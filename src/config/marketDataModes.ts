/**
 * #1727 (parent #1717, slice (g)): SEVEN runtime config switches for
 * the Market-data MCP-vs-REST pairs (scan appendix (g) findings F01–F05) —
 * the PAYMENTS_FLOW_MODE (#1711) / QUOTE_* (#1725) / ETRADE_* (#1726)
 * pattern applied to this domain. Pure module: no Cloudflare
 * imports, no I/O, no network — the port is the resolver, and both
 * surfaces consume it (port-first, cfagent blueprint #1795/#1798
 * restated wording: cloud-native but cloud-agnostic).
 *
 * Switches (Worker env vars, non-secret, owner-set; this slice sets
 * NO production value — production values are an owner action):
 *   MARKET_DATA_QUOTE_MODE         "mcp" | "rest"            (F01 quote)
 *   MARKET_DATA_FUNDAMENTALS_MODE  "mcp" | "rest"            (F01 fundamentals)
 *   MARKET_DATA_RESEARCH_MODE      "mcp" | "rest"            (F01 research)
 *   MARKET_DATA_BARS_MODE          "mcp" | "rest"            (F02 bars)
 *   MARKET_DATA_SNAPSHOT_MODE      "mcp" | "rest"            (F03 snapshot)
 *   ALPACA_READS_MODE  "mcp" | "rest" | "none"    (F04 reads)
 *   ALPACA_ORDER_MODE  "mcp" | "market-data" | "trading" (F05 place order)
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * #1906 rename: the canonical env var names above replace the legacy
 * FOSS_*_MODE names; a legacy name still set while its canonical name
 * is unset is honored as a deprecated fallback (envValueForSwitch),
 * so stored owner configuration keeps working. Likewise the order
 * mode value "foss" is accepted as a deprecated alias for
 * "market-data" at every level (resolveAlpacaOrderMode). Alias
 * removal is a separate follow-up; no alias is removed here.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (per-surface
 *   legacy — the #1726 accepted interpretation of the identical
 *   standing-rule text "built-in default (current PUBLIC ROUTE
 *   behavior)": each surface keeps its own current contract when
 *   nothing is configured, so this slice changes NO unattended
 *   behavior; the owner can overturn any default with one env var).
 * Carriers: run = the per-request / per-call `mode` field (MCP
 * input `mode`, REST query `?mode=` or POST body `mode`); session
 * / user = the optional `scopedMarketDataModes` carrier on the execution
 * context (McpToolContext.scopedMarketDataModes / route ctx
 * scopedMarketDataModes, populated by the execution-context owner);
 * global env = the Worker env var. A blank/unset level falls
 * through to the next level. The FIRST non-blank level wins; if
 * that value is unrecognized, the resolution FAILS CLOSED to the
 * surface legacy (invalid=true, level = the winning level) and
 * does NOT fall through to a lower level. Callers must log +
 * audit `market_data.config_error` on invalid.
 *
 * Built-in defaults per surface = that surface's CURRENT behavior
 * (recorded explicitly so the owner can overturn it later):
 *   MCP surface: quote=mcp, fundamentals=mcp, research=mcp,
 *     bars=mcp, snapshot=mcp, reads=mcp, order=mcp.
 *   /market-data REST surface: quote=rest, fundamentals=rest,
 *     research=rest, bars=rest, snapshot=rest, reads=rest,
 *     order=market-data.
 *   /trading REST surface: reads=none (its current silence),
 *     order=trading (its current normalization + minimal audit).
 *   (/trading has no quote/fundamentals/research/bars/snapshot
 *   routes, so those switches do not apply there.)
 *
 * Per-mode behavior matrix (both/all paths preserved as branches,
 * never deleted; no endpoint removed):
 * | pair            | mcp branch                            | rest/market-data/trading branch              |
 * | quote           | symbol required (throw / 400), audit   | symbol defaults NVDA, no quote audit    |
 * |                 | market_data.quote.fetched                    |                                         |
 * | fundamentals    | symbol required, audit                | symbol defaults NVDA, no audit          |
 * |                 | market_data.fundamentals.fetched             |                                         |
 * | research        | symbol required, audit                | symbol defaults NVDA, audit             |
 * |                 | market_data.research.generated               | market_data.research_generated                 |
 * | bars            | no provider input (service default),  | provider input (default yfinance)       |
 * |                 | {symbol,count,provenance,bars}, audit  | passed explicitly; fuller envelope      |
 * |                 | market_data.bars.fetched                     | {symbol,provider,timeframe,count,     |
 * |                 |                                       | bars,provenance,source,timestamp};     |
 * |                 |                                       | no bars audit                           |
 * | snapshot        | symbol required, audit                | symbol defaults NVDA, audit             |
 * |                 | alpaca.snapshot {symbol,         | alpaca.snapshot_queried {symbol,price,  |
 * |                 | assetClass,tradePrice,provenance}     | bid,ask,assetClass}                     |
 * | alpaca reads    | audits alpaca.account.query /         | rest: audits alpaca.account_queried /   |
 * | (account /      | positions.query / orders.query with   | positions_queried / orders_queried      |
 * | positions /     | the /market-data-identical payloads;         | with the same payloads; none: no read   |
 * | orders)         | orders status default open            | audit; orders status default open in    |
 * |                 |                                       | every mode                              |
 * | alpaca place    | verbatim input (no qty default, no     | market-data: /market-data normalization (uppercase   |
 * | order           | uppercasing, no aliases, limit_price  | + trim, qty = qty\|\|quantity\|\|1, side  |
 * |                 | only), audit alpaca.order.place       | = side\|\|orderAction\|\|buy lowercased,  |
 * |                 | with the full field set               | type = type\|\|orderType\|\|market        |
 * |                 |                                       | lowercased, limit_price\|\|limitPrice,   |
 * |                 |                                       | tif day) + alpaca.order_placed full     |
 * |                 |                                       | set; trading: /trading normalization    |
 * |                 |                                       | (trim, no uppercase, qty\|\|1, side      |
 * |                 |                                       | lower default buy, type raw, tif day)   |
 * |                 |                                       | + alpaca.order_placed minimal           |
 * |                 |                                       | {symbol,qty,side,status}                |
 *
 * AUDIT-NAME DECISION (F01, recorded explicitly per the issue):
 * the REST spelling `market_data.research_generated` is the canonical
 * spelling for NEW consumers — it matches the past-tense
 * underscore convention of the whole /market-data *_queried family
 * (account_queried, positions_queried, orders_queried,
 * snapshot_queried). The MCP spelling `market_data.research.generated`
 * is NOT deleted: it stays available under mode=mcp on both
 * surfaces. The unification is that the name is now governed by
 * one configured mode instead of by which surface answered —
 * the split is explicit configuration, not an accident. The
 * owner can make the MCP spelling the global default with one
 * env var (MARKET_DATA_RESEARCH_MODE=mcp).
 *
 * THREE-WAY NOTE (F04/F05, domain (m) #1733 R01 interaction):
 * the reads and order switches are three-valued because the
 * divergence is three-way (MCP vs /market-data vs /trading), not two-
 * way. This slice WIRES all three surfaces through the switch
 * but does NOT pre-decide the /trading↔/market-data twin question:
 * /trading keeps its own legacy as its built-in default
 * (reads=none, order=trading), and #1733 retains full freedom
 * to change the /trading default or the twin semantics later —
 * that is a one-line default change once the switch exists.
 * No route is moved, merged, or renamed here.
 *
 * Scan-vs-code corrections (appendix (g) was written against an
 * older tree; current main governs, and the pins in
 * tests/market_data_modes_1727.test.ts lock the true behavior):
 * - MCP quote/fundamentals DO audit today (market_data.quote.fetched /
 *   market_data.fundamentals.fetched); the appendix claim that MCP
 *   audits "snapshot/bars/research but not quote/fundamentals"
 *   is stale — the divergence is REST-silence vs MCP-audit.
 * - MCP orders status DOES default to open today (zod default +
 *   execute `|| "open"` + service default); the scan's "no
 *   default" claim is stale — status default is pinned, not
 *   switched, open in every mode on every surface.
 * - MCP account/positions/orders audit payloads are IDENTICAL to
 *   the /market-data *_queried payloads; F04's divergence is the event
 *   NAME (+ /trading silence), not the payload.
 * - MarketDataResearchService.getHistoricalBars defaults provider to
 *   yfinance; MCP's 3-arg call and REST's explicit default agree
 *   on the VALUE — F02's divergence is the provider OVERRIDE +
 *   envelope + audit, not the default value.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Alpaca order placement carries NO HITL gate on either surface
 *   today (unlike E*TRADE E04); this slice neither adds nor
 *   weakens one. The order switch changes input normalization +
 *   audit only — the service placement call is the same in every
 *   mode, and no switch value can disable an enforcement.
 * - REST auth shapes stand in every mode (the market-data/alpaca routes
 *   keep their current auth posture; no switch value widens
 *   access, disables an audit outside its own mode branch, or
 *   changes a symbol-length bound (Market-data 1–20, zod).
 * - Live-only provenance stands in every mode (#923): no switch
 *   serves a static/generated substitute.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in
 * resolution order and unit-pinned, but in production today only
 * run (per-request `mode`) and global env are settable — the same
 * boundary as #1721/#1722/#1723/#1724/#1725/#1726. The route ctx
 * carrier is populated by no production caller yet.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/marketDataModes",
});

export type MarketDataQuoteMode = "mcp" | "rest";
export type MarketDataFundamentalsMode = "mcp" | "rest";
export type MarketDataResearchMode = "mcp" | "rest";
export type MarketDataBarsMode = "mcp" | "rest";
export type MarketDataSnapshotMode = "mcp" | "rest";
export type AlpacaReadsMode = "mcp" | "rest" | "none";
export type AlpacaOrderMode = "mcp" | "market-data" | "trading";

/** One switch's value per pair key, as carried at session/user level. */
export interface MarketDataModeValues {
  quote?: unknown;
  fundamentals?: unknown;
  research?: unknown;
  bars?: unknown;
  snapshot?: unknown;
  reads?: unknown;
  order?: unknown;
}

