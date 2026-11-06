/**
 * Issue #181: POST /api/browser/snapshot and /api/browser/transaction-snap
 * called no auth check at all — any unauthenticated caller could trigger a
 * browser capture posted to the configured Slack channel.
 *
 * Pinned here, using the same harness as
 * tests/fallback_identity_session_gate.test.ts (real worker fetch dispatch,
 * recording ORCHESTRATOR_AGENT stub, Map-backed SESSIONS KV):
 * - unauthenticated (or unknown session) → 401, no capture attempted,
 *   nothing forwarded;
 * - valid session → the route behaves exactly as before (snapshot captured
 *   via ETradeBrowserService, transaction-snap forwarded to the agent).
 */
import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/fallback_identity_session_gate.test.ts);
// routeAgentRequest returns null so the worker's own route dispatch runs.
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
  // Issue #199: src/server.ts re-exports PaymentsAgent/ScheduledAgent,
  // which `extend Agent` when the module loads — the stub must be an
  // extendable class, otherwise `extends undefined` throws at import time.
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

// Record browser captures without touching a real browser or Slack.
const browserCalls = vi.hoisted(() => [] as Array<{ url: string; opts: any }>);
vi.mock("../src/services/browserAgent", () => {
  return {
    ETradeBrowserService: class {
      env: any;
      constructor(env: any) {
        this.env = env;
      }
      async captureAndSendToSlack(url: string, opts: any) {
        browserCalls.push({ url, opts });
        return { success: true, mocked: true };
      }
    },
  };
});

import worker from "../src/server";
import type { Env } from "../src/types";

const LOGIN = "octocat-181";
const SESSION_ID = "0d9a1810-1c2b-4e3f-8a5b-181000000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  body: any;
  userLogin: string | null;
}

function makeEnv() {
  const forwarded: ForwardedCall[] = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            body: await req.json().catch(() => null),
            userLogin: req.headers.get("x-user-login"),
          });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
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

describe("browser snapshot routes require a session (#181)", () => {
  it("POST /api/browser/snapshot unauthenticated → 401, no capture attempted", async () => {
    browserCalls.length = 0;
    const { env } = makeEnv();
    const res = await worker.fetch(
      req("/api/browser/snapshot", { method: "POST", body: { url: "https://etrade.com" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(browserCalls).toHaveLength(0);
  });

  it("POST /api/browser/snapshot with an unknown session id → 401, no capture attempted", async () => {
    browserCalls.length = 0;
    const { env } = makeEnv();
    const res = await worker.fetch(
      req("/api/browser/snapshot", {
        method: "POST",
        cookie: "no-such-session",
        body: { url: "https://etrade.com" },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(browserCalls).toHaveLength(0);
  });

  it("POST /api/browser/snapshot with a valid session → capture runs as before", async () => {
    browserCalls.length = 0;
    const { env } = makeEnv();
    const res = await worker.fetch(
      req("/api/browser/snapshot", {
        method: "POST",
        cookie: SESSION_ID,
        body: { url: "https://etrade.com", caption: "daily" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, mocked: true });
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0].url).toBe("https://etrade.com");
    expect(browserCalls[0].opts.caption).toBe("daily");
  });

  it("POST /api/browser/transaction-snap unauthenticated → 401, not forwarded", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/browser/transaction-snap", {
        method: "POST",
        body: { transaction: { symbol: "AAPL" } },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/browser/transaction-snap with a valid session → forwarded as before", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/browser/transaction-snap", {
        method: "POST",
        cookie: SESSION_ID,
        body: { transaction: { symbol: "AAPL" } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/browser/transaction-snap");
  });
});
