/**
 * Issue #3154 (parent #945, Q6) — revocation-mid-run consumer.
 *
 * The Q6 measure table (#1750 + #945 comment 6630444615) settled WHAT
 * revocation propagation must be; this module is the consumer that
 * enforces it on the run path, which did not exist: a run whose
 * owner session, membership, or delegation was revoked denies at
 * the next check, audits the denial, preserves the schedule (never
 * deletes it), and fails closed. No silent drops.
 *
 * Seams (the run stage/guard boundaries this hooks, no new parallel
 * enforcement path):
 * - Scheduled-callback dispatch (src/agents/orchestrator/
 *   scheduledCallbacks.ts resolveCallbackDispatch): every firing
 *   re-checks the owner before the callback body runs. A denied
 *   firing audits schedule.dispatch_denied and returns; the
 *   schedule is preserved (only the NO_IDENTITY path removes
 *   unowned baseline schedules, unchanged).
 * - Async-job execution (src/agents/orchestrator/asyncJobs.ts
 *   executeAsyncJob): every job execution — including every
 *   pipeline-stage execution, since a deferred stage job re-arms
 *   through executeAsyncJob — re-checks the owner after claim and
 *   before any capability leg. A denied job audits
 *   async_job.dispatch_denied, is marked failed, and never reaches
 *   a tool, route, or start notification. The schedule that queued
 *   it is preserved.
 * - Interactive runs already re-validate on every request
 *   (validateAndTouchWiredSession + the freshness gate), so the
 *   session arm below is supplied by those paths, not re-implemented
 *   here. Unattended runs carry no session, so the dispatch seams
 *   check membership (and delegation when a payload carries one).
 *
 * Deny rule (deliberate, mirrors serviceDispatch.ts): deny ONLY on
 * positive revocation evidence. A principal with no membership
 * record (null = unresolvable, e.g. legacy never-wired login) or
 * an empty membership list allows: never granted means nothing
 * revoked, and legacy populations are outside the #1750 scope
 * limits. A lookup failure (store or resolver throws) also ALLOWS
 * with a loud log — this check is additive over pre-existing
 * behavior, and a failing lookup must never fabricate a denial
 * that stops a healthy owner's runs. The service tier keeps its
 * own fail-closed rule (no store = deny); only the owner arm,
 * which previously had no check at all, preserves behavior on
 * lookup failure.
 *
 * Live mirrors serviceDispatch.ts: a membership is live when
 * revokedAtMs is undefined AND at least one role binding is live
 * (expiresAtMs undefined or in the future). A membership record
 * that is revoked, or live-recorded with every binding expired,
 * is not live.
 *
 * Approval-consumer inventory (Q6 item 3 — every consumer shape
 * validates through lifecycle.ts validateApproval):
 * - lifecycle Approval records: validateApproval directly.
 *   Production note, stated honestly: no production path mints or
 *   consumes lifecycle Approval records today; their consumers are
 *   the tests (tests/iaaa_approval.test.ts,
 *   tests/iaaa_acceptance.test.ts), which pin APPROVAL_REVOKED.
 * - Workflow approval decisions (trade approval settle via
 *   settleTradingOrder / executeApprovedOrder; payment workflow
 *   approval delivery): validateWorkflowApprovalViaLifecycle
 *   below maps the decision onto validateApproval's verdict
 *   (approver revoked -> APPROVAL_REVOKED, changed terms ->
 *   PROPOSAL_CHANGED, unverifiable approver -> INVALID_APPROVAL
 *   fail-closed). Wiring the bridge into the trade/payment settle
 *   paths is the named follow-up slice: those are money paths and
 *   their settle-core change needs CTO+CISO review. This slice
 *   proves the bridge semantics for every inventoried consumer
 *   shape and wires the run-path consumers (dispatch seams).
 * - Scheduled-callback dispatch (owner) and async-job execution
 *   (owner): enforceOwnerDispatch below, wired in this slice.
 *
 * Non-goals (issue #3154): no change to the #1750 target values
 * or the Q6 measure table; no change to the legacy-session §8
 * bound; no new revocation triggers. Delegation records are
 * checked when supplied; no run payload carries a delegation id
 * today, so the delegation arm is proven in unit tests and
 * activates when a payload carries one.
 */
import { validateApproval, type ApprovalValidation } from "./lifecycle";
import type {
  Membership,
  MembershipStore,
  Permission,
  RoleBinding,
} from "./authorization";
import type { Delegation } from "./delegation";

export type RunRevocationReason =
  | "SESSION_REVOKED"
  | "DELEGATION_REVOKED"
  | "DELEGATION_EXPIRED"
  | "OWNER_MEMBERSHIP_REVOKED";

export type RunAuthorityDecision =
  | { allowed: true }
  | { denied: true; reason: RunRevocationReason; detail?: string };

function bindingIsLive(binding: RoleBinding, nowMs: number): boolean {
  return binding.expiresAtMs === undefined || binding.expiresAtMs > nowMs;
}

