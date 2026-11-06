/**
 * Issue #1754 (#1717 gate-coverage audit): three Worker routes were
 * reachable with no authentication at all, and the endpoint catalog
 * listed them as public with intent unasserted:
 * - POST /api/qa/investigate (LLM spend, arbitrary failure detail)
 * - POST /api/memory/search (stored vector-memory outcomes)
 * - GET /api/options/flows/* (live flow items, news, filings)
 *
 * Pinned here with the same harness as
 * tests/browser_snapshot_auth.test.ts (real worker fetch dispatch,
 * recording ORCHESTRATOR_AGENT stub, Map-backed SESSIONS KV):
 * - unauthenticated → 401 and the downstream work never runs;
 * - valid session → the route behaves exactly as before;
 * - qa/investigate additionally accepts the dedicated service token
 *   (QA_INVESTIGATE_TOKEN, Bearer, timing-safe compare, fail-closed
 *   when unset) so the post-deploy qa-smoke script keeps its
 *   diagnosis step without a user session; a wrong or missing token
 *   without a session is 401.
 */
import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

const investigateCalls = vi.hoisted(() => [] as Array<unknown>);
vi.mock("../src/qa/investigate", () => {
  return {
    investigateQAFailure: async (_env: any, failure: unknown) => {
      investigateCalls.push(failure);
      return {
        diagnosis: "mocked diagnosis",
        likelyCause: "mocked cause",
        proposedFix: "mocked fix",
        confidence: 1,
        model: "mocked-model",
      };
    },
  };
});

const memoryCalls = vi.hoisted(() => [] as Array<unknown>);
vi.mock("../src/memory/vector-memory", () => {
  return {
    VectorMemory: class {
      constructor(..._args: Array<unknown>) {}
      async recallForPlan(query: unknown, operationFilter: unknown, topK: unknown) {
        memoryCalls.push({ query, operationFilter, topK });
        return [];
      }
    },
  };
});

import worker from "../src/server";
import type { Env } from "../src/types";

const LOGIN = "octocat-1754";
const SESSION_ID = "0d9a1754-1c2b-4e3f-8a5b-175400000001";
const QA_TOKEN = "test-qa-investigate-token-1754";

function makeEnv(extra: Record<string, unknown> = {}) {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
    AI: {},
    VECTOR_MEMORY: {},
    ...extra,
  };
  return env as Env;
}

const req = (
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

const qaBody = { operation: "check_failed", errorClass: "test", detail: "test detail" };

describe("gate-coverage audit #1754: previously ungated routes", () => {
  it("POST /api/qa/investigate unauthenticated → 401, no investigation runs", async () => {
    investigateCalls.length = 0;
    const res = await worker.fetch(req("/api/qa/investigate", { method: "POST", body: qaBody }), makeEnv());
    expect(res.status).toBe(401);
    expect(investigateCalls).toHaveLength(0);
  });

  it("POST /api/qa/investigate with a wrong service token and no session → 401", async () => {
    investigateCalls.length = 0;
    const res = await worker.fetch(
      req("/api/qa/investigate", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
        body: qaBody,
      }),
      makeEnv({ QA_INVESTIGATE_TOKEN: QA_TOKEN }),
    );
    expect(res.status).toBe(401);
    expect(investigateCalls).toHaveLength(0);
  });

  it("POST /api/qa/investigate with the service token and no session → 200, investigation runs", async () => {
    investigateCalls.length = 0;
    const res = await worker.fetch(
      req("/api/qa/investigate", {
        method: "POST",
        headers: { Authorization: `Bearer ${QA_TOKEN}` },
        body: qaBody,
      }),
      makeEnv({ QA_INVESTIGATE_TOKEN: QA_TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(investigateCalls).toHaveLength(1);
  });

  it("POST /api/qa/investigate with a valid session → 200, investigation runs as before", async () => {
    investigateCalls.length = 0;
    const res = await worker.fetch(
      req("/api/qa/investigate", { method: "POST", cookie: SESSION_ID, body: qaBody }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(investigateCalls).toHaveLength(1);
  });

  it("POST /api/memory/search unauthenticated → 401, no vector recall runs", async () => {
    memoryCalls.length = 0;
    const res = await worker.fetch(
      req("/api/memory/search", { method: "POST", body: { query: "test" } }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(memoryCalls).toHaveLength(0);
  });

  it("POST /api/memory/search with a valid session → 200, recall runs as before", async () => {
    memoryCalls.length = 0;
    const res = await worker.fetch(
      req("/api/memory/search", { method: "POST", cookie: SESSION_ID, body: { query: "test" } }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(memoryCalls).toHaveLength(1);
  });

  it("GET /api/options/flows/presets unauthenticated → 401", async () => {
    const res = await worker.fetch(req("/api/options/flows/presets"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("GET /api/options/flows/presets with a valid session → 200, presets as before", async () => {
    const res = await worker.fetch(req("/api/options/flows/presets", { cookie: SESSION_ID }), makeEnv());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success?: boolean; presets?: unknown };
    expect(data.success).toBe(true);
    expect(data.presets).toBeDefined();
  });

  it("GET /api/options/flows/live unauthenticated → 401 (before any flow work)", async () => {
    const res = await worker.fetch(req("/api/options/flows/live?tickers=AAPL"), makeEnv());
    expect(res.status).toBe(401);
  });
});
