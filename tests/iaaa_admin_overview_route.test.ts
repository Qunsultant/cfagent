import { describe, it, expect, vi, afterEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// Same worker-fetch harness pattern as tests/iaaa_login_routes.test.ts.
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
 * #945 IAAA-UI v1 (read-only) — GET /api/iaaa/overview route gating.
 *
 * Fail-closed, server-side: unauthenticated → 401; legacy session or
 * wired non-admin → 403 with NO data; platform-admin wired session →
 * 200 with the overview shape. The route is GET-only and performs no
 * store write of any kind.
 */
const NOW = Date.now();
const ADMIN_SESSION = "0d9a3120-1c2b-4e3f-8a5b-312000000001";
const USER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-312000000002";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-312000000003";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  const wired = (internalUserId: string) => ({
    githubLogin: `user-${internalUserId.slice(0, 8)}`,
    githubName: "Test User",
    githubAvatar: "",
    createdAt: NOW,
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "12345",
    authTimeMs: NOW,
    lastActivityMs: NOW,
    sessionVersion: 1,
  });
  seed("sessions", ADMIN_SESSION, wired(ADMIN_ID));
  seed("sessions", USER_SESSION, wired(USER_ID));
  seed("sessions", LEGACY_SESSION, {
    githubLogin: "legacy-user",
    githubName: "Legacy",
    githubAvatar: "",
    createdAt: NOW,
  });
  // Membership records + per-user index (Kv membership store layout).
  seed("sessions", "iaaa-membership:m-admin-1", {
    membershipId: "m-admin-1",
    internalUserId: ADMIN_ID,
    tenantId: "primary",
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
    ],
    createdBy: "system:bootstrap-genesis",
    createdAtMs: NOW - 1000,
  });
  seed("sessions", `iaaa-membership:user:${ADMIN_ID}`, ["m-admin-1"]);
  seed("sessions", "iaaa-membership:m-user-1", {
    membershipId: "m-user-1",
    internalUserId: USER_ID,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
  });
  seed("sessions", `iaaa-membership:user:${USER_ID}`, ["m-user-1"]);
  // Audit log (single iaaa-audit:events key) + genesis marker.
  seed("sessions", "iaaa-audit:events", [
    {
      id: "evt-1",
      timestamp: NOW - 1000,
      type: "auth.login.success",
      actorPrincipalId: ADMIN_ID,
      actorType: "user",
      initiatingPrincipalId: ADMIN_ID,
      tenantId: "primary",
      correlationId: "corr-1",
      action: "auth.login",
      decision: "allow",
      policyVersion: "iaaa-1",
      outcome: "success",
      previousEventHash: null,
      eventHash: "hash-1",
    },
    {
      id: "evt-2",
      timestamp: NOW - 500,
      type: "auth.login.success",
      actorPrincipalId: USER_ID,
      actorType: "user",
      initiatingPrincipalId: USER_ID,
      tenantId: "other-tenant",
      correlationId: "corr-2",
      action: "auth.login",
      decision: "allow",
      policyVersion: "iaaa-1",
      outcome: "success",
      previousEventHash: "hash-1",
      eventHash: "hash-2",
    },
  ]);
  seed("sessions", "iaaa-bootstrap:platform-genesis:primary", JSON.stringify({ grantedTo: ADMIN_ID }));
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

describe("GET /api/iaaa/overview gating", () => {
  it("unauthenticated → 401", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("legacy session (no internalUserId) → 403, no data", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview", { cookie: LEGACY_SESSION }), makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect("memberships" in body).toBe(false);
    expect("recentAuditEvents" in body).toBe(false);
  });

  it("wired non-admin session → 403, no data", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview", { cookie: USER_SESSION }), makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect("memberships" in body).toBe(false);
    expect("recentAuditEvents" in body).toBe(false);
  });

  it("wired platform-admin session → 200 with the overview shape", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview", { cookie: ADMIN_SESSION }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.tenantId).toBe("primary");
    expect(body.callerInternalUserId).toBe(ADMIN_ID);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].roleBindings[0].role).toBe("platform-admin");
    expect(body.genesis.platformGenesisOccurred).toBe(true);
    // Only the resolved tenant's events, newest first.
    expect(body.recentAuditEvents).toHaveLength(1);
    expect(body.recentAuditEvents[0].id).toBe("evt-1");
    expect(body.recentAuditEvents[0].correlationId).toBe("corr-1");
  });

  it("non-GET → 405", async () => {
    const res = await worker.fetch(
      req("/api/iaaa/overview", { method: "POST", cookie: ADMIN_SESSION }),
      makeEnv(),
    );
    expect(res.status).toBe(405);
  });
});

describe("GET /api/iaaa/overview adminCounts (#2173)", () => {
  it("platform-admin 200 carries system-wide counts with a per-tenant breakdown summing to the total", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview", { cookie: ADMIN_SESSION }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    // Seeds: ADMIN holds platform-admin in primary; USER holds
    // tenant-admin in primary. No other memberships exist.
    expect(body.adminCounts.platformAdmins).toBe(1);
    expect(body.adminCounts.tenantAdminsTotal).toBe(1);
    expect(body.adminCounts.tenantAdminsByTenant).toEqual([{ tenantId: "primary", count: 1 }]);
    const sum = body.adminCounts.tenantAdminsByTenant.reduce(
      (acc: number, row: { count: number }) => acc + row.count,
      0,
    );
    expect(sum).toBe(body.adminCounts.tenantAdminsTotal);
    // Counts only: no member identities in the counts field.
    expect(JSON.stringify(body.adminCounts)).not.toContain(ADMIN_ID);
    expect(JSON.stringify(body.adminCounts)).not.toContain(USER_ID);
  });

  it("wired non-admin 403 carries no counts", async () => {
    const res = await worker.fetch(req("/api/iaaa/overview", { cookie: USER_SESSION }), makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect("adminCounts" in body).toBe(false);
  });
});
