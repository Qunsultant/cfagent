/**
 * Issue #6482 — the managed schedule controls.
 *
 * The floor, the kill-switch, the start-paused control, and the
 * firing-rate alert thresholds are MANAGED settings, not env-only
 * or dashboard-only knobs: they live in the one managed store
 * (mas_settings, through the dedicated SettingsPort — the #2390
 * G-7 home, same as governedHalt's kill-switch write) and are
 * settable AND readable from the schedules home
 * (GET/POST /api/schedules/controls). Precedence everywhere:
 *   managed setting > env carrier > default
 * (floor default monthly 2,592,000s, fail-closed; firing default ON, so
 * deploying the slice halts nothing; start-paused default true, so a
 * new schedule never fires before an operator looks at it; rate
 * defaults 120 firings / 60 minutes).
 *
 * Every read here is fail-safe: a missing mas_settings table (a
 * store that has never ensured it) reads as "no managed value",
 * never a throw — the floor and the firing default still apply.
 * Writes ensure the table first (the screeningFlags ensure-on-
 * every-call shape). The firing-rate check is best-effort too: a
 * store failure skips the alert, never the firing.
 *
 * The R2 driver note (#6482, verified in source): ListMultipartUploads
 * has NO call site in src/; the schedulable R2-listing driver is the
 * corpus sync (src/services/corpusSync.ts:216, paginated
 * bucket.list({prefix:"knowledge/"}) per sync), armed as a schedule
 * — so it is governed by the same floor + kill-switch as every
 * other armed schedule. Nothing here names a driver the code does
 * not show.
 */
import { resolveEnvironmentConfig } from "../config/environment";
import {
  DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP,
  DEFAULT_GOAL_RUN_TICK_HISTORY_CAP,
  GOAL_RUN_JOB_RUN_RECORD_CAP_ENV_VAR,
  GOAL_RUN_JOB_RUN_RECORD_CAP_SETTING_KEY,
  GOAL_RUN_TICK_HISTORY_CAP_ENV_VAR,
  GOAL_RUN_TICK_HISTORY_CAP_SETTING_KEY,
  goalRunJobRunRecordCapSource,
  goalRunTickHistoryCapSource,
  parseGoalRunRetentionCap,
  resolveGoalRunJobRunRecordCap,
  resolveGoalRunTickHistoryCap,
  type GoalRunRetentionSource,
} from "../config/goalRunRetention";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES,
  HEARTBEAT_INTERVAL_ENV_VAR,
  HEARTBEAT_INTERVAL_SETTING_KEY,
  HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR,
  HEARTBEAT_WATCHDOG_STALE_AFTER_SETTING_KEY,
  heartbeatIntervalSecondsSource,
  heartbeatWatchdogStaleAfterSource,
  parseHeartbeatIntervalSeconds,
  parseHeartbeatWatchdogStaleAfterMinutes,
  resolveHeartbeatIntervalSecondsFrom,
  resolveHeartbeatWatchdogStaleAfterMsFrom,
  type HeartbeatWatchdogSource,
} from "../config/heartbeatWatchdog";
import {
  DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES,
  MISSED_SCHEDULE_GRACE_ENV_VAR,
  MISSED_SCHEDULE_GRACE_SETTING_KEY,
  missedScheduleGraceSource,
  parseMissedScheduleGraceMinutes,
  resolveMissedScheduleGraceMinutesFrom,
  type MissedScheduleGraceSource,
} from "../config/missedScheduleAlert";
import {
  DEFAULT_RESEARCH_JOB_CONFIG,
  RESEARCH_SCHEDULE_UTC_HOUR_ENV_VAR,
  RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY,
  parseResearchScheduleUtcHour,
  researchScheduleUtcHourSource,
  resolveResearchScheduleUtcHour,
  type ResearchScheduleUtcHourSource,
} from "../config/researchJobConfig";
import {
  DEFAULT_SCHEDULE_DUE_GUARD_MS,
  SCHEDULE_DUE_GUARD_ENV_VAR,
  SCHEDULE_DUE_GUARD_SETTING_KEY,
  parseScheduleDueGuardMs,
  resolveScheduleDueGuardMs,
  scheduleDueGuardSource,
  type ScheduleDueGuardSource,
} from "../config/scheduleDueGuard";
import {
  AGENT_SCHEDULE_MIN_INTERVAL_ENV_VAR,
  DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS,
  SCHEDULE_MIN_INTERVAL_SETTING_KEY,
  parseScheduleMinIntervalSeconds,
  resolveScheduleMinIntervalSeconds,
  scheduleMinIntervalSource,
  type ScheduleMinIntervalSource,
} from "../config/scheduleFrequencyFloor";
import {
  DEFAULT_SCHEDULE_FIRING_ENABLED,
  SCHEDULE_FIRING_ENABLED_ENV_VAR,
  SCHEDULE_FIRING_ENABLED_SETTING_KEY,
  parseScheduleFiringEnabled,
  resolveScheduleFiringEnabled,
  scheduleFiringEnabledSource,
  type ScheduleFiringEnabledSource,
} from "../config/scheduleFiringKillSwitch";
import {
  DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD,
  DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES,
  SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR,
  SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_SETTING_KEY,
  SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR,
  SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_SETTING_KEY,
  parseScheduleFiringRateAlertThreshold,
  parseScheduleFiringRateAlertWindowMinutes,
  resolveEffectiveScheduleFiringRateAlertThreshold,
  resolveEffectiveScheduleFiringRateAlertWindowMinutes,
  scheduleFiringRateAlertThresholdSource,
  scheduleFiringRateAlertWindowMinutesSource,
  type ScheduleFiringRateAlertSource,
} from "../config/scheduleFiringRateAlert";
import {
  DEFAULT_SCHEDULE_START_PAUSED,
  SCHEDULE_START_PAUSED_ENV_VAR,
  SCHEDULE_START_PAUSED_SETTING_KEY,
  parseScheduleStartPaused,
  resolveScheduleStartPaused,
  scheduleStartPausedSource,
  type ScheduleStartPausedSource,
} from "../config/scheduleStartPaused";
import {
  DEFAULT_STALE_RUNNING_REAP_MS,
  DEFAULT_STALE_SWEEP_BATCH_LIMIT,
  STALE_RUNNING_REAP_ENV_VAR,
  STALE_RUNNING_REAP_SETTING_KEY,
  STALE_SWEEP_BATCH_LIMIT_ENV_VAR,
  STALE_SWEEP_BATCH_LIMIT_SETTING_KEY,
  parseStaleRunningReapMs,
  parseStaleSweepBatchLimit,
  resolveStaleRunningReapMs,
  resolveStaleSweepBatchLimit,
  staleRunningReapSource,
  staleSweepBatchLimitSource,
  type StaleAsyncJobReapSource,
} from "../config/staleAsyncJobReap";
import { createSettingsPort } from "../data/createSettingsPorts";
import type { SettingsSqlExecutor } from "../data/settingsReadPorts";
import {
  createJobRunRecordAdapter,
  type D1JobRunRecordStore,
} from "../data/createJobRunRecordPorts";

