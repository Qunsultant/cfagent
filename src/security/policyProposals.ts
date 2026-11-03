/**
 * Issue #2838 (sub-issue of #2837) — PAP editor: approval-gated
 * policy administration for the IAAA authorization system.
 *
 * Design (stated plainly, because #1755 deferred exactly this):
 * - ONE policy, ONE validation path. A proposal carries a
 *   PolicySnapshot validated by #1755's parsePolicySnapshot()
 *   (pdpPorts.ts) — the same validator the snapshot policy source
 *   uses. The compiled ROLE_GRANTS tables in authorization.ts
 *   stay authoritative until a promotion completes: writing a
 *   proposal changes nothing, approving changes nothing, and only
 *   a successful promotion replaces the PAP-active snapshot.
 * - Proposal workflow: platform-admin proposes → a DIFFERENT
 *   platform-admin approves (proposer ≠ approver by default) →
 *   promotion re-validates and then, only then, swaps the active
 *   snapshot. Any exception to proposer ≠ approver needs a NAMED
 *   reason recorded on the proposal (exceptionReason); without
 *   one, self-approval is refused.
 * - Platform-only. Proposals carry tenantScope "platform" always.
 *   Tenant admins never administer platform policy: propose,
 *   approve, reject, and promote all require platform-admin, and
 *   the routes re-check it (this module takes the caller's
 *   platform-admin flag as input — it never decides adminhood
 *   itself, so a route cannot smuggle a tenant admin through).
 * - Fail-closed. An invalid proposal is never created; a failed
 *   promotion returns the previous active snapshot untouched and
 *   leaves the proposal unpromoted (still "approved", so a fixed
 *   re-promotion is possible without re-approval); a stored
 *   proposal that no longer validates is refused at promotion.
 * - Versioning: none invented beyond #1755's version string.
 *   A proposal's beforeRef/afterRef are `version:digest` over the
 *   snapshot's canonical JSON — references for audit, not a new
 *   versioning scheme. The digest is a reference hash only; the
 *   tamper evidence lives in the #1760 chained-hash audit store
 *   the routes append to, never in this digest.
 * - Audit + traces: every transition builds an audit event via
 *   policyProposalAuditInput() — proposer, approver, before/after
 *   refs, timestamp, platform scope — with the proposal's
 *   correlationId carried verbatim, so the record joins to a
 *   #2808 trace by that id. The correlation id is caller-supplied
 *   (a traceparent) when the caller has one, else a fresh UUID
 *   minted at proposal time and recorded on every later event.
 * - OBLIGATION_POLICY (#1751) is OUT of scope here: this module
 *   neither reads nor writes it, and no proposal can carry it.
 *   Whether it is editable at all is a carried question (§15).
 *
 * Cloud-native but cloud-agnostic: this module is pure — no
 * Cloudflare imports, no I/O. The KV-backed store adapter takes
 * an injected { get, put } pair; the routes supply the session
 * store's KvLike, tests supply memory. The live PDP is NOT
 * rewired here: the PAP-active snapshot is what the PAP routes
 * and preview evaluate, and live adoption of a promoted snapshot
 * goes through the existing platform-only
 * IAAA_PDP_POLICY_SNAPSHOT_JSON switch (#1755), an operator
 * action outside this slice — so a promotion can never silently
 * flip live enforcement. That adoption step is named in the §15
 * as the delivery boundary.
 */

import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  type AttributeProvider,
  type Membership,
  type Permission,
  type PolicySnapshot,
  type Role,
} from "./authorization";
import { parsePolicySnapshot } from "./pdpPorts";

export type PolicyProposalStatus = "proposed" | "approved" | "rejected" | "promoted";

/** A policy-change proposal. Platform scope only, by construction. */
export interface PolicyProposal {
  proposalId: string;
  status: PolicyProposalStatus;
  proposer: string;
  approver?: string;
  /** Named reason for a proposer = approver exception; absent otherwise. */
  exceptionReason?: string;
  proposedSnapshot: PolicySnapshot;
  /** `version:digest` of the snapshot active when proposed. */
  beforeRef: string;
  /** `version:digest` of the proposed snapshot. */
  afterRef: string;
  tenantScope: "platform";
  /** Traceparent / correlation id, carried onto every audit event. */
  correlationId: string;
  createdAtMs: number;
  reviewedAtMs?: number;
  promotedAtMs?: number;
}

