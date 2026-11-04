/**
 * #2171 (parent #1717) — access management for agents as subjects
 * of the IAAA system.
 *
 * Consumed, not rebuilt:
 * - #1755 PDP architecture: permission-bearing grants are decided
 *   through the PDP seam (createAgentPdpChecker wraps
 *   checkPermission from iaaaPdpSeam.ts; the port form is
 *   pdpPorts.ts createInProcessPdp). This module never re-derives
 *   role grants.
 * - #1751 obligation evaluator: when a caller opts in
 *   (enforceObligations), a permission-bearing grant is additionally
 *   run through evaluateWithObligations() with the caller's
 *   authTimeMs + audit writer. Without the opt-in, obligations stay
 *   the adopting route's job, exactly as #1751 specifies.
 * - #1750 revocation targets: the bounds below reuse #1750's
 *   measurement definition (clock starts when the revoking write
 *   completes; 0 ms means the very next gate check denies) and its
 *   mechanism (fresh store reads, no cache layer in this module).
 * - #1760 audit chain: audit events are plain records shaped for
 *   the caller's sink (the hash-chained iaaaAuditStore, or a test
 *   recorder). This module performs no I/O itself; the caller
 *   supplies the sink, and an allow is returned only after the
 *   sink succeeds — audit as a condition, mirroring #1751.
 * - #1763 attribution audit: this module is the uniform
 *   allowed-call audit row G-AUD-1 asked for (agent + grant +
 *   delegating principal on every covered decision), and its
 *   agent-turn gate wiring (see mcpPermissionPorts.ts) is the
 *   threading G-AUD-2 asked for at that door. G-AUD-3 (system
 *   principal), G-AUD-4/G-AUD-5 (scanner free tools / shared
 *   instance), and G-AUD-6 (per-caller A2A identity) are NOT
 *   closed here; see the doc's residual list.
 * - #2681 service tokens: a service principal's agent id derives
 *   from its service login (agentIdForServiceLogin), and its
 *   internal id stays `service:<login>` (serviceIdentity.ts) —
 *   never a second derivation, never a shared-secret fallback.
 * - delegation.ts: delegation validity is re-checked at every
 *   invocation (never assumed from creation), and budget
 *   consumption follows its persist-the-returned-copy discipline —
 *   this module persists the incremented grant itself, so
 *   budget exhaustion is enforced by the gate rather than by
 *   caller discipline (see authorizeAgentInvocation). Issue
 *   #3153 (Q8, owner directive 2026-11-04) extends that
 *   discipline to the delegation itself: a delegation-backed
 *   allow persists the delegation's incremented usedActions
 *   alongside the grant's, and a delegation whose action-count
 *   budget is spent denies with BUDGET_EXHAUSTED. The same
 *   slice adds approval-record binding at invocation (step 3b):
 *   an invocation carrying an approval is allowed only when
 *   the stored approval record validates — same hash, same
 *   version, same tenant, action granted, unexpired, unrevoked
 *   — so a material proposal change after approval cannot
 *   settle on the old approval.
 *
 * Identity: an agent id is `agent:<kind>:<slug>` — a namespace no
 * user id can collide with (user ids are UUIDs, `v1:` hashes, or
 * `service:<login>`). The id is stable across runs and distinct
 * from the user the agent acts for; the delegating principal is
 * recorded on the identity (and, when a delegation backs the
 * grant, on the delegation) so an action attributes to agent +
 * principal, never to a shared token or a synthetic login.
 *
 * Grants: a grant names one target (tool, route, agent, or data
 * scope) in one tenant, optionally bounded by purpose, resource
 * scope, expiry, and an action-count budget. Matching is EXACT:
 * the target string must equal the grant's target, and a purpose
 * bound grant requires the same purpose. Default-deny: no
 * matching grant, no access — and no single factor ever grants.
 * A permission-bearing grant additionally requires a PDP allow
 * for the delegating principal (or the agent id when no principal
 * is recorded); a permission-less grant is governed by the grant
 * + delegation checks alone, and no PDP is consulted for it.
 *
 * Revocation bounds (per #1750's measurement definition; this
 * module caches nothing, so every check is a fresh store read):
 * - grant revocation: 0 ms — the next authorize denies.
 * - identity revocation: 0 ms — and it cascades to the identity's
 *   grants in the same operation (a grant checked after identity
 *   revocation denies via the identity check even before the
 *   cascade lands, so the cascade is belt-and-braces, not the bound).
 * - delegation revocation: 0 ms — authorize re-reads the
 *   delegation store on every call; revoking the delegation denies
 *   even when its grants are left untouched.
 * - expiry: 0 ms past the deadline (exclusive: a check at
 *   expiresAtMs denies).
 * - in-flight work: DEFINED, not implicit — a decision already
 *   returned is never retroactively killed. Only NEW invocations
 *   deny. A started execution keeps its seal; its next tool
 *   invocation re-authorizes and denies. Scheduled runs
 *   re-authorize at run start; a run already executing runs to
 *   completion, and its next invocation denies.
 * - cross-isolate caveat: these bounds bind gates that read the
 *   stores fresh. If an adopting gate caches identity/grant
 *   records, that gate's cache TTL becomes its bound and must be
 *   stated by that gate — it is not folded into these numbers.
 *
 * Enforcement mode (platform-only switch, never caller-set):
 * IAAA_AGENT_ACCESS_MODE unset/blank/"off" → off (the pure module
 * is available, live gates unchanged); "audit" → shadow (the
 * gate evaluates and audits would-deny, but never denies);
 * "enforce" → deny on grant failure. Any other value → off with
 * invalid=true (visible misconfiguration, never a silent upgrade
 * to enforce and never a silent downgrade from it — the default
 * is preserved and the caller must log/audit the invalid flag).
 * The switch itself is admin/platform-controlled by construction:
 * resolveAgentAccessMode reads ONLY the platform env object
 * passed by the gate; there is no run, session, or user carrier
 * for it, so a gated subject cannot configure away its own
 * enforcement (the program's security guard).
 *
 * What is NOT wired here (named residuals, not silent gaps):
 * - Durable persistence beyond the store interfaces: memory
 *   stores ship here; the KV adapter below runs over any KvLike
 *   (the caller supplies its bucket, e.g. the SessionStore DO
 *   bucket via createStoreKv, as #2681 does). Provisioning UX
 *   and SessionStore-bucket wiring belong to CTO-lane #945
 *   adoption, which owns that store — this slice does not invent
 *   a second bucket.
 * - A2A dispatch: UNCHANGED. The shared A2A_API_TOKEN gate stays
 *   exactly as #2053 governs it (aliasing token names is
 *   forbidden there); agent grants apply to A2A only once #945
 *   wiring resolves an A2A caller to an agent identity, which
 *   does not exist today (G-AUD-6). No A2A path in this slice
 *   claims per-caller identity.
 * - Human role/membership UI (#2688): untouched except where
 *   agent delegation touches it (the delegator must hold the
 *   permission they delegate, via the PDP/delegation checks).
 *
 * Cloud-native but cloud-agnostic: this module is pure — no
 * Cloudflare imports, no I/O, no network. Stores are interfaces;
 * the only adapters are the in-memory stores and the KvLike
 * adapter, both backend-neutral.
 */

