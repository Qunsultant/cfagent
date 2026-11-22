/**
 * Service-user provisioning routes (#2331 slice 1).
 *
 * The service user is a real identity, not a configured name: this
 * module provisions it through the existing grant path and revokes
 * it through the existing membership store. It invents no identity
 * scheme, no grant rule, and no audit channel:
 * - Gate: the caller's x-user-login header (set by the Worker from
 *   the verified session, same trust as the schedules routes) is
 *   resolved to an internalUserId through the wired-login alias
 *   record, and the caller must hold a live platform-admin
 *   membership (PDP platform-scope check, GAP-1 seam A).
 *   Anything else answers 403 with
 *   no data. A caller without an alias has no wired identity and
 *   is refused the same way legacy sessions are refused by the
 *   #1758 admin routes.
 * - Grant: grantMembership, so canGrantRole re-enforces Slice 3
 *   policy at the store call. Two consequences the caller must
 *   understand. First, platform-admin is NOT a tenant superuser:
 *   provisioning a tenant tier additionally requires the caller to
 *   hold tenant-admin in that tenant, and a platform-admin without
 *   it gets 403 GRANT_DENIED with nothing written. Second, the
 *   bindings this route grants are always member, never admin:
 *   platform tier gets one platform-scope member binding, tenant
 *   tier gets one tenant-scope member binding.
 * - Platform-scope member caveat, stated plainly for slice 2:
 *   authorize() grants platform-scope permissions only to
 *   platform-admin bindings, so a platform-scope member binding
 *   carries no PDP permission under the current policy. Slice 1
 *   grants no admin and invents no role to work around that;
 *   slice 2 (dispatch enforcement) must define its platform-tier
 *   check accordingly (membership check, or a tenant-scoped PDP
 *   check), as its own decision.
 * - Service identity: the internalUserId is
 *   serviceUserInternalUserId(login) (`service:<login>`), shared
 *   with slice 2 through that helper. No alias record is written
 *   for the service user: alias records are observations of wired
 *   logins, and the service user never logs in.
 * - Brokerage: untouched. This route reads no token, writes no
 *   token, and grants no brokerage credential; brokerage-attached
 *   work runs as the schedule owner only (#2331 decision).
 *   EXCEPTION, issue #4988 (#945 Q10): the E*TRADE authorization
 *   routes below (etrade/start, etrade/verifier, etrade/revoke)
 *   are the ONE way the service login gains its own broker token
 *   — the owner authorizes svc-background through the 3-legged
 *   flow, and the token is stored under the service login's keys
 *   only, never the owner's. The user's Connect flow is untouched,
 *   and schedule-owner brokerage work (#2331) is not rewired.
 * - Audit: every actual grant and every actual revoke emits one
 *   event through the orchestrator audit funnel (ctx.audit).
 *   Idempotent no-ops (already provisioned, nothing to revoke)
 *   change nothing and emit nothing, the same rule as the
 *   maintenance preview. Reads (status) emit nothing. The #4988
 *   E*TRADE routes audit the same way: a started authorization,
 *   a completed exchange, and an actual token revocation each emit
 *   one event with the acting admin as actor and the service
 *   identity as target; a refused start/exchange emits nothing.
 * - Provision is idempotent: re-provisioning an already active
 *   matching binding returns it instead of minting a duplicate.
 *   Revoke removes every active binding in the selected scope;
 *   offboard (no tier) removes all of them, any role, so no
 *   privilege survives offboarding.
 */

import { createKvMembershipStore, grantMembership } from "../../security/iaaaMembershipStore";
import { resolveGrantDefaultExpiryDays } from "../../security/grantRules";
import {
  exchangeETradeVerifier,
  getETradeRequestToken,
  getStoredTokens,
  revokeRemoteAccessToken,
} from "../../security/etradeOAuth";
import { checkPlatformPermission } from "../../security/iaaaPdpSeam";
import { createKvPermissionDenialStore } from "../../security/iaaaPermissionDenialStore";
import { requiresStepUpForAction } from "../../security/iaaaGates";
import { evaluateRoutePep } from "../../security/pepGateway";
import { isWiringEnabled } from "../../security/providers";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { resolveLogins } from "../../security/identityDisplay";
import {
  getServiceUserLogin,
  isLoginShaped,
  serviceUserInternalUserId,
} from "../../security/serviceIdentity";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { getSession, getSessionId, sessionStore } from "../../security/session";
import {
  listServiceTokens,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
  serviceTokenStore,
  type ServiceTokenTier,
} from "../../security/serviceTokens";
import type { MembershipStore, PermissionDenialReader } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env, SessionData } from "../../types";

