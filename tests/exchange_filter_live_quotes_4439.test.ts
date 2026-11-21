/**
 * Issue #4439 (N9) — the exchange filter is wired into the live-quote
 * paths. An exchange=NYSE run filters to NYSE-listed symbols on the
 * yahoo / live-quotes / etrade-only modes, stamps the applied exchange
 * on the run record, and refuses loud (naming the scope) when the scope
 * yields no listings. The filter stage itself rejects exchange
 * mismatches on quotes that carry a listing exchange, and passes quotes
 * with no listing exchange (no data means no verdict — the #950 sector
 * precedent; acquisition is the enforcement point for pipeline runs).
 *
 * Fixtures are deterministic stubs. No live market data, no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetQuoteCache } from "../src/services/quoteCache";

// Issue #5822: the quote binds serve fresh cached rows (quoteCache,
// 5-min TTL). These tests assert live provider calls, so every test
// starts from a cold cache.
beforeEach(() => {
  __resetQuoteCache();
});
import {
  acquireUniverse,
  bindEtradeQuoteDeps,
  bindLiveQuotesQuoteDeps,
} from "../src/trading/screenerPipeline";
import { DynamicMarketScreener } from "../src/trading/screener";
import { createYahooStockScreener } from "../src/services/screeningRuntime";
import { YFINANCE_MARKET_UNIVERSE } from "../src/config/curatedStockUniverse";
import type {
  DataProvider,
  DataRunContext,
} from "../src/trading/dataProviders/contract";
import type { ETradeQuote, MarketDataResearchQuote } from "../src/types";

const RUN: DataRunContext = { runId: "run-4439", userLogin: "trader1" };

// Mixed-exchange fixture listings: two NYSE, one NASDAQ, one AMEX.
// The listing exchange is lowercase here (the listings feed's
// NasdaqExchange spelling); the filter's exchange is uppercase.
const listings = (entries: Array<[string, string]>) =>
  entries.map(
    ([symbol, exchange]) =>
      ({
        symbol,
        companyName: `${symbol} Inc`,
        exchange,
        change: 0,
        changePercent: 0,
      }) as any
  );
const MIXED = listings([
  ["JPM", "nyse"],
  ["XOM", "nyse"],
  ["AAPL", "nasdaq"],
  ["ABT", "amex"],
]);
const NASDAQ_ONLY = listings([
  ["AAPL", "nasdaq"],
  ["MSFT", "nasdaq"],
]);

function etradeQuote(symbol: string, price = 100): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    lastPrice: price,
    price,
    change: 1,
    changePercent: 1,
    bid: price - 0.05,
    ask: price + 0.05,
    volume: 1000,
    open: price,
    high: price,
    low: price,
    source: "E*TRADE live",
    quoteStatus: "LIVE",
  } as ETradeQuote;
}

function yahooQuote(symbol: string, price = 100): MarketDataResearchQuote {
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
    timestamp: "2026-10-25T00:00:00.000Z",
    currency: "USD",
  } as MarketDataResearchQuote;
}

type ProviderStub = {
  provider: DataProvider;
  calls: { single: string[]; batch: string[][] };
};

/** Provider stub: serves `served`, throws for the rest, counts calls. */
function stubProvider(
  id: string,
  served: Record<string, ETradeQuote | MarketDataResearchQuote>
): ProviderStub {
  const calls = { single: [] as string[], batch: [] as string[][] };
  const provider = {
    id,
    capabilities: ["quotes"],
    getQuote: async (symbol: string) => {
      calls.single.push(symbol);
      const quote = served[symbol];
      if (!quote) throw new Error(`${id} returned no quote for ${symbol}`);
      return { providerId: id, capability: "quotes", result: quote };
    },
    getQuotesBatch: async (symbols: string[]) => {
      calls.batch.push(symbols);
      return {
        providerId: id,
        capability: "quotes",
        result: symbols.filter((s) => served[s]).map((s) => served[s]),
      };
    },
  };
  return { provider: provider as unknown as DataProvider, calls };
}

const allEtradeQuotes = () =>
  Object.fromEntries(MIXED.map((l) => [l.symbol, etradeQuote(l.symbol as string)])) as Record<
    string,
    ETradeQuote
  >;
