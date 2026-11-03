/**
 * Issue #2688 — human role grants: platform-admin and tenant-admin
 * assignment (provider-agnostic), the human counterpart to the
 * #2681 service-token role assignment.
 *
 * ONE role model, no second role system: the catalog is ALL_ROLES
 * from authorization.ts. ROLE_GRANT_ROLES is a filter of that
 * catalog (the two admin roles this surface may assign), computed
 * here — never a re-declared list. Server-side validation checks
 * every requested role against ALL_ROLES first, then against this
 * filter; client role lists are presentations of it, never
 * enforcement points.
 *
 * What this module adds over the #1758 membership routes (which
 * grant/revoke whole memberships for any role):
 * - Per-binding flattening: one row per admin binding, carrying
 *   who granted it (grantedBy) and when (the membership's
 *   createdAtMs) — the Members tab shows neither.
 * - Per-binding revoke: removing one admin role without revoking
 *   the whole membership and its sibling bindings. Effect is
 *   immediate because every PDP read re-reads the store fresh.
 * - The grant/revoke gates themselves are NOT re-implemented:
 *   canGrantRole decides both (revoke mirrors grant — only a
 *   granter who could grant the role may revoke it), and the
 *   route adds its own granter ≠ target refusal for grants, the
 *   same pattern as #2681's mint route.
 *
 * Slice 3 policy, stated plainly because the issue body's
 * shorthand ("granted by a platform admin") does not override it:
 * a platform-admin is NOT a tenant superuser. A platform-admin
 * grants platform-admin; a tenant-admin grant requires the
 * granter to hold role:assign in that tenant — a tenant-admin of
 * that tenant, or a platform-admin who also holds tenant-admin
 * there. canGrantRole is the authority; this module never widens
 * it. The first platform admin comes from owner-controlled
 * bootstrap genesis (a `platform:` entry in IAAA_BOOTSTRAP_ADMINS,
 * claimed once via the genesis marker in iaaaGithubEndToEnd.ts);
 * after genesis, only an existing platform-admin grants
 * platform-admin. Admin signup is never open self-service, and a
 * fresh login via any provider holds no admin role until granted.
 */

import {
  ALL_ROLES,
  canGrantRole,
  type AuthorizationDecision,
  type AuthorizationScope,
  type Membership,
  type MembershipStore,
  type Role,
} from "./authorization";

/**
 * The grantable set for this surface: ALL_ROLES filtered to the
 * two admin roles. Computed, not declared — a catalog change in
 * authorization.ts flows through here automatically.
 */
export const ROLE_GRANT_ROLES: readonly Role[] = ALL_ROLES.filter(
  (role): role is "platform-admin" | "tenant-admin" =>
    role === "platform-admin" || role === "tenant-admin",
);

export type RoleGrantRole = (typeof ROLE_GRANT_ROLES)[number];

/** One admin binding, flattened for list/grant/revoke surfaces. */
export interface RoleGrantView {
  /** `${membershipId}:${bindingIndex}` — stable within a membership. */
  grantId: string;
  membershipId: string;
  bindingIndex: number;
  internalUserId: string;
  tenantId: string;
  role: Role;
  scope: AuthorizationScope;
  grantedBy: string;
  /** Membership createdAtMs: when this binding was granted. */
  grantedAtMs: number;
  /** True once the whole membership is revoked. */
  revoked: boolean;
  expiresAtMs?: number;
}

export function toRoleGrantView(
  membership: Membership,
  bindingIndex: number,
): RoleGrantView | null {
  const binding = membership.roleBindings[bindingIndex];
  if (!binding) return null;
  if (!(ROLE_GRANT_ROLES as readonly string[]).includes(binding.role)) return null;
  return {
    grantId: `${membership.membershipId}:${bindingIndex}`,
    membershipId: membership.membershipId,
    bindingIndex,
    internalUserId: membership.internalUserId,
    tenantId: membership.tenantId,
    role: binding.role,
    scope: binding.scope,
    grantedBy: binding.grantedBy,
    grantedAtMs: membership.createdAtMs,
    revoked: membership.revokedAtMs !== undefined,
    ...(binding.expiresAtMs !== undefined ? { expiresAtMs: binding.expiresAtMs } : {}),
  };
}

