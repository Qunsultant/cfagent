/**
 * #1735 (parent #1717, slice (o)): PAYMENTS RE-SCOPE — the port for
 * the ONE payments-flow switch, PAYMENTS_FLOW_MODE (#1711).
 *
 * #1711 established the switch as a SINGLE GLOBAL Worker-env value:
 * "hitl" | "immediate", case-insensitive, blank/unset → "hitl",
 * unrecognized → "hitl" FAIL-CLOSED with a payment.config_error
 * audit. This slice re-scopes its RESOLUTION, in this order:
 *   run > session > user > global env > built-in (hitl)
 * per the owner-confirmed 2026-10-26 reading of run/session/user
 * scope as the execution context. Neither flow changes: HITL is
 * still the #1690 draft/confirm flow (no checkout at create) and
 * immediate is still the pre-#1690 route behavior recovered verbatim
 * by #1711. The global env value STAYS as the global fallback, and
 * HITL stays the built-in default. This slice sets NO production
 * value — production values are an owner action; unset = HITL.
 *
 * Pure module: no Cloudflare imports, no I/O, no network — the port
 * is the resolver, and the payments route consumes it (port-first,
 * cfagent blueprint #1795/#1798 restated wording: cloud-native but
 * cloud-agnostic). The resolver is a pure function of its levels:
 * no module state, so two runs resolving different modes can never
 * confuse each other through shared mutable state.
 *
 * Carriers: run = the per-run value on the route context
 * (PaymentsRouteContext.paymentsFlowModeRun, set by the execution
 * owner for that run); session / user = the optional
 * scopedPaymentsFlowModes carrier on the route context (populated
 * by the execution-context owner); global env = the Worker env var.
 * A blank/unset level falls through to the next level. The FIRST
 * non-blank level wins; if that value is unrecognized, the
 * resolution FAILS CLOSED to hitl (invalid=true, level = the
 * winning level) and does NOT fall through to a lower level.
 * Callers must log + audit payment.config_error on invalid.
 *
 * SECURITY — why run is NOT request input (the #1735 guard): the
 * flow switch governs which money-flow variant an execution uses,
 * and the HITL confirm gate applies inside the hitl flow. A
 * request-supplied run value (body/query `flowMode`) would let a
 * caller flip their own execution to immediate and bypass the
 * confirm gate — a caller disabling their own enforcement, which
 * the standing guard forbids. The #1728 presentation switches CAN
 * take run from the per-request `mode` field because they govern
 * presentation/validation contracts only, never enforcement; the
 * flow switch cannot, so its run carrier is execution-owner-set
 * only and request input is ignored (pinned in
 * tests/payments_flow_mode_scoped_1735.test.ts). The same guard
 * applies to the session/user carriers: they are populated by the
 * execution-context owner, never by the request caller.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user/run carriers are honored in
 * resolution order and unit-pinned, but in production today only
 * global env is settable — the same boundary as #1721/#1722/#1723/
 * #1724/#1727/#1728, whose route-ctx carriers are populated by no
 * production caller yet. An admin-owned persisted settings surface
 * is a follow-up, not smuggled in via a store whose keys any caller
 * can write.
 *
 * One deliberate tightening vs the legacy env-only resolver
 * (resolvePaymentsFlowMode in src/agents/routes/payments.ts, kept
 * unchanged): a NON-STRING value (possible only in tests — Worker
 * env vars are strings) was silently treated as unset by the legacy
 * resolver (hitl, not invalid, no audit). The scoped resolver
 * treats a non-string non-null value as INVALID (fail-closed hitl,
 * audited), matching the #1726/#1727/#1728 program resolvers: a
 * misconfiguration should be visible in the audit ledger, not
 * silent. String semantics are byte-identical to #1711.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/paymentsFlowModes",
});

export type PaymentsFlowMode = "hitl" | "immediate";

/** One switch value, as carried at session/user level. */
export interface PaymentsFlowModeValues {
  flow?: unknown;
}

/** Session/user carriers for the payments-flow switch. */
export interface PaymentsFlowScopedModes {
  session?: PaymentsFlowModeValues;
  user?: PaymentsFlowModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface PaymentsFlowModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedPaymentsFlowModeScoped {
  mode: PaymentsFlowMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const PAYMENTS_FLOW_MODE_SWITCH = "PAYMENTS_FLOW_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function paymentsFlowConfigErrorEvent(): string {
  return "payment.config_error";
}

function normalizeFlowValue(raw: unknown): PaymentsFlowMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "hitl" || normalized === "immediate") return normalized;
  return "invalid";
}

/**
 * Resolves PAYMENTS_FLOW_MODE over run > session > user > env >
 * builtin (hitl). First non-blank level wins; an unrecognized
 * winning value fails closed to hitl with invalid=true and no
 * fall-through to lower levels.
 */
export function resolvePaymentsFlowModeScoped(
  levels: PaymentsFlowModeScopeLevels
): ResolvedPaymentsFlowModeScoped {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeFlowValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(paymentsFlowConfigErrorEvent(), {
        message: `[${paymentsFlowConfigErrorEvent()}] ${PAYMENTS_FLOW_MODE_SWITCH} unrecognized value at ${level}; failing closed to "hitl"`,
        switch: PAYMENTS_FLOW_MODE_SWITCH,
        level,
        raw: typeof value === "string" ? value : undefined,
      });
      return {
        mode: "hitl",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return {
      mode: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      level,
    };
  }
  return { mode: "hitl", invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + run + env. */
export function levelsForPaymentsFlowMode(
  scoped: PaymentsFlowScopedModes | undefined,
  run: unknown,
  envValue: unknown
): PaymentsFlowModeScopeLevels {
  return { run, session: scoped?.session?.flow, user: scoped?.user?.flow, env: envValue };
}