const allYahooQuotes = () =>
  Object.fromEntries(MIXED.map((l) => [l.symbol, yahooQuote(l.symbol as string)])) as Record<
    string,
    MarketDataResearchQuote
  >;

describe("exchange scope in acquireUniverse (#4439)", () => {
  it("yahoo mode quotes only the requested exchange's listings and stamps listingExchange", async () => {
    const fetched: string[] = [];
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => {
        fetched.push(symbol);
        return yahooQuote(symbol);
      },
    };
    const acquired = await acquireUniverse({
      mode: "yahoo",
      symbols: MIXED,
      yahooDeps,
      exchange: "NYSE",
    });

    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(["JPM", "XOM"]);
    expect(acquired.quotes.every((q) => q.listingExchange === "NYSE")).toBe(true);
    expect(acquired.discovery.candidateCount).toBe(2);
    expect(acquired.discovery.listingCount).toBe(2);
    // The fetch itself was scoped: the provider was never asked for the
    // NASDAQ/AMEX symbols.
    expect(fetched.sort()).toEqual(["JPM", "XOM"]);
  });

  it("live-quotes mode quotes only the requested exchange's listings and stamps listingExchange", async () => {
    const etrade = stubProvider("etrade", allEtradeQuotes());
    const yahoo = stubProvider("yahoo", allYahooQuotes());
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: MIXED,
      quoteDeps,
      exchange: "NYSE",
    });

    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(["JPM", "XOM"]);
    expect(acquired.quotes.every((q) => q.listingExchange === "NYSE")).toBe(true);
    expect(acquired.discovery.candidateCount).toBe(2);
    const requested = [...etrade.calls.single, ...etrade.calls.batch.flat()];
    expect(requested.sort()).toEqual(["JPM", "XOM"]);
    expect(yahoo.calls.single).toHaveLength(0);
    expect(yahoo.calls.batch).toHaveLength(0);
  });

  it("etrade-only mode quotes only the requested exchange's listings and stamps listingExchange", async () => {
    const etrade = stubProvider("etrade", allEtradeQuotes());
    const quoteDeps = bindEtradeQuoteDeps(etrade.provider, RUN);

    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: MIXED,
      quoteDeps,
      exchange: "NYSE",
    });

    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(["JPM", "XOM"]);
    expect(acquired.quotes.every((q) => q.listingExchange === "NYSE")).toBe(true);
    expect(acquired.discovery.candidateCount).toBe(2);
    const requested = [...etrade.calls.single, ...etrade.calls.batch.flat()];
    expect(requested.sort()).toEqual(["JPM", "XOM"]);
  });

  it("no exchange requested leaves every mode's universe unchanged", async () => {
    const etrade = stubProvider("etrade", allEtradeQuotes());
    const quoteDeps = bindEtradeQuoteDeps(etrade.provider, RUN);
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: MIXED,
      quoteDeps,
    });
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual([
      "AAPL",
      "ABT",
      "JPM",
      "XOM",
    ]);
    // Without a requested exchange every quote still carries its
    // listing exchange, stamped from the listing row.
    const bySym = new Map(acquired.quotes.map((q) => [q.symbol, q.listingExchange]));
    expect(bySym.get("JPM")).toBe("NYSE");
    expect(bySym.get("XOM")).toBe("NYSE");
    expect(bySym.get("AAPL")).toBe("NASDAQ");
    expect(bySym.get("ABT")).toBe("AMEX");
  });

  it("exchange=ALL leaves every mode's universe unchanged", async () => {
    const fetched: string[] = [];
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => {
        fetched.push(symbol);
        return yahooQuote(symbol);
      },
    };
    const acquired = await acquireUniverse({
      mode: "yahoo",
      symbols: MIXED,
      yahooDeps,
      exchange: "ALL",
    });
    expect(acquired.quotes).toHaveLength(4);
    expect(fetched.sort()).toEqual(["AAPL", "ABT", "JPM", "XOM"]);
  });

  it("an exchange scope with no listings refuses loud naming the scope (etrade-only)", async () => {
    const etrade = stubProvider("etrade", allEtradeQuotes());
    const quoteDeps = bindEtradeQuoteDeps(etrade.provider, RUN);
    await expect(
      acquireUniverse({
        mode: "etrade-only",
        symbols: NASDAQ_ONLY,
        quoteDeps,
        exchange: "NYSE",
      })
    ).rejects.toThrow(/in exchange scope NYSE/);
  });

  it("an exchange scope with no listings refuses loud naming the scope (yahoo)", async () => {
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => yahooQuote(symbol),
    };
    await expect(
      acquireUniverse({
        mode: "yahoo",
        symbols: NASDAQ_ONLY,
        yahooDeps,
        exchange: "NYSE",
      })
    ).rejects.toThrow(/in exchange scope NYSE/);
  });

  it("an exchange scope with no listings returns empty with the scope in the message (live-quotes)", async () => {
    const etrade = stubProvider("etrade", allEtradeQuotes());
    const yahoo = stubProvider("yahoo", allYahooQuotes());
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);
    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: NASDAQ_ONLY,
      quoteDeps,
      exchange: "NYSE",
    });
    expect(acquired.quotes).toHaveLength(0);
    expect(acquired.discovery.message).toContain("in exchange scope NYSE");
  });
});

