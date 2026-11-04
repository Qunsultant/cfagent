/**
 * Issue #2220 (program #2218, slice 2) — user administration surface.
 *
 * Server side, tested through handlePlatformUsersRoutes:
 * - GET /api/admin/platform-users/me is SELF-ONLY: the subject is
 *   always the verified session login (x-user-login). A userId
 *   query parameter or body field can never redirect it to
 *   another user; no client-supplied tenantId is read anywhere.
 * - GET /api/admin/platform-users/lookup?login=<login> is an
 *   OPERATOR read: the caller must hold a live platform-admin
 *   membership (the same gate the IAAA panel's overview route
 *   enforces server-side). Tenant admins and unwired callers
 *   get 403 with no data. Reads emit no audit events.
 * - Both views are READ-ONLY displays built from existing ports
 *   only: resolvePlatformIdentity for identity + account
 *   linkage, the IAAA membership store for memberships. No user
 *   store is invented, no IAAA state is written, no schema is
 *   ensured on a read path (an unbound store answers 503).
 * - A caller or target without a wired alias still gets its
 *   identity/account view; memberships read "unmapped" instead
 *   of invented — a missing alias is disclosed, never guessed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handlePlatformUsersRoutes,
  type PlatformUsersRouteContext,
} from "../src/agents/routes/platformUsers";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { KvLike } from "../src/security/kvResilience";

const ME = "/api/admin/platform-users/me";
const LOOKUP = "/api/admin/platform-users/lookup";

const CALLER_LOGIN = "operator-user";
const CALLER_ID = "operator-id-1";
const TARGET_LOGIN = "member-user";
const TARGET_ID = "member-id-1";

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

function tenantMemberMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 2,
  };
}

function revokedMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-revoked-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 3,
    revokedAtMs: 4,
  };
}

function memoryCommercial(
  rows: Record<string, { tenantId: string; tier: "Free" | "PayPerUse" | "Subscribed"; creditsUSD: number; includedRuns: number }>,
): CommercialStore {
  return {
    getAccount: async (userId: string) => {
      const row = rows[userId];
      if (!row) return null;
      return {
        id: `acct-${userId}`,
        tenantId: row.tenantId,
        tier: row.tier,
        creditsUSD: row.creditsUSD,
        includedRuns: row.includedRuns,
        updatedAtMs: 10,
      };
    },
  } as unknown as CommercialStore;
}

function memorySubscriptions(
  rows: Record<string, Array<{ periodEndMs: number }>>,
): SubscriptionStore {
  return {
    listSubscriptions: async (userId: string) => rows[userId] ?? [],
  } as unknown as SubscriptionStore;
}

async function makeCtx(opts: {
  callerMemberships?: Membership[];
  targetMemberships?: Membership[];
  aliasLogins?: Record<string, string>;
  commercialRows?: Parameters<typeof memoryCommercial>[0];
  subscriptionRows?: Parameters<typeof memorySubscriptions>[0];
  commercial?: CommercialStore | null;
  subscriptions?: SubscriptionStore | null;
}): Promise<{ ctx: PlatformUsersRouteContext; audit: ReturnType<typeof vi.fn>; store: MembershipStore }> {
  const store = createMemoryMembershipStore();
  for (const m of opts.callerMemberships ?? []) await store.put(m);
  for (const m of opts.targetMemberships ?? []) await store.put(m);
  const audit = vi.fn();
  const kv = mapKv(
    Object.fromEntries(
      Object.entries(opts.aliasLogins ?? {}).map(([login, id]) => {
        const seed = aliasSeed(login, id);
        return Object.entries(seed)[0];
      }),
    ),
  );
  const ctx = {
    env: {},
    audit,
    membershipStore: store,
    aliasKv: kv,
    commercial:
      opts.commercial !== undefined
        ? opts.commercial
        : memoryCommercial(opts.commercialRows ?? {}),
    subscriptions:
      opts.subscriptions !== undefined
        ? opts.subscriptions
        : memorySubscriptions(opts.subscriptionRows ?? {}),
  } as unknown as PlatformUsersRouteContext;
  return { ctx, audit, store };
}

async function call(
  ctx: PlatformUsersRouteContext,
  path: string,
  login: string | null,
  method = "GET",
) {
  const headers: Record<string, string> = {};
  if (login !== null) headers["x-user-login"] = login;
  const req = new Request(`https://agent.test${path}`, { method, headers });
  const res = await handlePlatformUsersRoutes(
    req,
    new URL(`https://agent.test${path}`),
    new URL(`https://agent.test${path}`).pathname,
    "session-1",
    ctx,
  );
  if (res === null) return { status: null, body: null as Record<string, unknown> | null };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("platform user admin routes (#2220)", () => {
  it("self view: returns the caller's identity, account linkage, and memberships", async () => {
    const { ctx, audit } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(CALLER_ID),
        tenantMemberMembership(CALLER_ID, "primary"),
        revokedMembership(CALLER_ID, "old-tenant"),
      ],
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID },
      commercialRows: {
        [CALLER_LOGIN]: { tenantId: "primary", tier: "PayPerUse", creditsUSD: 5, includedRuns: 2 },
      },
    });
    const { status, body } = await call(ctx, ME, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.userLogin).toBe(CALLER_LOGIN);
    expect(body!.tenantId).toBe("primary");
    expect(body!.hasAccount).toBe(true);
    expect(body!.tier).toBe("PayPerUse");
    expect(body!.creditsUSD).toBe(5);
    expect(body!.includedRunsRemaining).toBe(2);
    expect(body!.membershipSource).toBe("wired");
    const memberships = body!.memberships as Array<Record<string, unknown>>;
    expect(memberships.map((m) => m.membershipId)).toEqual([
      `m-platform-${CALLER_ID}`,
      `m-tenant-${CALLER_ID}-primary`,
      `m-revoked-${CALLER_ID}-old-tenant`,
    ]);
    expect(memberships[2].revokedAtMs).toBe(4);
    expect(body!.account).toEqual({
      tenantId: "primary",
      tier: "PayPerUse",
      creditsUSD: 5,
      includedRuns: 2,
      updatedAtMs: 10,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("self view: a client userId parameter can never redirect it to another user", async () => {
    const { ctx } = await makeCtx({
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID, [TARGET_LOGIN]: TARGET_ID },
      commercialRows: {
        [CALLER_LOGIN]: { tenantId: "primary", tier: "Free", creditsUSD: 0, includedRuns: 0 },
        [TARGET_LOGIN]: { tenantId: "other", tier: "Subscribed", creditsUSD: 99, includedRuns: 9 },
      },
    });
    const { status, body } = await call(ctx, `${ME}?userId=${TARGET_LOGIN}`, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.userLogin).toBe(CALLER_LOGIN);
    expect(body!.tenantId).toBe("primary");
    expect(body!.creditsUSD).toBe(0);
  });

  it("self view: no account row resolves to Free with a null tenant, not an error", async () => {
    const { ctx } = await makeCtx({
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID },
    });
    const { status, body } = await call(ctx, ME, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.hasAccount).toBe(false);
    expect(body!.tenantId).toBeNull();
    expect(body!.tier).toBe("Free");
    expect(body!.account).toBeNull();
  });

  it("self view: a caller without a wired alias still gets identity; memberships read unmapped", async () => {
    const { ctx } = await makeCtx({
      commercialRows: {
        [CALLER_LOGIN]: { tenantId: "primary", tier: "Free", creditsUSD: 1, includedRuns: 0 },
      },
    });
    const { status, body } = await call(ctx, ME, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.userLogin).toBe(CALLER_LOGIN);
    expect(body!.membershipSource).toBe("unmapped");
    expect(body!.memberships).toEqual([]);
  });

  it("self view: 401 without a verified login; 405 on POST; null on unknown paths", async () => {
    const { ctx } = await makeCtx({});
    expect((await call(ctx, ME, null)).status).toBe(401);
    expect((await call(ctx, ME, CALLER_LOGIN, "POST")).status).toBe(405);
    expect((await call(ctx, "/api/admin/platform-users/other", CALLER_LOGIN)).status).toBeNull();
  });

  it("self view: an unbound store fails closed with 503, never a guessed Free", async () => {
    const { ctx } = await makeCtx({ commercial: null, subscriptions: null });
    const { status } = await call(ctx, ME, CALLER_LOGIN);
    expect(status).toBe(503);
  });

  it("operator lookup: a platform admin reads another user's view", async () => {
    const { ctx, audit } = await makeCtx({
      callerMemberships: [platformAdminMembership(CALLER_ID)],
      targetMemberships: [tenantMemberMembership(TARGET_ID, "acme")],
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID, [TARGET_LOGIN]: TARGET_ID },
      commercialRows: {
        [TARGET_LOGIN]: { tenantId: "acme", tier: "Subscribed", creditsUSD: 0, includedRuns: 10 },
      },
      subscriptionRows: { [TARGET_LOGIN]: [{ periodEndMs: Date.now() + 86400000 }] },
    });
    const { status, body } = await call(ctx, `${LOOKUP}?login=${TARGET_LOGIN}`, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.userLogin).toBe(TARGET_LOGIN);
    expect(body!.tenantId).toBe("acme");
    expect(body!.tier).toBe("Subscribed");
    expect(body!.includedRunsRemaining).toBe(10);
    expect((body!.memberships as Array<Record<string, unknown>>).map((m) => m.tenantId)).toEqual(["acme"]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("operator lookup: tenant admins, unwired callers, and anonymous callers get 403/401 with no data", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [
        tenantMemberMembership(CALLER_ID, "primary"),
      ],
      targetMemberships: [tenantMemberMembership(TARGET_ID, "acme")],
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID, [TARGET_LOGIN]: TARGET_ID },
      commercialRows: {
        [TARGET_LOGIN]: { tenantId: "acme", tier: "Free", creditsUSD: 0, includedRuns: 0 },
      },
    });
    const tenantAdmin = await call(ctx, `${LOOKUP}?login=${TARGET_LOGIN}`, CALLER_LOGIN);
    expect(tenantAdmin.status).toBe(403);
    expect(tenantAdmin.body!.userLogin).toBeUndefined();
    const unwired = await call(ctx, `${LOOKUP}?login=${TARGET_LOGIN}`, "nobody-wired");
    expect(unwired.status).toBe(403);
    const anon = await call(ctx, `${LOOKUP}?login=${TARGET_LOGIN}`, null);
    expect(anon.status).toBe(401);
  });

  it("operator lookup: missing or malformed login is 400; the target's tenant comes from stored data, never the request", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(CALLER_ID)],
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID },
    });
    expect((await call(ctx, LOOKUP, CALLER_LOGIN)).status).toBe(400);
    expect((await call(ctx, `${LOOKUP}?login=`, CALLER_LOGIN)).status).toBe(400);
    // A tenantId parameter on the lookup is ignored: scope is the
    // target's stored record, not a client-supplied tenant.
    const { status, body } = await call(
      ctx,
      `${LOOKUP}?login=${TARGET_LOGIN}&tenantId=spoofed`,
      CALLER_LOGIN,
    );
    expect(status).toBe(200);
    expect(body!.tenantId).toBeNull();
    expect(body!.userLogin).toBe(TARGET_LOGIN);
  });

  it("operator lookup: an unmapped target still returns its account view with unmapped memberships", async () => {
    const { ctx } = await makeCtx({
      callerMemberships: [platformAdminMembership(CALLER_ID)],
      aliasLogins: { [CALLER_LOGIN]: CALLER_ID },
      commercialRows: {
        [TARGET_LOGIN]: { tenantId: "acme", tier: "Free", creditsUSD: 3, includedRuns: 0 },
      },
    });
    const { status, body } = await call(ctx, `${LOOKUP}?login=${TARGET_LOGIN}`, CALLER_LOGIN);
    expect(status).toBe(200);
    expect(body!.tenantId).toBe("acme");
    expect(body!.membershipSource).toBe("unmapped");
    expect(body!.memberships).toEqual([]);
  });
});
