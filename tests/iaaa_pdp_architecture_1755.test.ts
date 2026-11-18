import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  authorize,
  authorizeWithPolicy,
  canGrantRole,
  createMemoryMembershipStore,
  createMembership,
  getCompiledPolicySnapshot,
  membershipStoreToAttributeProvider,
  type AttributeProvider,
  type Membership,
} from "../src/security/authorization";
import {
  compiledPolicyProvider,
  createInProcessPdp,
  exportPolicySnapshot,
  parsePolicySnapshot,
  resolvePdpPolicySource,
  snapshotPolicyProvider,
  type PolicySnapshot,
} from "../src/security/pdpPorts";
import { evaluateRoutePep } from "../src/security/pepGateway";

/**
 * #1755 (parent #1717): IAAA PDP architecture — policy store,
 * PDP service boundary, PEP/PIP consolidation.
 *
 * Decisions (recorded on #1755 before this build):
 * (a) TypeScript tables stay authoritative; a portable JSON
 *     PolicySnapshot + PolicyProvider port is added; no editor.
 * (b) The PDP stays in-process; it gains a PolicyDecisionPoint
 *     port with a serializable request/response contract; no
 *     network endpoint or independent deployment.
 * (c) No single runtime gateway; one gateway PATTERN
 *     (evaluateRoutePep) adopted at the four integration:connect
 *     sites, plus a real PIP port — the PDP reads attributes only
 *     through an AttributeProvider, never a store directly.
 *
 * Nothing here changes an enforcement decision: the compiled
 * policy path must agree with authorize() on every case, and the
 * gateway must reproduce the four server.ts blocks exactly.
 */

const NOW = 1_800_000_000_000;

async function seed(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user: string,
  role: "member" | "tenant-admin" | "platform-admin",
  tenant = "tenant-a",
): Promise<Membership> {
  const scope = role === "platform-admin" ? "platform" : "tenant";
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: tenant,
    roleBindings: [{ role, scope, grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

describe("policy snapshot: portable form of the compiled tables (#1755a)", () => {
  it("exports the compiled tables with the current policy version", () => {
    const snapshot = exportPolicySnapshot();
    expect(snapshot.version).toBe(AUTHORIZATION_POLICY_VERSION);
    expect(snapshot.version).toBe("iaaa-authorization-2");
    expect(snapshot.roleGrants["tenant-admin"]).toContain("role:assign");
    expect(snapshot.roleGrants.member).toContain("task:read");
    expect(snapshot.roleGrants.member).not.toContain("role:assign");
    expect(snapshot.roleGrants["platform-admin"]).toEqual([
      "role:assign",
      "audit:read",
      "audit:export",
    ]);
  });

  it("round-trips: export -> parse -> export is identical", () => {
    const parsed = parsePolicySnapshot(exportPolicySnapshot());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(exportPolicySnapshot()).toEqual(parsed.snapshot);
    // And the compiled accessor agrees with the export.
    expect(getCompiledPolicySnapshot()).toEqual(exportPolicySnapshot());
  });

  it("parse rejects unknown permissions, unknown roles, and missing roles", () => {
    const base = exportPolicySnapshot();
    expect(
      parsePolicySnapshot({ ...base, roleGrants: { ...base.roleGrants, member: ["task:read", "nope:perm"] } }).ok,
    ).toBe(false);
    expect(
      parsePolicySnapshot({ ...base, roleGrants: { ...base.roleGrants, wizard: ["task:read"] } }).ok,
    ).toBe(false);
    const { member: _dropped, ...withoutMember } = base.roleGrants;
    expect(parsePolicySnapshot({ ...base, roleGrants: withoutMember }).ok).toBe(false);
    expect(parsePolicySnapshot({ ...base, version: "" }).ok).toBe(false);
    expect(parsePolicySnapshot(null).ok).toBe(false);
    expect(parsePolicySnapshot(JSON.stringify(base)).ok).toBe(false);
  });

  it("export returns a copy: mutating it cannot change live policy", async () => {
    const snapshot = exportPolicySnapshot();
    (snapshot.roleGrants.member as string[]).push("role:assign");
    const store = createMemoryMembershipStore();
    await seed(store, "user-1", "member");
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });
});

describe("PIP port: the PDP reads attributes only through a provider (#1755c)", () => {
  it("authorizeWithPolicy agrees with authorize() across a decision matrix", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "user-1", "member");
    await seed(store, "admin-1", "tenant-admin");
    await seed(store, "plat-1", "platform-admin", "platform");
    const pip = membershipStoreToAttributeProvider(store);
    const policy = getCompiledPolicySnapshot();
    const cases = [
      { actor: "user-1", tenant: "tenant-a", permission: "task:read", scope: "tenant" },
      { actor: "user-1", tenant: "tenant-a", permission: "role:assign", scope: "tenant" },
      { actor: "admin-1", tenant: "tenant-a", permission: "role:assign", scope: "tenant" },
      { actor: "admin-1", tenant: "tenant-b", permission: "task:read", scope: "tenant" },
      { actor: "nobody", tenant: "tenant-a", permission: "task:read", scope: "tenant" },
      { actor: "plat-1", tenant: undefined, permission: "audit:export", scope: "platform" },
      { actor: "admin-1", tenant: undefined, permission: "audit:export", scope: "platform" },
    ] as const;
    for (const c of cases) {
      const viaStore = await authorize(store, {
        actorInternalUserId: c.actor,
        tenantId: c.tenant,
        permission: c.permission as never,
        scope: c.scope as never,
        nowMs: NOW,
      });
      const viaPip = await authorizeWithPolicy(policy, pip, {
        actorInternalUserId: c.actor,
        tenantId: c.tenant,
        permission: c.permission as never,
        scope: c.scope as never,
        nowMs: NOW,
      });
      expect(viaPip).toEqual(viaStore);
    }
  });

  it("a snapshot that removes a grant denies, proving the store path is live", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "user-1", "member");
    const pip = membershipStoreToAttributeProvider(store);
    const snapshot: PolicySnapshot = {
      ...getCompiledPolicySnapshot(),
      roleGrants: {
        ...getCompiledPolicySnapshot().roleGrants,
        member: ["task:create"],
      },
    };
    const denied = await authorizeWithPolicy(snapshot, pip, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(denied.decision).toBe("deny");
    const allowed = await authorizeWithPolicy(snapshot, pip, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(allowed.decision).toBe("allow");
  });

  it("the PDP never calls the store: a counting PIP is the only read path", async () => {
    let reads = 0;
    const pip: AttributeProvider = {
      async getMembershipsByUser() {
        reads += 1;
        return [];
      },
    };
    const decision = await authorizeWithPolicy(getCompiledPolicySnapshot(), pip, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_MEMBERSHIP");
    expect(reads).toBe(1);
  });

  it("canGrantRole still enforces the hard boundary through the PIP", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "admin-1", "tenant-admin");
    const granted = await canGrantRole(store, {
      granterInternalUserId: "admin-1",
      targetTenantId: "tenant-a",
      targetScope: "tenant",
      targetRole: "member",
      nowMs: NOW,
    });
    expect(granted.decision).toBe("allow");
    const platformDenied = await canGrantRole(store, {
      granterInternalUserId: "admin-1",
      targetTenantId: "tenant-a",
      targetScope: "platform",
      targetRole: "platform-admin",
      nowMs: NOW,
    });
    expect(platformDenied.decision).toBe("deny");
    expect(platformDenied.reason).toBe("PLATFORM_SCOPE_DENIED");
  });
});

