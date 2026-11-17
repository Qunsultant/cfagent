// @vitest-environment node
/**
 * Issue #4234 (ADR 0030) — the hourly heartbeat watchdog.
 *
 * Pinned behaviors:
 * - Config (src/config/heartbeatWatchdog.ts): the watchdog cron is
 *   hourly (`0 * * * *`); the heartbeat interval defaults to 1800s
 *   (today's 30-minute tick cadence; #4235 may change it later) and the
 *   staleness threshold defaults to 120 minutes. Blank, unparseable,
 *   or non-positive values fall through to the defaults — the
 *   watchdog has no disabling value.
 * - Pure decision (src/services/heartbeatWatchdog.ts): a missing
 *   alarm re-arms without force; a present-but-stale alarm (or one
 *   that never fired) re-arms with force (cancel + re-create); a
 *   fresh alarm is healthy and re-arms nothing.
 * - Entry point (runWatchdogEntryPoint): reads the alarm list and
 *   the last tick from the ScheduledAgent stub, decides, re-arms
 *   only on positive evidence, records exactly one ledger row per
 *   run, and NEVER calls onCron (the watchdog does no tick work).
 * - Re-arm primitive (ScheduledAgent.ensureHeartbeatAlarm): the
 *   #618/#3788 ensure-pattern for the onCron alarm — skip when
 *   present, scheduleEvery when absent, cancel + re-create on
 *   force.
 *
 * Deliberately NOT in this slice: restoring the three #4112 duty
 * crons (tick / renewTokens / retention); any change to the SDK
 * alarm mechanism itself.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", () => ({
  OPERATION_CATALOG: [],
  createJob: vi.fn(async (_env: any, req: any) => ({
    jobId: "job_1",
    ...req,
    status: "pending",
  })),
}));

import {
  HEARTBEAT_WATCHDOG_CRON,
  HEARTBEAT_ALARM_CALLBACK,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS,
  resolveHeartbeatIntervalSeconds,
  resolveHeartbeatWatchdogStaleAfterMs,
  resolveHeartbeatWatchdogConfig,
} from "../src/config/heartbeatWatchdog";
import {
  decideHeartbeatWatchdog,
} from "../src/services/heartbeatWatchdog";
import {
  HEARTBEAT_WATCHDOG_CRON as ROUTED_WATCHDOG_CRON,
  resolveCronEntryPoint,
  runWatchdogEntryPoint,
  type CronDispatchRecordInput,
  type CronEntryPointDeps,
} from "../src/services/consolidatedCronEntries";
import { ScheduledAgent } from "../src/agents/scheduled-agent";

const NOW = new Date("2026-11-13T12:00:00Z");
const NOW_MS = NOW.getTime();
const MIN = 60 * 1000;

describe("heartbeat watchdog config (#4234)", () => {
  it("fires hourly and watches the onCron alarm", () => {
    expect(HEARTBEAT_WATCHDOG_CRON).toBe("0 * * * *");
    expect(ROUTED_WATCHDOG_CRON).toBe(HEARTBEAT_WATCHDOG_CRON);
    expect(HEARTBEAT_ALARM_CALLBACK).toBe("onCron");
    expect(resolveCronEntryPoint(HEARTBEAT_WATCHDOG_CRON)).toBe("watchdog");
  });

  it("defaults the heartbeat interval to 1800s and the staleness threshold to 120 minutes", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_SECONDS).toBe(1800);
    expect(DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS).toBe(120 * MIN);
    expect(resolveHeartbeatWatchdogConfig({})).toEqual({
      intervalSeconds: 1800,
      staleAfterMs: 120 * MIN,
    });
  });

  it("honours owner-set values and falls through to defaults on blank, unparseable, or non-positive values", () => {
    expect(resolveHeartbeatIntervalSeconds({ HEARTBEAT_INTERVAL_SECONDS: "900" })).toBe(900);
    expect(
      resolveHeartbeatWatchdogStaleAfterMs({
        HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES: "30",
      }),
    ).toBe(30 * MIN);
    for (const bad of ["", "  ", "soon", "-5", "0"]) {
      expect(resolveHeartbeatIntervalSeconds({ HEARTBEAT_INTERVAL_SECONDS: bad })).toBe(1800);
      expect(
        resolveHeartbeatWatchdogStaleAfterMs({
          HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES: bad,
        }),
      ).toBe(120 * MIN);
    }
  });
});

describe("decideHeartbeatWatchdog (pure, #4234)", () => {
  const staleAfterMs = 120 * MIN;

  it("missing alarm → re-arm without force", () => {
    const d = decideHeartbeatWatchdog({
      alarmExists: false,
      lastTickAtMs: NOW_MS - 10 * MIN,
      nowMs: NOW_MS,
      staleAfterMs,
    });
    expect(d.finding).toBe("missing");
    expect(d.rearm).toBe(true);
    expect(d.forceRearm).toBe(false);
  });

  it("present alarm, last tick 10 minutes ago → healthy, no re-arm", () => {
    const d = decideHeartbeatWatchdog({
      alarmExists: true,
      lastTickAtMs: NOW_MS - 10 * MIN,
      nowMs: NOW_MS,
      staleAfterMs,
    });
    expect(d.finding).toBe("healthy");
    expect(d.rearm).toBe(false);
    expect(d.forceRearm).toBe(false);
  });

  it("present alarm, last tick 121 minutes ago → stale, re-arm with force", () => {
    const d = decideHeartbeatWatchdog({
      alarmExists: true,
      lastTickAtMs: NOW_MS - 121 * MIN,
      nowMs: NOW_MS,
      staleAfterMs,
    });
    expect(d.finding).toBe("stale");
    expect(d.rearm).toBe(true);
    expect(d.forceRearm).toBe(true);
  });

  it("present alarm that never fired → stale, re-arm with force", () => {
    const d = decideHeartbeatWatchdog({
      alarmExists: true,
      lastTickAtMs: null,
      nowMs: NOW_MS,
      staleAfterMs,
    });
    expect(d.finding).toBe("stale");
    expect(d.rearm).toBe(true);
    expect(d.forceRearm).toBe(true);
  });

  it("a tick exactly at the threshold is healthy (stale only strictly after)", () => {
    const d = decideHeartbeatWatchdog({
      alarmExists: true,
      lastTickAtMs: NOW_MS - staleAfterMs,
      nowMs: NOW_MS,
      staleAfterMs,
    });
    expect(d.finding).toBe("healthy");
  });
});

/* =================================================================
 * Entry point harness (mirrors the S5 makeDeps in
 * tests/schedule-3121-s5-parity.test.ts).
 * ================================================================= */

