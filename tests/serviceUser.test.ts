import { describe, it, expect, vi } from "vitest";
import {
  handleServiceUserRoutes,
  type ServiceUserRouteContext,
} from "../src/agents/routes/serviceUser";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import type { SessionData } from "../src/types";

const PROVISION = "/api/admin/service-user/provision";
const REVOKE = "/api/admin/service-user/revoke";
const STATUS = "/api/admin/service-user/status";

const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";
const SERVICE_LOGIN = "svc-background";
const SERVICE_ID = "service:svc-background";

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

function aliasSeed(login: string, internalUserId: string): Record<string, string> {
  return {
    [`${IAAA_ALIAS_KEY_PREFIX}login:${login}`]: JSON.stringify({
      githubLogin: login,
      internalUserId,
      recordedAtMs: 1,
      source: "wired-login",
    }),
  };
}

function platformAdminMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "bootstrap" },
    ],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function tenantAdminMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [
      { role: "tenant-admin", scope: "tenant", grantedBy: "bootstrap" },
    ],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

async function makeCtx(opts: {
  callerMemberships?: Membership[];
  aliasLogin?: string;
  aliasId?: string;
  serviceLogin?: string | null;
  defaultTenantId?: string;
  preexisting?: Membership[];
  /** #6259 — verified-session seam: when present, resolveActingSession returns it. */
  session?: SessionData | null;
}): Promise<{ ctx: ServiceUserRouteContext; audit: ReturnType<typeof vi.fn>; store: MembershipStore }> {
  const store = createMemoryMembershipStore();
  for (const m of opts.callerMemberships ?? []) await store.put(m);
  for (const m of opts.preexisting ?? []) await store.put(m);
  const audit = vi.fn();
  const aliasLogin = opts.aliasLogin ?? ADMIN_LOGIN;
  const aliasId = opts.aliasId ?? ADMIN_ID;
  const kv = mapKv(aliasLogin ? aliasSeed(aliasLogin, aliasId) : {});
  const ctx = {
    env: {},
    audit,
    membershipStore: store,
    aliasKv: kv,
    serviceLogin: opts.serviceLogin === undefined ? SERVICE_LOGIN : opts.serviceLogin,
    defaultTenantId: opts.defaultTenantId ?? "primary",
    ...(opts.session !== undefined ? { session: opts.session } : {}),
  } as unknown as ServiceUserRouteContext;
  return { ctx, audit, store };
}

