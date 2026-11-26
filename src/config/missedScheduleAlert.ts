/**
 * Issue #3788 (parent incident #3781) — the schedule-watchdog grace
 * window: a configuration resolver in the src/config/*Modes.ts idiom
 * (a documented Worker env var, a named built-in default, no magic
 * number in the read path).
 *
 * MISSED_SCHEDULE_GRACE_MINUTES (non-secret, owner-set; this slice
 * sets NO production value):
 *   Minutes past a schedule/goal/task's expected firing tick before
 *   the watchdog treats the absence of a run as a missed fire and
 *   emits the audit + Slack + ledger signals. The grace absorbs the
 *   Worker 30-minute tick granularity (a tick up to 30 minutes after the
 *   scheduled minute still fires the goal on time) and ordinary
 *   platform jitter.
 *   Built-in default: 60 minutes — one full 30-minute tick past the
 *   scheduled minute, plus margin.
 *   "0" (or a negative value) DISABLES the watchdog entirely: no
 *   missed-fire findings and no heartbeat record. A blank or
 *   unparseable value falls through to the default. Fractional
 *   minutes are honoured (0.5 = 30 seconds), which the tests use to
 *   exercise the configuration seam.
 */

export const MISSED_SCHEDULE_GRACE_ENV_VAR = "MISSED_SCHEDULE_GRACE_MINUTES";

/**
 * Issue #6503 step 13 — the watchdog grace is a MANAGED setting,
 * not env-only: mas_settings `schedule.missedScheduleGraceMinutes`,
 * settable from the schedules home. Precedence everywhere:
 * managed > env carrier > default (60 minutes). The env carrier
 * and the default are unchanged, including the "0 disables"
 * semantic: a managed or env 0 disables the watchdog entirely.
 */
export const MISSED_SCHEDULE_GRACE_SETTING_KEY = "schedule.missedScheduleGraceMinutes";

/** The built-in default: 60 minutes, in milliseconds. */
export const DEFAULT_MISSED_SCHEDULE_GRACE_MS = 60 * 60 * 1000;

/** The built-in default grace, in minutes (the managed/env unit). */
export const DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES = 60;

/** Where the effective grace came from (named for the home + the audit trail). */
export type MissedScheduleGraceSource = "managed" | "env" | "default";

/**
 * Parse a grace in minutes: a number, or undefined (blank or
 * non-numeric — falls through to the next source). Zero and
 * negative values parse as 0 (disabled — the pre-existing env
 * semantic); unlike the other schedule knobs, 0 here is a DEFINED
 * value and must win over the env/default, never fall through.
 * Strings parse as numbers so managed settings (stored as text)
 * resolve the same way as env carriers.
 */
export function parseMissedScheduleGraceMinutes(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value <= 0 ? 0 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const minutes = Number(value.trim());
  if (!Number.isFinite(minutes)) return undefined;
  return minutes <= 0 ? 0 : minutes;
}

/** Resolve the grace in minutes from already-read sources: managed > env > default (60). */
export function resolveMissedScheduleGraceMinutesFrom(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseMissedScheduleGraceMinutes(input.managed) ??
    parseMissedScheduleGraceMinutes(input.env) ??
    DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES
  );
}

/** Name the winning grace source for the same inputs. */
export function missedScheduleGraceSource(input: {
  managed?: unknown;
  env?: unknown;
}): MissedScheduleGraceSource {
  if (parseMissedScheduleGraceMinutes(input.managed) !== undefined) return "managed";
  if (parseMissedScheduleGraceMinutes(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the grace in milliseconds from already-read sources: managed > env > default. */
export function resolveMissedScheduleGraceMsFrom(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return Math.round(resolveMissedScheduleGraceMinutesFrom(input) * 60 * 1000);
}

export interface MissedScheduleGraceEnv {
  MISSED_SCHEDULE_GRACE_MINUTES?: string;
}

/**
 * Resolve the missed-schedule grace window in milliseconds.
 * Returns 0 when the watchdog is disabled by configuration.
 * Issue #6503 step 13 — delegates to the managed-aware resolver
 * with no managed value, so the env-only behavior is unchanged.
 */
export function resolveMissedScheduleGraceMs(env: MissedScheduleGraceEnv): number {
  return resolveMissedScheduleGraceMsFrom({ env: env.MISSED_SCHEDULE_GRACE_MINUTES });
}
