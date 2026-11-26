/**
 * #1224 — pipeline goals at the ScheduledAgent level.
 *
 * A goal whose operation names a pipeline (pipeline:social-daily)
 * runs ordered stages back-to-back in ONE firing through the
 * pipeline executor — not the single-operation path. One budget
 * check covers the whole pipeline; one tick entry records it.
 * Manual triggerGoal runs the full pipeline the same way as a cron
 * firing. The existing daily-social-post goal (social.publish) and
 * single-operation goals are unchanged.
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
    { agent: "search", binding: "ORCHESTRATOR_AGENT", operations: ["search.query"], blurb: "" },
    {
      agent: "social",
      binding: "SCHEDULED_AGENT",
      operations: ["social.publish", "pipeline:social-daily"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createJob } from "../src/orchestrate";
import { createSocialBriefStoreFromNamespace } from "../src/agents/social/briefStore";
import { createSocialStoresFromNamespace } from "../src/agents/social/durableStores";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";

// Monday 2026-10-26 09:00 EDT = 13:00Z.
const MON_0900 = "2026-10-26T13:00:00Z";

function pipelineGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "social-daily-pipeline",
    name: "Social daily pipeline",
    cron: "0 9 * * 1-5",
    timeZone: "America/New_York",
    operation: "pipeline:social-daily",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

// #6503 — the "goals" KV key is dead: goals live in the D1 unified
// store only (fail-closed without AGENT_DB). Fixtures plant via D1.
function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _goals: store,
  };
}

/** Fake SessionStore DO namespace with the real reply contract + raw access + op counts. */
function makeSessionStore() {
  const data = new Map<string, string>();
  const gets = new Map<string, number>();
  let failDraftPuts = false;
  let failBriefGets = false;
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
      const mapKey = `${body.ns}:${body.key}`;
      if (body.op === "get") {
        gets.set(mapKey, (gets.get(mapKey) ?? 0) + 1);
        if (failBriefGets && body.key.startsWith("social-brief:")) {
          throw new Error("brief store down");
        }
        return Response.json({ value: data.has(mapKey) ? data.get(mapKey)! : null });
      }
      if (body.op === "put") {
        if (failDraftPuts && body.key.startsWith("social-draft:")) {
          throw new Error("draft store down");
        }
        data.set(mapKey, body.value!);
        return Response.json({ ok: true });
      }
      if (body.op === "delete") {
        data.delete(mapKey);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  };
  const namespace = { idFromName: () => "kv", get: () => stub };
  return {
    namespace,
    getCount: (key: string) => gets.get(`social:${key}`) ?? 0,
    rawGet: (key: string) => data.get(`social:${key}`),
    rawKeys: () => [...data.keys()],
    setFailDraftPuts: (v: boolean) => void (failDraftPuts = v),
    setFailBriefGets: (v: boolean) => void (failBriefGets = v),
  };
}

function makeEnv(sessionStore: unknown, budgetSpy: { calls: number }, extra: Record<string, unknown> = {}) {
  return {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => {
          budgetSpy.calls++;
          return { allowed: true };
        },
      }),
    },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    // Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
    // environment.config.json ("threads" in production), so a bare env
    // no longer resolves the code default ["threads", "x"]. This
    // pipeline pins the two-autonomous-channel shape (x + threads),
    // so the list is set explicitly here.
    SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
    ...extra,
  } as any;
}

async function seedBrief(sessionStore: unknown, date: string, text: string) {
  const briefStore = createSocialBriefStoreFromNamespace(sessionStore as any);
  await briefStore!.putBrief(date, text);
}

/** Plant `goals` into `mockD1`, sweeping migration-0092's seeds. */
async function plantGoals(mockD1: MockD1Database, goals: any[]) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  for (const goal of goals) await store.save(goalToRecord(goal));
  // The first store op lazily ensures the schema, and migration
  // 0092's goals seed lands the 9 built-in goals — sweep them, so
  // the tick sees ONLY the fixture goals (same pattern as the
  // #6503 G3 goals-tick file).
  const keep = new Set(goals.map((goal) => String(goal.id)));
  for (const row of await store.listByKind("goal")) {
    if (!keep.has(row.id)) await store.remove(row.id);
  }
}

