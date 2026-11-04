/**
 * #3077 (#945 Q3) — reviewed bootstrap changes: proposal/approval/
 * audit flow for post-genesis bootstrap list changes, reusing the
 * #2838 PAP semantics (proposer ≠ approver by default, self-approval
 * only with a named reason recorded, audit) without duplicating it.
 *
 * Conformance tests for the fail-closed invariants: a malformed
 * identifier is never proposed; an unapproved proposal changes
 * nothing; proposer = approver is refused by default; a removal
 * never drops a membership by itself (list-removal retains until
 * explicit revoke); a genesis grant audit event is verified present
 * by the #1760 coverage tests (cited, not re-proven here).
 *
 * The bootstrap list itself stays in the IAAA_BOOTSTRAP_ADMINS env
 * var: proposals/approvals/audit are managed here, application
 * through the existing secrets channel is confirmed, never applied
 * by this module.
 */
import { describe, expect, it } from "vitest";
import {
  approveBootstrapProposal,
  bootstrapProposalAuditInput,
  confirmBootstrapApplied,
  createBootstrapProposal,
  createMemoryBootstrapProposalStore,
  currentBootstrapEntries,
  findBootstrapDivergence,
  normalizeBootstrapEntry,
  parseStoredBootstrapProposal,
  rejectBootstrapProposal,
  type BootstrapProposal,
} from "../src/security/bootstrapProposals";
import type { Membership } from "../src/security/authorization";

const NOW = 1_790_000_000_000;
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function proposed(overrides: Partial<BootstrapProposal> = {}): BootstrapProposal {
  const created = createBootstrapProposal({
    proposer: "admin-1",
    action: "add",
    identifier: UUID_B,
    reason: "onboard second admin",
    nowMs: NOW,
  });
  if (!created.ok) throw new Error("fixture proposal failed");
  return { ...created.proposal, ...overrides };
}

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    membershipId: "m1",
    internalUserId: UUID_A,
    tenantId: "tenant-1",
    roleBindings: [
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    createdAtMs: NOW,
    ...overrides,
  };
}

describe("normalizeBootstrapEntry", () => {
  it("accepts a bare UUID and a derived v1: id", () => {
    expect(normalizeBootstrapEntry(UUID_A)).toBe(UUID_A);
    expect(normalizeBootstrapEntry(`v1:${"a".repeat(64)}`)).toBe(`v1:${"a".repeat(64)}`);
  });
  it("accepts a provider issuer:subject pair and a platform: entry", () => {
    expect(normalizeBootstrapEntry("https://github.com:123")).toBe("https://github.com:123");
    expect(normalizeBootstrapEntry(`platform:${UUID_A}`)).toBe(`platform:${UUID_A}`);
    expect(normalizeBootstrapEntry(`  platform:${UUID_A}  `)).toBe(`platform:${UUID_A}`);
  });
  it("rejects logins, blanks, and malformed entries", () => {
    expect(normalizeBootstrapEntry("alice")).toBeNull();
    expect(normalizeBootstrapEntry("")).toBeNull();
    expect(normalizeBootstrapEntry("   ")).toBeNull();
    expect(normalizeBootstrapEntry("platform:alice")).toBeNull();
    expect(normalizeBootstrapEntry("platform:")).toBeNull();
    expect(normalizeBootstrapEntry("https://github.com:")).toBeNull();
  });
});

describe("currentBootstrapEntries", () => {
  it("parses the env list, drops blanks and malformed entries, dedupes", () => {
    expect(currentBootstrapEntries(`platform:${UUID_A}, ${UUID_B}, alice, ${UUID_B},`)).toEqual([
      `platform:${UUID_A}`,
      UUID_B,
    ]);
    expect(currentBootstrapEntries(undefined)).toEqual([]);
    expect(currentBootstrapEntries("")).toEqual([]);
  });
});