/** Canonical JSON for a snapshot: roles in ALL_ROLES order, fields fixed. */
export function canonicalSnapshotJson(snapshot: PolicySnapshot): string {
  const roles: Role[] = [
    "platform-admin",
    "tenant-admin",
    "workspace-admin",
    "member",
    "approver",
    "auditor",
  ];
  const roleGrants: Record<string, readonly Permission[]> = {};
  for (const role of roles) roleGrants[role] = [...(snapshot.roleGrants[role] ?? [])];
  return JSON.stringify({
    version: snapshot.version,
    permissions: [...snapshot.permissions],
    roleGrants,
  });
}

/** FNV-1a reference digest (hex). A reference, NOT tamper evidence. */
export function snapshotDigest(snapshot: PolicySnapshot): string {
  const text = canonicalSnapshotJson(snapshot);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `version:digest` reference for a snapshot. */
export function snapshotRef(snapshot: PolicySnapshot): string {
  return `${snapshot.version}:${snapshotDigest(snapshot)}`;
}

// ---------------------------------------------------------------------------
// Proposal workflow (pure)
// ---------------------------------------------------------------------------

export type CreateProposalResult =
  | { ok: true; proposal: PolicyProposal }
  | { ok: false; code: "INVALID_SNAPSHOT" | "INVALID_PROPOSER"; error: string };

export interface CreateProposalInput {
  proposer: string;
  /** Unknown input: validated, never trusted, via parsePolicySnapshot(). */
  snapshotInput: unknown;
  beforeSnapshot: PolicySnapshot;
  correlationId?: string;
  nowMs: number;
}

export function createProposal(input: CreateProposalInput): CreateProposalResult {
  const proposer = input.proposer.trim();
  if (proposer === "") {
    return { ok: false, code: "INVALID_PROPOSER", error: "proposer is required." };
  }
  const parsed = parsePolicySnapshot(input.snapshotInput);
  if (!parsed.ok) {
    return { ok: false, code: "INVALID_SNAPSHOT", error: parsed.error };
  }
  const snapshot = parsed.snapshot;
  return {
    ok: true,
    proposal: {
      proposalId: crypto.randomUUID(),
      status: "proposed",
      proposer,
      proposedSnapshot: snapshot,
      beforeRef: snapshotRef(input.beforeSnapshot),
      afterRef: snapshotRef(snapshot),
      tenantScope: "platform",
      correlationId:
        input.correlationId !== undefined && input.correlationId.trim() !== ""
          ? input.correlationId.trim()
          : crypto.randomUUID(),
      createdAtMs: input.nowMs,
    },
  };
}

export type ApproveProposalResult =
  | { ok: true; proposal: PolicyProposal }
  | {
      ok: false;
      code: "NOT_PLATFORM_ADMIN" | "SELF_APPROVAL" | "WRONG_STATUS";
      error: string;
    };

export interface ApproveProposalInput {
  approver: string;
  approverIsPlatformAdmin: boolean;
  /** Named reason for a proposer = approver exception; required for self-approval. */
  exceptionReason?: string;
  nowMs: number;
}

/**
 * Approve a proposed proposal. Proposer ≠ approver by default: a
 * self-approval without a non-empty named reason is refused, and
 * a self-approval with one records the reason on the proposal.
 */
export function approveProposal(
  proposal: PolicyProposal,
  input: ApproveProposalInput,
): ApproveProposalResult {
  if (!input.approverIsPlatformAdmin) {
    return {
      ok: false,
      code: "NOT_PLATFORM_ADMIN",
      error: "approving a policy proposal requires platform-admin.",
    };
  }
  if (proposal.status !== "proposed") {
    return {
      ok: false,
      code: "WRONG_STATUS",
      error: `only a proposed proposal can be approved (status: ${proposal.status}).`,
    };
  }
  const approver = input.approver.trim();
  const reason = (input.exceptionReason ?? "").trim();
  if (approver === proposal.proposer && reason === "") {
    return {
      ok: false,
      code: "SELF_APPROVAL",
      error:
        "proposer cannot approve their own proposal without a named exception reason.",
    };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      status: "approved",
      approver,
      ...(approver === proposal.proposer ? { exceptionReason: reason } : {}),
      reviewedAtMs: input.nowMs,
    },
  };
}

