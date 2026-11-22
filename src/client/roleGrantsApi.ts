/**
 * Client for the role-grant admin endpoints (issue #2688):
 * GET /api/iaaa/role-grants,
 * POST /api/iaaa/role-grants/grant,
 * POST /api/iaaa/role-grants/revoke.
 *
 * Issue #6165 — one admin-creation path: the grant/revoke
 * endpoints below are deprecated aliases of the membership-grant
 * route (POST /api/iaaa/membership/grant). The list endpoint
 * stays canonical: the Role grants section is now a read-only
 * admin-role list. See docs/architecture/transition/deprecations.md
 * (#6165 entry).
 *
 * The grantable roles here are the admin subset of the single
 * role catalog (ALL_ROLES in src/security/authorization.ts):
 * platform-admin and tenant-admin only. This list is a display
 * list, not a second role system — the server validates every
 * request against ALL_ROLES and refuses anything ungrantable.
 * All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";
import { isInternalUserId } from "./identityDisplay";

/** Presentation of the role-grants subset of ALL_ROLES. Server enforces. */
export const ROLE_GRANT_ROLE_OPTIONS = ["platform-admin", "tenant-admin", "store-operator"] as const;

export type RoleGrantRoleOption = (typeof ROLE_GRANT_ROLE_OPTIONS)[number];

export interface RoleGrantInfo {
  grantId: string;
  membershipId: string;
  bindingIndex: number;
  internalUserId: string;
  /** #6164 — grantee login resolved server-side, null when no alias exists. */
  login?: string | null;
  /** issuer:subject from the identity binding, or null when unbound. */
  identity: string | null;
  /** Grantee email captured at grant time, or null. */
  email: string | null;
  tenantId: string;
  role: string;
  scope: string;
  grantedBy: string;
  /** #6164 — granter login resolved server-side, null when no alias exists. */
  grantedByLogin?: string | null;
  grantedAtMs: number;
  revoked: boolean;
  expiresAtMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrant(value: unknown): RoleGrantInfo {
  if (!isRecord(value)) throw new Error("Role-grant response was not an object.");
  const grantId = value.grantId;
  const membershipId = value.membershipId;
  const bindingIndex = value.bindingIndex;
  const internalUserId = value.internalUserId;
  const tenantId = value.tenantId;
  const role = value.role;
  const scope = value.scope;
  const grantedBy = value.grantedBy;
  const grantedAtMs = value.grantedAtMs;
  if (
    typeof grantId !== "string" ||
    typeof membershipId !== "string" ||
    typeof bindingIndex !== "number" ||
    typeof internalUserId !== "string" ||
    typeof tenantId !== "string" ||
    typeof role !== "string" ||
    typeof scope !== "string" ||
    typeof grantedBy !== "string" ||
    typeof grantedAtMs !== "number"
  ) {
    throw new Error("Role-grant response was missing required fields.");
  }
  return {
    grantId,
    membershipId,
    bindingIndex,
    internalUserId,
    login: typeof value.login === "string" ? value.login : null,
    identity: typeof value.identity === "string" ? value.identity : null,
    email: typeof value.email === "string" ? value.email : null,
    tenantId,
    role,
    scope,
    grantedBy,
    grantedByLogin: typeof value.grantedByLogin === "string" ? value.grantedByLogin : null,
    grantedAtMs,
    revoked: value.revoked === true,
    ...(typeof value.expiresAtMs === "number" ? { expiresAtMs: value.expiresAtMs } : {}),
  };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
  return new Error(message);
}

export async function fetchRoleGrants(): Promise<RoleGrantInfo[]> {
  const res = await apiFetch("/api/iaaa/role-grants");
  if (!res.ok) throw await readError(res, "Failed to load role grants.");
  const body = (await res.json().catch(() => null)) as { grants?: unknown } | null;
  if (!body || !Array.isArray(body.grants)) throw new Error("Role-grant response was malformed.");
  return body.grants.map(parseGrant);
}

export interface GrantRoleGrantInput {
  /** #6164 (A2) — a login or an internal user id; the server resolves a login. */
  target: string;
  role: string;
  tenantId?: string;
  email?: string;
}

/**
 * @deprecated Issue #6165 — one admin-creation path. Superseded by
 * POST /api/iaaa/membership/grant (Grant membership on the Members
 * tab, src/server/routes/auth.ts). Kept functional as a deprecated
 * alias: it mints through the same grantMembership seam, so behavior
 * is unchanged. Frozen — no new consumers.
 */
export async function grantRoleGrant(input: GrantRoleGrantInput): Promise<{ grant?: RoleGrantInfo; alreadyGranted?: boolean; pending?: boolean; proposalId?: string }> {
  const { target, ...rest } = input;
  const res = await apiFetch("/api/iaaa/role-grants/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(isInternalUserId(target) ? { internalUserId: target } : { login: target }),
      ...rest,
    }),
  });
  if (!res.ok) throw await readError(res, "Failed to grant role.");
  const body = (await res.json().catch(() => null)) as { grant?: unknown; alreadyGranted?: unknown; pending?: unknown; proposalId?: unknown } | null;
  if (!body) throw new Error("Role-grant response was malformed.");
  // Issue #3155 (Q9): a first-approver grant returns 202 with no
  // grant — a pending proposal, not an error. The panel shows an
  // awaiting notice.
  if (body.pending === true) {
    return {
      pending: true,
      ...(typeof body.proposalId === "string" ? { proposalId: body.proposalId } : {}),
    };
  }
  return {
    grant: parseGrant(body.grant),
    ...(body.alreadyGranted === true ? { alreadyGranted: true as const } : {}),
  };
}

/**
 * @deprecated Issue #6165 — one admin-creation path. Superseded by
 * the Members-tab revoke in src/client/IaaaAdminPanel.tsx
 * (revokeMembershipApi). Kept functional as a deprecated alias;
 * behavior is unchanged. Frozen — no new consumers.
 */
export async function revokeRoleGrant(membershipId: string, bindingIndex: number): Promise<void> {
  const res = await apiFetch("/api/iaaa/role-grants/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ membershipId, bindingIndex }),
  });
  if (!res.ok) throw await readError(res, "Failed to revoke role grant.");
}

export function fmtRoleGrantTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
