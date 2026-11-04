/**
 * Issue #2183 (proposal slice) + issue #3156 (Q7 enforcement
 * wiring, #945).
 *
 * Money paths call checkAuditGate BEFORE a consequential action.
 * Enforcement is ON: the owner directive of 2026-11-04 (#3156)
 * retired audit-only mode and settled the open CISO+CDO
 * fail-direction question — fail-CLOSED, including when the
 * policy store is unreachable. The stored enforcement-mode
 * setting is retained for compatibility but no longer disables
 * enforcement: checkAuditGate forces enforcing mode regardless
 * of what the store says. A future cleanup may remove the
 * setting; this slice does not (the pure evaluator, the seed,
 * and resolveAuditPolicy keep their #2183 semantics, and their
 * tests stay green).
 *
 * Fail direction, decided: a missing adapter (AGENT_DB unbound)
 * or a policy-load failure BLOCKS the action, except for the
 * seeded non-blocking reads (audit.read, payment.read), which
 * never block. Accepted cost, stated plainly: a D1 policy-store
 * outage blocks money execution even when the mas_events audit
 * write itself would succeed — the gate cannot establish policy
 * or chain evidence, so it denies rather than guess. The
 * tamper-response runbook covers the operator response (restore
 * the store; never bypass the gate).
 *
 * This module imports port types only — never a store client,
 * never drizzle-orm (structural test pin).
 */
import {
  AUDIT_POLICY_NON_BLOCKING_ACTIONS,
  evaluateAuditGate,
  resolveAuditPolicy,
  type AuditChainEntryInput,
  type AuditGateDecision,
  type AuditPolicyPort,
} from "../data/auditPolicyPorts";

/**
 * Fail-closed fallback for an unreachable policy store. Seeded
 * non-blocking reads stay allowed (a read that cannot consult
 * policy is not a consequential action); every other action
 * blocks, regardless of whether the caller's own audit write
 * succeeded — without the store, the gate cannot verify policy
 * or chain evidence, so it denies.
 */
function failClosedFallback(action: string): AuditGateDecision {
  if ((AUDIT_POLICY_NON_BLOCKING_ACTIONS as readonly string[]).includes(action)) {
    console.error(
      `[audit-gate] fail-closed fallback allows non-blocking action ${action} despite an unreachable store.`,
    );
    return {
      action,
      mode: "enforcing",
      blockOnAuditFailure: false,
      blocked: false,
      wouldBlock: false,
      allowed: true,
    };
  }
  console.error(`[audit-gate] fail-closed fallback BLOCKS action ${action}: store unreachable.`);
  return {
    action,
    mode: "enforcing",
    blockOnAuditFailure: true,
    blocked: true,
    wouldBlock: false,
    allowed: false,
  };
}

/**
 * Evaluate one consequential action against the operator policy.
 * `auditWriteSucceeded` is the caller's report of whether the
 * durable audit write for this action succeeded. Enforcement is
 * forced on (owner directive 2026-11-04, #3156): the resolved
 * policy's mode is overridden to enforcing before evaluation,
 * and an unreachable store blocks via the fail-closed fallback.
 * Returns the decision; the caller blocks only when
 * decision.blocked is true.
 */
export async function checkAuditGate(
  setup: () => Promise<AuditPolicyPort | null>,
  action: string,
  auditWriteSucceeded: boolean,
): Promise<AuditGateDecision> {
  let port: AuditPolicyPort | null;
  try {
    port = await setup();
  } catch (err) {
    console.error(
      `[audit-gate] policy store setup failed for action ${action} — fail-closed fallback:`,
      err instanceof Error ? err.message : String(err),
    );
    return failClosedFallback(action);
  }
  if (!port) {
    console.error(
      `[audit-gate] no audit-policy adapter (AGENT_DB unbound) for action ${action} — fail-closed fallback.`,
    );
    return failClosedFallback(action);
  }
  try {
    const policy = await resolveAuditPolicy(port);
    // #3156: audit-only mode is OFF — enforce regardless of the stored setting.
    const decision = evaluateAuditGate({ ...policy, mode: "enforcing" }, action, auditWriteSucceeded);
    if (decision.blocked) {
      console.error(
        `[audit-gate] BLOCKED action ${action}: audit write failed for a blocking action under enforcement.`,
      );
    }
    return decision;
  } catch (err) {
    console.error(
      `[audit-gate] policy load failed for action ${action} — fail-closed fallback:`,
      err instanceof Error ? err.message : String(err),
    );
    return failClosedFallback(action);
  }
}

/**
 * Best-effort chain append, mirroring the journal projection
 * direction: a chain-write failure is loudly logged and never
 * fails the underlying action. The DO mas_events row remains
 * the audit record; this link is its tamper evidence.
 */
export async function appendAuditChainBestEffort(
  setup: () => Promise<AuditPolicyPort | null>,
  input: AuditChainEntryInput,
): Promise<void> {
  try {
    const port = await setup();
    if (!port) {
      console.error("[audit-gate] chain append skipped (AGENT_DB unbound); audit row unaffected.");
      return;
    }
    await port.appendChainEntry(input);
  } catch (err) {
    console.error(
      "[audit-gate] chain append failed — audit row unaffected:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
