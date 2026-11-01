/**
 * Issue #945, Slice 3 — membership + scoped authorization PDP (pure policy).
 *
 * This module is deliberately NOT live enforcement. It does not touch
 * any route, API, job, tool, storage backend, or existing permission
 * check, and it changes no production membership, role, or permission.
 * A later slice wires these pure rules into live call sites; until
 * then they are testable policy, not behaviour change.
 *
 * Effective authority, as an intersection (spec §5, #945 §5):
 *   effective authority = initiator membership
 *     ∩ tenant policy (this PDP: role grants + scope + tenant)
 *     ∩ resource policy (own-scope / workspace / assigned-approver
 *       checks in this module; richer resource policy is later wiring)
 * A missing factor denies. No single factor — especially a role name
 * alone — ever grants.
 *
 * What is covered (spec §5 permission matrix, default-deny):
 * - Tenant/workspace Membership with RoleBindings, in the
 *   application-owned tenant model from the merged spec. No Auth0
 *   Organization or provider tenant is created or consulted here.
 * - Roles: platform-admin (platform scope only), tenant-admin,
 *   workspace-admin, member, approver, auditor — as distinct scopes.
 *   A platform admin's membership grants nothing in a tenant, and a
 *   tenant admin's membership grants nothing in another tenant.
 * - Default-deny: any permission not explicitly granted by an active,
 *   in-scope binding is denied, including unknown permissions.
 * - Tenant scoping: a membership in Tenant A grants nothing in
 *   Tenant B, whether the request names the tenant, a direct
 *   resource id, or an export.
 * - Resource/context checks beyond role names: member grants are
 *   own-scope only (a resourceOwnerId that is not the actor denies),
 *   workspace-admin grants are workspace-scoped, and approver grants
 *   require the actor to be the assigned approver when one is given.
 * - The hard rule: a tenant admin cannot grant platform privileges,
 *   and no non-platform-admin can grant a platform-scoped permission.
 *   Possessing a permission does not itself grant the right to grant
 *   it; granting requires the separate role:assign grant in scope.
 *
 * What is NOT covered, explicitly:
 * - Delegation (Slice 4): no delegation input is accepted here, and
 *   an actor cannot expand scope through this module.
 * - Approval workflows (Slice 4) and audit events (Slice 5): the
 *   approver role is a role grant only, not an approval record, and
 *   decisions are returned, not recorded, by this module.
 * - Live enforcement at APIs, jobs, tools, storage, retrieval,
 *   artifacts, exports, or notifications (later wiring).
 * - Identity: identity here is the Slice 1 stable internal user id.
 *   Email and display login are NOT inputs to any function in this
 *   module, so an email change cannot create or transfer authority.
 *
 * Time is always a caller-supplied `nowMs` seam, never Date.now()
 * inside a decision, so every rule is testable at its exact boundary.
 * Identifiers are trimmed and compared exactly, as in Slices 1–2: no
 * case folding, no URL canonicalization.
 */

// ---------------------------------------------------------------------------
// Permissions and roles (spec §5)
// ---------------------------------------------------------------------------

