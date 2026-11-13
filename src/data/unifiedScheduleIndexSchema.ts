/**
 * Issue #3121 Phase 2 (#3124) — ordering index for the consolidated
 * schedule store's unfiltered list read; homed in the data layer by
 * the #2280 slice-1/slice-3 pattern (index helpers live in layer
 * schema modules; the adapter calls ensure* from ensureTable).
 *
 * The management list (`listUnifiedScheduleItems`, the Schedules
 * home's list read — one scan per list) runs exactly:
 *   SELECT * FROM unified_schedules ORDER BY created_at ASC, id ASC
 * The existing kind/state indexes both need a leading equality, so
 * neither serves an unfiltered ORDER BY — every list walked the
 * whole table and sorted it. The (created_at ASC, id ASC) index
 * turns it into a bounded index walk in stored order. Verified by
 * EXPLAIN QUERY PLAN in tests/schedule-3121-3124-parity.test.ts
 * (3124-P06).
 *
 * Ordering/seek, NOT covering: the query selects * over wide rows
 * (definition_json / provenance_json), so a covering index would
 * duplicate the table. This is the #2280 slice-1 precedent — a seek
 * index where covering is inapplicable.
 */
import type { SqlStorage } from "../orm";
import { UNIFIED_SCHEDULES_TABLE } from "./unifiedSchedulePorts";
import { ormIndexSql } from "./schemaComponent/ormCatalogue";

/** Exact unfiltered-list query for the unified store (doSqliteUnifiedScheduleAdapter.ts). */
export const UNIFIED_SCHEDULES_LIST_SQL = `SELECT * FROM ${UNIFIED_SCHEDULES_TABLE} ORDER BY created_at ASC, id ASC`;

/**
 * #4282 P2a: the index SQL lives in the schema catalogue
 * (src/data/schemaComponent/ormCatalogue.ts); this array is the same
 * statement by name, so callers reading it see identical SQL.
 */
export const UNIFIED_SCHEDULE_INDEXES: Array<{ name: string; sql: string }> = [
  {
    name: "unified_schedules_created_idx",
    sql: ormIndexSql("unified_schedules_created_idx"),
  },
];

/**
 * Create the unified-schedule indexes (idempotent). Call from the
 * adapter's ensureTable, after the table exists. Additive only
 * (CREATE INDEX IF NOT EXISTS); no table is altered and no row is
 * deleted.
 */
export function ensureUnifiedScheduleIndexes(sql: SqlStorage): void {
  for (const index of UNIFIED_SCHEDULE_INDEXES) {
    sql.exec(index.sql);
  }
}
