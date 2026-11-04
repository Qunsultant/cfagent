import { describe, it, expect } from "vitest";
import {
  createMemoryIdentityBindingStore,
  resolveOrCreateBinding,
} from "../src/security/identityBinding";
import {
  createMemoryRevocationStore,
  sessionIsUsable,
  DEFAULT_SESSION_POLICY,
} from "../src/security/sessionPolicy";
import type { SessionState } from "../src/security/sessionPolicy";
import {
  createMemoryMembershipStore,
  createMembership,
  authorize,
  AUTHORIZATION_POLICY_VERSION,
} from "../src/security/authorization";
import {
  createMemoryDelegationStore,
  createDelegation,
  authorizeDelegatedAction,
} from "../src/security/delegation";
import {
  createMemoryAuditStore,
  recordAuditEvent,
  verifyChain,
} from "../src/security/iaaaAudit";
import {
  createApproval,
  validateApproval,
  revokePrincipal,
} from "../src/security/lifecycle";

/**
 * Issue #945, Slice 6 — lifecycle verification: the §8 acceptance
 * suite end-to-end through Slices 1–5 together.
 *
 * This is a pure-policy scenario, not live wiring: no route, API,
 * job, tool, session cookie, or production record is touched, and
 * nothing here claims live enforcement. It proves the slices compose
 * — identity binding, session policy, PDP authorization, bounded
 * delegation, approval validity, and audit attribution — and that
 * revocation mid-flow makes the same chain fail at the next check.
 * Spec §6: "Legitimate workflows still succeed (a system that
 * denies everything fails)".
 */

const NOW = 1_800_000_000_000;

