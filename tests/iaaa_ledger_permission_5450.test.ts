import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  PERMISSIONS,
  authorize,
  createMemoryMembershipStore,
  createMembership,
  getCompiledPolicySnapshot,
} from "../src/security/authorization";
import { parsePolicySnapshot } from "../src/security/pdpPorts";

/**
 * GAP-2 (#5450, CISO coordination #5348) — the money/ledger permission.
 *
 * `ledger:record` is added to the SAME 17-permission table, following the
 * existing pattern: tenant-admin + workspace-admin hold it via the
 * [...PERMISSIONS] spread, like the other admin-only permissions; no
 * other role holds it. The permission name + bindings are CISO review
 * questions on the PR (#5348 had not decided at build time; no-idle-wait
 * per #5348). No route behavior changes in this slice — the permission
 * is policy data the ledger-gate slice will consult.
 */

const NOW = 1_800_000_000_000;

const ORIGINAL_17 = [
  "membership:invite",
  "membership:revoke",
  "role:assign",
  "task:create",
  "task:read",
  "task:cancel",
  "artifact:read",
  "artifact:edit",
  "artifact:export",
  "integration:connect",
  "integration:use",
  "integration:manage",
  "action:propose",
  "action:approve",
  "action:execute",
  "audit:read",
  "audit:export",
] as const;

async function grant(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user: string,
  role: "tenant-admin" | "workspace-admin" | "member" | "approver" | "auditor" | "platform-admin",
  scope: "tenant" | "workspace" | "platform",
  tenantId = "tenant-a",
) {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId,
    roleBindings: [{ role, scope, grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

describe("money/ledger permission (#5450)", () => {
  it("adds ledger:record to the same table without changing the other 17 entries", () => {
    expect(PERMISSIONS).toHaveLength(18);
    expect([...PERMISSIONS.slice(0, 17)]).toEqual([...ORIGINAL_17]);
    expect(PERMISSIONS[17]).toBe("ledger:record");
  });

  it("advances the policy version with the table change", () => {
    expect(AUTHORIZATION_POLICY_VERSION).toBe("iaaa-authorization-2");
    expect(getCompiledPolicySnapshot().version).toBe("iaaa-authorization-2");
  });

  it("grants ledger:record to tenant-admin + workspace-admin via the spread, no other role", () => {
    const snapshot = getCompiledPolicySnapshot();
    expect([...snapshot.roleGrants["tenant-admin"]]).toEqual([...PERMISSIONS]);
    expect([...snapshot.roleGrants["workspace-admin"]]).toEqual([...PERMISSIONS]);
    expect(snapshot.roleGrants["platform-admin"]).toEqual([
      "role:assign",
      "audit:read",
      "audit:export",
    ]);
    expect(snapshot.roleGrants["member"]).toEqual([
      "task:create",
      "task:read",
      "task:cancel",
      "artifact:read",
      "artifact:edit",
      "artifact:export",
      "action:propose",
      "integration:connect",
    ]);
    expect(snapshot.roleGrants["approver"]).toEqual(["action:approve"]);
    expect(snapshot.roleGrants["auditor"]).toEqual([
      "task:read",
      "artifact:read",
      "audit:read",
    ]);
    for (const role of ["platform-admin", "member", "approver", "auditor"] as const) {
      expect(snapshot.roleGrants[role]).not.toContain("ledger:record");
    }
  });

  it("allows a tenant-admin to record a ledger row in their own tenant", async () => {
    const store = createMemoryMembershipStore();
    await grant(store, "admin-1", "tenant-admin", "tenant");
    const decision = await authorize(store, {
      actorInternalUserId: "admin-1",
      tenantId: "tenant-a",
      permission: "ledger:record",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.policyVersion).toBe("iaaa-authorization-2");
  });

  it("denies a member the ledger permission (default-deny for unbound roles)", async () => {
    const store = createMemoryMembershipStore();
    await grant(store, "user-1", "member", "tenant");
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "ledger:record",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_GRANT");
  });

  it("denies ledger:record at platform scope (platform-admin does not hold it)", async () => {
    const store = createMemoryMembershipStore();
    await grant(store, "platform-1", "platform-admin", "platform", "platform");
    const decision = await authorize(store, {
      actorInternalUserId: "platform-1",
      permission: "ledger:record",
      scope: "platform",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_GRANT");
  });

  it("denies a cross-tenant ledger request", async () => {
    const store = createMemoryMembershipStore();
    await grant(store, "admin-1", "tenant-admin", "tenant");
    const decision = await authorize(store, {
      actorInternalUserId: "admin-1",
      tenantId: "tenant-b",
      permission: "ledger:record",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("carries the new permission through the portable policy snapshot", () => {
    const parsed = parsePolicySnapshot(getCompiledPolicySnapshot());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.permissions).toContain("ledger:record");
    expect(parsed.snapshot.roleGrants["tenant-admin"]).toContain("ledger:record");
  });
});
