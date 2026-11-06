/**
 * #1728 (parent #1717, slice (h)): ONE runtime config switch per
 * divergent agentic-payments + premium-gating MCP-vs-REST pair — the
 * PAYMENTS_FLOW_MODE (#1711) / ETRADE_* (#1726) / MARKET_DATA_* (#1727)
 * pattern applied to this domain. Pure module: no Cloudflare
 * imports, no I/O, no network — the port is the resolver, and both
 * surfaces consume it (port-first, cfagent blueprint #1795).
 *
 * Switches (Worker env vars, non-secret, owner-set; this slice sets NO
 * production value — production values are an owner action):
 *   PAYMENTS_CREATE_MODE        "mcp" | "rest"   (P-1 draft_payment)
 *   PAYMENTS_CONFIRM_MODE       "mcp" | "rest"   (P-2 confirm_payment_draft)
 *   PAYMENTS_TRANSACTIONS_MODE  "mcp" | "rest"   (P-3 get_transactions)
 *   AGENTIC_WALLET_MODE         "mcp" | "rest"   (P-5 agentic_wallet_status)
 *   PREMIUM_SCREENER_MODE       "mcp" | "rest"   (P-6a paid_options_screener)
 *   PREMIUM_RESEARCH_MODE       "mcp" | "rest"   (P-6b paid_market_research)
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * Carriers: run = the per-request / per-call `mode` field (REST body
 * `mode`, REST query `?mode=`, MCP input `mode`); session / user =
 * the optional `scopedPaymentsModes` carrier on the execution context
 * (McpToolContext.scopedPaymentsModes / route ctx scopedPaymentsModes,
 * populated by the execution-context owner); global env = the Worker
 * env var. A blank/unset level falls through to the next level. The
 * FIRST non-blank level wins; if that value is unrecognized, the
 * resolution FAILS CLOSED to the surface legacy (invalid=true, level
 * = the winning level) and does NOT fall through to a lower level.
 * Callers must log + audit `payment.config_error` on invalid (the
 * premium routes have no audit writer on their context, so they log
 * only — the quoteModes precedent for unaudited surfaces).
 *
 * Built-in default per surface = that surface's CURRENT behavior
 * (recorded explicitly so the owner can overturn it later). The
 * values are named after the surfaces, so legacy IS the surface name:
 *   MCP surface: every switch defaults to "mcp".
 *   REST surface: every switch defaults to "rest".
 * Unset switches therefore change NOTHING on either surface (zero
 * unattended behavior change, including on every money path). A
 * single global env value applies to both surfaces; an owner who
 * sets PAYMENTS_CREATE_MODE=rest globally must know the REST create
 * route still runs its gateway 400 before delegation (see the
 * enforcement boundary below) — the switch governs the command's
 * presentation/validation contract, not the route's guard.
 *
 * What the switches govern (PRESENTATION + the command-side
 * validation/audit contract — never enforcement, never money state):
 * | pair            | mcp branch (MCP legacy)              | rest branch (REST legacy)              |
 * | create          | no gateway validation; omitted desc  | gateway validated (UNSUPPORTED_       |
 * |                 | → generic `Payment intent for ...`   | GATEWAY throw); omitted desc → ""      |
 * | confirm         | full envelope (executorDid/decision/ | REST subset envelope (success/status/  |
 * |                 | executedAt/transaction)              | draftId/checkoutUrl/gatewayRef/        |
 * |                 |                                      | authorizerDid)                         |
 * | transactions    | limit + status honored; raw rows +   | limit fixed 50, status ignored, rows   |
 * |                 | count, no summary                    | coerced + summary                      |
 * | wallet status   | {success: true, ...status}           | raw wallet status                      |
 * | wallet setlimit | message-string shape; missing limit  | route shape {success, autoApprove-     |
 * |                 | → silent status fall-through; no     | LimitUSD}; missing/negative/NaN →     |
 * |                 | audit; `limit` alias ignored         | throw; audits limit_updated; `limit`  |
 * |                 |                                      | alias honored                          |
 * | screener env.   | flat envelope (status/paid/receipt/   | REST envelope (success/service/       |
 * |                 | matchesCount/contracts/...)          | receipt/screenResult)                  |
 * | research env.   | flat envelope (status/paid/receipt/  | REST envelope (success/service/       |
 * |                 | report)                              | receipt/report)                        |
 *
 * What the switches do NOT govern (ENFORCEMENT / MONEY STATE, never
 * opt-out — a switch value can never weaken, bypass, or re-route
 * any of these):
 * - The REST create route's gateway 400 (issue #156) runs BEFORE
 *   delegation in BOTH modes: gateway validation on the route is a
 *   guard, not a presentation delta. The switch only adds the same
 *   validation to direct MCP execution under mode=rest.
 * - HITL for transactions: draft → human confirm → execute is
 *   unchanged in both modes on both surfaces, as is
 *   PAYMENTS_FLOW_MODE (hitl | immediate, #1711). In immediate mode
 *   the create/confirm envelopes are the verbatim pre-#1690 route
 *   shapes; the create/confirm switches do not apply there.
 * - The P-2 shared gap (neither layer checks the facade
 *   createCheckout/executeRefund success flag before writing
 *   status "completed") is NOT fixed by this slice and NOT governed
 *   by any switch here: it changes money-state transition semantics
 *   in both modes (including #1711's verbatim immediate recovery)
 *   and is recorded as a follow-up in the #1728 §15, not silently
 *   re-described as fixed by a presentation unification.
 * - Premium payment verification: the x402 gate, the MPP boundary
 *   (MPP credentials are verified ONLY through the mppx gateway in
 *   handleGatedEndpoint; verifyPayment rejects MPP-from-headers in
 *   ALL modes), the per-tier prices ($0.05 / $0.10 / $0.02), the
 *   execution channel (MCP "mcp", REST "webhook"/"premium"), the
 *   caller identity (MCP sessionId, REST session login or verified
 *   payer scope), and canonical capture/run-linking on REST are all
 *   unswitched. The premium switches govern the RESPONSE ENVELOPE
 *   only. MCP paid tools stay x402-only in every mode.
 * - The agentic wallet balance stays a simulated local-ledger figure
 *   ($50 starting credit) in every mode, and wallet reads stay
 *   per-identity scoped (#183) in every mode.
 * - REST-only surfaces with no MCP pair are NOT given a weaker MCP
 *   twin by this slice: POST /payments/capture, POST /payments/
 *   webhook, GET /payments/dids, the agentic ledger routes
 *   (/payments/agentic/ledger/*), and /premium/stock-signals (no
 *   paid_stock_signals command — the ScreenerAgent pipeline it
 *   executes through is not bound in MCP context, the #1726
 *   screened-mode boundary) are pinned as single-surface residuals,
 *   not re-implemented.
 * - No per-handler auth change: both layers still inherit the
 *   dispatcher session (the scan's auth-gate note stands).
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-request `mode` / `?mode=`) and global env are settable; an
 * admin-owned persisted settings surface is a follow-up, not
 * smuggled in via a store whose keys any caller can write (the
 * #1721 boundary note). The route ctx carriers are populated by no
 * production caller yet.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/agenticPaymentsModes",
});

export type PaymentsSurfaceMode = "mcp" | "rest";

/** One switch's value per surface key, as carried at session/user level. */
export interface PaymentsModeValues {
  create?: unknown;
  confirm?: unknown;
  transactions?: unknown;
  wallet?: unknown;
  screener?: unknown;
  research?: unknown;
}

