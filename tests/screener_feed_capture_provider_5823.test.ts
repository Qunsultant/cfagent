// @vitest-environment node
/**
 * Issue #5823 (#4437 slice 2): the screener's feed stage reads
 * through the #3941 capture-wired provider.
 *
 * Today `screenerStepDepsForScheduledAgent` /
 * `screenerStepDepsForWorkflow` omit the quote/history deps, so
 * `screenFeedStage` / `screenGatherStage` bind them themselves
 * from the platform at stage time (`bindScreenerQuoteDeps` /
 * `bindScreenerHistoryDeps`, #4192) — inline per-provider adapter
 * construction that bypasses the #3941 provider
 * (`createCaptureWiredFeedProvider`, the ONE construction feed
 * jobs use) and never reads the capture.
 *
 * After this slice the step handler supplies the deps, bound over
 * the #3941 provider by `createScreenerFeedDepsFactories`, and the
 * engine stage methods refuse by name when the deps are absent —
 * no stage-time bind remains on the engine path. The bespoke flow
 * (`runScreenInner`) keeps its shared bind methods until slice 7
 * retires it; `screenLive` is untouched.
 *
 * The gated binds are slice 1's (`bindYahooScreenerDeps` et al.):
 * fresh capture serves with zero live calls, a miss fetches live
 * once and writes through — the slice-1 pin, through the new path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import type { FeedStepDeps } from "../src/services/feedPipelineJobs";
import {
  createScreenerFeedDepsFactories,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import type { ScreenerRunRequest } from "../src/agents/screener-agent";
import { QuoteTrace } from "../src/trading";
import {
  __resetQuoteCache,
  getCachedQuote,
  setCachedQuote,
} from "../src/services/quoteCache";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type {
  ETradeQuote,
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";
import type {
  DataProvider,
  DataRunContext,
} from "../src/trading/dataProviders/contract";

const RUN_ID = "run-5823";
const T0 = Date.parse("2026-11-19T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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
    timestamp: iso(T0),
    currency: "USD",
  };
}

function brokerRow(symbol: string, price = 100): ETradeQuote {
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

function bars(): MarketDataResearchHistoricalBar[] {
  const out: MarketDataResearchHistoricalBar[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i;
    out.push({
      provenance: "live",
      timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
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
  const getHistoricalBars = vi.fn(
    async (symbol: string, timeframe?: string, limit?: number, runContext?: DataRunContext) => ({
      providerId: "yahoo",
      capability: "historicalBars",
      result: bars(),
    }),
  );
  const provider = {
    id: "yahoo",
    name: "Yahoo",
    capabilities: ["quotes", "historicalBars"],
    isConfigured: () => true,
    getQuote,
    getQuotesBatch,
    getHistoricalBars,
  } as unknown as DataProvider;
  return { provider, getQuote, getQuotesBatch, getHistoricalBars };
}

function countingBroker(id: "etrade" | "alpaca" | "public") {
  const getQuote = vi.fn(async (symbol: string) => ({
    providerId: id,
    capability: "quotes",
    result: brokerRow(symbol),
  }));
  const getQuotesBatch = vi.fn(async (symbols: string[]) => ({
    providerId: id,
    capability: "quotes",
    result: symbols.map((s) => brokerRow(s)),
  }));
  const provider = {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuote,
    getQuotesBatch,
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

function req(provider: ScreenerRunRequest["provider"]): ScreenerRunRequest {
  return {
    trigger: "manual",
    userLogin: "owner",
    universe: "NASDAQ100",
    provider,
  };
}

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

beforeEach(() => {
  __resetQuoteCache();
});

describe("screener feed deps over the #3941 provider (#5823)", () => {
  it("yahoo: the factory resolves the yahoo quotes job and binds the gated deps over its provider", async () => {
    const yahoo = countingYahoo();
    const seen: { defId: string; sourceId: string; userLogin?: string }[] = [];
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: (def: { id: string; sourceId: string }, opts?: { userLogin?: string }) => {
        seen.push({ defId: def.id, sourceId: def.sourceId, userLogin: opts?.userLogin });
        return yahoo.provider;
      },
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    const bundle = quoteDepsFor(req("yahoo"), RUN_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0].sourceId).toBe("yahoo");
    expect(seen[0].defId).toBe("yahoo-nasdaq100-quotes");
    expect(seen[0].userLogin).toBe("owner");
    const row = await bundle.yahoo!.fetchYahooQuote("AAPL");
    expect(row.symbol).toBe("AAPL");
    expect(yahoo.getQuote).toHaveBeenCalledTimes(1);
  });

  it("fresh cache: the factory-bound yahoo deps serve with zero provider calls (slice-1 pin, new path)", async () => {
    const yahoo = countingYahoo();
    setCachedQuote("yahoo:AAPL", yahooRow("AAPL", 150));
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => yahoo.provider,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    const bundle = quoteDepsFor(req("yahoo"), RUN_ID);
    const row = await bundle.yahoo!.fetchYahooQuote("AAPL");
    expect(row.price).toBe(150);
    expect(yahoo.getQuote).not.toHaveBeenCalled();
    expect(yahoo.getQuotesBatch).not.toHaveBeenCalled();
  });

  it("missing cache: the factory-bound yahoo deps fetch live once and write through", async () => {
    const yahoo = countingYahoo();
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => yahoo.provider,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    const bundle = quoteDepsFor(req("yahoo"), RUN_ID);
    await bundle.yahoo!.fetchYahooQuote("AAPL");
    expect(yahoo.getQuote).toHaveBeenCalledTimes(1);
    expect(getCachedQuote("yahoo:AAPL")).toBeDefined();
    await bundle.yahoo!.fetchYahooQuote("AAPL");
    expect(yahoo.getQuote).toHaveBeenCalledTimes(1);
  });

  it.each([["etrade", "etrade"], ["alpaca", "alpaca"], ["public", "public"]] as const)(
    "%s: the bundle carries the requested provider's leg, bound over the factory provider",
    async (provider, leg) => {
      const broker = countingBroker(provider);
      const seen: string[] = [];
      const feedDeps = {
        registry: buildFeedJobRegistry({}),
        providerFor: (def: { id: string; sourceId: string }) => {
          seen.push(def.sourceId);
          return broker.provider;
        },
        universeStore: null,
        datasetStore: null,
      } as unknown as FeedStepDeps;
      const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
      const bundle = quoteDepsFor(req(provider), RUN_ID);
      expect(seen).toEqual([provider]);
      const row = await bundle[leg]!.fetchQuote("AAPL");
      expect(row.symbol).toBe("AAPL");
      expect(broker.getQuote).toHaveBeenCalledTimes(1);
    },
  );

  it("unwired provider (providerFor returns undefined) refuses SCREENER_QUOTE_DEPS_MISSING by name", () => {
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => undefined,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    expect(() => quoteDepsFor(req("yahoo"), RUN_ID)).toThrow(
      /SCREENER_QUOTE_DEPS_MISSING.*yahoo/,
    );
  });

  it("wired without feed deps refuses SCREENER_QUOTE_DEPS_MISSING by name, never a TypeError", () => {
    const { quoteDepsFor } = createScreenerFeedDepsFactories(undefined as unknown as FeedStepDeps);
    expect(() => quoteDepsFor(req("yahoo"), RUN_ID)).toThrow(
      /SCREENER_QUOTE_DEPS_MISSING.*without feed deps/,
    );
  });

  it("no quotes job registered for the source refuses by name, never another source's job", () => {
    const yahoo = countingYahoo();
    const registry = buildFeedJobRegistry({});
    const feedDeps = {
      registry: {
        get: (id: string) => (id === "yahoo-nasdaq100-quotes" ? registry.get(id) : undefined),
        list: () => registry.list().filter((d) => d.sourceId === "yahoo"),
      },
      providerFor: () => yahoo.provider,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    expect(() => quoteDepsFor(req("etrade"), RUN_ID)).toThrow(
      /SCREENER_QUOTE_DEPS_MISSING.*etrade/,
    );
  });

  it("an unknown provider refuses by name", () => {
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => undefined,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { quoteDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    expect(() =>
      quoteDepsFor(req("nasdaq" as ScreenerRunRequest["provider"]), RUN_ID),
    ).toThrow(/SCREENER_QUOTE_DEPS_MISSING.*nasdaq/);
  });

  it("history: fetchBars runs over the factory yahoo provider with the run context", async () => {
    const yahoo = countingYahoo();
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => yahoo.provider,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { historyDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    const deps = await historyDepsFor(req("yahoo"), RUN_ID);
    const fetched = await deps.fetchBars("AAPL");
    expect(fetched).not.toBeNull();
    expect(fetched!.length).toBe(30);
    expect(yahoo.getHistoricalBars).toHaveBeenCalledTimes(1);
    const call = yahoo.getHistoricalBars.mock.calls[0];
    expect(call[0]).toBe("AAPL");
    expect(call[3]).toMatchObject({ runId: RUN_ID, userLogin: "owner" });
  });

  it("history: an unwired history provider degrades to null-fetching deps, never a throw (#1331 contract)", async () => {
    const feedDeps = {
      registry: buildFeedJobRegistry({}),
      providerFor: () => undefined,
      universeStore: null,
      datasetStore: null,
    } as unknown as FeedStepDeps;
    const { historyDepsFor } = createScreenerFeedDepsFactories(feedDeps);
    const deps = await historyDepsFor(req("yahoo"), RUN_ID);
    await expect(deps.fetchBars("AAPL")).resolves.toBeNull();
  });
});

describe("engine stages without pre-bound deps refuse by name (#5823)", () => {
  it("screenFeedStage with no quoteDeps refuses SCREENER_QUOTE_DEPS_MISSING instead of binding at stage time", async () => {
    const storage = new FakeStorage();
    storage.map.set("screener:owner-login", "owner");
    const agent = new ScreenerAgent({ storage } as any, {} as any);
    await expect(
      agent.screenFeedStage("run-5823-feed", {
        request: req("yahoo"),
        symbols: listings(["AAPL", "MSFT"]),
        timestamp: iso(T0),
      }),
    ).rejects.toThrow(/SCREENER_QUOTE_DEPS_MISSING/);
  });

  it("screenGatherStage with no historyDeps refuses SCREENER_HISTORY_DEPS_MISSING instead of binding at stage time", async () => {
    const storage = new FakeStorage();
    storage.map.set("screener:owner-login", "owner");
    const agent = new ScreenerAgent({ storage } as any, {} as any);
    const feedOutput = {
      timestamp: iso(T0),
      userLogin: "owner",
      universe: "NASDAQ100",
      sector: "",
      provider: "yahoo" as const,
      symbols: listings(["AAPL"]),
      expectedCount: 1,
      acquired: {
        quotes: [yahooRow("AAPL", 150)],
        discovery: {
          mode: "live_quotes" as const,
          candidateCount: 1,
          listingCount: 1,
          message: "test",
        },
      },
      platformRunId: "platform-5823",
      quoteTraceSummary: new QuoteTrace().complete(),
      taskId: null,
      appliedLearnings: [],
    };
    await expect(
      agent.screenGatherStage("run-5823-gather", {
        request: req("yahoo"),
        feedOutput,
      }),
    ).rejects.toThrow(/SCREENER_HISTORY_DEPS_MISSING/);
  });
});