import {
  PERMISSIONS,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  recheckDelegation,
  type Delegation,
  type DelegationStore,
} from "./delegation";
import {
  validateApproval,
  type Approval,
  type ApprovalStore,
} from "./lifecycle";
import { checkPermission } from "./iaaaPdpSeam";
import {
  evaluateWithObligations,
  type ObligationAuditWriter,
} from "./obligations";
import { isLoginShaped } from "./serviceIdentity";
import type { KvLike } from "./kvResilience";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type AgentKind = "fleet" | "a2a" | "mcp" | "scheduled" | "service";

const AGENT_KINDS: readonly AgentKind[] = [
  "fleet",
  "a2a",
  "mcp",
  "scheduled",
  "service",
];

const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
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

/**
 * The stable id for an agent: `agent:<kind>:<slug>`. Throws on an
 * unknown kind or a malformed slug — ids are never built from
 * unvalidated input, because an id is an authority boundary.
 */
export function agentIdentityId(kind: AgentKind, slug: string): string {
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown agent kind: ${String(kind)}`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid agent slug: ${slug}`);
  }
  return `agent:${kind}:${slug}`;
}

/** Parse an agent id back into kind + slug, or null when not one. */
export function parseAgentIdentityId(
  id: string,
): { kind: AgentKind; slug: string } | null {
  if (typeof id !== "string" || !id.startsWith("agent:")) return null;
  const rest = id.slice("agent:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const kind = rest.slice(0, colon);
  const slug = rest.slice(colon + 1);
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) return null;
  if (!SLUG_PATTERN.test(slug)) return null;
  return { kind: kind as AgentKind, slug };
}

/**
 * The agent id for a service principal (#2681): `agent:service:<login>`,
 * derived from the same login whose internal id is `service:<login>`.
 * Throws on a malformed login — never a fallback identity.
 */
export function agentIdForServiceLogin(login: string): string {
  if (!isLoginShaped(login)) {
    throw new Error(`invalid service login for agent id: ${String(login)}`);
  }
  return `agent:service:${login}`;
}

