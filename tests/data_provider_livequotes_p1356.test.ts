/**
 * Issue #1356 (liveDeps cutover, epic #1116) — pins for the NEW seam,
 * written BEFORE the implementation (TDD pins-first).
 *
 * The live-quotes mode keeps working, but its stale Nasdaq-listing
 * DELAYED fallback is REPLACED outright by Yahoo gap-fill composition
 * (D1), and the broker-shaped LiveScreenerDeps seam is replaced by a
 * route-resolved platform quote binding (QuoteScreenerDeps):
 *
 *  - live-quotes: E*TRADE primary + Yahoo gap-fill, per element, with
 *    per-element provenance (E*TRADE live / Yahoo Finance). When
 *    E*TRADE serves everything, Yahoo is never called.
 *  - etrade-only: E*TRADE or nothing — the binding takes NO gap-fill
 *    parameter, so a servable Yahoo is never consulted.
 *  - route readers resolve from the routing table and NEVER silently
 *    promote gap-fill to primary: an unservable E*TRADE primary throws
 *    DataProviderNotFoundError even when Yahoo could serve.
 *
 * Fixtures are deterministic stubs. No live market data, no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetQuoteCache } from "../src/services/quoteCache";

// Issue #5822: the quote binds serve fresh cached rows (quoteCache,
// 5-min TTL). These tests assert live provider calls, captures, and
// failures, so every test starts from a cold cache.
beforeEach(() => {
  __resetQuoteCache();
});
import {
  acquireUniverse,
  bindEtradeQuoteDeps,
  bindLiveQuotesQuoteDeps,
  etradeQuoteProviderFromRoute,
  quotesProvidersFromRoute,
} from "../src/trading/screenerPipeline";
import {
  DataProviderRegistry,
  DataProviderNotFoundError,
} from "../src/trading/dataProviders/registry";
import type {
  DataProvider,
  DataRunContext,
} from "../src/trading/dataProviders/contract";
import type { ETradeQuote, MarketDataResearchQuote } from "../src/types";

const RUN: DataRunContext = { runId: "run-p1356", userLogin: "trader1" };

const listings = (symbols: string[]) =>
  symbols.map(
    (symbol) => ({ symbol, companyName: `${symbol} Inc`, exchange: "NASDAQ" }) as any
  );

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
  contexts: DataRunContext[];
};

/** E*TRADE stub: serves `served`, throws `fail(symbol)` for the rest. */
function stubEtrade(
  served: Record<string, ETradeQuote>,
  opts: { fail?: (symbol: string) => Error | null; batchThrows?: boolean } = {}
): ProviderStub {
  const calls = { single: [] as string[], batch: [] as string[][] };
  const contexts: DataRunContext[] = [];
  const provider = {
    id: "etrade",
    capabilities: ["quotes"],
    getQuote: async (symbol: string, ctx: DataRunContext) => {
      calls.single.push(symbol);
      contexts.push(ctx);
      const err = opts.fail?.(symbol);
      if (err) throw err;
      const quote = served[symbol];
      if (!quote) throw new Error(`E*TRADE returned no quote for ${symbol} [null-response]`);
      return { providerId: "etrade", capability: "quotes", result: quote };
    },
    getQuotesBatch: async (symbols: string[], ctx: DataRunContext) => {
      calls.batch.push(symbols);
      contexts.push(ctx);
      if (opts.batchThrows) throw new Error("E*TRADE batch unavailable");
      return {
        providerId: "etrade",
        capability: "quotes",
        result: symbols.filter((s) => served[s]).map((s) => served[s]),
      };
    },
  };
  return { provider: provider as unknown as DataProvider, calls, contexts };
}

/** Yahoo stub: serves `served` MarketDataResearchQuotes, counts every fetch. */
function stubYahoo(served: Record<string, MarketDataResearchQuote>): ProviderStub {
  const calls = { single: [] as string[], batch: [] as string[][] };
  const contexts: DataRunContext[] = [];
  const provider = {
    id: "yahoo",
    capabilities: ["quotes"],
    getQuote: async (symbol: string, ctx: DataRunContext) => {
      calls.single.push(symbol);
      contexts.push(ctx);
      const quote = served[symbol];
      if (!quote) throw new Error(`Yahoo returned no quote for ${symbol}`);
      return { providerId: "yahoo", capability: "quotes", result: quote };
    },
    getQuotesBatch: async (symbols: string[], ctx: DataRunContext) => {
      calls.batch.push(symbols);
      contexts.push(ctx);
      return {
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.filter((s) => served[s]).map((s) => served[s]),
      };
    },
  };
  return { provider: provider as unknown as DataProvider, calls, contexts };
}

