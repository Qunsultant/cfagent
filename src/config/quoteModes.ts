/**
 * #1725 (parent #1717, slice (e)): EIGHT runtime config switches for
 * the market-data / quote paths — the PAYMENTS_FLOW_MODE (#1711) /
 * ads-revenue (#1721) / NLQ_MODE (#1722) / KNOWLEDGE_MODE (#1723) /
 * HTTP_DELIVERY_MODE (#1724) pattern applied to this domain.
 *
 * NEVER EITHER/OR, ALWAYS CONFIGURABLE: every divergent pair keeps
 * BOTH code paths; no endpoint is removed, no code path is deleted,
 * no store is merged, and no synthetic/static substitute is
 * introduced (live-only #923 discipline stands: a provider that
 * cannot serve live throws explicit unavailable, as today — a
 * "no-substitution" refusal is a null/unavailable, never a made-up
 * price).
 *
 * The switches:
 * - QUOTE_EXPIRY_MODE ("honour" | "continuity") — M2: HTTP/facade
 *   honours liveMarketCache expiresAt (expired → unavailable) vs
 *   WS/getBatch ignoring it for stream continuity. Defaults:
 *   HTTP/facade "honour", WS/getBatch "continuity".
 * - QUOTE_STREAM_PROVENANCE ("bare" | "provenance") — M2 shape:
 *   WS ticks bare (tick fields only) vs annotated with
 *   provenance/fetchedAtMs/ageMs from the cache entry. Default WS
 *   "bare". HTTP is always provenance (facade contract, not
 *   switched). A cache read is never labelled "live" in any mode
 *   (facade rule, #1643).
 * - QUOTE_HTTP_PROVIDER_MODE ("yahoo-only" | "env") — M2b: the HTTP
 *   branch drops env (Yahoo-only refresh) vs passing env (Alpaca
 *   possible when configured). Default HTTP "yahoo-only" — the
 *   M2b call-site fact, RUNTIME-CONFIRMED in tests (see the #1725
 *   suite: handleMarketQuotesHttp with no env issues no Alpaca
 *   request; with env it can), recorded explicitly, NOT silently
 *   "fixed" to Alpaca-first. WS always passes env (pinned, not
 *   switched).
 * - QUOTE_ALPACA_KEY_MODE ("either" | "id-only") — M6: which env-key
 *   spellings count as "Alpaca configured". Defaults: hybrid
 *   provider "id-only" (_ID + _SECRET_KEY only, its legacy gate),
 *   marketStream fetch "either" (either spelling, both sides, its
 *   legacy gate). An explicitly set level overrides the surface
 *   default uniformly. The Alpaca platform getStatus surface keeps
 *   its either-spelling rule pinned (status reporter, not a quote
 *   fetch) — see the suite.
 * - QUOTE_FALLBACK_MODE ("fallthrough" | "no-substitution") — M3/M9:
 *   marketStream try-Alpaca-then-Yahoo silent fallthrough vs the
 *   registry's no-substitution rule (unservable primary → explicit
 *   unavailable, never a substitute provider). Defaults:
 *   marketStream "fallthrough", registry "no-substitution"
 *   (pinned — the registry is untouched). Under
 *   "no-substitution", an Alpaca-configured marketStream fetch that
 *   fails (or has no previous tick for change derivation) returns
 *   null (unavailable) instead of Yahoo data; an Alpaca-
 *   unconfigured fetch still reads Yahoo (that is not a
 *   substitution, it is the only leg).
 * - QUOTE_ETRADE_UNKNOWN_MODE ("throw" | "zero-object") — M7:
 *   unknown-symbol tail. Defaults: platform getQuote "throw"
 *   (#294 fail-fast), service sync getQuote "zero-object"
 *   (AUTH_REQUIRED zero-price object). The #922 curated-live throw
 *   stands in EVERY mode (it precedes the unknown tail on both
 *   surfaces), and fetchQuoteLiveStrict is pinned, not switched
 *   (its policy is #1726-adjacent: MCP-vs-REST command
 *   unification stays #1726 ground).
 * - QUOTE_YAHOO_OPEN_MODE ("midpoint" | "wire") — M4: Yahoo
 *   single-quote open derivation. Defaults: single "midpoint"
 *   ((dayHigh+dayLow)/2, falling back to price), batch "wire"
 *   (regularMarketOpen, pinned — the batch method is untouched).
 *   Under "wire", a missing wire open falls back to the midpoint
 *   formula (no invented value).
 * - QUOTE_YAHOO_INDICATORS_MODE ("computed" | "unset") — M4:
 *   Yahoo single-quote rsi14/macdSignal. Defaults: single
 *   "computed" (from 1mo closes), batch "unset" (pinned — parity
 *   note: E*TRADE snapshots carry no indicators either). Under
 *   "unset" the fields are undefined, never zero-filled.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * First non-blank level wins; an unrecognized winning value FAILS
 * CLOSED to the surface legacy, logged via the structured logger, with NO
 * fall-through. Audit note, stated honestly: the quote surfaces
 * are unaudited today (M10: market HTTP/WS no audit, Market-data REST
 * quote no audit; MCP audits live at the command layer, which
 * this slice does not touch), so there is no audit writer on
 * these paths to emit quotes.config_error through — adding one
 * would change the unaudited contract. The event name is defined
 * here for the layer that owns audit, and invalid values are
 * console-logged (greppable) at every wired call site.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Auth/audit/error shapes stand in every mode (M10): market HTTP
 *   stays unauthenticated 200+unavailable, Market-data REST stays 500 on
 *   failure, Market-data MCP stays audited-throw, E*TRADE MCP stays
 *   session-bound LiveStrict. No switch value widens access,
 *   disables an audit, or changes a symbol-length bound (Market-data
 *   1–20, E*TRADE 1–10, zod).
 * - Caches stay separate (M8): liveMarketCache (bare key, 20s
 *   Alpaca / 30s Yahoo, MarketTickData) and quoteCache (namespaced
 *   key, 5 min, MarketDataResearchQuote/listings, 500-entry cap) are NOT merged;
 *   the expiry switch only changes how one cache's entries are
 *   read, never which store a path writes.
 * - Live-only provenance stands in every mode: no switch serves a
 *   stale tick as current under "honour", and no switch labels a
 *   cache read "live". Curated defaultPrice ?? 100.0 stays
 *   non-live-only, and the sync zero-price stub stays an
 *   AUTH_REQUIRED object, never a priced quote.
 * - The M12 screener evaluator (screenWithQuotes, shared across
 *   E*TRADE/Yahoo legs) and the S4 research-provider seam
 *   (honestly-empty degradation vs registry throw-on-unservable)
 *   are PINNED, not switched — selection differs by route by
 *   design, and neither evaluator is duplicated.
 * - Route-twin spelling/identity/headers (R02: /etrade/quote vs
 *   /market-data/quote vs /api/market-data|market|foss/quotes) belong to appendix
 *   (m) — this slice owns provider/cache semantics only and does
 *   not move, merge, or rename any route. Note the scan
 *   disagreement resolved on current main: appendix (e) M10 says
 *   no dedicated REST E*TRADE quote route exists, but routes scan
 *   R02 and etradeBroker.ts:282 show GET /etrade/quote DOES exist
 *   at the DO route layer (registry-resolved platform +
 *   fetchQuoteLiveStrict, x-user-login gate, no-cache headers);
 *   the (e) claim holds only for the Worker /api layer. This
 *   slice pins the DO route's existence without touching it.
 * - DataProvider adapter batch asymmetry stands: getQuotesBatch
 *   exists only when the wrapped provider has getQuotes (Yahoo
 *   only, not Alpaca) — pinned, not papered over.
 * - Public quote-row mapping (M11) stays partial: absent fields
 *   are omitted, never zero-filled, no quoteStatus stamped —
 *   pinned, not switched.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in
 * resolution order and unit-pinned, but in production today only
 * run (per-request header / query param / method opts) and global
 * env are settable — the same boundary as #1721/#1722/#1723/#1724.
 * The Worker HTTP branch resolves the provider mode itself
 * (it decides whether env reaches the handler at all) and passes
 * the handler a mode-only env for expiry resolution, so the
 * expiry env level is not lost when the fetch env is withheld
 * (see handleMarketQuotesHttp's envForModes option).
 */

