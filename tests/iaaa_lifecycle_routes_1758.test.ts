/**
 * Issue #1758 (#1717 lifecycle wiring) — TDD Red-first route tests.
 *
 * Worker-fetch harness (same pattern as tests/iaaa_access_request_routes.test.ts):
 * - POST /api/iaaa/membership/grant: admin grant route (was module-only).
 * - POST /api/iaaa/membership/revoke + /edit: panel mutation actions.
 * - GET /api/iaaa/memberships: list-all (was missing from MembershipStore).
 * - POST /api/iaaa/deactivate: self-service deactivation (F-17).
 * - POST /api/iaaa/offboard: admin offboarding via the session registry —
 *   the caller never supplies session ids (F-16 bulk revocation).
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

const ADMIN_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a1";
const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a2";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a3";
const TARGET_SESSION_1 = "0d9a3120-1c2b-4e3f-8a5b-3120000000b1";
const TARGET_SESSION_2 = "0d9a3120-1c2b-4e3f-8a5b-3120000000b2";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a4";
const ADMIN_ID = "v1:routeadmin00000000000000000000000000000000000000000001";
const PLATFORM_ID = "v1:routeplatform000000000000000000000000000000000000001";
const MEMBER_ID = "v1:routemember00000000000000000000000000000000000000001";
const TARGET_ID = "v1:routetarget00000000000000000000000000000000000000001";

async function makeEnv() {
  const fake = makeFakeSessionStore();
  const { namespace, seed, store } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string | undefined, fresh: boolean) => ({
    githubLogin: login,
    githubName: login,
    ...(internalUserId ? { internalUserId } : {}),
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    ...(fresh ? { authTimeMs: now } : {}),
  });
  seed("sessions", ADMIN_SESSION, session("admin-user", ADMIN_ID, true));
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID, true));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID, true));
  seed("sessions", TARGET_SESSION_1, session("target-user", TARGET_ID, true));
  seed("sessions", TARGET_SESSION_2, session("target-user", TARGET_ID, true));
  seed("sessions", LEGACY_SESSION, { githubLogin: "legacy-user" });
  // One API key + one E*TRADE token for the target login.
  store.set(
    "api_keys:key:key-1",
    JSON.stringify({
      id: "key-1",
      login: "target-user",
      hash: "deadbeef",
      label: "target key",
      prefix: "cfk_deadbee",
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    }),
  );
  store.set("api_keys:user:target-user", JSON.stringify(["key-1"]));
  store.set("api_keys:hash:deadbeef", "key-1");
  seed("etrade", "etrade:token:TEST:target-user", {
    userLogin: "target-user",
    storedAt: new Date(now).toISOString(),
  });
  const env = { SESSION_STORE: namespace } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  const adminMembership = await createMembership(membershipStore, {
    internalUserId: ADMIN_ID,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  const platformMembership = await createMembership(membershipStore, {
    internalUserId: PLATFORM_ID,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  const memberMembership = await createMembership(membershipStore, {
    internalUserId: MEMBER_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  const targetMembership = await createMembership(membershipStore, {
    internalUserId: TARGET_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  if (!adminMembership.ok || !platformMembership.ok || !memberMembership.ok || !targetMembership.ok) {
    throw new Error("test seed failed");
  }
  return {
    env,
    fake,
    membershipIds: {
      admin: adminMembership.membership.membershipId,
      platform: platformMembership.membership.membershipId,
      member: memberMembership.membership.membershipId,
      target: targetMembership.membership.membershipId,
    },
  };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("admin grant route (#1758 F-14/F-15)", () => {
  it("grants a tenant role for a tenant-admin with fresh auth", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: "v1:newuser000000000000000000000000000000000000000000001",
        roleBindings: [{ role: "member", scope: "tenant" }],
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; membership: { internalUserId: string } };
    expect(body.ok).toBe(true);
    expect(body.membership.internalUserId).toBe(
      "v1:newuser000000000000000000000000000000000000000000001",
    );
  });

  it("refuses self-grant even for an admin", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: ADMIN_ID,
        roleBindings: [{ role: "auditor", scope: "tenant" }],
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("SELF_GRANT");
  });

  it("refuses a non-admin, a legacy session, and an unauthenticated caller", async () => {
    const { env } = await makeEnv();
    const grant = (cookie?: string) =>
      worker.fetch(
        req("POST", "/api/iaaa/membership/grant", {
          internalUserId: TARGET_ID,
          roleBindings: [{ role: "member", scope: "tenant" }],
        }, cookie),
        env,
      );
    expect((await grant()).status).toBe(401);
    expect((await grant(LEGACY_SESSION)).status).toBe(403);
    expect((await grant(MEMBER_SESSION)).status).toBe(403);
  });

  it("lets a platform-admin grant a platform role, but not a tenant role", async () => {
    const { env } = await makeEnv();
    const platformGrant = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: "v1:newplatform0000000000000000000000000000000000000001",
        roleBindings: [{ role: "platform-admin", scope: "platform" }],
      }, PLATFORM_SESSION),
      env,
    );
    expect(platformGrant.status).toBe(201);
    const tenantGrant = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: "v1:newplatform0000000000000000000000000000000000000001",
        roleBindings: [{ role: "member", scope: "tenant" }],
      }, PLATFORM_SESSION),
      env,
    );
    expect(tenantGrant.status).toBe(403);
  });
});

describe("membership revoke / edit / list (#1758 F-21)", () => {
  it("revokes a tenant membership for a tenant-admin and lists all tenant memberships", async () => {
    const { env, membershipIds } = await makeEnv();
    const list = await worker.fetch(req("GET", "/api/iaaa/memberships", undefined, ADMIN_SESSION), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { memberships: Array<{ membershipId: string }> };
    expect(listBody.memberships.some((m) => m.membershipId === membershipIds.target)).toBe(true);
    const revoke = await worker.fetch(
      req("POST", "/api/iaaa/membership/revoke", { membershipId: membershipIds.target }, ADMIN_SESSION),
      env,
    );
    expect(revoke.status).toBe(200);
    expect((await worker.fetch(req("GET", "/api/iaaa/memberships", undefined, MEMBER_SESSION), env)).status).toBe(403);
    expect(
      (await worker.fetch(
        req("POST", "/api/iaaa/membership/revoke", { membershipId: "no-such-id" }, ADMIN_SESSION),
        env,
      )).status,
    ).toBe(404);
  });

  it("edits a membership by granting the new bindings then revoking the old record", async () => {
    const { env, membershipIds } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/edit", {
        membershipId: membershipIds.target,
        roleBindings: [{ role: "auditor", scope: "tenant" }],
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; oldRevoked: boolean; membership: { roleBindings: Array<{ role: string }> } };
    expect(body.ok).toBe(true);
    expect(body.oldRevoked).toBe(true);
    expect(body.membership.roleBindings[0].role).toBe("auditor");
  });
});

describe("self-service deactivation (#1758 F-17)", () => {
  it("requires the explicit confirmation literal", async () => {
    const { env } = await makeEnv();
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/deactivate", { confirm: true }, TARGET_SESSION_1), env)).status,
    ).toBe(400);
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/deactivate", {}, TARGET_SESSION_1), env)).status,
    ).toBe(400);
  });

  it("deactivates only the caller: sessions, keys, tokens, suppression, audit, cleared cookie", async () => {
    const { env, fake } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/deactivate", { confirm: "deactivate" }, TARGET_SESSION_1),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      sessionsRevoked: string[];
      apiKeysRevoked: string[];
      mailSuppressed: boolean;
      auditEmitted: boolean;
    };
    expect(body.verified).toBe(true);
    expect(body.sessionsRevoked).toHaveLength(2);
    expect(body.apiKeysRevoked).toEqual(["key-1"]);
    expect(body.mailSuppressed).toBe(true);
    expect(body.auditEmitted).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    // Target sessions are gone from the store; the admin session survives.
    expect(fake.store.has(`sessions:${TARGET_SESSION_1}`)).toBe(false);
    expect(fake.store.has(`sessions:${TARGET_SESSION_2}`)).toBe(false);
    expect(fake.store.has(`sessions:${ADMIN_SESSION}`)).toBe(true);
    expect(fake.store.has("api_keys:key:key-1")).toBe(false);
    expect(fake.store.has("etrade:etrade:token:TEST:target-user")).toBe(false);
    expect(fake.store.has(`sessions:iaaa-mail-suppression:${TARGET_ID}`)).toBe(true);
    const auditRaw = fake.store.get("sessions:iaaa-audit:events");
    expect(auditRaw).toBeTruthy();
    const events = JSON.parse(auditRaw as string) as Array<{ action: string }>;
    expect(events.some((e) => e.action === "iaaa.deactivate")).toBe(true);
  });

  it("refuses legacy sessions and unauthenticated callers", async () => {
    const { env } = await makeEnv();
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/deactivate", { confirm: "deactivate" }, LEGACY_SESSION), env)).status,
    ).toBe(403);
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/deactivate", { confirm: "deactivate" }), env)).status,
    ).toBe(401);
  });
});

describe("admin offboarding via the session registry (#1758 F-16)", () => {
  it("revokes sessions the caller never listed, plus keys and tokens", async () => {
    const { env, fake } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/offboard", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      sessionsRevoked: string[];
      membershipsRevoked: string[];
    };
    expect(body.verified).toBe(true);
    expect(body.sessionsRevoked).toHaveLength(2);
    expect(body.membershipsRevoked).toHaveLength(1);
    expect(fake.store.has(`sessions:${TARGET_SESSION_1}`)).toBe(false);
    expect(fake.store.has(`sessions:${TARGET_SESSION_2}`)).toBe(false);
    expect(fake.store.has(`sessions:${ADMIN_SESSION}`)).toBe(true);
  });

  it("refuses non-admins and unauthenticated callers", async () => {
    const { env } = await makeEnv();
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/offboard", { internalUserId: TARGET_ID }, MEMBER_SESSION), env)).status,
    ).toBe(403);
    expect(
      (await worker.fetch(req("POST", "/api/iaaa/offboard", { internalUserId: TARGET_ID }), env)).status,
    ).toBe(401);
  });
});
