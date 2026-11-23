/**
 * #1755 (parent #1717) — IAAA PDP architecture ports.
 *
 * Decisions (recorded on #1755 before this build):
 * (a) TypeScript tables stay authoritative; this module adds their
 *     portable form (PolicySnapshot) and the PolicyProvider port.
 *     No policy editor: a runtime editor would be a second source
 *     of truth and an unaudited privilege path.
 * (b) The PDP stays in-process; this module defines its logical
 *     service boundary — the PolicyDecisionPoint port with a
 *     JSON-serializable request/response contract. The only live
 *     adapter is the in-process one; a future network PDP is a new
 *     adapter behind the same port, not a rewrite. No PDP HTTP
 *     endpoint is added here.
 *
 * Cloud-native but cloud-agnostic: this module is pure — no
 * Cloudflare imports, no I/O, no network. The platform env values
 * it reads are plain strings passed in by the caller.
 *
 * SECURITY — policy source is platform-only. resolvePdpPolicySource
 * reads ONLY the platform env object. There is no run, session, or
 * user carrier for it, by design: a caller-choosable policy source
 * would let a gated subject pick its own policy. Invalid source
 * or snapshot fails closed to the compiled default (invalid=true
 * so the misconfiguration is visible to the caller, which should
 * log/audit it — the PDP itself has no logger by design).
 */

import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  PERMISSIONS,
  type AttributeProvider,
  type AuthorizationDecision,
  type AuthorizationScope,
  type Permission,
  type PolicySnapshot,
  type ResourceScope,
  type Role,
} from "./authorization";

export type { PolicySnapshot } from "./authorization";

/** The compiled tables, in portable form. */
export function exportPolicySnapshot(): PolicySnapshot {
  return getCompiledPolicySnapshot();
}

const ROLES: readonly Role[] = [
  "platform-admin",
  "tenant-admin",
  "store-operator",
  "workspace-admin",
  "member",
  "approver",
  "auditor",
];

export type ParsePolicySnapshotResult =
  | { ok: true; snapshot: PolicySnapshot }
  | { ok: false; error: string };

function fail(error: string): ParsePolicySnapshotResult {
  return { ok: false, error };
}

/**
 * Validate an unknown value as a PolicySnapshot. Rejects unknown
 * permissions, unknown roles, duplicate entries, missing roles,
 * and non-object input — a malformed snapshot must never become a
 * permissive policy by omission (every role must be explicit).
 */
export function parsePolicySnapshot(value: unknown): ParsePolicySnapshotResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("policy snapshot must be an object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "string" || v.version.trim() === "") {
    return fail("policy snapshot version must be a non-empty string");
  }
  if (!Array.isArray(v.permissions)) {
    return fail("policy snapshot permissions must be an array");
  }
  const permissions: Permission[] = [];
  for (const p of v.permissions) {
    if (typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) {
      return fail(`policy snapshot has unknown permission: ${String(p)}`);
    }
    if (permissions.includes(p as Permission)) {
      return fail(`policy snapshot duplicates permission: ${p}`);
    }
    permissions.push(p as Permission);
  }
  if (
    typeof v.roleGrants !== "object" ||
    v.roleGrants === null ||
    Array.isArray(v.roleGrants)
  ) {
    return fail("policy snapshot roleGrants must be an object");
  }
  const grants = v.roleGrants as Record<string, unknown>;
  for (const key of Object.keys(grants)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      return fail(`policy snapshot has unknown role: ${key}`);
    }
  }
  const roleGrants = {} as Record<Role, readonly Permission[]>;
  for (const role of ROLES) {
    const list = grants[role];
    if (!Array.isArray(list)) {
      return fail(`policy snapshot roleGrants.${role} must be an array`);
    }
    const rolePermissions: Permission[] = [];
    for (const p of list) {
      if (typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) {
        return fail(`policy snapshot roleGrants.${role} has unknown permission: ${String(p)}`);
      }
      if (rolePermissions.includes(p as Permission)) {
        return fail(`policy snapshot roleGrants.${role} duplicates permission: ${p}`);
      }
      rolePermissions.push(p as Permission);
    }
    roleGrants[role] = rolePermissions;
  }
  return {
    ok: true,
    snapshot: { version: v.version.trim(), permissions, roleGrants },
  };
}

