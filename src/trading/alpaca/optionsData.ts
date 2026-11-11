/**
 * Issue #3233 (program #3216): Alpaca options data plane.
 *
 * E*TRADE serves option chains and expiry dates today; Alpaca's platform
 * adapter did not, which made "Alpaca supports what E*TRADE supports" false.
 * This module is the missing read path: option contracts (the chain's rows) and
 * option snapshots (the quote/greeks behind each row), mapped as pure data so
 * the platform adapter can assemble a `BrokerOptionChain`.
 *
 * Honesty rules that shape every mapping here (they are the repo's standing
 * ones — #1555 invented quote fields, #913 provider labelling):
 *   - A field Alpaca does not send is left `undefined`. Nothing is defaulted to
 *     zero, and no field is synthesised from another provider.
 *   - A contract with no usable quote (no bid, no ask, no trade) is OMITTED
 *     from the chain rather than emitted with fabricated prices.
 *   - `lastPrice` is the last trade when present; otherwise the bid/ask
 *     midpoint, which is a documented derivation, not an invented print.
 *   - Upstream error bodies are never surfaced: the caller gets a short,
 *     broker-named message (same rule as the #3197 connect fix).
 *
 * Endpoints (Alpaca Trading API v2 / Market Data v1beta1):
 *   GET {trading}/v2/options/contracts?underlying_symbols=…
 *   GET {data}/v1beta1/options/snapshots/{underlying}?symbols=…
 */

import type {
  BrokerOptionChain,
  BrokerOptionContract,
  BrokerOptionExpireDate,
  Env,
} from "../../types";
import type {
  OptionsChainRequest,
  OptionsChainSource,
} from "../dataProviders/contract";
import type { OptionRequestBudget } from "../interfaces";
import { normalizeAlpacaBaseUrl } from "./credentials";

export interface AlpacaOptionsConfig {
  /** Trading host — paper or live, already resolved by the caller. */
  tradingUrl: string;
  /** Market-data host. */
  dataUrl: string;
  /** APCA-API-KEY-ID / APCA-API-SECRET-KEY headers. */
  headers: Record<string, string>;
  /** Options feed; `indicative` works without an OPRA subscription. */
  feed?: string;
  /**
   * Issue #3515 S1: the shared Alpaca outbound limiter (the platform
   * adapter passes its provider's `outboundLimiter`). When supplied,
   * each options fetch awaits one token from the same Alpaca budget as
   * the trading/market-data calls; when absent, the calls are
   * unthrottled (direct callers without a provider instance).
   */
  rateLimiter?: import("../../security/outboundRateLimiter").OutboundRateLimiter;
}

export interface AlpacaOptionContractRow {
  /** OSI symbol, e.g. AAPL260116C00200000. */
  symbol: string;
  underlying: string;
  /** YYYY-MM-DD. */
  expirationDate: string;
  strikePrice: number;
  type: "call" | "put";
}

export interface AlpacaOptionQuoteRow {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  impliedVolatility?: number;
}

const CONTRACT_PAGE_CAP = 5;
const CONTRACT_LIMIT = 10000;

/**
 * Issue #3158 — single paper/live resolver for the Alpaca adapter.
 * The default base URL is the paper host; a base URL counts as live
 * only when it is set and is not a paper host. The trading client
 * (AlpacaMarketDataProvider.getTradingUrl) uses the same default, so
 * status and placement can never disagree about paper vs live.
 *
 * Moved here from platform.ts by #3990: the data adapter needs the
 * same resolution for its options source, and this module is the
 * low-level home both the platform and the adapter read. platform.ts
 * re-exports it, so existing importers are untouched.
 */
const ALPACA_PAPER_HOST = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_HOST = "https://api.alpaca.markets";

/**
 * Issue #3866 — the configured URL, normalized once.
 *
 * `resolveAlpacaTradingBase` used to answer a hardcoded host for the `TEST`
 * selection while the client used `env.ALPACA_BASE_URL`. Status therefore
 * advertised a URL the client never called, which is how four portfolio reads
 * failed against an apparently healthy connection.
 */
