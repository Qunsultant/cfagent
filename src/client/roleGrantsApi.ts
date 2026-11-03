/**
 * Client for the role-grant admin endpoints (issue #2688):
 * GET /api/iaaa/role-grants,
 * POST /api/iaaa/role-grants/grant,
 * POST /api/iaaa/role-grants/revoke.
 *
 * The grantable roles here are the admin subset of the single
 * role catalog (ALL_ROLES in src/security/authorization.ts):
 * platform-admin and tenant-admin only. This list is a display
 * list, not a second role system — the server validates every
 * request against ALL_ROLES and refuses anything ungrantable.
 * All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

/** Presentation of the role-grants subset of ALL_ROLES. Server enforces. */
export const ROLE_GRANT_ROLE_OPTIONS = ["platform-admin", "tenant-admin"] as const;

export type RoleGrantRoleOption = (typeof ROLE_GRANT_ROLE_OPTIONS)[number];

export interface RoleGrantInfo {
  grantId: string;
  membershipId: string;
  bindingIndex: number;
  internalUserId: string;
  /** issuer:subject from the identity binding, or null when unbound. */
  identity: string | null;
  /** Grantee email captured at grant time, or null. */
  email: string | null;
  tenantId: string;
  role: string;
  scope: string;
  grantedBy: string;
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
    identity: typeof value.identity === "string" ? value.identity : null,
    email: typeof value.email === "string" ? value.email : null,
    tenantId,
    role,
    scope,
    grantedBy,
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
  internalUserId: string;
  role: string;
  tenantId?: string;
  email?: string;
}

export async function grantRoleGrant(input: GrantRoleGrantInput): Promise<{ grant: RoleGrantInfo; alreadyGranted?: boolean }> {
  const res = await apiFetch("/api/iaaa/role-grants/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res, "Failed to grant role.");
  const body = (await res.json().catch(() => null)) as { grant?: unknown; alreadyGranted?: unknown } | null;
  if (!body) throw new Error("Role-grant response was malformed.");
  return {
    grant: parseGrant(body.grant),
    ...(body.alreadyGranted === true ? { alreadyGranted: true as const } : {}),
  };
}

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
