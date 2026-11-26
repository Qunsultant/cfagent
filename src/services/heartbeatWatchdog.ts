/**
 * Issue #4234 (ADR 0030) — the hourly heartbeat watchdog, pure core.
 *
 * The watchdog lives OUTSIDE what it watches (the Worker cron is the
 * one mechanism independent of the Durable Object alarm state), so
 * this module is pure decision code: given what the entry point
 * observed on the ScheduledAgent — whether the heartbeat alarm
 * exists, and when the tick last fired — it answers whether the
 * heartbeat is healthy, missing, or wedged, and whether the alarm
 * must be re-armed. It does no I/O, reads no env, and performs no
 * re-arm itself; the entry point in
 * `src/services/consolidatedCronEntries.ts` owns the reads, the
 * re-arm call, and the ledger row.
 *
 * Findings (ADR 0030 §Decision, steps 1–3):
 * - `healthy` — the alarm exists and the tick fired within the
 *   staleness threshold. No re-arm.
 * - `missing` — no heartbeat alarm exists (never armed, storage
 *   wiped or reset, a deploy changed the arming path, cancelled or
 *   paused and never resumed). Re-arm without force: arming an
 *   absent alarm is a plain `scheduleEvery`.
 * - `stale` — the alarm exists but the tick has not fired within
 *   the threshold (the alarm is wedged: present but not firing), or
 *   it exists and never fired at all. Re-arm WITH force: the wedged
 *   schedule is cancelled and re-created, because re-arming past an
 *   existing schedule would be a no-op under the ensure-pattern.
 *
 * Fail-closed on evidence the watchdog cannot see: this module
 * never sees an unreadable observation — the entry point records
 * a failure row and re-arms nothing when `listSchedules` or the
 * tick history cannot be read. A missing alarm is positive
 * evidence (an empty schedule list), not an absence of evidence.
 */

export type HeartbeatWatchdogFinding = "healthy" | "missing" | "stale";

export interface HeartbeatWatchdogObservation {
  /** Whether a heartbeat alarm (callback `onCron`) exists on the ScheduledAgent. */
  alarmExists: boolean;
  /** Epoch ms of the most recent recorded tick firing, or null when it never fired. */
  lastTickAtMs: number | null;
  /** Epoch ms at which the watchdog is deciding. */
  nowMs: number;
  /** Ms since the last tick firing after which a present alarm counts as wedged. */
  staleAfterMs: number;
}

export interface HeartbeatWatchdogDecision {
  finding: HeartbeatWatchdogFinding;
  /** Whether the entry point must re-arm the heartbeat alarm. */
  rearm: boolean;
  /** Whether the re-arm must cancel the existing schedule first (stale only). */
  forceRearm: boolean;
  /** Human-readable detail for the ledger row (never a raw error). */
  detail: string;
}

function minutesAgo(nowMs: number, atMs: number): number {
  return Math.max(0, Math.round((nowMs - atMs) / 60000));
}

/**
 * Decide the heartbeat's state from one observation. Pure: no I/O,
 * no env, no clock read — `nowMs` is injected by the caller.
 */
export function decideHeartbeatWatchdog(
  observation: HeartbeatWatchdogObservation,
): HeartbeatWatchdogDecision {
  const { alarmExists, lastTickAtMs, nowMs, staleAfterMs } = observation;
  if (!alarmExists) {
    return {
      finding: "missing",
      rearm: true,
      forceRearm: false,
      detail:
        "heartbeat alarm missing on the ScheduledAgent — re-arming the recurring onCron alarm",
    };
  }
  if (lastTickAtMs === null) {
    return {
      finding: "stale",
      rearm: true,
      forceRearm: true,
      detail:
        "heartbeat alarm present but the tick never fired — re-arming the recurring onCron alarm",
    };
  }
  if (nowMs - lastTickAtMs > staleAfterMs) {
    return {
      finding: "stale",
      rearm: true,
      forceRearm: true,
      detail: `heartbeat alarm present but the last tick fired ${minutesAgo(nowMs, lastTickAtMs)} minutes ago — re-arming the recurring onCron alarm`,
    };
  }
  return {
    finding: "healthy",
    rearm: false,
    forceRearm: false,
    detail: `heartbeat alarm present; last tick ${minutesAgo(nowMs, lastTickAtMs)} minutes ago`,
  };
}

