/**
 * Issue #945, Slice 6 — lifecycle verification: approvals, revocation
 * propagation, offboarding, and interrupted-execution reconciliation
 * (pure policy, no wiring).
 *
 * This module is deliberately NOT live enforcement. It does not touch
 * any route, API, job, tool, session cookie, storage backend, or
 * existing execution flow, and it changes no production session,
 * membership, delegation, approval, or audit record. A later,
 * separately authorized slice wires these pure rules into live
 * call sites; until then they are testable policy, and nothing here
 * should be read as a claim that live revocation, offboarding, or
 * recovery is currently governed by it, or that any rollout or
 * flag-gating has happened (spec §7: rollout behind a flag with
 * rollback happens only after verification AND authorized rollout,
 * and that authorization is not given for this slice).
 *
 * What is covered (spec §6 acceptance cases):
 * - Approvals: a record granting named actions in a tenant for one
 *   proposal hash + version, until expiry or revocation. A
 *   material proposal change (proposalHash OR proposalVersion
 *   mismatch) invalidates a prior approval, as do expiry and
 *   revocation. An approval never grants an action it does not
 *   name, or authority in another tenant. Issue #3153 (Q8, owner
 *   directive 2026-11-04): the version binding is stored on the
 *   record here and enforced at live call sites by the
 *   agent-access gate (src/security/agentAccess.ts step 3b), not
 *   by this module — this module still touches no route, job, or
 *   execution flow itself.
 * - Revocation propagation: revokePrincipal() revokes a principal's
 *   sessions (Slice 2 store), memberships (Slice 3 store), and
 *   delegations (Slice 4 store) and reports exactly what was
 *   revoked. isPrincipalFullyRevoked() re-checks afterwards:
 *   a revoked principal's sessions, memberships, and delegations
 *   must all be unusable, and the check is performed, not assumed.
 * - Offboarding: offboardPrincipal() runs the same revocation as a
 *   checklist and returns anything it could not revoke as
 *   `unrevoked`, reported, never silently dropped. A step with
 *   nothing to revoke is "not-applicable", not a silent success.
 * - Interrupted-execution reconciliation: reconcileInterruptedExecution()
 *   replays nothing already completed. An execution whose outcome
 *   is unknown is reported as "unknown-requires-manual-review"
 *   with nothing to execute, never retried on assumption.
 *
 * What is NOT covered, explicitly:
 * - Queued work and active tasks: revocation of sessions,
 *   memberships, and delegations is the contract checked here.
 *   Cancelling queued work or active tasks at live call sites is
 *   later wiring; this module does not claim to cancel anything.
 * - Approval workflows beyond the record: who may approve, and
 *   how a proposal hash is computed, are caller decisions. The
 *   hash is compared exactly (trimmed); no hashing is done here.
 * - Cost budgets, retention, and tamper response: out of scope
 *   for this slice (see Slices 4–5 headers).
 * - Identity: identity here is the Slice 1 stable internal user
 *   id. Email and display login are NOT inputs to any function in
 *   this module, so an email change cannot create, transfer, or
 *   revoke authority through it.
 *
 * Time is always a caller-supplied `nowMs` seam, never Date.now()
 * inside a decision, so every rule is testable at its exact
 * boundary. Identifiers are trimmed and compared exactly, as in
 * Slices 1–5: no case folding, no URL canonicalization.
 */

import { PERMISSIONS } from "./authorization";
import type { MembershipStore, Permission } from "./authorization";
import { revokeDelegation } from "./delegation";
import type { DelegationStore } from "./delegation";
import type { RevocationStore } from "./sessionPolicy";

