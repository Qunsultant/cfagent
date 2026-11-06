/**
 * #1250 (rebase onto post-#1224 main) — pipeline-branch live-transport
 * wiring for the production executor.
 *
 * Pinned here:
 * - a pipeline:social-daily firing with NO injected transport resolves
 *   the fetch transport, so a live publish in production reaches a
 *   platform endpoint (stubbed global fetch here; no real network,
 *   placeholder token) — the Threads two-step sequence, exactly as
 *   the social.publish wiring test pins it;
 * - live without a token errors and never touches fetch (the
 *   per-channel error is recorded as a tick error, mirroring the
 *   social.publish path; the run still completes with errors).
 *
 * Modeled on tests/pipeline_scheduled_goals.test.ts (pipeline goal
 * via onCron, SessionStore stub, brief for the firing date) combined
 * with tests/social_live_transport_wiring.test.ts (stubbed global
 * fetch, placeholder token).
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
import { createSocialBriefStoreFromNamespace } from "../src/agents/social/briefStore";

// Monday 2026-10-26 09:00 EDT = 13:00Z.
const MON_0900 = "2026-10-26T13:00:00Z";
const PLACEHOLDER_TOKEN = "test-placeholder-token";

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

async function seedBrief(sessionStore: unknown, date: string, text: string) {
  const briefStore = createSocialBriefStoreFromNamespace(sessionStore as any);
  await briefStore!.putBrief(date, text);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onCron pipeline-branch live-transport wiring", () => {
  it("resolves the fetch transport when no transport is injected, and posts live", async () => {
    const session = makeSessionStore();
    await seedBrief(session.namespace, "2026-10-26", "Pipeline brief.");
    const agent = new (ScheduledAgent as any)(makeCtx([pipelineGoal()]), makeEnv(session.namespace));
    const { stub, calls } = stubThreadsFetch();
    const tick = await agent.onCron(makeEnv(session.namespace));
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(stub).toHaveBeenCalled();
    expect(calls[0].url).toBe("https://graph.threads.net/v1.0/me/threads");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PLACEHOLDER_TOKEN}`);
    expect(calls).toHaveLength(2);
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("posted");
    expect(draft.platformPostId).toBe("post-9");
  });

  it("live without a token errors and never touches fetch", async () => {
    const session = makeSessionStore();
    await seedBrief(session.namespace, "2026-10-26", "Pipeline brief.");
    const agent = new (ScheduledAgent as any)(makeCtx([pipelineGoal()]), makeEnv(session.namespace));
    const { stub } = stubThreadsFetch();
    const env = makeEnv(session.namespace, { THREADS_ACCESS_TOKEN: undefined });
    const tick = await agent.onCron(env);
    expect(stub).not.toHaveBeenCalled();
    expect(tick.errors.some((e: string) => e.includes("threads") && e.includes("missing token"))).toBe(true);
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("draft");
  });
});