export type RejectProposalResult =
  | { ok: true; proposal: PolicyProposal }
  | { ok: false; code: "NOT_PLATFORM_ADMIN" | "WRONG_STATUS"; error: string };

export interface RejectProposalInput {
  reviewer: string;
  reviewerIsPlatformAdmin: boolean;
  nowMs: number;
}

/** Reject a proposed proposal (a proposer withdrawing their own proposal is allowed). */
export function rejectProposal(
  proposal: PolicyProposal,
  input: RejectProposalInput,
): RejectProposalResult {
  if (!input.reviewerIsPlatformAdmin) {
    return {
      ok: false,
      code: "NOT_PLATFORM_ADMIN",
      error: "rejecting a policy proposal requires platform-admin.",
    };
  }
  if (proposal.status !== "proposed") {
    return {
      ok: false,
      code: "WRONG_STATUS",
      error: `only a proposed proposal can be rejected (status: ${proposal.status}).`,
    };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      status: "rejected",
      approver: input.reviewer.trim(),
      reviewedAtMs: input.nowMs,
    },
  };
}

export type PromoteProposalResult =
  | { ok: true; proposal: PolicyProposal; activeSnapshot: PolicySnapshot }
  | {
      ok: false;
      code: "WRONG_STATUS" | "INVALID_SNAPSHOT";
      error: string;
      /** The previous active snapshot, untouched. */
      activeSnapshot: PolicySnapshot;
    };

export interface PromoteProposalInput {
  activeSnapshot: PolicySnapshot;
  nowMs: number;
}

/**
 * Promote an approved proposal: the ONLY activation path. The
 * proposed snapshot is re-validated (round-tripped through JSON,
 * as a stored proposal would be); on failure the previous active
 * snapshot is returned untouched and the proposal stays
 * "approved". On success the proposal is "promoted" and the
 * returned active snapshot is the proposed one.
 */
export function promoteProposal(
  proposal: PolicyProposal,
  input: PromoteProposalInput,
): PromoteProposalResult {
  if (proposal.status !== "approved") {
    return {
      ok: false,
      code: "WRONG_STATUS",
      error: `only an approved proposal can be promoted (status: ${proposal.status}).`,
      activeSnapshot: input.activeSnapshot,
    };
  }
  const reparsed = parsePolicySnapshot(
    JSON.parse(canonicalSnapshotJson(proposal.proposedSnapshot)) as unknown,
  );
  if (!reparsed.ok) {
    return {
      ok: false,
      code: "INVALID_SNAPSHOT",
      error: `proposed snapshot no longer validates: ${reparsed.error}`,
      activeSnapshot: input.activeSnapshot,
    };
  }
  return {
    ok: true,
    proposal: { ...proposal, status: "promoted", promotedAtMs: input.nowMs },
    activeSnapshot: reparsed.snapshot,
  };
}

// ---------------------------------------------------------------------------
// Preview: decision impact BEFORE approval (nothing is activated)
// ---------------------------------------------------------------------------

export interface PolicyGrantChange {
  role: Role;
  permission: Permission;
  change: "added" | "removed";
}

/** Per-role grant diff, sorted by role then permission. */
export function diffPolicySnapshots(
  before: PolicySnapshot,
  after: PolicySnapshot,
): PolicyGrantChange[] {
  const roles: Role[] = [
    "platform-admin",
    "tenant-admin",
    "workspace-admin",
    "member",
    "approver",
    "auditor",
  ];
  const changes: PolicyGrantChange[] = [];
  for (const role of roles) {
    const beforeSet = new Set(before.roleGrants[role] ?? []);
    const afterSet = new Set(after.roleGrants[role] ?? []);
    const permissions = [...new Set([...beforeSet, ...afterSet])].sort();
    for (const permission of permissions) {
      if (beforeSet.has(permission) && !afterSet.has(permission)) {
        changes.push({ role, permission, change: "removed" });
      } else if (!beforeSet.has(permission) && afterSet.has(permission)) {
        changes.push({ role, permission, change: "added" });
      }
    }
  }
  return changes;
}

