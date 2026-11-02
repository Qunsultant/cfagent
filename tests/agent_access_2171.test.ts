/**
 * Issue #2171 (parent #1717) — access management for agents.
 *
 * RED FIRST: written against src/security/agentAccess.ts before that
 * module exists. The slice covers, in one coherent unit:
 * - agent identities (stable `agent:<kind>:<slug>` ids, distinct from
 *   user ids; delegation from a principal is bounded and recorded),
 * - grants (tool / route / agent / data targets, default-deny),
 * - enforcement through the PDP seam, fail-closed on PDP error,
 * - revocation propagation (0 ms per trigger class, fresh reads),
 * - audit records carrying agent + grant + delegating principal.
 */
import { describe, it, expect } from "vitest";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createDelegation,
  createMemoryDelegationStore,
  revokeDelegation,
  type Delegation,
} from "../src/security/delegation";
import {
  agentIdentityId,
  agentIdForServiceLogin,
  authorizeAgentInvocation,
  createAgentGrant,
  createAgentIdentity,
  createKvAgentGrantStore,
  createKvAgentIdentityStore,
  createMemoryAgentGrantStore,
  createMemoryAgentIdentityStore,
  parseAgentIdentityId,
  resolveAgentAccessMode,
  revokeAgentGrant,
  revokeAgentIdentity,
  revokeGrantsForDelegation,
  type AgentAccessDeps,
  type AgentGrant,
  type AgentIdentity,
} from "../src/security/agentAccess";
import type { KvLike } from "../src/security/kvResilience";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TENANT = "tenant-1";
const DELEGATOR = "user-delegator-1";
const AGENT_SLUG = "orchestrator";

