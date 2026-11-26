/**
 * Issue #1517 ([AGENTIC] Lane 1, follow-up of #1362) — DO integration.
 *
 * Approval alone still creates no goals-list entry (Phase 3 pin,
 * preserved); only the explicit `materializeSynthesizedSchedule`
 * call does. `onCron` fires a materialized goal only through the
 * governed decision: pending-at-materialize-time cannot happen
 * (materialize refuses it), but a record killed AFTER materializing,
 * a globally-halted tick, a not-due record, and an orphan goal all
 * fail closed with zero job descriptors and a tick error naming the
 * chain. One-shot records fire only through the direct method, never
 * through a goals entry, and are consumed on firing. Tests use
 * fakes/shims only — no live scheduled job is created.
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
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";

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

/** Cron due in the current UTC hour, so isDue passes regardless of when the test runs. */
function dueCron() {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

// NOTE: each test uses a distinct synthesized id. Post-#6503 each
// test also gets its own MockD1, so no goal state leaks across
// tests — but the first store op lazily ensures the schema and
// migration 0092's goals seed lands the 9 built-in goals, so
// materializedAgent prunes them: the tick must see ONLY the
// materialized goal (same pattern as the #6503 G3 goals-tick file).
async function pruneSeededGoals(mockD1: MockD1Database, keepIds: string[]) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  const keep = new Set(keepIds);
  for (const row of await store.listByKind("goal")) {
    if (!keep.has(row.id)) await store.remove(row.id);
  }
}

/** Plant one goal row into `mockD1`, sweeping the migration seeds. */
async function plantGoal(mockD1: MockD1Database, goal: any) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  await store.save(goalToRecord(goal));
  await pruneSeededGoals(mockD1, [String(goal.id)]);
}

async function materializedAgent(
  id = "synth-do-fire",
  opts: { budgetAllowed?: boolean } = {},
) {
  const { ctx, store } = makeCtx();
  const mockD1 = new MockD1Database();
  const agent = new (ScheduledAgent as any)(ctx, makeEnv(opts.budgetAllowed ?? true, mockD1));
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  const record = await agent.synthesizeSchedule(chain, {
    id,
    cron: dueCron(),
  });
  expect(record.status).toBe("pending");
  await agent.approveSynthesizedSchedule(id);
  const goal = await agent.materializeSynthesizedSchedule(id);
  await pruneSeededGoals(mockD1, [id]);
  return { agent, store, goal };
}

describe("materialization in ScheduledAgent (#1517)", () => {
  it("approval alone creates no goal; materialize creates exactly one, idempotently", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-do-mat", cron: dueCron() });
    await agent.approveSynthesizedSchedule("synth-do-mat");
    expect((await agent.listGoals()).some((g: any) => g.id === "synth-do-mat")).toBe(false);
    const goal = await agent.materializeSynthesizedSchedule("synth-do-mat");
    expect(goal.operation).toBe("chain.execute");
    expect(goal.cron).toBe(dueCron());
    const again = await agent.materializeSynthesizedSchedule("synth-do-mat");
    expect(again.id).toBe(goal.id);
    expect(
      (await agent.listGoals()).filter((g: any) => g.id === "synth-do-mat"),
    ).toHaveLength(1);
  });

  it("materialize refuses pending and one-shot records, and unknown ids", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-do-pend", cron: dueCron() });
    await expect(agent.materializeSynthesizedSchedule("synth-do-pend")).rejects.toThrow(
      /only approved/,
    );
    const email = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!email) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(email, { id: "synth-do-one" });
    await agent.approveSynthesizedSchedule("synth-do-one");
    await expect(agent.materializeSynthesizedSchedule("synth-do-one")).rejects.toThrow(
      /one-shot/,
    );
    await expect(agent.materializeSynthesizedSchedule("synth-nope")).rejects.toThrow(
      /Unknown synthesized schedule/,
    );
  });

  it("onCron fires a materialized, approved, due goal and stamps goal + record", async () => {
    const { agent, store, goal } = await materializedAgent();
    const tick = await agent.onCron();
    expect(tick.jobsCreated).toBe(1);
    expect(tick.jobsSkipped).toBe(0);
    const goals = (await agent.listGoals()) as any[];
    expect(goals.find((g) => g.id === "synth-do-fire")?.lastRun).toBeTruthy();
    const synth = (await agent.listSynthesizedSchedules()) as any[];
    expect(synth.find((r) => r.id === "synth-do-fire")?.lastRun).toBeTruthy();
    // Second tick in the same window: record is no longer due, so no re-fire.
    const tick2 = await agent.onCron();
    expect(tick2.jobsCreated).toBe(0);
  });

  it("onCron never fires a killed, halted, or orphan chain goal", async () => {
    const { agent, store, goal } = await materializedAgent("synth-do-killed");
    await agent.killSynthesizedSchedule("synth-do-killed");
    const killedTick = await agent.onCron();
    expect(killedTick.jobsCreated).toBe(0);
    expect(killedTick.jobsSkipped).toBe(1);
    expect(killedTick.errors.join(" ")).toMatch(/synth-do-killed/);
    expect(killedTick.errors.join(" ")).toMatch(/killed/);

    const { agent: agent2, store: store2, goal: goal2 } = await materializedAgent("synth-do-halted");
    const haltedTick = await agent2.onCron({ halted: true });
    expect(haltedTick.jobsCreated).toBe(0);
    expect(haltedTick.errors.join(" ")).toMatch(/halted/);

    // Orphan: a chain.execute goal with no synthesized record exists.
    const orphan: any = {
      id: "synth-orphan",
      name: "Orphan chain",
      cron: dueCron(),
      operation: "chain.execute",
      budgetCents: 100,
      enabled: true,
    };
    const { ctx: ctx4, store: store4 } = makeCtx();
    const mockD1 = new MockD1Database();
    const agent4 = new (ScheduledAgent as any)(ctx4, makeEnv(true, mockD1));
    // #6503 — the orphan goal is planted in D1 (the "goals" KV key
    // is dead); the migration-0092 seeds are swept so the tick sees
    // only the orphan.
    await plantGoal(mockD1, orphan);
    const orphanTick = await agent4.onCron();
    expect(orphanTick.jobsCreated).toBe(0);
    expect(orphanTick.jobsSkipped).toBe(1);
    expect(orphanTick.errors.join(" ")).toMatch(/no synthesized record/);
  });

  it("onCron budget rejection fires nothing and leaves the record due", async () => {
    const { agent, store, goal } = await materializedAgent("synth-do-budget", { budgetAllowed: false });
    const tick = await agent.onCron();
    expect(tick.jobsCreated).toBe(0);
    const synth = (await agent.listSynthesizedSchedules()) as any[];
    expect(synth.find((r) => r.id === "synth-do-budget")?.lastRun).toBeUndefined();
  });

  it("one-shot records fire directly, are consumed, and never become goals", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const email = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!email) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(email, { id: "synth-do-onefire" });
    await agent.approveSynthesizedSchedule("synth-do-onefire");
    const first = await agent.fireSynthesizedSchedule("synth-do-onefire");
    expect(first.fired).toBe(true);
    expect(first.jobId).toBeTruthy();
    const second = await agent.fireSynthesizedSchedule("synth-do-onefire");
    expect(second.fired).toBe(false);
    expect(second.reason).toMatch(/already fired/);
    expect((await agent.listGoals()).some((g: any) => g.id === "synth-do-onefire")).toBe(false);
    const synth = (await agent.listSynthesizedSchedules()) as any[];
    expect(synth.find((r) => r.id === "synth-do-onefire")?.firedAt).toBeTruthy();
  });

  it("direct firing refuses recurring records (they must materialize and ride onCron)", async () => {
    const { agent } = await materializedAgent("synth-do-recurring");
    // synth-do-recurring is recurring and already materialized; direct fire refuses it.
    await expect(agent.fireSynthesizedSchedule("synth-do-recurring")).rejects.toThrow(
      /materialize/,
    );
  });
});

