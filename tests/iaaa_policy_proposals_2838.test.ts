/**
 * #2838 (sub-issue of #2837) — PAP editor: approval-gated policy
 * administration. Conformance tests for the fail-closed invariants:
 * an invalid proposal never takes effect, an unapproved proposal is
 * inert, proposer = approver is refused by default, and a failed
 * promotion leaves the previous policy active.
 *
 * The PAP edits ROLE_GRANTS policy only, via #1755 PolicySnapshots
 * validated by parsePolicySnapshot(). The frozen OBLIGATION_POLICY
 * (#1751) is OUT of scope for editing in this slice (carried
 * question) — the last test pins that this slice does not touch it.
 */
import { describe, expect, it } from "vitest";
import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  type PolicySnapshot,
} from "../src/security/authorization";
import { OBLIGATION_POLICY } from "../src/security/obligations";
import {
  approveProposal,
  createMemoryPolicyProposalStore,
  createProposal,
  diffPolicySnapshots,
  previewDecisions,
  promoteProposal,
  rejectProposal,
  snapshotRef,
  type PolicyProposal,
} from "../src/security/policyProposals";
import { parsePolicySnapshot } from "../src/security/pdpPorts";

const NOW = 1_790_000_000_000;

function memberProvider(role: string) {
  return {
    getMembershipsByUser: async () => [
      {
        membershipId: "m1",
        internalUserId: "user-1",
        tenantId: "tenant-1",
        roleBindings: [
          { role: role as never, scope: "tenant" as const, grantedBy: "admin" },
        ],
        createdBy: "admin",
        createdAtMs: NOW,
      },
    ],
  };
}

function withGrantRemoved(
  snapshot: PolicySnapshot,
  role: string,
  permission: string,
): PolicySnapshot {
  const grants = { ...snapshot.roleGrants } as Record<string, readonly string[]>;
  grants[role] = (grants[role] as readonly string[]).filter((p) => p !== permission);
  return { ...snapshot, roleGrants: grants as PolicySnapshot["roleGrants"] };
}

