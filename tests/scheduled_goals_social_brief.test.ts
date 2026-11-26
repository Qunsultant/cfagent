/**
 * #1077 Phase 5b slice 2: the production brief comes from the durable
 * brief store. onCron reads the firing date's brief from SESSION_STORE
 * (no overrides in production); a test override still wins for tests.
 * Absent/corrupt briefs keep the existing noBrief behavior: the goal
 * stays due and retries on the next tick, never drafting, never
 * inventing content.
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
    { agent: "social", binding: "SCHEDULED_AGENT", operations: ["social.publish"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createJob } from "../src/orchestrate";

// Monday 2026-10-26 09:00 EDT = 13:00Z.
const MON_0900 = "2026-10-26T13:00:00Z";

function socialGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "daily-social-post",
    name: "Daily social post",
    cron: "0 9 * * 1-5",
    timeZone: "America/New_York",
    operation: "social.publish",
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
  };
}

function makePayments() {
  return { budgetCheck: async () => ({ allowed: true }) };
}

/** Fake SessionStore DO namespace with the real reply contract + raw access. */
function makeSessionStore() {
  const data = new Map<string, string>();
  const ops: string[] = [];
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
      ops.push(body.op);
      const mapKey = `${body.ns}:${body.key}`;
      if (body.op === "list") {
        return Response.json({ error: "list is restricted to E*TRADE token entries" }, { status: 400 });
      }
      if (body.op === "get") {
        return Response.json({ value: data.has(mapKey) ? data.get(mapKey)! : null });
      }
      if (body.op === "put") {
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
  return {
    namespace: { idFromName: () => "kv", get: () => stub },
    ops,
    rawGet: (key: string) => data.get(`social:${key}`),
    rawSet: (key: string, value: string) => void data.set(`social:${key}`, value),
    rawKeys: () => [...data.keys()],
  };
}

function makeFailingSessionStore() {
  return {
    namespace: {
      idFromName: () => "kv",
      get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
    },
  };
}

function makeEnv(sessionStore?: unknown, extra: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: { idFromName: () => "payments-default", get: () => makePayments() },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    // Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
    // environment.config.json ("threads" in production), so a bare env
    // no longer resolves the code default ["threads", "x"]. These
    // tests pin the two-autonomous-channel shape (x + threads), so
    // the list is set explicitly here.
    SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
    ...extra,
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
  vi.mocked(createJob).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onCron social brief from the durable store", () => {
  it("fires from the stored firing-date brief with no overrides, never a list op", async () => {
    const session = makeSessionStore();
    session.rawSet("social-brief:2026-10-26", JSON.stringify({ text: "Stored morning brief." }));
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(createJob).not.toHaveBeenCalled();
    expect((await agent.listGoals())[0].lastRun).toBe(new Date(MON_0900).toISOString());
    expect(session.ops).not.toContain("list");
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:x")!).status).toBe("dry-run-posted");
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:x")!).text).toBe("Stored morning brief.");
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:facebook")!).status).toBe("draft");
  });

  it("absent brief stays due with no overrides: no drafts, no lastRun", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(session.rawKeys()).toEqual([]);
  });

  it("a brief stored for another date is not used for this firing", async () => {
    const session = makeSessionStore();
    session.rawSet("social-brief:2026-10-27", JSON.stringify({ text: "Tomorrow's brief." }));
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(0);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(session.rawKeys()).toEqual(["social:social-brief:2026-10-27"]);
  });

  it("a corrupt stored brief reads as absent: stays due, never drafts", async () => {
    const session = makeSessionStore();
    session.rawSet("social-brief:2026-10-26", "not json at all");
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });

  it("a test override brief still wins over the store", async () => {
    const session = makeSessionStore();
    session.rawSet("social-brief:2026-10-26", JSON.stringify({ text: "Stored brief." }));
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Override brief.",
    });
    expect(tick.jobsCreated).toBe(1);
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:x")!).text).toBe("Override brief.");
  });

  it("a brief-store transport failure records an error and leaves the goal due", async () => {
    const failing = makeFailingSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(failing.namespace));
    const tick = await agent.onCron(makeEnv(failing.namespace));
    expect(tick.errors.some((e: string) => e.includes("daily-social-post"))).toBe(true);
    expect(tick.jobsSkipped).toBe(1);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });
});