describe("one-shot direct firing records a consolidated-ledger row (#3393)", () => {
  it("3393-P01 fired one-shot records a success row with §4 linkage joining record <-> job", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const email = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!email) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(email, { id: "synth-3393-one" });
    await agent.approveSynthesizedSchedule("synth-3393-one");
    const first = await agent.fireSynthesizedSchedule("synth-3393-one");
    expect(first.fired).toBe(true);
    expect(first.jobId).toBeTruthy();
    // Joinability: the row's scheduleId IS the record id and its
    // asyncJobId IS the created job — the ledger row joins to the
    // synthesized record and to the created job without a second hop.
    const rows = (await agent.listJobRuns("synth-3393-one")) as any[];
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.outcome).toBe("success");
    expect(row.trigger).toBe("manual");
    expect(row.triggeredBy).toBe("manual");
    expect(row.jobId).toBe("synth-3393-one");
    expect(row.operation).toBe("chain.execute");
    expect(row.scheduleId).toBe("synth-3393-one");
    expect(row.asyncJobId).toBe(first.jobId);
    expect(row.workflowId).toBeNull();
    expect(row.descriptor).toBe(`job:${first.jobId}`);
  });

  it("3393-P02 blocked re-fire records a skipped row with the reason", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const email = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!email) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(email, { id: "synth-3393-refire" });
    await agent.approveSynthesizedSchedule("synth-3393-refire");
    const first = await agent.fireSynthesizedSchedule("synth-3393-refire");
    expect(first.fired).toBe(true);
    const second = await agent.fireSynthesizedSchedule("synth-3393-refire");
    expect(second.fired).toBe(false);
    expect(second.reason).toMatch(/already fired/);
    // Two firing attempts, two rows: the success row and the
    // refusal row (newest first).
    const rows = (await agent.listJobRuns("synth-3393-refire")) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe("skipped");
    expect(rows[0].detail).toMatch(/already fired/);
    expect(rows[0].scheduleId).toBe("synth-3393-refire");
    expect(rows[0].asyncJobId).toBeNull();
    expect(rows[0].workflowId).toBeNull();
    expect(rows[1].outcome).toBe("success");
  });

  it("3393-P03 budget-rejected one-shot records a skipped row with the reason", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv(false));
    const email = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!email) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(email, { id: "synth-3393-budget" });
    await agent.approveSynthesizedSchedule("synth-3393-budget");
    const fired = await agent.fireSynthesizedSchedule("synth-3393-budget");
    expect(fired.fired).toBe(false);
    expect(fired.reason).toMatch(/budget check rejected/);
    const rows = (await agent.listJobRuns("synth-3393-budget")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("skipped");
    expect(rows[0].detail).toMatch(/budget check rejected/);
    expect(rows[0].scheduleId).toBe("synth-3393-budget");
    expect(rows[0].asyncJobId).toBeNull();
    expect(rows[0].workflowId).toBeNull();
    // A refused firing consumes nothing: the record stays unfired.
    const synth = (await agent.listSynthesizedSchedules()) as any[];
    expect(synth.find((r) => r.id === "synth-3393-budget")?.firedAt).toBeFalsy();
  });
});
