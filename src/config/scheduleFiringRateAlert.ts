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
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduledJobAlert.ts).
 */

/** Firings per window above which the alert fires; 0 disables it. */
export const SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR = "SCHEDULE_FIRING_RATE_ALERT_THRESHOLD";

/** The trailing window for the firing-rate count, in minutes. */
export const SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR = "SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES";

/** The working default threshold: 120 firings per window. */
export const DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD = 120;

/** The working default window: 60 minutes. */
export const DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES = 60;

/** Resolve the alert threshold from env: a count, 0 = disabled. */
export function resolveScheduleFiringRateAlertThreshold(env: unknown): number {
  const raw = (env as Record<string, unknown> | undefined)?.[SCHEDULE_FIRING_RATE_ALERT_THRESHOLD_ENV_VAR];
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD;
  if (parsed <= 0) return 0;
  return Math.round(parsed);
}

/** Resolve the alert window from env, in minutes. */
export function resolveScheduleFiringRateAlertWindowMinutes(env: unknown): number {
  const raw = (env as Record<string, unknown> | undefined)?.[SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES_ENV_VAR];
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES;
  return Math.round(parsed);
}