export function configuredAlpacaBase(env: Env): string {
  return normalizeAlpacaBaseUrl(env.ALPACA_BASE_URL);
}

export function resolveAlpacaTradingBase(
  env: Env,
  overrideEnv?: string,
): { baseUrl: string; isLive: boolean; source: "pin" | "selection" | "inference" } {
  // Issue #3233: an explicit trading type wins over inference. Without it the
  // legacy rule stands (paper host = paper), so nothing silently changes for
  // an environment that only sets ALPACA_BASE_URL.
  const explicit = String(env.ALPACA_TRADING_TYPE ?? "").trim().toLowerCase();
  const configured = configuredAlpacaBase(env);
  if (explicit === "paper") {
    return { baseUrl: configured.includes("paper-api") ? configured : ALPACA_PAPER_HOST, isLive: false, source: "pin" };
  }
  if (explicit === "live") {
    return { baseUrl: configured.includes("paper-api") ? ALPACA_LIVE_HOST : configured, isLive: true, source: "pin" };
  }
  // Issue #3272: the persisted selection is authoritative when the deployment
  // has not pinned a trading type. TEST means paper, PROD means live - the
  // same mapping the catalog declares for every broker (#3232), so the hub
  // switch now means the same thing on both brokers instead of being an
  // E*TRADE-only control that Alpaca silently ignored.
  const selection = String(overrideEnv ?? "").trim().toUpperCase();
  if (selection === "TEST" || selection === "PAPER" || selection === "SANDBOX") {
    return { baseUrl: configured.includes("paper-api") ? configured : ALPACA_PAPER_HOST, isLive: false, source: "selection" };
  }
  if (selection === "PROD" || selection === "LIVE") {
    return { baseUrl: configured.includes("paper-api") ? ALPACA_LIVE_HOST : configured, isLive: true, source: "selection" };
  }
  return { baseUrl: configured, isLive: !configured.includes("paper-api"), source: "inference" };
}

/**
 * Issue #3990: the options config, built once from env. The platform
 * adapter's `optionsConfig()` and the data adapter's options source
 * both read this — one construction, no second copy of the key/feed
 * resolution. Without an override the base resolves by inference
 * (paper host when unconfigured), so a data read never silently
 * targets a live host.
 */
