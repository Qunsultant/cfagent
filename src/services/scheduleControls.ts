/**
 * Issue #6482 — the managed schedule controls.
 *
 * The floor and the kill-switch are MANAGED settings, not
 * env-only or dashboard-only knobs: they live in the one managed
 * store (mas_settings, through the dedicated SettingsPort — the
 * #2390 G-7 home, same as governedHalt's kill-switch write) and
 * are settable AND readable from the schedules home
 * (GET/POST /api/schedules/controls). Precedence everywhere:
 *   managed setting > env carrier > default
 * (floor default monthly 2,592,000s, fail-closed; firing default ON, so
 * deploying the slice halts nothing).
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
  resolveScheduleFiringRateAlertThreshold,
  resolveScheduleFiringRateAlertWindowMinutes,
} from "../config/scheduleFiringRateAlert";
import { createSettingsPort } from "../data/createSettingsPorts";
import type { SettingsSqlExecutor } from "../data/settingsReadPorts";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";

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

/** One controls write: a value, or null to clear the managed key (fall back to env/default). */
export interface ScheduleControlsPatch {
  minIntervalSeconds?: number | string | null;
  firingEnabled?: boolean | string | null;
}

export type ScheduleControlsPatchResult =
  | { ok: true; changed: { minIntervalSeconds?: number | null; firingEnabled?: boolean | null } }
  | { ok: false; code: "INVALID_CONTROLS"; message: string };

/**
 * Apply one controls write through the managed store. Validation
 * is fail-closed: an invalid floor (zero, negative, fractional,
 * non-numeric) or a non-boolean firing value refuses the WHOLE
 * patch and writes nothing.
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
  if (floor === undefined && firing === undefined) {
    return { ok: true, changed: {} };
  }
  const port = createSettingsPort(sql as never);
  port.ensureSchema();
  const changed: { minIntervalSeconds?: number | null; firingEnabled?: boolean | null } = {};
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
 * trailing window. Best-effort: a store failure counts 0, never a
 * throw. The read is bounded (newest-first, capped) — a count at
 * the cap still proves "above threshold" for any threshold below it.
 */
export function countScheduleFiringsInWindow(
  sql: ScheduleControlsSql,
  windowStartMs: number,
  limit = 500,
): number {
  try {
    const rows = new SqlJobRunRecordStore(sql as never).listRecent(limit);
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
export function checkScheduleFiringRate(
  sql: ScheduleControlsSql,
  env: unknown,
  nowMs: number,
  emit?: (type: string, payload: Record<string, unknown>) => void,
): ScheduleFiringRateCheck {
  const threshold = resolveScheduleFiringRateAlertThreshold(env ?? {});
  const windowMinutes = resolveScheduleFiringRateAlertWindowMinutes(env ?? {});
  const base = { threshold, windowMinutes, alerted: false };
  if (threshold <= 0) return { ...base, exceeded: false, count: 0 };
  try {
    const windowStartMs = nowMs - windowMinutes * 60_000;
    const count = countScheduleFiringsInWindow(sql, windowStartMs);
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
  firingRate: { count: number; threshold: number; windowMinutes: number; exceeded: boolean };
  inventory: ArmedScheduleInventoryItem[];
}

/** Resolve the controls view from the store, the env, and the unified list items. */
export function resolveScheduleControlsView(
  sql: ScheduleControlsSql,
  env: unknown,
  listItems: readonly ArmedScheduleInventoryInput[],
  nowMs: number = Date.now(),
): ScheduleControlsView {
  const floor = resolveEffectiveScheduleFloor(sql, env);
  const firing = resolveEffectiveScheduleFiringEnabled(sql, env);
  const threshold = resolveScheduleFiringRateAlertThreshold(env ?? {});
  const windowMinutes = resolveScheduleFiringRateAlertWindowMinutes(env ?? {});
  const count =
    threshold > 0 ? countScheduleFiringsInWindow(sql, nowMs - windowMinutes * 60_000) : 0;
  const { exceeded } = evaluateScheduleFiringRate({ firingsInWindow: count, threshold });
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
    firingRate: { count, threshold, windowMinutes, exceeded },
    inventory: buildArmedScheduleInventory(listItems),
  };
}
