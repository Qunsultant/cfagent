import { describe, expect, it } from "vitest";
import { agentIdForServiceLogin } from "../src/security/agentAccess";
import {
  createMemoryMembershipStore,
  type AuthorizationScope,
  type Membership,
  type Role,
} from "../src/security/authorization";
import {
  authorizeSystemPrincipal,
  type SystemPrincipalPermissionResult,
} from "../src/security/serviceDispatch";
import { serviceUserInternalUserId } from "../src/security/serviceIdentity";

/**
 * GAP-3 (#5459, CISO coordination #5349) — the system-principal
 * binding story.
 *
 * The story: the system actor is `service:<login>` (the existing
 * derivation, never a second one); the binding that carries a
 * permission for it is a tenant-scope binding whose role grants
 * the permission under the EXISTING policy table — for
 * `ledger:record`, a tenant-admin binding in the tenant whose
 * ledger is written — evaluated by the existing authorize() at
 * tenant scope. No policy change, no new grant rule, no new
 * store. A member binding carries no money permission, and this
 * slice does not invent a rule to change that.
 *
 * The binding shape + the anomaly semantics below are CISO review
 * questions on the PR (#5349 had not decided at build time;
 * no-idle-wait per #5349). Nothing here is presented as
 * CISO-decided.
 */

const SERVICE_LOGIN = "svc-background";
const SERVICE_ID = `service:${SERVICE_LOGIN}`;
const TENANT = "tenant-a";
const NOW = 1_700_000_000_000;
const FUTURE = NOW + 60_000;
const PAST = NOW - 60_000;

function membershipFor(
  userId: string,
  opts: {
    role: Role;
    scope: AuthorizationScope;
    tenantId: string;
    expiresAtMs?: number;
    revokedAtMs?: number;
    suffix?: string;
  },
): Membership {
  return {
    membershipId: `m-${userId}-${opts.tenantId}-${opts.role}-${opts.scope}-${opts.suffix ?? "1"}`,
    internalUserId: userId,
    tenantId: opts.tenantId,
    roleBindings: [
      {
        role: opts.role,
        scope: opts.scope,
        grantedBy: "test",
        ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
      },
    ],
    createdBy: "test",
    createdAtMs: NOW - 2_000,
    ...(opts.revokedAtMs !== undefined ? { revokedAtMs: opts.revokedAtMs } : {}),
  };
}

function resolved(
  result: SystemPrincipalPermissionResult,
): Extract<SystemPrincipalPermissionResult, { resolved: true }> {
  if (!result.resolved) throw new Error(`expected resolved, got ${result.reason}`);
  return result;
}

describe("authorizeSystemPrincipal — resolution and threading", () => {
  it("resolves the configured login to the service principal and threads it into the decision", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "tenant-admin", scope: "tenant", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.serviceLogin).toBe(SERVICE_LOGIN);
    expect(result.principalId).toBe(SERVICE_ID);
    expect(result.decision.principalId).toBe(SERVICE_ID);
    expect(result.decision.decision).toBe("allow");
    expect(result.decision.permission).toBe("ledger:record");
    expect(result.anomaly).toBeUndefined();
  });

  it("derives the principal id and the agent id from the same login, through the existing derivations", () => {
    expect(serviceUserInternalUserId(SERVICE_LOGIN)).toBe(SERVICE_ID);
    expect(agentIdForServiceLogin(SERVICE_LOGIN)).toBe(`agent:service:${SERVICE_LOGIN}`);
  });

  it("does not resolve an unconfigured service login", async () => {
    const store = createMemoryMembershipStore();
    const result = await authorizeSystemPrincipal(store, {
      serviceLogin: null,
      tenantId: TENANT,
      permission: "ledger:record",
      nowMs: NOW,
    });
    expect(result).toEqual({ resolved: false, reason: "SERVICE_NOT_CONFIGURED" });
  });

  it("does not resolve a malformed service login — fail-closed, never a throw or a fallback", async () => {
    const store = createMemoryMembershipStore();
    for (const malformed of ["", "has space", "trailing\n"]) {
      const result = await authorizeSystemPrincipal(store, {
        serviceLogin: malformed,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      });
      expect(result).toEqual({ resolved: false, reason: "SERVICE_NOT_CONFIGURED" });
    }
  });

  it("never resolves a shared-orchestrator address as an identity", async () => {
    const store = createMemoryMembershipStore();
    for (const address of ["shared_orchestrator", "default_trader"]) {
      await store.put(
        membershipFor(`service:${address}`, {
          role: "tenant-admin",
          scope: "tenant",
          tenantId: TENANT,
          suffix: address,
        }),
      );
      const result = await authorizeSystemPrincipal(store, {
        serviceLogin: address,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      });
      expect(result).toEqual({ resolved: false, reason: "SHARED_ADDRESS" });
    }
  });
});