/** One agent over a fresh D1 with `goals` planted. */
async function plantedAgent(
  goals: any[],
  ss: ReturnType<typeof makeSessionStore>,
  budgetSpy: { calls: number },
) {
  const env = makeEnv(ss.namespace, budgetSpy);
  await plantGoals(env.AGENT_DB as MockD1Database, goals);
  const agent = new ScheduledAgent(makeCtx() as any, env);
  return { agent, env };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
  vi.mocked(createJob).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pipeline goals through ScheduledAgent", () => {
  it("runs the full pipeline in one firing: one budget check, one tick, lastRun set", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent([pipelineGoal()], ss, budgetSpy);
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(budgetSpy.calls).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.jobsSkipped).toBe(0);
    expect(tick.errors).toEqual([]);
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBe(new Date(MON_0900).toISOString());
    const history = await agent.getTickHistory();
    expect(history).toHaveLength(1);
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
    expect((await stores.ledger.getDraft("2026-10-26", "facebook"))?.status).toBe("draft");
  });

  it("noBrief pipeline run is skipped, lastRun untouched, goal stays due", async () => {
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent([pipelineGoal()], ss, budgetSpy);
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors).toEqual([]);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(ss.rawKeys().filter((k) => k.includes("social-draft:"))).toEqual([]);
  });

  it("a failed pipeline run records a tick error and stays due for resume", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    ss.setFailBriefGets(true);
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent([pipelineGoal()], ss, budgetSpy);
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.length).toBeGreaterThan(0);
    expect(tick.errors.join(" ")).toMatch(/brief store down/);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });

  it("re-fire after a mid-pipeline failure resumes at generate without re-reading the brief", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    ss.setFailDraftPuts(true);
    const budgetSpy = { calls: 0 };
    const { agent, env } = await plantedAgent([pipelineGoal()], ss, budgetSpy);
    const first = await agent.onCron(env);
    expect(first.jobsCreated).toBe(0);
    expect(first.errors.length).toBeGreaterThan(0);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    // Feed ran once (one brief get); generate failed on draft puts.
    expect(ss.getCount("social-brief:2026-10-26")).toBe(1);
    ss.setFailDraftPuts(false);
    const second = await agent.onCron(env);
    expect(second.jobsCreated).toBe(1);
    expect(second.errors).toEqual([]);
    // Resume did NOT re-run feed: still exactly one brief read.
    expect(ss.getCount("social-brief:2026-10-26")).toBe(1);
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
    expect((await stores.ledger.getDraft("2026-10-26", "facebook"))?.status).toBe("draft");
  });

  it("manual triggerGoal runs the full pipeline the same way as a cron firing", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const { agent, env } = await plantedAgent(
      [pipelineGoal({ lastRun: new Date(MON_0900).toISOString() })],
      ss,
      budgetSpy,
    );
    // Not due (lastRun is today 09:00): a plain onCron would skip it.
    const skipped = await agent.onCron(env);
    expect(skipped.jobsCreated).toBe(0);
    const tick = await agent.triggerGoal("social-daily-pipeline", env);
    expect(tick.jobsCreated).toBe(1);
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
  });

  it("addGoal accepts pipeline:social-daily and rejects unknown pipelines", async () => {
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    // #6503 — no fixture goal to plant: addGoal loads the D1 store
    // (migration-0092's nine built-ins) and appends.
    const agent = new ScheduledAgent(makeCtx() as any, makeEnv(ss.namespace, budgetSpy));
    const created = await agent.addGoal({
      id: "my-pipeline",
      name: "My pipeline",
      cron: "0 9 * * 1-5",
      operation: "pipeline:social-daily",
      budgetCents: 1,
      timeZone: "America/New_York",
    });
    expect(created.operation).toBe("pipeline:social-daily");
    await expect(
      agent.addGoal({
        id: "bad-pipeline",
        name: "Bad pipeline",
        cron: "0 9 * * 1-5",
        operation: "pipeline:unknown",
        budgetCents: 1,
      }),
    ).rejects.toThrow(/Unknown operation/);
  });

  it("an unknown pipeline operation seeded directly fails closed without createJob", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent(
      [pipelineGoal({ id: "weird", operation: "pipeline:nope" })],
      ss,
      budgetSpy,
    );
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/unknown pipeline/);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("single-operation goals still go through createJob, untouched by the pipeline branch", async () => {
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent(
      [
        pipelineGoal({ enabled: false }),
        {
          id: "hunt",
        name: "Hunt",
        // No timeZone → UTC read of all five fields (#4235). 13:00Z
        // matches now.
        cron: "0 13 * * *",
        operation: "search.query",
        budgetCents: 100,
        enabled: true,
      },
      ],
      ss,
      budgetSpy,
    );
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(tick.jobsCreated).toBe(1);
  });

  it("does NOT rewire daily-social-post: it still runs the social.publish path", async () => {
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const { agent } = await plantedAgent(
      [
      {
        id: "daily-social-post",
        name: "Daily social post",
        cron: "0 9 * * 1-5",
        timeZone: "America/New_York",
        operation: "social.publish",
        budgetCents: 1,
        enabled: true,
      },
      ],
      ss,
      budgetSpy,
    );
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(1);
    expect(createJob).not.toHaveBeenCalled();
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
  });

  it("a run whose record does not land is a tick error, not a silent success (issue 6293)", async () => {
    // The firing itself succeeds; only the legacy "jobRunRecords" KV
    // write fails (the ledger post is absent in this env, so the KV
    // key is the only home). Before the fix the tick said jobsCreated
    // 1 with no error and no row anywhere — the trigger looked like
    // a success while the ledger showed nothing.
    const store = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => {
          if (k === "jobRunRecords") throw new Error("record store down");
          void store.set(k, v);
        },
      },
      _goals: store,
    };
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    // #6503 — the goal is planted in D1 (the "goals" KV key is dead);
    // the failing write is the ctx.storage "jobRunRecords" put below.
    const env = makeEnv(ss.namespace, budgetSpy);
    await plantGoals(env.AGENT_DB as MockD1Database, [pipelineGoal()]);
    const agent = new ScheduledAgent(ctx as any, env);
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/run record did not land/);
  });
});
