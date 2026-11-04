/**
 * User administration routes (#2220, program #2218 slice 2).
 *
 * READ-ONLY views over data that already exists elsewhere — this
 * module invents no user store, writes no IAAA state, and changes
 * no account. What it shows, and where each piece comes from:
 * - Profile display (verified-login identity) + account linkage:
 *   resolvePlatformIdentity (slice 1, src/services/platformIdentity)
 *   over the commercial + subscription ports. The account block
 *   is the stored commercial row; the tier shown is the effective
 *   tier at read time (a lapsed subscription stops conferring
 *   Subscribed, exactly as on the payment screen).
 * - Tenant membership view: the IAAA membership store read path
 *   (the same read the IAAA panel renders), mapped to a view that
 *   carries no grant internals. Revoked rows stay visible with
 *   their revoked time — a revoked membership is history, not a
 *   missing row.
 *
 * Scoping (session-scoped ALWAYS, the #2231 correction):
 * - The self view takes its subject from the verified session
 *   login only. It reads no userId parameter, no body field, and
 *   no client-supplied tenantId — a request cannot redirect it
 *   to another user, and the tenant it shows is the tenant of
 *   the caller's own stored record.
 * - The operator lookup takes a login as a lookup key, never as
 *   scope: the tenant shown is the target's stored tenant, and a
 *   tenantId parameter on the lookup is ignored outright.
 * - A login with no wired alias record still gets its
 *   identity/account view; its memberships read "unmapped"
 *   (disclosed, never guessed from another record).
 *
 * Gating:
 * - Self: any verified login (401 without one). No alias is
 *   required for the identity half; the membership half reports
 *   unmapped without one.
 * - Operator lookup: the IAAA panel's gate, reused — the caller
 *   resolves through the wired-login alias record to an
 *   internalUserId that must hold a live platform-admin
 *   membership (isPlatformAdmin). Tenant admins, unwired
 *   callers, and anonymous callers get 401/403 with no data.
 *   This is an admin-surface read, not a commercial money write,
 *   so the gate is platform-admin membership, not the
 *   COMMERCIAL_STORE_OPERATORS list (which gates money writes
 *   in the payment routes and would exclude the platform admins
 *   this panel is built for).
 * - Reads emit no audit events (the service-user status and
 *   tenant-queue preview rule); an unbound store answers 503
 *   rather than a guessed Free, and no schema is ensured on a
 *   read path (mirroring the pricing GET).
 */

import { createCommercialAdapter } from "../../data/createCommercialPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import {
  resolvePlatformIdentity,
  type PlatformIdentity,
} from "../../services/platformIdentity";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { isPlatformAdmin } from "../../security/iaaaAdminOverview";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { sessionStore } from "../../security/session";
import { isLoginShaped } from "../../security/serviceIdentity";
import type {
  Membership,
  MembershipStore,
} from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";

export interface PlatformUsersRouteContext {
  /** Worker env (carries the SESSION_STORE + AGENT_DB bindings). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). Reads emit nothing. */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: use these ports instead of the composition-root adapters. */
  commercial?: CommercialStore | null;
  /** Test seam: use these ports instead of the composition-root adapters. */
  subscriptions?: SubscriptionStore | null;
  /** Test seam: use this store instead of the SessionStore KV store. */
  membershipStore?: MembershipStore;
  /** Test seam: use this KV instead of the SessionStore KV for aliases. */
  aliasKv?: KvLike;
}

export interface PlatformUserMembershipView {
  membershipId: string;
  tenantId: string;
  roles: Array<{ role: string; scope: string }>;
  createdAtMs: number;
  revokedAtMs?: number;
}

export interface PlatformUserAccountView {
  tenantId: string;
  tier: string;
  creditsUSD: number;
  includedRuns: number;
  updatedAtMs: number;
}

