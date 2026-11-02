/**
 * Issue #1980 — index-list refresh goals through ScheduledAgent
 * (follows the resource_goals_scheduled_1819.test.ts harness:
 * mocked `agents` base, mocked orchestrate catalog, fake DO
 * storage, fake timers).
 *
 * Pinned behaviors:
 * - An injected refresh executor fires the goal, stamps lastRun,
 *   and names partial failures as tick errors (partial still
 *   stamps: the run happened, the next cadence re-fetches).
 * - An all-failed job throws into the tick: error recorded,
 *   goal stays due (lastRun untouched).
 * - Holdings goal with no executor fails visibly and stays due
 *   (no invented holdings URL); Wikipedia goal with no executor
 *   and no AGENT_DB fails visibly and stays due.
 * - The goals fire on their real cadences from DEFAULT_SCHEDULES
 *   (Wikipedia Sunday 04:00 UTC, holdings daily 03:00 UTC).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    {
      agent: "index",
      binding: "SCHEDULED_AGENT",
      operations: ["index.refresh_wikipedia", "index.refresh_holdings"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";

function makeCtx(initialGoals?: any[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
  };
}

function indexGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "index-refresh-wikipedia",
    name: "Index-list refresh (Wikipedia)",
    cron: "0 4 * * 0",
    timeZone: "UTC",
    operation: "index.refresh_wikipedia",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("index.refresh_wikipedia via onCron (#1980)", () => {
  it("fires Sunday 04:00 UTC, stamps lastRun, and names partial failures", async () => {
    // 2026-11-01 is a Sunday.
    vi.setSystemTime(new Date("2026-11-01T04:00:00Z"));
    const ctx = makeCtx([indexGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(async () => ({
      status: "partial" as const,
      artifacts: [{ artifactId: "a1", index: "dow" as const, snapshotDate: "2026-11-01", source: "wikipedia", sourceLabel: "Wikipedia", memberCount: 30 }],
      failures: [{ index: "sp500" as const, error: "wiki timeout" }],
      reason: "partial index refresh: sp500 failed",
    }));
    const tick = await agent.onCron(env as never, { halted: false, indexRefreshExecutor: executor } as never);
    expect(executor).toHaveBeenCalledWith("index.refresh_wikipedia");
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/sp500/);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBe("2026-11-01T04:00:00.000Z");
  });

  it("does not fire Saturday 04:00 UTC (wrong weekday)", async () => {
    // 2026-10-31 is a Saturday.
    vi.setSystemTime(new Date("2026-10-31T04:00:00Z"));
    const ctx = makeCtx([indexGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(async () => ({
      status: "completed" as const,
      artifacts: [],
      failures: [],
    }));
    const tick = await agent.onCron(env as never, { halted: false, indexRefreshExecutor: executor } as never);
    expect(executor).not.toHaveBeenCalled();
    expect(tick.jobsCreated).toBe(0);
  });

  it("all-failed job errors and stays due", async () => {
    vi.setSystemTime(new Date("2026-11-01T04:00:00Z"));
    const ctx = makeCtx([indexGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(async () => {
      throw new Error("Index-list refresh failed for every index (dow: down)");
    });
    const tick = await agent.onCron(env as never, { halted: false, indexRefreshExecutor: executor } as never);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/every index/);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("Wikipedia goal with no executor and no AGENT_DB errors and stays due", async () => {
    vi.setSystemTime(new Date("2026-11-01T04:00:00Z"));
    const ctx = makeCtx([indexGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/AGENT_DB/);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });
});

describe("index.refresh_holdings via onCron (#1980)", () => {
  it("holdings goal with no executor fails visibly and stays due (no invented URL)", async () => {
    vi.setSystemTime(new Date("2026-11-02T03:00:00Z"));
    const ctx = makeCtx([
      indexGoal({
        id: "index-refresh-holdings",
        name: "Index-list refresh (ETF holdings)",
        cron: "0 3 * * *",
        operation: "index.refresh_holdings",
        enabled: true,
      }),
    ]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/holdings fetcher not bound/);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("forced trigger fires the disabled holdings goal through an injected executor", async () => {
    vi.setSystemTime(new Date("2026-11-02T03:00:00Z"));
    const ctx = makeCtx([
      indexGoal({
        id: "index-refresh-holdings",
        name: "Index-list refresh (ETF holdings)",
        cron: "0 3 * * *",
        operation: "index.refresh_holdings",
        enabled: false,
      }),
    ]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(async () => ({
      status: "completed" as const,
      artifacts: [{ artifactId: "a1", index: "russell2000" as const, snapshotDate: "2026-11-01", source: "iwm", sourceLabel: "IWM holdings-derived", memberCount: 1900 }],
      failures: [],
    }));
    const tick = await agent.onCron(env as never, {
      halted: false,
      forceGoalId: "index-refresh-holdings",
      indexRefreshExecutor: executor,
    } as never);
    expect(executor).toHaveBeenCalledWith("index.refresh_holdings");
    expect(tick.jobsCreated).toBe(1);
  });
});
