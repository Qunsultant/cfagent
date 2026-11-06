import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/browser_snapshot_auth.test.ts); routeAgentRequest returns
// null so the worker's own route dispatch runs.
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

import worker from "../src/server";
import type { Env } from "../src/types";

/**
 * Issue #312 — POST /api/chat inherits the sibling /api route posture:
 * requireAuth at the Worker edge (401 without a session), then forwarding
 * to the per-user ORCHESTRATOR_AGENT instance with the /api prefix stripped and
 * x-user-login set. It must not be queued as an async job (immediate sync).
 */
const LOGIN = "octocat-312";
const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  body: any;
  userLogin: string | null;
  asyncEligible: string | null;
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
            asyncEligible: req.headers.get("x-async-eligible"),
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

const CHAT_BODY = { messages: [{ role: "user", content: "Hello AI Assistant" }] };

describe("POST /api/chat auth + forwarding (#312)", () => {
  it("unauthenticated → 401, nothing forwarded", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/chat", { method: "POST", body: CHAT_BODY }), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("unknown session → 401, nothing forwarded", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/chat", { method: "POST", cookie: "nope", body: CHAT_BODY }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("authenticated → forwarded to the per-user instance as /chat, immediate sync", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/chat", { method: "POST", cookie: SESSION_ID, body: CHAT_BODY }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/chat");
    expect(forwarded[0].userLogin).toBe(LOGIN);
    expect(forwarded[0].body).toEqual(CHAT_BODY);
    // Immediate-sync: not marked async-eligible, so the DO answers directly
    // instead of queueing an async job.
    expect(forwarded[0].asyncEligible).toBeNull();
  });
});
