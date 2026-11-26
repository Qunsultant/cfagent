/**
 * Issue #1655 — op-registry gap: qa.run_sweep missing from
 * OPERATION_CATALOG.
 *
 * The DEFAULT_SCHEDULES daily-qa-sweep goal names qa.run_sweep, but
 * the catalog listed only qa.supervised_fix, so every due tick
 * (06 UTC hour) recorded "daily-qa-sweep: Unknown operation:
 * qa.run_sweep" and left the goal due. The same error surfaced in
 * tests/chain_executor_scheduled_agent.test.ts ("governed firing
 * with a chain executor (#1523)"), blocking PR #1649.
 *
 * Pins (Red on main, Green with the catalog entry):
 * - the qa catalog entry lists qa.run_sweep alongside qa.supervised_fix;
 * - createJob accepts qa.run_sweep and returns a pending descriptor;
 * - a forced daily-qa-sweep tick records no unknown-operation error
 *   and stamps the goal. Forcing the goal makes this pin independent
 *   of the 06 UTC due window; the chain-executor test remains the
 *   standing pin for the in-window behavior.
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

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { OPERATION_CATALOG, createJob } from "../src/orchestrate";
import { MockD1Database } from "./mock-d1";

function makeCtx() {
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
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB). The forced goal IS a built-in: migration
    // 0092's seed plants daily-qa-sweep, so no fixture planting is
    // needed — binding D1 is enough.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => ({ allowed: true }),
      }),
    },
  } as any;
}

describe("qa.run_sweep op-registry gap (#1655)", () => {
  it("the qa catalog entry lists qa.run_sweep alongside qa.supervised_fix", () => {
    const qa = OPERATION_CATALOG.find((e) => e.agent === "qa");
    expect(qa).toBeDefined();
    expect(qa!.operations).toContain("qa.supervised_fix");
    expect(qa!.operations).toContain("qa.run_sweep");
  });

  it("createJob accepts qa.run_sweep and returns a pending descriptor", async () => {
    const job = await createJob(makeEnv(), {
      goalId: "daily-qa-sweep",
      goalName: "Daily QA sweep",
      operation: "qa.run_sweep",
      budgetCents: 500,
    });
    expect(job.operation).toBe("qa.run_sweep");
    expect(job.status).toBe("pending");
  });

  it("a forced daily-qa-sweep tick records no unknown-operation error and stamps the goal", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const tick = await agent.onCron({ forceGoalId: "daily-qa-sweep" });
    expect(
      tick.errors.filter((e: string) => e.includes("daily-qa-sweep")),
    ).toEqual([]);
    expect(tick.jobsCreated).toBeGreaterThanOrEqual(1);
    const goal = (await agent.listGoals()).find(
      (g: any) => g.id === "daily-qa-sweep",
    )!;
    expect(goal.lastRun).toBeTruthy();
  });
});