describe("authorizeSystemPrincipal — the binding story", () => {
  it("allows ledger:record for a live tenant-admin binding in the tenant", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "tenant-admin", scope: "tenant", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "allow", reason: "ALLOW" });
  });

  it("denies ledger:record for a member binding — the member role carries no money permission", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "member", scope: "tenant", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "NO_GRANT" });
  });

  it("is the PDP deciding, not a ledger special-case: a member binding allows task:create", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "member", scope: "tenant", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "task:create",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "allow", reason: "ALLOW" });
  });

  it("denies an unprovisioned service id", async () => {
    const store = createMemoryMembershipStore();
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "NO_MEMBERSHIP" });
  });

  it("denies cross-tenant: a binding in another tenant grants nothing here", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "tenant-admin", scope: "tenant", tenantId: "tenant-b" }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "CROSS_TENANT" });
  });

  it("denies a revoked membership", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "tenant-admin",
        scope: "tenant",
        tenantId: TENANT,
        revokedAtMs: NOW - 1_000,
      }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "MEMBERSHIP_REVOKED" });
  });

  it("denies an expired binding", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "tenant-admin",
        scope: "tenant",
        tenantId: TENANT,
        expiresAtMs: PAST,
      }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "NO_GRANT" });
  });

  it("revocation denies at the next check — 0 ms semantics, fresh store read", async () => {
    const store = createMemoryMembershipStore();
    const membership = membershipFor(SERVICE_ID, {
      role: "tenant-admin",
      scope: "tenant",
      tenantId: TENANT,
      expiresAtMs: FUTURE,
    });
    await store.put(membership);
    const before = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(before.decision.decision).toBe("allow");
    expect(await store.revokeMembership(membership.membershipId, NOW + 1_000)).toBe(true);
    const after = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW + 1_000,
      }),
    );
    expect(after.decision).toMatchObject({ decision: "deny", reason: "MEMBERSHIP_REVOKED" });
  });

  it("passes an invalid tenant through to the PDP's own denial", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "tenant-admin", scope: "tenant", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: "   ",
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "INVALID_TENANT_ID" });
  });
});

describe("authorizeSystemPrincipal — the platform-admin anomaly (#2331)", () => {
  it("denies a service id holding only a platform-admin binding, and surfaces the anomaly", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "platform-admin", scope: "platform", tenantId: TENANT }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "deny", reason: "NO_GRANT" });
    expect(result.anomaly).toContain("platform-admin binding");
  });

  it("surfaces the anomaly without overriding a PDP allow from a legitimate tenant binding", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, { role: "tenant-admin", scope: "tenant", tenantId: TENANT }),
    );
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "platform-admin",
        scope: "platform",
        tenantId: TENANT,
        suffix: "2",
      }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision).toMatchObject({ decision: "allow", reason: "ALLOW" });
    expect(result.anomaly).toContain("platform-admin binding");
  });

  it("does not flag an admin binding on a revoked membership — revocation already handled it", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "platform-admin",
        scope: "platform",
        tenantId: TENANT,
        revokedAtMs: NOW - 1_000,
      }),
    );
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "tenant-admin",
        scope: "tenant",
        tenantId: TENANT,
        suffix: "2",
      }),
    );
    const result = resolved(
      await authorizeSystemPrincipal(store, {
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        permission: "ledger:record",
        nowMs: NOW,
      }),
    );
    expect(result.decision.decision).toBe("allow");
    expect(result.anomaly).toBeUndefined();
  });
});
