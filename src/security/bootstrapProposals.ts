/**
 * Issue #3077 (#945 Q3) — reviewed bootstrap changes: approval-gated
 * administration of the IAAA_BOOTSTRAP_ADMINS list.
 *
 * Design (stated plainly, because Q3/R1 require exactly this):
 * - The bootstrap list itself STAYS in the IAAA_BOOTSTRAP_ADMINS env
 *   var. This module manages proposals, approvals, and audit for
 *   post-genesis list changes; it never writes the env var and
 *   never applies a change by itself. An approved change is applied
 *   through the existing secrets channel (GitHub repo secrets →
 *   deploy sync), and the operator confirms application here, so
 *   proposal → approval → application is fully traceable. Moving
 *   the list into an app store is a separate architectural
 *   decision, not this slice.
 * - Proposal workflow, reusing #2838's PAP semantics without
 *   duplicating its code: a platform-admin proposes → a DIFFERENT
 *   platform-admin approves (proposer ≠ approver by default) →
 *   the operator confirms application after the secrets-channel
 *   change. Any exception to proposer ≠ approver needs a NAMED
 *   reason recorded on the proposal (exceptionReason); without
 *   one, self-approval is refused. The single-admin case is that
 *   exception, not a bypass: the reason is recorded and audited.
 * - Genesis exception: the FIRST platform admin cannot be
 *   UI-approved (no reviewer exists yet) — initial genesis stays
 *   owner-via-secrets + audited (iaaa.genesis.grant, actor
 *   system:bootstrap-genesis, pinned by tests/audit_coverage_1760).
 *   This flow governs post-genesis changes only.
 * - List-removal rule (recorded default for owner correction):
 *   removing an identifier from the list does NOT drop an existing
 *   membership — it stays until explicitly revoked through the
 *   revoke path. Proposals carry the retained membership when one
 *   exists, and the current-list view surfaces the divergence
 *   (bootstrap-granted members no longer listed).
 * - Platform-only. Propose, approve, reject, and confirm-applied
 *   all require platform-admin, and the routes re-check it (this
 *   module takes the caller's platform-admin flag as input — it
 *   never decides adminhood itself, so a route cannot smuggle a
 *   tenant admin through).
 * - Fail-closed. A malformed identifier is never proposed; a
 *   failed audit append stores nothing (audit-before-persist in
 *   the routes); a stored proposal that no longer parses is
 *   refused at load.
 * - Audit + traces: every transition builds an audit event via
 *   bootstrapProposalAuditInput() — proposer, approver/applier,
 *   action, identifier, timestamp, platform scope — with the
 *   proposal's correlationId carried verbatim, so the record joins
 *   to a #2808 trace by that id. The correlation id is
 *   caller-supplied (a traceparent) when the caller has one, else
 *   a fresh UUID minted at proposal time and recorded on every
 *   later event.
 * - Post-genesis effect note: after genesis, a platform: entry
 *   grants tenant-admin only (the genesis-closed path) — it does
 *   NOT mint a second platform admin. Platform-admin grants go
 *   through Role grants (#2688), never through this list. The UI
 *   says so; this module does not special-case it beyond
 *   preserving the entry verbatim.
 *
 * Cloud-native but cloud-agnostic: this module is pure — no
 * Cloudflare imports, no I/O. The KV-backed store adapter takes an
 * injected { get, put } pair; the routes supply the session
 * store's KvLike, tests supply memory.
 */

import type { Membership } from "./authorization";
import { parseBootstrapAdmins } from "./iaaaBootstrap";

export type BootstrapProposalStatus = "proposed" | "approved" | "rejected" | "applied";
export type BootstrapChangeAction = "add" | "remove";

/** A bootstrap-list-change proposal. Platform scope only, by construction. */
export interface BootstrapProposal {
  proposalId: string;
  status: BootstrapProposalStatus;
  action: BootstrapChangeAction;
  /** The list entry as it would appear in IAAA_BOOTSTRAP_ADMINS (may carry `platform:`). */
  identifier: string;
  /** Required non-empty reason from the proposer. */
  reason: string;
  proposer: string;
  approver?: string;
  /** Named reason for a proposer = approver exception; absent otherwise. */
  exceptionReason?: string;
  /** Retained bootstrap-granted membership, for remove proposals (see list-removal rule). */
  retained?: { internalUserId: string; membershipId: string };
  /** Traceparent / correlation id, carried onto every audit event. */
  correlationId: string;
  createdAtMs: number;
  reviewedAtMs?: number;
  appliedAtMs?: number;
  appliedBy?: string;
  applicationNote?: string;
}

