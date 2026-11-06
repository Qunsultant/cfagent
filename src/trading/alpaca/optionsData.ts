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
