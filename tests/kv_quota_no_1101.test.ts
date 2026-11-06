import { describe, it, expect, vi } from "vitest";

// Same stand-ins as the other Worker-level suites: the agent SDKs import
// `cloudflare:workers`, which Node's ESM loader rejects. None of the routes
// under test touch them.
vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class MockAIChatAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("agents", () => ({ routeAgentRequest: async () => null, Agent: class MockAgent {} }));
vi.mock("agents/mcp", () => ({ McpAgent: class MockMcpAgent {} }));
vi.mock("agents/x402", () => ({ withX402: (cls: any) => cls }));

import worker from "../src/server";

/**
 * Issue #329 — the production failure mode.
 *
 * When the daily KV read quota ran out, `getSession` threw, nothing caught it,
 * and Cloudflare returned error 1101 for every request. This test drives the
 * real Worker handler with a KV that throws exactly that error and asserts two
 * things: the handler returns a Response instead of throwing, and the public
 * surface (health, landing) keeps working while authentication degrades.
 */
const SESSION_ID = "0d9a3290-1c2b-4e3f-8a5b-329000000001";
const QUOTA_ERROR = "KV get() limit exceeded for the day.";

function envWithExhaustedKv() {
  const kv = {
    get: async () => {
      throw new Error(QUOTA_ERROR);
    },
    put: async () => {
      throw new Error(QUOTA_ERROR);
    },
    delete: async () => {
      throw new Error(QUOTA_ERROR);
    },
  };

  return {
    ASSETS: {
      fetch: async () => new Response("<html>app</html>", { headers: { "Content-Type": "text/html" } }),
    },
    SESSIONS: kv,
    ETRADE_KV: kv,
    APP_NAME: "NextGenTP",
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
  } as any;
}

describe("KV quota exhaustion cannot become 1101 (#329)", () => {
  it("answers an authenticated route with a response, not a throw", async () => {
    const request = new Request("https://agent.openaimp.com/api/schedules", {
      headers: { Cookie: `session_id=${SESSION_ID}` },
    });

    const response = await worker.fetch(request, envWithExhaustedKv());

    // The session cannot be verified, so the route is denied — but the denial is
    // a normal HTTP response (401), never an escaped exception.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBeLessThan(500);
  });

  it("keeps the public health endpoint up while KV is failing", async () => {
    const response = await worker.fetch(new Request("https://agent.openaimp.com/health"), envWithExhaustedKv());

    expect(response.status).toBe(200);
  });

  it("still serves the landing page when the session store cannot be read", async () => {
    const response = await worker.fetch(
      new Request("https://agent.openaimp.com/", { headers: { Cookie: `session_id=${SESSION_ID}` } }),
      envWithExhaustedKv()
    );

    expect(response.status).toBe(200);
  });
});
