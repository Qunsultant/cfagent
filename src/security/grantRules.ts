/**
 * Issue #3155 (parent #945, Q9) — grant-rule mechanics, LIVE.
 *
 * Owner directive 2026-11-04 ("don't hold off on anything... full
 * development, deployment, and enablement (ON)") adopts these rules
 * as live behavior; there is no flag gate and no flag-off path.
 * The rules were proposed in #945 comment 6630444615 and adopted by
 * that directive (recorded on #3155 as comment 6630909319).
 *
 * The three rules:
 * 1. Second approver: a tenant-admin or platform-admin grant mints
 *    only after two DISTINCT approvers have approved it. The
 *    proposal store (grantProposals.ts) carries the approvers; the
 *    routes enforce the count. Non-admin grants are unaffected.
 * 2. Default expiry: a non-platform-scope binding without an
 *    explicit expiresAtMs is stamped with nowMs + default days
 *    (adopted initial value 90 days for tenant grants, configurable
 *    via IAAA_GRANT_DEFAULT_EXPIRY_DAYS, never hardcoded at a use
 *    site). Platform-scope bindings are untouched, and genesis
 *    grants are exempt by construction: the bootstrap path calls
 *    createMembership directly and never passes through
 *    grantMembership, where the default is applied.
 * 3. Granter-review queue: grants whose granter of record
 *    (Membership.createdBy) is fully revoked are listed for review.
 *    Grants themselves are NOT cascade-revoked. The single
 *    exception, applied at revoke time: a grant that violates the
 *    grant matrix on its face is revoked with the granter (see
 *    grantBindingViolatesMatrix).
 *
 * Coverage boundary, stated plainly: second-approver enforcement
 * lives on the live grant surfaces — POST /api/iaaa/membership/grant,
 * POST /api/iaaa/role-grants/grant, POST /api/iaaa/membership/edit,
 * and POST /api/iaaa/access-request/decision. The grantMembership
 * seam itself stays the minting path (canGrantRole + expiry); a
 * future direct-seam caller that mints admin roles must route
 * through the proposal flow, or it bypasses the approver rule.
 * Service-user provisioning grants the member role only, so it is
 * outside the approver rule; the membership/edit surface is inside
 * it. The review queue's granter of record is Membership.createdBy
 * (one granter per membership); co-approvers are preserved on the
 * proposal / access-request record for audit, and do not by
 * themselves put a grant in the queue.
 *
 * Known interaction, not fixed here: service dispatch checks
 * membership liveness by revokedAtMs only (serviceDispatch.ts), so
 * a default-expired tenant-tier service membership still dispatches
 * until revoked. Expiry-aware dispatch is a separate slice.
 */

import type { Membership, MembershipStore, RoleBinding } from "./authorization";

/** Admin roles whose grants require two distinct approvers. */
export const ADMIN_GRANT_ROLES: readonly string[] = ["tenant-admin", "platform-admin"];

/** Adopted initial default grant lifetime, in days, for tenant grants. */
export const DEFAULT_GRANT_EXPIRY_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** True when any binding in the grant carries an admin role. */
export function isAdminRoleGrant(
  bindings: Array<{ role: string }>,
): boolean {
  return bindings.some((b) => (ADMIN_GRANT_ROLES as readonly string[]).includes(b.role));
}

/**
 * Resolve the default grant lifetime from an operator override,
 * mirroring resolveWiredFreshnessMs. A positive finite integer wins;
 * anything else (unset, empty, non-numeric, zero, negative,
 * non-finite) falls back to the adopted default, so a typo can
 * neither disable the default nor invent a lifetime. Zero never
 * means "no expiry": unbounded tenant grants are exactly what the
 * default exists to prevent.
 */