export function buildAlpacaOptionsConfig(
  env: Env | undefined,
  rateLimiter?: AlpacaOptionsConfig["rateLimiter"],
  overrideEnv?: string,
): AlpacaOptionsConfig {
  const safeEnv = (env ?? {}) as Env;
  const { baseUrl } = resolveAlpacaTradingBase(safeEnv, overrideEnv);
  return {
    tradingUrl: baseUrl,
    dataUrl: safeEnv.ALPACA_DATA_URL || "https://data.alpaca.markets",
    headers: {
      "APCA-API-KEY-ID": safeEnv.ALPACA_API_KEY || safeEnv.ALPACA_API_KEY_ID || "",
      "APCA-API-SECRET-KEY": safeEnv.ALPACA_SECRET_KEY || safeEnv.ALPACA_API_SECRET_KEY || "",
    },
    feed: safeEnv.ALPACA_OPTIONS_FEED,
    rateLimiter,
  };
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Fetch the option contracts for one underlying.
 *
 * Filters the endpoint supports natively are pushed down (expiration window,
 * strike, call/put); everything else is filtered by the caller. Pagination is
 * bounded — an unbounded crawl against a large chain is a cost defect, and the
 * cap is stated rather than silently truncating a page loop.
 */
export async function fetchAlpacaOptionContracts(
  cfg: AlpacaOptionsConfig,
  params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    chainType?: "CALL" | "PUT" | "CALLPUT";
  },
): Promise<AlpacaOptionContractRow[]> {
  const rows: AlpacaOptionContractRow[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < CONTRACT_PAGE_CAP; page++) {
    const query = new URLSearchParams();
    query.set("underlying_symbols", params.symbol.trim().toUpperCase());
    query.set("limit", String(CONTRACT_LIMIT));
    if (params.chainType === "CALL") query.set("type", "call");
    if (params.chainType === "PUT") query.set("type", "put");
    if (params.expiryYear && params.expiryMonth && params.expiryDay) {
      const day = isoDate(params.expiryYear, params.expiryMonth, params.expiryDay);
      query.set("expiration_date_gte", day);
      query.set("expiration_date_lte", day);
    } else if (params.expiryYear && params.expiryMonth) {
      const start = isoDate(params.expiryYear, params.expiryMonth, 1);
      const end = isoDate(params.expiryYear, params.expiryMonth, 28);
      query.set("expiration_date_gte", start);
      // Alpaca filters by exact date range; a month window is widened by the
      // caller-side filter below when the month has more than 28 days.
      query.set("expiration_date_lte", end);
    }
    if (params.strikePrice !== undefined) query.set("strike_price_gte", String(params.strikePrice));
    if (pageToken) query.set("page_token", pageToken);

    const url = `${cfg.tradingUrl.replace(/\/$/, "")}/v2/options/contracts?${query.toString()}`;
    // Issue #3515 S1: one Alpaca token per page fetch, shared with the provider.
    await cfg.rateLimiter?.acquire();
    const res = await fetch(url, { headers: cfg.headers });
    if (!res.ok) {
      throw new Error(`Alpaca option contracts unavailable [HTTP ${res.status}].`);
    }
    const payload = (await res.json().catch(() => ({}))) as {
      option_contracts?: any[];
      next_page_token?: string | null;
    };
    for (const c of payload.option_contracts ?? []) {
      const symbol = String(c?.symbol ?? "");
      const expirationDate = String(c?.expiration_date ?? "");
      const strikePrice = num(c?.strike_price);
      const type = String(c?.type ?? "").toLowerCase();
      if (!symbol || !expirationDate || strikePrice === undefined) continue;
      if (type !== "call" && type !== "put") continue;
      rows.push({
        symbol,
        underlying: String(c?.underlying_symbol ?? params.symbol).toUpperCase(),
        expirationDate,
        strikePrice,
        type,
      });
    }
    pageToken = payload.next_page_token ?? undefined;
    if (!pageToken) break;
  }

  return rows.filter((row) => {
    if (params.chainType === "CALL" && row.type !== "call") return false;
    if (params.chainType === "PUT" && row.type !== "put") return false;
    if (params.strikePrice !== undefined && row.strikePrice !== params.strikePrice) return false;
    if (params.expiryYear && params.expiryMonth) {
      const [y, m, d] = row.expirationDate.split("-").map((part) => Number(part));
      if (y !== params.expiryYear || m !== params.expiryMonth) return false;
      if (params.expiryDay && d !== params.expiryDay) return false;
    }
    return true;
  });
}

/**
 * Fetch snapshots for a set of contract symbols.
 *
 * The snapshot carries the quote, the last trade, and (where the data plan
 * includes it) greeks and implied volatility. Symbols Alpaca does not return
 * are simply absent from the map — callers must treat "missing" as "no live
 * quote for this contract", never as zero.
 */
export async function fetchAlpacaOptionSnapshots(
  cfg: AlpacaOptionsConfig,
  underlying: string,
  symbols: readonly string[],
): Promise<Map<string, AlpacaOptionQuoteRow>> {
  const out = new Map<string, AlpacaOptionQuoteRow>();
  if (symbols.length === 0) return out;

  const query = new URLSearchParams();
  query.set("symbols", symbols.join(","));
  if (cfg.feed) query.set("feed", cfg.feed);

  const url = `${cfg.dataUrl.replace(/\/$/, "")}/v1beta1/options/snapshots/${encodeURIComponent(
    underlying.toUpperCase(),
  )}?${query.toString()}`;
  // Issue #3515 S1: one Alpaca token per snapshot fetch, shared with the provider.
  await cfg.rateLimiter?.acquire();
  const res = await fetch(url, { headers: cfg.headers });
  if (!res.ok) {
    throw new Error(`Alpaca option snapshots unavailable [HTTP ${res.status}].`);
  }
  const payload = (await res.json().catch(() => ({}))) as { snapshots?: Record<string, any> };
  for (const [symbol, snap] of Object.entries(payload.snapshots ?? {})) {
    const quote = snap?.latestQuote ?? {};
    const trade = snap?.latestTrade ?? {};
    const greeks = snap?.greeks ?? {};
    const row: AlpacaOptionQuoteRow = {
      symbol,
      bid: num(quote.bp),
      ask: num(quote.ap),
      last: num(trade.p),
      volume: num(snap?.dailyBar?.v),
      delta: num(greeks.delta),
      gamma: num(greeks.gamma),
      theta: num(greeks.theta),
      vega: num(greeks.vega),
      rho: num(greeks.rho),
      impliedVolatility: num(snap?.impliedVolatility),
    };
    out.set(symbol, row);
  }
  return out;
}

