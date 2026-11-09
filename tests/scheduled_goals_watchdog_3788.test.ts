// @vitest-environment node
/**
 * Issue #3788 (parent incident #3781) — schedule watchdog, ScheduledAgent
 * integration.
 *
 * A goal that misses its firing must be detectable from the runs ledger,
 * not just from a panel reading "never": one onCron tick past the
 * expected tick + grace emits the missed-fire ledger record (skipped,
 * "missed-fire: ..."), a Slack alert through the injected poster, and a
 * heartbeat record — exactly once per (goal, expected tick).
 *
 * TDD Red: ScheduledAgent has no watchdog yet (no runScheduleWatchdog,
 * no watchdogSlackPost opt, no heartbeat record).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  OPERATION_CATALOG: [
    { agent: "search", binding: "ORCHESTRATOR_AGENT", operations: ["search.query"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { SCHEDULE_WATCHDOG_FIRST_SEEN_KEY } from "../src/services/scheduleWatchdog";

function makeStore() {
  const store = new Map<string, unknown>();
  return {
    store,
    ctx: {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
      },
    },
  };
}

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/test",
    MISSED_SCHEDULE_GRACE_MINUTES: "0.01",
  } as any;
}

/** Cron for one hour ago (UTC), so the tick is past but the goal is not due now. */
function hourAgoCron(minute: number): string {
  const prevHour = (new Date().getUTCHours() + 23) % 24;
  return `${minute} ${prevHour} * * *`;
}

function missedGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: hourAgoCron(0),
    operation: "search.query",
    budgetCents: 500,
    enabled: true,
    ...overrides,
  };
}

describe("ScheduledAgent schedule watchdog (#3788)", () => {
  it("flags a goal that never fired: ledger record + Slack alert + heartbeat", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [missedGoal()]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "daily-qa-sweep": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // The watchdog reads the poster's args through postSlackText; capture
    // the rendered text via the posted JSON body instead.
    const bodies: string[] = [];
    const capturingPost = vi.fn(async (_url: string, _headers: unknown, body: string) => {
      bodies.push(body);
      return { status: 200 };
    });
    await agent.onCron({ watchdogSlackPost: capturingPost });

    const runs = await agent.listJobRuns("daily-qa-sweep");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail).toMatch(/^missed-fire: expected /);
    expect(runs[0].detail).toContain("(last run: never)");

    expect(capturingPost).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toContain("daily-qa-sweep");
    expect(bodies[0]).toContain("missed");

    const heartbeat = await agent.listJobRuns("schedule-watchdog-heartbeat");
    expect(heartbeat).toHaveLength(1);
    expect(heartbeat[0].outcome).toBe("success");
    expect(heartbeat[0].detail).toContain("examined=1");
    expect(heartbeat[0].detail).toContain("missed=1");
  });

  it("flags a #1819 resource goal the same way (resource-daily-rollup)", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [
      missedGoal({
        id: "resource-daily-rollup",
        name: "SessionStore daily resource rollup",
        cron: hourAgoCron(30),
        timeZone: "UTC",
        operation: "resource.rollup_daily",
        budgetCents: 1,
      }),
    ]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "resource-daily-rollup": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });

    const runs = await agent.listJobRuns("resource-daily-rollup");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail).toMatch(/^missed-fire: expected /);
    expect(capturingPost).toHaveBeenCalledTimes(1);
  });

  it("does not flag a goal that ran at/after its expected tick", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const goal = missedGoal();
    store.set("goals", [goal]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "daily-qa-sweep": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // A run 30 minutes ago covers the hour-ago tick.
    store.set("jobRunRecords", [
      {
        system: "scheduled-agent-goal",
        jobId: "daily-qa-sweep",
        operation: "search.query",
        started: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        finished: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: "daily-qa-sweep",
        asyncJobId: null,
        workflowId: null,
      },
    ]);
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });

    expect(await agent.listJobRuns("daily-qa-sweep")).toHaveLength(1);
    expect(capturingPost).not.toHaveBeenCalled();
    const heartbeat = await agent.listJobRuns("schedule-watchdog-heartbeat");
    expect(heartbeat).toHaveLength(1);
    expect(heartbeat[0].detail).toContain("missed=0");
  });

  it("never flags a disabled goal", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [missedGoal({ enabled: false })]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "daily-qa-sweep": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });
    expect(await agent.listJobRuns("daily-qa-sweep")).toHaveLength(0);
    expect(capturingPost).not.toHaveBeenCalled();
  });

  it("does not flag on first sight: the first tick stamps first-seen only", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [missedGoal()]);
    // No first-seen entry seeded: the goal is observed for the first
    // time on this tick, so a tick before that cannot be attributed.
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });
    expect(await agent.listJobRuns("daily-qa-sweep")).toHaveLength(0);
    expect(capturingPost).not.toHaveBeenCalled();
    const firstSeen = store.get(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY) as Record<string, string>;
    expect(typeof firstSeen["daily-qa-sweep"]).toBe("string");
  });

  it("alerts exactly once per (goal, expected tick) across ticks", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [missedGoal()]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "daily-qa-sweep": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });
    await agent.onCron({ watchdogSlackPost: capturingPost });

    const runs = await agent.listJobRuns("daily-qa-sweep");
    expect(runs).toHaveLength(1);
    expect(capturingPost).toHaveBeenCalledTimes(1);
    // The heartbeat proves the second tick ran (the tick path is alive).
    expect(await agent.listJobRuns("schedule-watchdog-heartbeat")).toHaveLength(2);
  });

  it("never stamps lastRun: the alert branch stays unstamped", async () => {
    const { store, ctx } = makeStore();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    store.set("goals", [missedGoal()]);
    store.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "daily-qa-sweep": new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const capturingPost = vi.fn(async () => ({ status: 200 }));
    await agent.onCron({ watchdogSlackPost: capturingPost });
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBeUndefined();
  });
});
