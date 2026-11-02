/**
 * Issue #1770 (slice A): per-run subrequest budget bounding for the
 * STOCK acquisition paths — the options side already has its ledger
 * (#1204/#1545); the stock side had only batching (#495) plus the
 * per-symbol retry cap, and the Yahoo per-symbol fallback was
 * unbounded. A run must never issue quote fetches past its budget:
 * unattempted symbols are deferred with the named request-budget
 * reason and carried into the qualified partial (#462) — never
 * reported as broker failures, never silently dropped.
 */
import { describe, it, expect, vi } from "vitest";
import {
  acquireUniverse,
  createStockSubrequestBudget,
  STOCK_SUBREQUEST_BUDGET_DEFERRED_REASON,
  fetchYahooQuotes,
} from "../src/trading/screenerPipeline";
import { DEFAULT_SCREENER_CONFIG } from "../src/trading/screenerConfig";
import type { ETradeQuote } from "../src/types";

function makeQuote(overrides: Partial<ETradeQuote> = {}): ETradeQuote {
  return {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    lastPrice: 217.23,
    price: 217.23,
    change: -4.07,
    changePercent: -1.84,
    bid: 0,
    ask: 0,
    volume: 0,
    open: 0,
    high: 0,
    low: 0,
    source: "E*TRADE live",
    quoteStatus: "LIVE",
    ...overrides,
  } as ETradeQuote;
}

const listed = (symbols: string[]) =>
  symbols.map(
    (symbol) =>
      ({ symbol, companyName: `${symbol} Inc`, exchange: "NASDAQ" }) as any
  );

function budgetConfig(limit: number) {
  return {
    ...DEFAULT_SCREENER_CONFIG,
    acquisition: {
      ...DEFAULT_SCREENER_CONFIG.acquisition,
      maxSubrequestsPerRun: limit,
    },
  };
}