function membershipIsLive(membership: Membership, nowMs: number): boolean {
  return (
    membership.revokedAtMs === undefined &&
    membership.roleBindings.some((binding) => bindingIsLive(binding, nowMs))
  );
}

/**
 * Pure mid-run re-check over supplied evidence. Check order is
 * deliberate and documented: session first, then delegation, then
 * membership — the first denial wins, and every denial names its
 * evidence so the audit record is attributable.
 */
export function recheckRunAuthority(input: {
  /** Null = unresolvable (legacy, no record): allows. */
  memberships: Membership[] | null;
  delegation?: Delegation | null;
  sessionRevoked?: boolean;
  nowMs: number;
}): RunAuthorityDecision {
  if (input.sessionRevoked === true) {
    return { denied: true, reason: "SESSION_REVOKED", detail: "owner session revoked" };
  }
  const delegation = input.delegation ?? null;
  if (delegation !== null) {
    if (delegation.revoked === true) {
      return { denied: true, reason: "DELEGATION_REVOKED", detail: `delegation ${delegation.id} revoked` };
    }
    if (input.nowMs >= delegation.expiresAtMs) {
      return { denied: true, reason: "DELEGATION_EXPIRED", detail: `delegation ${delegation.id} expired` };
    }
  }
  const memberships = input.memberships;
  if (memberships !== null && memberships.length > 0) {
    const anyLive = memberships.some((m) => membershipIsLive(m, input.nowMs));
    if (!anyLive) {
      return {
        denied: true,
        reason: "OWNER_MEMBERSHIP_REVOKED",
        detail: "owner has membership records but none live",
      };
    }
  }
  return { allowed: true };
}

/**
 * Async owner-dispatch seam: resolves the owner's internal id
 * through the injected resolver (production: the iaaa-alias login
 * lookup over the SessionStore KV), loads memberships, and applies
 * recheckRunAuthority. A missing store, an unresolvable login, or
 * a throwing store/resolver ALLOWS with a loud log — see the
 * module header for why a lookup failure never fabricates a
 * denial. The resolver is injected (never imported here) so this
 * stays pure against a MembershipStore + a function, with no
 * Cloudflare infrastructure in the module.
 */
export async function enforceOwnerDispatch(input: {
  store?: MembershipStore;
  resolveInternalUserId: (login: string) => Promise<string | null>;
  login: string;
  nowMs: number;
}): Promise<RunAuthorityDecision> {
  if (!input.store) return { allowed: true };
  let internalUserId: string | null;
  try {
    internalUserId = await input.resolveInternalUserId(input.login);
  } catch (err) {
    console.error(
      `[runRevocationGate] owner identity resolution failed for login ${input.login}; preserving pre-existing behavior (allow):`,
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true };
  }
  if (internalUserId === null) return { allowed: true };
  let memberships: Membership[];
  try {
    memberships = await input.store.getMembershipsByUser(internalUserId);
  } catch (err) {
    console.error(
      `[runRevocationGate] membership load failed for owner ${input.login}; preserving pre-existing behavior (allow):`,
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true };
  }
  return recheckRunAuthority({ memberships, nowMs: input.nowMs });
}

/**
 * Approval bridge (Q6 item 3): a workflow approval decision
 * validated THROUGH lifecycle.ts validateApproval. The decision
 * itself carries no lifecycle record, so the bridge maps it onto
 * one: the approver's revocation becomes the record's revoked
 * flag, the frozen proposal terms become the proposal hash, and
 * an unverifiable approver (no internal id) refuses to mint a
 * record at all — INVALID_APPROVAL, fail closed at settle, never
 * an anonymous approval. Expiry is exclusive, matching
 * validateApproval (an approval expiring exactly at nowMs is
 * expired).
 */
export function validateWorkflowApprovalViaLifecycle(input: {
  approvalId: string;
  /** Null = approver could not be resolved: invalid, fail closed. */
  approverInternalUserId: string | null;
  tenantId: string;
  action: Permission;
  originalProposalHash: string;
  currentProposalHash: string;
  approverRevoked: boolean;
  expiresAtMs: number;
  nowMs: number;
}): ApprovalValidation {
  if (input.approverInternalUserId === null) {
    return { valid: false, reason: "INVALID_APPROVAL" };
  }
  const record = {
    id: input.approvalId,
    proposalHash: input.originalProposalHash,
    approverInternalUserId: input.approverInternalUserId,
    tenantId: input.tenantId,
    grantedActions: [input.action],
    scope: "tenant",
    expiresAtMs: input.expiresAtMs,
    revoked: input.approverRevoked,
  } as unknown as Parameters<typeof validateApproval>[0];
  return validateApproval(record, {
    proposalHash: input.currentProposalHash,
    action: input.action,
    tenantId: input.tenantId,
    nowMs: input.nowMs,
  });
}

// Re-exported for seam callers that need the lifecycle verdict type.
export type { ApprovalValidation };
