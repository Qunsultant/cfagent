/**
 * Issue #2280 (slice 1) — seek indexes for the framework's
 * alarm job queue; homed in the data layer by issue #2362
 * (#1976 step 4f: index helpers live in layer schema modules;
 * src/services/frameworkQueueIndexes.ts is now a delegate
 * over this module).
 *
 * The `agents` SDK (0.24.0, the version on main) drives its
 * durable job queue from `cf_agents_jobs`, created WITHOUT
 * ROWID with `id TEXT PRIMARY KEY` and NO index on `time`
 * (zero index creation in the SDK's lifecycle bundle). Every
 * alarm runs four statements against that table:
 * - `due()`: `SELECT * FROM cf_agents_jobs WHERE time <= ? ORDER BY time ASC`
 * - `nextAlarmTime()` MIN 1: `SELECT MIN(time) FROM cf_agents_jobs WHERE exclusive = 1`
 * - `nextAlarmTime()` MIN 2: `SELECT MIN(time) FROM cf_agents_jobs WHERE
 *   singleflight = 0 OR running = 0 OR <hung check>`
 * - `nextAlarmTime()` MIN 3 (hung recheck): `SELECT MIN(<hung expression>)
 *   FROM cf_agents_jobs WHERE singleflight = 1 AND running = 1 AND <hung check>`
 * plus `rearmAlarm()` re-running `nextAlarmTime()` after every alarm.
 * Without indexes each statement walks the whole table, so one alarm costs
 * roughly four full scans; at ~331 alarms/day on a per-user agent with a
 * ~3k-row queue that is ~4M rows/day — the 2026-10-29 account-level
 * rows-read exhaustion that took production login down.
 *
 * A time-only index does NOT collapse all four scans (verified by EXPLAIN
 * QUERY PLAN on the exact statements): `due()` becomes a bounded seek and
 * the ready-MIN short-circuits on the first `singleflight = 0` entry, but
 * the exclusive-MIN still walks the whole time index and the hung-recheck
 * MIN still walks the primary key, because neither filter column is in the
 * index. This module therefore creates three indexes, and with the full set
 * EXPLAIN shows a bounded seek (covering where applicable) for all four:
 * - `(time)` — the due range and the ready-MIN walk.
 * - `(exclusive, time)` — the exclusive-MIN seeks its partition.
 * - `(singleflight, running, execution_started_at, hung_timeout_seconds)` —
 *   the hung-recheck MIN seeks the (1, 1) partition, which is empty or tiny
 *   between alarms, and the index covers every column the statement reads.
 *
 * Ordering: the framework creates the table lazily on first queue use, so
 * this must run AFTER the caller has touched the queue (in
 * OrchestratorAgent.onStart, the schedule reconciliation earlier in onStart
 * forces that creation). If the table still does not exist this throws and
 * the caller catches it — a missed index is retried on the next start, and
 * a failure must never block startup. Additive only (idempotent index
 * creation); no table is altered and no row is deleted, per the #2299
 * rename-never-delete rule's additive spirit for data.
 *
 * Other agent classes adopt this by calling it from their own onStart after
 * their first queue touch; slice 1 wires only OrchestratorAgent, the class
 * behind the burning per-user instances.
 */
import type { SqlStorage } from "../orm";
import { ormIndexSql } from "./schemaComponent/ormCatalogue";

/**
 * #4282 P2a: the index SQL lives in the schema catalogue
 * (src/data/schemaComponent/ormCatalogue.ts); this array is the same
 * statements by name, so callers reading it see identical SQL.
 */
export const FRAMEWORK_QUEUE_INDEXES: Array<{ name: string; sql: string }> = [
  {
    name: "idx_cf_agents_jobs_time",
    sql: ormIndexSql("idx_cf_agents_jobs_time"),
  },
  {
    name: "idx_cf_agents_jobs_exclusive_time",
    sql: ormIndexSql("idx_cf_agents_jobs_exclusive_time"),
  },
  {
    name: "idx_cf_agents_jobs_singleflight_running",
    sql: ormIndexSql("idx_cf_agents_jobs_singleflight_running"),
  },
];

/**
 * Create the framework queue seek indexes on the agent
 * instance's own SQLite storage. Idempotent (IF NOT EXISTS).
 * Throws when the table does not exist yet; the caller
 * catches that and retries on the next start.
 */
export function ensureFrameworkQueueIndexes(sql: SqlStorage): void {
  for (const index of FRAMEWORK_QUEUE_INDEXES) {
    sql.exec(index.sql);
  }
}
