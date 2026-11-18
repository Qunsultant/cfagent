/**
 * #945 Wiring Phase 2b-part2 — PDP seam (NOT enforcement).
 *
 * This module answers one question — "does this internalUserId hold
 * this permission in this tenant?" — by reading memberships from a
 * MembershipStore and running Slice 3's authorize() PDP. It exists
 * so the later route-wiring step has a single, tested call site to
 * attach to, instead of each route re-deriving the check.
 *
 * GAP-1 (seam A, CISO coordination #5350, design #5343 / ADR 0034)
 * IS that later, separately reviewed step: the epic §8
 * precondition holds — the wiring phase 2b-part2 migration +
 * membership provisioning landed, and the blanket-member
 * integration:connect grant (#2450) plus the live
 * integration:connect gates prove provisioning is real — so route
 * handlers now attach to this seam. The wired call sites are the
 * platform-admin gates (checkPlatformPermission) in
 * src/security/iaaaAdminOverview.ts (buildAdminOverview, the shared
 * IAAA admin gate consumed by the admin routes in
 * src/server/routes/), src/server/routes/auth.ts (the SecHub
 * policy/PDP/PEP/PIP branch), and the resolveCaller gates in
 * src/agents/routes/adminTenantQueues.ts, kvWipe.ts,
 * platformUsers.ts, serviceUser.ts, and dataLifecycle.ts, plus the
 * pre-existing agent/obligation call sites below. Grepping for
 * checkPermission / checkPlatformPermission callers must return
 * only those gates, the agent/obligation call sites, and tests.
 * A route that needs a permission with no mapping yet does NOT
 * attach here on an invented mapping — the mapping is CISO's
 * (GAP-2 / slice 2), and the route keeps its existing gate until
 * the mapping exists.
 *
 * Default-deny is inherited from Slice 3, not re-implemented here:
 * unknown permissions, missing memberships, revoked memberships,
 * cross-tenant requests, and scope/resource mismatches all deny.
 * Identity is always the Slice 1 internal user id; a login is
 * never an input to this function. Store/PDP errors propagate to
 * the caller: the handler maps them to a 500 with no data, which
 * is fail-closed — no access is ever granted without an explicit
 * PDP allow.
 */

import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  membershipStoreToAttributeProvider,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type MembershipStore,
} from "./authorization";

export interface CheckPermissionInput {
  internalUserId: string;
  tenantId: string;
  permission: AuthorizationRequest["permission"];
  scope?: AuthorizationRequest["scope"];
  resourceScope?: AuthorizationRequest["resourceScope"];
  nowMs: number;
}

/**
 * PDP decision for one permission check. Allow iff Slice 3 allows.
 * #1755: signature unchanged; internally the check now routes
 * through the PIP port (store adapted to a provider) and the
 * compiled policy snapshot, so the seam consumes the same PDP core
 * as the port-based callers. Decisions are identical.
 */
export async function checkPermission(
  store: MembershipStore,
  input: CheckPermissionInput,
): Promise<AuthorizationDecision> {
  return authorizeWithPolicy(
    getCompiledPolicySnapshot(),
    membershipStoreToAttributeProvider(store),
    {
      actorInternalUserId: input.internalUserId,
      tenantId: input.tenantId,
      permission: input.permission,
      scope: input.scope,
      resourceScope: input.resourceScope,
      nowMs: input.nowMs,
    },
  );
}

export interface CheckPlatformPermissionInput {
  internalUserId: string;
  permission: AuthorizationRequest["permission"];
  nowMs: number;
}

/**
 * GAP-1 (seam A, #5350): platform-scope PDP consultation for route
 * handlers. Platform scope is platform-wide, not tenant-scoped, so
 * this consultation takes no tenantId — the PDP's platform branch
 * ignores it, exactly as canGrantRole's platform branch passes
 * tenantId: undefined. Allow iff Slice 3 allows at platform scope:
 * a live, unrevoked, unexpired platform-admin binding at platform
 * scope holding the permission. The platform-admin grants are
 * role:assign, audit:read, and audit:export; every wired gate
 * passes role:assign, the platform-privilege grant, so the
 * decision is exactly "holds live platform-admin membership" —
 * behavior-identical to the isPlatformAdmin predicate this
 * consultation replaces at the wired gates. Per-surface permission
 * mapping is CISO follow-up (GAP-2 / slice 2), not invented here:
 * this slice changes the enforcement mechanism, not the policy.
 * Fail-closed per the #5350 contract: an invalid actor, an unknown
 * permission, or no live platform-admin binding denies; a
 * store/PDP error propagates to the handler, which answers 500
 * with no data — no access without an explicit allow.
 */
export async function checkPlatformPermission(
  store: MembershipStore,
  input: CheckPlatformPermissionInput,
): Promise<AuthorizationDecision> {
  return authorizeWithPolicy(
    getCompiledPolicySnapshot(),
    membershipStoreToAttributeProvider(store),
    {
      actorInternalUserId: input.internalUserId,
      tenantId: undefined,
      permission: input.permission,
      scope: "platform",
      nowMs: input.nowMs,
    },
  );
}
