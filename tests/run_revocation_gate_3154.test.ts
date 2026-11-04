/**
 * Issue #3154 (parent #945, Q6) — revocation-mid-run consumer + user
 * dispatch re-check proof + approval-consumer validation proof.
 *
 * RED first: this file imports src/security/runRevocationGate.ts,
 * which does not exist yet. It must fail on import until the slice
 * lands, then go green without edits.
 *
 * What is pinned here:
 * 1. recheckRunAuthority (pure): deny on positive revocation
 *    evidence only — revoked session, revoked/expired delegation,
 *    or memberships that exist but none live. No record (null) or
 *    an empty membership list allows: a principal that was never
 *    granted has nothing revoked, and legacy principals without a
 *    membership record keep pre-existing behavior (the #1750 scope
 *    limits: legacy populations are not covered by the 0 ms
 *    targets, and this slice does not invent coverage for them).
 *    Live mirrors serviceDispatch.ts: membership live =
 *    revokedAtMs undefined AND at least one binding live
 *    (expiresAtMs undefined or in the future).
 * 2. enforceOwnerDispatch (async seam): the same verdict through
 *    a membership store + login->internalUserId resolver. A
 *    missing store, an unresolvable login, or a throwing
 *    store/resolver ALLOWS (logged): the check is additive over
 *    pre-existing behavior, and a lookup failure must never
 *    fabricate a denial that stops a healthy owner's runs.
 * 3. Approval-consumer inventory: every consumer shape found in
 *    this slice validates through lifecycle.ts validateApproval
 *    (directly for lifecycle Approval records; via the
 *    validateWorkflowApprovalViaLifecycle bridge for workflow
 *    approval decisions, which mints no record of its own — it
 *    maps the decision onto validateApproval's verdict). A
 *    revoked approval is invalid even if unexpired
 *    (APPROVAL_REVOKED). Wiring status per consumer is stated in
 *    the module header, not faked by this test: the dispatch
 *    seams are wired in this slice; trade/payment settle-path
 *    wiring is the named follow-up (money paths, CTO+CISO review).
 */
import { describe, expect, it } from "vitest";
import {
  enforceOwnerDispatch,
  recheckRunAuthority,
  validateWorkflowApprovalViaLifecycle,
  type RunAuthorityDecision,
} from "../src/security/runRevocationGate";
import { validateApproval } from "../src/security/lifecycle";
import type { Membership } from "../src/security/authorization";
import type { Delegation } from "../src/security/delegation";

const NOW = 1_000_000;

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    membershipId: "m1",
    internalUserId: "v1:abc",
    tenantId: "primary",
    createdBy: "admin",
    createdAtMs: 1,
    roleBindings: [{ role: "member", scope: "tenant" }],
    ...overrides,
  } as Membership;
}

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: "d1",
    delegatorInternalUserId: "v1:abc",
    delegateAgentId: "agent-1",
    tenantId: "primary",
    allowedActions: [],
    resourceScope: [],
    expiresAtMs: NOW + 60_000,
    usedActions: 0,
    reDelegationAllowed: false,
    revoked: false,
    createdAtMs: 1,
    ...overrides,
  } as Delegation;
}

