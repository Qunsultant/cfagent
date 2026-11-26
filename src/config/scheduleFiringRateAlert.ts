/**
 * Issue #6482 — the schedule firing-rate alert threshold, externalized.
 *
 * The guardrail that catches a recurrence in hours, not at the
 * bill: when schedule firings in the trailing window exceed the
 * configured threshold, the firing path emits the coded
 * `schedule.firing_rate_exceeded` observation (audit + structured
 * log) through the existing observability seam, at most once per
 * window. The thresholds are working defaults, not rulings.
 *
 * Working defaults: 120 firings in 60 minutes. A legitimate
 * estate fires far below that (the monthly floor caps each schedule
 * at one firing per month; the platform's own fixed duties add a
 * handful), while the runaway loop fired ~1800–2400 per hour — so
 * the default sits far above legitimate traffic and far below the
 * loop. A threshold of 0 disables the alert.
 *
 * Issue #6503 — the thresholds are MANAGED settings, not env-only:
 * mas_settings `schedule.firingRateAlertThreshold` /
 * `schedule.firingRateAlertWindowMinutes`, settable from the
 * schedules home. Precedence everywhere: managed > env carrier >
 * default (120 / 60).
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduledJobAlert.ts).
 */

/** Firings per window above which the alert fires; 0 disables it. */
export const SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR = "SCHEDULE_FIRING_RATE_ALERT_THRESHOLD";

/** The trailing window for the firing-rate count, in minutes. */
export const SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR = "SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES";

/** The managed-setting key for the threshold (mas_settings), settable from the schedules home. */
export const SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_SETTING_KEY = "schedule.firingRateAlertThreshold";

/** The managed-setting key for the window (mas_settings), settable from the schedules home. */
export const SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_SETTING_KEY =
  "schedule.firingRateAlertWindowMinutes";

/** The working default threshold: 120 firings per window. */
export const DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD = 120;

/** The working default window: 60 minutes. */
export const DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES = 60;

/**
 * Parse an alert threshold: a count, 0 = disabled. A non-positive
 * number reads as 0 (disabled — the pre-existing env semantic);
 * a non-numeric value is undefined (falls through to the next
 * source). Strings parse as numbers so managed settings (stored
 * as text) resolve the same way as env carriers.
 */
export function parseScheduleFiringRateAlertThreshold(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value <= 0 ? 0 : Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  return parsed <= 0 ? 0 : Math.round(parsed);
}

/**
 * Parse an alert window, in minutes: a positive whole number, or
 * undefined (non-numeric, non-finite, zero or negative — falls
 * through to the next source; the window has no "disabled" value).
 */
export function parseScheduleFiringRateAlertWindowMinutes(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed);
}

/** Where the effective threshold/window came from (named for the home + the audit trail). */
export type ScheduleFiringRateAlertSource = "managed" | "env" | "default";

/** Resolve the alert threshold from already-read sources: managed > env > default (120). */
export function resolveEffectiveScheduleFiringRateAlertThreshold(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseScheduleFiringRateAlertThreshold(input.managed) ??
    parseScheduleFiringRateAlertThreshold(input.env) ??
    DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD
  );
}

/** Name the winning threshold source for the same inputs. */
export function scheduleFiringRateAlertThresholdSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleFiringRateAlertSource {
  if (parseScheduleFiringRateAlertThreshold(input.managed) !== undefined) return "managed";
  if (parseScheduleFiringRateAlertThreshold(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the alert window from already-read sources: managed > env > default (60 minutes). */
export function resolveEffectiveScheduleFiringRateAlertWindowMinutes(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseScheduleFiringRateAlertWindowMinutes(input.managed) ??
    parseScheduleFiringRateAlertWindowMinutes(input.env) ??
    DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES
  );
}

/** Name the winning window source for the same inputs. */
export function scheduleFiringRateAlertWindowMinutesSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleFiringRateAlertSource {
  if (parseScheduleFiringRateAlertWindowMinutes(input.managed) !== undefined) return "managed";
  if (parseScheduleFiringRateAlertWindowMinutes(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the alert threshold from env: a count, 0 = disabled. */
export function resolveScheduleFiringRateAlertThreshold(env: unknown): number {
  const raw = (env as Record<string, unknown> | undefined)?.[SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR];
  return parseScheduleFiringRateAlertThreshold(raw) ?? DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD;
}

/** Resolve the alert window from env, in minutes. */
export function resolveScheduleFiringRateAlertWindowMinutes(env: unknown): number {
  const raw = (env as Record<string, unknown> | undefined)?.[SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR];
  return parseScheduleFiringRateAlertWindowMinutes(raw) ?? DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES;
}