function tenantAdmin(delegator: string): Membership {
  return {
    membershipId: `m-admin-${delegator}`,
    internalUserId: delegator,
    tenantId: TENANT,
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

interface Fixture {
  memberships: MembershipStore;
  delegations: ReturnType<typeof createMemoryDelegationStore>;
  identities: ReturnType<typeof createMemoryAgentIdentityStore>;
  grants: ReturnType<typeof createMemoryAgentGrantStore>;
  delegation: Delegation;
  identity: AgentIdentity;
  grant: AgentGrant;
}

async function fixture(opts: {
  grantPermission?: "task:read" | "role:assign";
  grantTarget?: string;
  grantTargetKind?: "tool" | "route" | "agent" | "data";
  grantPurpose?: string;
  grantResourceScope?: string[];
  grantMaxActions?: number;
  grantExpiresAtMs?: number;
  identityExpiresAtMs?: number;
} = {}): Promise<Fixture> {
  const memberships = createMemoryMembershipStore();
  await memberships.put(tenantAdmin(DELEGATOR));
  const delegations = createMemoryDelegationStore();
  const created = await createDelegation(memberships, delegations, {
    delegatorInternalUserId: DELEGATOR,
    delegateAgentId: agentIdentityId("fleet", AGENT_SLUG),
    tenantId: TENANT,
    allowedActions: [opts.grantPermission ?? "task:read"],
    resourceScope: opts.grantResourceScope ?? [],
    expiresAtMs: NOW + 30 * DAY,
    reDelegationAllowed: false,
    nowMs: NOW,
  });
  if (!created.ok) throw new Error(`delegation setup failed: ${created.error}`);
  const identities = createMemoryAgentIdentityStore();
  const grants = createMemoryAgentGrantStore();
  const identityResult = await createAgentIdentity(identities, {
    kind: "fleet",
    slug: AGENT_SLUG,
    tenantId: TENANT,
    delegatingPrincipalInternalUserId: DELEGATOR,
    delegationId: created.delegation.id,
    expiresAtMs: opts.identityExpiresAtMs,
    nowMs: NOW,
  });
  if (!identityResult.ok) throw new Error(`identity setup failed: ${identityResult.error}`);
  const grantResult = await createAgentGrant(identities, grants, delegations, {
    agentId: identityResult.identity.id,
    targetKind: opts.grantTargetKind ?? "tool",
    target: opts.grantTarget ?? "web_search",
    tenantId: TENANT,
    purpose: opts.grantPurpose,
    resourceScope: opts.grantResourceScope ?? [],
    permission: opts.grantPermission ?? "task:read",
    maxActions: opts.grantMaxActions,
    expiresAtMs: opts.grantExpiresAtMs,
    delegationId: created.delegation.id,
    nowMs: NOW,
  });
  if (!grantResult.ok) throw new Error(`grant setup failed: ${grantResult.error}`);
  return {
    memberships,
    delegations,
    identities,
    grants,
    delegation: created.delegation,
    identity: identityResult.identity,
    grant: grantResult.grant,
  };
}

function allowingPdp(seen?: { actor?: string }) {
  return async (req: { actorInternalUserId: string }) => {
    if (seen) seen.actor = req.actorInternalUserId;
    return { decision: "allow" as const, reason: "ALLOW" as const };
  };
}

function baseDeps(fx: Fixture, extra: Partial<AgentAccessDeps> = {}): AgentAccessDeps {
  return {
    identities: fx.identities,
    grants: fx.grants,
    delegations: fx.delegations,
    pdp: allowingPdp(),
    ...extra,
  };
}

describe("agent identity (#2171)", () => {
  it("derives a stable, namespaced id distinct from user ids", () => {
    const id = agentIdentityId("fleet", "orchestrator");
    expect(id).toBe("agent:fleet:orchestrator");
    expect(parseAgentIdentityId(id)).toEqual({ kind: "fleet", slug: "orchestrator" });
    expect(parseAgentIdentityId("user-uuid-1")).toBeNull();
    expect(parseAgentIdentityId("service:svc-background")).toBeNull();
    expect(parseAgentIdentityId("agent:bogus-kind:x")).toBeNull();
    expect(() => agentIdentityId("fleet", "bad slug!")).toThrow();
  });

  it("maps a service login to a service-kind agent id", () => {
    expect(agentIdForServiceLogin("svc-background")).toBe("agent:service:svc-background");
    expect(() => agentIdForServiceLogin("not a login!!")).toThrow();
  });

  it("creates an identity and rejects a duplicate id", async () => {
    const identities = createMemoryAgentIdentityStore();
    const first = await createAgentIdentity(identities, {
      kind: "mcp",
      slug: "search",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    const dup = await createAgentIdentity(identities, {
      kind: "mcp",
      slug: "search",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("IDENTITY_EXISTS");
  });

  it("rejects an identity whose expiry is not in the future", async () => {
    const identities = createMemoryAgentIdentityStore();
    const result = await createAgentIdentity(identities, {
      kind: "scheduled",
      slug: "nightly",
      tenantId: TENANT,
      expiresAtMs: NOW,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("agent grants (#2171)", () => {
  it("creates a grant and rejects an unknown agent", async () => {
    const fx = await fixture();
    const bad = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: "agent:fleet:ghost",
      targetKind: "tool",
      target: "web_search",
      tenantId: TENANT,
      resourceScope: [],
      nowMs: NOW,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("UNKNOWN_AGENT");
  });

  it("rejects a grant whose delegation names another agent or tenant", async () => {
    const fx = await fixture();
    const other = await createAgentIdentity(fx.identities, {
      kind: "fleet",
      slug: "other",
      tenantId: TENANT,
      nowMs: NOW,
    });
    if (!other.ok) throw new Error("other identity setup failed");
    const bad = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: other.identity.id,
      targetKind: "tool",
      target: "web_search",
      tenantId: TENANT,
      resourceScope: [],
      delegationId: fx.delegation.id,
      nowMs: NOW,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("DELEGATION_MISMATCH");
  });

  it("rejects an unknown permission and a negative budget", async () => {
    const fx = await fixture();
    const badPerm = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: fx.identity.id,
      targetKind: "tool",
      target: "other_tool",
      tenantId: TENANT,
      resourceScope: [],
      // @ts-expect-error testing an unknown permission at runtime
      permission: "not:a-permission",
      nowMs: NOW,
    });
    expect(badPerm.ok).toBe(false);
    const badBudget = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: fx.identity.id,
      targetKind: "tool",
      target: "other_tool",
      tenantId: TENANT,
      resourceScope: [],
      maxActions: -1,
      nowMs: NOW,
    });
    expect(badBudget.ok).toBe(false);
  });
});

describe("agent enforcement (#2171)", () => {
  it("allows a valid invocation and persists the consumed budget", async () => {
    const fx = await fixture({ grantMaxActions: 2 });
    const seen: { actor?: string } = {};
    const decision = await authorizeAgentInvocation(baseDeps(fx, { pdp: allowingPdp(seen) }), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("ALLOW");
    expect(decision.grant?.usedActions).toBe(1);
    expect(decision.auditEvent.agentId).toBe(fx.identity.id);
    expect(decision.auditEvent.grantId).toBe(fx.grant.id);
    expect(decision.auditEvent.delegatingPrincipal).toBe(DELEGATOR);
    // The PDP actor is the delegating principal, not the agent id.
    expect(seen.actor).toBe(DELEGATOR);
    const stored = await fx.grants.get(fx.grant.id);
    expect(stored?.usedActions).toBe(1);
  });

  it("denies an unknown identity, a revoked identity, and an expired identity", async () => {
    const fx = await fixture();
    const unknown = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: "agent:fleet:ghost",
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(unknown.decision).toBe("deny");
    expect(unknown.reason).toBe("IDENTITY_UNKNOWN");
    expect(unknown.auditEvent.grantId).toBeNull();

    await revokeAgentIdentity(fx.identities, fx.grants, fx.identity.id, NOW);
    const revoked = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(revoked.reason).toBe("IDENTITY_REVOKED");

    const fx2 = await fixture({ identityExpiresAtMs: NOW + DAY });
    const expired = await authorizeAgentInvocation(baseDeps(fx2), {
      agentId: fx2.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW + DAY,
    });
    expect(expired.reason).toBe("IDENTITY_EXPIRED");
  });

  it("default-deny: no matching grant means no access", async () => {
    const fx = await fixture();
    const decision = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "etrade_execute_order",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_GRANT");
    expect(decision.auditEvent.grantId).toBeNull();
  });

  it("denies revoked and expired grants, at the exact expiry boundary", async () => {
    const fx = await fixture({ grantExpiresAtMs: NOW + DAY });
    await revokeAgentGrant(fx.grants, fx.grant.id, NOW);
    const revoked = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(revoked.reason).toBe("GRANT_REVOKED");

    const fx2 = await fixture({ grantExpiresAtMs: NOW + DAY });
    const before = await authorizeAgentInvocation(baseDeps(fx2), {
      agentId: fx2.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW + DAY - 1,
    });
    expect(before.decision).toBe("allow");
    const at = await authorizeAgentInvocation(baseDeps(fx2), {
      agentId: fx2.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW + DAY,
    });
    expect(at.reason).toBe("GRANT_EXPIRED");
  });

  it("denies cross-tenant invocations", async () => {
    const fx = await fixture();
    const decision = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: "tenant-2",
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(decision.reason).toBe("CROSS_TENANT");
  });

  it("enforces purpose and resource scope", async () => {
    const fx = await fixture({ grantPurpose: "research", grantResourceScope: ["res-1"] });
    const wrongPurpose = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      purpose: "trading",
      resourceId: "res-1",
      nowMs: NOW,
    });
    expect(wrongPurpose.reason).toBe("PURPOSE_MISMATCH");
    const wrongResource = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      purpose: "research",
      resourceId: "res-2",
      nowMs: NOW,
    });
    expect(wrongResource.reason).toBe("OUT_OF_RESOURCE_SCOPE");
    const ok = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      purpose: "research",
      resourceId: "res-1",
      nowMs: NOW,
    });
    expect(ok.decision).toBe("allow");
  });

  it("exhausts an action-count budget", async () => {
    const fx = await fixture({ grantMaxActions: 1 });
    const first = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(first.decision).toBe("allow");
    const second = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(second.reason).toBe("BUDGET_EXHAUSTED");
  });

  it("denies on revoked, expired, mismatched, and unknown delegations", async () => {
    const fx = await fixture();
    await revokeDelegation(fx.delegations, fx.delegation.id, NOW);
    const revoked = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(revoked.reason).toBe("DELEGATION_REVOKED");

    const fx2 = await fixture();
    const missing = await authorizeAgentInvocation(
      { ...baseDeps(fx2), delegations: undefined },
      {
        agentId: fx2.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
      },
    );
    expect(missing.reason).toBe("DELEGATION_UNKNOWN");
  });

  it("denies when the grant's permission is outside the delegation", async () => {
    const memberships = createMemoryMembershipStore();
    await memberships.put(tenantAdmin(DELEGATOR));
    const delegations = createMemoryDelegationStore();
    const created = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: DELEGATOR,
      delegateAgentId: agentIdentityId("fleet", AGENT_SLUG),
      tenantId: TENANT,
      allowedActions: ["task:read"],
      resourceScope: [],
      expiresAtMs: NOW + 30 * DAY,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("delegation setup failed");
    const identities = createMemoryAgentIdentityStore();
    const grants = createMemoryAgentGrantStore();
    const identity = await createAgentIdentity(identities, {
      kind: "fleet",
      slug: AGENT_SLUG,
      tenantId: TENANT,
      delegatingPrincipalInternalUserId: DELEGATOR,
      delegationId: created.delegation.id,
      nowMs: NOW,
    });
    if (!identity.ok) throw new Error("identity setup failed");
    // Grant carries a permission the delegation never granted; the
    // grant itself is creatable (it names a real permission), but
    // enforcement must deny because the delegation does not cover it.
    const grant = await createAgentGrant(identities, grants, delegations, {
      agentId: identity.identity.id,
      targetKind: "tool",
      target: "web_search",
      tenantId: TENANT,
      resourceScope: [],
      permission: "task:read",
      nowMs: NOW,
    });
    if (!grant.ok) throw new Error("grant setup failed");
    // Widen the grant's permission past the delegation by direct
    // store edit (simulating a grant minted before a delegation
    // narrowing): enforcement re-checks the delegation every call.
    await grants.put({ ...grant.grant, permission: "role:assign" });
    const decision = await authorizeAgentInvocation(
      { identities, grants, delegations, pdp: allowingPdp() },
      {
        agentId: identity.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
      },
    );
    expect(decision.reason).toBe("ACTION_NOT_DELEGATED");
  });

  it("fails closed on PDP deny, PDP throw, and missing PDP for permission grants", async () => {
    const fx = await fixture();
    const denied = await authorizeAgentInvocation(
      baseDeps(fx, {
        pdp: async () => ({ decision: "deny" as const, reason: "DENIED" as const }),
      }),
      {
        agentId: fx.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
      },
    );
    expect(denied.reason).toBe("PDP_DENIED");
    const throwing = await authorizeAgentInvocation(
      baseDeps(fx, {
        pdp: async () => {
          throw new Error("pdp down");
        },
      }),
      {
        agentId: fx.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
      },
    );
    expect(throwing.reason).toBe("PDP_ERROR");
    const missing = await authorizeAgentInvocation(baseDeps(fx, { pdp: undefined }), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(missing.reason).toBe("PDP_UNAVAILABLE");
  });

  it("allows a permission-less grant without a PDP (the grant governs)", async () => {
    const fx = await fixture();
    await fx.grants.put({ ...fx.grant, permission: undefined });
    const decision = await authorizeAgentInvocation(baseDeps(fx, { pdp: undefined }), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("enforces #1751 obligations when the caller opts in", async () => {
    const fx = await fixture({ grantPermission: "role:assign" });
    const stale = await authorizeAgentInvocation(
      {
        ...baseDeps(fx),
        membershipStoreForObligations: fx.memberships,
      },
      {
        agentId: fx.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
        enforceObligations: true,
        authTimeMs: NOW - 60 * 60 * 1000,
        obligationAudit: async () => true,
      },
    );
    expect(stale.reason).toBe("OBLIGATION_FAILED");
    const fresh = await authorizeAgentInvocation(
      {
        ...baseDeps(fx),
        membershipStoreForObligations: fx.memberships,
      },
      {
        agentId: fx.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
        enforceObligations: true,
        authTimeMs: NOW,
        obligationAudit: async () => true,
      },
    );
    expect(fresh.decision).toBe("allow");
  });
});

describe("agent audit + revocation propagation (#2171)", () => {
  it("records allow and deny with agent + grant + delegating principal", async () => {
    const fx = await fixture();
    const events: Array<unknown> = [];
    const deps: AgentAccessDeps = {
      ...baseDeps(fx),
      auditSink: async (event) => {
        events.push(event);
      },
    };
    const allowed = await authorizeAgentInvocation(deps, {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(allowed.auditEvent).toMatchObject({
      type: "agent.action",
      agentId: fx.identity.id,
      grantId: fx.grant.id,
      delegatingPrincipal: DELEGATOR,
      decision: "allow",
    });
    const denied = await authorizeAgentInvocation(deps, {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "nope",
      nowMs: NOW,
    });
    expect(denied.auditEvent).toMatchObject({ decision: "deny", reason: "NO_GRANT", grantId: null });
    expect(events).toHaveLength(2);
  });

  it("fails a would-be allow closed when its audit write throws", async () => {
    const fx = await fixture();
    const decision = await authorizeAgentInvocation(
      {
        ...baseDeps(fx),
        auditSink: async () => {
          throw new Error("audit down");
        },
      },
      {
        agentId: fx.identity.id,
        tenantId: TENANT,
        targetKind: "tool",
        target: "web_search",
        nowMs: NOW,
      },
    );
    expect(decision.reason).toBe("AUDIT_FAILED");
    const stored = await fx.grants.get(fx.grant.id);
    expect(stored?.usedActions).toBe(0);
  });

  it("revocation propagates at 0 ms for grants, identities, and delegations", async () => {
    const fx = await fixture();
    const before = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(before.decision).toBe("allow");

    // Grant revocation: the very next check at the same instant denies.
    await revokeAgentGrant(fx.grants, fx.grant.id, NOW);
    const afterGrant = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(afterGrant.reason).toBe("GRANT_REVOKED");

    // Identity revocation cascades to grants in the same operation.
    const fx2 = await fixture();
    const cascade = await revokeAgentIdentity(fx2.identities, fx2.grants, fx2.identity.id, NOW);
    expect(cascade.identityRevoked).toBe(true);
    expect(cascade.grantsRevoked).toBe(1);
    const storedGrant = await fx2.grants.get(fx2.grant.id);
    expect(storedGrant?.revoked).toBe(true);

    // Delegation revocation denies without touching the grant record.
    const fx3 = await fixture();
    await revokeDelegation(fx3.delegations, fx3.delegation.id, NOW);
    const afterDelegation = await authorizeAgentInvocation(baseDeps(fx3), {
      agentId: fx3.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(afterDelegation.reason).toBe("DELEGATION_REVOKED");
    const untouched = await fx3.grants.get(fx3.grant.id);
    expect(untouched?.revoked).toBe(false);
  });

  it("revoking a delegation's grants is a separate, counted cascade", async () => {
    const fx = await fixture();
    const count = await revokeGrantsForDelegation(fx.delegations, fx.grants, fx.delegation.id, NOW);
    expect(count).toBe(1);
    const denied = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(denied.reason).toBe("GRANT_REVOKED");
  });

  it("in-flight work is defined: a past allow is not retroactively killed", async () => {
    const fx = await fixture();
    const first = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(first.decision).toBe("allow");
    await revokeAgentGrant(fx.grants, fx.grant.id, NOW);
    // The first decision object is unchanged; only NEW invocations deny.
    expect(first.decision).toBe("allow");
    const second = await authorizeAgentInvocation(baseDeps(fx), {
      agentId: fx.identity.id,
      tenantId: TENANT,
      targetKind: "tool",
      target: "web_search",
      nowMs: NOW,
    });
    expect(second.decision).toBe("deny");
  });
});

describe("agent access mode switch (#2171)", () => {
  it("resolves off/audit/enforce from the platform env only", () => {
    expect(resolveAgentAccessMode(undefined)).toEqual({ mode: "off", invalid: false });
    expect(resolveAgentAccessMode({})).toEqual({ mode: "off", invalid: false });
    expect(resolveAgentAccessMode({ IAAA_AGENT_ACCESS_MODE: "enforce" })).toEqual({
      mode: "enforce",
      invalid: false,
    });
    expect(resolveAgentAccessMode({ IAAA_AGENT_ACCESS_MODE: "AUDIT" })).toEqual({
      mode: "audit",
      invalid: false,
    });
    expect(resolveAgentAccessMode({ IAAA_AGENT_ACCESS_MODE: "bogus" })).toEqual({
      mode: "off",
      invalid: true,
    });
    expect(resolveAgentAccessMode({ IAAA_AGENT_ACCESS_MODE: "" })).toEqual({
      mode: "off",
      invalid: false,
    });
  });
});

describe("KV-backed agent stores (#2171)", () => {
  it("round-trips identities and grants, and skips corrupt rows fail-closed", async () => {
    const kv = mapKv();
    const identities = createKvAgentIdentityStore(kv);
    const grants = createKvAgentGrantStore(kv);
    const created = await createAgentIdentity(identities, {
      kind: "a2a",
      slug: "fleet-caller",
      tenantId: TENANT,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("kv identity setup failed");
    const read = await identities.get(created.identity.id);
    expect(read?.id).toBe(created.identity.id);
    const grant = await createAgentGrant(identities, grants, undefined, {
      agentId: created.identity.id,
      targetKind: "agent",
      target: "agent:fleet:worker",
      tenantId: TENANT,
      resourceScope: [],
      nowMs: NOW,
    });
    if (!grant.ok) throw new Error("kv grant setup failed");
    const listed = await grants.listByAgent(created.identity.id);
    expect(listed.map((g) => g.id)).toEqual([grant.grant.id]);

    // Corrupt bytes: reads miss (deny downstream), lists skip.
    const corrupt = mapKv({
      "agent-identity:agent:a2a:bad": "{not json",
      "agent-grant:agent:a2a:bad:g1": "{not json",
      "agent-grants:agent:a2a:bad": JSON.stringify(["agent:a2a:bad:g1"]),
    });
    const badIdentities = createKvAgentIdentityStore(corrupt);
    expect(await badIdentities.get("agent:a2a:bad")).toBeNull();
    const badGrants = createKvAgentGrantStore(corrupt);
    expect(await badGrants.listByAgent("agent:a2a:bad")).toEqual([]);
  });
});