export interface ServiceUserRouteContext {
  /** Worker env (carries the SESSION_STORE binding). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: use this store instead of the SessionStore KV store. */
  membershipStore?: MembershipStore;
  /** Test seam: use this KV instead of the SessionStore KV for aliases. */
  aliasKv?: KvLike;
  /** Test seam: use this service login instead of env SERVICE_USER_LOGIN. */
  serviceLogin?: string | null;
  /** Test seam: use this tenant instead of resolveIaaaTenant(env). */
  defaultTenantId?: string;
  /**
   * Issue #1764 — test seam for the brokerage-token presence
   * check in the provisioning checklist. When absent, the route
   * reads presence (never a value) via getStoredTokens and
   * reports "unknown" if that read fails, so a store outage is
   * never reported as "absent" or "present".
   */
  brokerageTokenPresent?: (serviceLogin: string) => Promise<boolean | null>;
  /** Issue #2681 — test seam: use this store instead of the SessionStore service_tokens bucket. */
  tokenStore?: KvLike;
  /**
   * Issue #4988 — test seam: the acting session for the step-up +
   * PEP gates on the E*TRADE authorization routes. When the property
   * is absent, the route loads the session from the request's session
   * cookie (fail-closed when unresolvable). A present null is a
   * missing session, never a fallback to the header identity.
   */
  session?: SessionData | null;
  /**
   * Issue #4988 — test seam: per-user permission-denial store for the
   * PEP check. When absent, the route builds the KV denial store over
   * the SessionStore; a build failure falls back to a denial-unaware
   * decision, exactly as evaluateRoutePep documents.
   */
  permissionDenialStore?: PermissionDenialReader;
}

type Tier = "platform" | "tenant";

function isTenantShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

interface Caller {
  login: string;
  internalUserId: string;
  store: MembershipStore;
}

/** Shared by the orchestrator-migration routes (#2681): same admin gate. */
export async function resolveCaller(
  request: Request,
  ctx: ServiceUserRouteContext,
): Promise<Caller | Response> {
  // Issue #2681: a service-token-authenticated caller is never an
  // administrator of the service identity — tokens never administer
  // tokens, and the service login has no wired alias, so the alias
  // check below would 403 it anyway. The explicit guard states the
  // rule instead of relying on that accident.
  if (request.headers.get("x-principal-kind") === "service-token") {
    return jsonError("Forbidden: service-token callers cannot administer the service identity.", 403);
  }
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  if (!internalUserId) {
    return jsonError(
      "Forbidden: service-user administration requires a wired session.",
      403,
    );
  }
  const store = ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
  // GAP-1 (seam A): the PDP platform-scope decision replaces the
  // hand-rolled isPlatformAdmin predicate — behavior-identical
  // (live platform-admin binding at platform scope, unrevoked,
  // unexpired). The permission is the platform-privilege grant;
  // per-surface mapping is CISO follow-up, not invented here.
  const decision = await checkPlatformPermission(store, {
    internalUserId,
    permission: "role:assign",
    nowMs: Date.now(),
  });
  if (decision.decision !== "allow") {
    return jsonError(
      "Forbidden: service-user administration requires platform-admin membership.",
      403,
    );
  }
  return { login, internalUserId, store };
}