export interface PolicyDecisionPreview {
  role: Role;
  permission: Permission;
  before: "allow" | "deny";
  after: "allow" | "deny";
  changed: boolean;
}

function previewProvider(role: Role): AttributeProvider {
  const membership: Membership = {
    membershipId: `preview-${role}`,
    internalUserId: "preview-user",
    tenantId: "preview-tenant",
    roleBindings: [{ role, scope: "tenant", grantedBy: "preview" }],
    createdBy: "preview",
    createdAtMs: 0,
  };
  return { getMembershipsByUser: async () => [membership] };
}

/**
 * What the proposed snapshot WOULD decide, per probe, against the
 * current snapshot — evaluated against synthetic memberships, so
 * no live membership is consulted and nothing is activated.
 */
export async function previewDecisions(
  before: PolicySnapshot,
  after: PolicySnapshot,
  probes: Array<{ role: Role; permission: Permission }>,
  nowMs = 0,
): Promise<PolicyDecisionPreview[]> {
  const out: PolicyDecisionPreview[] = [];
  for (const probe of probes) {
    const provider = previewProvider(probe.role);
    const beforeDecision = await authorizeWithPolicy(before, provider, {
      actorInternalUserId: "preview-user",
      tenantId: "preview-tenant",
      permission: probe.permission,
      nowMs,
    });
    const afterDecision = await authorizeWithPolicy(after, provider, {
      actorInternalUserId: "preview-user",
      tenantId: "preview-tenant",
      permission: probe.permission,
      nowMs,
    });
    out.push({
      role: probe.role,
      permission: probe.permission,
      before: beforeDecision.decision,
      after: afterDecision.decision,
      changed: beforeDecision.decision !== afterDecision.decision,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit input builder (the route appends this to the #1760 store)
// ---------------------------------------------------------------------------

export type PolicyProposalAuditAction =
  | "policy.proposed"
  | "policy.approved"
  | "policy.rejected"
  | "policy.promoted";

/**
 * The audit record for one PAP transition, shaped for
 * recordAuditEvent (iaaaAudit.ts): proposer/approver attribution
 * via actor/initiator, before → after refs in resourceId,
 * proposal id in approvalId, platform scope in tenantId, and the
 * proposal's correlationId verbatim for #2808 trace joining.
 * The route supplies timestamp/policyVersion/outcome around it.
 */
export function policyProposalAuditInput(
  proposal: PolicyProposal,
  action: PolicyProposalAuditAction,
  actorPrincipalId: string,
): {
  type: "iaaa.policy";
  actorPrincipalId: string;
  actorType: "human";
  initiatingPrincipalId: string;
  tenantId: "platform";
  correlationId: string;
  action: PolicyProposalAuditAction;
  resourceId: string;
  approvalId: string;
} {
  return {
    type: "iaaa.policy",
    actorPrincipalId,
    actorType: "human",
    initiatingPrincipalId: proposal.proposer,
    tenantId: "platform",
    correlationId: proposal.correlationId,
    action,
    resourceId: `${proposal.beforeRef} -> ${proposal.afterRef}`,
    approvalId: proposal.proposalId,
  };
}

// ---------------------------------------------------------------------------
// Stores: memory (tests / preview) + injected-KV (routes)
// ---------------------------------------------------------------------------

export interface PolicyProposalStore {
  getProposal(proposalId: string): PolicyProposal | undefined;
  listProposals(): PolicyProposal[];
  putProposal(proposal: PolicyProposal): void;
  getActiveSnapshot(): PolicySnapshot;
  putActiveSnapshot(snapshot: PolicySnapshot): void;
}

/** In-memory store. The active snapshot starts as the compiled tables. */
export function createMemoryPolicyProposalStore(
  initialActive?: PolicySnapshot,
): PolicyProposalStore {
  const proposals = new Map<string, PolicyProposal>();
  let active: PolicySnapshot = initialActive ?? getCompiledPolicySnapshot();
  return {
    getProposal: (id) => proposals.get(id),
    listProposals: () =>
      [...proposals.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
    putProposal: (proposal) => {
      proposals.set(proposal.proposalId, proposal);
    },
    getActiveSnapshot: () => active,
    putActiveSnapshot: (snapshot) => {
      active = snapshot;
    },
  };
}

/** Minimal KV surface the route adapter needs (the session store's KvLike fits). */
export interface PolicyProposalKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const POLICY_PROPOSAL_KEY_PREFIX = "iaaa-policy-proposal:";
export const POLICY_PROPOSAL_ACTIVE_KEY = "iaaa-policy-proposal:active";

/** Parse + re-validate a stored proposal; corrupt stored JSON fails closed (null). */
export function parseStoredProposal(value: string): PolicyProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.proposalId !== "string" ||
    !["proposed", "approved", "rejected", "promoted"].includes(String(p.status)) ||
    typeof p.proposer !== "string" ||
    typeof p.beforeRef !== "string" ||
    typeof p.afterRef !== "string" ||
    p.tenantScope !== "platform" ||
    typeof p.correlationId !== "string" ||
    typeof p.createdAtMs !== "number"
  ) {
    return null;
  }
  const snapshot = parsePolicySnapshot(p.proposedSnapshot);
  if (!snapshot.ok) return null;
  if (snapshotRef(snapshot.snapshot) !== p.afterRef) return null;
  return {
    proposalId: p.proposalId as string,
    status: p.status as PolicyProposalStatus,
    proposer: p.proposer as string,
    ...(typeof p.approver === "string" ? { approver: p.approver } : {}),
    ...(typeof p.exceptionReason === "string"
      ? { exceptionReason: p.exceptionReason }
      : {}),
    proposedSnapshot: snapshot.snapshot,
    beforeRef: p.beforeRef as string,
    afterRef: p.afterRef as string,
    tenantScope: "platform",
    correlationId: p.correlationId as string,
    createdAtMs: p.createdAtMs as number,
    ...(typeof p.reviewedAtMs === "number" ? { reviewedAtMs: p.reviewedAtMs } : {}),
    ...(typeof p.promotedAtMs === "number" ? { promotedAtMs: p.promotedAtMs } : {}),
  };
}

/** KV-backed store over an injected KV pair (routes supply sessionStore(env)). */
export function createKvPolicyProposalStore(kv: PolicyProposalKv): {
  getProposal(proposalId: string): Promise<PolicyProposal | null>;
  putProposal(proposal: PolicyProposal): Promise<void>;
  getActiveSnapshot(): Promise<PolicySnapshot>;
  putActiveSnapshot(snapshot: PolicySnapshot): Promise<void>;
} {
  return {
    async getProposal(proposalId: string) {
      const raw = await kv.get(`${POLICY_PROPOSAL_KEY_PREFIX}${proposalId}`);
      if (raw === null) return null;
      return parseStoredProposal(raw);
    },
    async putProposal(proposal: PolicyProposal) {
      await kv.put(
        `${POLICY_PROPOSAL_KEY_PREFIX}${proposal.proposalId}`,
        JSON.stringify(proposal),
      );
    },
    async getActiveSnapshot() {
      const raw = await kv.get(POLICY_PROPOSAL_ACTIVE_KEY);
      if (raw === null) return getCompiledPolicySnapshot();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return getCompiledPolicySnapshot();
      }
      const result = parsePolicySnapshot(parsed);
      // A corrupt stored active snapshot fails closed to compiled.
      return result.ok ? result.snapshot : getCompiledPolicySnapshot();
    },
    async putActiveSnapshot(snapshot: PolicySnapshot) {
      await kv.put(POLICY_PROPOSAL_ACTIVE_KEY, canonicalSnapshotJson(snapshot));
    },
  };
}