async function call(
  ctx: ServiceUserRouteContext,
  path: string,
  method: string,
  login: string | null,
  body?: Record<string, unknown>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (login !== null) headers["x-user-login"] = login;
  const req = new Request(`https://agent.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleServiceUserRoutes(
    req,
    new URL(`https://agent.test${path}`),
    path,
    "session-1",
    ctx,
  );
  if (res === null) return { status: null, body: null };
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/admin/service-user/provision (#2331 slice 1)", () => {
  it("rejects a non-admin caller with 403 and creates nothing", async () => {
    const { ctx, audit, store } = await makeCtx({ callerMemberships: [] });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    expect(status).toBe(403);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects a missing caller login with 401", async () => {
    const { ctx } = await makeCtx({ callerMemberships: [platformAdminMembership(ADMIN_ID)] });
    const { status } = await call(ctx, PROVISION, "POST", null, { tier: "platform" });
    expect(status).toBe(401);
  });

  it("rejects a caller without a wired alias with 403", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      aliasLogin: "",
    });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    expect(status).toBe(403);
  });

  it("provisions the platform tier with a narrow member binding and audits once", async () => {
    const { ctx, audit, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    const { status, body } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    expect(status).toBe(200);
    expect(body.serviceInternalUserId).toBe(SERVICE_ID);
    expect(body.tier).toBe("platform");
    const rows = await store.getMembershipsByUser(SERVICE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].roleBindings).toEqual([
      expect.objectContaining({ role: "member", scope: "platform" }),
    ]);
    expect(rows[0].roleBindings[0].role).not.toMatch(/admin/);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe("service_user.provisioned");
  });

  it("provisions the tenant tier when the caller is also tenant-admin there", async () => {
    const { ctx, audit, store } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantAdminMembership(ADMIN_ID, "tenant-x"),
      ],
    });
    const { status, body } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, {
      tier: "tenant",
      tenantId: "tenant-x",
    });
    expect(status).toBe(200);
    expect(body.tier).toBe("tenant");
    expect(body.tenantId).toBe("tenant-x");
    const rows = await store.getMembershipsByUser(SERVICE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-x");
    expect(rows[0].roleBindings).toEqual([
      expect.objectContaining({ role: "member", scope: "tenant" }),
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("denies tenant provisioning when the caller lacks tenant-admin there", async () => {
    const { ctx, audit, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, {
      tier: "tenant",
      tenantId: "tenant-x",
    });
    expect(status).toBe(403);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects an unknown tier with 400 and creates nothing", async () => {
    const { ctx, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "global" });
    expect(status).toBe(400);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(0);
  });

  it("rejects tenant provisioning without tenantId with 400", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantAdminMembership(ADMIN_ID, "tenant-x"),
      ],
    });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "tenant" });
    expect(status).toBe(400);
  });

  it("re-provisioning the same tier is idempotent: no duplicate row, no second audit", async () => {
    const { ctx, audit, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    const { status, body } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    expect(status).toBe(200);
    expect(body.alreadyProvisioned).toBe(true);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the service login is unconfigured", async () => {
    const { ctx, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceLogin: null,
    });
    const { status } = await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    expect(status).toBe(500);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(0);
  });

  it("refuses a self-grant even if the alias points at the service id", async () => {
    const { ctx, store } = await makeCtx({
      callerMemberships: [platformAdminMembership(SERVICE_ID)],
      aliasLogin: SERVICE_LOGIN,
      aliasId: SERVICE_ID,
    });
    const { status } = await call(ctx, PROVISION, "POST", SERVICE_LOGIN, { tier: "platform" });
    expect(status).toBe(403);
    expect(await store.getMembershipsByUser(SERVICE_ID)).toHaveLength(1);
  });

  it("returns 405 for a wrong method on a matched path", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    const { status } = await call(ctx, PROVISION, "GET", ADMIN_LOGIN);
    expect(status).toBe(405);
  });

  it("returns null for an unmatched path", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
    });
    const req = new Request("https://agent.test/api/other", { method: "GET" });
    const res = await handleServiceUserRoutes(
      req,
      new URL("https://agent.test/api/other"),
      "/api/other",
      "session-1",
      ctx,
    );
    expect(res).toBeNull();
  });
});

describe("POST /api/admin/service-user/revoke (#2331 slice 1)", () => {
  async function provisioned() {
    const { ctx, audit, store } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantAdminMembership(ADMIN_ID, "tenant-x"),
      ],
    });
    await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "tenant", tenantId: "tenant-x" });
    audit.mockClear();
    return { ctx, audit, store };
  }

  it("revokes one tier and audits once", async () => {
    const { ctx, audit, store } = await provisioned();
    const { status, body } = await call(ctx, REVOKE, "POST", ADMIN_LOGIN, { tier: "tenant", tenantId: "tenant-x" });
    expect(status).toBe(200);
    expect(body.revokedCount).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe("service_user.revoked");
    const remaining = await store.getMembershipsByUser(SERVICE_ID);
    expect(remaining.filter((m) => m.revokedAtMs === undefined)).toHaveLength(1);
  });

  it("offboards all tiers when no tier is given", async () => {
    const { ctx, audit, store } = await provisioned();
    const { status, body } = await call(ctx, REVOKE, "POST", ADMIN_LOGIN, {});
    expect(status).toBe(200);
    expect(body.revokedCount).toBe(2);
    expect(audit).toHaveBeenCalledTimes(1);
    const remaining = await store.getMembershipsByUser(SERVICE_ID);
    expect(remaining.filter((m) => m.revokedAtMs === undefined)).toHaveLength(0);
  });

  it("revoking nothing is an idempotent empty result with no audit", async () => {
    const { ctx, audit } = await provisioned();
    await call(ctx, REVOKE, "POST", ADMIN_LOGIN, {});
    audit.mockClear();
    const { status, body } = await call(ctx, REVOKE, "POST", ADMIN_LOGIN, {});
    expect(status).toBe(200);
    expect(body.revokedCount).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects revoke by a non-admin with 403", async () => {
    const { ctx } = await makeCtx({ callerMemberships: [] });
    const { status } = await call(ctx, REVOKE, "POST", ADMIN_LOGIN, {});
    expect(status).toBe(403);
  });
});