/** Session/user carriers for the market-data switches. */
export interface MarketDataScopedModes {
  session?: MarketDataModeValues;
  user?: MarketDataModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface MarketDataModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedMarketDataSwitch<T extends string> {
  mode: T;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const MARKET_DATA_QUOTE_MODE_SWITCH = "MARKET_DATA_QUOTE_MODE" as const;
export const MARKET_DATA_FUNDAMENTALS_MODE_SWITCH = "MARKET_DATA_FUNDAMENTALS_MODE" as const;
export const MARKET_DATA_RESEARCH_MODE_SWITCH = "MARKET_DATA_RESEARCH_MODE" as const;
export const MARKET_DATA_BARS_MODE_SWITCH = "MARKET_DATA_BARS_MODE" as const;
export const MARKET_DATA_SNAPSHOT_MODE_SWITCH = "MARKET_DATA_SNAPSHOT_MODE" as const;
export const ALPACA_READS_MODE_SWITCH = "ALPACA_READS_MODE" as const;
export const ALPACA_ORDER_MODE_SWITCH = "ALPACA_ORDER_MODE" as const;

/**
 * #1906: deprecated legacy env var names, superseded by their canonical
 * MARKET_DATA_*_MODE / ALPACA_*_MODE names, honored ONLY when the canonical
 * name is unset or blank. Production values are owner-set; a hard cutover
 * would silently break stored configuration, so the resolver falls back
 * instead of failing. Alias removal is a separate follow-up.
 */
const LEGACY_ENV_VARS: Record<string, string> = {
  MARKET_DATA_QUOTE_MODE: "FOSS_QUOTE_MODE",
  MARKET_DATA_FUNDAMENTALS_MODE: "FOSS_FUNDAMENTALS_MODE",
  MARKET_DATA_RESEARCH_MODE: "FOSS_RESEARCH_MODE",
  MARKET_DATA_BARS_MODE: "FOSS_BARS_MODE",
  MARKET_DATA_SNAPSHOT_MODE: "FOSS_SNAPSHOT_MODE",
  ALPACA_READS_MODE: "FOSS_ALPACA_READS_MODE",
  ALPACA_ORDER_MODE: "FOSS_ALPACA_ORDER_MODE",
};

/**
 * Reads one switch's env level: the canonical var first, the deprecated
 * legacy var when the canonical is unset or blank. A non-blank canonical
 * value always wins — even when invalid, so an explicit misconfiguration
 * still fails closed instead of silently falling back to legacy.
 */
export function envValueForSwitch(env: unknown, canonicalVar: string): unknown {
  const record = env as Record<string, unknown> | null;
  const canonical = record?.[canonicalVar];
  if (canonical !== undefined && canonical !== null && canonical !== "") return canonical;
  const legacy = LEGACY_ENV_VARS[canonicalVar];
  return legacy ? record?.[legacy] : undefined;
}

/** Audit event emitted when a switch value fails closed. */
export function marketDataConfigErrorEvent(): string {
  return "market_data.config_error";
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
  levels: MarketDataModeScopeLevels,
  legacy: T,
  valid: string[],
  switchName: string
): ResolvedMarketDataSwitch<T> {
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
      structuredLog.warn(marketDataConfigErrorEvent(), {
        message: `[${marketDataConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy`,
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

/** Builds the level set for one switch from the scoped carrier + run + env. */
export function levelsForMarketDataSwitch(
  scoped: MarketDataScopedModes | undefined,
  key: keyof MarketDataModeValues,
  run: unknown,
  envValue: unknown
): MarketDataModeScopeLevels {
  return { run, session: scoped?.session?.[key], user: scoped?.user?.[key], env: envValue };
}

export function resolveMarketDataQuoteMode(levels: MarketDataModeScopeLevels, legacy: MarketDataQuoteMode): ResolvedMarketDataSwitch<MarketDataQuoteMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], MARKET_DATA_QUOTE_MODE_SWITCH);
}

export function resolveMarketDataFundamentalsMode(
  levels: MarketDataModeScopeLevels,
  legacy: MarketDataFundamentalsMode
): ResolvedMarketDataSwitch<MarketDataFundamentalsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], MARKET_DATA_FUNDAMENTALS_MODE_SWITCH);
}