function routeRecords(gapFill: string | null, primary = "etrade") {
  return [
    {
      capability: "quotes",
      primaryProviderId: primary,
      gapFillProviderId: gapFill,
    },
  ] as any;
}

function configRecords(etradeEnabled = true, yahooEnabled = true) {
  return [
    {
      id: "etrade",
      adapterKind: "etrade-service",
      lifecycleState: etradeEnabled ? "enabled" : "disabled",
      enabled: etradeEnabled,
      precedence: 1,
      credentialRef: null,
      config: {},
      createdAt: "2026-10-25T00:00:00.000Z",
    },
    {
      id: "yahoo",
      adapterKind: "market-data-yahoo",
      lifecycleState: yahooEnabled ? "enabled" : "disabled",
      enabled: yahooEnabled,
      precedence: 3,
      credentialRef: null,
      config: {},
      createdAt: "2026-10-25T00:00:00.000Z",
    },
  ] as any;
}

describe("live-quotes gap-fill composition (#1356, D1)", () => {
  it("serves E*TRADE-served symbols from E*TRADE and failed symbols from Yahoo, with per-element provenance and no Nasdaq rows", async () => {
    const etrade = stubEtrade(
      { NVDA: etradeQuote("NVDA", 200) },
      { fail: (sym) => (sym === "AAPL" ? new Error("E*TRADE unavailable") : null) }
    );
    const yahoo = stubYahoo({ AAPL: yahooQuote("AAPL", 150) });
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["NVDA", "AAPL"]),
      quoteDeps,
    });

    expect(acquired.quotes).toHaveLength(2);
    const bySym = new Map(acquired.quotes.map((q) => [q.symbol, q]));
    expect(bySym.get("NVDA")?.source).toBe("E*TRADE live");
    expect(bySym.get("NVDA")?.quoteStatus).toBe("LIVE");
    expect(bySym.get("AAPL")?.source).toBe("Yahoo Finance");
    expect(bySym.get("AAPL")?.quoteStatus).toBe("LIVE");
    // D1: no stale listing rows anywhere in the new seam.
    expect(acquired.quotes.every((q) => !String(q.source).includes("Nasdaq"))).toBe(true);
    expect(acquired.quotes.every((q) => q.quoteStatus !== "DELAYED")).toBe(true);
    expect(acquired.discovery.mode).toBe("live_quotes");
    expect(acquired.discovery.message).toContain("Yahoo Finance gap-fill");
    expect(acquired.discovery.message).not.toContain("Nasdaq");
    // Gap-fill is per element: Yahoo was never asked about NVDA.
    expect(yahoo.calls.single).not.toContain("NVDA");
    expect(yahoo.calls.batch.flat()).not.toContain("NVDA");
  });

  it("never calls Yahoo when E*TRADE serves the whole universe", async () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA"), AAPL: etradeQuote("AAPL") });
    const yahoo = stubYahoo({ NVDA: yahooQuote("NVDA"), AAPL: yahooQuote("AAPL") });
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["NVDA", "AAPL"]),
      quoteDeps,
    });

    expect(acquired.quotes).toHaveLength(2);
    expect(acquired.quotes.every((q) => q.source === "E*TRADE live")).toBe(true);
    expect(yahoo.calls.single).toHaveLength(0);
    expect(yahoo.calls.batch).toHaveLength(0);
  });

  it("serves the whole universe from Yahoo gap-fill when E*TRADE is down, without throwing", async () => {
    const etrade = stubEtrade({}, { batchThrows: true, fail: () => new Error("E*TRADE unavailable") });
    const yahoo = stubYahoo({ NVDA: yahooQuote("NVDA"), AAPL: yahooQuote("AAPL") });
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["NVDA", "AAPL"]),
      quoteDeps,
    });

    expect(acquired.quotes).toHaveLength(2);
    expect(acquired.quotes.every((q) => q.source === "Yahoo Finance")).toBe(true);
    expect(acquired.partial).toBeUndefined();
  });

  it("fails honestly naming both providers when neither serves anything, with no DELAYED rows", async () => {
    const etrade = stubEtrade({}, { fail: () => new Error("E*TRADE unavailable") });
    const yahoo = stubYahoo({});
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    await expect(
      acquireUniverse({
        mode: "live-quotes",
        symbols: listings(["NVDA", "AAPL"]),
        quoteDeps,
      })
    ).rejects.toThrow(/E\*TRADE.*Yahoo|Yahoo.*E\*TRADE/);
  });

  it("forwards the same run context to both providers so capture attribution stays run-linked", async () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA") }, { fail: () => new Error("E*TRADE unavailable") });
    const yahoo = stubYahoo({ AAPL: yahooQuote("AAPL") });
    const quoteDeps = bindLiveQuotesQuoteDeps(etrade.provider, yahoo.provider, RUN);

    await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["NVDA", "AAPL"]),
      quoteDeps,
    });

    expect(etrade.contexts).toContainEqual(RUN);
    expect(yahoo.contexts).toContainEqual(RUN);
  });
});

