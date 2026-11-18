import { describe, it, expect } from "vitest";
import { checkPlatformPermission } from "../src/security/iaaaPdpSeam";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";

/**
 * GAP-1 (#5441, seam A, CISO coordination #5350, design #5343 /
 * ADR 0034): the platform-scope PDP consultation route handlers
 * attach to.
 *
 * The consultation delegates to Slice 3's authorize() at platform
 * scope. These tests pin the fail-closed contract (#5350): an
 * invalid actor, an unknown permission, or no live platform-admin
 * binding denies; a store/PDP error propagates to the handler,
 * which answers 500 with no data — no access is ever granted
 * without an explicit PDP allow. They also pin the
 * behavior-neutrality of the permission literal: all three
 * platform-admin grants decide identically, so the wired gates'
 * choice of `role:assign` (the platform-privilege grant) changes
 * no decision the former isPlatformAdmin predicate made.
 */

const NOW = 1792660000000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function membership(
  overrides: Partial<Membership> & { internalUserId: string },
): Membership {
  return {
    membershipId: `m-${overrides.internalUserId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    internalUserId: overrides.internalUserId,
    tenantId: overrides.tenantId ?? "primary",
    roleBindings: overrides.roleBindings ?? [
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
    ...overrides,
  };
}

const platformAdmin = (userId: string): Membership =>
  membership({
    internalUserId: userId,
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
    ],
  });

async function storeWith(memberships: Membership[]): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  for (const m of memberships) await store.put(m);
  return store;
}

describe("checkPlatformPermission", () => {
  it("allows a live platform-admin binding at platform scope", async () => {
    const store = await storeWith([platformAdmin(ADMIN_ID)]);
    const decision = await checkPlatformPermission(store, {
      internalUserId: ADMIN_ID,
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("ALLOW");
  });

  it("denies when the actor holds no membership at all", async () => {
    const store = await storeWith([]);
    const decision = await checkPlatformPermission(store, {
      internalUserId: USER_ID,
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });

  it("denies a tenant-admin: the platform hard boundary holds", async () => {
    const store = await storeWith([membership({ internalUserId: USER_ID })]);
    const decision = await checkPlatformPermission(store, {
      internalUserId: USER_ID,
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });

  it("denies a platform-admin binding at tenant scope (scope mismatch)", async () => {
    const store = await storeWith([
      membership({
        internalUserId: USER_ID,
        roleBindings: [
          { role: "platform-admin", scope: "tenant", grantedBy: "system:bootstrap" },
        ],
      }),
    ]);
    const decision = await checkPlatformPermission(store, {
      internalUserId: USER_ID,
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });

  it("denies revoked and expired bindings", async () => {
    const revoked = await storeWith([
      { ...platformAdmin(ADMIN_ID), revokedAtMs: NOW - 1 },
    ]);
    expect(
      (
        await checkPlatformPermission(revoked, {
          internalUserId: ADMIN_ID,
          permission: "role:assign",
          nowMs: NOW,
        })
      ).decision,
    ).toBe("deny");
    const expired = await storeWith([
      membership({
        internalUserId: ADMIN_ID,
        roleBindings: [
          {
            role: "platform-admin",
            scope: "platform",
            grantedBy: "system:bootstrap-genesis",
            expiresAtMs: NOW - 1,
          },
        ],
      }),
    ]);
    expect(
      (
        await checkPlatformPermission(expired, {
          internalUserId: ADMIN_ID,
          permission: "role:assign",
          nowMs: NOW,
        })
      ).decision,
    ).toBe("deny");
  });

  it("denies an unknown permission and an invalid actor", async () => {
    const store = await storeWith([platformAdmin(ADMIN_ID)]);
    const unknown = await checkPlatformPermission(store, {
      internalUserId: ADMIN_ID,
      // @ts-expect-error unknown permission literal, denied by the PDP
      permission: "nope:not-a-permission",
      nowMs: NOW,
    });
    expect(unknown.decision).toBe("deny");
    expect(unknown.reason).toBe("UNKNOWN_PERMISSION");
    const invalid = await checkPlatformPermission(store, {
      internalUserId: "   ",
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(invalid.decision).toBe("deny");
    expect(invalid.reason).toBe("INVALID_ACTOR");
  });

  it("all three platform-admin grants decide identically (literal is behavior-neutral)", async () => {
    const adminStore = await storeWith([platformAdmin(ADMIN_ID)]);
    const userStore = await storeWith([membership({ internalUserId: USER_ID })]);
    for (const permission of ["role:assign", "audit:read", "audit:export"] as const) {
      expect(
        (
          await checkPlatformPermission(adminStore, {
            internalUserId: ADMIN_ID,
            permission,
            nowMs: NOW,
          })
        ).decision,
      ).toBe("allow");
      expect(
        (
          await checkPlatformPermission(userStore, {
            internalUserId: USER_ID,
            permission,
            nowMs: NOW,
          })
        ).decision,
      ).toBe("deny");
    }
  });

  it("a permission outside the platform grants denies even a platform admin", async () => {
    const store = await storeWith([platformAdmin(ADMIN_ID)]);
    const decision = await checkPlatformPermission(store, {
      internalUserId: ADMIN_ID,
      permission: "membership:revoke",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_GRANT");
  });

  it("a throwing store propagates: fail-closed at the handler (500, no access)", async () => {
    const throwing: MembershipStore = {
      async getMembershipsByUser(): Promise<Membership[]> {
        throw new Error("corrupt evidence");
      },
      async put(): Promise<void> {},
      async revokeMembership(): Promise<boolean> {
        return false;
      },
    };
    await expect(
      checkPlatformPermission(throwing, {
        internalUserId: ADMIN_ID,
        permission: "role:assign",
        nowMs: NOW,
      }),
    ).rejects.toThrow("corrupt evidence");
  });
});
