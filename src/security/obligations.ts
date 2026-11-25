/**
 * #1751 (parent #1717, IAAA-3): obligation/advice channel.
 *
 * Before this slice, authz.md §10 recorded obligations/advice as
 * partial equivalents only: audit-on-decision was a record, not a
 * condition, and step-up was enforced ad hoc at each gate, not
 * declared as an obligation attached to a policy. The PDP returned
 * allow/deny and everything else was the caller's job.
 *
 * This module is the channel. It has two halves, kept deliberately
 * separate the way XACML separates them:
 *
 * - POLICY: the frozen OBLIGATION_POLICY table. Obligations and
 *   advice attach to a PERMISSION, not to a gate call site, so every
 *   PEP that evaluates through this module enforces the same
 *   obligations for the same permission. A permission with no table
 *   entry behaves exactly as the PDP alone decides — the channel
 *   adds enforcement, it never re-decides policy.
 * - PEP ENFORCEMENT: evaluateWithObligations() wraps the PDP seam
 *   (checkPermission, iaaaPdpSeam.ts). On a PDP deny it returns the
 *   deny unchanged (with the PDP's reason) plus the policy's
 *   advice. On a PDP allow it enforces each declared obligation, in
 *   table order, BEFORE returning allow; any failure turns the
 *   decision into a deny with reason OBLIGATION_FAILED. Advice is
 *   delivered with allow and deny alike and never changes a
 *   decision — it is information, not enforcement.
 *
 * The two obligation kinds in v1 (the issue's acceptance minimum):
 * - "step-up": fresh authentication, via the real requiresStepUp
 *   rule (sessionPolicy.ts): authTimeMs must be finite, not in the
 *   future, and younger than the platform step-up freshness
 *   default. The window is DEFAULT_STEP_UP_FRESHNESS_MS (15
 *   minutes), settled as a CISO value by #1757 (values unchanged),
 *   exactly as #1750 reused the enforced defaults.
 * - "audit-before-allow": the injected audit writer must record
 *   the allow decision before allow is returned. This is audit as
 *   a CONDITION, not audit-on-decision: a missing writer, a false
 *   return, or a throwing writer all deny. The writer is injected
 *   (an interface, not a store): this module performs no I/O and
 *   uses no Cloudflare infrastructure, so no adapter is defined
 *   for it — the caller supplies whatever audit sink its surface
 *   already uses (the hash-chained iaaaAuditStore, or a test
 *   recorder). CAIO coordination: no CAIO-lane obligation port
 *   exists to consume or link; nothing is duplicated here.
 *
 * Fail-closed rules (the program's security guard, applied here):
 * - A missing authTimeMs, a future authTimeMs, or a non-finite one
 *   fails the step-up obligation. The obligation is never skipped
 *   for lack of context.
 * - A missing audit writer fails the audit obligation. The allow
 *   is never returned unaudited.
 * - An audit writer that returns false or throws fails the
 *   obligation. Channel unavailability denies; it never fails
 *   open to allow.
 * - An unknown obligation kind (defensive branch — unreachable
 *   from the frozen, typed table) denies rather than being
 *   ignored. Ambiguity fails closed.
 * - Obligations short-circuit in table order: a failed step-up
 *   never triggers an audit record for an action that will not
 *   happen.
 *
 * What this table deliberately is NOT:
 * - Not configuration. No env var, session value, run value, or
 *   user value can widen, narrow, or disable an obligation — there
 *   is no lookup of any kind in this module, on purpose. A
 *   caller-configurable obligation would let a caller disable
 *   their own enforcement, which the program's security guard
 *   forbids. The table is frozen at module load for the same
 *   reason. (Pin justification, NEVER EITHER/OR exception: there
 *   is no divergent pair here to keep — the ad-hoc gates this
 *   channel replaces were never a second contract, and keeping
 *   them as a switchable alternative would preserve exactly the
 *   ad-hoc enforcement the issue retires. The old gates are NOT
 *   deleted by this slice; they stay in place until CTO-lane #945
 *   route wiring adopts this evaluator route by route, and that
 *   migration is a named residual in authz.md §10, not a silent
 *   coexistence.)
 * - Not live route wiring. Like authorization.ts before it, this
 *   module is the PEP-side enforcement function, proved here
 *   against the real PDP seam; routes keep their current gates
 *   until the #945 wiring step adopts it (each adopting route
 *   must supply its session's authTimeMs and its audit sink).
 *   Changing live gates inside this slice — e.g. making
 *   integration:connect deny whenever its route lacks an audit
 *   writer — would be a behavior change with no route owner
 *   review, and is refused here on purpose.
 * - Not scope-qualified (v1). Obligations attach to the permission
 *   regardless of scope; scope-qualified entries are a future
 *   extension, not invented here.
 */