export function resolveMarketDataResearchMode(
  levels: MarketDataModeScopeLevels,
  legacy: MarketDataResearchMode
): ResolvedMarketDataSwitch<MarketDataResearchMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], MARKET_DATA_RESEARCH_MODE_SWITCH);
}

export function resolveMarketDataBarsMode(levels: MarketDataModeScopeLevels, legacy: MarketDataBarsMode): ResolvedMarketDataSwitch<MarketDataBarsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], MARKET_DATA_BARS_MODE_SWITCH);
}

export function resolveMarketDataSnapshotMode(
  levels: MarketDataModeScopeLevels,
  legacy: MarketDataSnapshotMode
): ResolvedMarketDataSwitch<MarketDataSnapshotMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], MARKET_DATA_SNAPSHOT_MODE_SWITCH);
}

export function resolveAlpacaReadsMode(
  levels: MarketDataModeScopeLevels,
  legacy: AlpacaReadsMode
): ResolvedMarketDataSwitch<AlpacaReadsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest", "none"], ALPACA_READS_MODE_SWITCH);
}

/** #1906: maps the deprecated "foss" order-mode value to "market-data" at one level. */
function aliasOrderModeValue(value: unknown): unknown {
  return typeof value === "string" && value.trim().toLowerCase() === "foss" ? "market-data" : value;
}