import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/quoteModes",
});

/** Audit event name for quote-switch fail-closed (see header note). */
export function quotesConfigErrorEvent(): string {
  return "quotes.config_error";
}

/** M2 expiry semantics. */
export type QuoteExpiryMode = "honour" | "continuity";
export const QUOTE_EXPIRY_MODE_SWITCH = "QUOTE_EXPIRY_MODE" as const;

/** M2 WS tick envelope. */
export type QuoteStreamProvenance = "bare" | "provenance";
export const QUOTE_STREAM_PROVENANCE_SWITCH = "QUOTE_STREAM_PROVENANCE" as const;

/** M2b HTTP provider selection. */
export type QuoteHttpProviderMode = "yahoo-only" | "env";
export const QUOTE_HTTP_PROVIDER_MODE_SWITCH = "QUOTE_HTTP_PROVIDER_MODE" as const;

/** M6 Alpaca-configured key spellings. */
export type QuoteAlpacaKeyMode = "either" | "id-only";
export const QUOTE_ALPACA_KEY_MODE_SWITCH = "QUOTE_ALPACA_KEY_MODE" as const;

/** M3/M9 provider-fallback semantics. */
export type QuoteFallbackMode = "fallthrough" | "no-substitution";
export const QUOTE_FALLBACK_MODE_SWITCH = "QUOTE_FALLBACK_MODE" as const;

/** M7 unknown-symbol tail. */
export type QuoteEtradeUnknownMode = "throw" | "zero-object";
export const QUOTE_ETRADE_UNKNOWN_MODE_SWITCH = "QUOTE_ETRADE_UNKNOWN_MODE" as const;

