/**
 * #1733 (parent #1717, slice (m)): REST↔REST twins unification —
 * scan appendix (m) findings R01, R02, R04, R06. Pure module: no
 * Cloudflare imports, no I/O, no network — the port is the resolver,
 * and the routes consume it (port-first, cfagent blueprint #1795/#1798
 * restated wording: cloud-native but cloud-agnostic).
 *
 * The ONE switch this slice adds (R04 audit writes):
 *   AUDIT_WRITE_MODE  "legacy" | "strict"
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (legacy).
 * Carriers: run = the per-request `mode` field (POST body `mode`
 * or query `?mode=`); session / user = the optional
 * `scopedAuditModes` carrier on the route context (populated by
 * the execution-context owner); global env = the Worker env var.
 * A blank/unset level falls through to the next level. The FIRST
 * non-blank level wins; if that value is unrecognized, the
 * resolution FAILS CLOSED to legacy (invalid=true, level = the
 * winning level) and does NOT fall through to a lower level.
 * Callers must log + audit `audit.config_error` on invalid.
 *
 * Per-mode behavior (both paths preserved as branches, never
 * deleted; no endpoint removed):
 * - legacy (built-in default = each spelling's current contract):
 *   POST /audit stays unvalidated (defaults type=
 *   autopilot.policy_check, agent=trading, payload = body.payload
 *   or the whole body, 200 {success, message}); POST /audit/event
 *   stays strict (201 stored record).
 * - strict: POST /audit ALSO applies the /audit/event validation
 *   (non-empty type ≤120 chars, agent trimmed to ≤64, payload
 *   ≤64 KB serialized) while keeping its own defaults
 *   (type=autopilot.policy_check, agent=trading) and its 200
 *   shape; its payload follows /audit/event (the payload field
 *   only, {} when absent) rather than the legacy whole-body
 *   fallback — a named tightening, not a silent change.
 *   POST /audit/event is strict in EVERY mode: the switch can
 *   only tighten /audit, never un-validate a previously validated
 *   path, and there is no "lenient" value (Security Guard: a
 *   configurable rule never lets a caller disable their own
 *   enforcement — attributable-audit validation is enforcement,
 *   and it is not opt-out here).
 *
 * What this slice DELIBERATELY does not switch (pins with
 * justification, per the #1729–#1732 divergent-by-design rule):
 * - R01 Alpaca twins: already unified by #1727's three-way
 *   FOSS_ALPACA_READS_MODE / FOSS_ALPACA_ORDER_MODE. #1733
 *   exercises #1727's reserved freedom by LEAVING the /trading
 *   defaults alone (order=trading, reads=none): no owner decision
 *   exists to change a production order/audit contract, and
 *   changing the /trading order default to foss would silently
 *   change order normalization (uppercasing, aliases) and the
 *   audit payload for existing /trading callers, while reads
 *   none→rest would start emitting audits for previously silent
 *   reads. The owner overturns either default with one env var.
 *   /foss/snapshot keeps no /trading twin (asymmetry, not a
 *   divergence: a new /trading/snapshot endpoint is new surface,
 *   out of this slice's scope).
 * - R02 quote twins (REST↔REST leg): provider/cache semantics
 *   belong to (e) #1725 (QUOTE_* modes) and (g) #1726/#1727
 *   (ETRADE_* / FOSS_* quote modes). The (m) leg —
 *   /etrade/quote's x-user-login gate, TEST/PROD env selection,
 *   and no-cache headers vs /foss/quote's none — is inherent to
 *   the broker's per-user OAuth and live-quote freshness: gating
 *   /foss would break public consumers, and ungating /etrade
 *   would be an enforcement regression. The batch pair
 *   /api/market/quotes = /api/foss/quotes (and the /ws spellings)
 *   are literally one branch each — IDENTICAL, not switched.
 * - R03 / R05 / M10: IDENTICAL aliases / UNIFIED reads — pinned
 *   by the existing extraction tests, not rebuilt here.
 * - Screen vs unified (follow-up diff): /screen runs the
 *   filter-shaped DynamicOptionsScreener path, /unified runs
 *   action-dispatched UnifiedOptionsService.execute, /recommend
 *   is the single-owner handler, /compare runs the panel
 *   pipeline, /catalog lists the registry — different contracts
 *   by design, no switch. Correction to the scan: only /unified
 *   goes through UnifiedOptionsService.execute; /screen does not.
 *
 * R06 transaction-snap identity (resolveSnapIdentity): the Worker
 * fallback chain (header OR tx.symbol OR "browser_trader") moves
 * here with NO behavior change. The literal SURVIVES, and only as
 * a defensive default: the Worker path requires a valid app
 * session first (requireAuth → 401) and rejects a missing
 * tx.symbol with 400 BEFORE the chain runs, so on the reachable
 * path the identity is always the header or tx.symbol. The DO
 * route has no fallback (one shared block).
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in
 * resolution order and unit-pinned, but in production today only
 * run (per-request `mode`) and global env are settable — the same
 * boundary as #1721–#1727. The route ctx carrier is populated by
 * no production caller yet.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/restTwinsModes",
});

export type AuditWriteMode = "legacy" | "strict";

/** One switch's value, as carried at session/user level. */
export interface AuditWriteModeValues {
  auditWrite?: unknown;
}