export interface AgentIdentity {
  id: string;
  kind: AgentKind;
  /** Tenant this identity is bound to, when bound. Unset = unbound. */
  tenantId?: string;
  /** Human (or service) principal that delegated to this agent, when any. */
  delegatingPrincipalInternalUserId?: string;
  /** Delegation backing this identity, when any. */
  delegationId?: string;
  displayName?: string;
  revoked: boolean;
  revokedAtMs?: number;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface AgentIdentityStore {
  get(id: string): Promise<AgentIdentity | null>;
  put(identity: AgentIdentity): Promise<void>;
}

export function createMemoryAgentIdentityStore(): AgentIdentityStore {
  const byId = new Map<string, AgentIdentity>();
  return {
    async get(id: string): Promise<AgentIdentity | null> {
      return byId.get(id) ?? null;
    },
    async put(identity: AgentIdentity): Promise<void> {
      byId.set(identity.id, identity);
    },
  };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type AgentGrantTargetKind = "tool" | "route" | "agent" | "data";

const GRANT_TARGET_KINDS: readonly AgentGrantTargetKind[] = [
  "tool",
  "route",
  "agent",
  "data",
];

export interface AgentGrant {
  id: string;
  agentId: string;
  targetKind: AgentGrantTargetKind;
  /** Exact target: tool name, route pattern, agent id, or data scope. */
  target: string;
  tenantId: string;
  /** When set, the invocation must carry exactly this purpose. */
  purpose?: string;
  /** Empty = not resource-restricted within the tenant. */
  resourceScope: string[];
  /** When set, a PDP allow for this permission is also required. */
  permission?: Permission;
  maxActions?: number;
  usedActions: number;
  /** Delegation backing this grant, when any. */
  delegationId?: string;
  revoked: boolean;
  revokedAtMs?: number;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface AgentGrantStore {
  get(id: string): Promise<AgentGrant | null>;
  put(grant: AgentGrant): Promise<void>;
  listByAgent(agentId: string): Promise<AgentGrant[]>;
}

export function createMemoryAgentGrantStore(): AgentGrantStore {
  const byId = new Map<string, AgentGrant>();
  return {
    async get(id: string): Promise<AgentGrant | null> {
      return byId.get(id) ?? null;
    },
    async put(grant: AgentGrant): Promise<void> {
      byId.set(grant.id, grant);
    },
    async listByAgent(agentId: string): Promise<AgentGrant[]> {
      return [...byId.values()].filter((g) => g.agentId === agentId);
    },
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type AgentIdentityErrorCode =
  | "INVALID_KIND"
  | "INVALID_SLUG"
  | "INVALID_TENANT"
  | "INVALID_EXPIRY"
  | "IDENTITY_EXISTS";

export type AgentIdentityResult =
  | { ok: true; identity: AgentIdentity }
  | { ok: false; code: AgentIdentityErrorCode; error: string };

export interface CreateAgentIdentityInput {
  kind: AgentKind;
  slug: string;
  tenantId?: string;
  delegatingPrincipalInternalUserId?: string;
  delegationId?: string;
  displayName?: string;
  expiresAtMs?: number;
  nowMs: number;
}

export async function createAgentIdentity(
  store: AgentIdentityStore,
  input: CreateAgentIdentityInput,
): Promise<AgentIdentityResult> {
  if (!(AGENT_KINDS as readonly string[]).includes(String(input.kind))) {
    return { ok: false, code: "INVALID_KIND", error: `unknown agent kind: ${String(input.kind)}` };
  }
  if (!SLUG_PATTERN.test(input.slug)) {
    return { ok: false, code: "INVALID_SLUG", error: `invalid agent slug: ${input.slug}` };
  }
  if (input.tenantId !== undefined && !isValidField(input.tenantId)) {
    return { ok: false, code: "INVALID_TENANT", error: "tenantId must be a non-empty string" };
  }
  if (input.expiresAtMs !== undefined && input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "INVALID_EXPIRY", error: "expiresAtMs must be after nowMs" };
  }
  const id = agentIdentityId(input.kind, input.slug);
  if (await store.get(id)) {
    return { ok: false, code: "IDENTITY_EXISTS", error: `agent identity already exists: ${id}` };
  }
  const identity: AgentIdentity = {
    id,
    kind: input.kind,
    tenantId: input.tenantId !== undefined ? normalize(input.tenantId) : undefined,
    delegatingPrincipalInternalUserId:
      input.delegatingPrincipalInternalUserId !== undefined
        ? normalize(input.delegatingPrincipalInternalUserId)
        : undefined,
    delegationId: input.delegationId,
    displayName: input.displayName,
    revoked: false,
    createdAtMs: input.nowMs,
    expiresAtMs: input.expiresAtMs,
  };
  await store.put(identity);
  return { ok: true, identity };
}

export type AgentGrantErrorCode =
  | "UNKNOWN_AGENT"
  | "INVALID_TARGET_KIND"
  | "INVALID_TARGET"
  | "INVALID_TENANT"
  | "INVALID_PERMISSION"
  | "INVALID_EXPIRY"
  | "INVALID_BUDGET"
  | "DELEGATION_UNKNOWN"
  | "DELEGATION_MISMATCH"
  | "DELEGATION_REVOKED"
  | "DELEGATION_EXPIRED"
  | "ACTION_NOT_DELEGATED";

export type AgentGrantResult =
  | { ok: true; grant: AgentGrant }
  | { ok: false; code: AgentGrantErrorCode; error: string };

export interface CreateAgentGrantInput {
  agentId: string;
  targetKind: AgentGrantTargetKind;
  target: string;
  tenantId: string;
  purpose?: string;
  resourceScope: string[];
  permission?: Permission;
  maxActions?: number;
  expiresAtMs?: number;
  delegationId?: string;
  nowMs: number;
}

export async function createAgentGrant(
  identities: AgentIdentityStore,
  grants: AgentGrantStore,
  delegations: DelegationStore | undefined,
  input: CreateAgentGrantInput,
): Promise<AgentGrantResult> {
  const identity = await identities.get(input.agentId);
  if (!identity) {
    return { ok: false, code: "UNKNOWN_AGENT", error: `unknown agent: ${input.agentId}` };
  }
  if (!(GRANT_TARGET_KINDS as readonly string[]).includes(String(input.targetKind))) {
    return { ok: false, code: "INVALID_TARGET_KIND", error: `unknown grant target kind: ${String(input.targetKind)}` };
  }
  if (!isValidField(input.target)) {
    return { ok: false, code: "INVALID_TARGET", error: "target must be a non-empty string" };
  }
  if (!isValidField(input.tenantId)) {
    return { ok: false, code: "INVALID_TENANT", error: "tenantId must be a non-empty string" };
  }
  if (
    input.permission !== undefined &&
    !(PERMISSIONS as readonly string[]).includes(String(input.permission))
  ) {
    return { ok: false, code: "INVALID_PERMISSION", error: `unknown permission: ${String(input.permission)}` };
  }
  if (input.expiresAtMs !== undefined && input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "INVALID_EXPIRY", error: "expiresAtMs must be after nowMs" };
  }
  if (
    input.maxActions !== undefined &&
    (typeof input.maxActions !== "number" ||
      !Number.isInteger(input.maxActions) ||
      input.maxActions < 0)
  ) {
    return { ok: false, code: "INVALID_BUDGET", error: "maxActions must be a non-negative integer" };
  }
  if (input.delegationId !== undefined && delegations !== undefined) {
    const delegation = await delegations.get(input.delegationId);
    if (!delegation) {
      return { ok: false, code: "DELEGATION_UNKNOWN", error: `unknown delegation: ${input.delegationId}` };
    }
    // A revoked or expired delegation backs nothing new: creation
    // re-checks validity, not just existence (#3153). A grant
    // minted against a dead delegation would deny at its first
    // invocation anyway; refusing it here keeps dead grants out
    // of the store entirely.
    const recheck = recheckDelegation(delegation, input.nowMs);
    if (!recheck.valid) {
      return {
        ok: false,
        code: recheck.reason,
        error: recheck.reason === "DELEGATION_REVOKED" ? "delegation is revoked" : "delegation is expired",
      };
    }
    if (
      delegation.delegateAgentId !== input.agentId ||
      delegation.tenantId !== normalize(input.tenantId)
    ) {
      return { ok: false, code: "DELEGATION_MISMATCH", error: "delegation does not name this agent in this tenant" };
    }
    if (
      input.permission !== undefined &&
      !delegation.allowedActions.includes(input.permission)
    ) {
      return { ok: false, code: "ACTION_NOT_DELEGATED", error: `delegation does not grant permission: ${input.permission}` };
    }
  }
  const grant: AgentGrant = {
    id: crypto.randomUUID(),
    agentId: input.agentId,
    targetKind: input.targetKind,
    target: normalize(input.target),
    tenantId: normalize(input.tenantId),
    purpose: input.purpose !== undefined ? normalize(input.purpose) : undefined,
    resourceScope: input.resourceScope.map((r) => normalize(String(r))),
    permission: input.permission,
    maxActions: input.maxActions,
    usedActions: 0,
    delegationId: input.delegationId,
    revoked: false,
    createdAtMs: input.nowMs,
    expiresAtMs: input.expiresAtMs,
  };
  await grants.put(grant);
  return { ok: true, grant };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** Revoke one grant; returns false when it does not exist. */
export async function revokeAgentGrant(
  store: AgentGrantStore,
  grantId: string,
  nowMs: number,
): Promise<boolean> {
  const grant = await store.get(grantId);
  if (!grant) return false;
  if (!grant.revoked) {
    await store.put({ ...grant, revoked: true, revokedAtMs: nowMs });
  }
  return true;
}

/**
 * Revoke an identity and cascade to its grants in the same
 * operation. The cascade is belt-and-braces: authorize denies on
 * the identity check before it ever reaches a grant, so the bound
 * does not depend on the cascade completing.
 */
export async function revokeAgentIdentity(
  identities: AgentIdentityStore,
  grants: AgentGrantStore,
  agentId: string,
  nowMs: number,
): Promise<{ identityRevoked: boolean; grantsRevoked: number }> {
  const identity = await identities.get(agentId);
  if (!identity) return { identityRevoked: false, grantsRevoked: 0 };
  let grantsRevoked = 0;
  if (!identity.revoked) {
    await identities.put({ ...identity, revoked: true, revokedAtMs: nowMs });
  }
  for (const grant of await grants.listByAgent(agentId)) {
    if (!grant.revoked) {
      await grants.put({ ...grant, revoked: true, revokedAtMs: nowMs });
      grantsRevoked += 1;
    }
  }
  return { identityRevoked: true, grantsRevoked };
}

/**
 * Revoke every not-yet-revoked grant backed by a delegation;
 * returns the count. A delegation names exactly one delegate
 * agent, so the cascade lists that agent's grants and revokes
 * the ones carrying this delegation id. (Revoking the delegation
 * itself, via delegation.ts revokeDelegation, already denies at
 * the gate without this cascade — see the header — so this is
 * the cleanup step, not the bound.)
 */
export async function revokeGrantsForDelegation(
  delegations: DelegationStore,
  grants: AgentGrantStore,
  delegationId: string,
  nowMs: number,
): Promise<number> {
  const delegation = await delegations.get(delegationId);
  if (!delegation) return 0;
  let count = 0;
  for (const grant of await grants.listByAgent(delegation.delegateAgentId)) {
    if (grant.delegationId === delegationId && !grant.revoked) {
      await grants.put({ ...grant, revoked: true, revokedAtMs: nowMs });
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// KV adapters (backend-neutral: any KvLike, e.g. a SessionStore DO
// bucket via createStoreKv as #2681 does — no bucket is created here)
// ---------------------------------------------------------------------------

const IDENTITY_KEY_PREFIX = "agent-identity:";
const GRANT_KEY_PREFIX = "agent-grant:";
const GRANTS_INDEX_PREFIX = "agent-grants:";

function isAgentIdentityValue(value: unknown): value is AgentIdentity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (AGENT_KINDS as readonly string[]).includes(String(v.kind)) &&
    typeof v.revoked === "boolean" &&
    typeof v.createdAtMs === "number"
  );
}

function isAgentGrantValue(value: unknown): value is AgentGrant {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.agentId === "string" &&
    (GRANT_TARGET_KINDS as readonly string[]).includes(String(v.targetKind)) &&
    typeof v.target === "string" &&
    typeof v.tenantId === "string" &&
    Array.isArray(v.resourceScope) &&
    typeof v.usedActions === "number" &&
    typeof v.revoked === "boolean" &&
    typeof v.createdAtMs === "number"
  );
}

function parseJson<T>(raw: string | null, guard: (v: unknown) => v is T): T | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createKvAgentIdentityStore(kv: KvLike): AgentIdentityStore {
  return {
    async get(id: string): Promise<AgentIdentity | null> {
      return parseJson(await kv.get(`${IDENTITY_KEY_PREFIX}${id}`), isAgentIdentityValue);
    },
    async put(identity: AgentIdentity): Promise<void> {
      await kv.put(`${IDENTITY_KEY_PREFIX}${identity.id}`, JSON.stringify(identity));
    },
  };
}

export function createKvAgentGrantStore(kv: KvLike): AgentGrantStore {
  return {
    async get(id: string): Promise<AgentGrant | null> {
      return parseJson(await kv.get(`${GRANT_KEY_PREFIX}${id}`), isAgentGrantValue);
    },
    async put(grant: AgentGrant): Promise<void> {
      await kv.put(`${GRANT_KEY_PREFIX}${grant.id}`, JSON.stringify(grant));
      const indexKey = `${GRANTS_INDEX_PREFIX}${grant.agentId}`;
      let ids: string[] = [];
      const raw = await kv.get(indexKey);
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            ids = parsed;
          }
          // A corrupt index is overwritten below with at least this
          // grant's id; other grants re-put by their owners restore
          // themselves. Listing a corrupt index never invents a grant.
        } catch {
          ids = [];
        }
      }
      if (!ids.includes(grant.id)) ids.push(grant.id);
      await kv.put(indexKey, JSON.stringify(ids));
    },
    async listByAgent(agentId: string): Promise<AgentGrant[]> {
      const raw = await kv.get(`${GRANTS_INDEX_PREFIX}${agentId}`);
      if (raw === null) return [];
      let ids: string[];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return [];
        ids = parsed;
      } catch {
        return [];
      }
      const out: AgentGrant[] = [];
      for (const id of ids) {
        const grant = parseJson(await kv.get(`${GRANT_KEY_PREFIX}${id}`), isAgentGrantValue);
        if (grant) out.push(grant);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// KV adapters for delegations and approvals (#3153): same pattern as
// the grant adapter — record keys plus a delegator index for
// delegations; corrupt records read as null, never thrown, so a
// corrupt row denies (fail-closed) instead of crashing the gate.
// ---------------------------------------------------------------------------

const DELEGATION_KEY_PREFIX = "delegation:";
const DELEGATIONS_INDEX_PREFIX = "delegations:";
const APPROVAL_KEY_PREFIX = "approval:";

function isDelegationValue(value: unknown): value is Delegation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.delegatorInternalUserId === "string" &&
    typeof v.delegateAgentId === "string" &&
    typeof v.tenantId === "string" &&
    Array.isArray(v.allowedActions) &&
    Array.isArray(v.resourceScope) &&
    typeof v.expiresAtMs === "number" &&
    typeof v.usedActions === "number" &&
    typeof v.reDelegationAllowed === "boolean" &&
    typeof v.revoked === "boolean" &&
    typeof v.createdAtMs === "number"
  );
}

function isApprovalValue(value: unknown): value is Approval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.proposalHash === "string" &&
    typeof v.proposalVersion === "string" &&
    typeof v.approverInternalUserId === "string" &&
    typeof v.tenantId === "string" &&
    Array.isArray(v.grantedActions) &&
    typeof v.scope === "string" &&
    typeof v.expiresAtMs === "number" &&
    typeof v.revoked === "boolean"
  );
}

