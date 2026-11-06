import { describe, it, expect, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// Same worker-fetch harness pattern as tests/iaaa_admin_overview_route.test.ts.
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
 * #1024 Phase 1 — OpenAPI + Swagger spike routes.
 * Provisional gating (the docs-exposure design decision is still open):
 * BOTH routes require an authenticated session — unauthenticated → 401.
 * This is the safe spike default, not the final design decision.
 */
const NOW = Date.now();
const SESSION = "0d9a3120-1c2b-4e3f-8a5b-312000000009";

function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  seed("sessions", SESSION, {
    githubLogin: "spike-user",
    githubName: "Spike User",
    githubAvatar: "",
    createdAt: NOW,
    internalUserId: "33333333-3333-4333-8333-333333333333",
    providerIssuer: "https://github.com",
    providerSubject: "12345",
    authTimeMs: NOW,
    lastActivityMs: NOW,
    sessionVersion: 1,
  });
  const env: any = {
    SESSION_STORE: namespace,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    APP_NAME: "Test Agent",
    APP_BASE_URL: "https://agent.test",
    IAAA_WIRING_ENABLED: "1",
    IAAA_ENABLED_PROVIDERS: "github",
  };
  return env as Env;
}

const req = (path: string, opts: { method?: string; cookie?: string } = {}) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
    headers: opts.cookie ? { Cookie: `session_id=${opts.cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {},
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /openapi.json (spike)", () => {
  it("unauthenticated → 401", async () => {
    const res = await worker.fetch(req("/openapi.json"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("authenticated → 200 with the generated spec as JSON", async () => {
    const res = await worker.fetch(req("/openapi.json", { cookie: SESSION }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.openapi).toBe("string");
    expect((body.paths as Record<string, unknown>)["/api/me"]).toBeDefined();
  });

  it("non-GET → 405 for an authenticated session", async () => {
    const res = await worker.fetch(req("/openapi.json", { method: "POST", cookie: SESSION }), makeEnv());
    expect(res.status).toBe(405);
  });
});

describe("GET /api/docs (spike)", () => {
  it("unauthenticated → 401", async () => {
    const res = await worker.fetch(req("/api/docs"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("authenticated → 200 HTML loading Swagger UI against /openapi.json", async () => {
    const res = await worker.fetch(req("/api/docs", { cookie: SESSION }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("/openapi.json");
  });
});
