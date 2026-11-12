/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the scan-run port: the legacy SqlScanRunStore (issue #27),
 * moved into the data layer. src/trading/options/scanRunStore
 * .ts is now a re-export shim over this module and
 * scanRunPorts.ts, so every existing import path and call
 * signature is preserved.
 *
 * The table is ensured lazily by the store (CREATE TABLE/INDEX
 * IF NOT EXISTS, plus the issue #103 user_login column probe),
 * mirroring how mas_policy_verdicts is written from the
 * orchestrator: plain sql.exec statements with bound parameters
 * and JSON payload columns.
 *
 * TRANSACTION SEAM (ADR D-C, step-2 audit §4): save()'s INSERT
 * + retention prune and updatePdfKey()'s read-modify-write run
 * through withTransaction (DO leg) when the host supplies the
 * transaction-capable storage object (the composition root
 * passes ctx.storage) and the transaction runner is
 * registered (transactionRunnerProvider.ts). Over a bare sql handle the same code
 * applies sequentially — exactly the legacy behaviour under
 * the DO's per-instance serialization.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import type { OpportunityScanResult } from "../trading";
import {
  SCAN_RUN_MAX_ROWS,
  SCAN_RUN_RETENTION_DAYS,
  normalizeScanRunBroker,
  normalizeScanRunLinkage,
  visibleToCaller,
  type LedgerLinkage,
  type ScanRunBroker,
  type ScanRunStore,
  type ScanRunStoreOptions,
  type ScanRunSummary,
  type ScanSqlExecutor,
  type StoredScanRun,
} from "./scanRunPorts";

const TABLE = "mas_opportunity_scans";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, ` +
  `mode TEXT NOT NULL, model_version TEXT NOT NULL, user_login TEXT, ` +
  // Issue #3314: the §4 linkage id columns — the same column names
  // job_run_records carries, so the join is a plain equality.
  `schedule_id TEXT, async_job_id TEXT, workflow_id TEXT, summary_json TEXT NOT NULL, result_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_opportunity_scans_generated_at ON ${TABLE} (generated_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, generated_at, mode, model_version, user_login, schedule_id, async_job_id, workflow_id, summary_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself (issue
// #103) so pagination walks only rows the caller may see — filtering
// after LIMIT/OFFSET would return short pages. With a NULL scope
// parameter the `user_login = NULL` comparison is never true, so an
// unscoped caller gets exactly the legacy (user_login IS NULL) rows.
const LIST_SQL =
  `SELECT summary_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT summary_json, result_json FROM ${TABLE} WHERE id = ?`;
const UPDATE_PDF_KEY_SQL = `UPDATE ${TABLE} SET summary_json = ?, result_json = ? WHERE id = ?`;
const UPDATE_LINKAGE_SQL =
  `UPDATE ${TABLE} SET schedule_id = ?, async_job_id = ?, workflow_id = ?, summary_json = ? WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE generated_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY generated_at DESC, id DESC LIMIT ?)`;
const TABLE_INFO_SQL = `PRAGMA table_info(${TABLE})`;
const ADD_USER_LOGIN_COLUMN_SQL = `ALTER TABLE ${TABLE} ADD COLUMN user_login TEXT`;
// Issue #3314: the three §4 linkage columns, probed exactly like
// user_login above — one ALTER per missing column, existing rows
// read back NULL (an explicit absence, never a dropped row).
const ADD_SCHEDULE_ID_COLUMN_SQL = `ALTER TABLE ${TABLE} ADD COLUMN schedule_id TEXT`;
const ADD_ASYNC_JOB_ID_COLUMN_SQL = `ALTER TABLE ${TABLE} ADD COLUMN async_job_id TEXT`;
const ADD_WORKFLOW_ID_COLUMN_SQL = `ALTER TABLE ${TABLE} ADD COLUMN workflow_id TEXT`;

function summarize(
  id: string,
  result: OpportunityScanResult,
  userLogin?: string,
  trigger?: "manual" | "scheduled",
  broker?: ScanRunBroker,
  linkage?: { scheduleId: string | null; asyncJobId: string | null; workflowId: string | null },
): ScanRunSummary {
  return {
    id,
    generatedAt: result.generatedAt,
    mode: result.mode,
    modelVersion: result.modelVersion,
    gate: result.gate,
    coverage: result.coverage,
    profileRef: result.profileRef ?? null,
    pdfKey: result.pdfKey ?? null,
    xlsxKey: result.xlsxKey ?? null,
    csvKey: result.csvKey ?? null,
    partial: result.partial ?? null,
    // Issue #3264: the trigger rides inside summary_json (no column
    // migration — the summary object is serialized wholesale), so
    // older rows simply lack the field and read back as null.
    ...(trigger ? { trigger } : {}),
    // Issue #3327: provenance rides inside summary_json (no column migration).
    broker: normalizeScanRunBroker(broker),
    ...(userLogin !== undefined ? { userLogin } : {}),
    // Issue #3314: the §4 linkage rides the summary too (the columns
    // carry the same three values) — stamped only when the caller
    // passed a linkage; absent, readers treat the fields as null.
    ...(linkage
      ? {
          scheduleId: linkage.scheduleId,
          asyncJobId: linkage.asyncJobId,
          workflowId: linkage.workflowId,
        }
      : {}),
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/**
 * ScanRunStore over Durable Object SQLite (the port's DO
 * adapter; the class name is the legacy one — it IS the store
 * the shim re-exports).
 */
export class SqlScanRunStore implements ScanRunStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: ScanSqlExecutor,
    options: ScanRunStoreOptions = {},
    /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts),
     *  when the host supplies it — enables the withTransaction
     *  wraps (see the module header). */
    private readonly storage?: DoTransactionStorage,
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? SCAN_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? SCAN_RUN_MAX_ROWS;
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    // Issue #103 migration: tables created before per-user scoping
    // have no user_login column. PRAGMA table_info (the repo's ORM
    // uses the same probe) → ALTER TABLE ADD COLUMN when missing;
    // existing rows read back NULL, which the visibility rule treats
    // as legacy/unscoped. Idempotent: once the column exists the
    // probe finds it and no ALTER runs.
    const columns = Array.from(this.sql.exec(TABLE_INFO_SQL)) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "user_login")) {
      this.sql.exec(ADD_USER_LOGIN_COLUMN_SQL);
    }
    // Issue #3314: same probe per linkage column — a table created
    // before #3314 gains them one ALTER at a time; existing rows read
    // back NULL, which the join treats as unjoined, never dropped.
    if (!columns.some((c) => c.name === "schedule_id")) {
      this.sql.exec(ADD_SCHEDULE_ID_COLUMN_SQL);
    }
    if (!columns.some((c) => c.name === "async_job_id")) {
      this.sql.exec(ADD_ASYNC_JOB_ID_COLUMN_SQL);
    }
    if (!columns.some((c) => c.name === "workflow_id")) {
      this.sql.exec(ADD_WORKFLOW_ID_COLUMN_SQL);
    }
    this.ensured = true;
  }

  private count(): number {
    const rows = Array.from(this.sql.exec(COUNT_SQL)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async save(
    result: OpportunityScanResult,
    options: {
      userLogin?: string;
      id?: string;
      trigger?: "manual" | "scheduled";
      broker?: ScanRunBroker;
      linkage?: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId">;
    } = {},
  ): Promise<StoredScanRun> {
    this.ensure();
    const id = options.id ?? this.idFactory();
    // Issue #3314: normalize once — a missing or poisoned (#3650)
    // id stamps as an explicit null on both the columns and the
    // summary. No linkage passed at all leaves the summary fields
    // absent (readers treat absent as null, the trigger pattern).
    const linkage =
      options.linkage !== undefined ? normalizeScanRunLinkage(options.linkage) : undefined;
    const summary = summarize(id, result, options.userLogin, options.trigger, options.broker, linkage);
    const run: StoredScanRun = { ...summary, result };
    const insert = () => {
      this.sql.exec(
        INSERT_SQL,
        id,
        result.generatedAt,
        result.mode,
        result.modelVersion,
        summary.userLogin ?? null,
        linkage?.scheduleId ?? null,
        linkage?.asyncJobId ?? null,
        linkage?.workflowId ?? null,
        JSON.stringify(summary),
        JSON.stringify(result),
      );
    };
    // Retention is enforced on the write path, relative to the run's
    // own timestamp: a run saved with an old generatedAt (backfill,
    // replay) prunes against its own clock, not the wall clock. The
    // INSERT + prune pair is one unit when the host supplied the
    // transaction-capable storage (ADR D-C).
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      await runner.run(
        this.storage,
        { operationName: "scanRuns.save", domain: "options-discovery" },
        () => {
          insert();
          this.pruneSync(new Date(result.generatedAt));
        },
      );
    } else {
      insert();
      await this.prune(new Date(result.generatedAt));
    }
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; userLogin?: string; broker?: ScanRunBroker } = {},
  ): Promise<ScanRunSummary[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    if (!options.broker) {
      const rows = Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, limit, offset)) as Array<{
        summary_json: string;
      }>;
      return rows.map((r) => JSON.parse(r.summary_json) as ScanRunSummary);
    }
    // Issue #3327: provenance lives inside summary_json, so the broker filter
    // happens after parsing. The table is capped at SCAN_RUN_MAX_ROWS, so
    // reading the (bounded) visible window and slicing here keeps pagination
    // honest instead of returning short pages from a filtered LIMIT.
    const rows = Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, this.maxRows, 0)) as Array<{
      summary_json: string;
    }>;
    return rows
      .map((r) => JSON.parse(r.summary_json) as ScanRunSummary)
      .filter((summary) => normalizeScanRunBroker(summary.broker) === options.broker)
      .slice(offset, offset + limit);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredScanRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
    if (!rows.length) return null;
    const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
    // The summary is the scoping authority (it is what summarize()
    // stamped); an invisible run reads as absent.
    if (!visibleToCaller(summary, options.userLogin)) return null;
    const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
    return { ...summary, result };
  }

  async updatePdfKey(id: string, pdfKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!pdfKey) return false;
    this.ensure();
    const apply = (): boolean => {
      const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
      if (!rows.length) return false;
      const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
      if (!visibleToCaller(summary, options.userLogin)) return false;
      const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
      summary.pdfKey = pdfKey;
      result.pdfKey = pdfKey;
      this.sql.exec(UPDATE_PDF_KEY_SQL, JSON.stringify(summary), JSON.stringify(result), id);
      return true;
    };
    // The GET + UPDATE read-modify-write is one unit when the
    // host supplied the transaction-capable storage, so the
    // summary/result pair cannot be stamped from a stale read.
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      return runner.run(
        this.storage,
        { operationName: "scanRuns.updatePdfKey", domain: "options-discovery" },
        apply,
      );
    }
    return apply();
  }

  async updateXlsxKey(id: string, xlsxKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!xlsxKey) return false;
    this.ensure();
    const apply = (): boolean => {
      const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
      if (!rows.length) return false;
      const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
      if (!visibleToCaller(summary, options.userLogin)) return false;
      const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
      summary.xlsxKey = xlsxKey;
      result.xlsxKey = xlsxKey;
      this.sql.exec(UPDATE_PDF_KEY_SQL, JSON.stringify(summary), JSON.stringify(result), id);
      return true;
    };
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      return runner.run(
        this.storage,
        { operationName: "scanRuns.updateXlsxKey", domain: "options-discovery" },
        apply,
      );
    }
    return apply();
  }

  async updateCsvKey(id: string, csvKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!csvKey) return false;
    this.ensure();
    const apply = (): boolean => {
      const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
      if (!rows.length) return false;
      const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
      if (!visibleToCaller(summary, options.userLogin)) return false;
      const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
      summary.csvKey = csvKey;
      result.csvKey = csvKey;
      this.sql.exec(UPDATE_PDF_KEY_SQL, JSON.stringify(summary), JSON.stringify(result), id);
      return true;
    };
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      return runner.run(
        this.storage,
        { operationName: "scanRuns.updateCsvKey", domain: "options-discovery" },
        apply,
      );
    }
    return apply();
  }

  async updateLedgerLinkage(
    id: string,
    linkage: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId">,
    options: { userLogin?: string } = {},
  ): Promise<boolean> {
    this.ensure();
    // Issue #3314: the scheduled-path backfill — the persist stage
    // inside the workflow cannot know the schedule id, so the caller
    // stamps it here once the run id and the schedule id are both
    // known. Same read-modify-write + visibility discipline as
    // updatePdfKey; the result JSON carries no linkage, so only the
    // columns and the summary move.
    const clean = normalizeScanRunLinkage(linkage);
    const apply = (): boolean => {
      const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
      if (!rows.length) return false;
      const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
      if (!visibleToCaller(summary, options.userLogin)) return false;
      summary.scheduleId = clean.scheduleId;
      summary.asyncJobId = clean.asyncJobId;
      summary.workflowId = clean.workflowId;
      this.sql.exec(
        UPDATE_LINKAGE_SQL,
        clean.scheduleId,
        clean.asyncJobId,
        clean.workflowId,
        JSON.stringify(summary),
        id,
      );
      return true;
    };
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      return runner.run(
        this.storage,
        { operationName: "scanRuns.updateLedgerLinkage", domain: "options-discovery" },
        apply,
      );
    }
    return apply();
  }

  private pruneSync(now: Date): number {
    this.ensure();
    const before = this.count();
    this.sql.exec(PRUNE_AGE_SQL, retentionCutoff(now, this.retentionDays));
    this.sql.exec(PRUNE_CAP_SQL, this.maxRows);
    return before - this.count();
  }

  async prune(now: Date): Promise<number> {
    return this.pruneSync(now);
  }
}