async function provisionServiceUser(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const tier = body.tier as string | undefined;
  if (tier !== "platform" && tier !== "tenant") {
    return jsonError(`Unknown tier: ${String(tier)}. Tier must be "platform" or "tenant".`, 400);
  }
  let tenantId: string;
  if (tier === "tenant") {
    if (!isTenantShaped(body.tenantId)) {
      return jsonError("tenantId is required for tenant provisioning.", 400);
    }
    tenantId = (body.tenantId as string).trim();
  } else {
    tenantId = ctx.defaultTenantId ?? resolveIaaaTenant(ctx.env);
  }
  const serviceLogin = ctx.serviceLogin === undefined
    ? getServiceUserLogin(ctx.env)
    : ctx.serviceLogin;
  if (serviceLogin === null) {
    return jsonError("Service user login is not configured (SERVICE_USER_LOGIN).", 500);
  }
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  if (serviceInternalUserId === caller.internalUserId) {
    return jsonError("Forbidden: a caller cannot provision itself as the service user.", 403);
  }
  const scope = tier === "platform" ? "platform" : "tenant";
  const existing = (await caller.store.getMembershipsByUser(serviceInternalUserId)).find(
    (m) =>
      m.revokedAtMs === undefined &&
      (tier === "platform" || m.tenantId === tenantId) &&
      m.roleBindings.some((b) => b.scope === scope && b.role === "member"),
  );
  if (existing) {
    return Response.json({
      ok: true,
      alreadyProvisioned: true,
      membershipId: existing.membershipId,
      serviceUser: serviceLogin,
      serviceInternalUserId,
      tier,
      tenantId,
    });
  }
  const result = await grantMembership(caller.store, {
    granterInternalUserId: caller.internalUserId,
    internalUserId: serviceInternalUserId,
    tenantId,
    roleBindings: [
      { role: "member", scope: scope as "platform" | "tenant", grantedBy: caller.internalUserId },
    ],
    nowMs: Date.now(),
    // Issue #3155 (Q9): tenant-tier service memberships carry the
    // default expiry like any tenant grant. Platform-scope bindings
    // are untouched by the default. Known interaction, not fixed
    // here: dispatch checks revokedAtMs only, so an expired
    // tenant-tier service membership still dispatches until
    // revoked — expiry-aware dispatch is a separate slice.
    defaultExpiryDays: resolveGrantDefaultExpiryDays(ctx.env.IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
  });
  if (!result.ok) {
    if (result.code === "GRANT_DENIED") {
      return jsonError(result.error, 403);
    }
    return jsonError(result.error, 400);
  }
  ctx.audit("service_user.provisioned", "orchestrator", {
    serviceUser: serviceLogin,
    serviceInternalUserId,
    tier,
    tenantId,
    membershipId: result.membership.membershipId,
    grantedBy: caller.internalUserId,
  });
  return Response.json({
    ok: true,
    membershipId: result.membership.membershipId,
    serviceUser: serviceLogin,
    serviceInternalUserId,
    tier,
    tenantId,
  });
}

async function revokeServiceUser(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const tierRaw = body.tier === undefined ? "all" : body.tier;
  if (tierRaw !== "platform" && tierRaw !== "tenant" && tierRaw !== "all") {
    return jsonError(`Unknown tier: ${String(tierRaw)}. Tier must be "platform", "tenant", or "all".`, 400);
  }
  let tenantId: string | undefined;
  if (tierRaw === "tenant") {
    if (!isTenantShaped(body.tenantId)) {
      return jsonError("tenantId is required for tenant revocation.", 400);
    }
    tenantId = (body.tenantId as string).trim();
  }
  const serviceLogin = ctx.serviceLogin === undefined
    ? getServiceUserLogin(ctx.env)
    : ctx.serviceLogin;
  if (serviceLogin === null) {
    return jsonError("Service user login is not configured (SERVICE_USER_LOGIN).", 500);
  }
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  const actives = (await caller.store.getMembershipsByUser(serviceInternalUserId)).filter(
    (m) => m.revokedAtMs === undefined,
  );
  const targets = actives.filter((m) => {
    if (tierRaw === "all") return true;
    if (tierRaw === "platform") return m.roleBindings.some((b) => b.scope === "platform");
    return m.tenantId === tenantId && m.roleBindings.some((b) => b.scope === "tenant");
  });
  const revoked: string[] = [];
  const nowMs = Date.now();
  for (const m of targets) {
    if (await caller.store.revokeMembership(m.membershipId, nowMs)) {
      revoked.push(m.membershipId);
    }
  }
  if (revoked.length > 0) {
    ctx.audit("service_user.revoked", "orchestrator", {
      serviceUser: serviceLogin,
      serviceInternalUserId,
      tier: tierRaw,
      tenantId,
      revoked,
      revokedBy: caller.internalUserId,
    });
  }
  return Response.json({
    ok: true,
    revoked,
    revokedCount: revoked.length,
    serviceUser: serviceLogin,
    serviceInternalUserId,
    tier: tierRaw,
    tenantId,
  });
}

/**
 * Issue #1764 — the service-identity provisioning completeness
 * checklist (F-33). Provisioning is an owner step, not code, so
 * the route cannot complete it — but it can stop it being
 * silent: every item is reported pass/fail/unknown, and every
 * non-pass item names the owner action that closes it. The
 * pre-existing status fields above are unchanged; this object
 * is purely additive. A binding counts as live only when the
 * membership is unrevoked AND its platform member binding is
 * unexpired (an expired binding previously read as provisioned
 * in the platform field's presence check). The token item is
 * presence only: the token value is never read into the
 * response, and a failed store read reports "unknown", never a
 * guessed pass or fail.
 */
export type ProvisioningCheckStatus = "pass" | "fail" | "unknown";

export interface ProvisioningChecklistItem {
  id: string;
  label: string;
  status: ProvisioningCheckStatus;
  detail?: string;
}

export interface ProvisioningChecklist {
  complete: boolean;
  checklist: ProvisioningChecklistItem[];
  ownerActions: string[];
}

async function buildProvisioningChecklist(
  ctx: ServiceUserRouteContext,
  serviceLogin: string,
  serviceInternalUserId: string,
  actives: Awaited<ReturnType<Caller["store"]["getMembershipsByUser"]>>,
): Promise<ProvisioningChecklist> {
  const nowMs = Date.now();
  const platformLive = actives.some((m) =>
    m.roleBindings.some(
      (b) =>
        b.scope === "platform" &&
        b.role === "member" &&
        (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
    ),
  );
  let tokenPresent: boolean | null;
  if (ctx.brokerageTokenPresent) {
    tokenPresent = await ctx.brokerageTokenPresent(serviceLogin);
  } else {
    try {
      const tokens = await getStoredTokens(ctx.env, serviceLogin, undefined, {
        internalUserId: serviceInternalUserId,
      });
      tokenPresent = tokens !== null;
    } catch {
      tokenPresent = null;
    }
  }
  const checklist: ProvisioningChecklistItem[] = [
    {
      id: "service_login_configured",
      label: "SERVICE_USER_LOGIN is configured",
      status: "pass",
      detail: `Configured login: ${serviceLogin}.`,
    },
    {
      id: "platform_membership_live",
      label: "Platform-tier member binding is live",
      status: platformLive ? "pass" : "fail",
      detail: platformLive
        ? "A live, unrevoked, unexpired platform-scope member binding exists."
        : "No live platform-scope member binding (missing, revoked, or expired).",
    },
    {
      id: "brokerage_token_present",
      label: "Brokerage token is stored for the service identity",
      status:
        tokenPresent === null ? "unknown" : tokenPresent ? "pass" : "fail",
      detail:
        tokenPresent === null
          ? "Token presence could not be read from the token store; not assumed present or absent."
          : tokenPresent
            ? "A stored token exists for the service identity (presence only; value never exposed)."
            : "No stored token for the service identity.",
    },
  ];
  const ownerActions: string[] = [];
  if (!platformLive) {
    ownerActions.push(
      "Provision the platform tier via POST /api/admin/service-user/provision with {\"tier\": \"platform\"} (platform-admin caller required).",
    );
  }
  if (tokenPresent === false) {
    ownerActions.push(
      `Authorize ${serviceLogin} once via the "Authorize service login with E*TRADE" action in the Service User section, so a stored token exists under its login.`,
    );
  }
  if (tokenPresent === null) {
    ownerActions.push(
      "Re-check brokerage token presence: the token-store read failed, so presence is unknown (not failed).",
    );
  }
  return {
    complete: checklist.every((item) => item.status === "pass"),
    checklist,
    ownerActions,
  };
}

async function statusServiceUser(
  caller: Caller,
  ctx: ServiceUserRouteContext,
): Promise<Response> {
  const serviceLogin = ctx.serviceLogin === undefined
    ? getServiceUserLogin(ctx.env)
    : ctx.serviceLogin;
  if (serviceLogin === null) {
    return jsonError("Service user login is not configured (SERVICE_USER_LOGIN).", 500);
  }
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  const actives = (await caller.store.getMembershipsByUser(serviceInternalUserId)).filter(
    (m) => m.revokedAtMs === undefined,
  );
  const platform = actives.find((m) => m.roleBindings.some((b) => b.scope === "platform"));
  const tenants = [
    ...new Set(
      actives
        .filter((m) => m.roleBindings.some((b) => b.scope === "tenant"))
        .map((m) => m.tenantId),
    ),
  ];
  const provisioning = await buildProvisioningChecklist(
    ctx,
    serviceLogin,
    serviceInternalUserId,
    actives,
  );
  return Response.json({
    ok: true,
    serviceUser: serviceLogin,
    serviceInternalUserId,
    platform: platform
      ? {
          membershipId: platform.membershipId,
          roles: platform.roleBindings.map((b) => b.role),
        }
      : null,
    tenants,
    provisioning,
  });
}

/**
 * Issue #2681 — service-token admin routes. Same gate as the
 * service-user routes (platform-admin, wired session only, never a
 * service-token caller) and the same audit funnel. Audit fires only
 * on actual lifecycle changes (mint/rotate/revoke); list reads emit
 * nothing, and failed mints emit nothing — the same rule as the
 * service-user routes.
 */
function resolveTokenStore(ctx: ServiceUserRouteContext): KvLike {
  return ctx.tokenStore ?? serviceTokenStore(ctx.env);
}

function resolveTokenServiceLogin(ctx: ServiceUserRouteContext): string | null {
  return ctx.serviceLogin === undefined ? getServiceUserLogin(ctx.env) : ctx.serviceLogin;
}

async function mintTokenRoute(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const serviceLogin = resolveTokenServiceLogin(ctx);
  if (serviceLogin === null) {
    return jsonError("Service user login is not configured (SERVICE_USER_LOGIN).", 500);
  }
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  if (serviceInternalUserId === caller.internalUserId) {
    return jsonError("Forbidden: a caller cannot mint a token for itself as the service user.", 403);
  }
  try {
    const { token, secret } = await mintServiceToken(
      resolveTokenStore(ctx),
      caller.store,
      {
        label: typeof body.label === "string" ? body.label : "",
        tier: body.tier as ServiceTokenTier,
        tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
        roles: Array.isArray(body.roles) ? (body.roles as never[]) : [],
        expiresAtMs: typeof body.expiresAtMs === "number" ? body.expiresAtMs : 0,
        serviceLogin,
        serviceInternalUserId,
        createdBy: caller.internalUserId,
      },
      Date.now(),
    );
    ctx.audit("service_token.minted", "orchestrator", {
      tokenId: token.id,
      prefix: token.prefix,
      tier: token.tier,
      tenantId: token.tenantId,
      roles: token.roles,
      createdBy: caller.internalUserId,
    });
    return Response.json({ ok: true, token, secret }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token mint failed.";
    if (/Cannot grant role/.test(message) || /not provisioned/.test(message)) {
      return jsonError(message, 403);
    }
    return jsonError(message, 400);
  }
}

async function listTokensRoute(ctx: ServiceUserRouteContext): Promise<Response> {
  const tokens = await listServiceTokens(resolveTokenStore(ctx));
  // #6164 (F7) — each token carries its minter's login, resolved
  // server-side via the alias record (null when no alias exists).
  // The service identity itself (serviceLogin + serviceInternalUserId)
  // already rides on the token record.
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const logins = await resolveLogins(kv, tokens.map((t) => t.createdBy));
  return Response.json({
    ok: true,
    tokens: tokens.map((t) => ({
      ...t,
      createdByLogin: logins.get(t.createdBy) ?? null,
    })),
  });
}

async function rotateTokenRoute(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const tokenId = typeof body.tokenId === "string" ? body.tokenId : "";
  const expiresAtMs = typeof body.expiresAtMs === "number" ? body.expiresAtMs : 0;
  if (!tokenId) return jsonError("tokenId is required.", 400);
  try {
    const rotated = await rotateServiceToken(
      resolveTokenStore(ctx),
      tokenId,
      expiresAtMs,
      Date.now(),
    );
    if (rotated === null) {
      return jsonError("Token not found or revoked.", 404);
    }
    ctx.audit("service_token.rotated", "orchestrator", {
      tokenId: rotated.token.id,
      prefix: rotated.token.prefix,
      rotatedBy: caller.internalUserId,
    });
    return Response.json({ ok: true, token: rotated.token, secret: rotated.secret });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token rotation failed.";
    return jsonError(message, 400);
  }
}

async function revokeTokenRoute(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const tokenId = typeof body.tokenId === "string" ? body.tokenId : "";
  if (!tokenId) return jsonError("tokenId is required.", 400);
  const revoked = await revokeServiceToken(resolveTokenStore(ctx), tokenId, Date.now());
  if (!revoked) {
    return jsonError("Token not found or already revoked.", 404);
  }
  ctx.audit("service_token.revoked", "orchestrator", {
    tokenId,
    revokedBy: caller.internalUserId,
  });
  return Response.json({ ok: true, revoked: true, tokenId });
}

/**
 * Issue #4988 (#945 Q10) — service-login E*TRADE authorization
 * (option 1, owner decision 2026-11-16): the service identity
 * (`svc-background`) holds its own broker login and its own stored
 * token; it never uses the owner's token.
 *
 * The three routes below are the ONE way the service login gains
 * its token. Every E*TRADE OAuth route in src/server/routes/auth.ts
 * binds to the signed-in session's login, and this slice does not
 * touch that flow. The rules, in order, on every route:
 * - Gate: the same resolveCaller platform-admin gate as the
 *   provision/revoke/status routes (wired session, never a
 *   service-token caller).
 * - Session: the acting session is loaded from the request's
 *   session cookie (the Worker forwards /api/* to this DO with the
 *   cookie intact, via stub.fetch). A missing session is refused
 *   with 401 — the header login is never substituted for it.
 * - Start only: Q4 step-up for integration-credential management
 *   (5-minute window), checked BEFORE the authorization decision,
 *   the same order as the role:assign route.
 * - Start + exchange: PEP integration:connect via evaluateRoutePep,
 *   the same helper and the same two 403 responses as the user
 *   linking routes (#1755). Revoke is platform-admin + audit only,
 *   per the slice (the api-keys pilot likewise does not step-up-
 *   gate revocation).
 * - Identity: the service login is resolved server-side from
 *   getServiceUserLogin() — NEVER from the request. The exchange
 *   binds to the request-token record stored under the service
 *   login's key, so a tampered or client-supplied login cannot
 *   redirect the token into another login's slot; the token lands
 *   under the service login's keys only (login + internal-id,
 *   via the identity dual-write in storeAccessTokens).
 * - Completion is a verifier PIN, not a browser callback: the
 *   start passes "oob", E*TRADE shows the PIN, the owner pastes
 *   it into the Service User section. No callback URL is
 *   registered — this DO-side route has no trusted public origin
 *   (the forwarded request URL is agent.internal), so a
 *   client-supplied callback would be an open redirect.
 * - Audit: a started authorization, a completed exchange, and an
 *   actual token revocation each emit one event with the acting
 *   admin as actor and the service identity as target. Refusals
 *   and no-op revokes emit nothing.
 */

/** The E*TRADE environment override, same carriers as the user linking routes. */
function etradeReqEnv(request: Request, url: URL): string | undefined {
  return (
    (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase() ||
    undefined
  );
}

/**
 * The acting session for the step-up + PEP gates. The session seam
 * overrides the load in tests; in production the id comes from the
 * request's session cookie. Any failure loads as null — fail-closed,
 * never a fallback to the header login.
 */
async function resolveActingSession(
  request: Request,
  ctx: ServiceUserRouteContext,
): Promise<SessionData | null> {
  if ("session" in ctx) return ctx.session ?? null;
  try {
    const sessionId = getSessionId(request);
    if (!sessionId) return null;
    return await getSession(ctx.env, sessionId);
  } catch {
    return null;
  }
}

function resolveServiceLoginForEtrade(
  ctx: ServiceUserRouteContext,
): string | Response {
  const serviceLogin =
    ctx.serviceLogin === undefined ? getServiceUserLogin(ctx.env) : ctx.serviceLogin;
  if (serviceLogin === null) {
    return jsonError("Service user login is not configured (SERVICE_USER_LOGIN).", 500);
  }
  return serviceLogin;
}

/**
 * The integration:connect PEP gate for the service-login E*TRADE
 * start + exchange routes — the same helper (evaluateRoutePep) and
 * the same two 403 responses as the user linking routes (#1755).
 * Returns null when the call may proceed, else the denial response.
 */
async function requireServiceEtradePep(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  session: SessionData,
): Promise<Response | null> {
  let denialStore = ctx.permissionDenialStore;
  if (!denialStore) {
    try {
      denialStore = createKvPermissionDenialStore(sessionStore(ctx.env));
    } catch {
      denialStore = undefined;
    }
  }
  const pep = await evaluateRoutePep({
    env: ctx.env,
    session,
    tenantId: ctx.defaultTenantId ?? resolveIaaaTenant(ctx.env),
    permission: "integration:connect",
    membershipStore: caller.store,
    permissionDenialStore: denialStore,
    nowMs: Date.now(),
  });
  if (pep.enforced && !pep.allowed) {
    if (pep.graceExpired) {
      return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
    }
    return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
  }
  return null;
}

async function startServiceEtradeAuth(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  request: Request,
  url: URL,
): Promise<Response> {
  const serviceLoginOrError = resolveServiceLoginForEtrade(ctx);
  if (serviceLoginOrError instanceof Response) return serviceLoginOrError;
  const serviceLogin = serviceLoginOrError;
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  const session = await resolveActingSession(request, ctx);
  if (!session) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  // #3102 (#945 Q4): starting a service credential requires fresh
  // authentication inside the 5-minute integration-credential-
  // management window, before the authorization decision below.
  if (
    requiresStepUpForAction(
      session,
      "integration-credential-management",
      isWiringEnabled(ctx.env),
      Date.now(),
    )
  ) {
    return jsonError("Step-up authentication required: please sign in again and retry.", 403);
  }
  const denied = await requireServiceEtradePep(caller, ctx, session);
  if (denied) return denied;
  try {
    const result = await getETradeRequestToken(
      ctx.env,
      serviceLogin,
      "oob",
      etradeReqEnv(request, url),
    );
    ctx.audit("service_user.etrade_auth_started", "orchestrator", {
      actor: caller.internalUserId,
      serviceUser: serviceLogin,
      serviceInternalUserId,
    });
    // The request-token secret stays server-side: the exchange reads
    // it from the service login's record, so it is never returned.
    return Response.json({
      ok: true,
      authorizeUrl: result.authorizeUrl,
      serviceUser: serviceLogin,
      serviceInternalUserId,
    });
  } catch (err: any) {
    return Response.json({ error: err.message || "Failed to initiate E*TRADE OAuth", code: err.code }, { status: 500 });
  }
}

async function completeServiceEtradeAuth(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  request: Request,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response> {
  const serviceLoginOrError = resolveServiceLoginForEtrade(ctx);
  if (serviceLoginOrError instanceof Response) return serviceLoginOrError;
  const serviceLogin = serviceLoginOrError;
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  const session = await resolveActingSession(request, ctx);
  if (!session) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const denied = await requireServiceEtradePep(caller, ctx, session);
  if (denied) return denied;
  const verifier = typeof body.verifier === "string" ? body.verifier.trim() : "";
  if (!verifier) return jsonError("Verifier PIN is required", 400);
  try {
    const tokens = await exchangeETradeVerifier(
      ctx.env,
      serviceLogin,
      verifier,
      undefined,
      undefined,
      etradeReqEnv(request, url),
      { internalUserId: serviceInternalUserId },
    );
    ctx.audit("service_user.etrade_auth_completed", "orchestrator", {
      actor: caller.internalUserId,
      serviceUser: serviceLogin,
      serviceInternalUserId,
    });
    return Response.json({
      ok: true,
      serviceUser: serviceLogin,
      serviceInternalUserId,
      environment: tokens.environment,
      storedAt: tokens.storedAt,
    });
  } catch (err: any) {
    return Response.json({ error: err.message || "Failed to exchange verifier", code: err.code }, { status: 400 });
  }
}

async function revokeServiceEtradeToken(
  caller: Caller,
  ctx: ServiceUserRouteContext,
  request: Request,
  url: URL,
): Promise<Response> {
  const serviceLoginOrError = resolveServiceLoginForEtrade(ctx);
  if (serviceLoginOrError instanceof Response) return serviceLoginOrError;
  const serviceLogin = serviceLoginOrError;
  const serviceInternalUserId = serviceUserInternalUserId(serviceLogin);
  // The identity deletes the service login's full resolved key set
  // — login + internal-id + alias — and nothing else; the owner's
  // token is never in that set.
  const result = await revokeRemoteAccessToken(
    ctx.env,
    serviceLogin,
    etradeReqEnv(request, url),
    { internalUserId: serviceInternalUserId },
  );
  if (result.deleted) {
    ctx.audit("service_user.etrade_revoked", "orchestrator", {
      actor: caller.internalUserId,
      serviceUser: serviceLogin,
      serviceInternalUserId,
    });
  }
  return Response.json({
    ok: true,
    deleted: result.deleted,
    serviceUser: serviceLogin,
    serviceInternalUserId,
    message: result.message,
  });
}

export async function handleServiceUserRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ServiceUserRouteContext,
): Promise<Response | null> {
  void sessionId;
  // Issue #2681 token routes. Checked before the provision/revoke/
  // status dispatch; an unknown tokens sub-path returns null so the
  // DO chain keeps routing (no route hijack).
  if (
    path.endsWith("/admin/service-user/tokens") ||
    path.includes("/admin/service-user/tokens/")
  ) {
    let tokenAction: "mint" | "list" | "rotate" | "revoke" | null = null;
    if (path.endsWith("/admin/service-user/tokens")) {
      tokenAction = request.method === "GET" ? "list" : "mint";
    } else if (path.endsWith("/admin/service-user/tokens/rotate")) {
      tokenAction = "rotate";
    } else if (path.endsWith("/admin/service-user/tokens/revoke")) {
      tokenAction = "revoke";
    } else {
      return null;
    }
    if (tokenAction === "list" && request.method !== "GET") {
      return jsonError("Method not allowed", 405);
    }
    if (tokenAction !== "list" && request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }
    try {
      const caller = await resolveCaller(request, ctx);
      if (caller instanceof Response) return caller;
      if (tokenAction === "list") {
        return listTokensRoute(ctx);
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (tokenAction === "mint") return mintTokenRoute(caller, ctx, body);
      if (tokenAction === "rotate") return rotateTokenRoute(caller, ctx, body);
      return revokeTokenRoute(caller, ctx, body);
    } catch {
      return jsonError("Service-token administration unavailable.", 500);
    }
  }
  // Issue #4988 (#945 Q10) — service-login E*TRADE authorization
  // routes. Checked before the provision/revoke/status dispatch;
  // an unknown etrade sub-path returns null so the DO chain keeps
  // routing (no route hijack).
  if (
    path.endsWith("/admin/service-user/etrade/start") ||
    path.endsWith("/admin/service-user/etrade/verifier") ||
    path.endsWith("/admin/service-user/etrade/revoke")
  ) {
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }
    try {
      const caller = await resolveCaller(request, ctx);
      if (caller instanceof Response) return caller;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (path.endsWith("/admin/service-user/etrade/start")) {
        return startServiceEtradeAuth(caller, ctx, request, url);
      }
      if (path.endsWith("/admin/service-user/etrade/verifier")) {
        return completeServiceEtradeAuth(caller, ctx, request, url, body);
      }
      return revokeServiceEtradeToken(caller, ctx, request, url);
    } catch {
      return jsonError("Service-user E*TRADE authorization unavailable.", 500);
    }
  }
  let action: "provision" | "revoke" | "status" | null = null;
  if (path.endsWith("/admin/service-user/provision")) {
    action = "provision";
  } else if (path.endsWith("/admin/service-user/revoke")) {
    action = "revoke";
  } else if (path.endsWith("/admin/service-user/status")) {
    action = "status";
  } else {
    return null;
  }
  if (action === "status" && request.method !== "GET") {
    return jsonError("Method not allowed", 405);
  }
  if (action !== "status" && request.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }
  try {
    const caller = await resolveCaller(request, ctx);
    if (caller instanceof Response) return caller;
    if (action === "status") {
      return statusServiceUser(caller, ctx);
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (action === "provision") {
      return provisionServiceUser(caller, ctx, body);
    }
    return revokeServiceUser(caller, ctx, body);
  } catch {
    return jsonError("Service-user administration unavailable.", 500);
  }
}
