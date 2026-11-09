/**
 * Issue #3788 (parent incident #3781) — schedule watchdog, pure core.
 *
 * No new scheduler, no new store, no fourth system: this module is the
 * pure decision half of the watchdog. The two agents consume it from
 * the ticks they already run (ScheduledAgent.onCron for goals,
 * OrchestratorAgent's 15-minute sweep for durable schedules). It
 * answers, for one schedule at one instant, "did it miss its firing?"
 *
 * Finding rules (shared by both consumers):
 * - Disabled schedules never alert; a grace of 0 disables the
 *   watchdog outright (the config seam, src/config/missedScheduleAlert.ts).
 * - The most recent expected tick comes from previousCronTickMs, which
 *   mirrors isDue's matching rules — a schedule the firing predicate
 *   can never fire (the opportunity-hunt step-hour quirk, a
 *   monthly cron with no tick inside the 8-day window) is never
 *   flagged. A goal that was first seen AFTER its expected tick (just
 *   created, or first observed by this deploy) never alerts for that
 *   tick: the watchdog attributes a miss only to a schedule that
 *   existed when the tick passed.
 * - A run at or after the expected tick — a job-run record, or a
 *   goal's lastRun stamp where the record has aged out of the cap —
 *   clears the miss. A failed run still counts as a firing (its
 *   failure is already recorded as a failure; the watchdog is about
 *   never-firing, not failing).
 * - An enabled goal whose cron is unparseable can never fire at all:
 *   it is flagged at once as `invalid_cron` (no expected tick, no
 *   first-seen gate — the defect is the cron itself, not a tick).
 * - Exactly-once per (schedule, expected tick) is carried by the
 *   ledger record itself: the missed-fire record is written with
 *   started = the watchdog tick (after the expected tick), so the
 *   next evaluation sees a run at/after the tick and stays silent.
 *   No second claim store exists.
 *
 * Every missed fire produces three signals (the consumers emit them,
 * claim-first in ledger order): a durable audit event carrying a CODE
 * (never a raw message, per #1743), a Slack alert through the existing
 * postSlackText seam, and a runs-ledger record with outcome "skipped"
 * and a "missed-fire: ..." detail (skipped is the ledger's value for
 * "no run happened"; buildJobRunRecord accepts it — no fourth outcome
 * is invented anywhere in this slice).
 */
import { isValidCron, previousCronTickMs } from "../schedule";
import type { StockCopilotCycleResult } from "./stockCopilot";

/** Durable first-seen key (one map per agent store): goal/schedule id → ISO. */
export const SCHEDULE_WATCHDOG_FIRST_SEEN_KEY = "scheduleWatchdogFirstSeen";

/** The watchdog's own heartbeat job id (one ledger row per tick). */
export const SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID = "schedule-watchdog-heartbeat";

/** Audit codes for missed firings (never a raw message, #1743). */
export const MISSED_FIRE_CODE = "missed_fire";
export const INVALID_CRON_CODE = "invalid_cron";

export interface MissedFiringFinding {
  code: typeof MISSED_FIRE_CODE | typeof INVALID_CRON_CODE;
  /** Start of the expected tick, epoch ms (absent for invalid_cron). */
  expectedTickMs?: number;
  /** ISO form of the expected tick (absent for invalid_cron). */
  expectedTickIso?: string;
  /** The schedule's last run, or null when it never ran. */
  lastRunIso?: string | null;
}

export interface WatchdogGoal {
  id: string;
  cron: string;
  enabled: boolean;
  lastRun?: string;
  timeZone?: string;
  operation?: string;
}

export interface GoalWatchdogInput {
  goal: WatchdogGoal;
  /** This goal's run records (newest first; started is ISO). */
  runs: Array<{ started: string }>;
  /** When this agent first observed the goal (epoch ms); absent = unseen. */
  firstSeenAtMs?: number;
  nowMs: number;
  graceMs: number;
}

/**
 * One goal's missed-firing finding at `nowMs`, or null when nothing
 * is attributable. Disabled goals, grace-disabled watchdogs, goals
 * with no tick in the window, and just-created goals never flag.
 */
export function findMissedGoalFiring(input: GoalWatchdogInput): MissedFiringFinding | null {
  const { goal, runs, firstSeenAtMs, nowMs, graceMs } = input;
  if (!goal.enabled) return null;
  if (!(graceMs > 0)) return null;
  if (!isValidCron(goal.cron)) {
    return { code: INVALID_CRON_CODE, lastRunIso: goal.lastRun ?? null };
  }
  const expected = previousCronTickMs(goal.cron, nowMs, goal.timeZone);
  if (expected === undefined) return null;
  // No first-seen stamp means the observation is unattributable
  // (first-seen storage failed): fail closed, no finding. The call
  // sites stamp firstSeen for every live goal before evaluating, so
  // undefined only ever means the stamp itself failed. (An
  // unparseable cron is still flagged above: that defect is the cron
  // itself, not an attributed tick.)
  if (firstSeenAtMs === undefined || firstSeenAtMs > expected) return null;
  if (nowMs <= expected + graceMs) return null;
  for (const run of runs) {
    const started = Date.parse(run.started);
    if (Number.isFinite(started) && started >= expected) return null;
  }
  if (goal.lastRun) {
    const last = Date.parse(goal.lastRun);
    if (Number.isFinite(last) && last >= expected) return null;
  }
  return {
    code: MISSED_FIRE_CODE,
    expectedTickMs: expected,
    expectedTickIso: new Date(expected).toISOString(),
    lastRunIso: goal.lastRun ?? null,
  };
}

