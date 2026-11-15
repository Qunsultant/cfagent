/**
 * Issue #4651 — GET /api/security/pdp: session-gated read of the PDP's
 * policy-source resolution (IAAA_PDP_POLICY_SOURCE code|snapshot +
 * invalid flag) plus the frozen obligation policy and its live
 * evaluateWithObligations() coverage.
 *
 * Worker-fetch harness (same pattern as
 * tests/permission_deny_routes_2450.test.ts): real handleFetch
 * against a fake SessionStore, seeded memberships + sessions.
 * TDD Red first: the route does not exist yet — every test below
 * fails until the slice lands.
 */
import { describe, expect, it, vi } from "vitest";
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
import { createMembership } from "../src/security/authorization";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { sessionStore } from "../src/security/session";
import { exportPolicySnapshot } from "../src/security/pdpPorts";
import type { Env } from "../src/types";

const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000d1";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000d2";
const PLATFORM_ID = "v1:pdpplatform000000000000000000000000000000000001";
const MEMBER_ID = "v1:pdpmember000000000000000000000000000000000000001";

async function makeEnv(extra: Record<string, string> = {}) {
  const fake = makeFakeSessionStore();
  const { namespace, seed } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string) => ({
    githubLogin: login,
    githubName: login,
    internalUserId,
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    authTimeMs: now,
  });
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID));
  const env = {
    SESSION_STORE: namespace,
    ...extra,
  } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  for (const [id, role, scope] of [
    [PLATFORM_ID, "platform-admin", "platform"],
    [MEMBER_ID, "member", "tenant"],
  ] as const) {
    const created = await createMembership(membershipStore, {
      internalUserId: id,
      tenantId: "primary",
      roleBindings: [{ role, scope, grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: now,
    });
    if (!created.ok) throw new Error(created.error);
  }
  return { env };
}

function req(method: string, path: string, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie
        ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" }
        : {}),
    },
  });
}

describe("GET /api/security/pdp (#4651)", () => {
  it("refuses unauthenticated callers with 401", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(req("GET", "/api/security/pdp"), env, {} as any);
    expect(res.status).toBe(401);
  });

  it("refuses non-platform callers with 403", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pdp", MEMBER_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("returns the resolved policy source and the frozen obligations for a platform admin", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pdp", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.policySource).toEqual({ source: "code", invalid: false });
    expect(body.obligations.map((o: any) => o.permission)).toEqual([
      "role:assign",
      "membership:revoke",
      "audit:export",
    ]);
    const roleAssign = body.obligations.find((o: any) => o.permission === "role:assign");
    expect(roleAssign.obligations).toEqual(["step-up", "audit-before-allow"]);
    expect(body.coverage.find((c: any) => c.permission === "role:assign").status).toBe(
      "enforced",
    );
    expect(body.coverage.find((c: any) => c.permission === "membership:revoke").status).toBe(
      "enforced",
    );
    expect(body.coverage.find((c: any) => c.permission === "audit:export").status).toBe(
      "residual",
    );
  });

  it("flags an unusable platform switch as invalid, failing closed to code", async () => {
    const { env } = await makeEnv({ IAAA_PDP_POLICY_SOURCE: "bogus" });
    const res = await worker.fetch(
      req("GET", "/api/security/pdp", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.policySource).toEqual({ source: "code", invalid: true });
  });

  it("resolves a valid snapshot switch to snapshot", async () => {
    const { env } = await makeEnv({
      IAAA_PDP_POLICY_SOURCE: "snapshot",
      IAAA_PDP_POLICY_SNAPSHOT_JSON: JSON.stringify(exportPolicySnapshot()),
    });
    const res = await worker.fetch(
      req("GET", "/api/security/pdp", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.policySource).toEqual({ source: "snapshot", invalid: false });
  });

  it("refuses non-GET methods with 405", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/security/pdp", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(405);
  });
});
