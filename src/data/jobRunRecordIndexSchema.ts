/**
 * Issue #3121 Phase 2 (#3124) — ordering index for the consolidated
 * ledger's recent read; same #2280 slice-1/slice-3 pattern as
 * unifiedScheduleIndexSchema.ts (index helpers live in layer schema
 * modules; the adapter calls ensure* from ensureTable).
 *
 * Both halves of the merged read (`GET /api/ledger/runs` — the one
 * ledger read path) and the tick watchdog's run read run exactly:
 *   SELECT * FROM job_run_records ORDER BY started DESC, id DESC LIMIT ?
 * The only index, job_idx (job_id, started DESC, id DESC), needs a
 * leading job_id equality, so the unfiltered recent read walked the
 * whole table and sorted it on every call. The (started DESC,
 * id DESC) index turns it into a bounded index walk of `limit` rows.
 * Verified by EXPLAIN QUERY PLAN in
 * tests/schedule-3121-3124-parity.test.ts (3124-P06).
 *
 * Ordering/seek, NOT covering: the query selects * over wide rows
 * (detail / artifact_refs_json), so a covering index would duplicate
 * the table (#2280 slice-1 precedent).
 *
 * DO-SQLite only: the D1 residency of this table (migration 0047,
 * `src/data/d1JobRunRecordAdapter.ts`) keeps its own index set —
 * the D1 recent-read index is a filed [Out-of-Scope] sub-issue
 * under #3124 (it needs a new migration, never an edit to 0047).
 */
import type { SqlStorage } from "../orm";
import { JOB_RUN_RECORDS_TABLE } from "./jobRunRecordPorts";
import { ormIndexSql } from "./schemaComponent/ormCatalogue";

/** Exact recent-read query for the ledger (doSqliteJobRunRecordAdapter.ts). */
export const JOB_RUN_RECORDS_RECENT_SQL = `SELECT * FROM ${JOB_RUN_RECORDS_TABLE} ORDER BY started DESC, id DESC LIMIT ?`;

/**
 * #4282 P2a: the index SQL lives in the schema catalogue
 * (src/data/schemaComponent/ormCatalogue.ts); this array is the same
 * statement by name, so callers reading it see identical SQL.
 */
export const JOB_RUN_RECORD_INDEXES: Array<{ name: string; sql: string }> = [
  {
    name: "job_run_records_recent_idx",
    sql: ormIndexSql("job_run_records_recent_idx"),
  },
];

/**
 * Create the ledger recent-read index (idempotent). Call from the
 * adapter's ensureTable, after the table exists. Additive only
 * (CREATE INDEX IF NOT EXISTS); no table is altered and no row is
 * deleted.
 */
export function ensureJobRunRecordIndexes(sql: SqlStorage): void {
  for (const index of JOB_RUN_RECORD_INDEXES) {
    sql.exec(index.sql);
  }
}