/** Session/user carriers for the agentic-payments switches. */
export interface PaymentsScopedModes {
  session?: PaymentsModeValues;
  user?: PaymentsModeValues;
}

/** One level of the resolution order. Blank/unset falls through. */
export interface PaymentsModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedPaymentsSwitch {
  mode: PaymentsSurfaceMode;
  invalid: boolean;
  raw?: string;
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const PAYMENTS_CREATE_MODE_SWITCH = "PAYMENTS_CREATE_MODE" as const;
export const PAYMENTS_CONFIRM_MODE_SWITCH = "PAYMENTS_CONFIRM_MODE" as const;
export const PAYMENTS_TRANSACTIONS_MODE_SWITCH = "PAYMENTS_TRANSACTIONS_MODE" as const;
export const AGENTIC_WALLET_MODE_SWITCH = "AGENTIC_WALLET_MODE" as const;
export const PREMIUM_SCREENER_MODE_SWITCH = "PREMIUM_SCREENER_MODE" as const;
export const PREMIUM_RESEARCH_MODE_SWITCH = "PREMIUM_RESEARCH_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function paymentsConfigErrorEvent(): string {
  return "payment.config_error";
}

function normalizeSwitchValue(raw: unknown): PaymentsSurfaceMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "mcp" || normalized === "rest") return normalized;
  return "invalid";
}

