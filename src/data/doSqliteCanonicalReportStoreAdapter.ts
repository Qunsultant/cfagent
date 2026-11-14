/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the canonical-report store ports: every mas_reports
 * statement of src/services/scheduledReports.ts and the
 * backfill read of src/services/reportSemanticIndex.ts,
 * moved into the data layer statement-for-statement. The
 * seam module keeps the fan-out contract (#2347), the
 * outcome computation, and the never-throws discipline; this
 * store holds the SQL, including the table's DDL (its ONE
 * home now) with the #876 additive column reconciliation
 * and the #2398 tenant-scoping of the generation index
 * (shape reconciliation in ensureSchema, below).
 *
 * One class serves both roles (write / read are roles over
 * one table in one instance; the composition root hands the
 * same store out under each).
 */
import type {
  CanonicalReportReadPort,
  CanonicalReportStoredContent,
  CanonicalReportStoredRow,
  CanonicalReportStoreSqlExecutor,
  CanonicalReportWritePort,
  InsertCanonicalReportRow,
} from "./canonicalReportStorePorts";
import { doStatementSql } from "./schemaComponent/doCatalogue";
import { remainderStatementSql } from "./schemaComponent/remainderCatalogue";

const TABLE = "mas_reports";
const HIT_COLUMNS =
  "id, run_id, title, source, summary, body, created_at, generation_id, user_login, body_r2_key, fanout_outcome";

/** Add a column to the table when it is missing (additive migration). */
function ensureColumn(
  sql: CanonicalReportStoreSqlExecutor,
  column: string,
  type: string
): void {
  const cols = Array.from(
    sql.exec(`PRAGMA table_info(${TABLE})`)
  ) as Array<{ name?: unknown }>;
  const names = cols.map((c) => String(c?.name ?? ""));
  if (!names.includes(column)) {
    sql.exec(
      remainderStatementSql("schema.do.mas_reports.alter_table_add_column", {
        TABLE,
        column,
        type,
      }),
    );
  }
}