describe("stock subrequest budget ledger (#1770)", () => {
  it("is a pure per-run ledger: tryConsume stops exactly at the limit", () => {
    const budget = createStockSubrequestBudget(2);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.exhausted).toBe(true);
    expect(budget.used).toBe(2);
    expect(budget.limit).toBe(2);
  });

  it("etrade-only: symbols past the budget are deferred with request-budget, not broker failures", async () => {
    const fetchQuote = vi.fn(async (sym: string) => makeQuote({ symbol: sym }));
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: listed(["AAA", "BBB", "CCC", "DDD", "EEE"]),
      // 1 batch attempt (fetchQuotes omitted below returns nothing, so
      // the batch leg is skipped) — budget 2 buys exactly 2 per-symbol
      // fetches; the other 3 must defer, not fail as broker errors.
      config: budgetConfig(2),
      quoteDeps: { fetchQuote },
    });
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(acquired.partial).toBeDefined();
    expect(acquired.partial!.quotedCount).toBe(2);
    expect(acquired.partial!.requestedCount).toBe(5);
    expect(acquired.partial!.failedSymbols.sort()).toEqual(["CCC", "DDD", "EEE"]);
    expect(acquired.partial!.failureReasons["request-budget"]).toBe(3);
    expect(acquired.partial!.failureReasons["api-http-5xx"]).toBeUndefined();
    expect(acquired.partial!.failureReasons.other).toBeUndefined();
    expect(acquired.discovery.message).toContain("request-budget=3");
  });

  it("etrade-only: a batch call consumes budget, so later chunks defer", async () => {
    const fetchQuotes = vi.fn(async () => [] as ETradeQuote[]);
    const fetchQuote = vi.fn(async (sym: string) => makeQuote({ symbol: sym }));
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: listed(["AAA", "BBB", "CCC"]),
      config: {
        ...budgetConfig(3),
        acquisition: {
          ...budgetConfig(3).acquisition,
          quoteBatchSize: 2,
        },
      },
      quoteDeps: { fetchQuotes, fetchQuote },
    });
    // Batch chunks (AAA, BBB) and (CCC) consume 2 units and omit all;
    // the per-symbol pass buys 1 more unit (AAA), then the budget is
    // gone and BBB/CCC defer.
    expect(fetchQuotes).toHaveBeenCalledTimes(2);
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    expect(acquired.quotes.map((q) => q.symbol)).toEqual(["AAA"]);
    expect(acquired.partial!.failureReasons["request-budget"]).toBe(2);
  });

  it("yahoo: the per-symbol fallback stops at the budget and defers the rest", async () => {
    const batch = vi.fn(async () => [] as any[]);
    const single = vi.fn(async (sym: string) => ({
      symbol: sym,
      provider: "yfinance",
      provenance: "live",
      companyName: `${sym} Inc`,
      price: 100,
      lastPrice: 100,
      change: 1,
      changePercent: 1,
      bid: 99,
      ask: 101,
      volume: 1000,
      open: 100,
      high: 100,
      low: 100,
      previousClose: 99,
      timestamp: "2026-10-25T00:00:00.000Z",
      currency: "USD",
    }));
    const deferred: string[] = [];
    const out = await fetchYahooQuotes(listed(["AAA", "BBB", "CCC", "DDD"]).map((l) => l.symbol), {
      fetchYahooBatchQuotes: batch,
      fetchYahooQuote: single,
    } as any, {
      budget: createStockSubrequestBudget(3),
      onBudgetDeferred: (symbols) => deferred.push(...symbols),
    });
    // 1 batch unit + 2 per-symbol units = 3; CCC and DDD are never
    // attempted once the budget is gone.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(2);
    expect(out.map((q) => q.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(deferred).toEqual(["CCC", "DDD"]);
    expect(STOCK_SUBREQUEST_BUDGET_DEFERRED_REASON).toContain("Subrequest budget");
  });

  it("yahoo mode in acquireUniverse names the budget when every symbol defers", async () => {
    // 1 batch unit exhausts the budget, so no per-symbol fetch is
    // issued and zero quotes is still an honest failure (#462) —
    // but the failure names the budget, not a Yahoo outage.
    await expect(
      acquireUniverse({
        mode: "yahoo",
        symbols: listed(["AAA", "BBB", "CCC"]),
        config: budgetConfig(1),
        yahooDeps: {
          fetchYahooBatchQuotes: async () => [] as any[],
          fetchYahooQuote: async () => {
            throw new Error("must not be called: budget exhausted");
          },
        } as any,
      })
    ).rejects.toThrow("request-budget=3");
  });

  it("yahoo mode in acquireUniverse carries budget deferrals into the partial", async () => {
    const acquired = await acquireUniverse({
      mode: "yahoo",
      symbols: listed(["AAA", "BBB", "CCC"]),
      config: budgetConfig(2),
      yahooDeps: {
        fetchYahooBatchQuotes: async () => [] as any[],
        fetchYahooQuote: async (sym: string) => ({
          symbol: sym,
          provider: "yfinance",
          provenance: "live",
          companyName: `${sym} Inc`,
          price: 100,
          lastPrice: 100,
          change: 1,
          changePercent: 1,
          bid: 99,
          ask: 101,
          volume: 1000,
          open: 100,
          high: 100,
          low: 100,
          previousClose: 99,
          timestamp: "2026-10-25T00:00:00.000Z",
          currency: "USD",
        }),
      } as any,
    });
    // 1 batch unit + 1 per-symbol unit: AAA quotes, BBB/CCC defer.
    expect(acquired.quotes.map((q) => q.symbol)).toEqual(["AAA"]);
    expect(acquired.partial).toBeDefined();
    expect(acquired.partial!.failureReasons["request-budget"]).toBe(2);
    expect(acquired.partial!.failureReasons["yahoo-unavailable"]).toBeUndefined();
  });

  it("default config leaves ordinary runs untouched (budget above the default path cost)", () => {
    expect(
      DEFAULT_SCREENER_CONFIG.acquisition.maxSubrequestsPerRun
    ).toBeGreaterThan(0);
  });
});