function makeWatchdogDeps(overrides: Record<string, unknown> = {}): {
  deps: CronEntryPointDeps;
  records: CronDispatchRecordInput[];
  rearms: Array<{ intervalSeconds: number; force?: boolean }>;
  onCronCalls: { count: number };
} {
  const records: CronDispatchRecordInput[] = [];
  const rearms: Array<{ intervalSeconds: number; force?: boolean }> = [];
  const onCronCalls = { count: 0 };
  const scheduledAgent = {
    onCron: async () => {
      onCronCalls.count += 1;
    },
    listSchedules: async () => [] as unknown[],
    getTickHistory: async () => [] as unknown[],
    ensureHeartbeatAlarm: async (
      intervalSeconds: number,
      opts?: { force?: boolean },
    ) => {
      rearms.push({ intervalSeconds, ...opts });
      return { armed: true, alreadyArmed: false };
    },
    ...((overrides.scheduledAgent as Record<string, unknown> | undefined) ?? {}),
  };
  const { scheduledAgent: _ignored, ...rest } = overrides;
  const deps: CronEntryPointDeps = {
    cron: HEARTBEAT_WATCHDOG_CRON,
    entryPoint: "watchdog",
    serviceUserLogin: "service-user",
    serviceProvisioned: true,
    orchestrator: { fetch: async () => new Response("{}", { status: 200 }) },
    scheduledAgent,
    renewTokens: async () => ({}),
    createSink: () => {
      throw new Error("watchdog entry point uses no observability sink");
    },
    slackPoster: async () => undefined,
    dispatchAndAwait: async (promise: Promise<unknown>) => {
      await promise;
    },
    recordDispatch: async (input: CronDispatchRecordInput) => {
      records.push(input);
    },
    now: () => new Date(NOW),
    logError: () => undefined,
    logInfo: () => undefined,
    heartbeatWatchdog: { intervalSeconds: 1800, staleAfterMs: 120 * MIN },
    ...rest,
  } as CronEntryPointDeps;
  return { deps, records, rearms, onCronCalls };
}