export interface PlatformUserView {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
  membershipSource: "wired" | "unmapped";
  memberships: PlatformUserMembershipView[];
  account: PlatformUserAccountView | null;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function toMembershipView(membership: Membership): PlatformUserMembershipView {
  const view: PlatformUserMembershipView = {
    membershipId: membership.membershipId,
    tenantId: membership.tenantId,
    roles: membership.roleBindings.map((b) => ({ role: b.role, scope: b.scope })),
    createdAtMs: membership.createdAtMs,
  };
  if (membership.revokedAtMs !== undefined) {
    view.revokedAtMs = membership.revokedAtMs;
  }
  return view;
}

function resolvePorts(ctx: PlatformUsersRouteContext): {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
} {
  return {
    commercial:
      ctx.commercial !== undefined
        ? ctx.commercial
        : createCommercialAdapter(ctx.env as { AGENT_DB?: unknown }),
    subscriptions:
      ctx.subscriptions !== undefined
        ? ctx.subscriptions
        : createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown }),
  };
}

async function buildUserView(
  ctx: PlatformUsersRouteContext,
  login: string,
): Promise<PlatformUserView> {
  const ports = resolvePorts(ctx);
  const identity: PlatformIdentity = await resolvePlatformIdentity(
    { commercial: ports.commercial, subscriptions: ports.subscriptions },
    { userId: login, nowMs: Date.now() },
  );
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  let memberships: PlatformUserMembershipView[] = [];
  let membershipSource: "wired" | "unmapped" = "unmapped";
  if (internalUserId !== null) {
    const store =
      ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
    memberships = (await store.getMembershipsByUser(internalUserId)).map(
      toMembershipView,
    );
    membershipSource = "wired";
  }
  return {
    userLogin: identity.userLogin,
    tenantId: identity.tenantId,
    hasAccount: identity.hasAccount,
    tier: identity.tier,
    creditsUSD: identity.creditsUSD,
    includedRunsRemaining: identity.includedRunsRemaining,
    membershipSource,
    memberships,
    account: identity.stored
      ? {
          tenantId: identity.stored.tenantId,
          tier: identity.stored.tier,
          creditsUSD: identity.stored.creditsUSD,
          includedRuns: identity.stored.includedRuns,
          updatedAtMs: identity.stored.updatedAtMs,
        }
      : null,
  };
}

async function resolveOperatorCaller(
  request: Request,
  ctx: PlatformUsersRouteContext,
): Promise<string | Response> {
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  if (!internalUserId) {
    return jsonError(
      "Forbidden: user administration requires a wired session.",
      403,
    );
  }
  const store =
    ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
  const memberships = await store.getMembershipsByUser(internalUserId);
  if (!isPlatformAdmin(memberships, Date.now())) {
    return jsonError(
      "Forbidden: user administration requires platform-admin membership.",
      403,
    );
  }
  return login;
}

export async function handlePlatformUsersRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PlatformUsersRouteContext,
): Promise<Response | null> {
  void sessionId;
  let action: "me" | "lookup" | null = null;
  if (path.endsWith("/admin/platform-users/me")) {
    action = "me";
  } else if (path.endsWith("/admin/platform-users/lookup")) {
    action = "lookup";
  } else {
    return null;
  }
  if (request.method !== "GET") {
    return jsonError("Method not allowed", 405);
  }
  try {
    if (action === "me") {
      const login = request.headers.get("x-user-login") || "";
      if (!isLoginShaped(login)) {
        return jsonError("Unauthorized: a signed-in session is required.", 401);
      }
      return Response.json(await buildUserView(ctx, login));
    }
    const caller = await resolveOperatorCaller(request, ctx);
    if (caller instanceof Response) return caller;
    const targetLogin = url.searchParams.get("login") || "";
    if (!isLoginShaped(targetLogin)) {
      return jsonError("login is required and must be a shaped login.", 400);
    }
    return Response.json(await buildUserView(ctx, targetLogin));
  } catch {
    return jsonError("Platform user administration unavailable.", 503);
  }
}