export function createKvDelegationStore(kv: KvLike): DelegationStore {
  return {
    async get(id: string): Promise<Delegation | null> {
      return parseJson(await kv.get(`${DELEGATION_KEY_PREFIX}${id}`), isDelegationValue);
    },
    async put(delegation: Delegation): Promise<void> {
      await kv.put(`${DELEGATION_KEY_PREFIX}${delegation.id}`, JSON.stringify(delegation));
      const indexKey = `${DELEGATIONS_INDEX_PREFIX}${delegation.delegatorInternalUserId}`;
      let ids: string[] = [];
      const raw = await kv.get(indexKey);
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            ids = parsed;
          }
        } catch {
          ids = [];
        }
      }
      if (!ids.includes(delegation.id)) ids.push(delegation.id);
      await kv.put(indexKey, JSON.stringify(ids));
    },
    async listByDelegator(delegatorInternalUserId: string): Promise<Delegation[]> {
      const raw = await kv.get(`${DELEGATIONS_INDEX_PREFIX}${delegatorInternalUserId}`);
      if (raw === null) return [];
      let ids: string[];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return [];
        ids = parsed;
      } catch {
        return [];
      }
      const out: Delegation[] = [];
      for (const id of ids) {
        const delegation = parseJson(await kv.get(`${DELEGATION_KEY_PREFIX}${id}`), isDelegationValue);
        if (delegation) out.push(delegation);
      }
      return out;
    },
  };
}