function resolveSwitch(
  levels: PaymentsModeScopeLevels,
  legacy: PaymentsSurfaceMode,
  switchName: string,
): ResolvedPaymentsSwitch {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(paymentsConfigErrorEvent(), {
        message: `[${paymentsConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy "${legacy}"`,
        switch: switchName,
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
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for one switch from the scoped carrier + run + env. */
export function levelsForPaymentsSwitch(
  scoped: PaymentsScopedModes | undefined,
  key: keyof PaymentsModeValues,
  run: unknown,
  envValue: unknown,
): PaymentsModeScopeLevels {
  return { run, session: scoped?.session?.[key], user: scoped?.user?.[key], env: envValue };
}

export function resolvePaymentsCreateMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, PAYMENTS_CREATE_MODE_SWITCH);
}

export function resolvePaymentsConfirmMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, PAYMENTS_CONFIRM_MODE_SWITCH);
}

export function resolvePaymentsTransactionsMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, PAYMENTS_TRANSACTIONS_MODE_SWITCH);
}

export function resolveAgenticWalletMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, AGENTIC_WALLET_MODE_SWITCH);
}

export function resolvePremiumScreenerMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, PREMIUM_SCREENER_MODE_SWITCH);
}

export function resolvePremiumResearchMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
  return resolveSwitch(levels, legacy, PREMIUM_RESEARCH_MODE_SWITCH);
}

/**
 * Key-based entry point for call sites that resolve by switch key
 * (commands, routes): one table, so a new switch cannot drift
 * between a command resolver and a route resolver. Callers own the
 * log + audit on `resolved.invalid` (agents differ per call site).
 */
export function resolvePaymentsSwitchByKey(
  scoped: PaymentsScopedModes | undefined,
  key: keyof PaymentsModeValues,
  run: unknown,
  envValue: unknown,
  legacy: PaymentsSurfaceMode,
): { resolved: ResolvedPaymentsSwitch; switchName: string } {
  const table: Record<keyof PaymentsModeValues, { switchName: string; resolve: (levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode) => ResolvedPaymentsSwitch }> = {
    create: { switchName: PAYMENTS_CREATE_MODE_SWITCH, resolve: resolvePaymentsCreateMode },
    confirm: { switchName: PAYMENTS_CONFIRM_MODE_SWITCH, resolve: resolvePaymentsConfirmMode },
    transactions: { switchName: PAYMENTS_TRANSACTIONS_MODE_SWITCH, resolve: resolvePaymentsTransactionsMode },
    wallet: { switchName: AGENTIC_WALLET_MODE_SWITCH, resolve: resolveAgenticWalletMode },
    screener: { switchName: PREMIUM_SCREENER_MODE_SWITCH, resolve: resolvePremiumScreenerMode },
    research: { switchName: PREMIUM_RESEARCH_MODE_SWITCH, resolve: resolvePremiumResearchMode },
  };
  const entry = table[key];
  return {
    resolved: entry.resolve(levelsForPaymentsSwitch(scoped, key, run, envValue), legacy),
    switchName: entry.switchName,
  };
}
