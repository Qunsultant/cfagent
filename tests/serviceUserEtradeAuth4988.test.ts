import { describe, it, expect, vi, beforeEach } from "vitest";
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
import type { Env, SessionData } from "../src/types";
import {
  etradeIdentityFromLogin,
  getRequestTokenSecret,
  getStoredTokens,
  getValidTokens,
  renewAllStoredETradeTokens,
  storeAccessTokens,
  storeRequestTokenSecret,
} from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { makeFakeSessionStore } from "./fake-session-store";

/**
 * #4988 (#945 Q10) — service-login E*TRADE authorization, option 1.
 *
 * RED FIRST: the routes under test do not exist yet. Every test here
 * names the slice acceptance it pins:
 * - start refused for non-admin / stale step-up / PDP-denied, nothing written;
 * - exchange stores under the service login only (login + internal-id keys),
 *   the owner's keys unchanged, checklist brokerage item turns pass;
 * - a tampered (client-supplied) login cannot redirect the token;
 * - a background context resolves the service token with no live session;
 * - revoke deletes only the service login's key set;
 * - the renewal pass covers the service login's token;
 * - start / complete / revoke each emit an audit event with actor + target.
 */

const START = "/api/admin/service-user/etrade/start";
const VERIFIER = "/api/admin/service-user/etrade/verifier";
const REVOKE = "/api/admin/service-user/etrade/revoke";
const STATUS = "/api/admin/service-user/status";

const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";
const OWNER_LOGIN = "owner-login";
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

function tenantMemberMembership(userId: string, tenantId = "primary"): Membership {
  return {
    membershipId: `m-member-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function freshSession(authTimeMs: number | undefined): SessionData {
  return {
    githubLogin: ADMIN_LOGIN,
    githubAvatar: "",
    githubName: "",
    createdAt: Date.now(),
    internalUserId: ADMIN_ID,
    ...(authTimeMs === undefined ? {} : { authTimeMs }),
  };
}

interface CtxBundle {
  ctx: ServiceUserRouteContext;
  audit: ReturnType<typeof vi.fn>;
  store: MembershipStore;
  env: Env;
  /** Raw fake SessionStore entries, keyed `${ns}:${key}`. */
  rawStore: Map<string, string>;
}

async function makeCtx(opts: {
  callerMemberships?: Membership[];
  serviceLogin?: string | null;
  session?: SessionData | null;
  pdpEnabled?: boolean;
}): Promise<CtxBundle> {
  const { namespace, store: rawStore } = makeFakeSessionStore();
  const store = createMemoryMembershipStore();
  for (const m of opts.callerMemberships ?? []) await store.put(m);
  const audit = vi.fn();
  const kv = mapKv(aliasSeed(ADMIN_LOGIN, ADMIN_ID));
  const env = {
    APP_ENV: "TEST",
    ET_API_KEY: "test-key",
    ET_API_SECRET: "test-secret",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: namespace,
    IAAA_WIRING_ENABLED: "1",
    IAAA_PDP_ENABLED: opts.pdpEnabled ? "1" : "0",
    SERVICE_USER_LOGIN: SERVICE_LOGIN,
  } as unknown as Env;
  const ctx = {
    env,
    audit,
    membershipStore: store,
    aliasKv: kv,
    serviceLogin: opts.serviceLogin === undefined ? SERVICE_LOGIN : opts.serviceLogin,
    defaultTenantId: "primary",
    // The session seam: the route reads the acting session from here
    // in tests; in production it loads it from the request cookie.
    session: opts.session === undefined ? freshSession(Date.now()) : opts.session,
  } as unknown as ServiceUserRouteContext;
  return { ctx, audit, store, env, rawStore };
}

async function call(
  ctx: ServiceUserRouteContext,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  query?: string,
) {
  const req = new Request(`https://agent.test${path}${query ?? ""}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-user-login": ADMIN_LOGIN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleServiceUserRoutes(
    req,
    new URL(`https://agent.test${path}${query ?? ""}`),
    path,
    "session-1",
    ctx,
  );
  if (res === null) return { status: null, body: null as any };
  return { status: res.status, body: (await res.json()) as any };
}

function mockRequestTokenFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("oauth_token=REQTOKEN&oauth_token_secret=REQSECRET", {
      status: 200,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
  );
}

function mockAccessTokenFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("oauth_token=ACCTOKEN&oauth_token_secret=ACCSECRET", {
      status: 200,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
  );
}