/** #1906: the deprecated "foss" value is accepted at every level as an alias for "market-data". */
export function resolveAlpacaOrderMode(
  levels: MarketDataModeScopeLevels,
  legacy: AlpacaOrderMode
): ResolvedMarketDataSwitch<AlpacaOrderMode> {
  const aliased: MarketDataModeScopeLevels = {
    run: aliasOrderModeValue(levels.run),
    session: aliasOrderModeValue(levels.session),
    user: aliasOrderModeValue(levels.user),
    env: aliasOrderModeValue(levels.env),
  };
  return resolveSwitch(aliased, legacy, ["mcp", "market-data", "trading"], ALPACA_ORDER_MODE_SWITCH);
}

/**
 * #1727 REST-surface convenience: resolve one switch for a route
 * host (run > session > user > global env > surface legacy) and
 * audit market_data.config_error on an invalid winning value
 * (fail-closed). The host is structural ({ scopedMarketDataModes, env,
 * audit }) so the dispatcher stays thin: one import, one call per
 * route. The audit category follows the route family: the
 * quote/fundamentals/research/bars/snapshot routes audit as
 * "research", the alpaca routes as "trading" (matching each
 * family's existing audit calls).
 */
export interface MarketDataRestSwitchHost {
  scopedMarketDataModes?: MarketDataScopedModes;
  env: unknown;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
}

