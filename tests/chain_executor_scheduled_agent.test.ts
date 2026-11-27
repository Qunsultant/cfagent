/**
 * Issue #1523 ([AGENTIC] Lane 2) — executor plug into lane 1's
 * firing path.
 *
 * Governed decision + PaymentsAgent budget check stay in front;
 * the executor runs only after both pass. Success stamps goal +
 * record and creates the descriptor (lane 1 behavior, plus real
 * legs); executor failure stamps nothing, creates no descriptor,
 * and leaves the goal due with a tick error naming the chain. No
 * executor supplied = exactly lane 1 behavior. Fakes only — no
 * live scheduled job, no broker, no queued job.
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
import { compileGoal } from "../src/orchestrate";
import { createChainLegExecutor } from "../src/agentic/chainExecutor";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { makeLedgerStub } from "./ledger-stub";

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

function makeEnv(budgetAllowed = true, mockD1 = new MockD1Database()) {
  return {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: mockD1,
    // #6101 step 9 — the KV "jobRunRecords" key is retired: fired
    // goals' records land via the ledger post on ORCHESTRATOR_AGENT
    // (the shared stub), and listJobRuns reads them back from it.
    ORCHESTRATOR_AGENT: makeLedgerStub().namespace,
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => ({
          allowed: budgetAllowed,
          reason: budgetAllowed ? undefined : "over budget",
        }),
      }),
    },
  } as any;
}

function dueCron() {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

async function materializedAgent(id: string) {
  const { ctx } = makeCtx();
  const mockD1 = new MockD1Database();
  const agent = new (ScheduledAgent as any)(ctx, makeEnv(true, mockD1));
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  await agent.synthesizeSchedule(chain, { id, cron: dueCron() });
  await agent.approveSynthesizedSchedule(id);
  const goal = await agent.materializeSynthesizedSchedule(id);
  // #6503 — the old hour-06 flake workaround (overwriting the "goals"
  // KV key) is dead with the key. The same scope is kept by pruning
  // migration 0092's seeded built-ins from D1 after materialize, so
  // the tick sees ONLY the chain goal: daily-qa-sweep (cron
  // "0 6 * * *", enabled) would otherwise fire during UTC hour 06
  // and inflate jobsCreated to 2. Same pattern as the #6503 G3
  // goals-tick file.
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  for (const row of await store.listByKind("goal")) {
    if (row.id !== id) await store.remove(row.id);
  }
  return agent;
}

function fakeRunner() {
  return async (_deps: any, payload: any) => {
    const { stage, key } = payload.shard;
    if (stage === "feed") return { listings: [{ symbol: "AAPL" }], quotes: [] };
    if (stage === "generate" && key === "assemble") {
      return { opportunities: [], totalScanned: 1, matchedCount: 0, universe: "NASDAQ100", timestamp: "2026-10-25T00:00:00.000Z" };
    }
    if (stage === "generate") return { format: key, key: `screener:${key}:abc`, fileName: `report.${key}` };
    if (stage === "store") {
      return { format: payload.inputs.format, key: payload.inputs.key, reportId: "r1" };
    }
    throw new Error(`unexpected shard ${stage}/${key}`);
  };
}

function executorFor(id: string) {
  const runtime: any = {
    sql: { exec: () => [] as any },
    env: {},
    orm: {},
    storage: {},
    createETradeService: () => ({}),
    sessionId: "test-session",
  };
  return createChainLegExecutor(
    runtime,
    { chainId: id, userLogin: "test-login", universe: "NASDAQ100", chainVersion: 1, trigger: "scheduled" },
    { shardRunner: fakeRunner() as any },
  );
}

describe("governed firing with a chain executor (#1523)", () => {
  it("executes legs, then stamps goal + record and counts the firing", async () => {
    const id = "synth-exec-ok";
    const agent = await materializedAgent(id);
    const tick = await agent.onCron({ chainExecutor: executorFor(id) });
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    const goal = (await agent.listGoals()).find((g: any) => g.id === id)!;
    expect(goal.lastRun).toBeTruthy();
    const record = (await agent.listSynthesizedSchedules()).find((r: any) => r.id === id)!;
    expect(record.lastRun).toBeTruthy();
  });

  it("executor failure creates no descriptor, stamps nothing, and names the chain", async () => {
    const id = "synth-exec-fail";
    const agent = await materializedAgent(id);
    const failing = async () => {
      throw new Error("feed shard boom");
    };
    const tick = await agent.onCron({ chainExecutor: failing });
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors.some((e: string) => e.includes(id))).toBe(true);
    const goal = (await agent.listGoals()).find((g: any) => g.id === id)!;
    expect(goal.lastRun).toBeFalsy();
    const record = (await agent.listSynthesizedSchedules()).find((r: any) => r.id === id)!;
    expect(record.lastRun).toBeFalsy();
  });

  it("no executor supplied keeps lane 1 behavior (descriptor, stamps, no legs claimed)", async () => {
    const id = "synth-exec-none";
    const agent = await materializedAgent(id);
    const tick = await agent.onCron();
    expect(tick.jobsCreated).toBe(1);
    const goal = (await agent.listGoals()).find((g: any) => g.id === id)!;
    expect(goal.lastRun).toBeTruthy();
  });

  it("one-shot direct firing runs the executor and reports execution; failure consumes nothing", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Send yesterday's report by email", {
      budgetCents: 1000,
    });
    if (!chain) throw new Error("one-shot chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-exec-one" });
    await agent.approveSynthesizedSchedule("synth-exec-one");
    const ok = await agent.fireSynthesizedSchedule("synth-exec-one", {
      chainExecutor: async (step: any) => ({ ran: step.capabilityId }),
    });
    expect(ok.fired).toBe(true);
    expect(ok.execution).toBeDefined();
    expect(ok.execution.legs.every((l: any) => l.status === "completed")).toBe(true);
    expect(ok.record.firedAt).toBeTruthy();

    const agent2 = new (ScheduledAgent as any)(makeCtx().ctx, makeEnv());
    await agent2.synthesizeSchedule(chain, { id: "synth-exec-one-fail" });
    await agent2.approveSynthesizedSchedule("synth-exec-one-fail");
    const failed = await agent2.fireSynthesizedSchedule("synth-exec-one-fail", {
      chainExecutor: async () => {
        throw new Error("serve shard boom");
      },
    });
    expect(failed.fired).toBe(false);
    expect(failed.reason).toMatch(/serve shard boom/);
    expect(failed.record.firedAt).toBeFalsy();
  });
});

describe("one-shot executor failure records a consolidated-ledger row (#3393)", () => {
  it("3393-P04 executor failure records a failure row with the error and no job", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Send yesterday's report by email", {
      budgetCents: 1000,
    });
    if (!chain) throw new Error("one-shot chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-3393-execfail" });
    await agent.approveSynthesizedSchedule("synth-3393-execfail");
    const failed = await agent.fireSynthesizedSchedule("synth-3393-execfail", {
      chainExecutor: async () => {
        throw new Error("serve shard boom");
      },
    });
    expect(failed.fired).toBe(false);
    expect(failed.reason).toMatch(/serve shard boom/);
    const rows = (await agent.listJobRuns("synth-3393-execfail")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failure");
    expect(rows[0].error).toMatch(/serve shard boom/);
    expect(rows[0].trigger).toBe("manual");
    expect(rows[0].scheduleId).toBe("synth-3393-execfail");
    expect(rows[0].asyncJobId).toBeNull();
    expect(rows[0].workflowId).toBeNull();
    expect(rows[0].jobId).toBe("synth-3393-execfail");
    expect(rows[0].operation).toBe("chain.execute");
  });
});
