/**
 * Issue #1317 (Yahoo provider slice, epic #1116) — characterization
 * pins for the CURRENT yahoo behaviour, written BEFORE the reroute.
 *
 * These pins capture the behaviour the slice must preserve:
 *  - screenerPipeline yahoo mode: quote shape, universe listing,
 *    honest failure (all-fail throws, partial qualifies, no fallback);
 *  - the MarketDataResearchQuote → pipeline-quote adaptation gate (non-live or
 *    non-positive quotes are refused, never re-stamped);
 *  - the P1 platform yahoo adapter's reference parity with the market-data
 *    engine (payload by reference, provenance envelope).
 *
 * They were written against the pre-slice homes (yahooDataSource.ts);
 * the slice moved those helpers into screenerPipeline.ts, changing
 * ONLY the import paths — the assertions stay byte-identical, so a
 * green run after the move proves no behaviour change.
 */
import { describe, it, expect } from "vitest";
import {
  fetchYahooQuotes,
  yahooUniverseListings,
  yahooQuoteToPipelineQuote,
  type YahooScreenerDeps,
} from "../src/trading/screenerPipeline";
import { acquireUniverse } from "../src/trading/screenerPipeline";
import { createYahooDataProvider } from "../src/trading/dataProviders/adapters";
import { YFINANCE_MARKET_UNIVERSE } from "../src/config/curatedStockUniverse";
import type { MarketDataResearchQuote } from "../src/types";
import type { IMarketDataProvider } from "../src/patterns/interfaces";

const fastPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const noSleep = async () => {};

function liveQuote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    companyName: `${symbol} Inc.`,
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    bid: price - 0.05,
    ask: price + 0.05,
    volume: 1000,
    open: price,
    high: price,
    low: price,
    previousClose: price - 1,
    timestamp: "2026-10-24T00:00:00.000Z",
    currency: "USD",
    rsi14: 55,
    macdSignal: "bullish",
  };
}

function deps(over: Partial<YahooScreenerDeps> = {}): YahooScreenerDeps {
  return {
    fetchYahooQuote: async (s: string) => liveQuote(s),
    retryPolicy: fastPolicy,
    retrySleep: noSleep,
    ...over,
  };
}

function fixtureMarketData(): IMarketDataProvider {
  const quote = liveQuote("AAPL", 250);
  return {
    providerId: "yfinance",
    name: "fixture",
    isConfigured: () => true,
    getQuote: async (s: string) => liveQuote(s, 250),
    getFundamentals: async (s: string) => ({
      provenance: "live",
      symbol: s,
      companyName: `${s} Inc.`,
      sector: "Technology",
      industry: "Software",
      description: "fixture",
      marketCap: 1_000_000,
      fiftyTwoWeekHigh: 300,
      fiftyTwoWeekLow: 200,
    }),
    getHistoricalBars: async (s: string, _tf?: string, limit?: number) => {
      const n = limit ?? 5;
      return Array.from({ length: n }, (_, i) => ({
        provenance: "live" as const,
        timestamp: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 1000,
      }));
    },
  };
}

