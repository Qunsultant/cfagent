import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// Same worker-fetch harness pattern as tests/api_chat_auth.test.ts:
// src/server.ts re-exports agent classes whose real module graph pulls
// in `cloudflare:` protocol imports the node test loader cannot resolve.
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
 * #945 activation enabler (user-authorized): GET /api/me returns the
 * caller's OWN stable internalUserId when the session is wired, so
 * the owner can read the exact bootstrap value after a wired login.
 * The field must be absent for legacy sessions (which carry no
 * internalUserId) and for unauthenticated callers. The id is an
 * identifier, not a credential: requireAuth guarantees the session
 * belongs to the caller, and knowing the id grants nothing without
 * a login as that user plus the owner-controlled bootstrap env list.
 */
const WIRED_SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000001";
const LEGACY_SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000002";
const INTERNAL_ID = "123e4567-e89b-12d3-a456-426614174000";

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } =
    makeFakeSessionStore();
  seedSession("sessions", WIRED_SESSION_ID, {
    githubLogin: "octocat-945",
    githubName: "Octocat",
    internalUserId: INTERNAL_ID,
  });
  seedSession("sessions", LEGACY_SESSION_ID, {
    githubLogin: "octocat-legacy",
    githubName: "Legacy Cat",
  });
  // Phase 3 (#6550): IAAA_WIRING_ENABLED lives in
  // environment.config.json (ON in production), so a bare env no
  // longer means wiring is off. This test pins /api/me's
  // internalUserId echo, not wired-session validation, so wiring
  // stays off explicitly.
  const env: any = { SESSION_STORE: sessionStoreNs, IAAA_WIRING_ENABLED: "0" };
  return env as Env;
}

const req = (cookie?: string) =>
  new Request("https://agent.test/api/me", {
    headers: cookie ? { Cookie: `session_id=${cookie}` } : {},
  });

describe("GET /api/me internalUserId (#945)", () => {
  it("wired session → internalUserId present with the session's own id", async () => {
    const res = await worker.fetch(req(WIRED_SESSION_ID), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.login).toBe("octocat-945");
    expect(body.internalUserId).toBe(INTERNAL_ID);
  });

  it("legacy session → internalUserId key absent, other fields unchanged", async () => {
    const res = await worker.fetch(req(LEGACY_SESSION_ID), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.login).toBe("octocat-legacy");
    expect("internalUserId" in body).toBe(false);
  });

  it("unauthenticated → authenticated:false, no internalUserId", async () => {
    const res = await worker.fetch(req(), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
    expect("internalUserId" in body).toBe(false);
  });
});
