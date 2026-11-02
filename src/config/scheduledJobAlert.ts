/**
 * Issue Qunsultant/cfagent#2037 — scheduled-job repeat-failure alert
 * threshold config. Mirrors src/config/dlqDepthAlert.ts: an env var
 * overrides the default; blank or unparseable falls back to the
 * default; 0 disables the alert.
 *
 * Working default (not a ruling): 3 consecutive failed ticks — at
 * the 30-minute cadence that is 90 minutes of consecutive failure before
 * the first Slack alert, repeating at every further multiple of the
 * threshold (6, 9, ...) while the streak continues.
 */
export const SCHEDULED_JOB_ALERT_ENV_VAR = "SCHEDULED_JOB_ALERT_THRESHOLD";
export const DEFAULT_SCHEDULED_JOB_ALERT_THRESHOLD = 3;

/** Resolve the alert threshold from env: a count, 0 = disabled. */
export function resolveScheduledJobAlertThreshold(env: Record<string, unknown>): number {
  const raw = env[SCHEDULED_JOB_ALERT_ENV_VAR];
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_SCHEDULED_JOB_ALERT_THRESHOLD;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_SCHEDULED_JOB_ALERT_THRESHOLD;
  if (parsed <= 0) return 0;
  return Math.round(parsed);
}