describe("characterization: screenerPipeline yahoo mode (pre-#1317 behaviour)", () => {
  it("quotes carry the pipeline shape, Yahoo source, and indicator data fields", async () => {
    const out = await acquireUniverse({
      mode: "yahoo",
      symbols: [{ symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 0, sector: "Technology" }],
      maxSymbols: 1,
      yahooDeps: deps(),
    });
    expect(out.provider).toBe("yahoo");
    expect(out.quotes).toHaveLength(1);
    const q = out.quotes[0];
    expect(q.symbol).toBe("AAPL");
    expect(q.source).toBe("Yahoo Finance");
    expect(q.quoteStatus).toBe("LIVE");
    expect(q.lastPrice).toBe(100);
    expect(q.price).toBe(100);
    expect(q.previousClose).toBe(99);
    expect(q.rsi).toBe(55);
    expect(q.macdSignal).toBe("bullish");
    expect(out.partial).toBeUndefined();
  });

  it("the universe listing is the curated universe as listings", () => {
    const listings = yahooUniverseListings();
    expect(listings.length).toBe(YFINANCE_MARKET_UNIVERSE.length);
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) {
      expect(typeof l.symbol).toBe("string");
      expect(typeof l.companyName).toBe("string");
    }
    const curated = new Map(YFINANCE_MARKET_UNIVERSE.map((c) => [c.symbol, c]));
    for (const l of listings) {
      expect(curated.has(l.symbol)).toBe(true);
    }
  });

  it("all-fail fails the run visibly; partial qualifies without fallback", async () => {
    const failing = deps({ fetchYahooQuote: async () => { throw new Error("boom"); } });
    await expect(
      acquireUniverse({
        mode: "yahoo",
        symbols: [
          { symbol: "AAPL", companyName: "Apple", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 0, sector: "Technology" },
          { symbol: "MSFT", companyName: "Microsoft", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 0, sector: "Technology" },
        ],
        maxSymbols: 2,
        yahooDeps: failing,
      })
    ).rejects.toThrow(/Yahoo Finance unavailable/);

    const partial = deps({
      fetchYahooQuote: async (s: string) => {
        if (s === "MSFT") throw new Error("boom");
        return liveQuote(s);
      },
    });
    const out = await acquireUniverse({
      mode: "yahoo",
      symbols: [
        { symbol: "AAPL", companyName: "Apple", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 0, sector: "Technology" },
        { symbol: "MSFT", companyName: "Microsoft", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 0, sector: "Technology" },
      ],
      maxSymbols: 2,
      yahooDeps: partial,
    });
    expect(out.quotes.map((q) => q.symbol)).toEqual(["AAPL"]);
    expect(out.partial?.quotedCount).toBe(1);
    expect(out.partial?.requestedCount).toBe(2);
    expect(out.partial?.failedSymbols).toEqual(["MSFT"]);
    expect(out.partial?.failureReasons).toEqual({ "yahoo-unavailable": 1 });
  });

  it("adaptation refuses non-live and non-positive quotes", () => {
    expect(yahooQuoteToPipelineQuote({ ...liveQuote("AAPL"), provenance: "generated" as never })).toBeNull();
    expect(yahooQuoteToPipelineQuote({ ...liveQuote("AAPL"), price: 0 })).toBeNull();
    expect(yahooQuoteToPipelineQuote({ ...liveQuote("AAPL"), price: -5 })).toBeNull();
    expect(yahooQuoteToPipelineQuote(liveQuote("AAPL"))).not.toBeNull();
  });

  it("fetchYahooQuotes preserves input order and skips failures", async () => {
    const out = await fetchYahooQuotes(["B", "A", "C"], deps({
      fetchYahooQuote: async (s: string) => {
        if (s === "A") throw new Error("boom");
        return liveQuote(s);
      },
    }));
    expect(out.map((q) => q.symbol)).toEqual(["B", "C"]);
  });
});

describe("characterization: P1 platform yahoo adapter parity", () => {
  it("quotes/bars/fundamentals/news pass through by reference with the yahoo envelope", async () => {
    const marketDataResearch = fixtureMarketData();
    const adapter = createYahooDataProvider(marketDataResearch);
    const q = await adapter.getQuote!("AAPL");
    expect(q.providerId).toBe("yahoo");
    expect(q.capability).toBe("quotes");
    expect(q.result.symbol).toBe("AAPL");
    expect(q.result.price).toBe(250);
    const bars = await adapter.getHistoricalBars!("AAPL");
    expect(bars.providerId).toBe("yahoo");
    expect(bars.capability).toBe("historicalBars");
    expect(Array.isArray(bars.result)).toBe(true);
    expect(bars.result.length).toBeGreaterThan(0);
    const f = await adapter.getFundamentals!("AAPL");
    expect(f.providerId).toBe("yahoo");
    expect(f.capability).toBe("fundamentals");
    expect(f.result.companyName).toBe("AAPL Inc.");
    // #3932: the Yahoo adapter declares news (Yahoo News search);
    // this test never calls getNews, so no fetch is stubbed here.
    expect(adapter.capabilities).toEqual(["quotes", "historicalBars", "fundamentals", "news"]);
    expect(adapter.isConfigured()).toBe(true);
  });
});
