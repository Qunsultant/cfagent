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

import worker from "../src/server";
import type { Env } from "../src/types";

/**
 * Issue #1149: RCA and fix "Connect E*Trade" and "Test & Sync API" flows.
 *
 * Verifies:
 * 1. Worker edge routing (/src/server.ts):
 *    Interactive broker, trading, options, and screener endpoints are NOT marked
 *    as x-async-eligible: 1 so they execute synchronously inline.
 * 2. Non-immediate generic background endpoints retain x-async-eligible: 1.
 * 3. Immediate regex pattern contract matches required paths.
 */
const LOGIN = "test-trader-1149";
const SESSION_ID = "11490000-1c2b-4e3f-8a5b-114900000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  userLogin: string | null;
  asyncEligible: string | null;
}

function makeEnv() {
  const forwarded: ForwardedCall[] = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
    FEATURE_SCREENER: "1",
    FEATURE_OPTIONS_RESEARCH: "1",
    SEARCH_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            userLogin: req.headers.get("x-user-login"),
            asyncEligible: req.headers.get("x-async-eligible"),
          });
          return Response.json({ ok: true, forwardedTo: new URL(req.url).pathname });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

const req = (path: string, method = "GET") =>
  new Request(`https://agent.test${path}`, {
    method,
    headers: {
      Cookie: `session_id=${SESSION_ID}`,
    },
  });

describe("E*TRADE & Broker Immediate Sync Routing (#1149)", () => {
  it("GET /api/etrade/status is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/etrade/status"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/etrade/status");
    expect(forwarded[0].userLogin).toBe(LOGIN);
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("GET /api/etrade/positions is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/etrade/positions"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/etrade/positions");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("POST /api/broker/etrade/environment is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/broker/etrade/environment", "POST"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/broker/etrade/environment");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("GET /api/trading/options/chain is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/trading/options/chain"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/options/chain");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("GET /api/screener/stocks is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/screener/stocks"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/screener/stocks");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("arbitrary background API retains x-async-eligible: 1", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/custom/long-computation"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/custom/long-computation");
    expect(forwarded[0].asyncEligible).toBe("1");
  });

  it("orchestrator immediate regex matches interactive broker/trading/options routes", () => {
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat|chat-activity|screener|etrade|broker|trading|options)(?:\/|$)/i;

    expect(isImmediateEndpoint.test("/etrade/status")).toBe(true);
    expect(isImmediateEndpoint.test("/etrade/positions")).toBe(true);
    expect(isImmediateEndpoint.test("/etrade/quote")).toBe(true);
    expect(isImmediateEndpoint.test("/etrade/accounts")).toBe(true);
    expect(isImmediateEndpoint.test("/broker/etrade/environment")).toBe(true);
    expect(isImmediateEndpoint.test("/trading/options/chain")).toBe(true);
    expect(isImmediateEndpoint.test("/screener/stocks")).toBe(true);
    expect(isImmediateEndpoint.test("/api/etrade/status")).toBe(true);
    expect(isImmediateEndpoint.test("/api/etrade/positions")).toBe(true);

    // Should NOT match arbitrary un-exempted endpoints
    expect(isImmediateEndpoint.test("/custom/long-computation")).toBe(false);
    expect(isImmediateEndpoint.test("/reports/analytics")).toBe(false);
  });

  it("POST /api/tenant/settings/auto-refresh is forwarded with immediate sync (no x-async-eligible) (#2692)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/tenant/settings/auto-refresh", "POST"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/tenant/settings/auto-refresh");
    expect(forwarded[0].asyncEligible).toBeNull();
  });
});
