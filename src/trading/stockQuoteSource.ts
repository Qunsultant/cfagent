/**
 * Issue #3272 (S2, programme #3216): the stock quote source port.
 *
 * Why this exists: `/api/etrade/screen` requires an E*TRADE login and gathers
 * its universe through the E*TRADE client, so an Alpaca tenant cannot screen
 * stocks at all — even though the screening math (`DynamicMarketScreener` in
 * `screener.ts`) is already pure and only needs quotes in.
 *
 * This port is the missing interface: "give me a quote for this symbol". A
 * broker platform satisfies it (`getQuote` is on every `ITradingPlatform`), and
 * the gather step below is deliberately boring — bounded concurrency, per-symbol
 * failure capture, no retries, no caching, no substitution.
 *
 * Honesty rules:
 *   - a failed quote is reported under the symbol's own name, never filled in
 *     from another source;
 *   - an empty gather is an empty result with failures attached, not a
 *     fabricated universe;
 *   - the caller (route) decides the universe size; this module only enforces
 *     the hard cap it is given.
 */
import type { BrokerQuote, StockScreenerFilter, StockScreenResult } from "../types";
import type { ITradingPlatform } from "./interfaces";

/** What the stock screen needs from a broker: one quote per symbol. */
export interface StockQuoteSource {
  getQuote(symbol: string): Promise<BrokerQuote>;
}

/** Adapt any platform into a quote source. Null when the platform has no quote read. */
export function platformQuoteSource(platform: ITradingPlatform | null | undefined): StockQuoteSource | null {
  if (!platform || typeof platform.getQuote !== "function") return null;
  const getQuote = platform.getQuote.bind(platform);
  return { getQuote: (symbol) => getQuote(symbol) };
}

export interface QuoteFailure {
  symbol: string;
  reason: string;
}

export interface QuoteGather {
  quotes: BrokerQuote[];
  failures: QuoteFailure[];
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

/**
 * Gather quotes for `symbols`. A symbol whose read throws is reported in
 * `failures` and contributes no quote — the screen then runs on what was
 * actually read, and says so.
 */
export async function gatherQuotes(
  source: StockQuoteSource,
  symbols: string[],
  concurrency = 6,
): Promise<QuoteGather> {
  const clean = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
  const outcomes = await mapLimit(clean, concurrency, async (symbol) => {
    try {
      const quote = await source.getQuote(symbol);
      if (!quote) return { symbol, quote: null, reason: "The broker returned no quote." };
      return { symbol, quote, reason: null };
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "The quote read failed.";
      return { symbol, quote: null, reason };
    }
  });

  const quotes: BrokerQuote[] = [];
  const failures: QuoteFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.quote) quotes.push(outcome.quote);
    else failures.push({ symbol: outcome.symbol, reason: outcome.reason ?? "The quote read failed." });
  }
  return { quotes, failures };
}

export interface NeutralStockScreen {
  quotes: QuoteGather;
  result: StockScreenResult;
}

/**
 * Screen `symbols` with the caller's filter, using only quotes from `source`.
 *
 * The screener is instantiated here (inside the trading layer) so a route can
 * call this through the barrel without importing a trading-internal module —
 * the same #290 boundary that shaped #3272 S1.
 */
export async function screenSymbolsWithSource(
  source: StockQuoteSource,
  symbols: string[],
  filter: StockScreenerFilter = {},
  concurrency = 6,
): Promise<NeutralStockScreen> {
  const quotes = await gatherQuotes(source, symbols, concurrency);
  const { DynamicMarketScreener } = await import("./screener");
  const result = new DynamicMarketScreener().screenWithQuotes(quotes.quotes, filter);
  return { quotes, result };
}