export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "quote", run: unknown, legacy: MarketDataQuoteMode): MarketDataQuoteMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "fundamentals", run: unknown, legacy: MarketDataFundamentalsMode): MarketDataFundamentalsMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "research", run: unknown, legacy: MarketDataResearchMode): MarketDataResearchMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "bars", run: unknown, legacy: MarketDataBarsMode): MarketDataBarsMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "snapshot", run: unknown, legacy: MarketDataSnapshotMode): MarketDataSnapshotMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "reads", run: unknown, legacy: AlpacaReadsMode): AlpacaReadsMode;
export function resolveMarketDataRestSwitch(host: MarketDataRestSwitchHost, key: "order", run: unknown, legacy: AlpacaOrderMode): AlpacaOrderMode;
export function resolveMarketDataRestSwitch(
  host: MarketDataRestSwitchHost,
  key: keyof MarketDataModeValues,
  run: unknown,
  legacy: string
): string {
  const table: Record<
    keyof MarketDataModeValues,
    {
      envVar: string;
      auditAgent: "research" | "trading";
      resolve: (levels: MarketDataModeScopeLevels, legacy: string) => ResolvedMarketDataSwitch<string>;
    }
  > = {
    quote: { envVar: MARKET_DATA_QUOTE_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveMarketDataQuoteMode(l, g as MarketDataQuoteMode) as unknown as ResolvedMarketDataSwitch<string> },
    fundamentals: { envVar: MARKET_DATA_FUNDAMENTALS_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveMarketDataFundamentalsMode(l, g as MarketDataFundamentalsMode) as unknown as ResolvedMarketDataSwitch<string> },
    research: { envVar: MARKET_DATA_RESEARCH_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveMarketDataResearchMode(l, g as MarketDataResearchMode) as unknown as ResolvedMarketDataSwitch<string> },
    bars: { envVar: MARKET_DATA_BARS_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveMarketDataBarsMode(l, g as MarketDataBarsMode) as unknown as ResolvedMarketDataSwitch<string> },
    snapshot: { envVar: MARKET_DATA_SNAPSHOT_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveMarketDataSnapshotMode(l, g as MarketDataSnapshotMode) as unknown as ResolvedMarketDataSwitch<string> },
    reads: { envVar: ALPACA_READS_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveAlpacaReadsMode(l, g as AlpacaReadsMode) as unknown as ResolvedMarketDataSwitch<string> },
    order: { envVar: ALPACA_ORDER_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveAlpacaOrderMode(l, g as AlpacaOrderMode) as unknown as ResolvedMarketDataSwitch<string> },
  };
  const entry = table[key];
  const resolved = entry.resolve(
    levelsForMarketDataSwitch(host.scopedMarketDataModes, key, run, envValueForSwitch(host.env, entry.envVar)),
    legacy
  );
  if (resolved.invalid) {
    host.audit(marketDataConfigErrorEvent(), entry.auditAgent, {
      switch: entry.envVar,
      raw: resolved.raw,
      level: resolved.level,
      failedClosedTo: resolved.mode,
    });
  }
  return resolved.mode;
}

/* ================= Mode meanings (pure, shared) =================
 * What each mode VALUE means, as pure functions consumed identically
 * by the MCP commands, the /market-data routes, and the /trading routes —
 * one definition per behavior, so the three surfaces cannot drift
 * apart again. These functions never touch the network, env, or
 * Cloudflare APIs; they only shape inputs, envelopes, and audit
 * payloads. The service calls themselves are unchanged.
 */

/** Audit event for a quote/fundamentals/research call, or null when the mode is silent. */
export function marketDataQuoteAuditEvent(mode: MarketDataQuoteMode): string | null {
  return mode === "mcp" ? "market_data.quote.fetched" : null;
}

export function marketDataFundamentalsAuditEvent(mode: MarketDataFundamentalsMode): string | null {
  return mode === "mcp" ? "market_data.fundamentals.fetched" : null;
}

