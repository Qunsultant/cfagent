/**
 * Client for the PIP read endpoint (issue #4655):
 * GET /api/security/pip — the PIP's live attribute state for the
 * caller's session: the attribute schema (Membership, RoleBinding,
 * PermissionDenial fields), the attribute sources (membership store
 * via membershipStoreToAttributeProvider; KV denial store), and the
 * signed-in user's OWN attributes (memberships + denials) as resolved
 * through the live AttributeProvider — never another user's.
 *
 * Nothing here decides authorization: the panel renders whatever the
 * server reports. All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export interface PipSchemaGroup {
  fields: string[];
}

export interface PipSchema {
  membership: PipSchemaGroup;
  roleBinding: PipSchemaGroup;
  permissionDenial: PipSchemaGroup;
}

export interface PipSourceInfo {
  id: string;
  name: string;
  via: string;
  available: boolean;
}

export interface PipMembership {
  membershipId: string;
  internalUserId: string;
  /** #6164 (F6) — login resolved server-side, null when no alias exists. */
  login?: string | null;
  tenantId: string;
  workspaceId?: string;
  roleBindings: {
    role: string;
    scope: string;
    workspaceId?: string;
    resourceId?: string;
    grantedBy: string;
    /** #6164 (F6) — granter login resolved server-side, null when no alias exists. */
    grantedByLogin?: string | null;
    expiresAtMs?: number;
  }[];
  createdBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
  email?: string;
}

export interface PipDenial {
  denialId: string;
  internalUserId: string;
  tenantId: string;
  permission: string;
  deniedBy: string;
  /** #6164 (F6) — denier login resolved server-side, null when no alias exists. */
  deniedByLogin?: string | null;
  deniedAtMs: number;
}

export interface PipAttributes {
  memberships: PipMembership[];
  denials: PipDenial[];
  denialsAvailable: boolean;
}

export interface PipState {
  schema: PipSchema;
  sources: PipSourceInfo[];
  attributes: PipAttributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("PIP response was malformed.");
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("PIP response was malformed.");
  }
  return [...(value as string[])];
}

function parseSchemaGroup(value: unknown): PipSchemaGroup {
  if (!isRecord(value)) throw new Error("PIP response was malformed.");
  return { fields: parseStringArray(value.fields) };
}

function parsePipState(value: unknown): PipState {
  if (!isRecord(value)) throw new Error("PIP response was not an object.");
  if (!isRecord(value.schema)) throw new Error("PIP response was malformed.");
  const schema: PipSchema = {
    membership: parseSchemaGroup(value.schema.membership),
    roleBinding: parseSchemaGroup(value.schema.roleBinding),
    permissionDenial: parseSchemaGroup(value.schema.permissionDenial),
  };
  if (!Array.isArray(value.sources)) throw new Error("PIP response was malformed.");
  const sources: PipSourceInfo[] = [];
  for (const entry of value.sources) {
    if (!isRecord(entry)) throw new Error("PIP response was malformed.");
    if (typeof entry.id !== "string") throw new Error("PIP response was malformed.");
    if (typeof entry.name !== "string") throw new Error("PIP response was malformed.");
    if (typeof entry.via !== "string") throw new Error("PIP response was malformed.");
    if (typeof entry.available !== "boolean") {
      throw new Error("PIP response was malformed.");
    }
    sources.push({
      id: entry.id,
      name: entry.name,
      via: entry.via,
      available: entry.available,
    });
  }
  if (!isRecord(value.attributes)) throw new Error("PIP response was malformed.");
  const attributes = value.attributes;
  if (!Array.isArray(attributes.memberships)) {
    throw new Error("PIP response was malformed.");
  }
  const memberships: PipMembership[] = [];
  for (const entry of attributes.memberships) {
    if (!isRecord(entry)) throw new Error("PIP response was malformed.");
    if (typeof entry.membershipId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.internalUserId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.tenantId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (!Array.isArray(entry.roleBindings)) {
      throw new Error("PIP response was malformed.");
    }
    const roleBindings: PipMembership["roleBindings"] = [];
    for (const binding of entry.roleBindings) {
      if (!isRecord(binding)) throw new Error("PIP response was malformed.");
      if (typeof binding.role !== "string") {
        throw new Error("PIP response was malformed.");
      }
      if (typeof binding.scope !== "string") {
        throw new Error("PIP response was malformed.");
      }
      if (typeof binding.grantedBy !== "string") {
        throw new Error("PIP response was malformed.");
      }
      roleBindings.push({
        role: binding.role,
        scope: binding.scope,
        ...(typeof binding.workspaceId === "string"
          ? { workspaceId: binding.workspaceId }
          : {}),
        ...(typeof binding.resourceId === "string"
          ? { resourceId: binding.resourceId }
          : {}),
        grantedBy: binding.grantedBy,
        ...(typeof binding.grantedByLogin === "string"
          ? { grantedByLogin: binding.grantedByLogin }
          : {}),
        ...(typeof binding.expiresAtMs === "number"
          ? { expiresAtMs: binding.expiresAtMs }
          : {}),
      });
    }
    if (typeof entry.createdBy !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.createdAtMs !== "number") {
      throw new Error("PIP response was malformed.");
    }
    memberships.push({
      membershipId: entry.membershipId,
      internalUserId: entry.internalUserId,
      ...(typeof entry.login === "string" ? { login: entry.login } : {}),
      tenantId: entry.tenantId,
      ...(typeof entry.workspaceId === "string" ? { workspaceId: entry.workspaceId } : {}),
      roleBindings,
      createdBy: entry.createdBy,
      createdAtMs: entry.createdAtMs,
      ...(typeof entry.revokedAtMs === "number" ? { revokedAtMs: entry.revokedAtMs } : {}),
      ...(typeof entry.email === "string" ? { email: entry.email } : {}),
    });
  }
  if (!Array.isArray(attributes.denials)) {
    throw new Error("PIP response was malformed.");
  }
  const denials: PipDenial[] = [];
  for (const entry of attributes.denials) {
    if (!isRecord(entry)) throw new Error("PIP response was malformed.");
    if (typeof entry.denialId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.internalUserId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.tenantId !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.permission !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.deniedBy !== "string") {
      throw new Error("PIP response was malformed.");
    }
    if (typeof entry.deniedAtMs !== "number") {
      throw new Error("PIP response was malformed.");
    }
    denials.push({
      denialId: entry.denialId,
      internalUserId: entry.internalUserId,
      tenantId: entry.tenantId,
      permission: entry.permission,
      deniedBy: entry.deniedBy,
      ...(typeof entry.deniedByLogin === "string" ? { deniedByLogin: entry.deniedByLogin } : {}),
      deniedAtMs: entry.deniedAtMs,
    });
  }
  if (typeof attributes.denialsAvailable !== "boolean") {
    throw new Error("PIP response was malformed.");
  }
  return {
    schema,
    sources,
    attributes: { memberships, denials, denialsAvailable: attributes.denialsAvailable },
  };
}

export async function fetchPipState(): Promise<PipState> {
  const res = await apiFetch("/api/security/pip");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof body?.error === "string" && body.error !== ""
        ? body.error
        : "Failed to load PIP state.";
    throw new Error(message);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return parsePipState(body);
}
