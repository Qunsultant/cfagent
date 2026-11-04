/**
 * Delegation management routes (#3153, #945 Q8, owner directive
 * 2026-11-04: delegation wiring LIVE, Q8 definitions adopted).
 *
 * A wired user creates, lists, and revokes their OWN
 * delegations. Self-service only: there is no route capability
 * for minting a delegation as another principal, and revoking
 * another user's delegation is a 403. Creation is PDP-checked
 * through Slice 3 by delegation.ts itself (the delegator must
 * hold every delegated permission in the tenant); the route adds
 * one shape rule delegation.ts does not impose — the delegate
 * must be an agent id (`agent:<kind>:<slug>`) — because
 * enforcement runs through the agent-access gate, which
 * authorizes agent ids.
 *
 * - Gate: the caller's x-user-login header (set by the Worker
 *   from the verified session, same trust as the schedules and
 *   service-user routes) is resolved to an internalUserId
 *   through the wired-login alias record. No membership role is
 *   required to manage one's own delegations: the PDP check at
 *   creation is the authorization. A caller without an alias
 *   has no wired identity and is refused, the same way legacy
 *   sessions are refused by the #1758 admin routes. A
 *   service-token caller is refused outright: tokens never
 *   administer delegations.
 * - Creation: createDelegation, so a PDP failure writes nothing
 *   and surfaces as DELEGATOR_LACKS_PERMISSION. The delegation
 *   budget is an action count only; maxCost is a future
 *   requirement, not accepted here.
 * - Revocation: revokeDelegation plus the grant cascade
 *   (revokeGrantsForDelegation). The gate denies on the
 *   delegation re-check even without the cascade, so the
 *   cascade is cleanup, not the bound — same rule as #2171.
 *   Revoking an already-revoked delegation is an idempotent
 *   no-op that changes and emits nothing.
 * - Audit: every actual create and every actual revoke emits
 *   one event through the orchestrator audit funnel (ctx.audit).
 *   Reads (list) emit nothing.
 * - Enforcement, stated plainly: these routes mint the
 *   delegation records; the agent-access gate enforces them at
 *   invocation (re-check, budget consumption, approval binding).
 *   Minting a delegation grants nothing by itself until an
 *   agent grant backs an invocation through that gate.
 */

import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { isLoginShaped } from "../../security/serviceIdentity";
import { sessionStore } from "../../security/session";
import {
  createDelegation,
  revokeDelegation,
  type DelegationStore,
} from "../../security/delegation";
import {
  createKvAgentGrantStore,
  createKvDelegationStore,
  parseAgentIdentityId,
  revokeGrantsForDelegation,
  type AgentGrantStore,
} from "../../security/agentAccess";
import {
  PERMISSIONS,
  type MembershipStore,
  type Permission,
} from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";

export interface DelegationRouteContext {
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
  /** Test seam: use this store instead of the SessionStore KV store. */
  delegationStore?: DelegationStore;
  /** Test seam: use this store instead of the SessionStore KV store. */
  grantStore?: AgentGrantStore;
  /** Test seam: use this KV instead of the SessionStore KV for aliases. */
  aliasKv?: KvLike;
}

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
  membershipStore: MembershipStore;
  delegationStore: DelegationStore;
  grantStore: AgentGrantStore;
}

/** Shared gate: wired session only, never a service token. */
export async function resolveDelegationCaller(
  request: Request,
  ctx: DelegationRouteContext,
): Promise<Caller | Response> {
  // Service-token callers never administer delegations: tokens
  // never administer tokens or the authority derived from them.
  if (request.headers.get("x-principal-kind") === "service-token") {
    return jsonError("Forbidden: service-token callers cannot administer delegations.", 403);
  }
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  if (!internalUserId) {
    return jsonError(
      "Forbidden: delegation administration requires a wired session.",
      403,
    );
  }
  return {
    login,
    internalUserId,
    membershipStore: ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env)),
    delegationStore: ctx.delegationStore ?? createKvDelegationStore(sessionStore(ctx.env)),
    grantStore: ctx.grantStore ?? createKvAgentGrantStore(sessionStore(ctx.env)),
  };
}