/** Minimal SQL surface the controls read/write over (the SettingsPort seam). */
export type ScheduleControlsSql = SettingsSqlExecutor;

/** The throttle marker for the firing-rate alert (last alert time, ISO). */
export const SCHEDULE_FIRING_RATE_ALERT_LAST_AT_KEY = "schedule.firingRateAlertLastAt";

/**
 * Read one managed value, fail-safe: a missing table or a store
 * failure reads as "no managed value" (null), never a throw — the
 * env carrier and the default still apply.
 */
export function readScheduleManagedSetting(
  sql: ScheduleControlsSql,
  key: string,
): string | null {
  try {
    return createSettingsPort(sql as never).get(key);
  } catch {
    return null;
  }
}

/** Write one managed value (ensures the table first). */
export function writeScheduleManagedSetting(
  sql: ScheduleControlsSql,
  key: string,
  value: string,
  updatedAt?: string,
): void {
  const port = createSettingsPort(sql as never);
  port.ensureSchema();
  port.set(key, value, updatedAt);
}

/** The effective floor with its source and the per-source values (for the home). */
export interface EffectiveScheduleFloor {
  seconds: number;
  source: ScheduleMinIntervalSource;
  managed: number | null;
  env: number | null;
  default: number;
}

/** Resolve the effective floor: managed > env carrier > default (monthly). */
export function resolveEffectiveScheduleFloor(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveScheduleFloor {
  const managedRaw = readScheduleManagedSetting(sql, SCHEDULE_MIN_INTERVAL_SETTING_KEY);
  // The env carrier is the #3122 resolver's value (same parse as the
  // capability has always used); the raw env record is the fallback
  // when the resolver cannot run (a bare test env).
  let envValue: number | undefined;
  try {
    envValue = resolveEnvironmentConfig(env as never)?.agentSchedule?.minIntervalSeconds;
  } catch {
    envValue = undefined;
  }
  if (envValue === undefined) {
    envValue = parseScheduleMinIntervalSeconds(
      (env as Record<string, unknown> | undefined)?.[AGENT_SCHEDULE_MIN_INTERVAL_ENV_VAR],
    );
  }
  const managed = parseScheduleMinIntervalSeconds(managedRaw ?? undefined);
  return {
    seconds: resolveScheduleMinIntervalSeconds({ managed, env: envValue }),
    source: scheduleMinIntervalSource({ managed, env: envValue }),
    managed: managed ?? null,
    env: envValue ?? null,
    default: DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS,
  };
}

/** The effective firing state with its source and the per-source values (for the home). */
export interface EffectiveScheduleFiringEnabled {
  enabled: boolean;
  source: ScheduleFiringEnabledSource;
  managed: boolean | null;
  env: boolean | null;
  default: boolean;
}

/** Resolve the effective kill-switch: managed > env carrier > default ON. */
export function resolveEffectiveScheduleFiringEnabled(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveScheduleFiringEnabled {
  const managedRaw = readScheduleManagedSetting(sql, SCHEDULE_FIRING_ENABLED_SETTING_KEY);
  const managed = parseScheduleFiringEnabled(managedRaw ?? undefined);
  const envValue = parseScheduleFiringEnabled(
    (env as Record<string, unknown> | undefined)?.[SCHEDULE_FIRING_ENABLED_ENV_VAR],
  );
  return {
    enabled: resolveScheduleFiringEnabled({ managed, env: envValue }),
    source: scheduleFiringEnabledSource({ managed, env: envValue }),
    managed: managed ?? null,
    env: envValue ?? null,
    default: DEFAULT_SCHEDULE_FIRING_ENABLED,
  };
}

/** The effective start-paused control with its source and the per-source values (for the home). */
export interface EffectiveScheduleStartPaused {
  paused: boolean;
  source: ScheduleStartPausedSource;
  managed: boolean | null;
  env: boolean | null;
  default: boolean;
}

/**
 * Resolve the effective start-paused control: managed > env carrier
 * > default (paused). The creation paths read this, never a
 * hardcoded starting state.
 */
export function resolveEffectiveScheduleStartPaused(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveScheduleStartPaused {
  const managedRaw = readScheduleManagedSetting(sql, SCHEDULE_START_PAUSED_SETTING_KEY);
  const managed = parseScheduleStartPaused(managedRaw ?? undefined);
  const envValue = parseScheduleStartPaused(
    (env as Record<string, unknown> | undefined)?.[SCHEDULE_START_PAUSED_ENV_VAR],
  );
  return {
    paused: resolveScheduleStartPaused({ managed, env: envValue }),
    source: scheduleStartPausedSource({ managed, env: envValue }),
    managed: managed ?? null,
    env: envValue ?? null,
    default: DEFAULT_SCHEDULE_START_PAUSED,
  };
}

/** The effective firing-rate alert thresholds with their sources and the per-source values. */
export interface EffectiveScheduleFiringRateAlert {
  threshold: number;
  thresholdSource: ScheduleFiringRateAlertSource;
  managedThreshold: number | null;
  envThreshold: number | null;
  defaultThreshold: number;
  windowMinutes: number;
  windowSource: ScheduleFiringRateAlertSource;
  managedWindowMinutes: number | null;
  envWindowMinutes: number | null;
  defaultWindowMinutes: number;
}

/** Resolve the effective firing-rate thresholds: managed > env carrier > default (120 / 60). */
export function resolveEffectiveScheduleFiringRateAlert(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveScheduleFiringRateAlert {
  const managedThresholdRaw = readScheduleManagedSetting(
    sql,
    SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_SETTING_KEY,
  );
  const managedWindowRaw = readScheduleManagedSetting(
    sql,
    SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_SETTING_KEY,
  );
  const managedThreshold = parseScheduleFiringRateAlertThreshold(managedThresholdRaw ?? undefined);
  const managedWindow = parseScheduleFiringRateAlertWindowMinutes(managedWindowRaw ?? undefined);
  const envRecord = env as Record<string, unknown> | undefined;
  const envThreshold = parseScheduleFiringRateAlertThreshold(
    envRecord?.[SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR],
  );
  const envWindow = parseScheduleFiringRateAlertWindowMinutes(
    envRecord?.[SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR],
  );
  return {
    threshold: resolveEffectiveScheduleFiringRateAlertThreshold({
      managed: managedThreshold,
      env: envThreshold,
    }),
    thresholdSource: scheduleFiringRateAlertThresholdSource({
      managed: managedThreshold,
      env: envThreshold,
    }),
    managedThreshold: managedThreshold ?? null,
    envThreshold: envThreshold ?? null,
    defaultThreshold: DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD,
    windowMinutes: resolveEffectiveScheduleFiringRateAlertWindowMinutes({
      managed: managedWindow,
      env: envWindow,
    }),
    windowSource: scheduleFiringRateAlertWindowMinutesSource({
      managed: managedWindow,
      env: envWindow,
    }),
    managedWindowMinutes: managedWindow ?? null,
    envWindowMinutes: envWindow ?? null,
    defaultWindowMinutes: DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES,
  };
}

/* =====================================================================
 * Issue #6503 step 13 — the externalized remainder (managed > env > default)
 * ===================================================================== */

/** The effective heartbeat interval with its source and the per-source values (for the home). */
export interface EffectiveHeartbeatInterval {
  seconds: number;
  source: HeartbeatWatchdogSource;
  managed: number | null;
  env: number | null;
  default: number;
}

/** Resolve the effective heartbeat interval: managed > env carrier > default (1800s). */
export function resolveEffectiveHeartbeatInterval(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveHeartbeatInterval {
  const managedRaw = readScheduleManagedSetting(sql, HEARTBEAT_INTERVAL_SETTING_KEY);
  const managed = parseHeartbeatIntervalSeconds(managedRaw ?? undefined);
  const envValue = parseHeartbeatIntervalSeconds(
    (env as Record<string, unknown> | undefined)?.[HEARTBEAT_INTERVAL_ENV_VAR],
  );
  return {
    seconds: resolveHeartbeatIntervalSecondsFrom({ managed, env: envValue }),
    source: heartbeatIntervalSecondsSource({ managed, env: envValue }),
    managed: managed ?? null,
    env: envValue ?? null,
    default: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  };
}

/** The effective watchdog staleness threshold with its source and the per-source values. */
export interface EffectiveHeartbeatWatchdogStaleAfter {
  /** Threshold in minutes (the managed/env unit); the ms form is minutes * 60_000. */
  minutes: number;
  ms: number;
  source: HeartbeatWatchdogSource;
  managedMinutes: number | null;
  envMinutes: number | null;
  defaultMinutes: number;
}

/** Resolve the effective staleness threshold: managed > env carrier > default (120 minutes). */
export function resolveEffectiveHeartbeatWatchdogStaleAfter(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveHeartbeatWatchdogStaleAfter {
  const managedRaw = readScheduleManagedSetting(sql, HEARTBEAT_WATCHDOG_STALE_AFTER_SETTING_KEY);
  const managed = parseHeartbeatWatchdogStaleAfterMinutes(managedRaw ?? undefined);
  const envValue = parseHeartbeatWatchdogStaleAfterMinutes(
    (env as Record<string, unknown> | undefined)?.[HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR],
  );
  const minutes =
    managed ?? envValue ?? DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES;
  return {
    minutes,
    ms: resolveHeartbeatWatchdogStaleAfterMsFrom({ managed, env: envValue }),
    source: heartbeatWatchdogStaleAfterSource({ managed, env: envValue }),
    managedMinutes: managed ?? null,
    envMinutes: envValue ?? null,
    defaultMinutes: DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES,
  };
}

/** The effective missed-schedule grace with its source and the per-source values (for the home). */
export interface EffectiveMissedScheduleGrace {
  /** Grace in minutes (the managed/env unit); 0 disables the watchdog. */
  minutes: number;
  /** Grace in milliseconds (the read path's unit); 0 disables the watchdog. */
  ms: number;
  source: MissedScheduleGraceSource;
  managedMinutes: number | null;
  envMinutes: number | null;
  defaultMinutes: number;
}

/** Resolve the effective watchdog grace: managed > env carrier > default (60 minutes, 0 disables). */
export function resolveEffectiveMissedScheduleGrace(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveMissedScheduleGrace {
  const managedRaw = readScheduleManagedSetting(sql, MISSED_SCHEDULE_GRACE_SETTING_KEY);
  const managed = parseMissedScheduleGraceMinutes(managedRaw ?? undefined);
  const envValue = parseMissedScheduleGraceMinutes(
    (env as Record<string, unknown> | undefined)?.[MISSED_SCHEDULE_GRACE_ENV_VAR],
  );
  const minutes = resolveMissedScheduleGraceMinutesFrom({ managed, env: envValue });
  return {
    minutes,
    ms: Math.round(minutes * 60 * 1000),
    source: missedScheduleGraceSource({ managed, env: envValue }),
    managedMinutes: managed ?? null,
    envMinutes: envValue ?? null,
    defaultMinutes: DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES,
  };
}

/** The effective isDue guard window with its source and the per-source values (for the home). */
export interface EffectiveScheduleDueGuard {
  ms: number;
  source: ScheduleDueGuardSource;
  managedMs: number | null;
  envMs: number | null;
  defaultMs: number;
}

/** Resolve the effective due guard: managed > env carrier > default (23h). */
export function resolveEffectiveScheduleDueGuard(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveScheduleDueGuard {
  const managedRaw = readScheduleManagedSetting(sql, SCHEDULE_DUE_GUARD_SETTING_KEY);
  const managed = parseScheduleDueGuardMs(managedRaw ?? undefined);
  const envValue = parseScheduleDueGuardMs(
    (env as Record<string, unknown> | undefined)?.[SCHEDULE_DUE_GUARD_ENV_VAR],
  );
  return {
    ms: resolveScheduleDueGuardMs({ managed, env: envValue }),
    source: scheduleDueGuardSource({ managed, env: envValue }),
    managedMs: managed ?? null,
    envMs: envValue ?? null,
    defaultMs: DEFAULT_SCHEDULE_DUE_GUARD_MS,
  };
}

/** The effective stale-async-job reap policy with its sources and the per-source values. */
export interface EffectiveStaleAsyncJobReap {
  reapMs: number;
  reapSource: StaleAsyncJobReapSource;
  managedReapMs: number | null;
  envReapMs: number | null;
  defaultReapMs: number;
  batchLimit: number;
  batchLimitSource: StaleAsyncJobReapSource;
  managedBatchLimit: number | null;
  envBatchLimit: number | null;
  defaultBatchLimit: number;
}

/** Resolve the effective reap policy: managed > env carrier > default (2h / 100 rows). */
export function resolveEffectiveStaleAsyncJobReap(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveStaleAsyncJobReap {
  const managedReapRaw = readScheduleManagedSetting(sql, STALE_RUNNING_REAP_SETTING_KEY);
  const managedBatchRaw = readScheduleManagedSetting(sql, STALE_SWEEP_BATCH_LIMIT_SETTING_KEY);
  const managedReap = parseStaleRunningReapMs(managedReapRaw ?? undefined);
  const managedBatch = parseStaleSweepBatchLimit(managedBatchRaw ?? undefined);
  const envRecord = env as Record<string, unknown> | undefined;
  const envReap = parseStaleRunningReapMs(envRecord?.[STALE_RUNNING_REAP_ENV_VAR]);
  const envBatch = parseStaleSweepBatchLimit(envRecord?.[STALE_SWEEP_BATCH_LIMIT_ENV_VAR]);
  return {
    reapMs: resolveStaleRunningReapMs({ managed: managedReap, env: envReap }),
    reapSource: staleRunningReapSource({ managed: managedReap, env: envReap }),
    managedReapMs: managedReap ?? null,
    envReapMs: envReap ?? null,
    defaultReapMs: DEFAULT_STALE_RUNNING_REAP_MS,
    batchLimit: resolveStaleSweepBatchLimit({ managed: managedBatch, env: envBatch }),
    batchLimitSource: staleSweepBatchLimitSource({ managed: managedBatch, env: envBatch }),
    managedBatchLimit: managedBatch ?? null,
    envBatchLimit: envBatch ?? null,
    defaultBatchLimit: DEFAULT_STALE_SWEEP_BATCH_LIMIT,
  };
}

/** The effective research fire hour with its source and the per-source values (for the home). */
export interface EffectiveResearchScheduleUtcHour {
  hour: number;
  source: ResearchScheduleUtcHourSource;
  managedHour: number | null;
  envHour: number | null;
  defaultHour: number;
}

/** Resolve the effective research fire hour: managed > env carrier > default (21 UTC). */
export function resolveEffectiveResearchScheduleUtcHour(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveResearchScheduleUtcHour {
  const managedRaw = readScheduleManagedSetting(sql, RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY);
  const managed = parseResearchScheduleUtcHour(managedRaw ?? undefined);
  const envRecord = env as Record<string, unknown> | undefined;
  const envRaw = envRecord?.[RESEARCH_SCHEDULE_UTC_HOUR_ENV_VAR];
  // The env leg clamps out-of-range hours into 0–23 (the pre-existing
  // resolveResearchJobConfig behavior); the source names "env" for any
  // numeric env value, managed wins over it. envHour shows the clamped
  // env value, the same number the env leg would resolve to on its own.
  const hour = resolveResearchScheduleUtcHour({ managed, env: envRaw });
  const envHour =
    typeof envRaw === "string" && envRaw.trim() !== "" && Number.isFinite(Number(envRaw.trim()))
      ? resolveResearchScheduleUtcHour({ env: envRaw })
      : null;
  return {
    hour,
    source: researchScheduleUtcHourSource({ managed, env: envRaw }),
    managedHour: managed ?? null,
    envHour,
    defaultHour: DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour,
  };
}

/** The effective goal-run retention caps with their sources and the per-source values. */
export interface EffectiveGoalRunRetention {
  jobRunRecordCap: number;
  jobRunRecordCapSource: GoalRunRetentionSource;
  managedJobRunRecordCap: number | null;
  envJobRunRecordCap: number | null;
  defaultJobRunRecordCap: number;
  tickHistoryCap: number;
  tickHistoryCapSource: GoalRunRetentionSource;
  managedTickHistoryCap: number | null;
  envTickHistoryCap: number | null;
  defaultTickHistoryCap: number;
}

/** Resolve the effective retention caps: managed > env carrier > default (500 / 50). */
export function resolveEffectiveGoalRunRetention(
  sql: ScheduleControlsSql,
  env: unknown,
): EffectiveGoalRunRetention {
  const managedJobRaw = readScheduleManagedSetting(sql, GOAL_RUN_JOB_RUN_RECORD_CAP_SETTING_KEY);
  const managedTickRaw = readScheduleManagedSetting(sql, GOAL_RUN_TICK_HISTORY_CAP_SETTING_KEY);
  const managedJob = parseGoalRunRetentionCap(managedJobRaw ?? undefined);
  const managedTick = parseGoalRunRetentionCap(managedTickRaw ?? undefined);
  const envRecord = env as Record<string, unknown> | undefined;
  const envJob = parseGoalRunRetentionCap(envRecord?.[GOAL_RUN_JOB_RUN_RECORD_CAP_ENV_VAR]);
  const envTick = parseGoalRunRetentionCap(envRecord?.[GOAL_RUN_TICK_HISTORY_CAP_ENV_VAR]);
  return {
    jobRunRecordCap: resolveGoalRunJobRunRecordCap({ managed: managedJob, env: envJob }),
    jobRunRecordCapSource: goalRunJobRunRecordCapSource({ managed: managedJob, env: envJob }),
    managedJobRunRecordCap: managedJob ?? null,
    envJobRunRecordCap: envJob ?? null,
    defaultJobRunRecordCap: DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP,
    tickHistoryCap: resolveGoalRunTickHistoryCap({ managed: managedTick, env: envTick }),
    tickHistoryCapSource: goalRunTickHistoryCapSource({ managed: managedTick, env: envTick }),
    managedTickHistoryCap: managedTick ?? null,
    envTickHistoryCap: envTick ?? null,
    defaultTickHistoryCap: DEFAULT_GOAL_RUN_TICK_HISTORY_CAP,
  };
}

/** One controls write: a value, or null to clear the managed key (fall back to env/default). */
export interface ScheduleControlsPatch {
  minIntervalSeconds?: number | string | null;
  firingEnabled?: boolean | string | null;
  startPaused?: boolean | string | null;
  firingRateAlertThreshold?: number | string | null;
  firingRateAlertWindowMinutes?: number | string | null;
  /** Issue #6503 step 13 — the externalized remainder (same null-clears rule). */
  heartbeatIntervalSeconds?: number | string | null;
  heartbeatWatchdogStaleAfterMinutes?: number | string | null;
  missedScheduleGraceMinutes?: number | string | null;
  dueGuardMs?: number | string | null;
  staleRunningReapMs?: number | string | null;
  staleSweepBatchLimit?: number | string | null;
  researchScheduleUtcHour?: number | string | null;
  jobRunRecordCap?: number | string | null;
  tickHistoryCap?: number | string | null;
}

export type ScheduleControlsPatchResult =
  | {
      ok: true;
      changed: {
        minIntervalSeconds?: number | null;
        firingEnabled?: boolean | null;
        startPaused?: boolean | null;
        firingRateAlertThreshold?: number | null;
        firingRateAlertWindowMinutes?: number | null;
        heartbeatIntervalSeconds?: number | null;
        heartbeatWatchdogStaleAfterMinutes?: number | null;
        missedScheduleGraceMinutes?: number | null;
        dueGuardMs?: number | null;
        staleRunningReapMs?: number | null;
        staleSweepBatchLimit?: number | null;
        researchScheduleUtcHour?: number | null;
        jobRunRecordCap?: number | null;
        tickHistoryCap?: number | null;
      };
    }
  | { ok: false; code: "INVALID_CONTROLS"; message: string };

/**
 * Apply one controls write through the managed store. Validation
 * is fail-closed: an invalid floor (zero, negative, fractional,
 * non-numeric), a non-boolean firing/start-paused value, or an
 * invalid rate threshold/window refuses the WHOLE patch and writes
 * nothing.
 */
export function applyScheduleControlsPatch(
  sql: ScheduleControlsSql,
  patch: ScheduleControlsPatch,
  nowIso: string,
): ScheduleControlsPatchResult {
  let floor: number | null | undefined;
  if (patch.minIntervalSeconds !== undefined) {
    if (patch.minIntervalSeconds === null) {
      floor = null;
    } else {
      const parsed = parseScheduleMinIntervalSeconds(patch.minIntervalSeconds);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `minIntervalSeconds must be a positive whole number of seconds (got ${String(patch.minIntervalSeconds)}); nothing was changed.`,
        };
      }
      floor = parsed;
    }
  }
  let firing: boolean | null | undefined;
  if (patch.firingEnabled !== undefined) {
    if (patch.firingEnabled === null) {
      firing = null;
    } else {
      const parsed = parseScheduleFiringEnabled(patch.firingEnabled);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `firingEnabled must be a boolean (got ${String(patch.firingEnabled)}); nothing was changed.`,
        };
      }
      firing = parsed;
    }
  }
  let startPaused: boolean | null | undefined;
  if (patch.startPaused !== undefined) {
    if (patch.startPaused === null) {
      startPaused = null;
    } else {
      const parsed = parseScheduleStartPaused(patch.startPaused);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `startPaused must be a boolean (got ${String(patch.startPaused)}); nothing was changed.`,
        };
      }
      startPaused = parsed;
    }
  }
  let rateThreshold: number | null | undefined;
  if (patch.firingRateAlertThreshold !== undefined) {
    if (patch.firingRateAlertThreshold === null) {
      rateThreshold = null;
    } else {
      const parsed = parseScheduleFiringRateAlertThreshold(patch.firingRateAlertThreshold);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `firingRateAlertThreshold must be a whole number of firings (0 disables the alert; got ${String(patch.firingRateAlertThreshold)}); nothing was changed.`,
        };
      }
      rateThreshold = parsed;
    }
  }
  let rateWindow: number | null | undefined;
  if (patch.firingRateAlertWindowMinutes !== undefined) {
    if (patch.firingRateAlertWindowMinutes === null) {
      rateWindow = null;
    } else {
      const parsed = parseScheduleFiringRateAlertWindowMinutes(patch.firingRateAlertWindowMinutes);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `firingRateAlertWindowMinutes must be a positive whole number of minutes (got ${String(patch.firingRateAlertWindowMinutes)}); nothing was changed.`,
        };
      }
      rateWindow = parsed;
    }
  }
  // Issue #6503 step 13 — the externalized remainder. Same
  // fail-closed rule: one invalid value refuses the WHOLE patch
  // and writes nothing. A grace of 0 disables the watchdog (the
  // pre-existing env semantic); every other knob needs a positive
  // value, and the research hour needs a whole UTC hour 0–23.
  let heartbeatInterval: number | null | undefined;
  if (patch.heartbeatIntervalSeconds !== undefined) {
    if (patch.heartbeatIntervalSeconds === null) {
      heartbeatInterval = null;
    } else {
      const parsed = parseHeartbeatIntervalSeconds(patch.heartbeatIntervalSeconds);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `heartbeatIntervalSeconds must be a positive number of seconds (got ${String(patch.heartbeatIntervalSeconds)}); nothing was changed.`,
        };
      }
      heartbeatInterval = parsed;
    }
  }
  let heartbeatStaleAfter: number | null | undefined;
  if (patch.heartbeatWatchdogStaleAfterMinutes !== undefined) {
    if (patch.heartbeatWatchdogStaleAfterMinutes === null) {
      heartbeatStaleAfter = null;
    } else {
      const parsed = parseHeartbeatWatchdogStaleAfterMinutes(patch.heartbeatWatchdogStaleAfterMinutes);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `heartbeatWatchdogStaleAfterMinutes must be a positive number of minutes (got ${String(patch.heartbeatWatchdogStaleAfterMinutes)}); nothing was changed.`,
        };
      }
      heartbeatStaleAfter = parsed;
    }
  }
  let grace: number | null | undefined;
  if (patch.missedScheduleGraceMinutes !== undefined) {
    if (patch.missedScheduleGraceMinutes === null) {
      grace = null;
    } else {
      const parsed = parseMissedScheduleGraceMinutes(patch.missedScheduleGraceMinutes);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `missedScheduleGraceMinutes must be a number of minutes (0 disables the watchdog; got ${String(patch.missedScheduleGraceMinutes)}); nothing was changed.`,
        };
      }
      grace = parsed;
    }
  }
  let dueGuard: number | null | undefined;
  if (patch.dueGuardMs !== undefined) {
    if (patch.dueGuardMs === null) {
      dueGuard = null;
    } else {
      const parsed = parseScheduleDueGuardMs(patch.dueGuardMs);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `dueGuardMs must be a positive whole number of milliseconds (got ${String(patch.dueGuardMs)}); nothing was changed.`,
        };
      }
      dueGuard = parsed;
    }
  }
  let reapMs: number | null | undefined;
  if (patch.staleRunningReapMs !== undefined) {
    if (patch.staleRunningReapMs === null) {
      reapMs = null;
    } else {
      const parsed = parseStaleRunningReapMs(patch.staleRunningReapMs);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `staleRunningReapMs must be a positive whole number of milliseconds (got ${String(patch.staleRunningReapMs)}); nothing was changed.`,
        };
      }
      reapMs = parsed;
    }
  }
  let reapBatch: number | null | undefined;
  if (patch.staleSweepBatchLimit !== undefined) {
    if (patch.staleSweepBatchLimit === null) {
      reapBatch = null;
    } else {
      const parsed = parseStaleSweepBatchLimit(patch.staleSweepBatchLimit);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `staleSweepBatchLimit must be a positive whole number of rows (got ${String(patch.staleSweepBatchLimit)}); nothing was changed.`,
        };
      }
      reapBatch = parsed;
    }
  }
  let researchHour: number | null | undefined;
  if (patch.researchScheduleUtcHour !== undefined) {
    if (patch.researchScheduleUtcHour === null) {
      researchHour = null;
    } else {
      const parsed = parseResearchScheduleUtcHour(patch.researchScheduleUtcHour);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `researchScheduleUtcHour must be a whole UTC hour from 0 to 23 (got ${String(patch.researchScheduleUtcHour)}); nothing was changed.`,
        };
      }
      researchHour = parsed;
    }
  }
  let jobRunCap: number | null | undefined;
  if (patch.jobRunRecordCap !== undefined) {
    if (patch.jobRunRecordCap === null) {
      jobRunCap = null;
    } else {
      const parsed = parseGoalRunRetentionCap(patch.jobRunRecordCap);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `jobRunRecordCap must be a positive whole number of records (got ${String(patch.jobRunRecordCap)}); nothing was changed.`,
        };
      }
      jobRunCap = parsed;
    }
  }
  let tickCap: number | null | undefined;
  if (patch.tickHistoryCap !== undefined) {
    if (patch.tickHistoryCap === null) {
      tickCap = null;
    } else {
      const parsed = parseGoalRunRetentionCap(patch.tickHistoryCap);
      if (parsed === undefined) {
        return {
          ok: false,
          code: "INVALID_CONTROLS",
          message: `tickHistoryCap must be a positive whole number of entries (got ${String(patch.tickHistoryCap)}); nothing was changed.`,
        };
      }
      tickCap = parsed;
    }
  }
  if (
    floor === undefined &&
    firing === undefined &&
    startPaused === undefined &&
    rateThreshold === undefined &&
    rateWindow === undefined &&
    heartbeatInterval === undefined &&
    heartbeatStaleAfter === undefined &&
    grace === undefined &&
    dueGuard === undefined &&
    reapMs === undefined &&
    reapBatch === undefined &&
    researchHour === undefined &&
    jobRunCap === undefined &&
    tickCap === undefined
  ) {
    return { ok: true, changed: {} };
  }
  const port = createSettingsPort(sql as never);
  port.ensureSchema();
  const changed: {
    minIntervalSeconds?: number | null;
    firingEnabled?: boolean | null;
    startPaused?: boolean | null;
    firingRateAlertThreshold?: number | null;
    firingRateAlertWindowMinutes?: number | null;
    heartbeatIntervalSeconds?: number | null;
    heartbeatWatchdogStaleAfterMinutes?: number | null;
    missedScheduleGraceMinutes?: number | null;
    dueGuardMs?: number | null;
    staleRunningReapMs?: number | null;
    staleSweepBatchLimit?: number | null;
    researchScheduleUtcHour?: number | null;
    jobRunRecordCap?: number | null;
    tickHistoryCap?: number | null;
  } = {};
  if (floor !== undefined) {
    if (floor === null) port.delete(SCHEDULE_MIN_INTERVAL_SETTING_KEY);
    else port.set(SCHEDULE_MIN_INTERVAL_SETTING_KEY, String(floor), nowIso);
    changed.minIntervalSeconds = floor;
  }
  if (firing !== undefined) {
    if (firing === null) port.delete(SCHEDULE_FIRING_ENABLED_SETTING_KEY);
    else port.set(SCHEDULE_FIRING_ENABLED_SETTING_KEY, firing ? "on" : "off", nowIso);
    changed.firingEnabled = firing;
  }
  if (startPaused !== undefined) {
    if (startPaused === null) port.delete(SCHEDULE_START_PAUSED_SETTING_KEY);
    else port.set(SCHEDULE_START_PAUSED_SETTING_KEY, startPaused ? "on" : "off", nowIso);
    changed.startPaused = startPaused;
  }
  if (rateThreshold !== undefined) {
    if (rateThreshold === null) port.delete(SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_SETTING_KEY);
    else port.set(SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_SETTING_KEY, String(rateThreshold), nowIso);
    changed.firingRateAlertThreshold = rateThreshold;
  }
  if (rateWindow !== undefined) {
    if (rateWindow === null) port.delete(SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_SETTING_KEY);
    else port.set(SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_SETTING_KEY, String(rateWindow), nowIso);
    changed.firingRateAlertWindowMinutes = rateWindow;
  }
  if (heartbeatInterval !== undefined) {
    if (heartbeatInterval === null) port.delete(HEARTBEAT_INTERVAL_SETTING_KEY);
    else port.set(HEARTBEAT_INTERVAL_SETTING_KEY, String(heartbeatInterval), nowIso);
    changed.heartbeatIntervalSeconds = heartbeatInterval;
  }
  if (heartbeatStaleAfter !== undefined) {
    if (heartbeatStaleAfter === null) port.delete(HEARTBEAT_WATCHDOG_STALE_AFTER_SETTING_KEY);
    else port.set(HEARTBEAT_WATCHDOG_STALE_AFTER_SETTING_KEY, String(heartbeatStaleAfter), nowIso);
    changed.heartbeatWatchdogStaleAfterMinutes = heartbeatStaleAfter;
  }
  if (grace !== undefined) {
    if (grace === null) port.delete(MISSED_SCHEDULE_GRACE_SETTING_KEY);
    else port.set(MISSED_SCHEDULE_GRACE_SETTING_KEY, String(grace), nowIso);
    changed.missedScheduleGraceMinutes = grace;
  }
  if (dueGuard !== undefined) {
    if (dueGuard === null) port.delete(SCHEDULE_DUE_GUARD_SETTING_KEY);
    else port.set(SCHEDULE_DUE_GUARD_SETTING_KEY, String(dueGuard), nowIso);
    changed.dueGuardMs = dueGuard;
  }
  if (reapMs !== undefined) {
    if (reapMs === null) port.delete(STALE_RUNNING_REAP_SETTING_KEY);
    else port.set(STALE_RUNNING_REAP_SETTING_KEY, String(reapMs), nowIso);
    changed.staleRunningReapMs = reapMs;
  }
  if (reapBatch !== undefined) {
    if (reapBatch === null) port.delete(STALE_SWEEP_BATCH_LIMIT_SETTING_KEY);
    else port.set(STALE_SWEEP_BATCH_LIMIT_SETTING_KEY, String(reapBatch), nowIso);
    changed.staleSweepBatchLimit = reapBatch;
  }
  if (researchHour !== undefined) {
    if (researchHour === null) port.delete(RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY);
    else port.set(RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY, String(researchHour), nowIso);
    changed.researchScheduleUtcHour = researchHour;
  }
  if (jobRunCap !== undefined) {
    if (jobRunCap === null) port.delete(GOAL_RUN_JOB_RUN_RECORD_CAP_SETTING_KEY);
    else port.set(GOAL_RUN_JOB_RUN_RECORD_CAP_SETTING_KEY, String(jobRunCap), nowIso);
    changed.jobRunRecordCap = jobRunCap;
  }
  if (tickCap !== undefined) {
    if (tickCap === null) port.delete(GOAL_RUN_TICK_HISTORY_CAP_SETTING_KEY);
    else port.set(GOAL_RUN_TICK_HISTORY_CAP_SETTING_KEY, String(tickCap), nowIso);
    changed.tickHistoryCap = tickCap;
  }
  return { ok: true, changed };
}

