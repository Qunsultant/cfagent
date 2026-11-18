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

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

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
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(
    private readonly sql: CanonicalReportStoreSqlExecutor,
    options?: { sink?: ObservabilitySink },
  ) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/doSqliteCanonicalReportStoreAdapter" },
    );
  }

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
        this.log.error("doSqliteCanonicalReportStore.drop_generation_index_failed", {
          message: `[scheduledReports] ensureScheduledReportsTable: DROP INDEX idx_mas_reports_generation (pre-#2398 global shape) failed; continuing: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Issue #876: the dedupe index is guarded — creating a UNIQUE
    // index over pairs that already hold duplicate non-null
    // values throws; unguarded, that aborted ensure (and therefore
    // EVERY report write for the DO) forever.
    // Issue #4507: the guard is dedupe-or-report now, not
    // log-and-continue. A failed CREATE means legacy duplicate
    // (user_login, generation_id) pairs are stored; they are the
    // same logical report stored twice (a generation id is a
    // tenant-local idempotency key), so the ensure resolves them
    // — newest row survives per pair (the #2863 read rule:
    // duplicates resolve to the newest row), the rest are
    // deleted — then retries the CREATE once. If the CREATE still
    // fails the schema is unreconcilable and the ensure throws a
    // named error instead of silently continuing without the
    // idempotency backstop; every seam caller fails closed on it
    // (store → null + REPORT_FANOUT_FAILED; reads → null/[]).
    // Crash-safe without a transaction: the dedupe is idempotent
    // (a second run finds no pairs) and the CREATE is
    // IF NOT EXISTS, so an interrupted ensure self-heals on the
    // next call — the same shape as the DROP-then-CREATE swap
    // above. NULL pairs are never touched (SQLite UNIQUE treats
    // NULLs as distinct; they can never block the index).
    const createGenerationIndex = () => {
      this.sql.exec(
        doStatementSql("schema.index.mas_reports.create_unique_index_idx_mas_reports_generation", { TABLE })
      );
    };
    try {
      createGenerationIndex();
    } catch (err) {
      const removed = this.dedupeGenerationIndexPairs();
      this.log.error("doSqliteCanonicalReportStore.unique_index_creation_failed", {
        message: `[scheduledReports] ensureScheduledReportsTable: unique-index creation for idx_mas_reports_generation failed (${err instanceof Error ? err.message : String(err)}); deduped ${removed.length} duplicate row(s), retrying the CREATE`,
        error: err instanceof Error ? err.message : String(err),
        dedupedCount: removed.length,
      });
      try {
        createGenerationIndex();
      } catch (retryErr) {
        throw new Error(
          `[scheduledReports] ensureScheduledReportsTable: unique-index creation for idx_mas_reports_generation failed after dedupe (${removed.length} duplicate row(s) removed) and retry (${retryErr instanceof Error ? retryErr.message : String(retryErr)}); the index is missing and report writes fail closed until the schema is repaired (original failure: ${err instanceof Error ? err.message : String(err)})`
        );
      }
    }
  }

  /**
   * Issue #4507 — resolve legacy duplicate (user_login,
   * generation_id) pairs so the tenant-scoped generation UNIQUE
   * index can be built. Surviving-row rule: per pair with both
   * columns non-NULL, keep the row with the greatest created_at;
   * ties break on the greatest id (deterministic total order) —
   * the newest row, matching the #2863 read rule (duplicates
   * resolve to the newest row). Every other row in the pair is
   * the same logical report stored twice (a generation id is a
   * tenant-local idempotency key) and is deleted through the
   * adapter's own deleteRow. NULL pairs are never touched:
   * SQLite UNIQUE treats NULLs as distinct, so they can never
   * block the index, and legacy NULL rows (pre-#308 generation
   * id, pre-#584 owner) must survive untouched. Idempotent: a
   * second run finds no pairs and removes nothing. Returns the
   * ids of the rows removed; each pair's removal is logged
   * loudly (a data deletion must be auditable).
   */
  private dedupeGenerationIndexPairs(): string[] {
    const pairs = Array.from(
      this.sql.exec(
        `SELECT user_login, generation_id FROM ${TABLE} WHERE user_login IS NOT NULL AND generation_id IS NOT NULL GROUP BY user_login, generation_id HAVING COUNT(*) > 1`
      )
    ) as Array<{ user_login?: unknown; generation_id?: unknown }>;
    const removed: string[] = [];
    for (const pair of pairs) {
      const owner = String(pair.user_login ?? "");
      const generationId = String(pair.generation_id ?? "");
      const rows = Array.from(
        this.sql.exec(
          `SELECT id FROM ${TABLE} WHERE user_login = ? AND generation_id = ? ORDER BY created_at DESC, id DESC`,
          owner,
          generationId
        )
      ) as Array<{ id?: unknown }>;
      if (rows.length <= 1) continue;
      const kept = String(rows[0]?.id ?? "");
      const victims = rows.slice(1);
      for (const victim of victims) {
        const id = String(victim.id ?? "");
        if (!id) continue;
        this.deleteRow(id);
        removed.push(id);
      }
      this.log.error("doSqliteCanonicalReportStore.deduped_generation_index_pair", {
        message: `[scheduledReports] ensureScheduledReportsTable: deduped generation-index pair (${owner}, ${generationId}): kept ${kept}, removed ${victims.length} duplicate row(s): ${victims.map((r) => String(r.id ?? "")).join(", ")}`,
        owner,
        generationId,
        kept,
        removed: victims.map((r) => String(r.id ?? "")),
        removedCount: victims.length,
      });
    }
    return removed;
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