describe("PDP port: serializable service-boundary contract, in-process (#1755b)", () => {
  it("in-process PDP agrees with authorize() and its request/response round-trip JSON", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "admin-1", "tenant-admin");
    const pdp = createInProcessPdp({
      policyProvider: compiledPolicyProvider(),
      attributeProvider: membershipStoreToAttributeProvider(store),
    });
    const request = {
      internalUserId: "admin-1",
      tenantId: "tenant-a",
      permission: "role:assign" as const,
      nowMs: NOW,
    };
    const wireRequest = JSON.parse(JSON.stringify(request));
    const response = await pdp.decide(wireRequest);
    const wireResponse = JSON.parse(JSON.stringify(response));
    expect(wireResponse).toEqual(response);
    expect(response.decision).toBe("allow");
    expect(response.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
    const direct = await authorize(store, {
      actorInternalUserId: "admin-1",
      tenantId: "tenant-a",
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(response).toEqual(direct);
  });

  it("a snapshot-backed PDP decides from the snapshot, not the tables", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "user-1", "member");
    const parsed = parsePolicySnapshot({
      ...exportPolicySnapshot(),
      roleGrants: { ...exportPolicySnapshot().roleGrants, member: [] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const pdp = createInProcessPdp({
      policyProvider: snapshotPolicyProvider(parsed.snapshot),
      attributeProvider: membershipStoreToAttributeProvider(store),
    });
    const decision = await pdp.decide({
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });
});

describe("policy-source switch: platform-only, invalid fails closed to compiled (#1755a guard)", () => {
  it("unset/blank/code resolve to compiled; snapshot resolves only with valid JSON", () => {
    expect(resolvePdpPolicySource({}).source).toBe("code");
    expect(resolvePdpPolicySource({ IAAA_PDP_POLICY_SOURCE: "  " }).source).toBe("code");
    expect(resolvePdpPolicySource({ IAAA_PDP_POLICY_SOURCE: "CODE" }).source).toBe("code");
    const snap = JSON.stringify(exportPolicySnapshot());
    const ok = resolvePdpPolicySource({
      IAAA_PDP_POLICY_SOURCE: "snapshot",
      IAAA_PDP_POLICY_SNAPSHOT_JSON: snap,
    });
    expect(ok.source).toBe("snapshot");
    expect(ok.invalid).toBe(false);
    expect(ok.snapshot).toEqual(exportPolicySnapshot());
  });

  it("invalid source or snapshot fails closed to compiled with invalid=true", () => {
    expect(resolvePdpPolicySource({ IAAA_PDP_POLICY_SOURCE: "yaml" }).invalid).toBe(true);
    expect(resolvePdpPolicySource({ IAAA_PDP_POLICY_SOURCE: "yaml" }).source).toBe("code");
    const missing = resolvePdpPolicySource({ IAAA_PDP_POLICY_SOURCE: "snapshot" });
    expect(missing.source).toBe("code");
    expect(missing.invalid).toBe(true);
    const broken = resolvePdpPolicySource({
      IAAA_PDP_POLICY_SOURCE: "snapshot",
      IAAA_PDP_POLICY_SNAPSHOT_JSON: "{not json",
    });
    expect(broken.source).toBe("code");
    expect(broken.invalid).toBe(true);
  });

  it("there is no caller carrier: session/user/run values cannot select a policy", () => {
    // The resolver reads ONLY the platform env object. A caller
    // object carrying a policy choice is not even an argument.
    const resolved = resolvePdpPolicySource({
      IAAA_PDP_POLICY_SOURCE: "snapshot",
      IAAA_PDP_POLICY_SNAPSHOT_JSON: JSON.stringify(exportPolicySnapshot()),
    });
    expect(resolved.source).toBe("snapshot");
    // And with no platform snapshot configured, no caller value
    // can conjure one: the env object is the whole input.
    expect(resolvePdpPolicySource({}).snapshot).toBeUndefined();
  });
});

describe("PEP gateway pattern: one helper for the four integration:connect sites (#1755c)", () => {
  const SESSION_TTL_S = 60 * 60 * 24 * 7; // SESSION_TTL in src/security/session.ts
  function envOn(extra: Record<string, string> = {}) {
    return { IAAA_PDP_ENABLED: "1", ...extra };
  }
  function session(user: string | undefined, createdAt: number) {
    return { internalUserId: user, createdAt } as never;
  }

  it("flag OFF is not enforced (pre-change path, byte-identical outcome)", async () => {
    const store = createMemoryMembershipStore();
    const outcome = await evaluateRoutePep({
      env: { IAAA_PDP_ENABLED: "0" },
      session: session("admin-1", NOW),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(outcome).toEqual({ enforced: false });
  });

  it("wired holder is allowed; wired non-holder is denied without a grace code", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "admin-1", "tenant-admin");
    const allowed = await evaluateRoutePep({
      env: envOn(),
      session: session("admin-1", NOW),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(allowed).toEqual({ enforced: true, allowed: true });
    const denied = await evaluateRoutePep({
      env: envOn(),
      session: session("user-9", NOW),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(denied).toEqual({ enforced: true, allowed: false, graceExpired: false });
  });

  it("legacy session inside the grace bound is not enforced; past it is denied with graceExpired", async () => {
    const store = createMemoryMembershipStore();
    const inside = await evaluateRoutePep({
      env: envOn(),
      session: session(undefined, NOW),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(inside).toEqual({ enforced: false });
    const past = await evaluateRoutePep({
      env: envOn(),
      session: session(undefined, NOW - (SESSION_TTL_S + 1) * 1000),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(past).toEqual({ enforced: true, allowed: false, graceExpired: true });
  });

  it("gateway honours a platform snapshot policy when configured", async () => {
    const store = createMemoryMembershipStore();
    await seed(store, "admin-1", "tenant-admin");
    const snapshot = {
      ...exportPolicySnapshot(),
      roleGrants: { ...exportPolicySnapshot().roleGrants, "tenant-admin": ["task:read"] },
    };
    const outcome = await evaluateRoutePep({
      env: envOn({
        IAAA_PDP_POLICY_SOURCE: "snapshot",
        IAAA_PDP_POLICY_SNAPSHOT_JSON: JSON.stringify(snapshot),
      }),
      session: session("admin-1", NOW),
      tenantId: "tenant-a",
      permission: "integration:connect",
      membershipStore: store,
      nowMs: NOW,
    });
    expect(outcome).toEqual({ enforced: true, allowed: false, graceExpired: false });
  });
});