export function marketDataResearchAuditEvent(mode: MarketDataResearchMode): string {
  return mode === "mcp" ? "market_data.research.generated" : "market_data.research_generated";
}

/** Audit event for a bars call, or null when the mode is silent. */
export function marketDataBarsAuditEvent(mode: MarketDataBarsMode): string | null {
  return mode === "mcp" ? "market_data.bars.fetched" : null;
}

/** Snapshot audit: [event, payload] per mode (payload shapes are the surfaces' own legacy shapes). */
export function marketDataSnapshotAudit(
  mode: MarketDataSnapshotMode,
  symbol: string,
  snapshot: { assetClass?: unknown; latestTrade?: { price?: unknown }; latestQuote?: { bidPrice?: unknown; askPrice?: unknown }; provenance?: unknown }
): [string, Record<string, unknown>] {
  if (mode === "mcp") {
    return [
      "alpaca.snapshot",
      { symbol, assetClass: snapshot.assetClass, tradePrice: snapshot.latestTrade?.price, provenance: snapshot.provenance },
    ];
  }
  return [
    "alpaca.snapshot_queried",
    {
      symbol,
      price: snapshot.latestTrade?.price,
      bid: snapshot.latestQuote?.bidPrice,
      ask: snapshot.latestQuote?.askPrice,
      assetClass: snapshot.assetClass,
    },
  ];
}

export type AlpacaReadKind = "account" | "positions" | "orders";

/** Reads audit event per mode, or null for the silent ("none") mode. */
export function marketDataReadsAuditEvent(mode: AlpacaReadsMode, kind: AlpacaReadKind): string | null {
  if (mode === "mcp") return `alpaca.${kind}.query`;
  if (mode === "rest") return `alpaca.${kind}_queried`;
  return null;
}

/** Raw order input as received from any surface (MCP input, REST body). */
export interface MarketDataOrderRawInput {
  symbol?: unknown;
  qty?: unknown;
  quantity?: unknown;
  side?: unknown;
  orderAction?: unknown;
  type?: unknown;
  orderType?: unknown;
  limit_price?: unknown;
  limitPrice?: unknown;
  time_in_force?: unknown;
  extended_hours?: unknown;
  order_class?: unknown;
  take_profit?: unknown;
  take_profit_limit_price?: unknown;
  stop_loss?: unknown;
  stop_loss_stop_price?: unknown;
  stop_loss_limit_price?: unknown;
}

/** Normalized order params as passed to MarketDataResearchService.placeAlpacaOrder. */
export interface MarketDataOrderNormalized {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  limit_price?: number;
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  extended_hours?: boolean;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  take_profit?: { limit_price: number };
  stop_loss?: { stop_price: number; limit_price?: number };
}

/**
 * Normalizes bracket parameters: supports nested { take_profit, stop_loss }
 * and convenience aliases take_profit_limit_price, stop_loss_stop_price.
 */
function extractBracketParams(input: MarketDataOrderRawInput): {
  order_class?: MarketDataOrderNormalized["order_class"];
  take_profit?: { limit_price: number };
  stop_loss?: { stop_price: number; limit_price?: number };
  extended_hours?: boolean;
} {
  let take_profit = input.take_profit as { limit_price: number } | undefined;
  if (!take_profit && input.take_profit_limit_price !== undefined && input.take_profit_limit_price !== null) {
    take_profit = { limit_price: Number(input.take_profit_limit_price) };
  }

  let stop_loss = input.stop_loss as { stop_price: number; limit_price?: number } | undefined;
  if (!stop_loss && input.stop_loss_stop_price !== undefined && input.stop_loss_stop_price !== null) {
    stop_loss = {
      stop_price: Number(input.stop_loss_stop_price),
      ...(input.stop_loss_limit_price !== undefined && input.stop_loss_limit_price !== null
        ? { limit_price: Number(input.stop_loss_limit_price) }
        : {}),
    };
  }

  const rawClass = input.order_class as MarketDataOrderNormalized["order_class"];
  const order_class = rawClass || (take_profit || stop_loss ? "bracket" : undefined);
  const extended_hours = typeof input.extended_hours === "boolean" ? input.extended_hours : undefined;

  return {
    ...(order_class ? { order_class } : {}),
    ...(take_profit ? { take_profit } : {}),
    ...(stop_loss ? { stop_loss } : {}),
    ...(extended_hours !== undefined ? { extended_hours } : {}),
  };
}