export const PERMISSIONS = [
  "membership:invite",
  "membership:revoke",
  "role:assign",
  "task:create",
  "task:read",
  "task:cancel",
  "artifact:read",
  "artifact:edit",
  "artifact:export",
  "integration:connect",
  "integration:use",
  "integration:manage",
  "action:propose",
  "action:approve",
  "action:execute",
  "audit:read",
  "audit:export",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role =
  | "platform-admin"
  | "tenant-admin"
  | "workspace-admin"
  | "member"
  | "approver"
  | "auditor";

const ROLES: readonly Role[] = [
  "platform-admin",
  "tenant-admin",
  "workspace-admin",
  "member",
  "approver",
  "auditor",
];

/**
 * The single role catalog. Every surface that assigns roles consumes
 * this list — service tokens (#2681), human role grants (#2688), and
 * the #2171 grants model — never a re-declared copy. Server-side
 * validation (canGrantRole, mint) checks against it; client checkbox
 * lists are presentations of it, not second systems.
 */
export const ALL_ROLES: readonly Role[] = ROLES;

export type AuthorizationScope = "platform" | "tenant" | "workspace" | "resource";

/** Role grants. Scope, tenant, and resource checks are applied on top. */
const ROLE_GRANTS: Record<Role, readonly Permission[]> = {
  // Platform scope only; see authorize() — this set never grants tenant permissions.
  "platform-admin": ["role:assign", "audit:read", "audit:export"],
  "tenant-admin": [...PERMISSIONS],
  "workspace-admin": [...PERMISSIONS],
  member: [
    "task:create",
    "task:read",
    "task:cancel",
    "artifact:read",
    "artifact:edit",
    "artifact:export",
    "action:propose",
    // #2450: an ordinary member can connect their own brokerage.
    // integration:use / integration:manage stay admin-held, and a
    // per-user denial (permissionDenials.ts) can revoke connect
    // for a specific member without touching the rest of the role.
    "integration:connect",
  ],
  approver: ["action:approve"],
  auditor: ["task:read", "artifact:read", "audit:read"],
};

// ---------------------------------------------------------------------------
// Memberships and store
// ---------------------------------------------------------------------------

export interface RoleBinding {
  role: Role;
  scope: AuthorizationScope;
  /** Workspace this binding is scoped to (workspace scope). Defaults to the membership workspace. */
  workspaceId?: string;
  resourceId?: string;
  grantedBy: string;
  expiresAtMs?: number;
}

export interface Membership {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  workspaceId?: string;
  roleBindings: RoleBinding[];
  createdBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

export interface MembershipStore {
  getMembershipsByUser(internalUserId: string): Promise<Membership[]>;
  put(membership: Membership): Promise<void>;
  revokeMembership(membershipId: string, nowMs: number): Promise<boolean>;
}

/**
 * #2450 — a per-user permission denial.
 *
 * A denial is NOT a membership edit and NOT a membership revoke:
 * revoking a membership kills ALL of that user's permissions, and a
 * RoleBinding has no per-permission field. A denial removes exactly
 * one permission for one user in one tenant; clearing it restores
 * exactly that permission. The record carries no secret, token, or
 * credential — only who denied what, for whom, and when. Audit
 * history lives in the audit funnel (the deny/clear routes write
 * audit-before-allow records); the store itself holds only live
 * denials, so clearing deletes the record.
 */
export interface PermissionDenial {
  denialId: string;
  internalUserId: string;
  tenantId: string;
  permission: Permission;
  deniedBy: string;
  deniedAtMs: number;
}

/** Minimal reader surface the PDP needs: denials by user. */
export interface PermissionDenialReader {
  getDenialsByUser(internalUserId: string): Promise<PermissionDenial[]>;
}

export function createMemoryMembershipStore(): MembershipStore {
  const byId = new Map<string, Membership>();
  const byUser = new Map<string, Membership[]>();

  return {
    async getMembershipsByUser(internalUserId: string): Promise<Membership[]> {
      return [...(byUser.get(internalUserId) ?? [])];
    },
    async put(membership: Membership): Promise<void> {
      byId.set(membership.membershipId, membership);
      const list = byUser.get(membership.internalUserId) ?? [];
      const index = list.findIndex((m) => m.membershipId === membership.membershipId);
      if (index >= 0) list[index] = membership;
      else list.push(membership);
      byUser.set(membership.internalUserId, list);
    },
    async revokeMembership(membershipId: string, nowMs: number): Promise<boolean> {
      const membership = byId.get(membershipId);
      if (!membership) return false;
      membership.revokedAtMs = nowMs;
      return true;
    },
  };
}

export type MembershipErrorCode =
  | "INVALID_USER_ID"
  | "INVALID_TENANT_ID"
  | "INVALID_CREATED_BY"
  | "INVALID_ROLE"
  | "INVALID_SCOPE"
  | "INVALID_GRANTED_BY"
  | "EMPTY_ROLE_BINDINGS";

export type MembershipResult =
  | { ok: true; membership: Membership }
  | { ok: false; code: MembershipErrorCode; error: string };

export interface CreateMembershipInput {
  internalUserId: string;
  tenantId: string;
  workspaceId?: string;
  roleBindings: RoleBinding[];
  createdBy: string;
  nowMs: number;
}

const MAX_FIELD_LENGTH = 512;

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

function normalize(value: string): string {
  return value.trim();
}

export async function createMembership(
  store: MembershipStore,
  input: CreateMembershipInput,
): Promise<MembershipResult> {
  if (!isValidField(input.internalUserId)) {
    return { ok: false, code: "INVALID_USER_ID", error: "internalUserId must be a non-empty string" };
  }
  if (!isValidField(input.tenantId)) {
    return { ok: false, code: "INVALID_TENANT_ID", error: "tenantId must be a non-empty string" };
  }
  if (!isValidField(input.createdBy)) {
    return { ok: false, code: "INVALID_CREATED_BY", error: "createdBy must be a non-empty string" };
  }
  if (!Array.isArray(input.roleBindings) || input.roleBindings.length === 0) {
    return { ok: false, code: "EMPTY_ROLE_BINDINGS", error: "at least one role binding is required" };
  }
  for (const binding of input.roleBindings) {
    if (!ROLES.includes(binding.role)) {
      return { ok: false, code: "INVALID_ROLE", error: `unknown role: ${String(binding.role)}` };
    }
    if (!["platform", "tenant", "workspace", "resource"].includes(binding.scope)) {
      return { ok: false, code: "INVALID_SCOPE", error: `unknown scope: ${String(binding.scope)}` };
    }
    if (!isValidField(binding.grantedBy)) {
      return { ok: false, code: "INVALID_GRANTED_BY", error: "grantedBy must be a non-empty string" };
    }
  }
  const membership: Membership = {
    membershipId: crypto.randomUUID(),
    internalUserId: normalize(input.internalUserId),
    tenantId: normalize(input.tenantId),
    workspaceId: input.workspaceId ? normalize(input.workspaceId) : undefined,
    roleBindings: input.roleBindings.map((b) => ({
      ...b,
      workspaceId: b.workspaceId ? normalize(b.workspaceId) : undefined,
      resourceId: b.resourceId ? normalize(b.resourceId) : undefined,
      grantedBy: normalize(b.grantedBy),
    })),
    createdBy: normalize(input.createdBy),
    createdAtMs: input.nowMs,
  };
  await store.put(membership);
  return { ok: true, membership };
}

// ---------------------------------------------------------------------------
// Policy snapshot + attribute provider (#1755, parent #1717)
//
// The compiled ROLE_GRANTS table stays the authoritative policy.
// The snapshot is its portable form: the same grants as JSON data
// (exportable, inspectable, loadable through a PolicyProvider) —
// not a second policy language and not an editor. The attribute
// provider is the PIP port: the PDP reads memberships only through
// it, never through a store directly. authorize() below stays as
// the back-compatible entry point: compiled policy + a store
// adapted to a provider, so every existing caller keeps the exact
// decisions it had.
// ---------------------------------------------------------------------------

/** Portable form of the role-grant policy. Plain JSON data. */
export interface PolicySnapshot {
  version: string;
  permissions: readonly Permission[];
  roleGrants: Record<Role, readonly Permission[]>;
}

/** A copy of the compiled tables, so no caller can mutate live policy. */
export function getCompiledPolicySnapshot(): PolicySnapshot {
  const roleGrants = {} as Record<Role, readonly Permission[]>;
  for (const role of ROLES) roleGrants[role] = [...ROLE_GRANTS[role]];
  return {
    version: AUTHORIZATION_POLICY_VERSION,
    permissions: [...PERMISSIONS],
    roleGrants,
  };
}

/**
 * PIP port: supplies the attributes the PDP evaluates. Today the
 * attribute sets are memberships and, when the provider supplies
 * them, per-user permission denials (#2450); federation,
 * transformation, or caching land here later, behind this
 * interface — never by giving the PDP another store to read
 * directly. getPermissionDenials is optional so every existing
 * provider keeps working denial-unaware; live gates that must
 * honor denials pass a denial-aware provider explicitly.
 */
export interface AttributeProvider {
  getMembershipsByUser(internalUserId: string): Promise<Membership[]>;
  getPermissionDenials?(internalUserId: string): Promise<PermissionDenial[]>;
}

/** Adapt any MembershipStore to the PIP port (the store is not the PDP). */
export function membershipStoreToAttributeProvider(
  store: MembershipStore,
  denialReader?: PermissionDenialReader,
): AttributeProvider {
  return {
    getMembershipsByUser: (internalUserId: string) =>
      store.getMembershipsByUser(internalUserId),
    ...(denialReader
      ? {
          getPermissionDenials: (internalUserId: string) =>
            denialReader.getDenialsByUser(internalUserId),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Policy decision point
// ---------------------------------------------------------------------------

export type DecisionReason =
  | "ALLOW"
  | "UNKNOWN_PERMISSION"
  | "INVALID_TENANT_ID"
  | "INVALID_ACTOR"
  | "NO_MEMBERSHIP"
  | "CROSS_TENANT"
  | "MEMBERSHIP_REVOKED"
  | "NO_GRANT"
  | "NOT_OWN_SCOPE"
  | "SCOPE_MISMATCH"
  | "NOT_ASSIGNED_APPROVER"
  | "PLATFORM_SCOPE_DENIED"
  | "PERMISSION_DENIED";

export interface ResourceScope {
  resourceId?: string;
  workspaceId?: string;
  /** Owner of an own-scope resource (member grants apply only to the actor's own). */
  resourceOwnerId?: string;
  /** Approver assigned to the action being approved, when one is assigned. */
  assignedApproverId?: string;
}

export interface AuthorizationRequest {
  actorInternalUserId: string;
  /** Required for tenant/workspace scope; ignored for platform scope. */
  tenantId?: string;
  permission: Permission;
  /** Defaults to "tenant". Platform-scoped checks require scope "platform". */
  scope?: AuthorizationScope;
  resourceScope?: ResourceScope;
  nowMs: number;
}

export interface AuthorizationDecision {
  decision: "allow" | "deny";
  reason: DecisionReason;
  principalId: string;
  tenantId?: string;
  permission: string;
  policyVersion: string;
}

export const AUTHORIZATION_POLICY_VERSION = "iaaa-authorization-1";

function deny(
  request: AuthorizationRequest,
  reason: DecisionReason,
  policyVersion: string = AUTHORIZATION_POLICY_VERSION,
): AuthorizationDecision {
  return {
    decision: "deny",
    reason,
    principalId: request.actorInternalUserId,
    tenantId: request.tenantId,
    permission: String(request.permission),
    policyVersion,
  };
}

function allow(
  request: AuthorizationRequest,
  policyVersion: string = AUTHORIZATION_POLICY_VERSION,
): AuthorizationDecision {
  return {
    decision: "allow",
    reason: "ALLOW",
    principalId: request.actorInternalUserId,
    tenantId: request.tenantId,
    permission: String(request.permission),
    policyVersion,
  };
}

function bindingIsActive(binding: RoleBinding, nowMs: number): boolean {
  return binding.expiresAtMs === undefined || binding.expiresAtMs > nowMs;
}

/**
 * The PDP. Returns allow only when an active membership, in the
 * requested tenant (or platform scope), carries an active role
 * binding that grants the permission and passes every applicable
 * scope and resource check. Everything else denies.
 *
 * #1755: the decision logic lives here, parameterized by policy
 * snapshot + attribute provider. The PDP reads no store: every
 * membership read goes through `attributes` (the PIP port).
 */
export async function authorizeWithPolicy(
  policy: PolicySnapshot,
  attributes: AttributeProvider,
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const version = policy.version;
  if (!(PERMISSIONS as readonly string[]).includes(String(request.permission))) {
    return deny(request, "UNKNOWN_PERMISSION", version);
  }
  if (!isValidField(request.actorInternalUserId)) {
    return deny(request, "INVALID_ACTOR", version);
  }
  const scope = request.scope ?? "tenant";
  const actor = normalize(request.actorInternalUserId);
  const all = await attributes.getMembershipsByUser(actor);

  // Platform scope: only a platform-admin binding grants, and only
  // platform permissions. Any other actor is denied at this hard
  // boundary, whatever tenant roles they hold.
  if (scope === "platform") {
    const platformBindings = all.flatMap((m) =>
      m.roleBindings
        .filter((b) => b.role === "platform-admin" && b.scope === "platform")
        .map((b) => ({ membership: m, binding: b })),
    );
    const active = platformBindings.filter(
      ({ membership, binding }) =>
        membership.revokedAtMs === undefined && bindingIsActive(binding, request.nowMs),
    );
    if (active.length === 0) return deny(request, "PLATFORM_SCOPE_DENIED", version);
    if (!(policy.roleGrants["platform-admin"] ?? []).includes(request.permission)) {
      return deny(request, "NO_GRANT", version);
    }
    return allow(request, version);
  }

  if (!isValidField(request.tenantId)) {
    return deny(request, "INVALID_TENANT_ID", version);
  }
  const tenantId = normalize(request.tenantId!);
  const inTenant = all.filter((m) => m.tenantId === tenantId);
  if (inTenant.length === 0) {
    // The actor holds memberships, but none in this tenant: the
    // request is cross-tenant, not merely unprivileged.
    return deny(request, all.length > 0 ? "CROSS_TENANT" : "NO_MEMBERSHIP", version);
  }
  const activeMemberships = inTenant.filter((m) => m.revokedAtMs === undefined);
  if (activeMemberships.length === 0) {
    return deny(request, "MEMBERSHIP_REVOKED", version);
  }

  // #2450 — per-user permission denials, consulted BEFORE role
  // grants: deny-beats-grant. Placement is deliberate: a user with
  // no (active) membership in this tenant keeps the NO_MEMBERSHIP /
  // MEMBERSHIP_REVOKED reason above, so a denial never leaks past
  // the membership boundary and never overrides it. Platform scope
  // skips this check: denials are tenant-scoped records, and
  // platform permissions are not deniable through this layer.
  // A provider without denials behaves exactly as before.
  if (attributes.getPermissionDenials) {
    const denials = await attributes.getPermissionDenials(actor);
    const denied = denials.some(
      (d) => d.tenantId === tenantId && d.permission === request.permission,
    );
    if (denied) return deny(request, "PERMISSION_DENIED", version);
  }

  let blockingReason: DecisionReason | null = null;
  for (const membership of activeMemberships) {
    for (const binding of membership.roleBindings) {
      if (!bindingIsActive(binding, request.nowMs)) continue;
      if (!(policy.roleGrants[binding.role] ?? []).includes(request.permission)) continue;
      // Scope compatibility: a platform binding never grants tenant
      // permissions; a tenant binding grants tenant-wide; a
      // workspace/resource binding grants within its workspace or
      // resource, and is checked against the requested workspace.
      if (binding.scope === "platform") continue;
      if (binding.scope === "workspace" || binding.scope === "resource") {
        // A workspace binding must not become a tenant-wide grant
        // for administrative permissions when no workspace is named.
        const administrative: readonly Permission[] = [
          "membership:invite",
          "membership:revoke",
          "role:assign",
        ];
        if (
          administrative.includes(request.permission) &&
          request.resourceScope?.workspaceId === undefined
        ) {
          blockingReason = "SCOPE_MISMATCH";
          continue;
        }
        const bindingWorkspace = binding.workspaceId ?? membership.workspaceId;
        const requestedWorkspace = request.resourceScope?.workspaceId;
        if (requestedWorkspace !== undefined && bindingWorkspace !== undefined) {
          if (normalize(requestedWorkspace) !== bindingWorkspace) {
            blockingReason = "SCOPE_MISMATCH";
            continue;
          }
        }
        if (
          binding.scope === "resource" &&
          binding.resourceId !== undefined &&
          request.resourceScope?.resourceId !== undefined &&
          normalize(request.resourceScope.resourceId) !== binding.resourceId
        ) {
          blockingReason = "SCOPE_MISMATCH";
          continue;
        }
      }
      // Member grants are own-scope only.
      if (binding.role === "member") {
        const owner = request.resourceScope?.resourceOwnerId;
        if (owner !== undefined && normalize(owner) !== actor) {
          blockingReason = "NOT_OWN_SCOPE";
          continue;
        }
      }
      // Approver grants require the assigned approver, when assigned.
      if (binding.role === "approver") {
        const assigned = request.resourceScope?.assignedApproverId;
        if (assigned !== undefined && normalize(assigned) !== actor) {
          blockingReason = "NOT_ASSIGNED_APPROVER";
          continue;
        }
      }
      return allow(request, version);
    }
  }
  return deny(request, blockingReason ?? "NO_GRANT", version);
}

/**
 * Back-compatible PDP entry point: the compiled policy, with the
 * caller's store adapted to the PIP port. Decisions are identical
 * to authorizeWithPolicy() with the compiled snapshot — this is a
 * delegation, not a second implementation. Pass a denial reader
 * when the caller must honor per-user permission denials (#2450);
 * without one the decision is denial-unaware, exactly as before.
 * Live gates that must honor denials pass the reader explicitly.
 */
export async function authorize(
  store: MembershipStore,
  request: AuthorizationRequest,
  denialReader?: PermissionDenialReader,
): Promise<AuthorizationDecision> {
  return authorizeWithPolicy(
    getCompiledPolicySnapshot(),
    membershipStoreToAttributeProvider(store, denialReader),
    request,
  );
}

// ---------------------------------------------------------------------------
// Granting roles (the separate role:assign check)
// ---------------------------------------------------------------------------

export interface GrantRoleRequest {
  granterInternalUserId: string;
  targetTenantId: string;
  targetScope: AuthorizationScope;
  targetRole: Role;
  targetWorkspaceId?: string;
  nowMs: number;
}

/**
 * Whether the granter may grant the target role. Granting requires
 * the separate role:assign grant in the right scope — possessing
 * the target permission is not enough — and platform privileges
 * require a platform admin, full stop.
 */
export async function canGrantRole(
  store: MembershipStore,
  request: GrantRoleRequest,
): Promise<AuthorizationDecision> {
  const base: AuthorizationRequest = {
    actorInternalUserId: request.granterInternalUserId,
    tenantId: request.targetTenantId,
    permission: "role:assign",
    nowMs: request.nowMs,
  };
  // #1755: same decisions as before, routed through the PIP port —
  // the store is adapted once, and every read below is a PIP read.
  const policy = getCompiledPolicySnapshot();
  const attributes = membershipStoreToAttributeProvider(store);
  if (!ROLES.includes(request.targetRole)) {
    return deny(base, "UNKNOWN_PERMISSION");
  }
  if (request.targetRole === "platform-admin" || request.targetScope === "platform") {
    const platform = await authorizeWithPolicy(policy, attributes, {
      ...base,
      tenantId: undefined,
      scope: "platform",
    });
    // authorizeWithPolicy() already denies non-platform-admins with
    // PLATFORM_SCOPE_DENIED; surface that hard boundary directly.
    return platform.decision === "allow" ? platform : deny(base, "PLATFORM_SCOPE_DENIED");
  }
  const tenantGrant = await authorizeWithPolicy(policy, attributes, base);
  if (tenantGrant.decision === "deny") return tenantGrant;
  // The grant's scope must match the granter's scope: a tenant-wide
  // grant requires a tenant-admin, and a workspace grant requires a
  // tenant-admin or the matching workspace-admin binding. A
  // workspace-admin must not become a tenant-wide granter through
  // the PDP's workspace-resource candidate rule.
  const memberships = await attributes.getMembershipsByUser(
    normalize(request.granterInternalUserId),
  );
  const inTenant = memberships.filter(
    (m) => m.tenantId === normalize(request.targetTenantId) && m.revokedAtMs === undefined,
  );
  const hasTenantAdmin = inTenant.some((m) =>
    m.roleBindings.some(
      (b) => b.role === "tenant-admin" && bindingIsActive(b, request.nowMs),
    ),
  );
  if (request.targetScope === "tenant" && !hasTenantAdmin) {
    return deny(base, "SCOPE_MISMATCH");
  }
  if (request.targetScope === "workspace" && request.targetWorkspaceId !== undefined) {
    const ok =
      hasTenantAdmin ||
      inTenant.some((m) =>
        m.roleBindings.some(
          (b) =>
            b.role === "workspace-admin" &&
            bindingIsActive(b, request.nowMs) &&
            (b.workspaceId ?? m.workspaceId) === normalize(request.targetWorkspaceId!),
        ),
      );
    if (!ok) return deny(base, "SCOPE_MISMATCH");
  }
  return tenantGrant;
}