/* =====================================================================
 * Armed-schedule inventory (callback + interval + owner)
 * ===================================================================== */

/** One armed schedule as the home shows it. */
export interface ArmedScheduleInventoryItem {
  id: string;
  callback: string;
  /** The interval in seconds, or null for cron / one-shot rows. */
  intervalSeconds: number | null;
  /** The cron expression, or null for interval / one-shot rows. */
  cron: string | null;
  /** The creator login from provenance, or null when unowned. */
  owner: string | null;
  state: string;
}

/** The list-item shape the inventory derives from (unified list items). */
export interface ArmedScheduleInventoryInput {
  id: string;
  callback?: string;
  type?: string;
  intervalSeconds?: number;
  cron?: string;
  state?: string;
  // Issue #6482 — createdBy is `string | null` on ScheduleProvenance
  // (null when no creator was established, never invented), so the
  // inventory input accepts null too.
  provenance?: { createdBy?: string | null } | null;
}

/**
 * Build the armed-schedule inventory from the unified list items:
 * callback + interval/cron + owner, one row per armed schedule.
 * The owner is the provenance creator login, never invented.
 */
export function buildArmedScheduleInventory(
  items: readonly ArmedScheduleInventoryInput[],
): ArmedScheduleInventoryItem[] {
  return items.map((item) => ({
    id: item.id,
    callback: typeof item.callback === "string" ? item.callback : "",
    intervalSeconds: typeof item.intervalSeconds === "number" ? item.intervalSeconds : null,
    cron: typeof item.cron === "string" ? item.cron : null,
    owner:
      item.provenance && typeof item.provenance.createdBy === "string" && item.provenance.createdBy.trim()
        ? item.provenance.createdBy
        : null,
    state: typeof item.state === "string" ? item.state : "unknown",
  }));
}