/** PAP port: where the PDP's policy comes from. */
export interface PolicyProvider {
  getPolicy(): PolicySnapshot | Promise<PolicySnapshot>;
}

/** The default provider: the compiled tables, as exported. */
export function compiledPolicyProvider(): PolicyProvider {
  return { getPolicy: () => getCompiledPolicySnapshot() };
}

/** A provider over an already-validated snapshot (see parsePolicySnapshot). */
export function snapshotPolicyProvider(snapshot: PolicySnapshot): PolicyProvider {
  return { getPolicy: () => snapshot };
}

export type PdpPolicySource = "code" | "snapshot";

export interface ResolvedPdpPolicySource {
  source: PdpPolicySource;
  /** True when the platform configuration was present but unusable. */
  invalid: boolean;
  snapshot?: PolicySnapshot;
}

export const PDP_POLICY_SOURCE_SWITCH = "IAAA_PDP_POLICY_SOURCE" as const;
export const PDP_POLICY_SNAPSHOT_SWITCH = "IAAA_PDP_POLICY_SNAPSHOT_JSON" as const;

/**
 * Resolve the policy source from the PLATFORM env only. Unset or
 * blank means compiled ("code"). "code" (any case) means compiled.
 * "snapshot" means the JSON in IAAA_PDP_POLICY_SNAPSHOT_JSON, when
 * it parses and validates. Anything else — unknown source, missing
 * or malformed snapshot JSON — fails closed to compiled with
 * invalid=true. No production value is set by this slice: unset
 * means compiled, exactly as before.
 */
export function resolvePdpPolicySource(
  env: Record<string, unknown> | null | undefined,
): ResolvedPdpPolicySource {
  const raw = env?.[PDP_POLICY_SOURCE_SWITCH];
  if (raw === undefined || raw === null) return { source: "code", invalid: false };
  if (typeof raw !== "string") return { source: "code", invalid: true };
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return { source: "code", invalid: false };
  if (normalized === "code") return { source: "code", invalid: false };
  if (normalized === "snapshot") {
    const json = env?.[PDP_POLICY_SNAPSHOT_SWITCH];
    if (typeof json !== "string" || json.trim() === "") {
      return { source: "code", invalid: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { source: "code", invalid: true };
    }
    const result = parsePolicySnapshot(parsed);
    if (!result.ok) return { source: "code", invalid: true };
    return { source: "snapshot", invalid: false, snapshot: result.snapshot };
  }
  return { source: "code", invalid: true };
}

/**
 * The PDP service-boundary contract: a plain-data request and a
 * plain-data decision. Both are JSON-serializable by construction
 * (no functions, no class instances), so a future network adapter
 * can carry them over HTTP without changing any caller.
 */
export interface PdpDecisionRequest {
  internalUserId: string;
  tenantId?: string;
  permission: Permission;
  scope?: AuthorizationScope;
  resourceScope?: ResourceScope;
  nowMs: number;
}

/** PDP port: decide, given a request. The decision IS the response. */
export interface PolicyDecisionPoint {
  decide(request: PdpDecisionRequest): Promise<AuthorizationDecision>;
}

/** The in-process PDP adapter: policy from the provider, attributes from the PIP. */
export function createInProcessPdp(deps: {
  policyProvider: PolicyProvider;
  attributeProvider: AttributeProvider;
}): PolicyDecisionPoint {
  return {
    async decide(request: PdpDecisionRequest): Promise<AuthorizationDecision> {
      const policy = await deps.policyProvider.getPolicy();
      return authorizeWithPolicy(policy, deps.attributeProvider, {
        actorInternalUserId: request.internalUserId,
        tenantId: request.tenantId,
        permission: request.permission,
        scope: request.scope,
        resourceScope: request.resourceScope,
        nowMs: request.nowMs,
      });
    },
  };
}
