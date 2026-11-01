/**
 * Issue #2567 (#2494): the stuck-running alert threshold — a
 * configuration resolver in the src/config/*Modes.ts idiom (a
 * documented Worker env var, a named built-in default, no magic
 * number in the read path).
 *
 * STUCK_RUN_ALERT_THRESHOLD_MINUTES (non-secret, owner-set; this
 * slice sets NO production value):
 *   Minutes a mas_async_jobs row may stay in `running` before the
 *   read path flags it stuck and raises ONE operator alert (the
 *   alert claim + delivery live in
 *   src/agents/orchestrator/asyncJobs.ts `maybeAlertStuckRunning`).
 *   Built-in default: 30 minutes — comfortably before the 2h
 *   stale-running reap backstop in the same read path, far beyond
 *   any healthy job's runtime.
 *   "0" (or a negative value) DISABLES the alert; the 2h reap is
 *   unaffected. A blank or unparseable value falls through to the
 *   default. Fractional minutes are honoured (0.5 = 30 seconds),
 *   which the tests use to exercise the configuration seam.
 */

export const STUCK_RUN_ALERT_ENV_VAR = "STUCK_RUN_ALERT_THRESHOLD_MINUTES";

/** The built-in default: 30 minutes, in milliseconds. */
export const DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS = 30 * 60 * 1000;

export interface StuckRunAlertEnv {
  STUCK_RUN_ALERT_THRESHOLD_MINUTES?: string;
}

/**
 * Resolve the stuck-run alert threshold in milliseconds.
 * Returns 0 when the alert is disabled by configuration.
 */
export function resolveStuckRunAlertThresholdMs(env: StuckRunAlertEnv): number {
  const raw = typeof env.STUCK_RUN_ALERT_THRESHOLD_MINUTES === "string"
    ? env.STUCK_RUN_ALERT_THRESHOLD_MINUTES.trim()
    : "";
  if (raw === "") return DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS;
  if (minutes <= 0) return 0;
  return Math.round(minutes * 60 * 1000);
}
