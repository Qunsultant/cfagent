/**
 * Issue #4234 (ADR 0030) — the heartbeat clock: the one recurring
 * SDK alarm on the ScheduledAgent.
 *
 * The tick's work is unchanged; only its trigger moves. The Worker
 * tick cron is OFF per #4112, and the alarm replaces it: the agent
 * arms one recurring `scheduleEvery` alarm for `onCron` (in-process,
 * no RPC hop), and the alarm firing IS the tick. This module owns
 * the two clock-side primitives — detecting an alarm firing, and
 * arming the alarm — and nothing else: the alarm fires `onCron`,
 * whose body dispatches the riders and the due-checks (see
 * `src/services/tickRiders.ts` and
 * `src/services/heartbeatDueChecks.ts`).
 *
 * Alarm detection: the SDK invokes a scheduled callback as
 * `handler(payload, schedule)` — two arguments, the second a
 * Schedule row (string `id`, string `callback`). The RPC tick is
 * `onCron()` (0 args), the manual trigger is
 * `(env, { forceGoalId, preloadedGoals })`, and the existing tests
 * call `()`, `({ haltReader })`, `(env, { halted })` — none of
 * those carries a Schedule row as the second argument, so the
 * discriminator keeps every existing call path behaving exactly as
 * today.
 */
import {
  HEARTBEAT_ALARM_CALLBACK,
  resolveHeartbeatIntervalSeconds,
} from "../config/heartbeatWatchdog";

/**
 * Whether this `onCron` invocation is the heartbeat alarm firing:
 * the second argument is a Schedule row whose callback is the
 * heartbeat alarm callback. Any other shape is an RPC tick, a
 * manual trigger, or a test call — not the alarm.
 */
export function isHeartbeatAlarmTick(
  _first: unknown,
  second?: unknown,
): boolean {
  if (second === null || typeof second !== "object") return false;
  const row = second as { id?: unknown; callback?: unknown };
  return (
    typeof row.id === "string" &&
    row.callback === HEARTBEAT_ALARM_CALLBACK
  );
}

/** The agent surface `armHeartbeatAlarm` needs: the re-arm primitive. */
export interface HeartbeatAlarmAgent {
  ensureHeartbeatAlarm: (
    intervalSeconds: number,
  ) => Promise<{ armed: boolean; alreadyArmed: boolean }>;
}

/**
 * Arm the heartbeat alarm on the agent at the owner-configured
 * interval (default 1800s). Returns the primitive's result.
 * Propagates an arming failure — the caller (onStart) decides
 * best-effort, so a failed arm never fails startup.
 */
export async function armHeartbeatAlarm(
  agent: HeartbeatAlarmAgent,
  env: Record<string, unknown>,
): Promise<{ armed: boolean; alreadyArmed: boolean }> {
  const intervalSeconds = resolveHeartbeatIntervalSeconds(env);
  return agent.ensureHeartbeatAlarm(intervalSeconds);
}
