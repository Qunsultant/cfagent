/**
 * Phase 5 Slice 1 (issue #2000) — DLQ depth-alert threshold
 * config. Mirrors src/config/stuckRunAlert.ts: an env var
 * overrides the default; blank or unparseable falls back to
 * the default; 0 disables the alert.
 *
 * Working default (not a ruling): 10 un-replayed dead-letter
 * records. Dashboard-native queue alerts are complementary,
 * not required — see the runbook.
 */
export const DLQ_DEPTH_ALERT_ENV_VAR = "DLQ_DEPTH_ALERT_THRESHOLD";
export const DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD = 10;

/** Resolve the depth threshold from env: a count, 0 = disabled. */
export function resolveDlqDepthAlertThreshold(env: Record<string, unknown>): number {
  const raw = env[DLQ_DEPTH_ALERT_ENV_VAR];
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD;
  if (parsed <= 0) return 0;
  return Math.round(parsed);
}