const GENESIS_PREFIX = "platform:";
const BOOTSTRAP_GRANTORS = ["system:bootstrap", "system:bootstrap-genesis"] as const;

/**
 * Normalize one bootstrap list entry: trim, keep a single `platform:`
 * prefix verbatim, and require the remainder to parse as exactly one
 * valid bootstrap entry with zero rejections (parseBootstrapAdmins).
 * Returns null for anything malformed — a login, a blank, a
 * platform: prefix over a malformed inner entry.
 */
export function normalizeBootstrapEntry(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (trimmed === "") return null;
  let inner = trimmed;
  let prefix = "";
  if (trimmed.startsWith(GENESIS_PREFIX)) {
    prefix = GENESIS_PREFIX;
    inner = trimmed.slice(GENESIS_PREFIX.length).trim();
    if (inner === "") return null;
  }
  const parsed = parseBootstrapAdmins(inner);
  if (parsed.entries.length !== 1 || parsed.rejected.length !== 0) return null;
  return `${prefix}${inner}`;
}

/** Parse an env-var list into normalized entries, deduped, order preserved. */
export function currentBootstrapEntries(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const normalized = normalizeBootstrapEntry(part);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proposal workflow (pure)
// ---------------------------------------------------------------------------

export type CreateBootstrapProposalResult =
  | { ok: true; proposal: BootstrapProposal }
  | {
      ok: false;
      code: "INVALID_PROPOSER" | "INVALID_REASON" | "INVALID_IDENTIFIER";
      error: string;
    };

export interface CreateBootstrapProposalInput {
  proposer: string;
  action: BootstrapChangeAction;
  identifier: string;
  reason: string;
  correlationId?: string;
  nowMs: number;
}

export function createBootstrapProposal(
  input: CreateBootstrapProposalInput,
): CreateBootstrapProposalResult {
  const proposer = input.proposer.trim();
  if (proposer === "") {
    return { ok: false, code: "INVALID_PROPOSER", error: "proposer is required." };
  }
  const reason = input.reason.trim();
  if (reason === "") {
    return { ok: false, code: "INVALID_REASON", error: "reason is required." };
  }
  const identifier = normalizeBootstrapEntry(input.identifier);
  if (identifier === null) {
    return {
      ok: false,
      code: "INVALID_IDENTIFIER",
      error: "identifier must be a valid bootstrap list entry (UUID, derived v1: id, or issuer:subject, optionally platform: prefixed).",
    };
  }
  return {
    ok: true,
    proposal: {
      proposalId: crypto.randomUUID(),
      status: "proposed",
      action: input.action,
      identifier,
      reason,
      proposer,
      correlationId:
        input.correlationId !== undefined && input.correlationId.trim() !== ""
          ? input.correlationId.trim()
          : crypto.randomUUID(),
      createdAtMs: input.nowMs,
    },
  };
}

export type ApproveBootstrapProposalResult =
  | { ok: true; proposal: BootstrapProposal }
  | {
      ok: false;
      code: "NOT_PLATFORM_ADMIN" | "SELF_APPROVAL" | "WRONG_STATUS";
      error: string;
    };

export interface ApproveBootstrapProposalInput {
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
export function approveBootstrapProposal(
  proposal: BootstrapProposal,
  input: ApproveBootstrapProposalInput,
): ApproveBootstrapProposalResult {
  if (!input.approverIsPlatformAdmin) {
    return {
      ok: false,
      code: "NOT_PLATFORM_ADMIN",
      error: "approving a bootstrap proposal requires platform-admin.",
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

export type RejectBootstrapProposalResult =
  | { ok: true; proposal: BootstrapProposal }
  | { ok: false; code: "NOT_PLATFORM_ADMIN" | "WRONG_STATUS"; error: string };

export interface RejectBootstrapProposalInput {
  reviewer: string;
  reviewerIsPlatformAdmin: boolean;
  nowMs: number;
}

/** Reject a proposed proposal (a proposer withdrawing their own proposal is allowed). */
export function rejectBootstrapProposal(
  proposal: BootstrapProposal,
  input: RejectBootstrapProposalInput,
): RejectBootstrapProposalResult {
  if (!input.reviewerIsPlatformAdmin) {
    return {
      ok: false,
      code: "NOT_PLATFORM_ADMIN",
      error: "rejecting a bootstrap proposal requires platform-admin.",
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

export type ConfirmBootstrapAppliedResult =
  | { ok: true; proposal: BootstrapProposal }
  | { ok: false; code: "NOT_PLATFORM_ADMIN" | "WRONG_STATUS"; error: string };

export interface ConfirmBootstrapAppliedInput {
  appliedBy: string;
  appliedByIsPlatformAdmin: boolean;
  applicationNote?: string;
  nowMs: number;
}

/**
 * Confirm application of an approved proposal. This records that the
 * operator applied the change through the secrets channel — it does
 * NOT change the env var itself, which this module cannot touch.
 * Only an approved proposal can be confirmed; anything else is refused.
 */
export function confirmBootstrapApplied(
  proposal: BootstrapProposal,
  input: ConfirmBootstrapAppliedInput,
): ConfirmBootstrapAppliedResult {
  if (!input.appliedByIsPlatformAdmin) {
    return {
      ok: false,
      code: "NOT_PLATFORM_ADMIN",
      error: "confirming application requires platform-admin.",
    };
  }
  if (proposal.status !== "approved") {
    return {
      ok: false,
      code: "WRONG_STATUS",
      error: `only an approved proposal can be confirmed applied (status: ${proposal.status}).`,
    };
  }
  const note = (input.applicationNote ?? "").trim();
  return {
    ok: true,
    proposal: {
      ...proposal,
      status: "applied",
      appliedBy: input.appliedBy.trim(),
      appliedAtMs: input.nowMs,
      ...(note !== "" ? { applicationNote: note } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Divergence: bootstrap-granted members no longer listed (pure)
// ---------------------------------------------------------------------------

export interface BootstrapDivergence {
  internalUserId: string;
  membershipId: string;
  roles: string[];
  grantedVia: (typeof BOOTSTRAP_GRANTORS)[number];
}

/**
 * Members whose active bootstrap-granted membership survives a list
 * removal: the membership is active (not revoked, binding
 * unexpired) with a bootstrap granter, and the member's internal id
 * is absent from the current list's resolved ids. Removal never
 * drops these — they stay until explicitly revoked.
 */
export function findBootstrapDivergence(
  currentInternalUserIds: string[],
  memberships: Membership[],
  nowMs: number,
): BootstrapDivergence[] {
  const out: BootstrapDivergence[] = [];
  for (const membership of memberships) {
    if (membership.revokedAtMs !== undefined) continue;
    const activeBootstrapBindings = membership.roleBindings.filter(
      (b) =>
        (BOOTSTRAP_GRANTORS as readonly string[]).includes(b.grantedBy) &&
        (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
    );
    if (activeBootstrapBindings.length === 0) continue;
    if (currentInternalUserIds.includes(membership.internalUserId)) continue;
    out.push({
      internalUserId: membership.internalUserId,
      membershipId: membership.membershipId,
      roles: activeBootstrapBindings.map((b) => b.role),
      grantedVia: activeBootstrapBindings.some((b) => b.grantedBy === "system:bootstrap-genesis")
        ? "system:bootstrap-genesis"
        : "system:bootstrap",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit input builder (the route appends this to the #1760 store)
// ---------------------------------------------------------------------------

export type BootstrapProposalAuditAction =
  | "bootstrap.proposed"
  | "bootstrap.approved"
  | "bootstrap.rejected"
  | "bootstrap.applied";

/**
 * The audit record for one bootstrap-proposal transition, shaped for
 * recordAuditEvent (iaaaAudit.ts): proposer/actor attribution via
 * actor/initiator, action + identifier in resourceId, proposal id in
 * approvalId, platform scope in tenantId, and the proposal's
 * correlationId verbatim for #2808 trace joining. The route supplies
 * timestamp/policyVersion/outcome around it.
 */
export function bootstrapProposalAuditInput(
  proposal: BootstrapProposal,
  action: BootstrapProposalAuditAction,
  actorPrincipalId: string,
): {
  type: "iaaa.bootstrap";
  actorPrincipalId: string;
  actorType: "human";
  initiatingPrincipalId: string;
  tenantId: "platform";
  correlationId: string;
  action: BootstrapProposalAuditAction;
  resourceId: string;
  approvalId: string;
} {
  return {
    type: "iaaa.bootstrap",
    actorPrincipalId,
    actorType: "human",
    initiatingPrincipalId: proposal.proposer,
    tenantId: "platform",
    correlationId: proposal.correlationId,
    action,
    resourceId: `${proposal.action}:${proposal.identifier}`,
    approvalId: proposal.proposalId,
  };
}

// ---------------------------------------------------------------------------
// Stores: memory (tests / preview) + injected-KV (routes)
// ---------------------------------------------------------------------------

export interface BootstrapProposalStore {
  getProposal(proposalId: string): BootstrapProposal | undefined;
  listProposals(): BootstrapProposal[];
  putProposal(proposal: BootstrapProposal): void;
}

/** In-memory store. */
export function createMemoryBootstrapProposalStore(): BootstrapProposalStore {
  const proposals = new Map<string, BootstrapProposal>();
  return {
    getProposal: (id) => proposals.get(id),
    listProposals: () =>
      [...proposals.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
    putProposal: (proposal) => {
      proposals.set(proposal.proposalId, proposal);
    },
  };
}

/** Minimal KV surface the route adapter needs (the session store's KvLike fits). */
export interface BootstrapProposalKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const BOOTSTRAP_PROPOSAL_KEY_PREFIX = "iaaa-bootstrap-proposal:";

/** Parse + validate a stored proposal; corrupt stored JSON fails closed (null). */
export function parseStoredBootstrapProposal(value: string): BootstrapProposal | null {
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
    !["proposed", "approved", "rejected", "applied"].includes(String(p.status)) ||
    (p.action !== "add" && p.action !== "remove") ||
    typeof p.identifier !== "string" ||
    normalizeBootstrapEntry(p.identifier) === null ||
    typeof p.reason !== "string" ||
    (p.reason as string).trim() === "" ||
    typeof p.proposer !== "string" ||
    typeof p.correlationId !== "string" ||
    typeof p.createdAtMs !== "number"
  ) {
    return null;
  }
  return {
    proposalId: p.proposalId as string,
    status: p.status as BootstrapProposalStatus,
    action: p.action as BootstrapChangeAction,
    identifier: p.identifier as string,
    reason: (p.reason as string).trim(),
    proposer: p.proposer as string,
    ...(typeof p.approver === "string" ? { approver: p.approver } : {}),
    ...(typeof p.exceptionReason === "string"
      ? { exceptionReason: p.exceptionReason }
      : {}),
    ...(typeof p.retained === "object" && p.retained !== null
      ? {
          retained: {
            internalUserId: (p.retained as Record<string, unknown>).internalUserId as string,
            membershipId: (p.retained as Record<string, unknown>).membershipId as string,
          },
        }
      : {}),
    correlationId: p.correlationId as string,
    createdAtMs: p.createdAtMs as number,
    ...(typeof p.reviewedAtMs === "number" ? { reviewedAtMs: p.reviewedAtMs } : {}),
    ...(typeof p.appliedAtMs === "number" ? { appliedAtMs: p.appliedAtMs } : {}),
    ...(typeof p.appliedBy === "string" ? { appliedBy: p.appliedBy } : {}),
    ...(typeof p.applicationNote === "string" ? { applicationNote: p.applicationNote } : {}),
  };
}

/** KV-backed store over an injected KV pair (routes supply sessionStore(env)). */
export function createKvBootstrapProposalStore(kv: BootstrapProposalKv): {
  getProposal(proposalId: string): Promise<BootstrapProposal | null>;
  putProposal(proposal: BootstrapProposal): Promise<void>;
} {
  return {
    async getProposal(proposalId: string) {
      const raw = await kv.get(`${BOOTSTRAP_PROPOSAL_KEY_PREFIX}${proposalId}`);
      if (raw === null) return null;
      return parseStoredBootstrapProposal(raw);
    },
    async putProposal(proposal: BootstrapProposal) {
      await kv.put(
        `${BOOTSTRAP_PROPOSAL_KEY_PREFIX}${proposal.proposalId}`,
        JSON.stringify(proposal),
      );
    },
  };
}