import {
  type AuthorizationDecision,
  type MembershipStore,
  type Permission,
} from "./authorization";
import { checkPermission, type CheckPermissionInput } from "./iaaaPdpSeam";
import { recordBlockingAuditAsync, type AsyncBlockingAuditEvents } from "./auditChain";
import {
  DEFAULT_SESSION_POLICY,
  DEFAULT_STEP_UP_FRESHNESS_MS,
  requiresStepUp,
} from "./sessionPolicy";

/** Obligation kinds the channel can enforce. */
export type ObligationKind = "step-up" | "audit-before-allow";

/** Advice kinds the channel can deliver. Advice never alters a decision. */
export type AdviceKind = "audit-notice";

/** One informational advice entry, declared on policy. */
export interface Advice {
  kind: AdviceKind;
  message: string;
}

/** One policy entry: the obligations and advice attached to a permission. */
export interface ObligationPolicyEntry {
  permission: Permission;
  obligations: readonly ObligationKind[];
  advice: readonly Advice[];
}

const auditNotice = (permission: Permission): Advice =>
  Object.freeze({
    kind: "audit-notice" as const,
    message:
      `A ${permission} decision is audited before it takes effect; ` +
      `an allow is returned only after the audit record succeeds.`,
  });

const roleAssign: ObligationPolicyEntry = Object.freeze({
  permission: "role:assign" as const,
  obligations: Object.freeze(["step-up", "audit-before-allow"] as const),
  advice: Object.freeze([auditNotice("role:assign")]),
});

const membershipRevoke: ObligationPolicyEntry = Object.freeze({
  permission: "membership:revoke" as const,
  obligations: Object.freeze(["audit-before-allow"] as const),
  advice: Object.freeze([auditNotice("membership:revoke")]),
});

const auditExport: ObligationPolicyEntry = Object.freeze({
  permission: "audit:export" as const,
  obligations: Object.freeze(["audit-before-allow"] as const),
  advice: Object.freeze([auditNotice("audit:export")]),
});

/**
 * The obligation policy. Frozen, and the ONLY source of
 * permission-to-obligation mapping: no caller input selects, adds,
 * or removes an entry at evaluation time.
 */
export const OBLIGATION_POLICY: readonly ObligationPolicyEntry[] =
  Object.freeze([roleAssign, membershipRevoke, auditExport]);

/** Lookup by permission; same frozen objects as OBLIGATION_POLICY. */
export const OBLIGATION_POLICY_BY_PERMISSION: Readonly<
  Partial<Record<Permission, ObligationPolicyEntry>>
> = Object.freeze({
  "role:assign": roleAssign,
  "membership:revoke": membershipRevoke,
  "audit:export": auditExport,
});

/** Declared obligations for a permission; [] when the policy has no entry. */
export function obligationsFor(permission: Permission): readonly ObligationKind[] {
  return OBLIGATION_POLICY_BY_PERMISSION[permission]?.obligations ?? [];
}

/** Declared advice for a permission; [] when the policy has no entry. */
export function adviceFor(permission: Permission): readonly Advice[] {
  return OBLIGATION_POLICY_BY_PERMISSION[permission]?.advice ?? [];
}

