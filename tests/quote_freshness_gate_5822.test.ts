/**
 * Issue #5822 (#4437 slice 1): behavioral CI pin for the quote
 * freshness gate.
 *
 * Owner principle (2026-11-19): any job can do a fetch — it just
 * needs to check how fresh the data is. The pin is behavioral, not
 * static: with a counting provider in the harness, fresh data present
 * means ZERO live provider calls; stale/missing means exactly one
 * fetch per symbol set plus write-through. It applies to any job's
 * fetch — the four screen-run quote binds (yahoo / etrade / alpaca /
 * public) are pinned here, and a screen run (acquireUniverse) is
 * pinned end-to-end.
 *
 * Fresh = present in the quoteCache within QUOTE_CACHE_TTL_MS (the
 * live-quote horizon; the feed capture's staleAfterMinutes is the
 * persisted-dataset horizon and does not make a month-old capture
 * fresh for a screen run). A cached row is served as recorded: the
 * pipeline's provenance gate (yahooQuoteToPipelineQuote) refuses
 * non-"live" rows, so re-stamping a cached row "cached" would defeat
 * the gate; the TTL is the staleness bound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  acquireUniverse,
  bindAlpacaQuoteDeps,
  bindEtradeQuoteDeps,
  bindLiveQuotesQuoteDeps,
  bindPublicQuoteDeps,
  bindYahooScreenerDeps,
} from "../src/trading/screenerPipeline";
import {
  __resetQuoteCache,
  getCachedQuote,
  setCachedQuote,
  QUOTE_CACHE_TTL_MS,
} from "../src/services/quoteCache";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { ETradeQuote, MarketDataResearchQuote } from "../src/types";
import type {
  DataProvider,
  DataRunContext,
} from "../src/trading/dataProviders/contract";

const RUN_CTX: DataRunContext = { runId: "pin-run", userLogin: "pin-user" };

function yahooRow(symbol: string, price = 100): MarketDataResearchQuote {
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
    timestamp: new Date().toISOString(),
    currency: "USD",
  };
}

function etradeRow(symbol: string, price = 100): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Inc.`,
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
  };
}

function countingYahoo() {
  const getQuote = vi.fn(async (symbol: string) => ({
    providerId: "yahoo",
    capability: "quotes",
    result: yahooRow(symbol),
  }));
  const getQuotesBatch = vi.fn(async (symbols: string[]) => ({
    providerId: "yahoo",
    capability: "quotes",
    result: symbols.map((s) => yahooRow(s)),
  }));
  const provider = {
    id: "yahoo",
    name: "Yahoo",
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuote,
    getQuotesBatch,
  } as unknown as DataProvider;
  return { provider, getQuote, getQuotesBatch };
}

function countingBroker(id: "etrade" | "alpaca" | "public", opts?: { batch?: boolean }) {
  const getQuote = vi.fn(async (symbol: string) => ({
    providerId: id,
    capability: "quotes",
    result: etradeRow(symbol),
  }));
  const getQuotesBatch =
    opts?.batch === false
      ? undefined
      : vi.fn(async (symbols: string[]) => ({
          providerId: id,
          capability: "quotes",
          result: symbols.map((s) => etradeRow(s)),
        }));
  const provider = {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuote,
    ...(getQuotesBatch ? { getQuotesBatch } : {}),
  } as unknown as DataProvider;
  return { provider, getQuote, getQuotesBatch };
}

function listings(symbols: string[]): NasdaqStockListing[] {
  return symbols.map((symbol) => ({
    symbol,
    companyName: `${symbol} Inc.`,
    exchange: "nasdaq" as const,
    change: 0,
    changePercent: 0,
  }));
}

beforeEach(() => {
  __resetQuoteCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quote freshness gate — yahoo bind (#5822)", () => {
  it("fresh cache: fetchYahooQuote serves the cached row with zero provider calls", async () => {
    const { provider, getQuote } = countingYahoo();
    setCachedQuote("yahoo:AAPL", yahooRow("AAPL", 150));
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const row = await deps.fetchYahooQuote("AAPL");
    expect(row.price).toBe(150);
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("missing cache: fetchYahooQuote fetches live exactly once and writes through", async () => {
    const { provider, getQuote } = countingYahoo();
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const row = await deps.fetchYahooQuote("AAPL");
    expect(row.symbol).toBe("AAPL");
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getCachedQuote("yahoo:AAPL")).toBeDefined();
    await deps.fetchYahooQuote("AAPL");
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("stale cache: fetchYahooQuote re-fetches live exactly once", async () => {
    vi.useFakeTimers();
    const { provider, getQuote } = countingYahoo();
    setCachedQuote("yahoo:AAPL", yahooRow("AAPL", 150));
    vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS + 1000);
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const row = await deps.fetchYahooQuote("AAPL");
    expect(row.price).toBe(100);
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("fresh cache: fetchYahooBatchQuotes serves all rows with zero provider calls", async () => {
    const { provider, getQuotesBatch } = countingYahoo();
    setCachedQuote("yahoo:AAA", yahooRow("AAA", 11));
    setCachedQuote("yahoo:BBB", yahooRow("BBB", 22));
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const rows = await deps.fetchYahooBatchQuotes!(["AAA", "BBB"]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(rows.map((r) => r.price)).toEqual([11, 22]);
    expect(getQuotesBatch).not.toHaveBeenCalled();
  });

  it("partial cache: fetchYahooBatchQuotes fetches only the missing symbols, once", async () => {
    const { provider, getQuotesBatch } = countingYahoo();
    setCachedQuote("yahoo:AAA", yahooRow("AAA", 11));
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const rows = await deps.fetchYahooBatchQuotes!(["AAA", "BBB", "CCC"]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(getQuotesBatch).toHaveBeenCalledTimes(1);
    expect(getQuotesBatch).toHaveBeenCalledWith(["BBB", "CCC"], RUN_CTX);
    expect(getCachedQuote("yahoo:BBB")).toBeDefined();
    expect(getCachedQuote("yahoo:CCC")).toBeDefined();
  });

  it("batch omission: symbols the live batch omits stay absent (fallback contract preserved)", async () => {
    const { provider, getQuotesBatch } = countingYahoo();
    getQuotesBatch.mockImplementation(async (symbols: string[]) => ({
      providerId: "yahoo",
      capability: "quotes",
      result: symbols.filter((s) => s !== "BBB").map((s) => yahooRow(s)),
    }));
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const rows = await deps.fetchYahooBatchQuotes!(["AAA", "BBB"]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(getQuotesBatch).toHaveBeenCalledTimes(1);
  });
});

describe("quote freshness gate — etrade / alpaca / public binds (#5822)", () => {
  it("fresh cache: fetchQuote serves the cached row with zero provider calls", async () => {
    const { provider, getQuote } = countingBroker("etrade");
    setCachedQuote("etrade:AAPL", etradeRow("AAPL", 150));
    const deps = bindEtradeQuoteDeps(provider, RUN_CTX);
    const row = await deps.fetchQuote("AAPL");
    expect(row.lastPrice).toBe(150);
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("missing cache: fetchQuote fetches live exactly once and writes through", async () => {
    const { provider, getQuote } = countingBroker("etrade");
    const deps = bindEtradeQuoteDeps(provider, RUN_CTX);
    const row = await deps.fetchQuote("AAPL");
    expect(row.symbol).toBe("AAPL");
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getCachedQuote("etrade:AAPL")).toBeDefined();
    await deps.fetchQuote("AAPL");
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("partial cache: fetchQuotes fetches only the missing symbols, once", async () => {
    const { provider, getQuotesBatch } = countingBroker("alpaca");
    setCachedQuote("alpaca:AAA", etradeRow("AAA", 11));
    const deps = bindAlpacaQuoteDeps(provider, RUN_CTX);
    const rows = await deps.fetchQuotes!(["AAA", "BBB"]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(getQuotesBatch).toHaveBeenCalledTimes(1);
    expect(getQuotesBatch).toHaveBeenCalledWith(["BBB"], RUN_CTX);
  });

  it("namespaces isolate providers: an etrade-cached row is never served to alpaca (or public)", async () => {
    const alpaca = countingBroker("alpaca");
    setCachedQuote("etrade:AAPL", etradeRow("AAPL", 150));
    const alpacaDeps = bindAlpacaQuoteDeps(alpaca.provider, RUN_CTX);
    await alpacaDeps.fetchQuote("AAPL");
    expect(alpaca.getQuote).toHaveBeenCalledTimes(1);

    const pub = countingBroker("public");
    const publicDeps = bindPublicQuoteDeps(pub.provider, RUN_CTX);
    await publicDeps.fetchQuote("AAPL");
    expect(pub.getQuote).toHaveBeenCalledTimes(1);
  });

  it("provider without batch: fetchQuotes stays absent", async () => {
    const { provider } = countingBroker("etrade", { batch: false });
    const deps = bindEtradeQuoteDeps(provider, RUN_CTX);
    expect(deps.fetchQuotes).toBeUndefined();
  });
});

describe("quote freshness gate — live-quotes gap-fill (#5822)", () => {
  it("fresh Yahoo cache: gap-fill serves from cache with zero Yahoo provider calls", async () => {
    const primary = countingBroker("etrade");
    primary.getQuotesBatch!.mockImplementation(async (symbols: string[]) => ({
      providerId: "etrade",
      capability: "quotes",
      result: symbols.filter((s) => s !== "BBB").map((s) => etradeRow(s)),
    }));
    const yahoo = countingYahoo();
    setCachedQuote("yahoo:BBB", yahooRow("BBB", 77));
    const deps = bindLiveQuotesQuoteDeps(
      primary.provider,
      yahoo.provider,
      RUN_CTX
    );
    const rows = await deps.fetchQuotes!(["AAA", "BBB"]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(rows.find((r) => r.symbol === "BBB")?.lastPrice).toBe(77);
    expect(yahoo.getQuotesBatch).not.toHaveBeenCalled();
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });
});

describe("quote freshness gate — screen run end-to-end (#5822)", () => {
  it("screen run over a fresh cache makes zero live provider calls", async () => {
    const { provider, getQuote, getQuotesBatch } = countingYahoo();
    for (const s of ["AAPL", "MSFT"]) setCachedQuote(`yahoo:${s}`, yahooRow(s, 123));
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const acquired = await acquireUniverse({
      mode: "yahoo",
      symbols: listings(["AAPL", "MSFT"]),
      maxSymbols: 2,
      yahooDeps: deps,
    });
    expect(acquired.quotes).toHaveLength(2);
    expect(getQuote).not.toHaveBeenCalled();
    expect(getQuotesBatch).not.toHaveBeenCalled();
  });

  it("screen run with missing cache fetches live once per symbol set and writes through", async () => {
    const { provider, getQuote, getQuotesBatch } = countingYahoo();
    const deps = bindYahooScreenerDeps(provider, RUN_CTX);
    const acquired = await acquireUniverse({
      mode: "yahoo",
      symbols: listings(["AAPL", "MSFT"]),
      maxSymbols: 2,
      yahooDeps: deps,
    });
    expect(acquired.quotes).toHaveLength(2);
    expect(getQuotesBatch).toHaveBeenCalledTimes(1);
    expect(getQuote).not.toHaveBeenCalled();
    expect(getCachedQuote("yahoo:AAPL")).toBeDefined();
    expect(getCachedQuote("yahoo:MSFT")).toBeDefined();
  });
});
