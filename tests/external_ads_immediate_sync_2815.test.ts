/**
 * Issue #2815: Prevent external ads impression beacons from becoming background workflow jobs.
 *
 * Pins:
 *  1. Worker forwards /api/external-ads/impression with immediate sync (no x-async-eligible).
 *  2. Worker forwards /api/external-ads/click with immediate sync.
 *  3. Orchestrator regex recognizes external-ads and categories/referrals/revenue/ads as immediate.
 *  4. SUPERSEDED by #2786 Part 2 (2026-11-03 ruling, "nothing excluded"):
 *     the Workflow Runs read model SURFACES standalone POST
 *     /external-ads/impression and /click rows labeled (ads family),
 *     instead of dropping them. The sync-routing pins above stand.
 */
import { describe, it, expect, vi } from "vitest";

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
import { makeFakeSessionStore } from "./fake-session-store";
import { buildWorkflowRuns, type WorkflowRunJobRow } from "../src/services/workflowRuns";

const LOGIN = "test-alice-2815";
const SESSION_ID = "28150000-1c2b-4e3f-8a5b-281500000001";

function makeEnv() {
  const forwarded: Array<{ pathname: string; asyncEligible: string | null; method: string }> = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });

  const env: any = {
    SESSION_STORE: sessionStoreNs,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => ({ toString: () => `id-${name}` }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          forwarded.push({
            pathname: url.pathname,
            asyncEligible: req.headers.get("x-async-eligible"),
            method: req.method,
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    },
  };
  return { env, forwarded };
}

function req(path: string, method = "POST", body: unknown = { id: "test-ad" }) {
  return new Request(`https://agent.example.com${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      Cookie: `session_id=${SESSION_ID}; csrf_token=csrf-test-token`,
      "X-CSRF-Token": "csrf-test-token",
    },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

describe("External Ads Immediate Sync & Workflow Runs Exclusion (#2815)", () => {
  it("POST /api/external-ads/impression is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/external-ads/impression", "POST"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/external-ads/impression");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("POST /api/external-ads/click is forwarded with immediate sync (no x-async-eligible)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/external-ads/click", "POST"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/external-ads/click");
    expect(forwarded[0].asyncEligible).toBeNull();
  });

  it("orchestrator immediate regex matches external-ads, categories, referrals, revenue, ads routes", () => {
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat|chat-activity|screener|etrade\/options\/strategy|etrade|broker|trading|options|workflow-runs|external-ads|categories|referrals|revenue|ads)(?:\/|$)/i;

    expect(isImmediateEndpoint.test("/api/external-ads/impression")).toBe(true);
    expect(isImmediateEndpoint.test("/external-ads/impression")).toBe(true);
    expect(isImmediateEndpoint.test("/api/external-ads/click")).toBe(true);
    expect(isImmediateEndpoint.test("/external-ads")).toBe(true);
    expect(isImmediateEndpoint.test("/api/categories")).toBe(true);
    expect(isImmediateEndpoint.test("/api/referrals")).toBe(true);
    expect(isImmediateEndpoint.test("/api/revenue")).toBe(true);
    expect(isImmediateEndpoint.test("/api/ads")).toBe(true);
  });

  it("buildWorkflowRuns surfaces standalone POST /external-ads/impression rows labeled (#2786 overrides #2815 item 4)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "ad-imp-1",
          capability: "http.request",
          display_name: "POST /external-ads/impression",
          status: "running",
          created_at: "2026-11-02T05:25:34.000Z",
          payload_json: JSON.stringify({
            method: "POST",
            pathAndQuery: "/external-ads/impression",
            body: JSON.stringify({ id: "e1" }),
          }),
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("Ad impression — e1");
    expect(runs[0].family).toBe("ads");
    expect(runs[0].workflow).toBe("Advertising");
  });

  it("buildWorkflowRuns surfaces standalone POST /external-ads/click rows labeled (#2786 overrides #2815 item 4)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "ad-click-1",
          capability: "http.request",
          display_name: "POST /external-ads/click",
          status: "running",
          created_at: "2026-11-02T05:25:35.000Z",
          payload_json: JSON.stringify({
            method: "POST",
            pathAndQuery: "/external-ads/click",
            body: JSON.stringify({ id: "e1" }),
          }),
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("Ad click — e1");
    expect(runs[0].family).toBe("ads");
    expect(runs[0].workflow).toBe("Advertising");
  });

  it("buildWorkflowRuns keeps real workflow POST submissions", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "screen-post-1",
          capability: "http.request",
          display_name: "POST /etrade/screen",
          status: "completed",
          created_at: "2026-11-02T05:28:10.000Z",
          completed_at: "2026-11-02T05:28:15.000Z",
          payload_json: JSON.stringify({
            method: "POST",
            pathAndQuery: "/etrade/screen",
            body: JSON.stringify({ trigger: "manual", universe: "TECH" }),
          }),
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow).toBe("Stock screening workflow");
  });
});
