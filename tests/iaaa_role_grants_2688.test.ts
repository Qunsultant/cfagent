/**
 * Issue #2688 — human role-grant UI: platform-admin and tenant-admin
 * assignment (provider-agnostic). TDD Red-first.
 *
 * What this slice adds over the #1758 Members tab (which already
 * grants/revokes whole memberships for any role):
 * - A dedicated admin-grants surface: only platform-admin and
 *   tenant-admin, flattened per binding, showing who granted each
 *   role and when (grantedBy + createdAtMs) — the Members tab shows
 *   neither.
 * - Per-binding revoke: removing one admin role without revoking
 *   the whole membership (and its other bindings), effective on
 *   the next fresh PDP read.
 * - Tenant-admin reachability: the list/grant/revoke endpoints admit
 *   tenant-admins in their own tenant (the IAAA panel itself is
 *   platform-gated, so tenant-admins could previously use the
 *   routes but never reach a UI for them).
 *
 * Shared gates, unchanged: ALL_ROLES is the single catalog,
 * canGrantRole decides every grant, the route refuses self-grant,
 * and grants/revokes are audited with immediate effect. A
 * platform-admin grants platform-admin only — Slice 3 policy is
 * NOT a tenant superuser: a tenant-admin grant additionally
 * requires the granter to hold role:assign in that tenant (a
 * tenant-admin of that tenant, or a platform-admin who also holds
 * tenant-admin there), exactly as canGrantRole decides. The issue
 * body's "granted by a platform admin" shorthand does not override
 * the PDP; see docs/architecture/security/role-grants-2688.md.
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
import {
  authorize,
  createMembership,
  createMemoryMembershipStore,
  type Membership,
} from "../src/security/authorization";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { sessionStore } from "../src/security/session";
import type { Env } from "../src/types";
import {
  canRevokeRoleGrant,
  flattenRoleGrants,
  removeRoleBinding,
  ROLE_GRANT_ROLES,
  validateRoleGrantRequest,
} from "../src/security/roleGrants";

const NOW = 1_800_000_000_000;

function membership(
  id: string,
  user: string,
  tenant: string,
  bindings: Membership["roleBindings"],
  createdAtMs = NOW,
): Membership {
  return {
    membershipId: id,
    internalUserId: user,
    tenantId: tenant,
    roleBindings: bindings,
    createdBy: "test-seed",
    createdAtMs,
  };
}

describe("roleGrants pure module (#2688)", () => {
  it("derives the grantable set from ALL_ROLES: exactly the two admin roles", () => {
    expect([...ROLE_GRANT_ROLES].sort()).toEqual(["platform-admin", "tenant-admin"]);
  });

  it("flattens only admin bindings, carrying grantor and grant time", () => {
    const rows = flattenRoleGrants([
      membership("m-1", "user-a", "primary", [
        { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
        { role: "member", scope: "tenant", grantedBy: "admin-x" },
      ]),
      membership("m-2", "user-b", "primary", [
        { role: "tenant-admin", scope: "tenant", grantedBy: "admin-x" },
      ]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      grantId: "m-1:0",
      internalUserId: "user-a",
      tenantId: "primary",
      role: "platform-admin",
      grantedBy: "system:bootstrap-genesis",
      grantedAtMs: NOW,
      revoked: false,
    });
    expect(rows[1]).toMatchObject({ grantId: "m-2:0", role: "tenant-admin", grantedBy: "admin-x" });
  });

  it("marks revoked memberships revoked, not live", () => {
    const m = membership("m-9", "user-c", "primary", [
      { role: "tenant-admin", scope: "tenant", grantedBy: "admin-x" },
    ]);
    m.revokedAtMs = NOW + 1;
    expect(flattenRoleGrants([m])[0].revoked).toBe(true);
  });

  it("refuses self-grant, unknown roles, and non-admin roles at validation", () => {
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-a",
        role: "tenant-admin",
        tenantId: "primary",
        resolvedTenantId: "primary",
      }).ok,
    ).toBe(false);
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-b",
        role: "super-user",
        tenantId: "primary",
        resolvedTenantId: "primary",
      }),
    ).toMatchObject({ ok: false, code: "INVALID_ROLE" });
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-b",
        role: "member",
        tenantId: "primary",
        resolvedTenantId: "primary",
      }),
    ).toMatchObject({ ok: false, code: "ROLE_NOT_GRANTABLE" });
  });

  it("maps platform-admin to platform scope and tenant-admin to exactly one tenant", () => {
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-b",
        role: "platform-admin",
        resolvedTenantId: "primary",
      }),
    ).toMatchObject({ ok: true, scope: "platform", tenantId: "primary" });
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-b",
        role: "tenant-admin",
        tenantId: "tenant-b",
        resolvedTenantId: "primary",
      }),
    ).toMatchObject({ ok: true, scope: "tenant", tenantId: "tenant-b" });
    expect(
      validateRoleGrantRequest({
        granterInternalUserId: "user-a",
        targetInternalUserId: "user-b",
        role: "tenant-admin",
        resolvedTenantId: "primary",
      }),
    ).toMatchObject({ ok: true, scope: "tenant", tenantId: "primary" });
  });

  it("revoke gate mirrors the grant gate: cross-tenant and platform-escalation deny", async () => {
    const store = createMemoryMembershipStore();
    await createMembership(store, {
      internalUserId: "platform-1",
      tenantId: "primary",
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      createdBy: "system:bootstrap-genesis",
      nowMs: NOW,
    });
    await createMembership(store, {
      internalUserId: "tenant-1",
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
      createdBy: "platform-1",
      nowMs: NOW,
    });
    const platformGrant = flattenRoleGrants(await store.getMembershipsByUser("platform-1"))[0];
    const tenantGrant = flattenRoleGrants(await store.getMembershipsByUser("tenant-1"))[0];
    // Tenant admin cannot revoke a platform grant.
    expect(
      (await canRevokeRoleGrant(store, { revokerInternalUserId: "tenant-1", grant: platformGrant, nowMs: NOW })).decision,
    ).toBe("deny");
    // Tenant admin can revoke a tenant grant in their own tenant.
    expect(
      (await canRevokeRoleGrant(store, { revokerInternalUserId: "tenant-1", grant: tenantGrant, nowMs: NOW })).decision,
    ).toBe("allow");
    // A stranger in another tenant cannot revoke it.
    await createMembership(store, {
      internalUserId: "tenant-2",
      tenantId: "other",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
      createdBy: "platform-1",
      nowMs: NOW,
    });
    expect(
      (await canRevokeRoleGrant(store, { revokerInternalUserId: "tenant-2", grant: tenantGrant, nowMs: NOW })).decision,
    ).toBe("deny");
  });

  it("per-binding revoke preserves sibling bindings and denies immediately", async () => {
    const store = createMemoryMembershipStore();
    const created = await createMembership(store, {
      internalUserId: "user-d",
      tenantId: "primary",
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "admin-x" },
        { role: "auditor", scope: "tenant", grantedBy: "admin-x" },
      ],
      createdBy: "admin-x",
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("seed failed");
    const removed = removeRoleBinding(created.membership, 0);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error("remove failed");
    expect(removed.emptied).toBe(false);
    expect(removed.membership.roleBindings.map((b) => b.role)).toEqual(["auditor"]);
    await store.put(removed.membership);
    // The tenant-admin grant is gone on the next fresh read; the
    // auditor binding survives untouched.
    const after = await authorize(store, {
      actorInternalUserId: "user-d",
      tenantId: "primary",
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(after.decision).toBe("deny");
    const audit = await authorize(store, {
      actorInternalUserId: "user-d",
      tenantId: "primary",
      permission: "audit:read",
      nowMs: NOW,
    });
    expect(audit.decision).toBe("allow");
    // This surface refuses non-admin bindings: the surviving
    // auditor binding cannot be removed through role grants.
    expect(removeRoleBinding(removed.membership, 0)).toMatchObject({
      ok: false,
      code: "NOT_ADMIN_BINDING",
    });
    expect(removeRoleBinding(created.membership, 7).ok).toBe(false);
    // Removing the only binding of a single-admin membership
    // empties it (the caller then revokes the record).
    const solo = await createMembership(store, {
      internalUserId: "user-e",
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "admin-x" }],
      createdBy: "admin-x",
      nowMs: NOW,
    });
    if (!solo.ok) throw new Error("seed failed");
    const emptied = removeRoleBinding(solo.membership, 0);
    expect(emptied.ok).toBe(true);
    if (emptied.ok) expect(emptied.emptied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests (worker-fetch harness, same pattern as #1758)
// ---------------------------------------------------------------------------

const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a2";
const TENANT_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a1";
const OTHER_TENANT_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a5";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a3";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a4";
const PLATFORM_ID = "v1:routeplatform000000000000000000000000000000000000001";
const TENANT_ID = "v1:routetenant0000000000000000000000000000000000000001";
const OTHER_ID = "v1:routeotherten000000000000000000000000000000000000001";
const MEMBER_ID = "v1:routemember00000000000000000000000000000000000000001";
const TARGET_ID = "v1:routetarget00000000000000000000000000000000000000001";

async function makeEnv() {
  const fake = makeFakeSessionStore();
  const { namespace, seed } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string | undefined, fresh: boolean) => ({
    githubLogin: login,
    githubName: login,
    ...(internalUserId ? { internalUserId } : {}),
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    ...(fresh ? { authTimeMs: now } : {}),
  });
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID, true));
  seed("sessions", TENANT_SESSION, session("tenant-user", TENANT_ID, true));
  seed("sessions", OTHER_TENANT_SESSION, session("other-user", OTHER_ID, true));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID, true));
  seed("sessions", LEGACY_SESSION, { githubLogin: "legacy-user" });
  const env = { SESSION_STORE: namespace } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  const platform = await createMembership(membershipStore, {
    internalUserId: PLATFORM_ID,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
    createdBy: "system:bootstrap-genesis",
    nowMs: now,
  });
  const tenant = await createMembership(membershipStore, {
    internalUserId: TENANT_ID,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap-genesis" }],
    createdBy: "system:bootstrap-genesis",
    nowMs: now,
  });
  const other = await createMembership(membershipStore, {
    internalUserId: OTHER_ID,
    tenantId: "other",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap-genesis" }],
    createdBy: "system:bootstrap-genesis",
    nowMs: now,
  });
  const member = await createMembership(membershipStore, {
    internalUserId: MEMBER_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "system:bootstrap-genesis" }],
    createdBy: "system:bootstrap-genesis",
    nowMs: now,
  });
  if (!platform.ok || !tenant.ok || !other.ok || !member.ok) throw new Error("seed failed");
  return {
    env,
    membershipIds: {
      platform: platform.membership.membershipId,
      tenant: tenant.membership.membershipId,
      other: other.membership.membershipId,
      member: member.membership.membershipId,
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

describe("role-grants routes (#2688)", () => {
  it("lists admin grants for a platform admin, with grantor and grant time", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(req("GET", "/api/iaaa/role-grants", undefined, PLATFORM_SESSION), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: Array<Record<string, unknown>> };
    const roles = body.grants.map((g) => g.role).sort();
    expect(roles).toContain("platform-admin");
    expect(roles).toContain("tenant-admin");
    expect(roles).not.toContain("member");
    const platform = body.grants.find((g) => g.role === "platform-admin");
    expect(platform).toMatchObject({ grantedBy: "system:bootstrap-genesis" });
    expect(typeof platform?.grantedAtMs).toBe("number");
    expect(typeof platform?.grantId).toBe("string");
  });

  it("scopes a tenant admin's list to their own tenant and denies members", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(req("GET", "/api/iaaa/role-grants", undefined, TENANT_SESSION), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: Array<Record<string, unknown>> };
    expect(body.grants.length).toBeGreaterThan(0);
    expect(body.grants.every((g) => g.tenantId === "primary")).toBe(true);
    expect(body.grants.some((g) => g.role === "platform-admin")).toBe(false);
    const denied = await worker.fetch(req("GET", "/api/iaaa/role-grants", undefined, MEMBER_SESSION), env);
    expect(denied.status).toBe(403);
    expect((await worker.fetch(req("GET", "/api/iaaa/role-grants", undefined, LEGACY_SESSION), env)).status).toBe(403);
    expect((await worker.fetch(req("GET", "/api/iaaa/role-grants"), env)).status).toBe(401);
  });

  it("lets a platform admin grant platform-admin and refuses self-grant and non-admin roles", async () => {
    const { env } = await makeEnv();
    const grant = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "platform-admin" }, PLATFORM_SESSION),
      env,
    );
    expect(grant.status).toBe(201);
    const self = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: PLATFORM_ID, role: "platform-admin" }, PLATFORM_SESSION),
      env,
    );
    expect(self.status).toBe(403);
    expect(((await self.json()) as { code?: string }).code).toBe("SELF_GRANT");
    const nonAdmin = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "member" }, PLATFORM_SESSION),
      env,
    );
    expect(nonAdmin.status).toBe(400);
    const unknown = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "super-user" }, PLATFORM_SESSION),
      env,
    );
    expect(unknown.status).toBe(400);
  });

  it("lets a tenant admin grant tenant-admin in their own tenant only, never platform-admin", async () => {
    const { env } = await makeEnv();
    const own = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "tenant-admin", tenantId: "primary" }, TENANT_SESSION),
      env,
    );
    expect(own.status).toBe(201);
    const platform = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "platform-admin" }, TENANT_SESSION),
      env,
    );
    expect(platform.status).toBe(403);
    const cross = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "tenant-admin", tenantId: "other" }, TENANT_SESSION),
      env,
    );
    expect(cross.status).toBe(403);
    // A platform-admin alone cannot grant tenant-admin (Slice 3: not
    // a tenant superuser) — the PDP, not the UI, decides this.
    const platTenant = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "tenant-admin", tenantId: "primary" }, PLATFORM_SESSION),
      env,
    );
    expect(platTenant.status).toBe(403);
  });

  it("a fresh login via any provider has no admin rights on these routes", async () => {
    const { env } = await makeEnv();
    const denied = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "tenant-admin", tenantId: "primary" }, MEMBER_SESSION),
      env,
    );
    expect(denied.status).toBe(403);
  });

  it("revokes one binding immediately and preserves sibling bindings", async () => {
    const { env, membershipIds } = await makeEnv();
    // Tenant admin grants tenant-admin to the target (their own tenant).
    const grant = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: TARGET_ID, role: "tenant-admin", tenantId: "primary" }, TENANT_SESSION),
      env,
    );
    expect(grant.status).toBe(201);
    const granted = (await grant.json()) as { grant: { grantId: string; membershipId: string; bindingIndex: number } };
    // The new admin can immediately grant in turn (live, unrevoked).
    const second = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", { internalUserId: MEMBER_ID, role: "tenant-admin", tenantId: "primary" }, TENANT_SESSION),
      env,
    );
    expect(second.status).toBe(201);
    // Revoke the first grant; the target's next admin call denies.
    const revoke = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/revoke", { membershipId: granted.grant.membershipId, bindingIndex: granted.grant.bindingIndex }, TENANT_SESSION),
      env,
    );
    expect(revoke.status).toBe(200);
    const list = await worker.fetch(req("GET", "/api/iaaa/role-grants", undefined, TENANT_SESSION), env);
    const listed = (await list.json()) as { grants: Array<{ internalUserId: string; revoked: boolean }> };
    expect(listed.grants.find((g) => g.internalUserId === TARGET_ID)?.revoked).toBe(true);
    // Cross-tenant revoke denies.
    const cross = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/revoke", { membershipId: membershipIds.other, bindingIndex: 0 }, TENANT_SESSION),
      env,
    );
    expect(cross.status).toBe(403);
    void membershipIds;
  });
});