/**
 * The audit event an audit-before-allow writer must record. The
 * writer returns true when the record succeeded; false, or a throw,
 * means the decision was NOT audited and the allow must not stand.
 */
export interface ObligationAuditEvent {
  permission: Permission;
  principalId: string;
  tenantId: string;
  decision: "allow";
  nowMs: number;
}

/** Injected audit sink for audit-before-allow. Injected, never constructed here. */
export type ObligationAuditWriter = (
  event: ObligationAuditEvent,
) => Promise<boolean>;

/**
 * Issue #2178 (Q7 S2) — guard family: adapt a chained mas_events
 * repo into an ObligationAuditWriter. The repo is still injected;
 * this only adapts it. A successful chained write returns true
 * (obligation satisfied); a throwing store propagates untouched —
 * auditSatisfied fails closed on throw, so an unaudited allow is
 * impossible. The obligation event carries no session, so the
 * row's sessionId is the acting principal (payload carries the
 * full decision fields). Boundary: today's worker-level
 * enforcement points (the server.ts IAAA routes) have no ORM /
 * mas_events write path, so they keep the IAAA DO-log writer
 * until a worker→DO audit RPC exists; this factory is the sink
 * agent-side enforcement points use.
 * #6102: the repo is the async D1 port now.
 */
export function createChainedAuditWriter(
  events: AsyncBlockingAuditEvents,
): ObligationAuditWriter {
  return async (event) => {
    await recordBlockingAuditAsync(events, {
      id: crypto.randomUUID(),
      sessionId: event.principalId,
      type: "iaaa.guard_decision",
      agent: "orchestrator",
      payload: {
        permission: event.permission,
        principalId: event.principalId,
        tenantId: event.tenantId,
        decision: event.decision,
      },
      createdAt: new Date(event.nowMs).toISOString(),
    });
    return true;
  };
}

/** Caller-supplied evaluation context. The PEP supplies it; the subject never does. */
export interface ObligationEvaluationContext {
  /**
   * Milliseconds of the caller's last authentication, for the
   * step-up obligation. Absent for permissions without a step-up
   * obligation; REQUIRED (and fail-closed when missing) for
   * permissions that carry one.
   */
  authTimeMs?: number;
  /**
   * Audit sink for the audit-before-allow obligation. Absent for
   * permissions without one; REQUIRED (and fail-closed when
   * missing) for permissions that carry one.
   */
  audit?: ObligationAuditWriter;
}

/** One obligation's enforcement outcome. */
export interface ObligationResult {
  kind: ObligationKind;
  satisfied: boolean;
  detail: string;
}

/** A PDP decision with its obligations enforced and its advice attached. */
export interface DecisionWithObligations {
  decision: "allow" | "deny";
  reason: AuthorizationDecision["reason"] | "OBLIGATION_FAILED";
  principalId: string;
  tenantId?: string;
  permission: string;
  policyVersion: string;
  /** Evaluated obligations, in table order; [] when the PDP denied or no entry exists. */
  obligations: readonly ObligationResult[];
  /** Policy-declared advice; delivered with allow and deny alike. */
  advice: readonly Advice[];
}

export type EvaluateWithObligationsInput = Omit<
  CheckPermissionInput,
  "scope" | "resourceScope"
> & {
  scope?: CheckPermissionInput["scope"];
  resourceScope?: CheckPermissionInput["resourceScope"];
} & ObligationEvaluationContext;

function stepUpSatisfied(authTimeMs: number | undefined, nowMs: number): boolean {
  // Reuse the real rule: requiresStepUp is true when step-up IS
  // required (stale, missing, non-finite, or future auth time).
  // A synthesized SessionState carries only what the rule reads.
  const required = requiresStepUp(
    {
      sessionId: "",
      internalUserId: "",
      createdAtMs: nowMs,
      lastActivityMs: nowMs,
      authTimeMs: authTimeMs ?? Number.NaN,
    },
    DEFAULT_SESSION_POLICY,
    nowMs,
  );
  return !required;
}