/**
 * Input normalization per order mode, byte-faithful to the legacy
 * route code it generalizes:
 * - mcp: verbatim (no qty default, no uppercasing, no aliases,
 *   limit_price only) — the MCP command's legacy.
 * - market-data: the /market-data/alpaca/order legacy (uppercase + trim, qty =
 *   qty||quantity||1, side = side||orderAction||buy lowercased,
 *   type = type||orderType||market lowercased,
 *   limit_price||limitPrice, tif day).
 * - trading: the /trading/alpaca/order legacy (trim, no uppercase,
 *   qty||1, side lower default buy, type raw default market,
 *   limit_price only when present, tif day).
 */
export function normalizeMarketDataOrderInput(input: MarketDataOrderRawInput, mode: AlpacaOrderMode): MarketDataOrderNormalized {
  const bracket = extractBracketParams(input);
  if (mode === "mcp") {
    // Strictly verbatim: the framework-level zod defaults (type
    // market, tif day) apply before execute in MCP transport; a
    // direct execute call passes its fields through untouched.
    return {
      symbol: input.symbol as string,
      qty: input.qty as number,
      side: input.side as "buy" | "sell",
      // Narrow cast at the single construction site (the legacy
      // routes passed type/tif through `as any` at each call site).
      type: input.type as MarketDataOrderNormalized["type"],
      limit_price: input.limit_price as number | undefined,
      time_in_force: input.time_in_force as MarketDataOrderNormalized["time_in_force"],
      ...bracket,
    };
  }
  if (mode === "market-data") {
    const symbol = String(input.symbol || "").toUpperCase().trim();
    const qty = Number((input.qty as unknown) || (input.quantity as unknown) || 1);
    const side = String(input.side || input.orderAction || "buy").toLowerCase() as "buy" | "sell";
    const type = String(input.type || input.orderType || "market").toLowerCase();
    const limitRaw = (input.limit_price as unknown) || (input.limitPrice as unknown);
    return {
      symbol,
      qty,
      side,
      type: type as MarketDataOrderNormalized["type"],
      limit_price: limitRaw ? Number(limitRaw) : undefined,
      time_in_force: ((input.time_in_force as string) || "day") as MarketDataOrderNormalized["time_in_force"],
      ...bracket,
    };
  }
  const symbol = String(input.symbol || "").trim();
  const qty = Number(input.qty) || 1;
  const side = String(input.side || "buy").toLowerCase() as "buy" | "sell";
  const type = (input.type as string) || "market";
  return {
    symbol,
    qty,
    side,
    type: type as MarketDataOrderNormalized["type"],
    limit_price: input.limit_price !== undefined ? Number(input.limit_price) : undefined,
    time_in_force: ((input.time_in_force as string) || "day") as MarketDataOrderNormalized["time_in_force"],
    ...bracket,
  };
}

/** Order audit event per mode. */
export function marketDataOrderAuditEvent(mode: AlpacaOrderMode): string {
  return mode === "mcp" ? "alpaca.order.place" : "alpaca.order_placed";
}

/**
 * Order audit payload per mode. mcp and market-data carry the full field
 * set (identical shapes — only the event name differs); trading
 * carries the minimal legacy set {symbol, qty, side, status}.
 */
export function marketDataOrderAuditPayload(
  mode: AlpacaOrderMode,
  normalized: MarketDataOrderNormalized,
  result: { orderId?: unknown; status?: unknown; success?: unknown }
): Record<string, unknown> {
  if (mode === "trading") {
    return { symbol: normalized.symbol, qty: normalized.qty, side: normalized.side, status: result.status };
  }
  return {
    symbol: normalized.symbol,
    qty: normalized.qty,
    side: normalized.side,
    // Legacy MCP audit defaulted a missing type to market; the market-data
    // / trading branches always carry a normalized type already.
    type: normalized.type || "market",
    limitPrice: normalized.limit_price,
    orderId: result.orderId,
    status: result.status,
    success: result.success,
  };
}
