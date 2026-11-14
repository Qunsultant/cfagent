/**
 * Issue #2280 (slice 2): the already-running gate for market screens.
 *
 * `ScheduledTasksService` runs this gate on the 30-minute tick (48x/day) to skip
 * a market screen when a chain for the same (userLogin, universe) is already
 * active. It used to read every non-terminal job payload with
 * `WHERE status NOT IN ('completed', 'failed')` and filter by chain in code
 * — a full scan of `mas_async_jobs` on every tick.
 *
 * Two facts shape this fix, both verified by EXPLAIN QUERY PLAN on the
 * exact statements against the real table shape:
 * - The status domain is CLOSED: every `mas_async_jobs` writer lives in
 *   `src/agents/orchestrator/asyncJobs.ts` and writes only `queued` (submit),
 *   `running` (start), `completed` (finish), or `failed` (fail / stale
 *   reaping). So `status IN ('queued', 'running')` is exactly equivalent
 *   to `status NOT IN ('completed', 'failed')` — no behavior change.
 * - The index alone does NOT fix the old query: `NOT IN` plus a
 *   `(status, created_at)` index still plans SCAN. The positive `IN` list
 *   plus that index plans two bounded seeks (`status=?`). Both halves of
 *   item 5 are required; either alone leaves the scan.
 *
 * The index is created here (called from `OrchestratorAgent.ensureTables`,
 * right after the table's own creation, so no lazy-creation ordering
 * issue like the framework queue's). The gate keeps its fail-open shape:
 * a read failure still proceeds, and the screen-run lock probe above the
 * gate remains the primary guard.
 */

import type { SqlStorage } from "../orm";
import { createAsyncJobPorts } from "../data/createAsyncJobPorts";

/**
 * Non-terminal job payloads, read by the already-running gate.
 *
 * @deprecated Superseded by ACTIVE_JOB_PAYLOADS_SQL in
 * src/data/asyncJobPorts.ts (the statement the DO adapter
 * executes for the read port's activeJobPayloads) — #2358
 * (#1976 step 4a). Re-exported here for existing importers;
 * the text is identical by construction (same source).
 */
export { ACTIVE_JOB_PAYLOADS_SQL } from "../data/asyncJobPorts";

/**
 * Create the gate's seek index. Idempotent (IF NOT EXISTS). Throws when
 * the table does not exist yet; the caller (ensureTables) creates the
 * table first, so that cannot happen in production order.
 *
 * @deprecated Superseded by the queue port's ensureGateIndexes
 * (src/data/asyncJobPorts.ts, composed by
 * src/data/createAsyncJobPorts.ts) — #2358 (#1976 step 4a). Kept
 * as a delegation shim for the existing call sites and pins.
 */
export function ensureAsyncJobGateIndexes(sql: SqlStorage): void {
  createAsyncJobPorts(sql as never).queue.ensureGateIndexes();
}

/**
 * True when any payload belongs to an active chain for this
 * (userLogin, universe). Unparseable payloads and payloads without a
 * chain never match, exactly as the previous inline code behaved.
 */
export function hasActiveChain(
  rows: Array<Record<string, unknown>>,
  userLogin: string,
  universe: string,
): boolean {
  return rows.some((row) => {
    try {
      const chain = (JSON.parse(String(row.payload_json)) as any)?.chain;
      return chain?.userLogin === userLogin && chain?.universe === universe;
    } catch {
      return false;
    }
  });
}