/** The ledger detail for a finding (non-empty: a skip requires a reason). */
export function missedFiringDetail(
  _id: string,
  finding: MissedFiringFinding,
  cron?: string,
): string {
  if (finding.code === INVALID_CRON_CODE) {
    return `invalid-cron: ${cron ?? "unparseable cron"} never matches; goal cannot fire`;
  }
  return `missed-fire: expected ${finding.expectedTickIso} (last run: ${finding.lastRunIso ?? "never"})`;
}

/** The SDK schedule shape the durable-schedule watchdog reads. */
export interface DurableScheduleShape {
  id: string;
  callback: string;
  /** SDK timing type: "cron" | "interval" | "scheduled" | "delayed". */
  type?: string;
  /** Next execution, epoch seconds (SDK `time`). */
  time?: number;
  /** Cron expression (SDK `cron`, cron type only). */
  cron?: string;
  /** Gap between executions, seconds (SDK `intervalSeconds`). */
  intervalSeconds?: number;
}

export interface DurableScheduleWatchdogInput {
  schedule: DurableScheduleShape;
  /** The schedule's newest callback-run record, if any. */
  latestRun?: { started: string };
  firstSeenAtMs?: number;
  nowMs: number;
  graceMs: number;
}

/** The most recent expected firing for a durable schedule, or undefined. */
export function expectedDurableScheduleTickMs(
  schedule: DurableScheduleShape,
  nowMs: number,
): number | undefined {
  if (schedule.type === "cron" && typeof schedule.cron === "string") {
    // SDK crons are UTC expressions (cron-schedule).
    return previousCronTickMs(schedule.cron, nowMs);
  }
  if (
    schedule.type === "interval" &&
    typeof schedule.time === "number" &&
    typeof schedule.intervalSeconds === "number"
  ) {
    // `time` is the NEXT execution; the previous firing was one
    // interval earlier.
    return schedule.time * 1000 - schedule.intervalSeconds * 1000;
  }
  if (
    (schedule.type === "scheduled" || schedule.type === "delayed") &&
    typeof schedule.time === "number"
  ) {
    return schedule.time * 1000;
  }
  return undefined;
}

/**
 * One durable schedule's missed-firing finding at `nowMs`, or null.
 * Same gates as the goal finder; the only run source is the
 * callback-run ledger (durable schedules carry no lastRun stamp).
 */
export function findMissedDurableSchedule(
  input: DurableScheduleWatchdogInput,
): MissedFiringFinding | null {
  const { schedule, latestRun, firstSeenAtMs, nowMs, graceMs } = input;
  if (!(graceMs > 0)) return null;
  const expected = expectedDurableScheduleTickMs(schedule, nowMs);
  if (expected === undefined) return null;
  // No first-seen stamp means the observation is unattributable
  // (first-seen storage failed): fail closed, no finding. The call
  // sites stamp firstSeen for every live schedule before evaluating,
  // so undefined only ever means the stamp itself failed.
  if (firstSeenAtMs === undefined || firstSeenAtMs > expected) return null;
  if (nowMs <= expected + graceMs) return null;
  if (latestRun) {
    const started = Date.parse(latestRun.started);
    if (Number.isFinite(started) && started >= expected) return null;
  }
  return {
    code: MISSED_FIRE_CODE,
    expectedTickMs: expected,
    expectedTickIso: new Date(expected).toISOString(),
    lastRunIso: latestRun?.started ?? null,
  };
}

/* =================================================================
 * Copilot Think task — the three silent never-run paths (#3788).
 * ================================================================= */

/** Why declareStockCopilotTasks declared nothing (audit code class). */
export type CopilotNonDeclarationCause = "flag_off" | "no_login_context" | "context_error";

/**
 * Classify a non-declaration: flag off first (the deliberate
 * no-op), then a failed context read, then a missing login. Null
 * means the task is declared (no signal).
 */
export function classifyCopilotNonDeclaration(input: {
  flagEnabled: boolean;
  contextError: boolean;
  hasLogin: boolean;
}): CopilotNonDeclarationCause | null {
  if (!input.flagEnabled) return "flag_off";
  if (input.contextError) return "context_error";
  if (!input.hasLogin) return "no_login_context";
  return null;
}

/**
 * Map a copilot cycle result to its runs-ledger outcome. "ok" is the
 * only success; every refusal state is a skip with the cycle status
 * (and refusal code, when the cycle named one) as the detail — a
 * refused cycle ran and decided not to trade, which is a skip, not
 * a failure. No fourth outcome exists.
 */
export function copilotCycleLedgerOutcome(
  status: StockCopilotCycleResult["status"],
  refusal?: string,
): { outcome: "success" | "skipped"; detail?: string; descriptor?: string } {
  if (status === "ok") {
    return { outcome: "success", descriptor: "cycle complete" };
  }
  if (status === "mode_unresolved" || status === "refused_mode_mismatch" || status === "inactive_broker") {
    return {
      outcome: "skipped",
      detail: `cycle refused: ${status}${refusal ? ` (${refusal})` : ""}`,
    };
  }
  return { outcome: "skipped", detail: `cycle ${status}` };
}

/**
 * The error CODE for a handler failure (audit events carry a code,
 * never a message, #1743): the thrown error's own `code` when it
 * carries a non-empty string one, else the generic cycle failure.
 */
export function copilotCycleErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return "cycle_failed";
}
