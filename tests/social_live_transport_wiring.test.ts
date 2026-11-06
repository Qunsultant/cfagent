/**
 * #1250 — production executor wiring for the live transport.
 *
 * Pinned here:
 * - onCron with NO injected transport resolves the fetch transport,
 *   so a live publish in production reaches a platform endpoint
 *   (stubbed global fetch here; no real network, placeholder token);
 * - an injected transport still wins over fetch (test paths keep
 *   their fakes; production never receives a fake);
 * - live without a token errors and never falls back to dry-run or
 *   fetch; posting disabled never touches fetch;
 * - the manual triggerGoal path (the real-post test path) resolves
 *   the fetch transport too, since triggerGoal calls onCron with no
 *   overrides.
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
    { agent: "social", binding: "SCHEDULED_AGENT", operations: ["social.publish"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createSessionStoreSocialBriefStore } from "../src/agents/social/briefStore";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";

// Monday 2026-10-26 09:00 EDT = 13:00Z.
const MON_0900 = "2026-10-26T13:00:00Z";
const PLACEHOLDER_TOKEN = "test-placeholder-token";

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
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
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
    rawGet: (key: string) => data.get(`social:${key}`),
  };
}

function makeEnv(sessionStore: unknown, extra: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: { idFromName: () => "payments-default", get: () => makePayments() },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    SOCIAL_LIVE_PUBLISHING: "1",
    SOCIAL_AUTONOMOUS_CHANNELS: "threads",
    THREADS_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
    ...extra,
  } as any;
}

/** Global fetch stub answering the Threads two-step sequence. */
function stubThreadsFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const stub = vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const payload = url.includes("threads_publish") ? { id: "post-9" } : { id: "container-1" };
    return { status: 200, text: async () => JSON.stringify(payload) };
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onCron live-transport wiring", () => {
  it("resolves the fetch transport when no transport is injected, and posts live", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const { stub, calls } = stubThreadsFetch();
    const sink = createMemoryDryRunSink();
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Test brief.",
      socialDryRunSink: sink,
    });
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(stub).toHaveBeenCalled();
    expect(calls[0].url).toBe("https://graph.threads.net/v1.0/me/threads");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PLACEHOLDER_TOKEN}`);
    expect(calls).toHaveLength(2);
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("posted");
    expect(draft.platformPostId).toBe("post-9");
    expect(sink.records).toEqual([]);
  });

  it("prefers an injected transport over fetch", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const { stub } = stubThreadsFetch();
    const injected = {
      post: async () => ({ status: 200, body: { id: "fake-1" } }),
    };
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Test brief.",
      socialTransport: injected,
    });
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(stub).not.toHaveBeenCalled();
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("posted");
    expect(draft.platformPostId).toBe("fake-1");
  });

  it("live without a token errors and never falls back to dry-run or fetch", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const { stub } = stubThreadsFetch();
    const sink = createMemoryDryRunSink();
    const env = makeEnv(session.namespace, { THREADS_ACCESS_TOKEN: undefined });
    const tick = await agent.onCron(env, {
      socialBriefProvider: () => "Test brief.",
      socialDryRunSink: sink,
    });
    expect(stub).not.toHaveBeenCalled();
    expect(sink.records).toEqual([]);
    expect(tick.errors.some((e: string) => e.includes("threads") && e.includes("missing token"))).toBe(true);
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("draft");
  });

  it("posting disabled never touches fetch", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const { stub } = stubThreadsFetch();
    const env = makeEnv(session.namespace, { SOCIAL_POSTING_ENABLED: undefined });
    const tick = await agent.onCron(env, { socialBriefProvider: () => "Test brief." });
    expect(stub).not.toHaveBeenCalled();
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
  });

  it("manual triggerGoal resolves the fetch transport too (no overrides)", async () => {
    const session = makeSessionStore();
    const briefStore = createSessionStoreSocialBriefStore(session.namespace.get("kv") as never);
    await briefStore.putBrief("2026-10-26", "Trigger brief.");
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const { stub, calls } = stubThreadsFetch();
    const tick = await agent.triggerGoal("daily-social-post", makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(stub).toHaveBeenCalled();
    expect(calls[0].url).toBe("https://graph.threads.net/v1.0/me/threads");
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("posted");
    expect(draft.platformPostId).toBe("post-9");
  });
});