async function createDelegationRoute(
  caller: Caller,
  ctx: DelegationRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const delegate = body.delegateAgentId;
  if (typeof delegate !== "string" || parseAgentIdentityId(delegate) === null) {
    return jsonError("delegateAgentId must be an agent id (agent:<kind>:<slug>).", 400);
  }
  if (!isTenantShaped(body.tenantId)) {
    return jsonError("tenantId is required and must be a shaped string.", 400);
  }
  const tenantId = (body.tenantId as string).trim();
  if (
    !Array.isArray(body.allowedActions) ||
    body.allowedActions.length === 0 ||
    !body.allowedActions.every(
      (a) => typeof a === "string" && (PERMISSIONS as readonly string[]).includes(a),
    )
  ) {
    return jsonError("allowedActions must be a non-empty array of known permissions.", 400);
  }
  if (
    body.resourceScope !== undefined &&
    (!Array.isArray(body.resourceScope) ||
      !body.resourceScope.every((r) => typeof r === "string"))
  ) {
    return jsonError("resourceScope must be an array of strings.", 400);
  }
  const nowMs = Date.now();
  if (typeof body.expiresAtMs !== "number" || body.expiresAtMs <= nowMs) {
    return jsonError("expiresAtMs must be a future timestamp.", 400);
  }
  let budget: { maxActions?: number } | undefined;
  if (body.budget !== undefined) {
    const raw = body.budget as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) {
      return jsonError("budget must be an object.", 400);
    }
    if (
      raw.maxActions !== undefined &&
      (typeof raw.maxActions !== "number" ||
        !Number.isInteger(raw.maxActions) ||
        raw.maxActions < 0)
    ) {
      return jsonError("budget.maxActions must be a non-negative integer.", 400);
    }
    budget = { maxActions: raw.maxActions as number | undefined };
  }
  if (body.reDelegationAllowed !== undefined && typeof body.reDelegationAllowed !== "boolean") {
    return jsonError("reDelegationAllowed must be a boolean.", 400);
  }
  if (body.taskId !== undefined && typeof body.taskId !== "string") {
    return jsonError("taskId must be a string.", 400);
  }
  const result = await createDelegation(caller.membershipStore, caller.delegationStore, {
    delegatorInternalUserId: caller.internalUserId,
    delegateAgentId: (delegate as string).trim(),
    tenantId,
    allowedActions: body.allowedActions as Permission[],
    resourceScope: ((body.resourceScope ?? []) as string[]).map((r) => r.trim()),
    expiresAtMs: body.expiresAtMs as number,
    budget,
    reDelegationAllowed: body.reDelegationAllowed === true,
    nowMs,
    taskId: typeof body.taskId === "string" ? body.taskId.trim() : undefined,
  });
  if (!result.ok) {
    return Response.json({ error: result.error, code: result.code }, { status: 400 });
  }
  ctx.audit("delegation.created", "orchestrator", {
    delegationId: result.delegation.id,
    delegator: caller.internalUserId,
    delegateAgentId: result.delegation.delegateAgentId,
    tenantId,
  });
  return Response.json({ ok: true, delegation: result.delegation }, { status: 201 });
}

async function listDelegationsRoute(caller: Caller): Promise<Response> {
  const delegations = await caller.delegationStore.listByDelegator(caller.internalUserId);
  return Response.json({ delegations });
}

async function revokeDelegationRoute(
  caller: Caller,
  ctx: DelegationRouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const delegationId =
    typeof body.delegationId === "string" ? body.delegationId.trim() : "";
  if (!delegationId) {
    return jsonError("delegationId is required.", 400);
  }
  const delegation = await caller.delegationStore.get(delegationId);
  if (!delegation) {
    return jsonError("Unknown delegation.", 404);
  }
  if (delegation.delegatorInternalUserId !== caller.internalUserId) {
    return jsonError("Forbidden: only the delegator may revoke a delegation.", 403);
  }
  if (delegation.revoked) {
    return Response.json({ ok: true, alreadyRevoked: true, delegationId });
  }
  const nowMs = Date.now();
  const revoked = await revokeDelegation(caller.delegationStore, delegationId, nowMs);
  if (!revoked) {
    return jsonError("Delegation could not be revoked.", 500);
  }
  const grantsRevoked = await revokeGrantsForDelegation(
    caller.delegationStore,
    caller.grantStore,
    delegationId,
    nowMs,
  );
  ctx.audit("delegation.revoked", "orchestrator", {
    delegationId,
    delegator: caller.internalUserId,
    grantsRevoked,
  });
  return Response.json({ ok: true, revoked: true, delegationId, grantsRevoked });
}

export async function handleDelegationRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: DelegationRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  let action: "create" | "revoke" | "list" | null = null;
  if (path.endsWith("/api/iaaa/delegations/create")) {
    action = "create";
  } else if (path.endsWith("/api/iaaa/delegations/revoke")) {
    action = "revoke";
  } else if (path.endsWith("/api/iaaa/delegations")) {
    action = "list";
  } else {
    return null;
  }
  if (action === "list" && request.method !== "GET") {
    return jsonError("Method not allowed", 405);
  }
  if (action !== "list" && request.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }
  try {
    const caller = await resolveDelegationCaller(request, ctx);
    if (caller instanceof Response) return caller;
    if (action === "list") {
      return listDelegationsRoute(caller);
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (action === "create") {
      return createDelegationRoute(caller, ctx, body);
    }
    return revokeDelegationRoute(caller, ctx, body);
  } catch {
    return jsonError("Delegation administration unavailable.", 500);
  }
}
