/**
 * Issue #5085 (S6, observability program #5080) — one runs ledger,
 * one source of truth for "did the run happen".
 *
 * The runs ledger (the one physical ledger: the D1 `job_run_records`
 * table, written through the one entry `recordLedgerRunD1`) is the
 * source of truth for whether a run happened. The Stock Copilot Loop
 * status reads it — never the activity table. The activity table
 * stays as the "Cycle activity" detail feed; it is not the liveness
 * proof.
 *
 * Issue #6101 — the ledger moved from the OrchestratorAgent Durable
 * Object SQLite `job_run_records` table to D1; the read below moved
 * with it. Pre-cutover rows stay in the DO, unreadable through the
 * app; the status reads post-cutover rows only.
 *
 * Why this module exists: the Loop status used to read
 * `activity.listActivity` for lastCycle and used the ledger only as
 * a neverExecuted corroboration (`hasCopilotCycleLedgerRows`). The
 * two stores could disagree — a cycle that fired and wrote a ledger
 * row but no activity record showed "never executed" with no
 * lastCycle, and an activity record with no ledger row showed a
 * live lastCycle. That is the #4001 shape. S6 makes the ledger the
 * single source: lastCycle is a projection of the newest copilot
 * cycle ledger row; neverExecuted is simply "no ledger row".
 *
 * The outcome class rides the ledger row: the cycle mapping writes
 * a descriptor naming the class for an ok cycle ("cycle complete:
 * traded" / "cycle complete: no trade"); refusal classes ride the
 * detail (kept byte-identical for the #3788 pin — the projection
 * reads the descriptor first, then the detail). Legacy rows whose
 * descriptor is the bare "cycle complete" fall back to the ledger
 * outcome (success → no_trade, skipped → inactive, failure →
 * refused) and are documented as such; they predate the
 * outcome-class descriptor.
 */
import type { JobRunRecord } from "../data/jobRunRecordPorts";
import type { D1JobRunRecordStore } from "../data/createJobRunRecordPorts";
import type { StockCopilotActivityRecord } from "../client/stockCopilotApi";
import { STOCK_COPILOT_TASK_ID } from "../agents/orchestrator/scheduledTasksCopilot";

/** The two job ids a copilot cycle ledger row can carry (see recordScheduleCallbackRun). */
const COPILOT_CYCLE_JOB_IDS = [
  STOCK_COPILOT_TASK_ID,
  `callback:${STOCK_COPILOT_TASK_ID}`,
] as const;

/**
 * The newest copilot cycle ledger row across both job ids, or
 * undefined when no cycle has ever recorded a row. Best-effort:
 * a read failure returns undefined (the caller treats it as "no
 * ledger row"), never throws — the status read must not fail
 * because the ledger read did.
 */
export async function latestCopilotCycleLedgerRow(
  store: D1JobRunRecordStore | null | undefined,
): Promise<JobRunRecord | undefined> {
  try {
    if (!store) return undefined;
    let latest: JobRunRecord | undefined;
    for (const jobId of COPILOT_CYCLE_JOB_IDS) {
      const row = await store.latestByJob(jobId);
      if (!row) continue;
      if (!latest || row.started >= latest.started) latest = row;
    }
    return latest;
  } catch {
    return undefined;
  }
}

/**
 * Parse the cycle outcome class out of a ledger row's descriptor,
 * then its detail. Token order matters: "inactive" is checked
 * before "refused" because the inactive-broker detail reads
 * "cycle refused: inactive_broker" — the class is inactive, not
 * refused.
 */
export function parseCopilotCycleOutcome(
  row: Pick<JobRunRecord, "descriptor" | "detail" | "outcome">,
): StockCopilotActivityRecord["outcome"] {
  const text = `${row.descriptor ?? ""} ${row.detail ?? ""}`.toLowerCase();
  if (text.includes("traded")) return "traded";
  if (text.includes("no trade")) return "no_trade";
  if (text.includes("inactive")) return "inactive";
  if (text.includes("refused")) return "refused";
  if (
    text.includes("outside sessions") ||
    text.includes("outside_enabled_sessions")
  ) {
    return "outside_sessions";
  }
  if (text.includes("disabled") || text.includes("paused")) return "inactive";
  // Legacy rows predate the outcome-class descriptor: fall back to
  // the ledger outcome. A successful legacy cycle completed with no
  // placements recorded, so it reads as no trade.
  if (row.outcome === "failure") return "refused";
  if (row.outcome === "skipped") return "inactive";
  return "no_trade";
}

/**
 * Project a copilot cycle ledger row into the lastCycle shape the
 * Stock Copilot panel renders. The id is ledger-derived (the
 * activity id does not exist for a ledger-only row); the session
 * is null (the ledger row carries no session); entries/exits are
 * empty (the ledger row carries no fills — the activity feed
 * still lists them when an activity record exists).
 */
export function projectCopilotLedgerRowToLastCycle(
  row: JobRunRecord,
): StockCopilotActivityRecord {
  return {
    id: `ledger:${row.jobId}:${row.started}`,
    cycleAt: row.started,
    outcome: parseCopilotCycleOutcome(row),
    session: null,
    entries: [],
    exits: [],
    detail: row.detail ?? row.descriptor ?? null,
  };
}