describe("PAP proposal creation (#2838)", () => {
  it("rejects an invalid snapshot fail-closed: no proposal, no policy change", () => {
    const before = getCompiledPolicySnapshot();
    const bad = {
      version: "iaaa-authorization-2",
      permissions: ["task:read", "not-a-permission"],
      roleGrants: before.roleGrants,
    };
    const result = createProposal({
      proposer: "admin-1",
      snapshotInput: bad,
      beforeSnapshot: before,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SNAPSHOT");
    // The #1755 validator is the single validation path.
    expect(parsePolicySnapshot(bad).ok).toBe(false);
  });

  it("rejects a snapshot missing a role (omission must never become permissive)", () => {
    const before = getCompiledPolicySnapshot();
    const grants = { ...before.roleGrants } as Record<string, unknown>;
    delete grants["auditor"];
    const result = createProposal({
      proposer: "admin-1",
      snapshotInput: { version: "x", permissions: before.permissions, roleGrants: grants },
      beforeSnapshot: before,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("creates a proposed (inert) proposal with before/after refs and platform scope", () => {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const result = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(JSON.stringify(proposed)),
      beforeSnapshot: before,
      correlationId: "00-abc123-01",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.status).toBe("proposed");
    expect(result.proposal.proposer).toBe("admin-1");
    expect(result.proposal.tenantScope).toBe("platform");
    expect(result.proposal.correlationId).toBe("00-abc123-01");
    expect(result.proposal.beforeRef).toBe(snapshotRef(before));
    expect(result.proposal.afterRef).toBe(snapshotRef(proposed));
    expect(result.proposal.beforeRef).not.toBe(result.proposal.afterRef);
  });
});

describe("PAP approval gate (#2838)", () => {
  function approvedProposal(): PolicyProposal {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const created = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(JSON.stringify(proposed)),
      beforeSnapshot: before,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("setup failed");
    return created.proposal;
  }

  it("refuses self-approval by default", () => {
    const proposal = approvedProposal();
    const result = approveProposal(proposal, {
      approver: "admin-1",
      approverIsPlatformAdmin: true,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF_APPROVAL");
  });

  it("allows self-approval only with a NAMED reason, recorded on the proposal", () => {
    const proposal = approvedProposal();
    const result = approveProposal(proposal, {
      approver: "admin-1",
      approverIsPlatformAdmin: true,
      exceptionReason: "sole platform admin during bootstrap; recorded per #2838",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.status).toBe("approved");
    expect(result.proposal.approver).toBe("admin-1");
    expect(result.proposal.exceptionReason).toContain("sole platform admin");
  });

  it("refuses approval by a non-platform-admin", () => {
    const proposal = approvedProposal();
    const result = approveProposal(proposal, {
      approver: "tenant-admin-9",
      approverIsPlatformAdmin: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_PLATFORM_ADMIN");
  });

  it("approves with a distinct platform-admin approver", () => {
    const proposal = approvedProposal();
    const result = approveProposal(proposal, {
      approver: "admin-2",
      approverIsPlatformAdmin: true,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.status).toBe("approved");
      expect(result.proposal.approver).toBe("admin-2");
      expect(result.proposal.exceptionReason).toBeUndefined();
    }
  });

  it("rejects, and a rejected proposal can neither approve nor promote", () => {
    const proposal = approvedProposal();
    const rejected = rejectProposal(proposal, {
      reviewer: "admin-2",
      reviewerIsPlatformAdmin: true,
      nowMs: NOW,
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.proposal.status).toBe("rejected");
    expect(
      approveProposal(rejected.proposal, {
        approver: "admin-2",
        approverIsPlatformAdmin: true,
        nowMs: NOW,
      }).ok,
    ).toBe(false);
    expect(
      promoteProposal(rejected.proposal, {
        activeSnapshot: getCompiledPolicySnapshot(),
        nowMs: NOW,
      }).ok,
    ).toBe(false);
  });
});

describe("PAP promotion is the only activation (#2838)", () => {
  it("an unapproved proposal is provably inert: decisions still follow the old policy", async () => {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const created = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(JSON.stringify(proposed)),
      beforeSnapshot: before,
      nowMs: NOW,
    });
    expect(created.ok).toBe(true);
    // Promotion of a merely-proposed proposal is refused.
    if (created.ok) {
      expect(
        promoteProposal(created.proposal, { activeSnapshot: before, nowMs: NOW }).ok,
      ).toBe(false);
    }
    // And the live PDP still allows under the previous policy.
    const decision = await authorizeWithPolicy(before, memberProvider("member"), {
      actorInternalUserId: "user-1",
      tenantId: "tenant-1",
      permission: "task:cancel",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("an approved proposal promotes: the new policy decides, the old one does not", async () => {
    const store = createMemoryPolicyProposalStore();
    const before = store.getActiveSnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const created = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(JSON.stringify(proposed)),
      beforeSnapshot: before,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("setup failed");
    const approved = approveProposal(created.proposal, {
      approver: "admin-2",
      approverIsPlatformAdmin: true,
      nowMs: NOW,
    });
    if (!approved.ok) throw new Error("setup failed");
    const promoted = promoteProposal(approved.proposal, {
      activeSnapshot: store.getActiveSnapshot(),
      nowMs: NOW,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.proposal.status).toBe("promoted");
    expect(promoted.activeSnapshot.roleGrants.member).not.toContain("task:cancel");
    store.putActiveSnapshot(promoted.activeSnapshot);
    store.putProposal(promoted.proposal);
    const decision = await authorizeWithPolicy(
      store.getActiveSnapshot(),
      memberProvider("member"),
      {
        actorInternalUserId: "user-1",
        tenantId: "tenant-1",
        permission: "task:cancel",
        nowMs: NOW,
      },
    );
    expect(decision.decision).toBe("deny");
  });

  it("a failed promotion leaves the previous policy active and untouched", () => {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const created = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(JSON.stringify(proposed)),
      beforeSnapshot: before,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("setup failed");
    const approved = approveProposal(created.proposal, {
      approver: "admin-2",
      approverIsPlatformAdmin: true,
      nowMs: NOW,
    });
    if (!approved.ok) throw new Error("setup failed");
    // Tamper the approved proposal's snapshot (simulates a stored
    // proposal that no longer validates at promotion time).
    const tampered: PolicyProposal = {
      ...approved.proposal,
      proposedSnapshot: {
        ...approved.proposal.proposedSnapshot,
        roleGrants: {
          ...approved.proposal.proposedSnapshot.roleGrants,
          member: ["task:read", "bogus-permission" as never],
        },
      },
    };
    const result = promoteProposal(tampered, { activeSnapshot: before, nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_SNAPSHOT");
      expect(result.activeSnapshot).toBe(before);
    }
  });

  it("the memory store round-trips proposals and the active snapshot", () => {
    const store = createMemoryPolicyProposalStore();
    const before = store.getActiveSnapshot();
    expect(store.listProposals()).toHaveLength(0);
    const created = createProposal({
      proposer: "admin-1",
      snapshotInput: JSON.parse(
        JSON.stringify(withGrantRemoved(before, "auditor", "audit:read")),
      ),
      beforeSnapshot: before,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("setup failed");
    store.putProposal(created.proposal);
    expect(store.getProposal(created.proposal.proposalId)?.status).toBe("proposed");
    expect(store.listProposals()).toHaveLength(1);
    expect(store.getActiveSnapshot()).toBe(before);
  });
});

describe("PAP preview (#2838)", () => {
  it("diffs grants: removed (and added) permissions per role, nothing silent", () => {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const diff = diffPolicySnapshots(before, proposed);
    expect(diff).toEqual([
      { role: "member", permission: "task:cancel", change: "removed" },
    ]);
    expect(diffPolicySnapshots(before, before)).toEqual([]);
  });

  it("previews decision changes before approval, without activating anything", async () => {
    const before = getCompiledPolicySnapshot();
    const proposed = withGrantRemoved(before, "member", "task:cancel");
    const changes = await previewDecisions(before, proposed, [
      { role: "member", permission: "task:cancel" },
      { role: "member", permission: "task:read" },
    ]);
    const changed = changes.filter((c) => c.changed);
    expect(changed).toEqual([
      {
        role: "member",
        permission: "task:cancel",
        before: "allow",
        after: "deny",
        changed: true,
      },
    ]);
    expect(changes.find((c) => c.permission === "task:read")?.changed).toBe(false);
  });
});

describe("PAP scope guard (#2838)", () => {
  it("does not edit the frozen OBLIGATION_POLICY (#1751 carried question)", () => {
    expect(OBLIGATION_POLICY.map((e) => e.permission)).toEqual([
      "role:assign",
      "membership:revoke",
      "audit:export",
    ]);
    expect(Object.isFrozen(OBLIGATION_POLICY)).toBe(true);
    expect(OBLIGATION_POLICY[0].obligations).toEqual(["step-up", "audit-before-allow"]);
  });
});