async function auditSatisfied(
  audit: ObligationAuditWriter | undefined,
  event: ObligationAuditEvent,
): Promise<{ satisfied: boolean; detail: string }> {
  if (!audit) {
    return {
      satisfied: false,
      detail: "no audit writer supplied; allow withheld (fail closed)",
    };
  }
  let recorded: boolean;
  try {
    recorded = await audit(event);
  } catch {
    return {
      satisfied: false,
      detail: "audit writer threw; allow withheld (fail closed)",
    };
  }
  return recorded
    ? { satisfied: true, detail: "audit record succeeded before allow" }
    : {
        satisfied: false,
        detail: "audit writer reported failure; allow withheld (fail closed)",
      };
}

/**
 * PEP-side enforcement: the PDP decision, with policy obligations
 * enforced and policy advice attached.
 *
 * - PDP deny: returned unchanged (PDP reason preserved), no
 *   obligation evaluated, policy advice attached.
 * - PDP allow, no policy entry: returned unchanged, no obligations,
 *   no advice — identical to the PDP alone.
 * - PDP allow, policy entry: each declared obligation is enforced
 *   in table order, short-circuiting on the first failure; any
 *   failure denies with reason OBLIGATION_FAILED. Only when every
 *   obligation is satisfied is allow returned — for
 *   audit-before-allow, after the audit record succeeds.
 */
export async function evaluateWithObligations(
  store: MembershipStore,
  input: EvaluateWithObligationsInput,
): Promise<DecisionWithObligations> {
  const pdp = await checkPermission(store, {
    internalUserId: input.internalUserId,
    tenantId: input.tenantId,
    permission: input.permission,
    scope: input.scope,
    resourceScope: input.resourceScope,
    nowMs: input.nowMs,
  });
  const advice = adviceFor(input.permission);
  const base = {
    principalId: pdp.principalId,
    tenantId: pdp.tenantId,
    permission: pdp.permission,
    policyVersion: pdp.policyVersion,
    advice,
  };
  if (pdp.decision === "deny") {
    return { ...base, decision: "deny", reason: pdp.reason, obligations: [] };
  }
  const entry = OBLIGATION_POLICY_BY_PERMISSION[input.permission];
  if (!entry) {
    return { ...base, decision: "allow", reason: pdp.reason, obligations: [] };
  }
  const results: ObligationResult[] = [];
  for (const kind of entry.obligations) {
    if (kind === "step-up") {
      const satisfied = stepUpSatisfied(input.authTimeMs, input.nowMs);
      results.push({
        kind,
        satisfied,
        detail: satisfied
          ? `authentication fresh within ${DEFAULT_STEP_UP_FRESHNESS_MS} ms`
          : "authentication stale or missing; step-up required (fail closed)",
      });
    } else if (kind === "audit-before-allow") {
      const outcome = await auditSatisfied(input.audit, {
        permission: input.permission,
        principalId: pdp.principalId,
        tenantId: input.tenantId,
        decision: "allow",
        nowMs: input.nowMs,
      });
      results.push({ kind, ...outcome });
    } else {
      // Defensive fail-closed: an unknown obligation kind is never
      // ignored, skipped, or treated as satisfied. Unreachable from
      // the frozen typed table; kept so a future table edit that
      // introduces a kind without an enforcer denies loudly.
      const unknown: never = kind;
      results.push({
        kind: unknown,
        satisfied: false,
        detail: "unknown obligation kind; allow withheld (fail closed)",
      });
    }
    if (!results[results.length - 1].satisfied) {
      return {
        ...base,
        decision: "deny",
        reason: "OBLIGATION_FAILED",
        obligations: Object.freeze(results),
      };
    }
  }
  return {
    ...base,
    decision: "allow",
    reason: pdp.reason,
    obligations: Object.freeze(results),
  };
}