export function createKvApprovalStore(kv: KvLike): ApprovalStore {
  return {
    async get(id: string): Promise<Approval | null> {
      return parseJson(await kv.get(`${APPROVAL_KEY_PREFIX}${id}`), isApprovalValue);
    },
    async put(approval: Approval): Promise<void> {
      await kv.put(`${APPROVAL_KEY_PREFIX}${approval.id}`, JSON.stringify(approval));
    },
  };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/** PDP decision, in the minimal shape the gate needs. */
export interface AgentPdpDecision {
  decision: "allow" | "deny";
  reason?: string;
}

export interface AgentPdpChecker {
  (request: {
    actorInternalUserId: string;
    tenantId: string;
    permission: Permission;
    nowMs: number;
  }): Promise<AgentPdpDecision>;
}

/** The real PDP seam (#1755) as an agent PDP checker. */
export function createAgentPdpChecker(membershipStore: MembershipStore): AgentPdpChecker {
  return async (request) => {
    const decision = await checkPermission(membershipStore, {
      internalUserId: request.actorInternalUserId,
      tenantId: request.tenantId,
      permission: request.permission,
      nowMs: request.nowMs,
    });
    return { decision: decision.decision, reason: decision.reason };
  };
}

/** One agent-action audit record: agent + grant + delegating principal. */
export interface AgentActionAuditEvent {
  type: "agent.action";
  agentId: string;
  agentKind: AgentKind | null;
  grantId: string | null;
  delegatingPrincipal: string | null;
  tenantId: string;
  targetKind: AgentGrantTargetKind;
  target: string;
  purpose?: string;
  resourceId?: string;
  decision: "allow" | "deny";
  reason: AgentDenyReason | "ALLOW";
  atMs: number;
}

export type AgentAuditSink = (
  event: AgentActionAuditEvent,
) => Promise<unknown> | unknown;

export interface AgentAccessDeps {
  identities: AgentIdentityStore;
  grants: AgentGrantStore;
  delegations?: DelegationStore;
  /** Approval store for the #3153 settlement binding (step 3b). */
  approvals?: ApprovalStore;
  /** PDP checker; required for permission-bearing grants (fail-closed without it). */
  pdp?: AgentPdpChecker;
  /** Membership store for the optional #1751 obligations phase. */
  membershipStoreForObligations?: MembershipStore;
  /** Audit sink for covered decisions; an allow is returned only after it succeeds. */
  auditSink?: AgentAuditSink;
}

export interface AgentInvocationRequest {
  agentId: string;
  tenantId: string;
  targetKind: AgentGrantTargetKind;
  target: string;
  purpose?: string;
  resourceId?: string;
  nowMs: number;
  /** Opt-in #1751 obligations phase (permission-bearing grants only). */
  enforceObligations?: boolean;
  authTimeMs?: number;
  obligationAudit?: ObligationAuditWriter;
  /**
   * Settlement approval (#3153, Q8): when present, the stored
   * approval record must validate — same hash, same version,
   * same tenant, action granted, unexpired, unrevoked — or the
   * invocation denies. The id is a lookup key, never authority:
   * the record is loaded and validated, so a caller-supplied id
   * grants nothing by itself. Absent, this step is skipped.
   */
  approval?: {
    id: string;
    proposalHash: string;
    proposalVersion?: string;
  };
}

export type AgentDenyReason =
  | "IDENTITY_UNKNOWN"
  | "IDENTITY_REVOKED"
  | "IDENTITY_EXPIRED"
  | "CROSS_TENANT"
  | "NO_GRANT"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "PURPOSE_MISMATCH"
  | "OUT_OF_RESOURCE_SCOPE"
  | "BUDGET_EXHAUSTED"
  | "DELEGATION_UNKNOWN"
  | "DELEGATION_REVOKED"
  | "DELEGATION_EXPIRED"
  | "DELEGATE_MISMATCH"
  | "ACTION_NOT_DELEGATED"
  | "APPROVAL_UNKNOWN"
  | "APPROVAL_INVALID"
  | "PDP_UNAVAILABLE"
  | "PDP_DENIED"
  | "PDP_ERROR"
  | "OBLIGATION_FAILED"
  | "AUDIT_FAILED"
  | "PERSIST_FAILED";

export interface AgentInvocationDecision {
  decision: "allow" | "deny";
  reason: "ALLOW" | AgentDenyReason;
  identity: AgentIdentity | null;
  /** On allow: the persisted grant copy (usedActions incremented). On deny: the matched grant, if any. */
  grant: AgentGrant | null;
  delegatingPrincipal: string | null;
  auditEvent: AgentActionAuditEvent;
}

/**
 * Authorize one agent invocation. Checks run in fixed order and
 * the first deny wins, so a deny reason names exactly one failed
 * factor. Every decision is audited through the caller's sink
 * when one is supplied: deny audits are best-effort (a failing
 * sink never changes a deny), but an allow audit failure denies
 * with AUDIT_FAILED and persists nothing — an unaudited allow is
 * impossible, mirroring #1751's audit-before-allow.
 *
 * On allow, the incremented grant copy is persisted here (a
 * persist failure denies with PERSIST_FAILED) so budget
 * exhaustion is enforced by the gate, not by caller discipline.
 * A delegation-backed allow additionally persists the
 * delegation's incremented copy (#3153): the delegation budget
 * is consumed by the gate, not by a pure-copy caller. The caller
 * must re-authorize per invocation: a decision is a point-in-time
 * verdict, and revocation after it does not recall it.
 */
export async function authorizeAgentInvocation(
  deps: AgentAccessDeps,
  request: AgentInvocationRequest,
): Promise<AgentInvocationDecision> {
  const tenantId = normalize(request.tenantId);
  let identity: AgentIdentity | null = null;
  let grant: AgentGrant | null = null;
  let delegatingPrincipal: string | null = null;
  // The delegation backing this invocation, when any — captured in
  // step 3 for the allow-path budget persist (step 6).
  let delegation: Delegation | null = null;

  const audit = async (
    decision: "allow" | "deny",
    reason: "ALLOW" | AgentDenyReason,
  ): Promise<AgentActionAuditEvent> => {
    const event: AgentActionAuditEvent = {
      type: "agent.action",
      agentId: request.agentId,
      agentKind: identity?.kind ?? null,
      grantId: grant?.id ?? null,
      delegatingPrincipal,
      tenantId,
      targetKind: request.targetKind,
      target: request.target,
      purpose: request.purpose,
      resourceId: request.resourceId,
      decision,
      reason,
      atMs: request.nowMs,
    };
    return event;
  };

  const deny = async (
    reason: AgentDenyReason,
  ): Promise<AgentInvocationDecision> => {
    const event = await audit("deny", reason);
    if (deps.auditSink) {
      try {
        await deps.auditSink(event);
      } catch {
        // Deny audits are best-effort: the deny stands regardless.
      }
    }
    return { decision: "deny", reason, identity, grant, delegatingPrincipal, auditEvent: event };
  };

  // 1. Identity: must exist, be unrevoked, unexpired, tenant-bound.
  identity = await deps.identities.get(request.agentId);
  if (!identity) return deny("IDENTITY_UNKNOWN");
  delegatingPrincipal = identity.delegatingPrincipalInternalUserId ?? null;
  if (identity.revoked) return deny("IDENTITY_REVOKED");
  if (identity.expiresAtMs !== undefined && identity.expiresAtMs <= request.nowMs) {
    return deny("IDENTITY_EXPIRED");
  }
  if (identity.tenantId !== undefined && identity.tenantId !== tenantId) {
    return deny("CROSS_TENANT");
  }

  // 2. Grant: exact target match in this tenant, then purpose match.
  const byAgent = await deps.grants.listByAgent(request.agentId);
  const targetMatches = byAgent.filter(
    (g) => g.targetKind === request.targetKind && g.target === normalize(request.target),
  );
  if (targetMatches.length === 0) return deny("NO_GRANT");
  const tenantMatches = targetMatches.filter((g) => g.tenantId === tenantId);
  if (tenantMatches.length === 0) return deny("CROSS_TENANT");
  const purposeMatches = tenantMatches.filter(
    (g) => g.purpose === undefined || (request.purpose !== undefined && g.purpose === normalize(request.purpose)),
  );
  if (purposeMatches.length === 0) return deny("PURPOSE_MISMATCH");
  grant = purposeMatches[0];
  if (grant.revoked) return deny("GRANT_REVOKED");
  if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) {
    return deny("GRANT_EXPIRED");
  }
  if (
    request.resourceId !== undefined &&
    grant.resourceScope.length > 0 &&
    !grant.resourceScope.includes(normalize(request.resourceId))
  ) {
    return deny("OUT_OF_RESOURCE_SCOPE");
  }
  if (grant.maxActions !== undefined && grant.usedActions >= grant.maxActions) {
    return deny("BUDGET_EXHAUSTED");
  }

  // 3. Delegation: re-read fresh on every call; a revoked or
  // expired delegation denies even when its grants are untouched.
  const delegationId = grant.delegationId ?? identity.delegationId;
  if (delegationId !== undefined) {
    if (!deps.delegations) return deny("DELEGATION_UNKNOWN");
    const found = await deps.delegations.get(delegationId);
    if (!found) return deny("DELEGATION_UNKNOWN");
    delegation = found;
    delegatingPrincipal =
      identity.delegatingPrincipalInternalUserId ?? delegation.delegatorInternalUserId;
    const validity = recheckDelegation(delegation, request.nowMs);
    if (!validity.valid) {
      return deny(validity.reason === "DELEGATION_REVOKED" ? "DELEGATION_REVOKED" : "DELEGATION_EXPIRED");
    }
    if (delegation.delegateAgentId !== request.agentId) return deny("DELEGATE_MISMATCH");
    if (delegation.tenantId !== tenantId) return deny("CROSS_TENANT");
    if (
      grant.permission !== undefined &&
      !delegation.allowedActions.includes(grant.permission)
    ) {
      return deny("ACTION_NOT_DELEGATED");
    }
    if (
      request.resourceId !== undefined &&
      delegation.resourceScope.length > 0 &&
      !delegation.resourceScope.includes(normalize(request.resourceId))
    ) {
      return deny("OUT_OF_RESOURCE_SCOPE");
    }
    // 3a. Delegation budget (#3153): the delegation's own
    // action-count budget is enforced here, not just the grant's.
    // A delegation with no budget is unbounded, as before.
    if (
      delegation.budget?.maxActions !== undefined &&
      delegation.usedActions >= delegation.budget.maxActions
    ) {
      return deny("BUDGET_EXHAUSTED");
    }
  } else {
    delegatingPrincipal = identity.delegatingPrincipalInternalUserId ?? null;
  }

  // 3b. Approval binding (#3153, Q8): when the invocation carries
  // a settlement approval, the stored record must validate. A
  // material proposal change after approval — hash or version
  // mismatch — denies with APPROVAL_INVALID, as do revocation,
  // expiry, tenant mismatch, and an ungranted action. An
  // unresolvable approval (no store wired, or no such record)
  // denies with APPROVAL_UNKNOWN: an approval that cannot be
  // verified never settles. This step runs after the delegation
  // checks, so the first deny names the delegation failure when
  // both fail.
  if (request.approval !== undefined) {
    if (!deps.approvals) return deny("APPROVAL_UNKNOWN");
    const approval = await deps.approvals.get(request.approval.id);
    if (!approval) return deny("APPROVAL_UNKNOWN");
    const validation = validateApproval(approval, {
      proposalHash: request.approval.proposalHash,
      proposalVersion: request.approval.proposalVersion,
      action: grant.permission,
      tenantId,
      nowMs: request.nowMs,
    });
    if (!validation.valid) return deny("APPROVAL_INVALID");
  }

  // 4. PDP seam: permission-bearing grants need a PDP allow for the
  // delegating principal (or the agent id when no principal is
  // recorded). A PDP error or a missing PDP denies — never allows.
  const actor = delegatingPrincipal ?? request.agentId;
  if (grant.permission !== undefined) {
    if (!deps.pdp) return deny("PDP_UNAVAILABLE");
    let pdpDecision: AgentPdpDecision;
    try {
      pdpDecision = await deps.pdp({
        actorInternalUserId: actor,
        tenantId,
        permission: grant.permission,
        nowMs: request.nowMs,
      });
    } catch {
      return deny("PDP_ERROR");
    }
    if (pdpDecision.decision !== "allow") return deny("PDP_DENIED");

    // 5. Obligations (#1751), only when the caller opts in: the
    // evaluator re-runs the PDP seam and enforces the permission's
    // declared obligations (step-up, audit-before-allow) in order.
    if (request.enforceObligations) {
      if (!deps.membershipStoreForObligations) return deny("OBLIGATION_FAILED");
      const withObligations = await evaluateWithObligations(
        deps.membershipStoreForObligations,
        {
          internalUserId: actor,
          tenantId,
          permission: grant.permission,
          nowMs: request.nowMs,
          authTimeMs: request.authTimeMs,
          audit: request.obligationAudit,
        },
      );
      if (withObligations.decision !== "allow") return deny("OBLIGATION_FAILED");
    }
  }

  // 6. Allow: audit first (a failing sink denies, persisting
  // nothing), then persist the consumed budget: the delegation's
  // incremented copy first (#3153), then the grant's. Ordering
  // is fail-closed in one direction only, and it is stated
  // plainly: if the delegation persist succeeds but the grant
  // persist fails, the delegation has consumed one action
  // without a grant consumption — the delegation budget denies
  // earlier, never allows extra. The reverse order would risk
  // the opposite: a consumed grant against an unconsumed
  // delegation, i.e. one extra delegated action.
  const incremented: AgentGrant = { ...grant, usedActions: grant.usedActions + 1 };
  const allowEvent = await audit("allow", "ALLOW");
  if (deps.auditSink) {
    try {
      await deps.auditSink(allowEvent);
    } catch {
      return deny("AUDIT_FAILED");
    }
  }
  try {
    if (delegation !== null && deps.delegations !== undefined) {
      await deps.delegations.put({ ...delegation, usedActions: delegation.usedActions + 1 });
    }
    await deps.grants.put(incremented);
  } catch {
    const persistEvent = await audit("deny", "PERSIST_FAILED");
    if (deps.auditSink) {
      try {
        await deps.auditSink(persistEvent);
      } catch {
        // Best-effort, as with every deny audit.
      }
    }
    return {
      decision: "deny",
      reason: "PERSIST_FAILED",
      identity,
      grant,
      delegatingPrincipal,
      auditEvent: persistEvent,
    };
  }
  return {
    decision: "allow",
    reason: "ALLOW",
    identity,
    grant: incremented,
    delegatingPrincipal,
    auditEvent: allowEvent,
  };
}