export class DoSqliteCanonicalReportStore
  implements CanonicalReportWritePort, CanonicalReportReadPort
{
  constructor(private readonly sql: CanonicalReportStoreSqlExecutor) {}

  // ------------------------------------------------------------------
  // Write role
  // ------------------------------------------------------------------

  ensureSchema(): void {
    this.sql.exec(doStatementSql("schema.do.mas_reports.create_table", { TABLE }));
    // Issue #876: reconcile EVERY expected column additively, not
    // just the newest ones (see the legacy ensure's note: column
    // order in the table definition is unchanged — reconciliation only
    // appends what is missing, with the plain TEXT type).
    ensureColumn(this.sql, "id", "TEXT");
    ensureColumn(this.sql, "run_id", "TEXT");
    ensureColumn(this.sql, "title", "TEXT");
    ensureColumn(this.sql, "source", "TEXT");
    ensureColumn(this.sql, "summary", "TEXT");
    ensureColumn(this.sql, "body", "TEXT");
    ensureColumn(this.sql, "created_at", "TEXT");
    // Additive migration for tables created before issue #308.
    ensureColumn(this.sql, "generation_id", "TEXT");
    // #584 (EP-003): tenant scoping. Legacy rows predate the
    // column and are NOT backfilled to a synthetic owner.
    ensureColumn(this.sql, "user_login", "TEXT");
    // Issue #338: R2-vs-DO storage split for report bodies.
    ensureColumn(this.sql, "body_r2_key", "TEXT");
    // Issue #2347: the recorded fan-out outcome (JSON). NULL on
    // rows stored before the contract landed.
    ensureColumn(this.sql, "fanout_outcome", "TEXT");

    this.sql.exec(
      doStatementSql("schema.index.mas_reports.create_index_idx_mas_reports_created", { TABLE })
    );
    this.sql.exec(
      doStatementSql("schema.index.mas_reports.create_index_idx_mas_reports_user", { TABLE })
    );
    // Issue #2398: the dedupe index is TENANT-scoped —
    // UNIQUE (user_login, generation_id) — matching the
    // write port's dedupe lookup, which scopes on the same
    // pair. A generation id is a tenant-local idempotency
    // key: the pre-#2398 GLOBAL UNIQUE (generation_id) made a
    // second tenant's INSERT for an already-used generation
    // id throw,
    // so the seam lost that tenant's report to a
    // REPORT_FANOUT_FAILED null even though the row was never
    // theirs. Reconcile the index shape here (its ONE home):
    // an existing index of this name whose columns are not
    // exactly (user_login, generation_id) is the pre-#2398
    // global shape and is dropped, then rebuilt tenant-scoped
    // by the guarded CREATE below. DROP-then-CREATE is the
    // crash-safe order under a single canonical name: both
    // statements touch the index only (no row moves), ensure
    // runs at the head of every store path so an interrupted
    // swap self-heals on the next call, and a table left
    // momentarily index-less still dedupes through the seam's
    // SELECT-then-INSERT check (the #876 degraded mode).
    const generationIndexCols = (
      Array.from(
        this.sql.exec(`PRAGMA index_info(idx_mas_reports_generation)`)
      ) as Array<{ seqno?: unknown; name?: unknown }>
    )
      .slice()
      .sort((a, b) => Number(a.seqno ?? 0) - Number(b.seqno ?? 0))
      .map((c) => String(c?.name ?? ""));
    if (
      generationIndexCols.length > 0 &&
      generationIndexCols.join(",") !== "user_login,generation_id"
    ) {
      try {
        this.sql.exec(
          remainderStatementSql("schema.index.mas_reports.drop_index_idx_mas_reports_generation", {
            TABLE,
          }),
        );
      } catch (err) {
        console.error(
          `[scheduledReports] ensureScheduledReportsTable: DROP INDEX idx_mas_reports_generation (pre-#2398 global shape) failed; continuing: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }
    }
    // Issue #876: the dedupe index is guarded — creating a UNIQUE
    // index over pairs that already hold duplicate non-null
    // values throws; unguarded, that aborted ensure (and therefore
    // EVERY report write for the DO) forever. The duplicates are
    // logged loudly (never deleted here) and the ensure completes.
    try {
      this.sql.exec(
        doStatementSql("schema.index.mas_reports.create_unique_index_idx_mas_reports_generation", { TABLE })
      );
    } catch (err) {
      console.error(
        `[scheduledReports] ensureScheduledReportsTable: unique-index creation for idx_mas_reports_generation failed (duplicate (user_login, generation_id) values already stored?); continuing without it: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  findIdByGeneration(generationId: string, owner: string): string {
    const existing = Array.from(
      this.sql.exec(
        `SELECT id FROM ${TABLE} WHERE generation_id = ? AND user_login = ? LIMIT 1`,
        generationId,
        owner
      )
    ) as Array<{ id?: unknown }>;
    return existing[0] ? String(existing[0].id ?? "") : "";
  }

  findStoredContent(id: string): CanonicalReportStoredContent | null {
    const rows = Array.from(
      this.sql.exec(
        `SELECT title, source, summary, body, body_r2_key, user_login FROM ${TABLE} WHERE id = ? LIMIT 1`,
        id
      )
    ) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    return {
      title: typeof row.title === "string" ? row.title : "",
      source: typeof row.source === "string" ? row.source : "",
      summary: typeof row.summary === "string" ? row.summary : "",
      body: typeof row.body === "string" ? row.body : "",
      bodyR2Key: typeof row.body_r2_key === "string" ? row.body_r2_key : null,
      ...(typeof row.user_login === "string" ? { userLogin: row.user_login } : {}),
    };
  }

  insertRow(row: InsertCanonicalReportRow): void {
    // The one INSERT both store seams share (single line —
    // MockSqlStorage's INSERT regex has no dotAll flag). Issue
    // #338: when bodyR2Key is set the body column stores "" and
    // the pointer names the R2 object; the seam passes the
    // already-resolved body value.
    this.sql.exec(
      `INSERT INTO ${TABLE} (id, run_id, title, source, summary, body, created_at, generation_id, user_login, body_r2_key, fanout_outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.runId,
      row.title,
      row.source,
      row.summary,
      row.body,
      row.createdAt,
      row.generationId,
      row.owner,
      row.bodyR2Key,
      row.fanoutOutcomeJson
    );
  }

  updateFanoutOutcome(reportId: string, fanoutOutcomeJson: string): void {
    this.sql.exec(
      `UPDATE ${TABLE} SET fanout_outcome = ? WHERE id = ?`,
      fanoutOutcomeJson,
      reportId
    );
  }

  updateBody(reportId: string, bodyJson: string): void {
    this.sql.exec(
      `UPDATE ${TABLE} SET body = ? WHERE id = ?`,
      bodyJson,
      reportId
    );
  }

  getFanoutOutcomeRaw(reportId: string): string | null {
    const rows = Array.from(
      this.sql.exec(
        `SELECT fanout_outcome FROM ${TABLE} WHERE id = ? LIMIT 1`,
        reportId
      )
    ) as Array<Record<string, unknown>>;
    const raw = rows[0]?.fanout_outcome;
    return typeof raw === "string" ? raw : null;
  }

  deleteRow(reportId: string): void {
    this.sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, reportId);
  }

  backfillBodyPointer(reportId: string, bodyR2Key: string): void {
    this.sql.exec(
      `UPDATE ${TABLE} SET body_r2_key = ?, body = '' WHERE id = ? AND body_r2_key IS NULL`,
      bodyR2Key,
      reportId
    );
  }

  // ------------------------------------------------------------------
  // Read role
  // ------------------------------------------------------------------

  getRowById(reportId: string): CanonicalReportStoredRow | null {
    const rows = Array.from(
      this.sql.exec(
        `SELECT ${HIT_COLUMNS} FROM ${TABLE} WHERE id = ? LIMIT 1`,
        reportId
      )
    ) as unknown as CanonicalReportStoredRow[];
    return rows[0] ?? null;
  }

  getRowByRunIdForOwner(
    runId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null {
    let q = `SELECT ${HIT_COLUMNS} FROM ${TABLE} WHERE run_id = ?`;
    const params: unknown[] = [runId];
    if (owner) {
      q += ` AND user_login = ?`;
      params.push(owner);
    }
    q += ` ORDER BY created_at DESC LIMIT 1`;
    const rows = Array.from(this.sql.exec(q, ...params)) as unknown as CanonicalReportStoredRow[];
    return rows[0] ?? null;
  }

  getRowByIdForOwner(
    reportId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null {
    let q = `SELECT ${HIT_COLUMNS} FROM ${TABLE} WHERE id = ?`;
    const params: unknown[] = [reportId];
    if (owner) {
      q += ` AND user_login = ?`;
      params.push(owner);
    }
    q += ` LIMIT 1`;
    const rows = Array.from(this.sql.exec(q, ...params)) as unknown as CanonicalReportStoredRow[];
    return rows[0] ?? null;
  }

  searchRows(
    tokens: string[],
    owner: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[] {
    const clause = tokens
      .map(
        () =>
          `(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(body) LIKE ?)`
      )
      .join(" OR ");
    const params: unknown[] = [];
    for (const t of tokens) {
      const like = `%${t}%`;
      params.push(like, like, like);
    }
    const ownerClause = owner ? `user_login = ? AND ` : "";
    const ownerParams: unknown[] = owner ? [owner] : [];
    return Array.from(
      this.sql.exec(
        `SELECT ${HIT_COLUMNS} FROM ${TABLE} WHERE ${ownerClause}(${clause}) ORDER BY created_at DESC LIMIT ?`,
        ...ownerParams,
        ...params,
        limit
      )
    ) as unknown as CanonicalReportStoredRow[];
  }

  listRows(
    owner: string | undefined,
    sourceFilter: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[] {
    let q = `SELECT ${HIT_COLUMNS} FROM ${TABLE}`;
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (owner) {
      wheres.push(`user_login = ?`);
      params.push(owner);
    }
    if (sourceFilter) {
      wheres.push(`source = ?`);
      params.push(sourceFilter);
    }
    if (wheres.length > 0) q += ` WHERE ` + wheres.join(" AND ");
    q += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return Array.from(
      this.sql.exec(q, ...params)
    ) as unknown as CanonicalReportStoredRow[];
  }

  findIdByRunId(runId: string): string | null {
    const rows = Array.from(
      this.sql.exec(`SELECT id FROM ${TABLE} WHERE run_id = ?`, runId)
    ) as Array<{ id?: unknown }>;
    return rows[0] ? String(rows[0].id ?? "") : null;
  }

  listIndexBackfillRows(
    limit: number,
    offset: number
  ): Array<{
    id: string;
    title: string;
    source: string;
    summary: string;
    body: string;
    body_r2_key: string | null;
  }> {
    return Array.from(
      this.sql.exec(
        `SELECT id, title, source, summary, body, body_r2_key FROM ${TABLE} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        limit,
        offset
      )
    ) as Array<{
      id: string;
      title: string;
      source: string;
      summary: string;
      body: string;
      body_r2_key: string | null;
    }>;
  }
}