export function resolveGrantDefaultExpiryDays(
  rawOverride: string | number | undefined | null,
): number {
  if (typeof rawOverride === "number") {
    return Number.isFinite(rawOverride) && rawOverride > 0
      ? Math.floor(rawOverride)
      : DEFAULT_GRANT_EXPIRY_DAYS;
  }
  if (typeof rawOverride === "string" && rawOverride.trim() !== "") {
    const parsed = Number(rawOverride.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_GRANT_EXPIRY_DAYS;
}

/**
 * Stamp the adopted default expiry onto bindings that lack one.
 * Non-platform-scope bindings without an explicit expiresAtMs get
 * nowMs + defaultDays; platform-scope bindings and bindings with an
 * explicit expiry are returned untouched. Never mutates its input.
 */
export function applyDefaultGrantExpiry(
  bindings: RoleBinding[],
  nowMs: number,
  defaultDays: number,
): RoleBinding[] {
  return bindings.map((b) => {
    if (b.scope === "platform" || b.expiresAtMs !== undefined) return { ...b };
    return { ...b, expiresAtMs: nowMs + defaultDays * MS_PER_DAY };
  });
}

/**
 * Binding identity for proposal matching: same set of
 * (role, scope, workspaceId) tuples, order-insensitive.
 */
export type GrantBindingKey = Pick<RoleBinding, "role" | "scope" | "workspaceId">;

function bindingKey(b: GrantBindingKey): string {
  return `${b.role}|${b.scope}|${b.workspaceId ?? ""}`;
}

export function bindingsEqual(a: GrantBindingKey[], b: GrantBindingKey[]): boolean {
  if (a.length !== b.length) return false;
  const aKeys = a.map(bindingKey).sort();
  const bKeys = b.map(bindingKey).sort();
  return aKeys.every((k, i) => k === bKeys[i]);
}

/**
 * Face-value matrix check for the granter-revocation pass: could the
 * granter have granted this binding at all, judging by the granter's
 * RECORDED bindings (revocation ignored — the granter is being
 * revoked, so live-only bindings would fail everything and cascade
 * the whole set, which the rule forbids) that were active at the
 * grant's creation time (expiry respected — an already-expired
 * binding granted nothing).
 *
 * Required granter role by binding scope: platform scope or the
 * platform-admin role requires a platform-admin binding; tenant
 * scope requires a tenant-admin binding in the same tenant;
 * workspace scope requires a tenant-admin binding in the same tenant
 * or a workspace-admin binding in the same tenant and workspace;
 * resource scope is treated as tenant scope. Anything else is a
 * face-value violation: the grant should never have minted, so it
 * is revoked with the granter instead of queued for review.
 */
export function grantBindingViolatesMatrix(
  binding: RoleBinding,
  grantTenantId: string,
  granterMemberships: Membership[],
  grantCreatedAtMs: number,
): boolean {
  const granterBindings: Array<{ role: string; scope: string; tenantId: string; workspaceId?: string }> = [];
  for (const m of granterMemberships) {
    for (const b of m.roleBindings) {
      if (b.expiresAtMs !== undefined && b.expiresAtMs <= grantCreatedAtMs) continue;
      granterBindings.push({
        role: b.role,
        scope: b.scope,
        tenantId: m.tenantId,
        workspaceId: b.workspaceId ?? m.workspaceId,
      });
    }
  }
  if (binding.role === "platform-admin" || binding.scope === "platform") {
    return !granterBindings.some((b) => b.role === "platform-admin" && b.scope === "platform");
  }
  if (binding.scope === "workspace") {
    const workspaceId = binding.workspaceId;
    return !granterBindings.some(
      (b) =>
        b.tenantId === grantTenantId &&
        (b.role === "tenant-admin" ||
          (b.role === "workspace-admin" && workspaceId !== undefined && b.workspaceId === workspaceId)),
    );
  }
  return !granterBindings.some((b) => b.tenantId === grantTenantId && b.role === "tenant-admin");
}

export interface ReviewQueueItem {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  roleBindings: RoleBinding[];
  createdBy: string;
  createdAtMs: number;
  reason: "granter-revoked";
}

/**
 * The granter-review queue, computed from a full membership listing:
 * live memberships (unrevoked, with at least one unexpired binding)
 * whose granter of record (createdBy) is FULLY revoked — the granter
 * holds at least one membership record and every one is revoked.
 * A granter with no membership records at all (including
 * "system:bootstrap", which holds none) is not "revoked", so
 * genesis grants never queue. The queue clears when the grant is
 * revoked; there is no mark-reviewed state in this slice, by
 * design: a grant by a revoked granter stays flagged until action.
 */
export function listGrantsForReview(
  allMemberships: Membership[],
  nowMs: number,
): ReviewQueueItem[] {
  const byUser = new Map<string, Membership[]>();
  for (const m of allMemberships) {
    const list = byUser.get(m.internalUserId) ?? [];
    list.push(m);
    byUser.set(m.internalUserId, list);
  }
  const fullyRevoked = new Set<string>();
  for (const [userId, memberships] of byUser) {
    if (memberships.length > 0 && memberships.every((m) => m.revokedAtMs !== undefined)) {
      fullyRevoked.add(userId);
    }
  }
  const queue: ReviewQueueItem[] = [];
  for (const m of allMemberships) {
    if (m.revokedAtMs !== undefined) continue;
    if (!fullyRevoked.has(m.createdBy)) continue;
    if (!m.roleBindings.some((b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs)) continue;
    queue.push({
      membershipId: m.membershipId,
      internalUserId: m.internalUserId,
      tenantId: m.tenantId,
      roleBindings: m.roleBindings.map((b) => ({ ...b })),
      createdBy: m.createdBy,
      createdAtMs: m.createdAtMs,
      reason: "granter-revoked",
    });
  }
  return queue;
}

export interface GranterRevocationPassResult {
  /** Live grants by the revoked granter examined. */
  reviewed: number;
  /** Matrix-violating bindings removed. */
  revokedBindings: number;
  /** Membership ids revoked because the pass emptied them. */
  revokedMemberships: string[];
  /** True when the pass did not run (user still holds a live membership). */
  skipped: boolean;
}

/**
 * Revoke-time pass, run after a membership revoke leaves the revoked
 * user with no live memberships. For each live membership the user
 * granted, bindings that violate the grant matrix on their face
 * (grantBindingViolatesMatrix) are removed; a membership emptied by
 * removal is revoked, otherwise it is re-put. Valid grants are left
 * untouched — they surface in the review queue instead. The pass
 * never fails the enclosing revoke: a listing failure is the
 * caller's to report, and this function only runs on a listing the
 * caller already holds.
 */
export async function runGranterRevocationPass(opts: {
  store: MembershipStore;
  allMemberships: Membership[];
  revokedUserId: string;
  nowMs: number;
}): Promise<GranterRevocationPassResult> {
  const { store, allMemberships, revokedUserId, nowMs } = opts;
  const stillLive = (await store.getMembershipsByUser(revokedUserId)).some(
    (m) => m.revokedAtMs === undefined,
  );
  if (stillLive) {
    return { reviewed: 0, revokedBindings: 0, revokedMemberships: [], skipped: true };
  }
  const granterMemberships = allMemberships.filter((m) => m.internalUserId === revokedUserId);
  const result: GranterRevocationPassResult = {
    reviewed: 0,
    revokedBindings: 0,
    revokedMemberships: [],
    skipped: false,
  };
  for (const m of allMemberships) {
    if (m.revokedAtMs !== undefined) continue;
    if (m.createdBy !== revokedUserId) continue;
    result.reviewed += 1;
    const violating = m.roleBindings.filter((b) =>
      grantBindingViolatesMatrix(b, m.tenantId, granterMemberships, m.createdAtMs),
    );
    if (violating.length === 0) continue;
    const remaining = m.roleBindings.filter(
      (b) => !grantBindingViolatesMatrix(b, m.tenantId, granterMemberships, m.createdAtMs),
    );
    result.revokedBindings += violating.length;
    if (remaining.length === 0) {
      await store.revokeMembership(m.membershipId, nowMs);
      result.revokedMemberships.push(m.membershipId);
    } else {
      await store.put({ ...m, roleBindings: remaining });
    }
  }
  return result;
}
