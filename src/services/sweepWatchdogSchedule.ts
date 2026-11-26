/**
 * Issue #3121 #4242 — the sweeps + watchdog record identities.
 *
 * The three framework maintenance duties (the stale-ledger-task
 * sweep, the stale-async-job sweep, the missed-schedule watchdog)
 * are stored platform-level schedules (#6503): one stored row per
 * duty (monthly, created paused), fired through their entry
 * points when the stored schedule fires. Their record ids live
 * here beside the firing rule they derive from, and each id
 * doubles as the ledger jobId its runs join on — the #4241
 * convention — EXCEPT the watchdog, whose runs already land
 * under the pre-existing heartbeat job id
 * (SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, schedule-watchdog-heartbeat):
 * scheduleIdToLedgerJobId maps the watchdog record id to that job
 * id, the #4239/#4240 mapping precedent.
 *
 * Cadence: each dispatch cron below is the retired firing rule's
 * value (the 6h/15m SDK arms are gone with the derived records);
 * the stored rows run monthly. The constants are kept, never
 * re-literalized elsewhere, as the ledger history of the old
 * cadence.
 *
 * Outcome mapping: the two sweeps return sweep-result objects, not
 * callback outcomes (the #3788 note in scheduleSystems.ts named
 * this as the open surgery). These two pure helpers ARE that
 * mapping — the #3394 wrapper's delegate truth for each sweep run
 * (counts in `detail`, so the home row shows them). A sweep with no
 * account owner records `skipped`, never a zero success.
 */
import type { JobRunOutcome } from "../data/jobRunRecordPorts";

/**
 * The unified-store record id of the stale-ledger-task sweep, named
 * once here beside its firing rule. It doubles as the ledger jobId
 * the sweep's runs join on.
 */
export const STALE_LEDGER_SWEEP_RECORD_ID = "sweep-stale-ledger-tasks";

/**
 * The stale-ledger sweep's cadence as a cron, the retired firing
 * rule's value (the 6-hour SDK arm is gone with the derived
 * records); the stored row runs monthly. Kept, never
 * re-literalized, as the ledger history of the old cadence.
 */
export const STALE_LEDGER_SWEEP_DISPATCH_CRON = "0 */6 * * *";

/**
 * The unified-store record id of the stale-async-job sweep, named
 * once here beside its firing rule. It doubles as the ledger jobId
 * the sweep's runs join on.
 */
export const STALE_ASYNC_JOB_SWEEP_RECORD_ID = "sweep-stale-async-jobs";

/**
 * The stale-async-job sweep's cadence as a cron, the retired
 * firing rule's value (the 15-minute SDK arm is gone with the
 * derived records); the stored row runs monthly. Kept, never
 * re-literalized, as the ledger history of the old cadence.
 */
export const STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON = "*/15 * * * *";

/**
 * The unified-store record id of the missed-schedule watchdog,
 * named once here beside its firing rule. Its runs join on the
 * pre-existing heartbeat job id, not this id (see the module doc).
 */
export const SCHEDULE_WATCHDOG_RECORD_ID = "schedule-watchdog";

/**
 * The watchdog's cadence as a cron, the retired firing rule's
 * value (the 15-minute SDK arm is gone with the derived records);
 * the stored row runs monthly. Kept, never re-literalized, as the
 * ledger history of the old cadence.
 */
export const SCHEDULE_WATCHDOG_DISPATCH_CRON = "*/15 * * * *";

/** The result shape the stale-ledger-task sweep returns. */
export interface StaleLedgerSweepResult {
  userLogin: string | null;
  researchSwept: number;
  screenerSwept: number;
  researchPruned: number;
  screenerPruned: number;
}

/** The result shape the stale-async-job sweep returns. */
export interface StaleAsyncJobSweepResult {
  examined: number;
  alerted: number;
  reaped: number;
}

/** The outcome a #3394 wrapper delegate returns for a sweep run. */
export interface SweepRunOutcome {
  outcome: JobRunOutcome;
  detail?: string;
  descriptor?: string;
}

/**
 * Map a stale-ledger-sweep result to the #3394 wrapper's delegate
 * truth: success with swept/pruned counts in `detail` (the home
 * row shows them), or `skipped` when the sweep ran with no
 * authenticated account owner — a no-owner run is not a success.
 */
export function staleLedgerSweepOutcome(
  result: StaleLedgerSweepResult,
): SweepRunOutcome {
  if (!result.userLogin) {
    return { outcome: "skipped", detail: "no authenticated account owner" };
  }
  return {
    outcome: "success",
    descriptor: "stale ledger sweep complete",
    detail:
      `research swept=${result.researchSwept} pruned=${result.researchPruned}; ` +
      `screener swept=${result.screenerSwept} pruned=${result.screenerPruned}`,
  };
}

/**
 * Map a stale-async-job-sweep result to the #3394 wrapper's
 * delegate truth: success with examined/alerted/reaped counts in
 * `detail` (the home row shows them). A run that found nothing is
 * still a success — the run ran.
 */
export function staleAsyncJobSweepOutcome(
  result: StaleAsyncJobSweepResult,
): SweepRunOutcome {
  return {
    outcome: "success",
    descriptor: "stale async-job sweep complete",
    detail: `examined=${result.examined} alerted=${result.alerted} reaped=${result.reaped}`,
  };
}