describe("POST /api/admin/service-user/etrade/start (#4988)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
  });

  it("refuses a non-admin caller with 403 and writes nothing", async () => {
    const { ctx, audit, env, rawStore } = await makeCtx({ callerMemberships: [] });
    const fetchSpy = mockRequestTokenFetch();
    const { status } = await call(ctx, START, "POST", {});
    expect(status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect([...rawStore.keys()].some((k) => k.includes("svc-background"))).toBe(false);
  });

  it("refuses a stale step-up session with 403 and writes nothing", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      session: freshSession(Date.now() - 6 * 60 * 1000),
    });
    const fetchSpy = mockRequestTokenFetch();
    const { status, body } = await call(ctx, START, "POST", {});
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/step-up/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a session without authTimeMs (legacy/stale) with 403", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      session: freshSession(undefined),
    });
    const fetchSpy = mockRequestTokenFetch();
    const { status } = await call(ctx, START, "POST", {});
    expect(status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a missing session (no resolvable cookie) with 401 and writes nothing", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      session: null,
    });
    const fetchSpy = mockRequestTokenFetch();
    const { status } = await call(ctx, START, "POST", {});
    expect(status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a PDP-denied caller with 403 and writes nothing", async () => {
    // Platform-admin only: platform scope never grants the tenant
    // permission integration:connect, so the PDP denies.
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      pdpEnabled: true,
    });
    const fetchSpy = mockRequestTokenFetch();
    const { status, body } = await call(ctx, START, "POST", {});
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/denied|integration:connect/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns the E*TRADE authorize URL, stores the request token under the service login only, and audits", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      pdpEnabled: true,
    });
    mockRequestTokenFetch();
    const { status, body } = await call(ctx, START, "POST", {});
    expect(status).toBe(200);
    expect(typeof body.authorizeUrl).toBe("string");
    expect(body.authorizeUrl).toContain("us.etrade.com");
    expect(body.authorizeUrl).toContain("REQTOKEN");
    expect(body.serviceUser).toBe(SERVICE_LOGIN);
    // The request-token secret is never returned to the caller: the
    // exchange reads it server-side from the service login's record.
    expect(body.requestTokenSecret).toBeUndefined();
    const stored = await getRequestTokenSecret(env, SERVICE_LOGIN);
    expect(stored).toEqual(
      expect.objectContaining({ requestToken: "REQTOKEN", requestTokenSecret: "REQSECRET" }),
    );
    expect(await getRequestTokenSecret(env, OWNER_LOGIN)).toBeNull();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe("service_user.etrade_auth_started");
    expect(audit.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        actor: ADMIN_ID,
        serviceUser: SERVICE_LOGIN,
        serviceInternalUserId: SERVICE_ID,
      }),
    );
  });

  it("fails closed with 500 when the service login is unconfigured", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      serviceLogin: null,
    });
    const fetchSpy = mockRequestTokenFetch();
    const { status } = await call(ctx, START, "POST", {});
    expect(status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getRequestTokenSecret(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/service-user/etrade/verifier (#4988)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
  });

  async function allowedCtx() {
    return makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
      pdpEnabled: true,
    });
  }

  it("stores the access token under the service login's keys only, turns the checklist item pass, and audits", async () => {
    const { ctx, audit, env, rawStore } = await allowedCtx();
    await storeRequestTokenSecret(env, SERVICE_LOGIN, "REQTOKEN", "REQSECRET");
    await storeAccessTokens(env, OWNER_LOGIN, "OWNER-ACC", "OWNER-SEC");
    mockAccessTokenFetch();
    const { status, body } = await call(ctx, VERIFIER, "POST", { verifier: "123456" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.serviceUser).toBe(SERVICE_LOGIN);
    const serviceTokens = await getStoredTokens(env, SERVICE_LOGIN);
    expect(serviceTokens?.accessToken).toBe("ACCTOKEN");
    expect(serviceTokens?.accessTokenSecret).toBe("ACCSECRET");
    // The internal-id key (service:svc-background) carries the same set.
    expect(rawStore.has("etrade:etrade:token:TEST:service:svc-background")).toBe(true);
    // The owner's token is untouched.
    expect((await getStoredTokens(env, OWNER_LOGIN))?.accessToken).toBe("OWNER-ACC");
    // The provisioning checklist's brokerage item turns pass.
    const statusRes = await call(ctx, STATUS, "GET");
    expect(statusRes.status).toBe(200);
    const brokerage = (statusRes.body.provisioning.checklist as Array<{ id: string; status: string }>).find(
      (item) => item.id === "brokerage_token_present",
    );
    expect(brokerage?.status).toBe("pass");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe("service_user.etrade_auth_completed");
    expect(audit.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        actor: ADMIN_ID,
        serviceUser: SERVICE_LOGIN,
        serviceInternalUserId: SERVICE_ID,
      }),
    );
  });

  it("ignores a tampered client-supplied login: the token still lands under the service login only", async () => {
    const { ctx, audit, env } = await allowedCtx();
    await storeRequestTokenSecret(env, SERVICE_LOGIN, "REQTOKEN", "REQSECRET");
    await storeAccessTokens(env, OWNER_LOGIN, "OWNER-ACC", "OWNER-SEC");
    mockAccessTokenFetch();
    const { status } = await call(
      ctx,
      VERIFIER,
      "POST",
      { verifier: "123456", login: OWNER_LOGIN, userLogin: OWNER_LOGIN },
      `?login=${OWNER_LOGIN}`,
    );
    expect(status).toBe(200);
    expect((await getStoredTokens(env, SERVICE_LOGIN))?.accessToken).toBe("ACCTOKEN");
    // The owner's token was not overwritten by the tampered exchange.
    expect((await getStoredTokens(env, OWNER_LOGIN))?.accessToken).toBe("OWNER-ACC");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][2]).toEqual(
      expect.objectContaining({ serviceUser: SERVICE_LOGIN }),
    );
  });

  it("refuses a PDP-denied caller with 403 and writes nothing", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [platformAdminMembership(ADMIN_ID)],
      pdpEnabled: true,
    });
    await storeRequestTokenSecret(env, SERVICE_LOGIN, "REQTOKEN", "REQSECRET");
    const fetchSpy = mockAccessTokenFetch();
    const { status } = await call(ctx, VERIFIER, "POST", { verifier: "123456" });
    expect(status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getStoredTokens(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("fails without a stored request token and leaves no partial token", async () => {
    const { ctx, audit, env } = await allowedCtx();
    const fetchSpy = mockAccessTokenFetch();
    const { status } = await call(ctx, VERIFIER, "POST", { verifier: "123456" });
    expect(status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getStoredTokens(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a missing verifier with 400", async () => {
    const { ctx, audit, env } = await allowedCtx();
    await storeRequestTokenSecret(env, SERVICE_LOGIN, "REQTOKEN", "REQSECRET");
    const fetchSpy = mockAccessTokenFetch();
    const { status } = await call(ctx, VERIFIER, "POST", { verifier: "   " });
    expect(status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getStoredTokens(env, SERVICE_LOGIN)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/service-user/etrade/revoke (#4988)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
  });

  it("deletes only the service login's key set; the owner's token still resolves", async () => {
    const { ctx, audit, env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
    });
    await storeAccessTokens(env, SERVICE_LOGIN, "SVC-ACC", "SVC-SEC", undefined, {
      internalUserId: SERVICE_ID,
    });
    await storeAccessTokens(env, OWNER_LOGIN, "OWNER-ACC", "OWNER-SEC");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("", { status: 200 }),
    );
    const { status, body } = await call(ctx, REVOKE, "POST", {});
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(await getStoredTokens(env, SERVICE_LOGIN)).toBeNull();
    expect(
      await getStoredTokens(env, SERVICE_LOGIN, undefined, { internalUserId: SERVICE_ID }),
    ).toBeNull();
    // The owner's token still resolves afterwards.
    expect((await getValidTokens(env, OWNER_LOGIN))?.accessToken).toBe("OWNER-ACC");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe("service_user.etrade_revoked");
    expect(audit.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        actor: ADMIN_ID,
        serviceUser: SERVICE_LOGIN,
        serviceInternalUserId: SERVICE_ID,
      }),
    );
  });

  it("refuses a non-admin caller with 403 and deletes nothing", async () => {
    const { ctx, audit, env } = await makeCtx({ callerMemberships: [] });
    await storeAccessTokens(env, SERVICE_LOGIN, "SVC-ACC", "SVC-SEC");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 200 }));
    const { status } = await call(ctx, REVOKE, "POST", {});
    expect(status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getStoredTokens(env, SERVICE_LOGIN))?.accessToken).toBe("SVC-ACC");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("service-login token resolution + renewal (#4988 §4/§6)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
  });

  it("a background context resolves the service token via getValidTokens with no live session", async () => {
    const { env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
    });
    await storeAccessTokens(env, SERVICE_LOGIN, "SVC-ACC", "SVC-SEC", undefined, {
      internalUserId: SERVICE_ID,
    });
    // No session anywhere in this read: the service login resolves
    // through etradeIdentityFromLogin alone (no alias record exists
    // for the service user, so the identity is empty and the login
    // keys are the resolution path).
    const identity = await etradeIdentityFromLogin(env, SERVICE_LOGIN);
    expect(identity).toEqual({});
    const resolved = await getValidTokens(env, SERVICE_LOGIN, undefined, identity);
    expect(resolved?.accessToken).toBe("SVC-ACC");
    expect(resolved?.userLogin).toBe(SERVICE_LOGIN);
  });

  it("the renewal pass covers the service login's token", async () => {
    const { env } = await makeCtx({
      callerMemberships: [
        platformAdminMembership(ADMIN_ID),
        tenantMemberMembership(ADMIN_ID),
      ],
    });
    await storeAccessTokens(env, SERVICE_LOGIN, "SVC-ACC", "SVC-SEC");
    await storeAccessTokens(env, OWNER_LOGIN, "OWNER-ACC", "OWNER-SEC");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("", { status: 200 }),
    );
    const result = await renewAllStoredETradeTokens(env);
    expect(result).toEqual({ renewed: 2, skipped: 0, failed: 0 });
    expect((await getValidTokens(env, SERVICE_LOGIN))?.accessToken).toBe("SVC-ACC");
    expect((await getValidTokens(env, OWNER_LOGIN))?.accessToken).toBe("OWNER-ACC");
  });
});
