/**
 * Issue #4234 (ADR 0030) — the heartbeat tick's due-checks: the
 * token-renewal and retention duties run inside the one alarm tick,
 * once daily after their due hour (UTC), never as separate crons.
 *
 * The old Worker crons (`0 3` renewal, `0 4` retention) stay OFF
 * per #4112. Their duties survive as due-checks: on each alarm
 * tick the agent reads the last successful dispatch from the one
 * run ledger (the entry points record their own rows there) and
 * runs the duty when its last run was before the most recent
 * due-hour boundary that has already passed. A duty that never ran
 * is due; a failed run leaves no successful row, so it retries on
 * the next tick. This module is pure decision + orchestration: it
 * does no I/O itself — the last-run reads and the duty runners are
 * injected by the caller (`ScheduledAgent.onCron`).
 *
 * Due hours are owner-configured values (see
 * `src/config/heartbeatWatchdog.ts`); the defaults preserve the old
 * cron hours (renewal 03:00 UTC, retention 04:00 UTC).
 */
import type { HeartbeatDueCheckConfig } from "../config/heartbeatWatchdog";

/**
 * The ledger jobId of the token-renewal dispatch (S1 §4: a cron
 * run's `jobId` IS its cron expression — the same value the
 * renewal entry point records, so the last-run read joins to it).
 */
export const RENEWAL_DISPATCH_CRON = "0 3 * * *";

/**
 * Issue #3121 #4239 — the unified-store record id of the token-renewal duty, named once here beside its ledger job id: the
 * record is derived from this duty, so the id lives with the
 * duty's identity, not with the management module.
 */
export const TOKEN_RENEWAL_RECORD_ID = "token-renewal";

/** The ledger jobId of the retention dispatch (same S1 rule). */
export const RETENTION_DISPATCH_CRON = "0 4 * * *";

/**
 * Issue #3121 #4240 — the unified-store record id of the retention duty, named once here beside its ledger job id: the
 * record is derived from this duty, so the id lives with the
 * duty's identity, not with the management module.
 */
export const RETENTION_RECORD_ID = "retention";

/**
 * The most recent due-hour instant at or before `now` (UTC). At
 * 02:00 with a 03:00 due hour the boundary is yesterday 03:00 —
 * the duty does not fire early.
 */
function dueBoundaryMs(now: Date, dueHourUtc: number): number {
  const boundary = new Date(now);
  boundary.setUTCHours(dueHourUtc, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    boundary.setUTCDate(boundary.getUTCDate() - 1);
  }
  return boundary.getTime();
}

function isDueAfterHour(
  now: Date,
  lastRunAtMs: number | null,
  dueHourUtc: number,
): boolean {
  if (lastRunAtMs === null) return true;
  return lastRunAtMs < dueBoundaryMs(now, dueHourUtc);
}

/**
 * Whether the token-renewal duty is due: never ran, or its last
 * successful run was before the most recent 03:00 UTC boundary
 * that has already passed. A run exactly at the boundary counts.
 */
export function isRenewalDue(
  now: Date,
  lastRunAtMs: number | null,
  config: HeartbeatDueCheckConfig,
): boolean {
  return isDueAfterHour(now, lastRunAtMs, config.renewalDueHourUtc);
}

/** Whether the retention duty is due (same rule, 04:00 UTC). */
export function isRetentionDue(
  now: Date,
  lastRunAtMs: number | null,
  config: HeartbeatDueCheckConfig,
): boolean {
  return isDueAfterHour(now, lastRunAtMs, config.retentionDueHourUtc);
}

/** The caller-injected reads + runners for one due-check pass. */
export interface HeartbeatDueCheckRunDeps {
  now: () => Date;
  /** Epoch ms of the last SUCCESSFUL renewal dispatch, or null when it never ran. */
  lastRenewalAtMs: number | null;
  /** Epoch ms of the last SUCCESSFUL retention dispatch, or null when it never ran. */
  lastRetentionAtMs: number | null;
  config: HeartbeatDueCheckConfig;
  /** Runs the renewal entry point (records its own ledger row). */
  runRenewal: () => Promise<void>;
  /** Runs the retention entry point (records its own ledger row). */
  runRetention: () => Promise<void>;
  logError: (...args: unknown[]) => void;
  logInfo: (...args: unknown[]) => void;
}

/**
 * Run each due duty once. A failing duty is logged and reported as
 * not run — it never fails the tick, and it retries on the next
 * tick because no successful row was recorded for it.
 */
export async function runHeartbeatDueChecks(
  deps: HeartbeatDueCheckRunDeps,
): Promise<{ renewalRan: boolean; retentionRan: boolean }> {
  const now = deps.now();
  let renewalRan = false;
  let retentionRan = false;
  if (isRenewalDue(now, deps.lastRenewalAtMs, deps.config)) {
    try {
      await deps.runRenewal();
      renewalRan = true;
      deps.logInfo(
        "[scheduled] heartbeat due-check: token renewal ran",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logError(
        `[scheduled] heartbeat due-check: token renewal failed (${message}) — will retry on the next tick`,
      );
    }
  }
  if (isRetentionDue(now, deps.lastRetentionAtMs, deps.config)) {
    try {
      await deps.runRetention();
      retentionRan = true;
      deps.logInfo("[scheduled] heartbeat due-check: retention ran");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logError(
        `[scheduled] heartbeat due-check: retention failed (${message}) — will retry on the next tick`,
      );
    }
  }
  return { renewalRan, retentionRan };
}
