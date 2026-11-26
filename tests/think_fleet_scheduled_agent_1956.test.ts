/**
 * Issue #1956 (think-fleet, ScheduledAgent slice) — ScheduledAgent
 * extends PortThink instead of raw Agent, with its cron/goal
 * behavior preserved.
 *
 * Pinned here:
 * - the class is PortThink-backed (instanceof PortThink);
 * - it exposes NO port hooks (this class has no turn path, so
 *   portHooks stays unset and PortThink's chat hooks are no-ops);
 * - the observable goal surface still works through the new base
 *   (addGoal + triggerGoal creates exactly one job via the mocked
 *   orchestrator, as before the migration).
 *
 * NOTE: this suite loads thinkAdapter.ts (via scheduled-agent.ts),
 * whose runtime `import { Think } from "@cloudflare/think"` loads
 * under Node vitest only through the program harness (#2003,
 * tracker #1951): vite.config.ts `test.alias` maps the bare
 * specifier to the test-only stub tests/stubs/cloudflareThink.ts,
 * which is constructible with (ctx, env) but refuses turns. The
 * production Worker build ignores that alias and still resolves
 * the real @cloudflare/think. This suite exercises no turn path
 * (this class has none) — only construction, the no-hooks pin,
 * and the cron/goal surface through the new base.
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
  OPERATION_CATALOG: [
    { agent: "search", binding: "ORCHESTRATOR_AGENT", operations: ["search.query"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { PortThink } from "../src/actors/thinkAdapter";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
  };
}

function makeEnv() {
  return {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); addGoal/triggerGoal resolve the store.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
  } as any;
}

describe("ScheduledAgent think-fleet migration (#1956)", () => {
  it("extends PortThink", () => {
    const agent = new (ScheduledAgent as any)(makeCtx(), makeEnv());
    expect(agent instanceof PortThink).toBe(true);
  });

  it("exposes no port hooks (no turn path on this class)", () => {
    const agent = new (ScheduledAgent as any)(makeCtx(), makeEnv());
    expect((agent as any).portHooks).toBeUndefined();
  });

  it("goal surface still works through the PortThink base", async () => {
    const agent = new (ScheduledAgent as any)(makeCtx(), makeEnv());
    const goal = await agent.addGoal({
      id: "think-fleet-probe",
      name: "Think fleet probe",
      cron: "0 6 * * *",
      operation: "search.query",
      budgetCents: 500,
    });
    expect(goal.id).toBe("think-fleet-probe");
    // #6503 — isolate the probe goal before triggering: addGoal
    // ran over a D1 store that migration 0092 seeded with the 9
    // built-ins, and triggerGoal runs a full onCron tick — the
    // seeded hourly resource-cap-alert goal is always due (it never
    // stamps lastRun by design) and must not leak into this test's
    // errors assertion. The old isolation (`ctx.storage.put("goals",
    // [goal])`) is dead — the "goals" KV key is never read — so
    // prune the seeded goals from D1 instead (same pattern as the
    // #6503 G3 goals-tick file).
    const store = createD1UnifiedSchedulePorts({
      d1: (agent as any).env.AGENT_DB as never,
    }).unifiedSchedules;
    for (const row of await store.listByKind("goal")) {
      if (row.id !== "think-fleet-probe") await store.remove(row.id);
    }
    const tick = await agent.triggerGoal("think-fleet-probe");
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    const goals = await agent.listGoals();
    expect(goals.some((g: any) => g.id === "think-fleet-probe")).toBe(true);
  });
});