describe("runWatchdogEntryPoint (#4234)", () => {
  it("healthy alarm: success row, no re-arm, never calls onCron", async () => {
    const { deps, records, rearms, onCronCalls } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => [{ id: "s1", callback: "onCron" }],
        getTickHistory: async () => [
          { timestamp: new Date(NOW_MS - 10 * MIN).toISOString() },
        ],
      },
    });
    await runWatchdogEntryPoint(deps);
    expect(records).toHaveLength(1);
    expect(records[0].entryPoint).toBe("watchdog");
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("healthy");
    expect(rearms).toHaveLength(0);
    expect(onCronCalls.count).toBe(0);
  });

  it("missing alarm: re-arms without force and records a success row naming the finding", async () => {
    const { deps, records, rearms, onCronCalls } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => [],
        getTickHistory: async () => [
          { timestamp: new Date(NOW_MS - 10 * MIN).toISOString() },
        ],
      },
    });
    await runWatchdogEntryPoint(deps);
    expect(rearms).toEqual([{ intervalSeconds: 1800, force: false }]);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("missing");
    expect(onCronCalls.count).toBe(0);
  });

  it("stale alarm: re-arms with force and records a success row naming the finding", async () => {
    const { deps, records, rearms } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => [{ id: "s1", callback: "onCron" }],
        getTickHistory: async () => [
          { timestamp: new Date(NOW_MS - 200 * MIN).toISOString() },
        ],
      },
    });
    await runWatchdogEntryPoint(deps);
    expect(rearms).toEqual([{ intervalSeconds: 1800, force: true }]);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("stale");
  });

  it("unreadable evidence: failure row, no re-arm (fail-closed, never re-arm on evidence it cannot see)", async () => {
    const { deps, records, rearms } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => {
          throw new Error("DO storage unavailable");
        },
      },
    });
    await expect(runWatchdogEntryPoint(deps)).rejects.toThrow(
      "DO storage unavailable",
    );
    expect(rearms).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error).toContain("DO storage unavailable");
  });

  it("re-arm failure: failure row naming the re-arm error", async () => {
    const { deps, records, rearms } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => [],
        ensureHeartbeatAlarm: async (
          intervalSeconds: number,
          opts?: { force?: boolean },
        ) => {
          // Record the attempt before throwing, like the
          // non-throwing stub: the pin is "exactly one re-arm
          // attempt, failure row naming the error, error propagates".
          rearms.push({ intervalSeconds, ...opts });
          throw new Error("scheduleEvery rejected the callback");
        },
      },
    });
    await expect(runWatchdogEntryPoint(deps)).rejects.toThrow(
      "scheduleEvery rejected the callback",
    );
    expect(rearms).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error).toContain("scheduleEvery rejected the callback");
  });

  it("ignores schedules with other callbacks when deciding the alarm is missing", async () => {
    const { deps, records, rearms } = makeWatchdogDeps({
      scheduledAgent: {
        listSchedules: async () => [
          { id: "s1", callback: "watchdogMissedSchedules" },
          { id: "s2", callback: "sweepStaleAsyncJobs" },
        ],
        getTickHistory: async () => [],
      },
    });
    await runWatchdogEntryPoint(deps);
    expect(rearms).toHaveLength(1);
    expect(records[0].detail).toContain("missing");
  });
});