describe("createBootstrapProposal", () => {
  it("creates an inert proposed proposal with reason and correlation id", () => {
    const created = createBootstrapProposal({
      proposer: "admin-1",
      action: "remove",
      identifier: UUID_A,
      reason: "offboarding",
      nowMs: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.proposal.status).toBe("proposed");
    expect(created.proposal.action).toBe("remove");
    expect(created.proposal.identifier).toBe(UUID_A);
    expect(created.proposal.reason).toBe("offboarding");
    expect(created.proposal.correlationId).not.toBe("");
  });
  it("refuses a blank proposer, a blank reason, and a malformed identifier", () => {
    expect(
      createBootstrapProposal({ proposer: " ", action: "add", identifier: UUID_A, reason: "r", nowMs: NOW }).ok,
    ).toBe(false);
    expect(
      createBootstrapProposal({ proposer: "a", action: "add", identifier: UUID_A, reason: " ", nowMs: NOW }).ok,
    ).toBe(false);
    const bad = createBootstrapProposal({ proposer: "a", action: "add", identifier: "alice", reason: "r", nowMs: NOW });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID_IDENTIFIER");
  });
});

describe("approveBootstrapProposal", () => {
  it("approves for a different platform admin", () => {
    const approved = approveBootstrapProposal(proposed(), {
      approver: "admin-2",
      approverIsPlatformAdmin: true,
      nowMs: NOW + 1,
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.proposal.status).toBe("approved");
      expect(approved.proposal.approver).toBe("admin-2");
      expect(approved.proposal.exceptionReason).toBeUndefined();
    }
  });
  it("refuses self-approval without a named reason, records it with one", () => {
    const refused = approveBootstrapProposal(proposed(), {
      approver: "admin-1",
      approverIsPlatformAdmin: true,
      nowMs: NOW + 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SELF_APPROVAL");
    const allowed = approveBootstrapProposal(proposed(), {
      approver: "admin-1",
      approverIsPlatformAdmin: true,
      exceptionReason: "sole platform admin; recorded for audit",
      nowMs: NOW + 1,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.proposal.exceptionReason).toBe("sole platform admin; recorded for audit");
  });
  it("refuses non-platform-admin approvers and wrong-status proposals", () => {
    const nonAdmin = approveBootstrapProposal(proposed(), {
      approver: "admin-2",
      approverIsPlatformAdmin: false,
      nowMs: NOW + 1,
    });
    expect(nonAdmin.ok).toBe(false);
    if (!nonAdmin.ok) expect(nonAdmin.code).toBe("NOT_PLATFORM_ADMIN");
    const approved = proposed({ status: "approved" });
    const wrong = approveBootstrapProposal(approved, {
      approver: "admin-2",
      approverIsPlatformAdmin: true,
      nowMs: NOW + 1,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("WRONG_STATUS");
  });
});

describe("rejectBootstrapProposal", () => {
  it("rejects a proposed proposal and refuses non-admins and wrong status", () => {
    const rejected = rejectBootstrapProposal(proposed(), {
      reviewer: "admin-2",
      reviewerIsPlatformAdmin: true,
      nowMs: NOW + 1,
    });
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.proposal.status).toBe("rejected");
    const nonAdmin = rejectBootstrapProposal(proposed(), {
      reviewer: "admin-2",
      reviewerIsPlatformAdmin: false,
      nowMs: NOW + 1,
    });
    expect(nonAdmin.ok).toBe(false);
    const wrong = rejectBootstrapProposal(proposed({ status: "applied" }), {
      reviewer: "admin-2",
      reviewerIsPlatformAdmin: true,
      nowMs: NOW + 1,
    });
    expect(wrong.ok).toBe(false);
  });
});

describe("confirmBootstrapApplied", () => {
  it("moves approved → applied with applier and timestamp, and refuses anything else", () => {
    const approved = proposed({ status: "approved", approver: "admin-2" });
    const applied = confirmBootstrapApplied(approved, {
      appliedBy: "admin-2",
      appliedByIsPlatformAdmin: true,
      applicationNote: "env updated via repo secrets; deploy synced",
      nowMs: NOW + 2,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.proposal.status).toBe("applied");
      expect(applied.proposal.appliedBy).toBe("admin-2");
      expect(applied.proposal.appliedAtMs).toBe(NOW + 2);
      expect(applied.proposal.applicationNote).toBe("env updated via repo secrets; deploy synced");
    }
    const wrong = confirmBootstrapApplied(proposed(), {
      appliedBy: "admin-2",
      appliedByIsPlatformAdmin: true,
      nowMs: NOW + 2,
    });
    expect(wrong.ok).toBe(false);
    const nonAdmin = confirmBootstrapApplied(approved, {
      appliedBy: "admin-2",
      appliedByIsPlatformAdmin: false,
      nowMs: NOW + 2,
    });
    expect(nonAdmin.ok).toBe(false);
  });
});

describe("findBootstrapDivergence", () => {
  it("flags a bootstrap-granted member no longer listed, and only that", () => {
    const members = [
      membership(),
      membership({
        membershipId: "m2",
        internalUserId: UUID_B,
        roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap-genesis" }],
        createdBy: "system:bootstrap-genesis",
      }),
      membership({
        membershipId: "m3",
        internalUserId: "33333333-3333-4333-8333-333333333333",
        roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-1" }],
        createdBy: "admin-1",
      }),
    ];
    const diverged = findBootstrapDivergence([UUID_B], members, NOW);
    expect(diverged.map((d) => d.internalUserId)).toEqual([UUID_A]);
    expect(diverged[0].grantedVia).toBe("system:bootstrap");
    expect(diverged[0].membershipId).toBe("m1");
  });
  it("ignores revoked and expired bootstrap bindings", () => {
    const members = [
      membership({ revokedAtMs: NOW - 1 }),
      membership({
        membershipId: "m4",
        roleBindings: [
          { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap", expiresAtMs: NOW - 1 },
        ],
      }),
    ];
    expect(findBootstrapDivergence([], members, NOW)).toEqual([]);
  });
});

describe("stores and audit input", () => {
  it("memory store round-trips and parseStoredProposal fails closed on corrupt input", () => {
    const store = createMemoryBootstrapProposalStore();
    const p = proposed();
    store.putProposal(p);
    expect(store.getProposal(p.proposalId)).toEqual(p);
    expect(store.listProposals()).toEqual([p]);
    expect(parseStoredBootstrapProposal("not json")).toBeNull();
    expect(parseStoredBootstrapProposal(JSON.stringify({ ...p, status: "bogus" }))).toBeNull();
    expect(parseStoredBootstrapProposal(JSON.stringify(p))).toEqual(p);
  });
  it("audit input attributes the transition to the actor, never to the subject alone", () => {
    const p = proposed();
    const input = bootstrapProposalAuditInput(p, "bootstrap.proposed", "admin-1");
    expect(input.type).toBe("iaaa.bootstrap");
    expect(input.action).toBe("bootstrap.proposed");
    expect(input.actorPrincipalId).toBe("admin-1");
    expect(input.actorType).toBe("human");
    expect(input.initiatingPrincipalId).toBe("admin-1");
    expect(input.tenantId).toBe("platform");
    expect(input.correlationId).toBe(p.correlationId);
    expect(input.approvalId).toBe(p.proposalId);
    expect(input.resourceId).toContain(UUID_B);
  });
});
