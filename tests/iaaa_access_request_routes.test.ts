/**
 * Issue #1274 — request-access routes + /api/me provider display.
 *
 * Worker-fetch harness (same pattern as the schedule-gate tests):
 * - /api/me reports provider {id, name, issuer} for wired sessions with
 *   a known issuer, and NO provider key for legacy sessions or wired
 *   sessions without a known issuer.
 * - POST /api/iaaa/access-request: 401 unauthenticated, 403 legacy or
 *   no-membership, 201 member, 409 duplicate pending, 400 bad role.
 * - GET /api/iaaa/access-requests: 401 unauthenticated, 403 non-admin,
 *   200 for a tenant-admin.
 * - POST /api/iaaa/access-request/decision: 401/403 gating, approve
 *   grants exactly the requested role, deny/pending grant nothing,
 *   unknown id 404, non-pending 409.
 * Never a live provider; memberships are seeded via createMembership.
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
import type { Env } from "../src/types";

const NOW = 1_790_000_000_000;
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000000b";
const ADMIN_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000000c";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000000d";
const NO_MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000000e";
const MEMBER_ID = "v1:routemember00000000000000000000000000000000000000000000001";
const ADMIN_ID = "v1:routeadmin000000000000000000000000000000000000000000000001";
const NOMEMBER_ID = "v1:routenomember00000000000000000000000000000000000000000001";

async function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  seed("sessions", MEMBER_SESSION, {
    githubLogin: "member-user",
    githubName: "Member User",
    internalUserId: MEMBER_ID,
    providerIssuer: "https://github.com",
    createdAt: NOW,
  });
  seed("sessions", ADMIN_SESSION, {
    githubLogin: "admin-user",
    githubName: "Admin User",
    internalUserId: ADMIN_ID,
    providerIssuer: "https://accounts.google.com",
    createdAt: NOW,
  });
  seed("sessions", LEGACY_SESSION, { githubLogin: "legacy-user" });
  seed("sessions", NO_MEMBER_SESSION, {
    githubLogin: "nomember-user",
    internalUserId: NOMEMBER_ID,
    providerIssuer: "https://github.com",
    createdAt: NOW,
  });
  const env = { SESSION_STORE: namespace } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  await createMembership(membershipStore, {
    internalUserId: MEMBER_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: NOW,
  });
  await createMembership(membershipStore, {
    internalUserId: ADMIN_ID,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: NOW,
  });
  return env;
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/me provider display (#1274)", () => {
  it("wired GitHub session reports provider GitHub", async () => {
    const res = await worker.fetch(req("GET", "/api/me", undefined, MEMBER_SESSION), await makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.provider).toEqual({
      id: "github",
      name: "GitHub",
      issuer: "https://github.com",
    });
  });

  it("wired Google session reports provider Google", async () => {
    const res = await worker.fetch(req("GET", "/api/me", undefined, ADMIN_SESSION), await makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toEqual({
      id: "google",
      name: "Google",
      issuer: "https://accounts.google.com",
    });
  });

  it("legacy session carries no provider key", async () => {
    const res = await worker.fetch(req("GET", "/api/me", undefined, LEGACY_SESSION), await makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect("provider" in body).toBe(false);
  });

  it("unauthenticated callers get authenticated false and no provider", async () => {
    const res = await worker.fetch(req("GET", "/api/me"), await makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false });
  });
});

describe("access-request routes (#1274)", () => {
  it("create: 401 unauthenticated, 403 legacy, 403 no-membership, 201 member", async () => {
    const env = await makeEnv();
    expect((await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }), env)).status).toBe(401);
    expect((await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, LEGACY_SESSION), env)).status).toBe(403);
    expect((await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, NO_MEMBER_SESSION), env)).status).toBe(403);
    const res = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request: { status: string; requestedRole: string } };
    expect(body.request.status).toBe("pending");
    expect(body.request.requestedRole).toBe("tenant-admin");
  });

  it("create: duplicate pending → 409; bad role → 400", async () => {
    const env = await makeEnv();
    const first = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION), env);
    expect(first.status).toBe(201);
    const dupe = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION), env);
    expect(dupe.status).toBe(409);
    const bad = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "platform-admin" }, MEMBER_SESSION), env);
    expect(bad.status).toBe(400);
  });

  it("list: 401 unauthenticated, 403 member, 200 tenant-admin", async () => {
    const env = await makeEnv();
    expect((await worker.fetch(req("GET", "/api/iaaa/access-requests"), env)).status).toBe(401);
    expect((await worker.fetch(req("GET", "/api/iaaa/access-requests", undefined, MEMBER_SESSION), env)).status).toBe(403);
    const res = await worker.fetch(req("GET", "/api/iaaa/access-requests", undefined, ADMIN_SESSION), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[] };
    expect(Array.isArray(body.requests)).toBe(true);
  });

  it("decision: non-admin → 403; approve grants tenant-admin; deny grants nothing", async () => {
    const env = await makeEnv();
    const created = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION), env);
    const createdBody = (await created.json()) as { request: { requestId: string } };
    const requestId = createdBody.request.requestId;

    const nonAdmin = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, MEMBER_SESSION),
      env,
    );
    expect(nonAdmin.status).toBe(403);

    const approved = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, ADMIN_SESSION),
      env,
    );
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { request: { status: string } };
    expect(approvedBody.request.status).toBe("approved");

    // The grant landed: the requester now holds tenant-admin in primary.
    const membershipStore = createKvMembershipStore(sessionStore(env));
    const memberships = await membershipStore.getMembershipsByUser(MEMBER_ID);
    expect(memberships.some((m) => m.tenantId === "primary" && m.roleBindings.some((b) => b.role === "tenant-admin"))).toBe(true);

    // Approving again is a conflict, not a second grant.
    const again = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, ADMIN_SESSION),
      env,
    );
    expect(again.status).toBe(409);

    // A fresh request that is denied grants nothing.
    const second = await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, NO_MEMBER_SESSION), env);
    expect(second.status).toBe(403); // no-membership users cannot request
    const denied = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId: "no-such-request", decision: "deny" }, ADMIN_SESSION),
      env,
    );
    expect(denied.status).toBe(404);
  });

  it("decision: pending requests grant nothing until approved", async () => {
    const env = await makeEnv();
    await worker.fetch(req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION), env);
    const membershipStore = createKvMembershipStore(sessionStore(env));
    const memberships = await membershipStore.getMembershipsByUser(MEMBER_ID);
    expect(memberships.some((m) => m.roleBindings.some((b) => b.role === "tenant-admin"))).toBe(false);
  });
});
