// @vitest-environment node
/**
 * Issue #3787 (d) — feed datasets produced on a schedule: the
 * `feed.refresh_all` goal fires on the existing ScheduledAgent
 * tick through the pipeline control plane's own feed-job seam
 * (dispatchScheduledPipelineJob), with an injected executor seam
 * for tests (the #1980 index-refresh precedent).
 *
 * Pinned behaviors (the #1980 harness: mocked `agents` base,
 * mocked orchestrate catalog, fake DO storage, fake timers):
 * - An injected executor fires the goal, records success, and
 *   names per-job failures as tick errors (partial still records
 *   success: the run happened, the next cadence re-dispatches).
 *   lastRun is deliberately never stamped (isDue's 23h guard
 *   would suppress an hourly goal).
 * - An all-failed dispatch records failure and stays due.
 * - A second tick within the hour is a deduped no-op.
 * - The goal fires hourly from DEFAULT_SCHEDULES.
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
      agent: "feed",
      binding: "SCHEDULED_AGENT",
      operations: ["feed.refresh_all"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { DEFAULT_SCHEDULES } from "../src/schedule";

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

function feedGoal(overrides: Record<string, unknown> = {}) {
  const seeded = DEFAULT_SCHEDULES.find((g) => g.id === "feed-refresh");
  return {
    id: "feed-refresh",
    name: "Feed refresh (all feed jobs)",
    cron: "0 * * * *",
    timeZone: "UTC",
    operation: "feed.refresh_all",
    budgetCents: 1,
    enabled: true,
    ...(seeded ? { cron: seeded.cron, operation: seeded.operation } : {}),
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

describe("feed.refresh_all via onCron (#3787d)", () => {
  it("fires hourly, stamps no lastRun (isDue's 23h guard would suppress an hourly goal), and names per-job failures as tick errors", async () => {
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    const ctx = makeCtx([feedGoal()]);
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const executor = vi.fn(async () => [
      { jobId: "yahoo-nasdaq100-quotes", state: "queued", runId: "run-1" },
      { jobId: "alpaca-nasdaq100-quotes", state: "running", error: "job_already_running: Job \"alpaca-nasdaq100-quotes\" is running" },
      { jobId: "etrade-nasdaq100-quotes", state: "failed", error: "FEED_FETCH_FAILED: boom" },
    ]);
    const tick = await agent.onCron(makeEnv() as never, {
      halted: false,
      feedRefreshExecutor: executor,
    } as never);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toHaveLength(1);
    expect(tick.errors[0]).toContain("etrade-nasdaq100-quotes");
    expect(tick.errors[0]).toContain("FEED_FETCH_FAILED");
    // The already-running job is not an error: its dataset is
    // being produced by the in-flight run.
    expect(tick.errors[0]).not.toContain("alpaca");
    const goals = ctx._store.get("goals") as Array<{ id: string; lastRun?: string }>;
    // Deliberately unstamped (the resource.cap_alert precedent):
    // stamping lastRun would let isDue's 23h guard suppress the
    // next hourly firing. Hourly dedup lives in the run record.
    expect(goals.find((g) => g.id === "feed-refresh")?.lastRun).toBeUndefined();
    const runs = await agent.listJobRuns("feed-refresh", 1);
    expect(runs[0]?.outcome).toBe("success");
  });

  it("all-failed dispatch records failure and stays due (lastRun untouched)", async () => {
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    const ctx = makeCtx([feedGoal()]);
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const executor = vi.fn(async () => [
      { jobId: "yahoo-nasdaq100-quotes", state: "failed", error: "FEED_FETCH_FAILED: boom" },
    ]);
    const tick = await agent.onCron(makeEnv() as never, {
      halted: false,
      feedRefreshExecutor: executor,
    } as never);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors[0]).toContain("FEED_FETCH_FAILED");
    const goals = ctx._store.get("goals") as Array<{ id: string; lastRun?: string }>;
    expect(goals.find((g) => g.id === "feed-refresh")?.lastRun).toBeUndefined();
    const runs = await agent.listJobRuns("feed-refresh", 1);
    expect(runs[0]?.outcome).toBe("failure");
  });

  it("a second tick within the hour is a deduped no-op (executor not called again)", async () => {
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    const ctx = makeCtx([feedGoal()]);
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const executor = vi.fn(async () => [
      { jobId: "yahoo-nasdaq100-quotes", state: "queued", runId: "run-1" },
    ]);
    const first = await agent.onCron(makeEnv() as never, {
      halted: false,
      feedRefreshExecutor: executor,
    } as never);
    expect(first.jobsCreated).toBe(1);
    vi.setSystemTime(new Date("2026-11-08T03:30:00Z"));
    const second = await agent.onCron(makeEnv() as never, {
      halted: false,
      feedRefreshExecutor: executor,
    } as never);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(second.jobsCreated).toBe(0);
    expect(second.jobsSkipped).toBe(1);
    expect(second.errors).toHaveLength(0);
  });
});