/* =====================================================================
 * Firing-rate alert (threshold + emitted observation)
 * ===================================================================== */

/** The pure rate verdict: exceeded only strictly above the threshold (0 = disabled). */
export function evaluateScheduleFiringRate(input: {
  firingsInWindow: number;
  threshold: number;
}): { exceeded: boolean; count: number; threshold: number } {
  const exceeded = input.threshold > 0 && input.firingsInWindow > input.threshold;
  return { exceeded, count: input.firingsInWindow, threshold: input.threshold };
}

/**
 * Count schedule firings (ledger rows) whose start falls in the
 * trailing window. Best-effort: a missing store or a store failure
 * counts 0, never a throw. The read is bounded (newest-first,
 * capped) — a count at the cap still proves "above threshold" for
 * any threshold below it.
 *
 * Issue #6101 — the count reads D1 (the store resolves from the
 * caller's env; a null store counts 0 — no ledger exists to count).
 */
export async function countScheduleFiringsInWindow(
  store: D1JobRunRecordStore | null,
  windowStartMs: number,
  limit = 500,
): Promise<number> {
  if (!store) return 0;
  try {
    const rows = await store.listRecent(limit);
    let count = 0;
    for (const row of rows) {
      const startedMs = Date.parse(row.started);
      if (Number.isFinite(startedMs) && startedMs >= windowStartMs) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export interface ScheduleFiringRateCheck {
  exceeded: boolean;
  count: number;
  threshold: number;
  windowMinutes: number;
  /** True when the observation was emitted on this check (at most once per window). */
  alerted: boolean;
}

/**
 * The firing-rate guardrail, evaluated on the firing path. When
 * firings in the trailing window exceed the configured threshold,
 * the coded `schedule.firing_rate_exceeded` observation is emitted
 * through the caller's sink (the existing audit + structured-log
 * seam the alerting consumes — no new notification mechanism) at
 * most once per window (throttled by the managed-settings marker).
 * Best-effort throughout: a store or sink failure never breaks the
 * firing being recorded.
 */
export async function checkScheduleFiringRate(
  sql: ScheduleControlsSql,
  env: unknown,
  nowMs: number,
  emit?: (type: string, payload: Record<string, unknown>) => void,
): Promise<ScheduleFiringRateCheck> {
  // Issue #6503 — the thresholds are managed settings: a managed
  // value wins over the env carrier, which wins over the default.
  const rate = resolveEffectiveScheduleFiringRateAlert(sql, env);
  const threshold = rate.threshold;
  const windowMinutes = rate.windowMinutes;
  const base = { threshold, windowMinutes, alerted: false };
  if (threshold <= 0) return { ...base, exceeded: false, count: 0 };
  try {
    const windowStartMs = nowMs - windowMinutes * 60_000;
    // Issue #6101 — the count reads D1 (the store resolves from
    // the same env the thresholds read); an unbound D1 counts 0.
    const count = await countScheduleFiringsInWindow(
      createJobRunRecordAdapter(
        env as { AGENT_DB?: unknown } | null | undefined,
      ),
      windowStartMs,
    );
    const { exceeded } = evaluateScheduleFiringRate({ firingsInWindow: count, threshold });
    if (!exceeded) return { ...base, exceeded: false, count };
    const lastAtRaw = readScheduleManagedSetting(sql, SCHEDULE_FIRING_RATE_ALERT_LAST_AT_KEY);
    const lastAtMs = lastAtRaw ? Date.parse(lastAtRaw) : NaN;
    if (Number.isFinite(lastAtMs) && lastAtMs >= windowStartMs) {
      return { ...base, exceeded: true, count };
    }
    try {
      emit?.("schedule.firing_rate_exceeded", {
        code: "firing_rate_exceeded",
        count,
        threshold,
        windowMinutes,
        windowStart: new Date(windowStartMs).toISOString(),
      });
    } catch {
      // A failing sink must not break the firing either.
    }
    try {
      writeScheduleManagedSetting(sql, SCHEDULE_FIRING_RATE_ALERT_LAST_AT_KEY, new Date(nowMs).toISOString());
    } catch {
      // The throttle marker is best-effort; the alert already went out.
    }
    return { ...base, exceeded: true, count, alerted: true };
  } catch {
    return { ...base, exceeded: false, count: 0 };
  }
}

/* =====================================================================
 * The controls view (GET /api/schedules/controls)
 * ===================================================================== */

/** The schedules-home controls view: effective values + rate + inventory. */
export interface ScheduleControlsView {
  minIntervalSeconds: number;
  minIntervalSource: ScheduleMinIntervalSource;
  managedMinIntervalSeconds: number | null;
  envMinIntervalSeconds: number | null;
  defaultMinIntervalSeconds: number;
  firingEnabled: boolean;
  firingEnabledSource: ScheduleFiringEnabledSource;
  managedFiringEnabled: boolean | null;
  envFiringEnabled: boolean | null;
  defaultFiringEnabled: boolean;
  /** Issue #6503 — new schedules start paused unless configured otherwise (default true). */
  startPaused: boolean;
  startPausedSource: ScheduleStartPausedSource;
  managedStartPaused: boolean | null;
  envStartPaused: boolean | null;
  defaultStartPaused: boolean;
  firingRate: {
    count: number;
    threshold: number;
    windowMinutes: number;
    exceeded: boolean;
    thresholdSource: ScheduleFiringRateAlertSource;
    windowSource: ScheduleFiringRateAlertSource;
    managedThreshold: number | null;
    envThreshold: number | null;
    defaultThreshold: number;
    managedWindowMinutes: number | null;
    envWindowMinutes: number | null;
    defaultWindowMinutes: number;
  };
  /** Issue #6503 step 13 — the externalized remainder (effective values + sources). */
  heartbeatIntervalSeconds: number;
  heartbeatIntervalSource: HeartbeatWatchdogSource;
  managedHeartbeatIntervalSeconds: number | null;
  envHeartbeatIntervalSeconds: number | null;
  defaultHeartbeatIntervalSeconds: number;
  heartbeatWatchdogStaleAfterMinutes: number;
  heartbeatWatchdogStaleAfterSource: HeartbeatWatchdogSource;
  managedHeartbeatWatchdogStaleAfterMinutes: number | null;
  envHeartbeatWatchdogStaleAfterMinutes: number | null;
  defaultHeartbeatWatchdogStaleAfterMinutes: number;
  missedScheduleGraceMinutes: number;
  missedScheduleGraceSource: MissedScheduleGraceSource;
  managedMissedScheduleGraceMinutes: number | null;
  envMissedScheduleGraceMinutes: number | null;
  defaultMissedScheduleGraceMinutes: number;
  dueGuardMs: number;
  dueGuardSource: ScheduleDueGuardSource;
  managedDueGuardMs: number | null;
  envDueGuardMs: number | null;
  defaultDueGuardMs: number;
  staleRunningReapMs: number;
  staleRunningReapSource: StaleAsyncJobReapSource;
  managedStaleRunningReapMs: number | null;
  envStaleRunningReapMs: number | null;
  defaultStaleRunningReapMs: number;
  staleSweepBatchLimit: number;
  staleSweepBatchLimitSource: StaleAsyncJobReapSource;
  managedStaleSweepBatchLimit: number | null;
  envStaleSweepBatchLimit: number | null;
  defaultStaleSweepBatchLimit: number;
  researchScheduleUtcHour: number;
  researchScheduleUtcHourSource: ResearchScheduleUtcHourSource;
  managedResearchScheduleUtcHour: number | null;
  envResearchScheduleUtcHour: number | null;
  defaultResearchScheduleUtcHour: number;
  jobRunRecordCap: number;
  jobRunRecordCapSource: GoalRunRetentionSource;
  managedJobRunRecordCap: number | null;
  envJobRunRecordCap: number | null;
  defaultJobRunRecordCap: number;
  tickHistoryCap: number;
  tickHistoryCapSource: GoalRunRetentionSource;
  managedTickHistoryCap: number | null;
  envTickHistoryCap: number | null;
  defaultTickHistoryCap: number;
  inventory: ArmedScheduleInventoryItem[];
}

/** Resolve the controls view from the store, the env, and the unified list items. */
export async function resolveScheduleControlsView(
  sql: ScheduleControlsSql,
  env: unknown,
  listItems: readonly ArmedScheduleInventoryInput[],
  nowMs: number = Date.now(),
): Promise<ScheduleControlsView> {
  const floor = resolveEffectiveScheduleFloor(sql, env);
  const firing = resolveEffectiveScheduleFiringEnabled(sql, env);
  const startPaused = resolveEffectiveScheduleStartPaused(sql, env);
  const rate = resolveEffectiveScheduleFiringRateAlert(sql, env);
  // Issue #6503 step 13 — the externalized remainder, resolved from
  // the same store + env as the step-2 controls.
  const heartbeatInterval = resolveEffectiveHeartbeatInterval(sql, env);
  const heartbeatStaleAfter = resolveEffectiveHeartbeatWatchdogStaleAfter(sql, env);
  const grace = resolveEffectiveMissedScheduleGrace(sql, env);
  const dueGuard = resolveEffectiveScheduleDueGuard(sql, env);
  const reap = resolveEffectiveStaleAsyncJobReap(sql, env);
  const researchHour = resolveEffectiveResearchScheduleUtcHour(sql, env);
  const retention = resolveEffectiveGoalRunRetention(sql, env);
  const count =
    rate.threshold > 0
      ? await countScheduleFiringsInWindow(
          // Issue #6101 — the count reads D1 (the store resolves
          // from the same env the thresholds read); unbound counts 0.
          createJobRunRecordAdapter(
            env as { AGENT_DB?: unknown } | null | undefined,
          ),
          nowMs - rate.windowMinutes * 60_000,
        )
      : 0;
  const { exceeded } = evaluateScheduleFiringRate({ firingsInWindow: count, threshold: rate.threshold });
  return {
    minIntervalSeconds: floor.seconds,
    minIntervalSource: floor.source,
    managedMinIntervalSeconds: floor.managed,
    envMinIntervalSeconds: floor.env,
    defaultMinIntervalSeconds: floor.default,
    firingEnabled: firing.enabled,
    firingEnabledSource: firing.source,
    managedFiringEnabled: firing.managed,
    envFiringEnabled: firing.env,
    defaultFiringEnabled: firing.default,
    startPaused: startPaused.paused,
    startPausedSource: startPaused.source,
    managedStartPaused: startPaused.managed,
    envStartPaused: startPaused.env,
    defaultStartPaused: startPaused.default,
    firingRate: {
      count,
      threshold: rate.threshold,
      windowMinutes: rate.windowMinutes,
      exceeded,
      thresholdSource: rate.thresholdSource,
      windowSource: rate.windowSource,
      managedThreshold: rate.managedThreshold,
      envThreshold: rate.envThreshold,
      defaultThreshold: rate.defaultThreshold,
      managedWindowMinutes: rate.managedWindowMinutes,
      envWindowMinutes: rate.envWindowMinutes,
      defaultWindowMinutes: rate.defaultWindowMinutes,
    },
    heartbeatIntervalSeconds: heartbeatInterval.seconds,
    heartbeatIntervalSource: heartbeatInterval.source,
    managedHeartbeatIntervalSeconds: heartbeatInterval.managed,
    envHeartbeatIntervalSeconds: heartbeatInterval.env,
    defaultHeartbeatIntervalSeconds: heartbeatInterval.default,
    heartbeatWatchdogStaleAfterMinutes: heartbeatStaleAfter.minutes,
    heartbeatWatchdogStaleAfterSource: heartbeatStaleAfter.source,
    managedHeartbeatWatchdogStaleAfterMinutes: heartbeatStaleAfter.managedMinutes,
    envHeartbeatWatchdogStaleAfterMinutes: heartbeatStaleAfter.envMinutes,
    defaultHeartbeatWatchdogStaleAfterMinutes: heartbeatStaleAfter.defaultMinutes,
    missedScheduleGraceMinutes: grace.minutes,
    missedScheduleGraceSource: grace.source,
    managedMissedScheduleGraceMinutes: grace.managedMinutes,
    envMissedScheduleGraceMinutes: grace.envMinutes,
    defaultMissedScheduleGraceMinutes: grace.defaultMinutes,
    dueGuardMs: dueGuard.ms,
    dueGuardSource: dueGuard.source,
    managedDueGuardMs: dueGuard.managedMs,
    envDueGuardMs: dueGuard.envMs,
    defaultDueGuardMs: dueGuard.defaultMs,
    staleRunningReapMs: reap.reapMs,
    staleRunningReapSource: reap.reapSource,
    managedStaleRunningReapMs: reap.managedReapMs,
    envStaleRunningReapMs: reap.envReapMs,
    defaultStaleRunningReapMs: reap.defaultReapMs,
    staleSweepBatchLimit: reap.batchLimit,
    staleSweepBatchLimitSource: reap.batchLimitSource,
    managedStaleSweepBatchLimit: reap.managedBatchLimit,
    envStaleSweepBatchLimit: reap.envBatchLimit,
    defaultStaleSweepBatchLimit: reap.defaultBatchLimit,
    researchScheduleUtcHour: researchHour.hour,
    researchScheduleUtcHourSource: researchHour.source,
    managedResearchScheduleUtcHour: researchHour.managedHour,
    envResearchScheduleUtcHour: researchHour.envHour,
    defaultResearchScheduleUtcHour: researchHour.defaultHour,
    jobRunRecordCap: retention.jobRunRecordCap,
    jobRunRecordCapSource: retention.jobRunRecordCapSource,
    managedJobRunRecordCap: retention.managedJobRunRecordCap,
    envJobRunRecordCap: retention.envJobRunRecordCap,
    defaultJobRunRecordCap: retention.defaultJobRunRecordCap,
    tickHistoryCap: retention.tickHistoryCap,
    tickHistoryCapSource: retention.tickHistoryCapSource,
    managedTickHistoryCap: retention.managedTickHistoryCap,
    envTickHistoryCap: retention.envTickHistoryCap,
    defaultTickHistoryCap: retention.defaultTickHistoryCap,
    inventory: buildArmedScheduleInventory(listItems),
  };
}
