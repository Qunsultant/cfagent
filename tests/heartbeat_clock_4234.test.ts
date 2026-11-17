// @vitest-environment node
/**
 * Issue #4234 (ADR 0030) — the heartbeat clock: the one recurring
 * SDK alarm on the ScheduledAgent.
 *
 * Pinned behaviors:
 * - Alarm-tick detection (`isHeartbeatAlarmTick`): the SDK invokes
 *   a scheduled callback as `handler(payload, schedule)` — two
 *   arguments, the second a Schedule row (string `id`, string
 *   `callback`). That shape, with callback `onCron`, is the alarm
 *   tick. Every other onCron call shape (RPC `onCron()`, one-arg
 *   opts, manual trigger `(env, { forceGoalId })`) is NOT an alarm
 *   tick and behaves exactly as today.
 * - Arming (`armHeartbeatAlarm`): resolves the interval from env
 *   (default 1800s) and arms the alarm through the agent's
 *   `ensureHeartbeatAlarm` primitive, returning its result.
 */
import { describe, it, expect, vi } from "vitest";

import {
  isHeartbeatAlarmTick,
  armHeartbeatAlarm,
} from "../src/services/heartbeatClock";

describe("isHeartbeatAlarmTick (#4234)", () => {
  it("detects the SDK alarm shape: payload + onCron schedule row", () => {
    expect(
      isHeartbeatAlarmTick({}, { id: "s1", callback: "onCron" }),
    ).toBe(true);
  });

  it("rejects the RPC shape: no arguments", () => {
    expect(isHeartbeatAlarmTick()).toBe(false);
  });

  it("rejects a one-arg opts call", () => {
    expect(isHeartbeatAlarmTick({ haltReader: {} })).toBe(false);
  });

  it("rejects the manual trigger shape (env, { forceGoalId })", () => {
    expect(isHeartbeatAlarmTick({}, { forceGoalId: "goal-1" })).toBe(false);
  });

  it("rejects the halted-opts shape (env, { halted })", () => {
    expect(isHeartbeatAlarmTick({}, { halted: true })).toBe(false);
  });

  it("rejects a schedule row for another callback", () => {
    expect(
      isHeartbeatAlarmTick(
        {},
        { id: "s1", callback: "watchdogMissedSchedules" },
      ),
    ).toBe(false);
  });

  it("rejects a schedule-shaped second arg without a callback", () => {
    expect(isHeartbeatAlarmTick({}, { id: "s1" })).toBe(false);
  });

  it("rejects a non-object second arg", () => {
    expect(isHeartbeatAlarmTick({}, "onCron")).toBe(false);
    expect(isHeartbeatAlarmTick({}, null)).toBe(false);
  });
});

describe("armHeartbeatAlarm (#4234)", () => {
  it("arms the alarm at the default 1800s interval and returns the result", async () => {
    const ensureHeartbeatAlarm = vi.fn(async () => ({
      armed: true,
      alreadyArmed: false,
    }));
    const result = await armHeartbeatAlarm({ ensureHeartbeatAlarm }, {});
    expect(ensureHeartbeatAlarm).toHaveBeenCalledTimes(1);
    expect(ensureHeartbeatAlarm).toHaveBeenCalledWith(1800);
    expect(result).toEqual({ armed: true, alreadyArmed: false });
  });

  it("honours an owner-set HEARTBEAT_INTERVAL_SECONDS", async () => {
    const ensureHeartbeatAlarm = vi.fn(async () => ({
      armed: true,
      alreadyArmed: false,
    }));
    await armHeartbeatAlarm(
      { ensureHeartbeatAlarm },
      { HEARTBEAT_INTERVAL_SECONDS: "900" },
    );
    expect(ensureHeartbeatAlarm).toHaveBeenCalledWith(900);
  });

  it("propagates an arming failure (the caller decides best-effort)", async () => {
    const ensureHeartbeatAlarm = vi.fn(async () => {
      throw new Error("scheduleEvery rejected the callback");
    });
    await expect(
      armHeartbeatAlarm({ ensureHeartbeatAlarm }, {}),
    ).rejects.toThrow("scheduleEvery rejected the callback");
  });
});