export const LIFECYCLE_POLICY_VERSION = "iaaa-lifecycle-1";

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

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * An approval record: one approver, one tenant, named granted
 * actions, one proposal hash + version. `scope` is a label for
 * the grant (default "tenant"); it does not widen the grant
 * beyond the tenant and actions named here. The version binds
 * the approval to one proposal revision: a settlement carrying
 * a different version fails validation (PROPOSAL_CHANGED), so a
 * material proposal change after approval cannot settle on the
 * old approval (Q8 #3153).
 */
export interface Approval {
  id: string;
  proposalHash: string;
  /** Proposal revision this approval was granted for (required). */
  proposalVersion: string;
  approverInternalUserId: string;
  tenantId: string;
  grantedActions: Permission[];
  scope: string;
  expiresAtMs: number;
  revoked: boolean;
}

export type ApprovalErrorCode =
  | "INVALID_PROPOSAL_HASH"
  | "INVALID_PROPOSAL_VERSION"
  | "INVALID_APPROVER"
  | "INVALID_TENANT"
  | "EMPTY_GRANTED_ACTIONS"
  | "INVALID_PERMISSION"
  | "INVALID_EXPIRY";

export type ApprovalResult =
  | { ok: true; approval: Approval }
  | { ok: false; code: ApprovalErrorCode; error: string };

export interface CreateApprovalInput {
  proposalHash: string;
  proposalVersion: string;
  approverInternalUserId: string;
  tenantId: string;
  grantedActions: Permission[];
  scope?: string;
  expiresAtMs: number;
  nowMs: number;
}

/**
 * Create an approval record. Validation failures create nothing:
 * there is no record to validate later, so a bad approval cannot
 * slip through by being stored first and checked second.
 */
export function createApproval(input: CreateApprovalInput): ApprovalResult {
  if (!isValidField(input.proposalHash)) {
    return { ok: false, code: "INVALID_PROPOSAL_HASH", error: "proposalHash must be a non-empty string" };
  }
  if (!isValidField(input.proposalVersion)) {
    return { ok: false, code: "INVALID_PROPOSAL_VERSION", error: "proposalVersion must be a non-empty string" };
  }
  if (!isValidField(input.approverInternalUserId)) {
    return { ok: false, code: "INVALID_APPROVER", error: "approverInternalUserId must be a non-empty string" };
  }
  if (!isValidField(input.tenantId)) {
    return { ok: false, code: "INVALID_TENANT", error: "tenantId must be a non-empty string" };
  }
  if (!Array.isArray(input.grantedActions) || input.grantedActions.length === 0) {
    return { ok: false, code: "EMPTY_GRANTED_ACTIONS", error: "at least one granted action is required" };
  }
  for (const action of input.grantedActions) {
    if (!(PERMISSIONS as readonly string[]).includes(String(action))) {
      return { ok: false, code: "INVALID_PERMISSION", error: `unknown permission: ${String(action)}` };
    }
  }
  if (typeof input.expiresAtMs !== "number" || input.expiresAtMs <= input.nowMs) {
    return { ok: false, code: "INVALID_EXPIRY", error: "expiresAtMs must be after nowMs" };
  }
  return {
    ok: true,
    approval: {
      id: crypto.randomUUID(),
      proposalHash: normalize(input.proposalHash),
      proposalVersion: normalize(input.proposalVersion),
      approverInternalUserId: normalize(input.approverInternalUserId),
      tenantId: normalize(input.tenantId),
      grantedActions: [...input.grantedActions],
      scope: input.scope !== undefined ? normalize(input.scope) : "tenant",
      expiresAtMs: input.expiresAtMs,
      revoked: false,
    },
  };
}

export type ApprovalValidityReason =
  | "VALID"
  | "INVALID_APPROVAL"
  | "APPROVAL_REVOKED"
  | "APPROVAL_EXPIRED"
  | "PROPOSAL_CHANGED"
  | "TENANT_MISMATCH"
  | "ACTION_NOT_GRANTED";

export interface ValidateApprovalRequest {
  proposalHash: string;
  /** When given, the approval must carry this proposal version. */
  proposalVersion?: string;
  /** When given, the approval must name this action. */
  action?: Permission;
  /** When given, the approval must be for this tenant. */
  tenantId?: string;
  nowMs: number;
}

export interface ApprovalValidation {
  valid: boolean;
  reason: ApprovalValidityReason;
}

/**
 * Validate an approval at `nowMs`. Order matters and is deliberate:
 * a revoked approval is invalid even if unexpired and unchanged;
 * an expired approval is invalid even if unchanged; only then are
 * the proposal hash and version compared, so a material proposal
 * change is never masked by an earlier failure, and an unchanged
 * proposal never rescues a revoked or expired approval. Expiry is
 * exclusive: an approval expiring exactly at nowMs is expired.
 * A versioned request against a version-less (pre-#3153) record
 * is a change: a record that cannot prove which revision it
 * approved cannot settle a versioned settlement.
 */
export function validateApproval(
  approval: Approval,
  request: ValidateApprovalRequest,
): ApprovalValidation {
  if (!approval || !isValidField(approval.id) || !isValidField(approval.proposalHash)) {
    return { valid: false, reason: "INVALID_APPROVAL" };
  }
  if (approval.revoked) return { valid: false, reason: "APPROVAL_REVOKED" };
  if (typeof approval.expiresAtMs !== "number" || request.nowMs >= approval.expiresAtMs) {
    return { valid: false, reason: "APPROVAL_EXPIRED" };
  }
  if (!isValidField(request.proposalHash) || normalize(request.proposalHash) !== approval.proposalHash) {
    return { valid: false, reason: "PROPOSAL_CHANGED" };
  }
  if (
    request.proposalVersion !== undefined &&
    normalize(request.proposalVersion) !== approval.proposalVersion
  ) {
    return { valid: false, reason: "PROPOSAL_CHANGED" };
  }
  if (request.tenantId !== undefined && normalize(request.tenantId) !== approval.tenantId) {
    return { valid: false, reason: "TENANT_MISMATCH" };
  }
  if (request.action !== undefined && !approval.grantedActions.includes(request.action)) {
    return { valid: false, reason: "ACTION_NOT_GRANTED" };
  }
  return { valid: true, reason: "VALID" };
}

/** Store an approval record by id, for settlement-time resolution (Q8 #3153). */
export interface ApprovalStore {
  get(id: string): Promise<Approval | null>;
  put(approval: Approval): Promise<void>;
}

export function createMemoryApprovalStore(): ApprovalStore {
  const byId = new Map<string, Approval>();
  return {
    async get(id: string): Promise<Approval | null> {
      return byId.get(id) ?? null;
    },
    async put(approval: Approval): Promise<void> {
      byId.set(approval.id, approval);
    },
  };
}

// ---------------------------------------------------------------------------
// Revocation propagation
// ---------------------------------------------------------------------------

/** The three stores a principal's authority lives in, by slice. */
export interface LifecycleStores {
  /** Slice 2 session revocation store. */
  sessions: RevocationStore;
  /** Slice 3 membership store. */
  memberships: MembershipStore;
  /** Slice 4 delegation store. */
  delegations: DelegationStore;
}

export interface RevocationFailure {
  kind: "session" | "membership" | "delegation";
  id: string;
  reason: string;
}

export interface RevocationReport {
  principalId: string;
  revokedAtMs: number;
  sessionsRevoked: string[];
  membershipsRevoked: string[];
  delegationsRevoked: string[];
  /** Counts of items examined per category, including already-revoked ones. */
  sessionsChecked: number;
  membershipsChecked: number;
  delegationsChecked: number;
  failures: RevocationFailure[];
  /** True only when nothing failed. An empty revocation is not a failure. */
  allRevoked: boolean;
}

export interface RevokePrincipalInput {
  internalUserId: string;
  /**
   * Session ids belonging to the principal. The Slice 2 store maps
   * sessions to users internally but exposes no listing, so the
   * caller supplies the ids it issued (its session registry);
   * supplying an id for another principal revokes only that id,
   * never a whole user, and is the caller's responsibility.
   */
  sessionIds: string[];
  nowMs: number;
}

/**
 * Revoke a principal's sessions, memberships, and delegations and
 * report exactly what was revoked. Already-revoked items are not
 * double-counted (revocation is idempotent), and any item that
 * could not be revoked appears in `failures` — it is never
 * silently dropped, and a failure in one category does not stop
 * the other categories from being revoked.
 */
export async function revokePrincipal(
  stores: LifecycleStores,
  input: RevokePrincipalInput,
): Promise<RevocationReport> {
  const principalId = normalize(input.internalUserId);
  const sessionsRevoked: string[] = [];
  const membershipsRevoked: string[] = [];
  const delegationsRevoked: string[] = [];
  const failures: RevocationFailure[] = [];

  for (const rawId of input.sessionIds) {
    const sessionId = normalize(rawId);
    if (await stores.sessions.isSessionRevoked(sessionId)) continue;
    await stores.sessions.revokeSession(sessionId);
    if (await stores.sessions.isSessionRevoked(sessionId)) {
      sessionsRevoked.push(sessionId);
    } else {
      failures.push({ kind: "session", id: sessionId, reason: "SESSION_REVOCATION_FAILED" });
    }
  }

  const memberships = await stores.memberships.getMembershipsByUser(principalId);
  for (const membership of memberships) {
    if (membership.revokedAtMs !== undefined) continue;
    const revoked = await stores.memberships.revokeMembership(membership.membershipId, input.nowMs);
    if (revoked) {
      membershipsRevoked.push(membership.membershipId);
    } else {
      failures.push({ kind: "membership", id: membership.membershipId, reason: "MEMBERSHIP_REVOCATION_FAILED" });
    }
  }

  const delegations = await stores.delegations.listByDelegator(principalId);
  for (const delegation of delegations) {
    if (delegation.revoked) continue;
    const revoked = await revokeDelegation(stores.delegations, delegation.id, input.nowMs);
    if (revoked) {
      delegationsRevoked.push(delegation.id);
    } else {
      failures.push({ kind: "delegation", id: delegation.id, reason: "DELEGATION_REVOCATION_FAILED" });
    }
  }

  return {
    principalId,
    revokedAtMs: input.nowMs,
    sessionsRevoked,
    membershipsRevoked,
    delegationsRevoked,
    sessionsChecked: input.sessionIds.length,
    membershipsChecked: memberships.length,
    delegationsChecked: delegations.length,
    failures,
    allRevoked: failures.length === 0,
  };
}

export interface PrincipalRevocationCheck {
  fullyRevoked: boolean;
  sessionsRevoked: boolean;
  membershipsRevoked: boolean;
  delegationsRevoked: boolean;
}

/**
 * Re-check, from the stores, that a principal's sessions,
 * memberships, and delegations are all unusable. This is a check,
 * not an assumption: it reads current store state, so a session
 * issued after revocation, or a membership created after it, is
 * correctly reported as not revoked. An empty category (no
 * sessions, memberships, or delegations at all) counts as revoked
 * for that category — there is nothing left usable.
 */
export async function isPrincipalFullyRevoked(
  stores: LifecycleStores,
  input: { internalUserId: string; sessionIds: string[] },
): Promise<PrincipalRevocationCheck> {
  const principalId = normalize(input.internalUserId);
  let sessionsRevoked = true;
  for (const rawId of input.sessionIds) {
    if (!(await stores.sessions.isSessionRevoked(normalize(rawId)))) {
      sessionsRevoked = false;
      break;
    }
  }
  const memberships = await stores.memberships.getMembershipsByUser(principalId);
  const membershipsRevoked = memberships.every((m) => m.revokedAtMs !== undefined);
  const delegations = await stores.delegations.listByDelegator(principalId);
  const delegationsRevoked = delegations.every((d) => d.revoked);
  return {
    fullyRevoked: sessionsRevoked && membershipsRevoked && delegationsRevoked,
    sessionsRevoked,
    membershipsRevoked,
    delegationsRevoked,
  };
}

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------

export interface OffboardingStep {
  step: "revoke-sessions" | "revoke-memberships" | "revoke-delegations";
  status: "done" | "failed" | "not-applicable";
  detail: string;
}

export interface OffboardingReport {
  principalId: string;
  offboarded: boolean;
  report: RevocationReport;
  steps: OffboardingStep[];
  /** Everything the revocation could not revoke, by kind and id. */
  unrevoked: RevocationFailure[];
}

/**
 * Offboard a principal: revoke sessions, memberships, and
 * delegations, and return a checklist. `offboarded` is true only
 * when nothing failed; a step with nothing to revoke is
 * "not-applicable", and a step with any failure is "failed" with
 * the failed items listed in `unrevoked`. Nothing is dropped:
 * callers must handle `unrevoked` (retry, escalate, or record it),
 * not ignore it.
 */
export async function offboardPrincipal(
  stores: LifecycleStores,
  input: RevokePrincipalInput,
): Promise<OffboardingReport> {
  const report = await revokePrincipal(stores, input);
  const stepFor = (
    step: OffboardingStep["step"],
    checked: number,
    kind: RevocationFailure["kind"],
  ): OffboardingStep => {
    const failed = report.failures.filter((f) => f.kind === kind);
    if (failed.length > 0) {
      return { step, status: "failed", detail: `${failed.length} ${kind}(s) could not be revoked` };
    }
    if (checked === 0) {
      return { step, status: "not-applicable", detail: `no ${kind}s to revoke` };
    }
    return { step, status: "done", detail: `${checked} ${kind}(s) revoked or already revoked` };
  };
  return {
    principalId: report.principalId,
    offboarded: report.allRevoked,
    report,
    steps: [
      stepFor("revoke-sessions", report.sessionsChecked, "session"),
      stepFor("revoke-memberships", report.membershipsChecked, "membership"),
      stepFor("revoke-delegations", report.delegationsChecked, "delegation"),
    ],
    unrevoked: report.failures,
  };
}

// ---------------------------------------------------------------------------
// Interrupted-execution reconciliation
// ---------------------------------------------------------------------------

export type ExecutionOutcome = "completed" | "interrupted" | "unknown";

export interface InterruptedExecutionInput {
  taskId: string;
  /** Side effects the task planned, in planned order. */
  plannedSideEffects: string[];
  /** Side-effect ids the ledger records as already completed. */
  completedSideEffectIds: string[];
  /** Recorded outcome of the interrupted execution. */
  outcome: ExecutionOutcome;
}

export type ReconciliationOutcome =
  | "resume"
  | "complete"
  | "unknown-requires-manual-review";

export interface Reconciliation {
  taskId: string;
  /** Planned side effects a retry may still perform. Never includes a completed one. */
  toExecute: string[];
  /** Planned side effects already completed, in planned order. */
  alreadyCompleted: string[];
  /** Completed ids that were never planned: reported, not dropped. */
  unexpectedCompleted: string[];
  outcome: ReconciliationOutcome;
  reason: string;
}

/**
 * Reconcile an interrupted execution against its side-effect
 * ledger. A retry executes only planned side effects that are not
 * already completed, in planned order, deduplicated. An execution
 * whose outcome is unknown executes nothing: with an unknown
 * outcome the ledger cannot be trusted to be complete, so blindly
 * repeating a side effect — or assuming one completed — could
 * double-apply it. That case is explicitly for manual review.
 */
export function reconcileInterruptedExecution(
  input: InterruptedExecutionInput,
): Reconciliation {
  const planned: string[] = [];
  for (const raw of input.plannedSideEffects) {
    const id = normalize(String(raw));
    if (id.length > 0 && !planned.includes(id)) planned.push(id);
  }
  const completed = new Set(
    input.completedSideEffectIds.map((raw) => normalize(String(raw))).filter((id) => id.length > 0),
  );
  const alreadyCompleted = planned.filter((id) => completed.has(id));
  const unexpectedCompleted = [...completed].filter((id) => !planned.includes(id));

  if (input.outcome === "unknown") {
    return {
      taskId: input.taskId,
      toExecute: [],
      alreadyCompleted,
      unexpectedCompleted,
      outcome: "unknown-requires-manual-review",
      reason: "interrupted execution has unknown outcome; manual review required before any retry",
    };
  }
  if (input.outcome === "completed") {
    return {
      taskId: input.taskId,
      toExecute: [],
      alreadyCompleted,
      unexpectedCompleted,
      outcome: "complete",
      reason: "execution already recorded as completed; nothing left to execute",
    };
  }
  const toExecute = planned.filter((id) => !completed.has(id));
  return {
    taskId: input.taskId,
    toExecute,
    alreadyCompleted,
    unexpectedCompleted,
    outcome: toExecute.length === 0 ? "complete" : "resume",
    reason:
      toExecute.length === 0
        ? "all planned side effects already completed; nothing left to execute"
        : "retry may execute only the planned side effects not already completed",
  };
}
