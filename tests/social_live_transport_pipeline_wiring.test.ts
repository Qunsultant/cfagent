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
import { MockD1Database } from "./mock-d1";
import { makeLedgerStub } from "./ledger-stub";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";

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

// #6503 — the "goals" KV key is dead: goals live in the D1 unified
// store only (fail-closed without AGENT_DB). Fixtures plant via D1.
function makeCtx() {
  const store = new Map<string, unknown>();
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
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: new MockD1Database(),
    ORCHESTRATOR_AGENT: makeLedgerStub().namespace,
    PAYMENTS_AGENT: { idFromName: () => "payments-default", get: () => makePayments() },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    SOCIAL_LIVE_PUBLISHING: "1",
    SOCIAL_AUTONOMOUS_CHANNELS: "threads",
    THREADS_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
    ...extra,
  } as any;
}

/** Plant the pipeline goal into `mockD1`, sweeping the seeds. */
async function plantPipelineGoal(mockD1: MockD1Database) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  await store.save(goalToRecord(pipelineGoal()));
  // The first store op lazily ensures the schema, and migration
  // 0092's goals seed lands the 9 built-ins — sweep them, so the
  // tick sees ONLY the pipeline goal (same pattern as the #6503 G3
  // goals-tick file).
  for (const row of await store.listByKind("goal")) {
    if (row.id !== "social-daily-pipeline") await store.remove(row.id);
  }
}

/** One agent over a fresh D1 with the pipeline goal planted. */
async function pipelineAgent(sessionStore: unknown) {
  const env = makeEnv(sessionStore);
  await plantPipelineGoal(env.AGENT_DB as MockD1Database);
  const agent = new (ScheduledAgent as any)(makeCtx(), env);
  return { agent, env };
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
    const agent = (await pipelineAgent(session.namespace)).agent;
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
    const agent = (await pipelineAgent(session.namespace)).agent;
    const { stub } = stubThreadsFetch();
    const env = makeEnv(session.namespace, { THREADS_ACCESS_TOKEN: undefined });
    const tick = await agent.onCron(env);
    expect(stub).not.toHaveBeenCalled();
    expect(tick.errors.some((e: string) => e.includes("threads") && e.includes("missing token"))).toBe(true);
    const draft = JSON.parse(session.rawGet("social-draft:2026-10-26:threads")!);
    expect(draft.status).toBe("draft");
  });
});
