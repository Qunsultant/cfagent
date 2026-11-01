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
 *   membership (isPlatformAdmin). Anything else answers 403 with
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
 * - Audit: every actual grant and every actual revoke emits one
 *   event through the orchestrator audit funnel (ctx.audit).
 *   Idempotent no-ops (already provisioned, nothing to revoke)
 *   change nothing and emit nothing, the same rule as the
 *   maintenance preview. Reads (status) emit nothing.
 * - Provision is idempotent: re-provisioning an already active
 *   matching binding returns it instead of minting a duplicate.
 *   Revoke removes every active binding in the selected scope;
 *   offboard (no tier) removes all of them, any role, so no
 *   privilege survives offboarding.
 */

import { createKvMembershipStore, grantMembership } from "../../security/iaaaMembershipStore";
import { getStoredTokens } from "../../security/etradeOAuth";
import { isPlatformAdmin } from "../../security/iaaaAdminOverview";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import {
  getServiceUserLogin,
  isLoginShaped,
  serviceUserInternalUserId,
} from "../../security/serviceIdentity";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { sessionStore } from "../../security/session";
import {
  listServiceTokens,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
  serviceTokenStore,
  type ServiceTokenTier,
} from "../../security/serviceTokens";
import type { MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";

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
  const memberships = await store.getMembershipsByUser(internalUserId);
  if (!isPlatformAdmin(memberships, Date.now())) {
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
      `Authorize ${serviceLogin} once via the Connect E*TRADE flow so a stored token exists under its login.`,
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
  return Response.json({ ok: true, tokens });
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

export async function handleServiceUserRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ServiceUserRouteContext,
): Promise<Response | null> {
  void url;
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
