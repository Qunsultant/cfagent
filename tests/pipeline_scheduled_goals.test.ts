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

function makeCtx(initialGoals?: unknown[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
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
    ...extra,
  } as any;
}

async function seedBrief(sessionStore: unknown, date: string, text: string) {
  const briefStore = createSocialBriefStoreFromNamespace(sessionStore as any);
  await briefStore!.putBrief(date, text);
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
    const ctx = makeCtx([pipelineGoal()]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
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
    const ctx = makeCtx([pipelineGoal()]);
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors).toEqual([]);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(ss.rawKeys().filter((k) => k.includes("social-draft:"))).toEqual([]);
  });

  it("a failed pipeline run records a tick error and stays due for resume", async () => {
    const ctx = makeCtx([pipelineGoal()]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    ss.setFailBriefGets(true);
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.length).toBeGreaterThan(0);
    expect(tick.errors.join(" ")).toMatch(/brief store down/);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });

  it("re-fire after a mid-pipeline failure resumes at generate without re-reading the brief", async () => {
    const ctx = makeCtx([pipelineGoal()]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    ss.setFailDraftPuts(true);
    const budgetSpy = { calls: 0 };
    const env = makeEnv(ss.namespace, budgetSpy);
    const agent = new ScheduledAgent(ctx as any, env);
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
    const ctx = makeCtx([pipelineGoal({ lastRun: new Date(MON_0900).toISOString() })]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const env = makeEnv(ss.namespace, budgetSpy);
    const agent = new ScheduledAgent(ctx as any, env);
    // Not due (lastRun is today 09:00): a plain onCron would skip it.
    const skipped = await agent.onCron(env);
    expect(skipped.jobsCreated).toBe(0);
    const tick = await agent.triggerGoal("social-daily-pipeline", env);
    expect(tick.jobsCreated).toBe(1);
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
  });

  it("addGoal accepts pipeline:social-daily and rejects unknown pipelines", async () => {
    const ctx = makeCtx([]);
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
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
    const ctx = makeCtx([pipelineGoal({ id: "weird", operation: "pipeline:nope" })]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.join(" ")).toMatch(/unknown pipeline/);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("single-operation goals still go through createJob, untouched by the pipeline branch", async () => {
    const ctx = makeCtx([
      pipelineGoal({ enabled: false }),
      {
        id: "hunt",
        name: "Hunt",
        // No timeZone → historical UTC behavior: only the first two
        // fields are read, so "0 */6" would be never-due (the
        // preserved opportunity-hunt quirk). 13:00Z matches now.
        cron: "0 13 * * *",
        operation: "search.query",
        budgetCents: 100,
        enabled: true,
      },
    ]);
    const ss = makeSessionStore();
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(tick.jobsCreated).toBe(1);
  });

  it("does NOT rewire daily-social-post: it still runs the social.publish path", async () => {
    const ctx = makeCtx([
      {
        id: "daily-social-post",
        name: "Daily social post",
        cron: "0 9 * * 1-5",
        timeZone: "America/New_York",
        operation: "social.publish",
        budgetCents: 1,
        enabled: true,
      },
    ]);
    const ss = makeSessionStore();
    await seedBrief(ss.namespace, "2026-10-26", "Morning brief.");
    const budgetSpy = { calls: 0 };
    const agent = new ScheduledAgent(ctx as any, makeEnv(ss.namespace, budgetSpy));
    const tick = await agent.onCron(makeEnv(ss.namespace, budgetSpy));
    expect(tick.jobsCreated).toBe(1);
    expect(createJob).not.toHaveBeenCalled();
    const stores = createSocialStoresFromNamespace(ss.namespace as any)!;
    expect((await stores.ledger.getDraft("2026-10-26", "x"))?.status).toBe("dry-run-posted");
  });
});
