/**
 * Issue #2280 (slice 3) — covering indexes for the nightly
 * retention batches; homed in the data layer by issue #2362
 * (#1976 step 4f: index helpers live in layer schema modules;
 * src/services/masRetentionIndexes.ts is now a delegate over
 * this module).
 *
 * The retention sweep (src/security/storageRetention.ts, run
 * nightly via the schedules route) prunes aged rows in
 * batches of 500 with these exact queries:
 *   SELECT id FROM mas_messages WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
 *   SELECT id FROM mas_events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
 * Both tables are created in OrchestratorAgent.ensureTables
 * from the canonical DDL in src/orm/schema.ts, which defines
 * no index on created_at — so every batch walked the whole
 * table, and a 10-batch run (max 5,000 rows) scanned it up to
 * 10 times. mas_events is the session audit log with a
 * 365-day window, so it is the larger of the two.
 *
 * The (created_at, id) shape is covering for both queries:
 * the range filter, the ORDER BY, and the selected column
 * all come from the index, so the plan is a bounded index
 * walk with no table lookups. Verified by EXPLAIN QUERY PLAN
 * in tests/masRetentionIndexes.test.ts.
 */
import type { SqlStorage } from "../orm";

/** Exact retention-batch query for mas_messages (storageRetention.ts). */
export const MAS_MESSAGES_RETENTION_SQL =
  "SELECT id FROM mas_messages WHERE created_at < ? ORDER BY created_at ASC LIMIT ?";

/** Exact retention-batch query for mas_events (storageRetention.ts). */
export const MAS_EVENTS_RETENTION_SQL =
  "SELECT id FROM mas_events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?";

/**
 * Create the retention indexes (idempotent). Call after both
 * tables exist — in OrchestratorAgent.ensureTables, right
 * after the mas_events table is created (mas_messages is
 * created earlier in the same method).
 */
export function ensureMasRetentionIndexes(sql: SqlStorage): void {
  sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_mas_messages_created ON mas_messages(created_at, id)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_mas_events_created ON mas_events(created_at, id)",
  );
  // Issue #2543: the receipts read-back's session+type query
  // (WHERE session_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?)
  // walks this covering index in order instead of scanning the audit log
  // — the #1819 failure mode for a log that grows unboundedly. Same
  // idempotent shape as the retention indexes above.
  sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_mas_events_session_type ON mas_events(session_id, type, created_at DESC)",
  );
}