/** M4 Yahoo single-quote open derivation. */
export type QuoteYahooOpenMode = "midpoint" | "wire";
export const QUOTE_YAHOO_OPEN_MODE_SWITCH = "QUOTE_YAHOO_OPEN_MODE" as const;

/** M4 Yahoo single-quote indicators. */
export type QuoteYahooIndicatorsMode = "computed" | "unset";
export const QUOTE_YAHOO_INDICATORS_MODE_SWITCH = "QUOTE_YAHOO_INDICATORS_MODE" as const;

/** One level set of the resolution order. Blank/unset falls through. */
export interface QuoteScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers, as carried by an execution context or method opts. */
export interface QuoteScopedModes {
  session?: unknown;
  user?: unknown;
}

export interface ResolvedQuoteSwitch<T> {
  mode: T;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeSwitchValue(raw: unknown, valid: string[]): string | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (valid.includes(normalized)) return normalized;
  return "invalid";
}

function resolveSwitch<T extends string>(
  levels: QuoteScopeLevels,
  legacy: T,
  valid: string[],
  switchName: string
): ResolvedQuoteSwitch<T> {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value, valid);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(quotesConfigErrorEvent(), {
        message: `[${quotesConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy`,
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
    return { mode: normalized as T, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + run + env. */
export function levelsForQuoteSwitch(
  scoped: QuoteScopedModes | undefined,
  run: unknown,
  envValue: unknown
): QuoteScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}

export function resolveQuoteExpiryMode(levels: QuoteScopeLevels, legacy: QuoteExpiryMode): ResolvedQuoteSwitch<QuoteExpiryMode> {
  return resolveSwitch(levels, legacy, ["honour", "continuity"], QUOTE_EXPIRY_MODE_SWITCH);
}

export function resolveQuoteStreamProvenance(
  levels: QuoteScopeLevels,
  legacy: QuoteStreamProvenance
): ResolvedQuoteSwitch<QuoteStreamProvenance> {
  return resolveSwitch(levels, legacy, ["bare", "provenance"], QUOTE_STREAM_PROVENANCE_SWITCH);
}

export function resolveQuoteHttpProviderMode(
  levels: QuoteScopeLevels,
  legacy: QuoteHttpProviderMode
): ResolvedQuoteSwitch<QuoteHttpProviderMode> {
  return resolveSwitch(levels, legacy, ["yahoo-only", "env"], QUOTE_HTTP_PROVIDER_MODE_SWITCH);
}

export function resolveQuoteAlpacaKeyMode(
  levels: QuoteScopeLevels,
  legacy: QuoteAlpacaKeyMode
): ResolvedQuoteSwitch<QuoteAlpacaKeyMode> {
  return resolveSwitch(levels, legacy, ["either", "id-only"], QUOTE_ALPACA_KEY_MODE_SWITCH);
}

export function resolveQuoteFallbackMode(
  levels: QuoteScopeLevels,
  legacy: QuoteFallbackMode
): ResolvedQuoteSwitch<QuoteFallbackMode> {
  return resolveSwitch(levels, legacy, ["fallthrough", "no-substitution"], QUOTE_FALLBACK_MODE_SWITCH);
}

export function resolveQuoteEtradeUnknownMode(
  levels: QuoteScopeLevels,
  legacy: QuoteEtradeUnknownMode
): ResolvedQuoteSwitch<QuoteEtradeUnknownMode> {
  return resolveSwitch(levels, legacy, ["throw", "zero-object"], QUOTE_ETRADE_UNKNOWN_MODE_SWITCH);
}

export function resolveQuoteYahooOpenMode(
  levels: QuoteScopeLevels,
  legacy: QuoteYahooOpenMode
): ResolvedQuoteSwitch<QuoteYahooOpenMode> {
  return resolveSwitch(levels, legacy, ["midpoint", "wire"], QUOTE_YAHOO_OPEN_MODE_SWITCH);
}

export function resolveQuoteYahooIndicatorsMode(
  levels: QuoteScopeLevels,
  legacy: QuoteYahooIndicatorsMode
): ResolvedQuoteSwitch<QuoteYahooIndicatorsMode> {
  return resolveSwitch(levels, legacy, ["computed", "unset"], QUOTE_YAHOO_INDICATORS_MODE_SWITCH);
}

/**
 * M6, unified: is Alpaca configured under a key mode? "either"
 * accepts ALPACA_API_KEY|ALPACA_API_KEY_ID with
 * ALPACA_SECRET_KEY|ALPACA_API_SECRET_KEY (marketStream/platform
 * legacy); "id-only" accepts only the _ID/_SECRET_KEY spellings
 * (hybrid legacy). Env may be undefined (unconfigured).
 */
export function isAlpacaConfigured(env: Env | undefined, keyMode: QuoteAlpacaKeyMode): boolean {
  if (!env) return false;
  if (keyMode === "id-only") {
    return Boolean(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY);
  }
  const apiKey = env.ALPACA_API_KEY || env.ALPACA_API_KEY_ID;
  const secretKey = env.ALPACA_SECRET_KEY || env.ALPACA_API_SECRET_KEY;
  return Boolean(apiKey && secretKey);
}