/** Every admin binding across the given memberships, flattened. */
export function flattenRoleGrants(memberships: Membership[]): RoleGrantView[] {
  const rows: RoleGrantView[] = [];
  for (const membership of memberships) {
    for (let i = 0; i < membership.roleBindings.length; i++) {
      const view = toRoleGrantView(membership, i);
      if (view) rows.push(view);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Grant validation (pure; the route still runs canGrantRole + the
// obligation channel before writing anything)
// ---------------------------------------------------------------------------

export type RoleGrantValidationCode =
  | "SELF_GRANT"
  | "INVALID_ROLE"
  | "ROLE_NOT_GRANTABLE"
  | "INVALID_TENANT_ID";

export type RoleGrantValidation =
  | {
      ok: true;
      role: RoleGrantRole;
      scope: AuthorizationScope;
      /** Platform grants record the resolved tenant; the PDP ignores it for platform scope. */
      tenantId: string;
    }
  | { ok: false; code: RoleGrantValidationCode; error: string };

export interface ValidateRoleGrantInput {
  granterInternalUserId: string;
  targetInternalUserId: string;
  role: string;
  /** Tenant for a tenant-admin grant; defaults to the resolved tenant. */
  tenantId?: string;
  resolvedTenantId: string;
}

export function validateRoleGrantRequest(
  input: ValidateRoleGrantInput,
): RoleGrantValidation {
  const granter = input.granterInternalUserId.trim();
  const target = input.targetInternalUserId.trim();
  if (target === "" || granter === "") {
    return { ok: false, code: "INVALID_TENANT_ID", error: "granter and target are required." };
  }
  // Route-level self-grant refusal: canGrantRole alone does not
  // compare granter to target, so this comparison lives here and
  // at the route — the same pattern as #2681's mint route.
  if (target === granter) {
    return {
      ok: false,
      code: "SELF_GRANT",
      error: "Self-grant is forbidden: another admin must grant your roles.",
    };
  }
  const role = input.role.trim();
  if (!(ALL_ROLES as readonly string[]).includes(role)) {
    return { ok: false, code: "INVALID_ROLE", error: `unknown role: ${role}` };
  }
  if (!(ROLE_GRANT_ROLES as readonly string[]).includes(role)) {
    return {
      ok: false,
      code: "ROLE_NOT_GRANTABLE",
      error: `role ${role} is not grantable through the role-grants surface.`,
    };
  }
  if (role === "platform-admin") {
    return { ok: true, role, scope: "platform", tenantId: input.resolvedTenantId };
  }
  const tenantId = (input.tenantId ?? "").trim() || input.resolvedTenantId.trim();
  if (tenantId === "") {
    return { ok: false, code: "INVALID_TENANT_ID", error: "a tenant id is required for tenant-admin grants." };
  }
  return { ok: true, role: "tenant-admin", scope: "tenant", tenantId };
}

// ---------------------------------------------------------------------------
// Revoke gate + per-binding revoke
// ---------------------------------------------------------------------------

export interface RevokeRoleGrantInput {
  revokerInternalUserId: string;
  grant: RoleGrantView;
  nowMs: number;
}

/**
 * Revoke mirrors grant: only a granter who could grant this role,
 * in this scope and tenant, may revoke it. A platform-admin
 * revokes platform grants; a tenant-admin revokes tenant grants
 * in their own tenant only; cross-tenant revokes deny. Self-revoke
 * is NOT refused here: removing one's own privilege is
 * de-escalation, never escalation, and it is audited like any
 * other revoke.
 */
export async function canRevokeRoleGrant(
  store: MembershipStore,
  input: RevokeRoleGrantInput,
): Promise<AuthorizationDecision> {
  return canGrantRole(store, {
    granterInternalUserId: input.revokerInternalUserId,
    targetTenantId: input.grant.tenantId,
    targetScope: input.grant.scope,
    targetRole: input.grant.role,
    nowMs: input.nowMs,
  });
}

export type RemoveRoleBindingResult =
  | { ok: true; membership: Membership; emptied: boolean }
  | { ok: false; code: "INVALID_INDEX" | "NOT_ADMIN_BINDING"; error: string };

/**
 * Pure per-binding removal. Removing the last binding empties the
 * membership (the caller then revokes the membership record, so a
 * revoked empty record — not a live empty one — is what remains).
 * The caller persists the result with store.put, or with
 * store.revokeMembership when emptied. Non-admin bindings are
 * refused: this surface revokes admin grants only.
 */
export function removeRoleBinding(
  membership: Membership,
  bindingIndex: number,
): RemoveRoleBindingResult {
  const binding = membership.roleBindings[bindingIndex];
  if (!binding) {
    return { ok: false, code: "INVALID_INDEX", error: `no binding at index ${bindingIndex}.` };
  }
  if (!(ROLE_GRANT_ROLES as readonly string[]).includes(binding.role)) {
    return {
      ok: false,
      code: "NOT_ADMIN_BINDING",
      error: `binding ${bindingIndex} is not an admin grant.`,
    };
  }
  const roleBindings = membership.roleBindings.filter((_, i) => i !== bindingIndex);
  return {
    ok: true,
    membership: { ...membership, roleBindings },
    emptied: roleBindings.length === 0,
  };
}