/**
 * The price a chain row shows for a contract.
 *
 * Last trade when Alpaca supplies one; otherwise the bid/ask midpoint, which is
 * arithmetic on two real quotes. `undefined` when neither exists — the caller
 * omits the contract instead of inventing a price.
 */
export function displayPriceFor(row: AlpacaOptionQuoteRow): number | undefined {
  if (row.last !== undefined) return row.last;
  if (row.bid !== undefined && row.ask !== undefined) return (row.bid + row.ask) / 2;
  return undefined;
}

/**
 * Issue #3990: the expiration calendar for one symbol, from the
 * contracts endpoint. Extracted verbatim from
 * `AlpacaTradingPlatform.getOptionExpireDates` — the platform
 * delegates here now, and the data adapter's options source reads
 * the same function, so the two surfaces cannot disagree about
 * which expirations exist.
 */
export async function fetchAlpacaOptionExpireDates(
  cfg: AlpacaOptionsConfig,
  symbol: string,
  expiryType?: string,
  requestBudget?: OptionRequestBudget,
): Promise<BrokerOptionExpireDate[]> {
  if (requestBudget && !requestBudget.tryConsume()) {
    throw new Error("Alpaca option expire-date request budget exhausted for this run.");
  }
  const contracts = await fetchAlpacaOptionContracts(cfg, { symbol });
  const seen = new Set<string>();
  const dates: BrokerOptionExpireDate[] = [];
  for (const row of contracts) {
    if (seen.has(row.expirationDate)) continue;
    seen.add(row.expirationDate);
    const [year, month, day] = row.expirationDate.split("-").map((part) => Number(part));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) continue;
    dates.push({ year, month, day, ...(expiryType ? { expiryType } : {}) });
  }
  dates.sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day);
  return dates;
}

/**
 * Issue #3990: one option chain, assembled from contracts +
 * snapshots. Extracted verbatim from
 * `AlpacaTradingPlatform.getOptionChains` — the platform delegates
 * here now, and the data adapter's options source reads the same
 * function, so the two surfaces cannot disagree about a chain.
 *
 * The underlying quote comes from the caller: the platform passes
 * its own getQuote, the data adapter passes its wrapped provider's
 * getQuote. Only the quote's symbol + lastPrice are read (the
 * strike-window pivot), so either shape serves.
 *
 * Honesty rules (see the module header): a contract with no
 * two-sided quote or no displayable price is omitted rather than
 * emitted with invented numbers; greeks and IV appear only when
 * Alpaca sends them.
 */
