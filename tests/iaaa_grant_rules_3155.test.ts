/**
 * Issue #3155 (parent #945, Q9) — grant-rule mechanics, LIVE.
 * Pure-helper, proposal-store, and access-request-approver tests.
 * Route-level tests (proposal flow in the grant routes, the
 * two-step access decision, the review query, the revoke pass)
 * live in tests/iaaa_grant_rules_routes_3155.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  applyDefaultGrantExpiry,
  bindingsEqual,
  DEFAULT_GRANT_EXPIRY_DAYS,
  grantBindingViolatesMatrix,
  isAdminRoleGrant,
  listGrantsForReview,
  resolveGrantDefaultExpiryDays,
} from "../src/security/grantRules";
import {
  createGrantProposalStore,
  resolveAdminGrantProposal,
} from "../src/security/grantProposals";
import { createAccessRequestStore } from "../src/security/iaaaAccessRequests";
import type { KvLike } from "../src/security/kvResilience";
import type { Membership, RoleBinding } from "../src/security/authorization";

function memoryKv(): KvLike {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as KvLike;
}

function binding(
  role: string,
  scope: string,
  extra: Partial<RoleBinding> = {},
): RoleBinding {
  return {
    role: role as RoleBinding["role"],
    scope: scope as RoleBinding["scope"],
    grantedBy: "granter",
    ...extra,
  };
}

function membership(
  id: string,
  userId: string,
  tenantId: string,
  roleBindings: RoleBinding[],
  extra: Partial<Membership> = {},
): Membership {
  return {
    membershipId: id,
    internalUserId: userId,
    tenantId,
    roleBindings,
    createdBy: "granter",
    createdAtMs: 1_000,
    ...extra,
  };
}

describe("resolveGrantDefaultExpiryDays", () => {
  it("adopts 90 days when unset, empty, non-numeric, zero, or negative", () => {
    expect(DEFAULT_GRANT_EXPIRY_DAYS).toBe(90);
    expect(resolveGrantDefaultExpiryDays(undefined)).toBe(90);
    expect(resolveGrantDefaultExpiryDays(null)).toBe(90);
    expect(resolveGrantDefaultExpiryDays("")).toBe(90);
    expect(resolveGrantDefaultExpiryDays("abc")).toBe(90);
    expect(resolveGrantDefaultExpiryDays("0")).toBe(90);
    expect(resolveGrantDefaultExpiryDays(0)).toBe(90);
    expect(resolveGrantDefaultExpiryDays("-5")).toBe(90);
    expect(resolveGrantDefaultExpiryDays(Number.NaN)).toBe(90);
  });

  it("honors a positive integer override, flooring fractions", () => {
    expect(resolveGrantDefaultExpiryDays("120")).toBe(120);
    expect(resolveGrantDefaultExpiryDays(45)).toBe(45);
    expect(resolveGrantDefaultExpiryDays("90.7")).toBe(90);
  });
});

describe("applyDefaultGrantExpiry", () => {
  const NOW = 10_000_000;

  it("stamps tenant bindings without an expiry, leaves the rest alone", () => {
    const input = [
      binding("member", "tenant"),
      binding("tenant-admin", "tenant", { expiresAtMs: 999_999 }),
      binding("platform-admin", "platform"),
      binding("workspace-admin", "workspace", { workspaceId: "ws-1" }),
    ];
    const out = applyDefaultGrantExpiry(input, NOW, 90);
    expect(out[0].expiresAtMs).toBe(NOW + 90 * 86_400_000);
    expect(out[1].expiresAtMs).toBe(999_999);
    expect(out[2].expiresAtMs).toBeUndefined();
    expect(out[3].expiresAtMs).toBe(NOW + 90 * 86_400_000);
    // Input is never mutated.
    expect(input[0].expiresAtMs).toBeUndefined();
    expect(input[3].expiresAtMs).toBeUndefined();
  });
});

describe("isAdminRoleGrant", () => {
  it("fires on any admin-role binding, not on member bindings", () => {
    expect(isAdminRoleGrant([binding("member", "tenant")])).toBe(false);
    expect(isAdminRoleGrant([binding("tenant-admin", "tenant")])).toBe(true);
    expect(isAdminRoleGrant([binding("platform-admin", "platform")])).toBe(true);
    expect(isAdminRoleGrant([binding("member", "tenant"), binding("tenant-admin", "tenant")])).toBe(true);
  });
});

describe("bindingsEqual", () => {
  it("matches order-insensitively and distinguishes workspace", () => {
    const a = [binding("member", "tenant"), binding("tenant-admin", "tenant")];
    const b = [binding("tenant-admin", "tenant"), binding("member", "tenant")];
    expect(bindingsEqual(a, b)).toBe(true);
    expect(bindingsEqual(a, [binding("member", "tenant")])).toBe(false);
    expect(
      bindingsEqual(
        [binding("workspace-admin", "workspace", { workspaceId: "ws-1" })],
        [binding("workspace-admin", "workspace", { workspaceId: "ws-2" })],
      ),
    ).toBe(false);
  });
});

describe("grantBindingViolatesMatrix", () => {
  const GRANT_TIME = 5_000;
  const granterTenantAdmin = membership("m1", "granter", "primary", [
    binding("tenant-admin", "tenant"),
  ]);
  const granterPlatformAdmin = membership("m2", "granter", "primary", [
    binding("platform-admin", "platform"),
  ]);

  it("platform grants require a platform-admin granter", () => {
    expect(
      grantBindingViolatesMatrix(
        binding("platform-admin", "platform"),
        "primary",
        [granterTenantAdmin],
        GRANT_TIME,
      ),
    ).toBe(true);
    expect(
      grantBindingViolatesMatrix(
        binding("platform-admin", "platform"),
        "primary",
        [granterPlatformAdmin],
        GRANT_TIME,
      ),
    ).toBe(false);
  });

  it("tenant grants require a tenant-admin granter in the same tenant", () => {
    expect(
      grantBindingViolatesMatrix(
        binding("member", "tenant"),
        "primary",
        [granterTenantAdmin],
        GRANT_TIME,
      ),
    ).toBe(false);
    expect(
      grantBindingViolatesMatrix(
        binding("member", "tenant"),
        "other",
        [granterTenantAdmin],
        GRANT_TIME,
      ),
    ).toBe(true);
    expect(
      grantBindingViolatesMatrix(binding("member", "tenant"), "primary", [], GRANT_TIME),
    ).toBe(true);
  });

  it("workspace grants accept a matching workspace-admin or a tenant-admin", () => {
    const wsGranter = membership("m3", "granter", "primary", [
      binding("workspace-admin", "workspace", { workspaceId: "ws-1" }),
    ]);
    const target = binding("workspace-admin", "workspace", { workspaceId: "ws-1" });
    expect(grantBindingViolatesMatrix(target, "primary", [wsGranter], GRANT_TIME)).toBe(false);
    expect(
      grantBindingViolatesMatrix(
        binding("workspace-admin", "workspace", { workspaceId: "ws-2" }),
        "primary",
        [wsGranter],
        GRANT_TIME,
      ),
    ).toBe(true);
    expect(grantBindingViolatesMatrix(target, "primary", [granterTenantAdmin], GRANT_TIME)).toBe(false);
  });

  it("ignores revocation but respects expiry at grant time", () => {
    const revokedGranter = membership("m4", "granter", "primary", [
      binding("tenant-admin", "tenant"),
    ], { revokedAtMs: 9_000 });
    expect(
      grantBindingViolatesMatrix(binding("member", "tenant"), "primary", [revokedGranter], GRANT_TIME),
    ).toBe(false);
    const expiredGranter = membership("m5", "granter", "primary", [
      binding("tenant-admin", "tenant", { expiresAtMs: 4_000 }),
    ]);
    expect(
      grantBindingViolatesMatrix(binding("member", "tenant"), "primary", [expiredGranter], GRANT_TIME),
    ).toBe(true);
  });
});

describe("listGrantsForReview", () => {
  const NOW = 100_000;

  it("lists live grants by a fully-revoked granter only", () => {
    const granterLive = membership("g1", "granter-live", "primary", [binding("tenant-admin", "tenant")]);
    const granterRevoked = membership(
      "g2",
      "granter-dead",
      "primary",
      [binding("tenant-admin", "tenant")],
      { revokedAtMs: 50_000 },
    );
    const grantByLive = membership("a1", "alice", "primary", [binding("member", "tenant")], {
      createdBy: "granter-live",
    });
    const grantByDead = membership("a2", "bob", "primary", [binding("member", "tenant")], {
      createdBy: "granter-dead",
    });
    const grantByDeadExpired = membership(
      "a3",
      "carol",
      "primary",
      [binding("member", "tenant", { expiresAtMs: 90_000 })],
      { createdBy: "granter-dead" },
    );
    const grantByDeadRevoked = membership("a4", "dave", "primary", [binding("member", "tenant")], {
      createdBy: "granter-dead",
      revokedAtMs: 60_000,
    });
    const genesisGrant = membership("a5", "erin", "primary", [binding("tenant-admin", "tenant")], {
      createdBy: "system:bootstrap",
    });
    const queue = listGrantsForReview(
      [granterLive, granterRevoked, grantByLive, grantByDead, grantByDeadExpired, grantByDeadRevoked, genesisGrant],
      NOW,
    );
    expect(queue.map((q) => q.membershipId)).toEqual(["a2"]);
    expect(queue[0].reason).toBe("granter-revoked");
  });

  it("does not treat a granter with any live membership as revoked", () => {
    const granterMixed = membership("g1", "granter", "primary", [binding("tenant-admin", "tenant")]);
    const granterMixedRevoked = membership(
      "g2",
      "granter",
      "other",
      [binding("tenant-admin", "tenant")],
      { revokedAtMs: 50_000 },
    );
    const grant = membership("a1", "alice", "primary", [binding("member", "tenant")], {
      createdBy: "granter",
    });
    expect(listGrantsForReview([granterMixed, granterMixedRevoked, grant], NOW)).toEqual([]);
  });
});

describe("grant proposal store", () => {
  const NOW = 20_000;
  const input = {
    kind: "grant" as const,
    granteeInternalUserId: "user-1",
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant" }],
  };

  it("proposes, matches order-insensitively, confirms only a distinct approver", async () => {
    const store = createGrantProposalStore(memoryKv());
    const proposed = await store.propose({ ...input, proposerInternalUserId: "admin-a", nowMs: NOW });
    expect(proposed.status).toBe("pending");
    expect(proposed.approvers).toEqual(["admin-a"]);

    const found = await store.findMatchingPending({ ...input });
    expect(found?.proposalId).toBe(proposed.proposalId);

    const self = await store.confirm(proposed.proposalId, "admin-a", NOW + 1);
    expect(self).toEqual({ ok: false, code: "SELF_CONFIRM" });

    const confirmed = await store.confirm(proposed.proposalId, "admin-b", NOW + 2);
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.proposal.status).toBe("confirmed");
      expect(confirmed.proposal.approvers).toEqual(["admin-a", "admin-b"]);
    }

    const again = await store.confirm(proposed.proposalId, "admin-c", NOW + 3);
    expect(again).toEqual({ ok: false, code: "NOT_PENDING" });
  });

  it("does not match a different binding set", async () => {
    const store = createGrantProposalStore(memoryKv());
    await store.propose({ ...input, proposerInternalUserId: "admin-a", nowMs: NOW });
    const found = await store.findMatchingPending({
      ...input,
      roleBindings: [{ role: "member", scope: "tenant" }],
    });
    expect(found).toBeNull();
  });

  it("resolve: first call proposes, same caller awaits, distinct caller confirms", async () => {
    const store = createGrantProposalStore(memoryKv());
    const first = await resolveAdminGrantProposal(store, {
      ...input,
      callerInternalUserId: "admin-a",
      nowMs: NOW,
    });
    expect(first.action).toBe("propose");
    const same = await resolveAdminGrantProposal(store, {
      ...input,
      callerInternalUserId: "admin-a",
      nowMs: NOW + 1,
    });
    expect(same.action).toBe("awaiting");
    const second = await resolveAdminGrantProposal(store, {
      ...input,
      callerInternalUserId: "admin-b",
      nowMs: NOW + 2,
    });
    expect(second.action).toBe("confirm");
    expect(second.proposal.approvers).toEqual(["admin-a", "admin-b"]);
  });
});

describe("access-request approvers (#3155)", () => {
  it("records approvers without deciding, then decide still works", async () => {
    const store = createAccessRequestStore(memoryKv());
    const created = await store.create({
      requesterInternalUserId: "user-1",
      requestedRole: "tenant-admin",
      tenantId: "primary",
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = await store.recordApprover(created.request.requestId, "admin-a", 2_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.approverCount).toBe(1);
    expect(first.request.status).toBe("pending");
    const dup = await store.recordApprover(created.request.requestId, "admin-a", 3_000);
    expect(dup).toEqual({ ok: false, code: "ALREADY_APPROVER" });
    const second = await store.recordApprover(created.request.requestId, "admin-b", 4_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.approverCount).toBe(2);
    const decided = await store.decide(created.request.requestId, "approved", "admin-b", 5_000);
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.request.status).toBe("approved");
      expect(decided.request.approvers).toEqual(["admin-a", "admin-b"]);
    }
  });
});