// ---------------------------------------------------------------------------
// Enforcement mode switch (platform env only — see header)
// ---------------------------------------------------------------------------

export type AgentAccessMode = "off" | "audit" | "enforce";

export const AGENT_ACCESS_MODE_SWITCH = "IAAA_AGENT_ACCESS_MODE" as const;

export interface ResolvedAgentAccessMode {
  mode: AgentAccessMode;
  /** True when the platform configuration was present but unusable. */
  invalid: boolean;
}

export function resolveAgentAccessMode(
  platformEnv: Record<string, unknown> | null | undefined,
): ResolvedAgentAccessMode {
  const raw = platformEnv?.[AGENT_ACCESS_MODE_SWITCH];
  if (raw === undefined || raw === null) return { mode: "off", invalid: false };
  if (typeof raw !== "string") return { mode: "off", invalid: true };
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return { mode: "off", invalid: false };
  if (normalized === "off") return { mode: "off", invalid: false };
  if (normalized === "audit") return { mode: "audit", invalid: false };
  if (normalized === "enforce") return { mode: "enforce", invalid: false };
  return { mode: "off", invalid: true };
}

/** Revocation propagation bounds, in #1750's measurement terms. */
export const AGENT_REVOCATION_BOUNDS = Object.freeze({
  /** Grant revocation: next gate check denies. */
  grantRevocationMs: 0,
  /** Identity revocation (plus cascade to grants): next gate check denies. */
  identityRevocationMs: 0,
  /** Delegation revocation: next gate check denies, grants untouched. */
  delegationRevocationMs: 0,
  /** Expiry: 0 ms past the deadline (exclusive boundary). */
  expiryMs: 0,
});