describe("etrade-only invariant: E*TRADE or nothing (#1356)", () => {
  it("never consults a servable Yahoo when E*TRADE serves nothing, and fails honestly", async () => {
    const etrade = stubEtrade({}, { fail: () => new Error("E*TRADE unavailable") });
    const yahoo = stubYahoo({ NVDA: yahooQuote("NVDA"), AAPL: yahooQuote("AAPL") });
    // The etrade-only binding takes the provider alone — Yahoo is not
    // even an argument, so the leg cannot reach it.
    const quoteDeps = bindEtradeQuoteDeps(etrade.provider, RUN);

    await expect(
      acquireUniverse({
        mode: "etrade-only",
        symbols: listings(["NVDA", "AAPL"]),
        quoteDeps,
      })
    ).rejects.toThrow("No fallback data substituted");
    expect(yahoo.calls.single).toHaveLength(0);
    expect(yahoo.calls.batch).toHaveLength(0);
  });

  it("takes no gap-fill parameter at all (type-level exclusion, pinned by arity)", () => {
    expect(bindEtradeQuoteDeps.length).toBe(2);
  });
});

describe("quotes route readers (#1356)", () => {
  it("etradeQuoteProviderFromRoute returns the registered, enabled, quotes-capable etrade adapter", () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA") });
    const registry = new DataProviderRegistry();
    registry.register(etrade.provider);

    expect(
      etradeQuoteProviderFromRoute(registry, configRecords(), routeRecords("yahoo"))
    ).toBe(etrade.provider);
  });

  it("etradeQuoteProviderFromRoute throws when the route does not name etrade primary, etrade is disabled, or etrade is unregistered", () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA") });
    const registry = new DataProviderRegistry();
    registry.register(etrade.provider);

    expect(() =>
      etradeQuoteProviderFromRoute(registry, configRecords(), routeRecords("yahoo", "yahoo"))
    ).toThrow(DataProviderNotFoundError);
    expect(() =>
      etradeQuoteProviderFromRoute(registry, configRecords(false), routeRecords("yahoo"))
    ).toThrow(DataProviderNotFoundError);
    expect(() =>
      etradeQuoteProviderFromRoute(new DataProviderRegistry(), configRecords(), routeRecords("yahoo"))
    ).toThrow(DataProviderNotFoundError);
  });

  it("quotesProvidersFromRoute returns primary only — quotes never gap-fill (issue #2144)", () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA") });
    const yahoo = stubYahoo({ NVDA: yahooQuote("NVDA") });
    const registry = new DataProviderRegistry();
    registry.register(etrade.provider);
    registry.register(yahoo.provider);

    // Yahoo is servable and the route declares it as gap-fill — the
    // owner ruling still suppresses it for quotes.
    const resolved = quotesProvidersFromRoute(registry, configRecords(), routeRecords("yahoo"));
    expect(resolved.primary).toBe(etrade.provider);
    expect(resolved.gapFill).toBeUndefined();
  });

  it("quotesProvidersFromRoute omits (never fatals on) an unservable gap-fill", () => {
    const etrade = stubEtrade({ NVDA: etradeQuote("NVDA") });
    const registry = new DataProviderRegistry();
    registry.register(etrade.provider);

    // Yahoo disabled in config: gap-fill omitted, primary still resolves.
    const resolved = quotesProvidersFromRoute(registry, configRecords(true, false), routeRecords("yahoo"));
    expect(resolved.primary).toBe(etrade.provider);
    expect(resolved.gapFill).toBeUndefined();
  });

  it("quotesProvidersFromRoute never silently promotes gap-fill to primary", () => {
    const yahoo = stubYahoo({ NVDA: yahooQuote("NVDA") });
    const registry = new DataProviderRegistry();
    registry.register(yahoo.provider);

    // E*TRADE primary unservable (disabled) while Yahoo is servable:
    // the route is refused outright, not served by Yahoo as primary.
    expect(() =>
      quotesProvidersFromRoute(registry, configRecords(false, true), routeRecords("yahoo"))
    ).toThrow(DataProviderNotFoundError);
  });
});
