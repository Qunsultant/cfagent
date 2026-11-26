/**
 * Issue #6503 step 13 — goal-run retention caps, externalized.
 *
 * The ScheduledAgent keeps two bounded histories: the per-run
 * job-run records (newest first, shared-ledger merge + legacy KV
 * key) and the short-term tick history (newest first, the proof a
 * tick ran). The literals were `SCHEDULED_AGENT_JOB_RUN_CAP = 500`
 * in `src/services/jobRunRecords.ts` and an inline `slice(0, 50)`
 * in `src/agents/scheduled-agent.ts` (recordTick) — the defaults
 * below ARE those literals, unchanged: with no managed or env
 * value the histories keep exactly as many entries as today.
 * (The 500-record cap is shared with the heartbeat rows: ~48
 * heartbeat rows a day against ~7 days of retained history at
 * current goal volume — see the runScheduleWatchdog note in
 * scheduled-agent.ts. Changing the cap changes that trade-off.)
 *
 * Precedence: managed setting (mas_settings
 * `goalRun.jobRunRecordCap` / `goalRun.tickHistoryCap`, settable
 * through the schedules-home controls surface) > env carrier
 * (`SCHEDULED_AGENT_JOB_RUN_CAP` / `SCHEDULED_AGENT_TICK_HISTORY_CAP`,
 * new — there was no env carrier for either cap) > default
 * (500 / 50). A cap must be a positive whole number of records;
 * anything else falls through to the next source. There is no
 * disabling value: a zero cap would keep no history at all.
 *
 * Live-wiring gap (step 13, named, not silently papered over):
 * both caps are read on the ScheduledAgent (`getJobRuns` /
 * `recordJobRun` / `recordTick`), a different durable object
 * whose storage cannot see the orchestrator's mas_settings — the
 * same cross-DO boundary the governed halt crosses with a D1
 * mirror (`src/data/governedHalt.ts`). The env leg IS wired
 * there (the agent's own `this.env`), so the caps are
 * configurable without a code change today; the managed leg
 * needs the mirror (or an orchestrator settings RPC), which is a
 * follow-up, not this slice. Until then the env/default governs,
 * exactly as today.
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduleFiringRateAlert.ts).
 */

/** The env carrier for the job-run record cap (new — the cap had no env carrier before step 13). */
export const GOAL_RUN_JOB_RUN_RECORD_CAP_ENV_VAR = "SCHEDULED_AGENT_JOB_RUN_CAP";

/** The env carrier for the tick-history cap (new). */
export const GOAL_RUN_TICK_HISTORY_CAP_ENV_VAR = "SCHEDULED_AGENT_TICK_HISTORY_CAP";

/** The managed-setting key for the job-run record cap (mas_settings). */
export const GOAL_RUN_JOB_RUN_RECORD_CAP_SETTING_KEY = "goalRun.jobRunRecordCap";

/** The managed-setting key for the tick-history cap (mas_settings). */
export const GOAL_RUN_TICK_HISTORY_CAP_SETTING_KEY = "goalRun.tickHistoryCap";

/** The built-in default job-run record cap: 500 records — the #2964 literal, unchanged. */
export const DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP = 500;

/** The built-in default tick-history cap: 50 entries — the scheduled-agent literal, unchanged. */
export const DEFAULT_GOAL_RUN_TICK_HISTORY_CAP = 50;

/**
 * Parse a retention cap in records: a positive whole number, or
 * undefined (non-numeric, non-finite, zero, negative, or
 * fractional — falls through to the next source). Strings parse
 * as numbers so managed settings (stored as text) resolve the
 * same way as env carriers.
 */
export function parseGoalRunRetentionCap(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Where the effective retention cap came from (named for the home + the audit trail). */
export type GoalRunRetentionSource = "managed" | "env" | "default";

/** Resolve the job-run record cap from already-read sources: managed > env > default (500). */
export function resolveGoalRunJobRunRecordCap(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseGoalRunRetentionCap(input.managed) ??
    parseGoalRunRetentionCap(input.env) ??
    DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP
  );
}

/** Name the winning job-run record cap source for the same inputs. */
export function goalRunJobRunRecordCapSource(input: {
  managed?: unknown;
  env?: unknown;
}): GoalRunRetentionSource {
  if (parseGoalRunRetentionCap(input.managed) !== undefined) return "managed";
  if (parseGoalRunRetentionCap(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the tick-history cap from already-read sources: managed > env > default (50). */
export function resolveGoalRunTickHistoryCap(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseGoalRunRetentionCap(input.managed) ??
    parseGoalRunRetentionCap(input.env) ??
    DEFAULT_GOAL_RUN_TICK_HISTORY_CAP
  );
}

/** Name the winning tick-history cap source for the same inputs. */
export function goalRunTickHistoryCapSource(input: {
  managed?: unknown;
  env?: unknown;
}): GoalRunRetentionSource {
  if (parseGoalRunRetentionCap(input.managed) !== undefined) return "managed";
  if (parseGoalRunRetentionCap(input.env) !== undefined) return "env";
  return "default";
}

/** Both retention caps, resolved together from already-read sources: managed > env > default. */
export interface GoalRunRetention {
  jobRunRecordCap: number;
  tickHistoryCap: number;
}

export function resolveGoalRunRetention(input: {
  managedJobRunRecordCap?: unknown;
  envJobRunRecordCap?: unknown;
  managedTickHistoryCap?: unknown;
  envTickHistoryCap?: unknown;
}): GoalRunRetention {
  return {
    jobRunRecordCap: resolveGoalRunJobRunRecordCap({
      managed: input.managedJobRunRecordCap,
      env: input.envJobRunRecordCap,
    }),
    tickHistoryCap: resolveGoalRunTickHistoryCap({
      managed: input.managedTickHistoryCap,
      env: input.envTickHistoryCap,
    }),
  };
}
