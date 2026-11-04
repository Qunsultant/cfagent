import { describe, it, expect } from "vitest";
import { createApproval, validateApproval } from "../src/security/lifecycle";
import type { Approval } from "../src/security/lifecycle";

/**
 * Issue #945, Slice 6 — lifecycle verification: approvals.
 *
 * Spec §6 acceptance case: "Material proposal changes invalidate
 * prior approval". An approval is a record, not a live workflow:
 * it grants named actions in a tenant for one proposal hash, until
 * expiry or revocation. It is NOT live enforcement and does not
 * touch any route, task, or execution flow. A later slice wires
 * it into live call sites; until then it is testable policy.
 * Issue #3153 wires the version binding into live call sites:
 * the agent-access gate validates the stored approval record at
 * invocation (see tests/iaaa_delegation_wiring_3153.test.ts).
 */

const NOW = 1_800_000_000_000;

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    proposalHash: "hash-abc",
    proposalVersion: "v1",
    approverInternalUserId: "approver-1",
    tenantId: "tenant-a",
    grantedActions: ["task:create", "action:execute"],
    scope: "tenant",
    expiresAtMs: NOW + 60_000,
    revoked: false,
    ...overrides,
  };
}

describe("iaaa approval (#945 slice 6)", () => {
  it("validates an approval for the unchanged proposal within expiry", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      proposalVersion: "v1",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(true);
    expect(result.reason).toBe("VALID");
  });

  it("invalidates a prior approval when the proposal changes materially", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-CHANGED",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PROPOSAL_CHANGED");
  });

  it("invalidates a prior approval when the proposal version changes after approval (#3153)", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      proposalVersion: "v2",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PROPOSAL_CHANGED");
  });

  it("treats a versioned request against a version-less record as a change (#3153)", () => {
    const legacy = approval();
    delete (legacy as Partial<Approval>).proposalVersion;
    const result = validateApproval(legacy, {
      proposalHash: "hash-abc",
      proposalVersion: "v1",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("PROPOSAL_CHANGED");
  });

  it("invalidates an approval once it expires, at the expiry instant", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW + 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("APPROVAL_EXPIRED");
  });

  it("invalidates a revoked approval even for the unchanged proposal", () => {
    const result = validateApproval(approval({ revoked: true }), {
      proposalHash: "hash-abc",
      action: "task:create",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("APPROVAL_REVOKED");
  });

  it("denies an action the approval never granted", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      action: "artifact:export",
      tenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("ACTION_NOT_GRANTED");
  });

  it("denies an approval used in a different tenant", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      action: "task:create",
      tenantId: "tenant-b",
      nowMs: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("TENANT_MISMATCH");
  });

  it("does not require an action or tenant check when the caller asks for none", () => {
    const result = validateApproval(approval(), {
      proposalHash: "hash-abc",
      nowMs: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an approval with no granted actions at creation and writes nothing new", () => {
    const result = createApproval({
      proposalHash: "hash-abc",
      proposalVersion: "v1",
      approverInternalUserId: "approver-1",
      tenantId: "tenant-a",
      grantedActions: [],
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("EMPTY_GRANTED_ACTIONS");
  });

  it("rejects an approval whose expiry is not in the future", () => {
    const result = createApproval({
      proposalHash: "hash-abc",
      proposalVersion: "v1",
      approverInternalUserId: "approver-1",
      tenantId: "tenant-a",
      grantedActions: ["task:create"],
      expiresAtMs: NOW,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("INVALID_EXPIRY");
  });

  it("creates a usable approval with a generated id", () => {
    const result = createApproval({
      proposalHash: "hash-abc",
      proposalVersion: "v1",
      approverInternalUserId: "approver-1",
      tenantId: "tenant-a",
      grantedActions: ["task:create"],
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.approval.revoked).toBe(false);
    expect(result.approval.id.length).toBeGreaterThan(0);
    expect(
      validateApproval(result.approval, {
        proposalHash: "hash-abc",
        proposalVersion: "v1",
        action: "task:create",
        tenantId: "tenant-a",
        nowMs: NOW,
      }).valid,
    ).toBe(true);
  });

  it("rejects an approval with no proposal version at creation (#3153)", () => {
    const result = createApproval({
      proposalHash: "hash-abc",
      proposalVersion: "",
      approverInternalUserId: "approver-1",
      tenantId: "tenant-a",
      grantedActions: ["task:create"],
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("INVALID_PROPOSAL_VERSION");
  });

  it("lets a legitimate unchanged approval succeed (a system that denies everything fails)", () => {
    // Same approval, re-checked at a later time still inside expiry:
    // validity is a property of the record, not of how often it is checked.
    const record = approval();
    for (const at of [NOW, NOW + 1_000, NOW + 59_999]) {
      expect(
        validateApproval(record, {
          proposalHash: "hash-abc",
          action: "action:execute",
          tenantId: "tenant-a",
          nowMs: at,
        }).valid,
      ).toBe(true);
    }
  });
});
