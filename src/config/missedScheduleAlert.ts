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

/** The built-in default: 60 minutes, in milliseconds. */
export const DEFAULT_MISSED_SCHEDULE_GRACE_MS = 60 * 60 * 1000;

export interface MissedScheduleGraceEnv {
  MISSED_SCHEDULE_GRACE_MINUTES?: string;
}

/**
 * Resolve the missed-schedule grace window in milliseconds.
 * Returns 0 when the watchdog is disabled by configuration.
 */
export function resolveMissedScheduleGraceMs(env: MissedScheduleGraceEnv): number {
  const raw = typeof env.MISSED_SCHEDULE_GRACE_MINUTES === "string"
    ? env.MISSED_SCHEDULE_GRACE_MINUTES.trim()
    : "";
  if (raw === "") return DEFAULT_MISSED_SCHEDULE_GRACE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_MISSED_SCHEDULE_GRACE_MS;
  if (minutes <= 0) return 0;
  return Math.round(minutes * 60 * 1000);
}
