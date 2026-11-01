/**
 * Issue #2681 — service-token admin routes.
 *
 * The token routes extend handleServiceUserRoutes in
 * src/agents/routes/serviceUser.ts (same gate, same audit funnel):
 * POST /api/admin/service-user/tokens (mint),
 * GET  /api/admin/service-user/tokens (list),
 * POST /api/admin/service-user/tokens/rotate,
 * POST /api/admin/service-user/tokens/revoke.
 *
 * RED FIRST: the routes do not exist yet.
 */
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

const MINT = "/api/admin/service-user/tokens";
const LIST = "/api/admin/service-user/tokens";
const ROTATE = "/api/admin/service-user/tokens/rotate";
const REVOKE = "/api/admin/service-user/tokens/revoke";

const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";
const SERVICE_LOGIN = "svc-background";
const SERVICE_ID = "service:svc-background";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

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
    membershipId: `m-platform-admin-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function platformMemberMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function tenantMemberMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function tenantAdminMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-admin-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

async function makeCtx(opts: {
  callerMemberships?: Membership[];
  serviceMemberships?: Membership[];
  aliasLogin?: string | null;
  principalKind?: string;
}): Promise<{
  ctx: ServiceUserRouteContext;
  audit: ReturnType<typeof vi.fn>;
  tokenStore: KvLike;
}> {
  const store = createMemoryMembershipStore();
  for (const m of opts.callerMemberships ?? []) await store.put(m);
  for (const m of opts.serviceMemberships ?? []) await store.put(m);
  const audit = vi.fn();
  const aliasLogin = opts.aliasLogin === undefined ? ADMIN_LOGIN : opts.aliasLogin;
  const kv = mapKv(aliasLogin ? aliasSeed(aliasLogin, ADMIN_ID) : {});
  const ctx = {
    env: {},
    audit,
    membershipStore: store,
    aliasKv: kv,
    serviceLogin: SERVICE_LOGIN,
    defaultTenantId: "primary",
    tokenStore: mapKv(),
  } as unknown as ServiceUserRouteContext;
  return { ctx, audit, tokenStore: (ctx as unknown as { tokenStore: KvLike }).tokenStore };
}

async function call(
  ctx: ServiceUserRouteContext,
  path: string,
  method: string,
  login: string | null,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (login !== null) headers["x-user-login"] = login;
  const req = new Request(`https://agent.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleServiceUserRoutes(req, new URL(`https://agent.test${path}`), path, "session-1", ctx);
  if (res === null) return { status: null, body: null as Record<string, unknown> | null };
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

describe("issue #2681: token admin routes — gate", () => {
  it("401 without a session login, 403 for a non-admin caller", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [],
      serviceMemberships: [platformMemberMembership(SERVICE_ID)],
    });
    const noLogin = await call(ctx, MINT, "POST", null, {
      label: "x",
      tier: "platform",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(noLogin.status).toBe(401);
    const nonAdmin = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "x",
      tier: "platform",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(nonAdmin.status).toBe(403);
  });

  it("403 for a token-authenticated caller: tokens never administer tokens", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceMemberships: [platformMemberMembership(SERVICE_ID)],
    });
    const res = await call(
      ctx,
      MINT,
      "POST",
      SERVICE_LOGIN,
      { label: "x", tier: "platform", roles: ["member"], expiresAtMs: NOW + 90 * DAY },
      { "x-principal-kind": "service-token" },
    );
    expect(res.status).toBe(403);
  });

  it("unknown paths still return null (no route hijack)", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceMemberships: [platformMemberMembership(SERVICE_ID)],
    });
    const res = await call(ctx, "/api/admin/service-user/tokens/unknown", "GET", ADMIN_LOGIN);
    expect(res.status).toBeNull();
  });
});

describe("issue #2681: token admin routes — lifecycle", () => {
  it("mints (201, secret once), lists metadata-only, rotates, revokes — all audited", async () => {
    const { ctx, audit } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceMemberships: [platformMemberMembership(SERVICE_ID)],
    });
    const minted = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "automation",
      tier: "platform",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(minted.status).toBe(201);
    const secret = minted.body!.secret as string;
    expect(typeof secret).toBe("string");
    expect(secret.startsWith("svc_")).toBe(true);
    const tokenId = (minted.body!.token as Record<string, unknown>).id as string;
    expect(audit).toHaveBeenCalledWith(
      "service_token.minted",
      "orchestrator",
      expect.objectContaining({ tokenId, tier: "platform" }),
    );
    expect(JSON.stringify(minted.body)).not.toContain("hash");

    const listed = await call(ctx, LIST, "GET", ADMIN_LOGIN);
    expect(listed.status).toBe(200);
    const tokens = listed.body!.tokens as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(tokenId);
    expect(tokens[0]).not.toHaveProperty("hash");
    expect(tokens[0]).not.toHaveProperty("secret");
    expect(audit.mock.calls.filter((c) => c[0] === "service_token.listed")).toHaveLength(0);

    const rotated = await call(ctx, ROTATE, "POST", ADMIN_LOGIN, {
      tokenId,
      expiresAtMs: NOW + 30 * DAY,
    });
    expect(rotated.status).toBe(200);
    const newSecret = rotated.body!.secret as string;
    expect(newSecret).not.toBe(secret);
    expect(newSecret.startsWith("svc_")).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      "service_token.rotated",
      "orchestrator",
      expect.objectContaining({ tokenId }),
    );

    const revoked = await call(ctx, REVOKE, "POST", ADMIN_LOGIN, { tokenId });
    expect(revoked.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      "service_token.revoked",
      "orchestrator",
      expect.objectContaining({ tokenId }),
    );
    const after = await call(ctx, LIST, "GET", ADMIN_LOGIN);
    const afterTokens = after.body!.tokens as Array<Record<string, unknown>>;
    expect(afterTokens[0].revokedAtMs).not.toBeNull();
  });

  it("tenant mint requires tenant-admin in that tenant (platform-admin alone is not enough)", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceMemberships: [tenantMemberMembership(SERVICE_ID, "tenant-a")],
    });
    const denied = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "t",
      tier: "tenant",
      tenantId: "tenant-a",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(denied.status).toBe(403);

    const { ctx: ctx2 } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantAdminMembership(ADMIN_ID, "tenant-a"),
      ],
      serviceMemberships: [tenantMemberMembership(SERVICE_ID, "tenant-a")],
    });
    const allowed = await call(ctx2, MINT, "POST", ADMIN_LOGIN, {
      label: "t",
      tier: "tenant",
      tenantId: "tenant-a",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(allowed.status).toBe(201);
  });

  it("400 on missing expiry, unknown role, and ungrantable role", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      serviceMemberships: [platformMemberMembership(SERVICE_ID)],
    });
    const noExpiry = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "x",
      tier: "platform",
      roles: ["member"],
    });
    expect(noExpiry.status).toBe(400);
    const badRole = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "x",
      tier: "platform",
      roles: ["superuser"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(badRole.status).toBe(400);
    const ungrantable = await call(ctx, MINT, "POST", ADMIN_LOGIN, {
      label: "x",
      tier: "tenant",
      tenantId: "tenant-a",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
    });
    expect(ungrantable.status).toBe(403);
  });
});