export async function assembleAlpacaOptionChain(
  cfg: AlpacaOptionsConfig,
  params: OptionsChainRequest,
  fetchUnderlyingQuote: (symbol: string) => Promise<{ symbol: string; lastPrice: number }>,
  requestBudget?: OptionRequestBudget,
): Promise<BrokerOptionChain | null> {
  if (requestBudget && !requestBudget.tryConsume()) {
    throw new Error("Alpaca option chain request budget exhausted for this run.");
  }
  const contracts = await fetchAlpacaOptionContracts(cfg, {
    symbol: params.symbol,
    expiryYear: params.expiryYear,
    expiryMonth: params.expiryMonth,
    expiryDay: params.expiryDay,
    strikePrice: params.strikePrice,
    chainType: params.chainType,
  });
  if (contracts.length === 0) return null;

  if (requestBudget && !requestBudget.tryConsume()) {
    throw new Error("Alpaca option snapshot request budget exhausted for this run.");
  }
  const symbols = contracts.map((row) => row.symbol);
  const snapshots = await fetchAlpacaOptionSnapshots(cfg, params.symbol, symbols);

  const underlying = await fetchUnderlyingQuote(params.symbol);
  const byStrike = new Map<number, { call?: BrokerOptionContract; put?: BrokerOptionContract }>();
  let matched = 0;

  for (const row of contracts) {
    const quote = snapshots.get(row.symbol);
    if (!quote) continue;
    if (quote.bid === undefined || quote.ask === undefined) continue;
    const lastPrice = displayPriceFor(quote);
    if (lastPrice === undefined) continue;
    const contract: BrokerOptionContract = {
      optionType: row.type === "call" ? "CALL" : "PUT",
      strikePrice: row.strikePrice,
      symbol: row.symbol,
      bid: quote.bid,
      ask: quote.ask,
      lastPrice,
      ...(quote.volume !== undefined ? { volume: quote.volume } : {}),
      ...(quote.delta !== undefined ? { delta: quote.delta } : {}),
      ...(quote.gamma !== undefined ? { gamma: quote.gamma } : {}),
      ...(quote.theta !== undefined ? { theta: quote.theta } : {}),
      ...(quote.vega !== undefined ? { vega: quote.vega } : {}),
      ...(quote.rho !== undefined ? { rho: quote.rho } : {}),
      ...(quote.impliedVolatility !== undefined
        ? { impliedVolatility: quote.impliedVolatility }
        : {}),
    };
    const pair = byStrike.get(row.strikePrice) ?? {};
    if (row.type === "call") pair.call = contract;
    else pair.put = contract;
    byStrike.set(row.strikePrice, pair);
    matched++;
  }

  if (matched === 0) return null;

  let strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (params.noOfStrikes && strikes.length > params.noOfStrikes) {
    // Centre the window on the underlying so the returned strikes are the
    // ones around the money, the same intent as E*TRADE's noOfStrikes.
    const pivot = strikes.reduce((best, s) =>
      Math.abs(s - underlying.lastPrice) < Math.abs(best - underlying.lastPrice) ? s : best,
    );
    const half = Math.floor(params.noOfStrikes / 2);
    const idx = strikes.indexOf(pivot);
    strikes = strikes.slice(Math.max(0, idx - half), Math.max(0, idx - half) + params.noOfStrikes);
  }

  return {
    symbol: underlying.symbol,
    underlyingPrice: underlying.lastPrice,
    selectedExpiry:
      params.expiryYear && params.expiryMonth && params.expiryDay
        ? { year: params.expiryYear, month: params.expiryMonth, day: params.expiryDay }
        : undefined,
    pairs: strikes.map((strike) => byStrike.get(strike) ?? {}),
  };
}

/**
 * Issue #3990: the data-provider options source over one config.
 * The adapter factory builds the config from env and hands the
 * wrapped provider's getQuote in as the underlying fetcher; the
 * source's two methods are the two halves of the `optionsChains`
 * capability. `ETradeOptionChain` is an alias of `BrokerOptionChain`
 * (types.ts), so the assembled chain IS the contract shape — no
 * second mapping.
 */
export function createAlpacaOptionsChainSource(
  cfg: AlpacaOptionsConfig,
  fetchUnderlyingQuote: (symbol: string) => Promise<{ symbol: string; lastPrice: number }>,
): OptionsChainSource {
  return {
    getChain: (request, _runContext, requestBudget) =>
      assembleAlpacaOptionChain(cfg, request, fetchUnderlyingQuote, requestBudget),
    getExpiryDates: (symbol, _runContext, requestBudget) =>
      fetchAlpacaOptionExpireDates(cfg, symbol, undefined, requestBudget),
  };
}