/* =================================================================
 * Re-arm primitive on the ScheduledAgent.
 * ================================================================= */

function makeAgentCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

function stubScheduler(agent: ScheduledAgent, schedules: Array<{ id: string; callback: string }>) {
  const calls = {
    scheduleEvery: [] as Array<{ intervalSeconds: number; callback: string; payload: unknown }>,
    cancel: [] as string[],
  };
  let rows = [...schedules];
  (agent as unknown as Record<string, unknown>).listSchedules = async () => [...rows];
  (agent as unknown as Record<string, unknown>).scheduleEvery = async (
    intervalSeconds: number,
    callback: string,
    payload?: unknown,
  ) => {
    calls.scheduleEvery.push({ intervalSeconds, callback, payload });
    const id = `sched-${rows.length + 1}`;
    rows.push({ id, callback });
    return { id, callback };
  };
  (agent as unknown as Record<string, unknown>).cancelSchedule = async (id: string) => {
    calls.cancel.push(id);
    rows = rows.filter((r) => r.id !== id);
    return true;
  };
  return { calls, getRows: () => rows };
}

describe("ScheduledAgent.ensureHeartbeatAlarm (#4234)", () => {
  it("arms the onCron alarm when none exists", async () => {
    const agent = new ScheduledAgent(makeAgentCtx() as never, {} as never);
    const { calls, getRows } = stubScheduler(agent, []);
    const result = await agent.ensureHeartbeatAlarm(1800);
    expect(result).toEqual({ armed: true, alreadyArmed: false });
    expect(calls.scheduleEvery).toEqual([
      { intervalSeconds: 1800, callback: "onCron", payload: {} },
    ]);
    expect(calls.cancel).toHaveLength(0);
    expect(getRows().some((r) => r.callback === "onCron")).toBe(true);
  });

  it("skips arming when the onCron alarm already exists", async () => {
    const agent = new ScheduledAgent(makeAgentCtx() as never, {} as never);
    const { calls } = stubScheduler(agent, [{ id: "s1", callback: "onCron" }]);
    const result = await agent.ensureHeartbeatAlarm(1800);
    expect(result).toEqual({ armed: false, alreadyArmed: true });
    expect(calls.scheduleEvery).toHaveLength(0);
    expect(calls.cancel).toHaveLength(0);
  });

  it("force re-arm cancels the wedged alarm and re-creates it", async () => {
    const agent = new ScheduledAgent(makeAgentCtx() as never, {} as never);
    const { calls, getRows } = stubScheduler(agent, [
      { id: "s1", callback: "onCron" },
      { id: "s2", callback: "watchdogMissedSchedules" },
    ]);
    const result = await agent.ensureHeartbeatAlarm(1800, { force: true });
    expect(result).toEqual({ armed: true, alreadyArmed: false });
    expect(calls.cancel).toEqual(["s1"]);
    expect(calls.scheduleEvery).toEqual([
      { intervalSeconds: 1800, callback: "onCron", payload: {} },
    ]);
    expect(getRows().some((r) => r.callback === "watchdogMissedSchedules")).toBe(true);
    expect(getRows().filter((r) => r.callback === "onCron")).toHaveLength(1);
  });

  it("refuses a non-positive interval instead of arming a broken alarm", async () => {
    const agent = new ScheduledAgent(makeAgentCtx() as never, {} as never);
    stubScheduler(agent, []);
    await expect(agent.ensureHeartbeatAlarm(0)).rejects.toThrow(
      "heartbeat interval must be a positive number of seconds",
    );
    await expect(agent.ensureHeartbeatAlarm(-30)).rejects.toThrow(
      "heartbeat interval must be a positive number of seconds",
    );
  });
});