describe("iaaa acceptance end to end (#945 slice 6)", () => {
  it("runs a legitimate chain through slices 1-5 with full audit attribution", async () => {
    // Slice 1: (issuer, subject) -> stable internal id.
    const bindings = createMemoryIdentityBindingStore();
    const binding = await resolveOrCreateBinding(bindings, {
      providerIssuer: "https://accounts.google.com",
      providerSubject: "subject-1",
      proofVerified: true,
      nowMs: NOW,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error("expected binding ok");
    const userId = binding.binding.internalUserId;
    // Same (issuer, subject) resolves to the same stable id.
    const again = await resolveOrCreateBinding(bindings, {
      providerIssuer: "https://accounts.google.com",
      providerSubject: "subject-1",
      proofVerified: true,
      nowMs: NOW,
    });
    expect(again.ok && again.binding.internalUserId).toBe(userId);

    // Slice 2: fresh, unexpired, unrevoked session is usable.
    const sessions = createMemoryRevocationStore();
    const session: SessionState = {
      sessionId: "session-1",
      internalUserId: userId,
      createdAtMs: NOW,
      lastActivityMs: NOW,
      authTimeMs: NOW,
    };
    await sessions.registerSession("session-1", userId);
    expect(
      (await sessionIsUsable(sessions, session, DEFAULT_SESSION_POLICY, NOW)).usable,
    ).toBe(true);

    // Slice 3: tenant membership + PDP allow for a tenant action.
    const memberships = createMemoryMembershipStore();
    const membership = await createMembership(memberships, {
      internalUserId: userId,
      tenantId: "tenant-a",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-admin-1" }],
      createdBy: "platform-admin-1",
      nowMs: NOW,
    });
    expect(membership.ok).toBe(true);
    const pdp = await authorize(memberships, {
      actorInternalUserId: userId,
      tenantId: "tenant-a",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(pdp.decision).toBe("allow");

    // Slice 4: bounded delegation used within scope.
    const delegations = createMemoryDelegationStore();
    const delegation = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: userId,
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: ["task:create"],
      resourceScope: [],
      expiresAtMs: NOW + 60_000,
      budget: { maxActions: 2 },
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(delegation.ok).toBe(true);
    if (!delegation.ok) throw new Error("expected delegation ok");
    const delegated = authorizeDelegatedAction(delegation.delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(delegated.decision).toBe("allow");

    // Slice 6 approval (the approval record the delegation's
    // approval flag stands in for): valid for the unchanged proposal.
    const approval = await createApproval({
      proposalHash: "hash-proposal-1",
      proposalVersion: "v1",
      approverInternalUserId: "approver-1",
      tenantId: "tenant-a",
      grantedActions: ["task:create"],
      expiresAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) throw new Error("expected approval ok");
    expect(
      validateApproval(approval.approval, {
        proposalHash: "hash-proposal-1",
        action: "task:create",
        tenantId: "tenant-a",
        nowMs: NOW,
      }).valid,
    ).toBe(true);

    // Slice 5: one audit event recording the whole chain.
    const audit = createMemoryAuditStore();
    const event = await recordAuditEvent(audit, {
      timestamp: NOW,
      type: "task:create",
      actorPrincipalId: "agent-1",
      actorType: "agent",
      initiatingPrincipalId: userId,
      tenantId: "tenant-a",
      taskId: "task-1",
      agentInstanceId: "agent-1",
      delegationId: delegation.delegation.id,
      correlationId: "corr-acceptance-1",
      action: "task:create",
      resourceId: "resource-1",
      decision: "allow",
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      approvalId: approval.approval.id,
      outcome: "succeeded",
    });
    expect(event.ok).toBe(true);
    if (!event.ok) throw new Error("expected audit ok");
    expect(event.event.initiatingPrincipalId).toBe(userId);
    expect(event.event.delegationId).toBe(delegation.delegation.id);
    expect(event.event.approvalId).toBe(approval.approval.id);
    expect(event.event.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
    expect(await verifyChain(await audit.list())).toBe(true);
  });

  it("fails the same chain at the next check after revocation mid-flow", async () => {
    const bindings = createMemoryIdentityBindingStore();
    const binding = await resolveOrCreateBinding(bindings, {
      providerIssuer: "https://accounts.google.com",
      providerSubject: "subject-1",
      proofVerified: true,
      nowMs: NOW,
    });
    if (!binding.ok) throw new Error("expected binding ok");
    const userId = binding.binding.internalUserId;

    const sessions = createMemoryRevocationStore();
    const session: SessionState = {
      sessionId: "session-1",
      internalUserId: userId,
      createdAtMs: NOW,
      lastActivityMs: NOW,
      authTimeMs: NOW,
    };
    await sessions.registerSession("session-1", userId);

    const memberships = createMemoryMembershipStore();
    const membership = await createMembership(memberships, {
      internalUserId: userId,
      tenantId: "tenant-a",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-admin-1" }],
      createdBy: "platform-admin-1",
      nowMs: NOW,
    });
    expect(membership.ok).toBe(true);

    const delegations = createMemoryDelegationStore();
    const delegation = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: userId,
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: ["task:create"],
      resourceScope: [],
      expiresAtMs: NOW + 60_000,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(delegation.ok).toBe(true);
    if (!delegation.ok) throw new Error("expected delegation ok");

    // Chain works before revocation...
    expect(
      (await sessionIsUsable(sessions, session, DEFAULT_SESSION_POLICY, NOW)).usable,
    ).toBe(true);
    expect(
      (await authorize(memberships, {
        actorInternalUserId: userId,
        tenantId: "tenant-a",
        permission: "task:create",
        nowMs: NOW,
      })).decision,
    ).toBe("allow");

    // ...revocation mid-flow (Slice 6)...
    const report = await revokePrincipal(
      { sessions, memberships, delegations },
      { internalUserId: userId, sessionIds: ["session-1"], nowMs: NOW },
    );
    expect(report.allRevoked).toBe(true);

    // ...and the same chain now fails at the next check, at every layer.
    const sessionAfter = await sessionIsUsable(sessions, session, DEFAULT_SESSION_POLICY, NOW);
    expect(sessionAfter.usable).toBe(false);
    expect(sessionAfter.reason).toBe("REVOKED");

    const pdpAfter = await authorize(memberships, {
      actorInternalUserId: userId,
      tenantId: "tenant-a",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(pdpAfter.decision).toBe("deny");
    expect(pdpAfter.reason).toBe("MEMBERSHIP_REVOKED");

    const stored = await delegations.get(delegation.delegation.id);
    if (!stored) throw new Error("expected delegation stored");
    expect(
      authorizeDelegatedAction(stored, {
        delegateAgentId: "agent-1",
        tenantId: "tenant-a",
        permission: "task:create",
        nowMs: NOW,
      }).decision,
    ).toBe("deny");

    // The denial itself is auditable: the chain's failure is recorded,
    // not silently dropped.
    const audit = createMemoryAuditStore();
    const denied = await recordAuditEvent(audit, {
      timestamp: NOW,
      type: "task:create",
      actorPrincipalId: "agent-1",
      actorType: "agent",
      initiatingPrincipalId: userId,
      tenantId: "tenant-a",
      taskId: "task-1",
      agentInstanceId: "agent-1",
      delegationId: delegation.delegation.id,
      correlationId: "corr-acceptance-2",
      action: "task:create",
      decision: "deny",
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      outcome: "failed",
      errorCode: "MEMBERSHIP_REVOKED",
    });
    expect(denied.ok).toBe(true);
    expect(await verifyChain(await audit.list())).toBe(true);
  });

  it("keeps tenant isolation in the end-to-end chain: tenant B gets nothing from tenant A", async () => {
    const memberships = createMemoryMembershipStore();
    const membership = await createMembership(memberships, {
      internalUserId: "user-a",
      tenantId: "tenant-a",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-admin-1" }],
      createdBy: "platform-admin-1",
      nowMs: NOW,
    });
    expect(membership.ok).toBe(true);
    const cross = await authorize(memberships, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-b",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(cross.decision).toBe("deny");
    expect(cross.reason).toBe("CROSS_TENANT");
  });
});