/* =================================================================
 * Issue #6503 step 12 — the schedule-watchdog self-watch: the
 * outer observation's decision half. Pure, like
 * `decideHeartbeatWatchdog` above: given the newest
 * `schedule.watchdog_heartbeat` ledger row (or its absence) it
 * answers whether the schedule watchdog itself is alive. It does
 * no I/O and performs no alerting; the entry point in
 * `src/services/consolidatedCronEntries.ts` owns the read and the
 * audit + Slack alert.
 *
 * Findings:
 * - `healthy` — a heartbeat-operation row exists within the
 *   staleness threshold. No alert.
 * - `missing` — no heartbeat-operation row exists at all (the
 *   watchdog never ran, or its rows aged out of the merged read).
 *   Alert: the watchdog is dead until proven otherwise.
 * - `stale` — the newest heartbeat-operation row is older than
 *   the threshold (the watchdog ran once, then stopped). Alert.
 *
 * The threshold is the heartbeat watchdog's own `staleAfterMs`
 * (HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES, default 120 minutes),
 * already resolved by the entry point: the heartbeat row is
 * written once per onCron tick, the same cadence the threshold
 * already judges for the tick itself, so one staleness rule
 * covers the tick path. No new literal lives here — step 13
 * externalizes the threshold's home, not this call site. A row
 * whose timestamp is unparseable reads as missing (no usable
 * evidence of a recent heartbeat), the alarm check's
 * unparseable-tick → null precedent.
 */

export type ScheduleWatchdogHeartbeatFinding = "healthy" | "missing" | "stale";

export interface ScheduleWatchdogHeartbeatObservation {
  /**
   * Epoch ms of the newest `schedule.watchdog_heartbeat` ledger
   * row, or null when no such row exists (or its timestamp is
   * unparseable). The caller filters by operation first — the
   * same job id is also written by the sweep
   * (`schedule.watchdog_sweep`), and a fresh sweep row must never
   * mask a stale heartbeat row.
   */
  lastHeartbeatAtMs: number | null;
  /** Epoch ms at which the watchdog is deciding. */
  nowMs: number;
  /** Ms since the last heartbeat row after which the watchdog counts as dead. */
  staleAfterMs: number;
  /** Seconds between onCron ticks — the watchdog's expected cadence, used only to name the heartbeat that was expected next. */
  intervalSeconds: number;
}

export interface ScheduleWatchdogHeartbeatDecision {
  finding: ScheduleWatchdogHeartbeatFinding;
  /** Human-readable detail for the dispatch row (never a raw error). */
  detail: string;
  /** ISO of the heartbeat that was expected next (last + one interval); absent when no heartbeat row exists. */
  expectedTickIso?: string;
  /** ISO of the newest heartbeat row, or null when none exists. */
  lastRunIso: string | null;
}

/**
 * Decide the schedule watchdog's state from its newest heartbeat
 * row. Pure: no I/O, no env, no clock read — `nowMs` is injected
 * by the caller.
 */
export function decideScheduleWatchdogHeartbeat(
  observation: ScheduleWatchdogHeartbeatObservation,
): ScheduleWatchdogHeartbeatDecision {
  const { lastHeartbeatAtMs, nowMs, staleAfterMs, intervalSeconds } =
    observation;
  if (lastHeartbeatAtMs === null) {
    return {
      finding: "missing",
      detail:
        "schedule-watchdog heartbeat missing — no schedule.watchdog_heartbeat ledger row; the schedule watchdog has never run (or its rows aged out)",
      lastRunIso: null,
    };
  }
  const lastRunIso = new Date(lastHeartbeatAtMs).toISOString();
  if (nowMs - lastHeartbeatAtMs > staleAfterMs) {
    return {
      finding: "stale",
      detail: `schedule-watchdog heartbeat stale — last schedule.watchdog_heartbeat row ${minutesAgo(nowMs, lastHeartbeatAtMs)} minutes ago`,
      expectedTickIso: new Date(
        lastHeartbeatAtMs + intervalSeconds * 1000,
      ).toISOString(),
      lastRunIso,
    };
  }
  return {
    finding: "healthy",
    detail: `schedule-watchdog heartbeat fresh; last schedule.watchdog_heartbeat row ${minutesAgo(nowMs, lastHeartbeatAtMs)} minutes ago`,
    lastRunIso,
  };
}