describe("exchange gate in the filter stage (#4439)", () => {
  const screener = new DynamicMarketScreener();
  const quoteWithExchange = (symbol: string, exchange: string) =>
    ({ ...etradeQuote(symbol), listingExchange: exchange }) as ETradeQuote;
  const quotes = [
    quoteWithExchange("JPM", "NYSE"),
    quoteWithExchange("XOM", "NYSE"),
    quoteWithExchange("AAPL", "NASDAQ"),
    quoteWithExchange("ABT", "AMEX"),
    etradeQuote("MSFT"), // no listingExchange: no verdict, passes.
  ];

  it("rejects exchange mismatches and stamps the applied exchange on the result", () => {
    const result = screener.screenWithQuotes(quotes, { exchange: "NYSE" }, false);
    expect(result.stocks.map((s) => s.symbol).sort()).toEqual(["JPM", "MSFT", "XOM"]);
    expect(result.filterSummary).toContain("Exchange: NYSE");
    expect(result.filterApplied.exchange).toBe("NYSE");
    const reasons = (result.ledger?.rejections ?? []).map((r) => r.reason);
    expect(reasons).toContainEqual(expect.stringContaining("does not match requested \"NYSE\""));
    expect(result.ledger?.rejections.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "ABT",
    ]);
  });

  it("no exchange requested leaves the screen unchanged and the summary unstamped", () => {
    const result = screener.screenWithQuotes(quotes, {}, false);
    expect(result.stocks.map((s) => s.symbol).sort()).toEqual([
      "AAPL",
      "ABT",
      "JPM",
      "MSFT",
      "XOM",
    ]);
    expect(result.filterSummary).not.toContain("Exchange:");
  });

  it("exchange=ALL leaves the screen unchanged and the summary unstamped", () => {
    const result = screener.screenWithQuotes(quotes, { exchange: "ALL" }, false);
    expect(result.stocks).toHaveLength(5);
    expect(result.filterSummary).not.toContain("Exchange:");
  });
});

describe("goal-screen Yahoo leg threads the exchange (#4439)", () => {
  it("createYahooStockScreener quotes only the requested exchange from the default universe", async () => {
    const fetched: string[] = [];
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => {
        fetched.push(symbol);
        return yahooQuote(symbol);
      },
    };
    const screener = createYahooStockScreener(yahooDeps);
    const result = await screener.screenMarkets({ exchange: "NYSE" });

    const nyse = new Set(
      YFINANCE_MARKET_UNIVERSE.filter((i) => i.exchange === "nyse").map((i) =>
        i.symbol.toUpperCase()
      )
    );
    expect(result.stocks.length).toBeGreaterThan(0);
    expect(result.stocks.every((s) => nyse.has(s.symbol.toUpperCase()))).toBe(true);
    expect(fetched.every((s) => nyse.has(s.toUpperCase()))).toBe(true);
    expect(result.filterSummary).toContain("Exchange: NYSE");
  });
});