describe("GET /api/admin/service-user/status (#2331 slice 1)", () => {
  it("reports provisioned tiers to a platform-admin and nothing to others", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantAdminMembership(ADMIN_ID, "tenant-x"),
      ],
    });
    await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "platform" });
    await call(ctx, PROVISION, "POST", ADMIN_LOGIN, { tier: "tenant", tenantId: "tenant-x" });
    const { status, body } = await call(ctx, STATUS, "GET", ADMIN_LOGIN);
    expect(status).toBe(200);
    expect(body.serviceUser).toBe(SERVICE_LOGIN);
    expect(body.platform).not.toBeNull();
    expect(body.tenants).toEqual(["tenant-x"]);
    const denied = await makeCtx({ callerMemberships: [] });
    const deniedRes = await call(denied.ctx, STATUS, "GET", ADMIN_LOGIN);
    expect(deniedRes.status).toBe(403);
  });
});

describe("caller identity resolution (#6259: one path, session-authoritative)", () => {
  const STALE_ID = "old-owner-id";
  const LIVE_ID = "v1:owner-derived-id";

  function liveSession(): SessionData {
    return {
      githubLogin: ADMIN_LOGIN,
      githubAvatar: "",
      githubName: "",
      createdAt: 1,
      internalUserId: LIVE_ID,
    };
  }

  function revokedPlatformAdmin(userId: string): Membership {
    return {
      membershipId: `m-revoked-${userId}`,
      internalUserId: userId,
      tenantId: "primary",
      roleBindings: [
        { role: "platform-admin", scope: "platform", grantedBy: "bootstrap" },
      ],
      createdBy: "bootstrap",
      createdAtMs: 1,
      revokedAtMs: 2,
    };
  }

  it("status resolves the caller from the verified session when the alias points at a stale id", async () => {
    // The alias still resolves the login to the retired id, whose
    // only grant is revoked; the live session carries the derived
    // id, which holds a live platform-admin grant. The Summary
    // tab reads the session id and allows; the service-user panel
    // must read the same id and allow too — not 403 with "not a
    // platform admin" and status cards that never load.
    const { ctx } = await makeCtx({
      callerMemberships: [
        revokedPlatformAdmin(STALE_ID),
        platformAdminMembership(LIVE_ID),
      ],
      aliasId: STALE_ID,
      session: liveSession(),
    });
    const { status, body } = await call(ctx, STATUS, "GET", ADMIN_LOGIN);
    expect(status).toBe(200);
    expect(body.serviceUser).toBe(SERVICE_LOGIN);
  });

  it("falls back to the alias when no session resolves (header-only callers keep today's behavior)", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [
        revokedPlatformAdmin(STALE_ID),
        platformAdminMembership(LIVE_ID),
      ],
      aliasId: STALE_ID,
      session: null,
    });
    const { status } = await call(ctx, STATUS, "GET", ADMIN_LOGIN);
    expect(status).toBe(403);
  });
});