/** Session/user carriers for the audit-write switch. */
export interface RestTwinsScopedModes {
  session?: AuditWriteModeValues;
  user?: AuditWriteModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface AuditWriteModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedAuditWriteSwitch {
  mode: AuditWriteMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const AUDIT_WRITE_MODE_SWITCH = "AUDIT_WRITE_MODE" as const;

/** Audit event emitted when the switch value fails closed. */
export function auditConfigErrorEvent(): string {
  return "audit.config_error";
}

function normalizeSwitchValue(raw: unknown, valid: string[]): string | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (valid.includes(normalized)) return normalized;
  return "invalid";
}

export function resolveAuditWriteMode(
  levels: AuditWriteModeScopeLevels,
  legacy: AuditWriteMode
): ResolvedAuditWriteSwitch {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value, ["legacy", "strict"]);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(auditConfigErrorEvent(), {
        message: `[${auditConfigErrorEvent()}] ${AUDIT_WRITE_MODE_SWITCH} unrecognized value at ${level}; failing closed to legacy`,
        switch: AUDIT_WRITE_MODE_SWITCH,
        level,
        raw: typeof value === "string" ? value : undefined,
      });
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized as AuditWriteMode, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for the audit-write switch from the scoped carrier + run + env. */
export function levelsForAuditWriteMode(
  scoped: RestTwinsScopedModes | undefined,
  run: unknown,
  envValue: unknown
): AuditWriteModeScopeLevels {
  return { run, session: scoped?.session?.auditWrite, user: scoped?.user?.auditWrite, env: envValue };
}

/**
 * #1733 REST-surface convenience: resolve the audit-write switch
 * for a route host (run > session > user > global env > legacy)
 * and audit audit.config_error on an invalid winning value
 * (fail-closed). The host is structural ({ scopedAuditModes, env,
 * audit }) so the dispatcher stays thin: one import, one call per
 * route. The config-error audit agent is "orchestrator" (the audit
 * family), matching /audit/event's default agent.
 */
export interface AuditWriteRestSwitchHost {
  scopedAuditModes?: RestTwinsScopedModes;
  env: unknown;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
}

export function resolveAuditWriteRestSwitch(
  host: AuditWriteRestSwitchHost,
  run: unknown,
  legacy: AuditWriteMode
): AuditWriteMode {
  const resolved = resolveAuditWriteMode(
    levelsForAuditWriteMode(host.scopedAuditModes, run, (host.env as Record<string, unknown> | null)?.[AUDIT_WRITE_MODE_SWITCH]),
    legacy
  );
  if (resolved.invalid) {
    host.audit(auditConfigErrorEvent(), "orchestrator", {
      switch: AUDIT_WRITE_MODE_SWITCH,
      raw: resolved.raw,
      level: resolved.level,
      failedClosedTo: resolved.mode,
    });
  }
  return resolved.mode;
}

/* ================= Strict validation (shared) =================
 * The /audit/event validation, factored so POST /audit in strict
 * mode applies byte-identical rules (same messages, same bounds).
 * The caller supplies the default agent: "orchestrator" for
 * /audit/event, "trading" for /audit (whose type default,
 * autopilot.policy_check, is pre-applied by the /audit handler —
 * /audit/event has no type default and a missing type is a 400).
 */

export interface StrictAuditWriteBody {
  type?: unknown;
  agent?: unknown;
  payload?: unknown;
}

export type StrictAuditWriteResult =
  | {
      ok: true;
      value: { type: string; agent: string; payload: Record<string, unknown> };
    }
  | { ok: false; error: string };

export function validateStrictAuditWrite(
  body: StrictAuditWriteBody | null | undefined,
  defaultAgent: string
): StrictAuditWriteResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A JSON object body is required" };
  }
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!type) {
    return { ok: false, error: "type (non-empty string) is required" };
  }
  if (type.length > 120) {
    return { ok: false, error: "type must be at most 120 characters" };
  }
  const agent =
    typeof body.agent === "string" && body.agent.trim()
      ? body.agent.trim().slice(0, 64)
      : defaultAgent;
  const payload =
    body.payload && typeof body.payload === "object"
      ? (body.payload as Record<string, unknown>)
      : {};
  const serialized = JSON.stringify(payload);
  if (serialized.length > 65536) {
    return { ok: false, error: "payload must serialize to at most 64 KB" };
  }
  return { ok: true, value: { type, agent, payload: JSON.parse(serialized) as Record<string, unknown> } };
}

/* ================= Transaction-snap identity (R06) =================
 * The Worker fallback chain, verbatim (falsy chain, not ?? — an
 * empty header falls through exactly as the inline code did).
 * Session conditions (enforced by the caller, src/server.ts, NOT
 * by this helper): a valid app session first (requireAuth → 401),
 * then a 400 when tx.symbol is missing — so the literal is a
 * defensive default only, unreachable on the reachable path.
 */
export function resolveSnapIdentity(
  headerLogin: string | null | undefined,
  txSymbol: string | null | undefined
): string {
  return headerLogin || txSymbol || "browser_trader";
}