describe("recheckRunAuthority (pure mid-run consumer)", () => {
  it("allows a run whose membership is live", () => {
    expect(recheckRunAuthority({ memberships: [membership()], nowMs: NOW })).toEqual({ allowed: true });
  });

  it("allows when the principal has no memberships (never granted, nothing revoked)", () => {
    expect(recheckRunAuthority({ memberships: [], nowMs: NOW })).toEqual({ allowed: true });
  });

  it("allows when memberships are unresolvable (legacy, no record)", () => {
    expect(recheckRunAuthority({ memberships: null, nowMs: NOW })).toEqual({ allowed: true });
  });

  it("denies when memberships exist but all are revoked", () => {
    const decision = recheckRunAuthority({
      memberships: [membership({ revokedAtMs: NOW - 1 }), membership({ membershipId: "m2", revokedAtMs: NOW - 2 })],
      nowMs: NOW,
    });
    expect(decision).toEqual({
      denied: true,
      reason: "OWNER_MEMBERSHIP_REVOKED",
      detail: "owner has membership records but none live",
    });
  });

  it("denies when the only membership is live-recorded but all bindings expired", () => {
    const decision = recheckRunAuthority({
      memberships: [membership({ roleBindings: [{ role: "member", scope: "tenant", expiresAtMs: NOW - 1 }] })],
      nowMs: NOW,
    });
    expect(decision).toEqual({
      denied: true,
      reason: "OWNER_MEMBERSHIP_REVOKED",
      detail: "owner has membership records but none live",
    });
  });

  it("allows when one binding is live even if another expired", () => {
    const decision = recheckRunAuthority({
      memberships: [
        membership({
          roleBindings: [
            { role: "member", scope: "tenant", expiresAtMs: NOW - 1 },
            { role: "member", scope: "tenant", expiresAtMs: NOW + 60_000 },
          ],
        }),
      ],
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("denies a revoked delegation even when membership is live", () => {
    const decision = recheckRunAuthority({
      memberships: [membership()],
      delegation: delegation({ revoked: true, revokedAtMs: NOW - 1 }),
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "DELEGATION_REVOKED", detail: "delegation d1 revoked" });
  });

  it("denies an expired delegation", () => {
    const decision = recheckRunAuthority({
      memberships: [membership()],
      delegation: delegation({ expiresAtMs: NOW }),
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "DELEGATION_EXPIRED", detail: "delegation d1 expired" });
  });

  it("denies a revoked session before anything else", () => {
    const decision = recheckRunAuthority({
      memberships: [membership()],
      delegation: delegation({ revoked: true }),
      sessionRevoked: true,
      nowMs: NOW,
    });
    expect(decision).toEqual({ denied: true, reason: "SESSION_REVOKED", detail: "owner session revoked" });
  });

  it("allows a live delegation with live membership", () => {
    expect(
      recheckRunAuthority({ memberships: [membership()], delegation: delegation(), nowMs: NOW }),
    ).toEqual({ allowed: true });
  });
});

describe("enforceOwnerDispatch (async seam)", () => {
  const storeFor = (list: Membership[]) => ({
    getMembershipsByUser: async () => list,
  });

  it("allows a live owner through store + resolver", async () => {
    const decision = await enforceOwnerDispatch({
      store: storeFor([membership()]) as never,
      resolveInternalUserId: async () => "v1:abc",
      login: "owner",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("denies a revoked owner through store + resolver, preserving the denial reason", async () => {
    const decision = await enforceOwnerDispatch({
      store: storeFor([membership({ revokedAtMs: NOW - 1 })]) as never,
      resolveInternalUserId: async () => "v1:abc",
      login: "owner",
      nowMs: NOW,
    });
    expect(decision).toEqual({
      denied: true,
      reason: "OWNER_MEMBERSHIP_REVOKED",
      detail: "owner has membership records but none live",
    });
  });

  it("allows when the login has no alias (unresolvable, legacy)", async () => {
    const decision = await enforceOwnerDispatch({
      store: storeFor([membership({ revokedAtMs: NOW - 1 })]) as never,
      resolveInternalUserId: async () => null,
      login: "legacy-user",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("allows when no store is present (additive check; pre-existing behavior preserved)", async () => {
    const decision = await enforceOwnerDispatch({
      store: undefined,
      resolveInternalUserId: async () => "v1:abc",
      login: "owner",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("allows (never fabricates a denial) when the store throws", async () => {
    const decision = await enforceOwnerDispatch({
      store: { getMembershipsByUser: async () => { throw new Error("kv down"); } } as never,
      resolveInternalUserId: async () => "v1:abc",
      login: "owner",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("allows (never fabricates a denial) when the resolver throws", async () => {
    const decision = await enforceOwnerDispatch({
      store: storeFor([membership()]) as never,
      resolveInternalUserId: async () => { throw new Error("alias store down"); },
      login: "owner",
      nowMs: NOW,
    });
    expect(decision).toEqual({ allowed: true });
  });
});

describe("approval-consumer inventory: every shape validates through lifecycle.ts", () => {
  it("lifecycle Approval records: revoked is invalid even if unexpired (APPROVAL_REVOKED)", () => {
    const verdict = validateApproval(
      {
        id: "appr-1",
        proposalHash: "hash-1",
        approverInternalUserId: "v1:abc",
        tenantId: "primary",
        grantedActions: ["task:create"],
        scope: "tenant",
        expiresAtMs: NOW + 60_000,
        revoked: true,
      } as never,
      { proposalHash: "hash-1", action: "task:create", tenantId: "primary", nowMs: NOW },
    );
    expect(verdict).toEqual({ valid: false, reason: "APPROVAL_REVOKED" });
  });

  it("workflow approval decisions: revoked approver is invalid via the bridge", () => {
    const verdict = validateWorkflowApprovalViaLifecycle({
      approvalId: "wf-1",
      approverInternalUserId: "v1:abc",
      tenantId: "primary",
      action: "task:create",
      originalProposalHash: "hash-1",
      currentProposalHash: "hash-1",
      approverRevoked: true,
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ valid: false, reason: "APPROVAL_REVOKED" });
  });

  it("workflow approval decisions: changed proposal terms are invalid via the bridge", () => {
    const verdict = validateWorkflowApprovalViaLifecycle({
      approvalId: "wf-1",
      approverInternalUserId: "v1:abc",
      tenantId: "primary",
      action: "task:create",
      originalProposalHash: "hash-1",
      currentProposalHash: "hash-2",
      approverRevoked: false,
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ valid: false, reason: "PROPOSAL_CHANGED" });
  });

  it("workflow approval decisions: unverifiable approver is invalid (fail closed at settle)", () => {
    const verdict = validateWorkflowApprovalViaLifecycle({
      approvalId: "wf-1",
      approverInternalUserId: null,
      tenantId: "primary",
      action: "task:create",
      originalProposalHash: "hash-1",
      currentProposalHash: "hash-1",
      approverRevoked: false,
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ valid: false, reason: "INVALID_APPROVAL" });
  });

  it("workflow approval decisions: live approver, unchanged terms, unexpired validates", () => {
    const verdict = validateWorkflowApprovalViaLifecycle({
      approvalId: "wf-1",
      approverInternalUserId: "v1:abc",
      tenantId: "primary",
      action: "task:create",
      originalProposalHash: "hash-1",
      currentProposalHash: "hash-1",
      approverRevoked: false,
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ valid: true, reason: "VALID" });
  });

  it("pins the inventory: every consumer shape maps to a lifecycle.ts verdict", () => {
    const inventory: Array<{ consumer: string; verdict: { valid: boolean } }> = [
      {
        consumer: "lifecycle Approval record",
        verdict: validateApproval(
          {
            id: "appr-1", proposalHash: "h", approverInternalUserId: "v1:abc",
            tenantId: "primary", grantedActions: ["task:create"], scope: "tenant",
            expiresAtMs: NOW + 60_000, revoked: true,
          } as never,
          { proposalHash: "h", action: "task:create", tenantId: "primary", nowMs: NOW },
        ),
      },
      {
        consumer: "trade approval settle (settleTradingOrder / executeApprovedOrder)",
        verdict: validateWorkflowApprovalViaLifecycle({
          approvalId: "wf-trade", approverInternalUserId: "v1:abc", tenantId: "primary",
          action: "task:create", originalProposalHash: "h", currentProposalHash: "h",
          approverRevoked: true, expiresAtMs: NOW + 60_000, nowMs: NOW,
        }),
      },
      {
        consumer: "payment workflow approval delivery",
        verdict: validateWorkflowApprovalViaLifecycle({
          approvalId: "wf-pay", approverInternalUserId: "v1:abc", tenantId: "primary",
          action: "task:create", originalProposalHash: "h", currentProposalHash: "h",
          approverRevoked: true, expiresAtMs: NOW + 60_000, nowMs: NOW,
        }),
      },
    ];
    expect(inventory).toHaveLength(3);
    for (const entry of inventory) expect(entry.verdict.valid).toBe(false);
  });
});

describe("decision shape", () => {
  it("denials carry a reason the dispatch seams can audit", () => {
    const decision = recheckRunAuthority({
      memberships: [membership({ revokedAtMs: 1 })],
      nowMs: NOW,
    }) as Extract<RunAuthorityDecision, { denied: true }>;
    expect(decision.denied).toBe(true);
    expect(decision.reason).toBe("OWNER_MEMBERSHIP_REVOKED");
  });
});
