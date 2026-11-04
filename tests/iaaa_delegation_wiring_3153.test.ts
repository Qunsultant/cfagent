/**
 * Issue #3153 (#945 Q8, owner directive 2026-11-04: delegation
 * wiring LIVE, Q8 definitions adopted) — delegation live wiring +
 * approval-record binding at the agent-access gate.
 *
 * RED FIRST: written against the #3153 gate changes before they
 * exist. The slice covers, in one coherent unit:
 * - delegation budget consumption persisted at invocation (not
 *   just the grant's budget): an exhausted delegation denies
 *   with BUDGET_EXHAUSTED, and an allow persists the delegation's
 *   incremented usedActions alongside the grant's;
 * - approval-record version/hash binding at settlement: an
 *   invocation carrying an approval is allowed only when the
 *   stored approval record validates — same hash, same version,
 *   same tenant, action granted, unexpired, unrevoked — and a
 *   material proposal change after approval denies with
 *   APPROVAL_INVALID;
 * - delegation re-check at grant creation: a revoked or expired
 *   delegation cannot back a new grant;
 * - durable KV stores for delegations and approvals, following
 *   the existing agent-access KV adapter pattern.
 *
 * Explicitly NOT covered here: maxCost (future requirement —
 * action-count only), the global IAAA_AGENT_ACCESS_MODE switch
 * (unchanged by this slice), and A2A dispatch (unchanged).
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
  createApproval,
  type Approval,
  type ApprovalStore,
} from "../src/security/lifecycle";
import {
  agentIdentityId,
  authorizeAgentInvocation,
  createAgentGrant,
  createAgentIdentity,
  createKvApprovalStore,
  createKvDelegationStore,
  createMemoryAgentGrantStore,
  createMemoryAgentIdentityStore,
  type AgentAccessDeps,
  type AgentGrant,
  type AgentIdentity,
} from "../src/security/agentAccess";
import type { KvLike } from "../src/security/kvResilience";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TENANT = "tenant-1";
const DELEGATOR = "user-delegator-1";
const AGENT = agentIdentityId("fleet", "orchestrator");

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

function createMemoryApprovalStore(): ApprovalStore {
  const byId = new Map<string, Approval>();
  return {
    async get(id: string): Promise<Approval | null> {
      return byId.get(id) ?? null;
    },
    async put(approval: Approval): Promise<void> {
      byId.set(approval.id, approval);
    },
  };
}

interface Fixture {
  memberships: MembershipStore;
  delegations: ReturnType<typeof createMemoryDelegationStore>;
  identities: ReturnType<typeof createMemoryAgentIdentityStore>;
  grants: ReturnType<typeof createMemoryAgentGrantStore>;
  approvals: ApprovalStore;
  delegation: Delegation;
  identity: AgentIdentity;
  grant: AgentGrant;
}

async function fixture(opts: {
  delegationMaxActions?: number;
  delegationExpiresAtMs?: number;
  grantPermission?: "task:read";
  grantMaxActions?: number;
} = {}): Promise<Fixture> {
  const memberships = createMemoryMembershipStore();
  await memberships.put(tenantAdmin(DELEGATOR));
  const delegations = createMemoryDelegationStore();
  const created = await createDelegation(memberships, delegations, {
    delegatorInternalUserId: DELEGATOR,
    delegateAgentId: AGENT,
    tenantId: TENANT,
    allowedActions: [opts.grantPermission ?? "task:read"],
    resourceScope: [],
    expiresAtMs: opts.delegationExpiresAtMs ?? NOW + 30 * DAY,
    budget:
      opts.delegationMaxActions !== undefined
        ? { maxActions: opts.delegationMaxActions }
        : undefined,
    reDelegationAllowed: false,
    nowMs: NOW,
  });
  if (!created.ok) throw new Error(`delegation setup failed: ${created.error}`);
  const identities = createMemoryAgentIdentityStore();
  const identityResult = await createAgentIdentity(identities, {
    kind: "fleet",
    slug: "orchestrator",
    tenantId: TENANT,
    delegatingPrincipalInternalUserId: DELEGATOR,
    delegationId: created.delegation.id,
    nowMs: NOW,
  });
  if (!identityResult.ok) throw new Error(`identity setup failed: ${identityResult.error}`);
  const grants = createMemoryAgentGrantStore();
  const grantResult = await createAgentGrant(identities, grants, delegations, {
    agentId: AGENT,
    targetKind: "tool",
    target: "screener.run",
    tenantId: TENANT,
    resourceScope: [],
    permission: opts.grantPermission ?? "task:read",
    maxActions: opts.grantMaxActions,
    delegationId: created.delegation.id,
    nowMs: NOW,
  });
  if (!grantResult.ok) throw new Error(`grant setup failed: ${grantResult.error}`);
  const approvals = createMemoryApprovalStore();
  return {
    memberships,
    delegations,
    identities,
    grants,
    approvals,
    delegation: created.delegation,
    identity: identityResult.identity,
    grant: grantResult.grant,
  };
}

function depsFor(fx: Fixture, extra: Partial<AgentAccessDeps> = {}): AgentAccessDeps {
  return {
    identities: fx.identities,
    grants: fx.grants,
    delegations: fx.delegations,
    approvals: fx.approvals,
    pdp: async () => ({ decision: "allow" }),
    ...extra,
  };
}

function invoke(fx: Fixture, extra: Record<string, unknown> = {}) {
  return {
    agentId: AGENT,
    tenantId: TENANT,
    targetKind: "tool" as const,
    target: "screener.run",
    nowMs: NOW,
    ...extra,
  };
}

async function validApproval(fx: Fixture, overrides: Partial<Approval> = {}): Promise<Approval> {
  const created = createApproval({
    proposalHash: "hash-proposal-1",
    proposalVersion: "v1",
    approverInternalUserId: DELEGATOR,
    tenantId: TENANT,
    grantedActions: ["task:read"],
    expiresAtMs: NOW + 30 * DAY,
    nowMs: NOW,
  });
  if (!created.ok) throw new Error(`approval setup failed: ${created.error}`);
  const approval = { ...created.approval, ...overrides };
  await fx.approvals.put(approval);
  return approval;
}

describe("delegation budget at invocation (#3153)", () => {
  it("persists the delegation's incremented budget on allow, alongside the grant's", async () => {
    const fx = await fixture({ delegationMaxActions: 2 });
    const decision = await authorizeAgentInvocation(depsFor(fx), invoke(fx));
    expect(decision.decision).toBe("allow");
    const delegation = await fx.delegations.get(fx.delegation.id);
    expect(delegation?.usedActions).toBe(1);
    const grant = await fx.grants.get(fx.grant.id);
    expect(grant?.usedActions).toBe(1);
  });

  it("denies with BUDGET_EXHAUSTED once the delegation budget is spent, without consuming the grant", async () => {
    const fx = await fixture({ delegationMaxActions: 1 });
    const first = await authorizeAgentInvocation(depsFor(fx), invoke(fx));
    expect(first.decision).toBe("allow");
    const second = await authorizeAgentInvocation(depsFor(fx), invoke(fx));
    expect(second.decision).toBe("deny");
    expect(second.reason).toBe("BUDGET_EXHAUSTED");
    const grant = await fx.grants.get(fx.grant.id);
    expect(grant?.usedActions).toBe(1);
  });

  it("denies with BUDGET_EXHAUSTED when the delegation starts exhausted", async () => {
    const fx = await fixture({ delegationMaxActions: 0 });
    const decision = await authorizeAgentInvocation(depsFor(fx), invoke(fx));
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("BUDGET_EXHAUSTED");
  });
});

describe("approval-record binding at invocation (#3153)", () => {
  it("allows when the attached approval validates: same hash, version, tenant, and action", async () => {
    const fx = await fixture();
    const approval = await validApproval(fx);
    const decision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(decision.decision).toBe("allow");
  });

  it("denies APPROVAL_INVALID when the proposal hash changed after approval", async () => {
    const fx = await fixture();
    const approval = await validApproval(fx);
    const decision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-CHANGED", proposalVersion: "v1" },
      }),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("APPROVAL_INVALID");
  });

  it("denies APPROVAL_INVALID when the proposal version changed after approval", async () => {
    const fx = await fixture();
    const approval = await validApproval(fx);
    const decision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-proposal-1", proposalVersion: "v2" },
      }),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("APPROVAL_INVALID");
  });

  it("denies APPROVAL_INVALID when the approval was revoked or expired", async () => {
    const fx = await fixture();
    const revoked = await validApproval(fx, { revoked: true });
    const revokedDecision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: revoked.id, proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(revokedDecision.reason).toBe("APPROVAL_INVALID");
    const expired = await validApproval(fx, { expiresAtMs: NOW });
    const expiredDecision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: expired.id, proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(expiredDecision.reason).toBe("APPROVAL_INVALID");
  });

  it("denies APPROVAL_INVALID when the approval does not grant the invoked action", async () => {
    const fx = await fixture();
    const approval = await validApproval(fx, { grantedActions: ["task:create"] });
    const decision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("APPROVAL_INVALID");
  });

  it("denies APPROVAL_UNKNOWN when the approval id resolves to nothing, or no approval store is wired", async () => {
    const fx = await fixture();
    const unknown = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: "no-such-approval", proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(unknown.reason).toBe("APPROVAL_UNKNOWN");
    const approval = await validApproval(fx);
    const noStore = await authorizeAgentInvocation(
      depsFor(fx, { approvals: undefined }),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-proposal-1", proposalVersion: "v1" },
      }),
    );
    expect(noStore.reason).toBe("APPROVAL_UNKNOWN");
  });

  it("leaves invocations without an attached approval unchanged", async () => {
    const fx = await fixture();
    const decision = await authorizeAgentInvocation(depsFor(fx), invoke(fx));
    expect(decision.decision).toBe("allow");
  });

  it("reports the delegation deny first when both delegation and approval fail", async () => {
    const fx = await fixture();
    await revokeDelegation(fx.delegations, fx.delegation.id, NOW);
    const approval = await validApproval(fx);
    const decision = await authorizeAgentInvocation(
      depsFor(fx),
      invoke(fx, {
        approval: { id: approval.id, proposalHash: "hash-CHANGED", proposalVersion: "v1" },
      }),
    );
    expect(decision.reason).toBe("DELEGATION_REVOKED");
  });
});

describe("delegation re-check at grant creation (#3153)", () => {
  it("refuses a grant backed by a revoked delegation", async () => {
    const fx = await fixture();
    await revokeDelegation(fx.delegations, fx.delegation.id, NOW);
    const result = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: AGENT,
      targetKind: "tool",
      target: "screener.run",
      tenantId: TENANT,
      resourceScope: [],
      permission: "task:read",
      delegationId: fx.delegation.id,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_REVOKED");
  });

  it("refuses a grant backed by an expired delegation", async () => {
    const fx = await fixture({ delegationExpiresAtMs: NOW + 1000 });
    const result = await createAgentGrant(fx.identities, fx.grants, fx.delegations, {
      agentId: AGENT,
      targetKind: "tool",
      target: "screener.run",
      tenantId: TENANT,
      resourceScope: [],
      permission: "task:read",
      delegationId: fx.delegation.id,
      nowMs: NOW + 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_EXPIRED");
  });
});

describe("KV delegation and approval stores (#3153)", () => {
  it("round-trips a delegation and lists it by delegator", async () => {
    const kv = mapKv();
    const store = createKvDelegationStore(kv);
    const fx = await fixture();
    await store.put(fx.delegation);
    expect(await store.get(fx.delegation.id)).toEqual(fx.delegation);
    expect(await store.listByDelegator(DELEGATOR)).toEqual([fx.delegation]);
    expect(await store.listByDelegator("someone-else")).toEqual([]);
  });

  it("returns null for a corrupt delegation record and skips it on list", async () => {
    const kv = mapKv({
      "delegation:bad-id": "{not json",
      "delegations:user-x": JSON.stringify(["bad-id"]),
    });
    const store = createKvDelegationStore(kv);
    expect(await store.get("bad-id")).toBeNull();
    expect(await store.listByDelegator("user-x")).toEqual([]);
  });

  it("round-trips an approval and returns null for a corrupt one", async () => {
    const kv = mapKv();
    const store = createKvApprovalStore(kv);
    const fx = await fixture();
    const approval = await validApproval(fx);
    await store.put(approval);
    expect(await store.get(approval.id)).toEqual(approval);
    const corrupt = mapKv({ [`approval:${approval.id}`]: "{not json" });
    expect(await createKvApprovalStore(corrupt).get(approval.id)).toBeNull();
  });
});
