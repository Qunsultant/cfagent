/**
 * Issue #1446 ([AGENTIC] Phase 3, sub-issue of #1362) — DO persistence
 * pin test for synthesized schedules.
 *
 * The structural confirmation gate, pinned at the storage level:
 * synthesized records live under the `synthesizedSchedules` DO key,
 * NEVER under the `goals` key that `onCron`/`triggerGoal` read — so
 * a pending record cannot fire through the existing firing paths
 * even if a caller errs. Approval persists on exactly that record
 * and never creates a goals-list entry.
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
import { SYNTHESIZED_SCHEDULES_KEY } from "../src/agentic/jobSynthesis";
import { compileGoal } from "../src/orchestrate";
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
    // #6503 — listGoals reads the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
  } as any;
}

describe("synthesized schedules in ScheduledAgent DO storage (#1446)", () => {
  it("synthesis persists a PENDING record under a separate key, invisible to listGoals", async () => {
    const { ctx, store } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    const record = await agent.synthesizeSchedule(chain, {
      id: "synth-do-nasdaq",
      cron: "0 6 * * *",
    });
    expect(record.status).toBe("pending");
    expect(record.kind).toBe("recurring");
    expect(record.deliveryChannels).toEqual(["slack"]);

    // Stored under the synthesized key, never under "goals".
    const stored = store.get(SYNTHESIZED_SCHEDULES_KEY) as any[];
    expect(stored.some((r: any) => r.id === "synth-do-nasdaq")).toBe(true);
    const goals = store.get("goals") as any[] | undefined;
    expect(goals ?? []).not.toContainEqual(
      expect.objectContaining({ id: "synth-do-nasdaq" }),
    );
    const listed = await agent.listGoals();
    expect(listed.some((g: any) => g.id === "synth-do-nasdaq")).toBe(false);
    const synth = await agent.listSynthesizedSchedules();
    expect(synth.some((r: any) => r.id === "synth-do-nasdaq")).toBe(true);
  });

  it("approval persists on exactly that record and creates no goals-list entry", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chainA = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    const chainB = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    await agent.synthesizeSchedule(chainA, { id: "synth-do-a", cron: "0 6 * * *" });
    await agent.synthesizeSchedule(chainB, { id: "synth-do-b" });
    const approved = await agent.approveSynthesizedSchedule("synth-do-a");
    expect(approved.status).toBe("approved");
    expect(approved.id).toBe("synth-do-a");
    const synth = await agent.listSynthesizedSchedules();
    expect(synth).toHaveLength(2);
    expect(synth.find((r: any) => r.id === "synth-do-a")?.status).toBe("approved");
    expect(synth.find((r: any) => r.id === "synth-do-b")?.status).toBe("pending");
    // Still no goals-list entry for the approved record: approval is a
    // status flip, not materialization (firing wiring is follow-up).
    const listed = await agent.listGoals();
    expect(listed.some((g: any) => g.id === "synth-do-a")).toBe(false);
    // Re-approve: no duplicate, still approved.
    await agent.approveSynthesizedSchedule("synth-do-a");
    expect((await agent.listSynthesizedSchedules())).toHaveLength(2);
  });

  it("approving an unknown synthesized id throws; duplicate synthesis ids throw", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    await expect(agent.approveSynthesizedSchedule("synth-nope")).rejects.toThrow(
      /Unknown synthesized schedule/,
    );
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    await agent.synthesizeSchedule(chain, { id: "synth-do-dup" });
    await expect(agent.synthesizeSchedule(chain, { id: "synth-do-dup" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("killing a synthesized schedule persists, is terminal, and stays enumerable (#1468)", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chainA = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    const chainB = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    await agent.synthesizeSchedule(chainA, { id: "synth-do-kill-a", cron: "0 6 * * *" });
    await agent.synthesizeSchedule(chainB, { id: "synth-do-kill-b" });
    await agent.approveSynthesizedSchedule("synth-do-kill-a");
    const killed = await agent.killSynthesizedSchedule("synth-do-kill-a");
    expect(killed.status).toBe("killed");
    // Terminal: approval of a killed record throws.
    await expect(agent.approveSynthesizedSchedule("synth-do-kill-a")).rejects.toThrow(
      /killed/,
    );
    // The other record is untouched; the killed one stays enumerable.
    const synth = await agent.listSynthesizedSchedules();
    expect(synth.find((r: any) => r.id === "synth-do-kill-b")?.status).toBe("pending");
    expect(synth.filter((r: any) => r.status === "killed").map((r: any) => r.id)).toEqual([
      "synth-do-kill-a",
    ]);
    // Re-kill is a no-op, unknown ids throw.
    await agent.killSynthesizedSchedule("synth-do-kill-a");
    expect((await agent.listSynthesizedSchedules())).toHaveLength(2);
    await expect(agent.killSynthesizedSchedule("synth-nope")).rejects.toThrow(
      /Unknown synthesized schedule/,
    );
  });
});
