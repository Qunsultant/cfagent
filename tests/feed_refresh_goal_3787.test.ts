// @vitest-environment node
/**
 * Issue #4306 S2 — the `feed-refresh` goal is REMOVED. Feed datasets
 * are produced by the per-job Think scheduled tasks (`pipeline-job:`
 * tasks, one per feed job, monthly); the hourly goal dispatch is gone.
 *
 * This file used to pin the goal's firing (#3787d). It now pins the
 * removal:
 * - `feed-refresh` is absent from DEFAULT_SCHEDULES (9 goals remain).
 * - Seeding an empty store does not re-add it (the seed rule seeds
 *   FROM DEFAULT_SCHEDULES, so deletion closes the re-seed path).
 * - addGoal refuses `feed.refresh_all` as an unknown operation
 *   (the operation catalog no longer carries it).
 * - A stored `feed-refresh` goal left behind dispatches nothing:
 *   the tick fails visibly naming the unknown operation instead of
 *   minting a job (createJob validates against the catalog).
 *
 * The mock orchestrate catalog below mirrors the real post-S2 catalog
 * for the operations this file exercises (no `feed` entry); the mock
 * createJob mirrors the real validation (unknown operation throws).
 * The real-catalog absence is pinned separately by
 * tests/screener_chain_stuck_3787.test.ts (real OPERATION_CATALOG)
 * and tests/goal_compiler.test.ts (full agent list).
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
      agent: "qa",
      binding: "SCHEDULED_AGENT",
      operations: ["qa.run_sweep"],
      blurb: "",
    },
    {
      agent: "social",
      binding: "SCHEDULED_AGENT",
      operations: ["social.publish"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => {
    const catalog = [
      { agent: "qa", operations: ["qa.run_sweep"] },
      { agent: "social", operations: ["social.publish"] },
    ];
    if (!catalog.some((e) => e.operations.includes(req.operation))) {
      throw new Error(`Unknown operation: ${req.operation}`);
    }
    return { jobId: "job_1", ...req, status: "pending" };
  }),
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

/** A stored feed-refresh goal as a deployment that has not yet run removeGoal would carry it. */
function storedFeedGoal() {
  return {
    id: "feed-refresh",
    name: "Feed refresh (all feed jobs)",
    cron: "0 * * * *",
    timeZone: "UTC",
    operation: "feed.refresh_all",
    budgetCents: 1,
    enabled: true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("feed-refresh goal removal (#4306 S2)", () => {
  it("DEFAULT_SCHEDULES carries no feed-refresh goal (9 goals remain)", () => {
    expect(DEFAULT_SCHEDULES.find((g) => g.id === "feed-refresh")).toBeUndefined();
    expect(DEFAULT_SCHEDULES).toHaveLength(9);
    expect(DEFAULT_SCHEDULES.map((g) => g.id)).toEqual([
      "daily-qa-sweep",
      "opportunity-hunt",
      "daily-social-post",
      "resource-daily-rollup",
      "resource-cap-alert",
      "resource-dashboard-comparison",
      "index-refresh-wikipedia",
      "index-refresh-holdings",
      // Issue #4411: the monthly Autopilot evaluation.
      "autopilot-monthly-evaluation",
    ]);
  });

  it("seeding an empty store does not re-add feed-refresh", async () => {
    const ctx = makeCtx();
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const goals = await agent.listGoals();
    expect(goals.map((g) => g.id)).not.toContain("feed-refresh");
    expect(goals).toHaveLength(9);
  });

  it("addGoal refuses feed.refresh_all as an unknown operation", async () => {
    const ctx = makeCtx();
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    await expect(
      agent.addGoal({
        id: "feed-refresh",
        name: "Feed refresh (all feed jobs)",
        cron: "0 * * * *",
        operation: "feed.refresh_all",
        budgetCents: 1,
        enabled: true,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("Unknown operation: feed.refresh_all");
    expect((await agent.listGoals()).map((g) => g.id)).not.toContain("feed-refresh");
  });

  it("a stored feed-refresh goal left behind dispatches nothing and fails visibly", async () => {
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    const ctx = makeCtx([storedFeedGoal()]);
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const tick = await agent.onCron(makeEnv() as never, {
      halted: false,
    } as never);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors).toHaveLength(1);
    expect(tick.errors[0]).toContain("Unknown operation: feed.refresh_all");
    const runs = await agent.listJobRuns("feed-refresh", 1);
    expect(runs[0]?.outcome).toBe("failure");
  });
});
