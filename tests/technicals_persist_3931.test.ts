// @vitest-environment node
/**
 * Issue #3931 (sub-issue of #3929) — persist daily-bar history
 * so enrich can compute RSI / MACD / ATR, and the UX reads the
 * persisted technicals as its primary source (Correction 2,
 * issue comment 6760545755, owner 2026-11-10): ONE parameterized
 * technicals job per data type, parameterized by the symbol list
 * as its run input. The universe is just the input — the stored
 * index list for the run's universe — never a second job
 * definition per universe. There will be no per-universe
 * technicals jobs.
 *
 * Pinned here (TDD Red first, on pristine main):
 * - The same `yahoo-nasdaq100-technicals` job serves two
 *   universes: the run input names the list; the artifact
 *   records the universe actually run; the default (no input)
 *   stays nasdaq100. An unknown universe refuses by name
 *   (FEED_UNIVERSE_UNKNOWN); a universe with no stored list
 *   fails FEED_UNIVERSE_MISSING, never an invented universe.
 *   A provider without historicalBars refuses by name; bars
 *   that are not all-live are skipped per symbol, never
 *   persisted as data; a run that fetched no bars fails.
 * - Every quotes enrich job (Yahoo, Alpaca, E*TRADE, Public —
 *   every universe) joins the parameterized technicals dataset
 *   for ITS OWN universe and carries rsi / macd / atr computed
 *   from the persisted bars (values where the dataset carries
 *   the symbol, named gaps where it does not); the join knob
 *   opts one job out of the history elements.
 * - Every chain folds the technicals node in, and the chain's
 *   technicals node runs with the chain's universe.
 * - The UX read path is persisted-first: persisted bars win
 *   over the live fetch (labelled as persisted), the live fetch
 *   remains the fallback when persisted data is absent or stale,
 *   and ATR(14) is computed from the same bars (live and
 *   persisted alike) and carried into the screener rows.
 */
import { describe, expect, it } from "vitest";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  readPersistedTechnicalsBars,
  runFeedTechnicalsJob,
  YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  buildEnrichJobRegistry,
  ENRICH_HISTORY_ELEMENTS,
  runEnrichJob,
} from "../src/services/enrichJobs";
import {
  buildAllFeedPipelineJobDefinitions,
  buildFeedPipelineJobDefinition,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  FEED_PULL_STEP,
  resolveFeedJob,
} from "../src/services/feedPipelineJobs";
import { buildPipelineChainRegistry } from "../src/services/pipelineChains";
import {
  buildAllChainPipelineJobDefinitions,
} from "../src/services/chainPipelineJobs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import {
  attachTechnicals,
  EMPTY_TECHNICALS,
  type ScannedStock,
} from "../src/trading/screenerPipeline";
import {
  computeAtr,
  computeTechnicals,
  fetchPlatformTechnicalsBatch,
  withPersistedBarsFirst,
  type YahooDailyBar,
  type YahooHistoryDeps,
} from "../src/trading";
import type {
  FeedDatasetStoreInput,
} from "../src/data/feedDatasetPorts";
import type {
  DataProvider,
  DataResult,
  HistoricalBarsResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { IndexId } from "../src/trading";
import type { MarketDataResearchHistoricalBar } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;
const SENT_ID = YAHOO_NASDAQ100_SENTIMENT_JOB_ID;
const NASDAQ_SYMBOLS = ["AAPL", "MSFT"];
const SP100_SYMBOLS = ["AAPL", "XOM"];

const INDEX_LABELS: Record<IndexId, string> = {
  nasdaq100: "Nasdaq-100",
  sp100: "S&P 100",
  sp500: "S&P 500",
  dow: "Dow Jones Industrial Average",
  sp400: "S&P MidCap 400",
  russell2000: "Russell 2000",
  russell1000: "Russell 1000",
  russell3000: "Russell 3000",
} as Record<IndexId, string>;

function quoteRow(symbol: string, overrides: Record<string, unknown> = {}): QuoteResult {
  return {
    symbol,
    price: 110,
    lastPrice: 110,
    change: 10,
    changePercent: 10,
    volume: 2_000_000,
    averageVolume: 1_000_000,
    open: 105,
    high: 115,
    low: 104,
    previousClose: 100,
    vwap: 108,
    trailingPE: 20,
    marketCap: 3_000_000_000,
    bid: 109.9,
    ask: 110.1,
    high52: 120,
    low52: 80,
    timestamp: iso(T0),
    ...overrides,
  } as unknown as QuoteResult;
}

function runRecord(runId: string, atMs: number, requested = 2) {
  return {
    runId,
    trigger: "manual" as const,
    startedAt: iso(atMs),
    finishedAt: iso(atMs + 1000),
    status: "completed" as const,
    requested,
    received: requested,
    failed: 0,
    missingSymbols: [],
    codedError: null,
    errorMessage: null,
  };
}

/**
 * 30 live daily bars with a steady +1/day ramp: closes 100..129,
 * high = close + 1, low = close − 1. Every true range is exactly
 * 2, so Wilder ATR(14) is exactly 2; every daily change is a gain,
 * so RSI(14) is exactly 100; the fast EMA sits above the slow EMA,
 * so MACD is positive. Values pinned independently of the
 * implementation under test — not copied from its output.
 */
export function risingBars(symbol: string, count = 30): MarketDataResearchHistoricalBar[] {
  const bars: MarketDataResearchHistoricalBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + i;
    bars.push({
      provenance: "live",
      timestamp: iso(T0 - (count - 1 - i) * 24 * 3600_000),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return bars;
}

/** The same ramp as plain daily bars (the persisted-read shape). */
function risingDailyBars(count = 30): YahooDailyBar[] {
  return risingBars("AAPL", count).map((b) => ({
    date: b.timestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

function feedArtifact(
  runId: string,
  atMs: number,
  overrides: Partial<FeedDatasetStoreInput> & { index: IndexId },
): FeedDatasetStoreInput {
  const { index, ...rest } = overrides;
  return {
    sourceId: "yahoo",
    dataset: "quotes",
    jobId: "yahoo-nasdaq100-quotes",
    universe: {
      kind: "index",
      index,
      label: INDEX_LABELS[index],
      snapshotDate: "2026-11-02",
      sourceLabel: `Wikipedia (${INDEX_LABELS[index]} table)`,
      size: 2,
    },
    run: runRecord(runId, atMs),
    quotes: [quoteRow("AAPL"), quoteRow("MSFT")],
    asOf: iso(atMs + 1000),
    nowIso: iso(atMs + 1000),
    ...rest,
  } as FeedDatasetStoreInput;
}

function technicalsArtifact(
  runId: string,
  atMs: number,
  index: IndexId,
  rows: Array<{ symbol: string; bars: MarketDataResearchHistoricalBar[] }>,
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo",
    dataset: "technicals",
    jobId: TECH_ID,
    elements: ["historicalBars"],
    universe: {
      kind: "index",
      index,
      label: INDEX_LABELS[index],
      snapshotDate: "2026-11-02",
      sourceLabel: `Wikipedia (${INDEX_LABELS[index]} table)`,
      size: rows.length,
    },
    providerId: "yahoo",
    asOf: iso(atMs + 1000),
    quotes: [],
    bars: rows.map((r) => ({ symbol: r.symbol, bars: r.bars })),
    run: runRecord(runId, atMs, rows.length),
    nowIso: iso(atMs + 1000),
  } as unknown as FeedDatasetStoreInput;
}

function fundamentalsArtifact(
  runId: string,
  atMs: number,
  index: IndexId,
  rows: Array<{ symbol: string; peTrailing: number }>,
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo",
    dataset: "fundamentals",
    jobId: "yahoo-nasdaq100-fundamentals",
    elements: ["fundamentals"],
    universe: {
      kind: "index",
      index,
      label: INDEX_LABELS[index],
      snapshotDate: "2026-11-02",
      sourceLabel: `Wikipedia (${INDEX_LABELS[index]} table)`,
      size: rows.length,
    },
    providerId: "yahoo",
    asOf: iso(atMs + 1000),
    quotes: [],
    fundamentals: rows.map((r) => ({
      symbol: r.symbol,
      fundamentals: {
        marketCap: 3_000_000_000,
        peTrailing: r.peTrailing,
        peForward: 25,
        targetMeanPrice: 132,
        recommendationKey: "buy",
      },
    })) as unknown as FeedDatasetStoreInput["fundamentals"],
    run: runRecord(runId, atMs, rows.length),
    nowIso: iso(atMs + 1000),
  } as unknown as FeedDatasetStoreInput;
}

/** #3932: the sentiment join's persisted copy — sourced news
 *  sentiment per symbol (label + score + provenance), the same
 *  shape the sentiment job persists. */
function sentimentArtifact(
  runId: string,
  atMs: number,
  index: IndexId,
  rows: Array<{ symbol: string; label: "bullish" | "bearish" | "neutral"; score: number }>,
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo",
    dataset: "sentiment",
    jobId: SENT_ID,
    elements: ["news"],
    universe: {
      kind: "index",
      index,
      label: INDEX_LABELS[index],
      snapshotDate: "2026-11-02",
      sourceLabel: `Wikipedia (${INDEX_LABELS[index]} table)`,
      size: rows.length,
    },
    providerId: "yahoo",
    asOf: iso(atMs + 1000),
    quotes: [],
    sentiment: rows.map((r) => ({
      symbol: r.symbol,
      sentiment: {
        label: r.label,
        score: r.score,
        method: "llm",
        model: "fixture-model",
        headlineCount: 1,
        headlines: [
          {
            headline: `${r.symbol} reports quarterly results`,
            source: "Yahoo Finance",
            publishedAt: iso(atMs),
          },
        ],
        source: "yahoo-news",
        asOf: iso(atMs + 1000),
      },
    })),
    run: runRecord(runId, atMs, rows.length),
    nowIso: iso(atMs + 1000),
  } as unknown as FeedDatasetStoreInput;
}

async function universeStore() {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: NASDAQ_SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  await store.store({
    index: "sp100",
    snapshotDate: "2026-11-02",
    symbols: SP100_SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (S&P 100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

/** A Yahoo-shaped provider serving the 30-bar ramp per symbol. */
function yahooProvider(opts: { generatedFor?: string[] } = {}): DataProvider {
  return {
    id: "yahoo",
    name: "yahoo",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quoteRow(s)),
      }) as DataResult<QuoteResult[]>,
    getHistoricalBars: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "historicalBars",
        result: risingBars(symbol).map((b) =>
          opts.generatedFor?.includes(symbol)
            ? { ...b, provenance: "generated" as const }
            : b,
        ),
      }) as DataResult<HistoricalBarsResult>,
    getFundamentals: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "fundamentals",
        result: {
          symbol,
          marketCap: 3_000_000_000,
          peTrailing: symbol === "AAPL" ? 28.5 : 22,
          peForward: 25,
          targetMeanPrice: 132,
          recommendationKey: "buy",
        },
      }) as DataResult<unknown>,
  } as unknown as DataProvider;
}

describe("the parameterized technicals job (#3931)", () => {
  it("registers one parameterized technicals job (dataset technicals, historicalBars)", () => {
    const registry = buildFeedJobRegistry({});
    const def = registry.get(TECH_ID) as FeedJobDefinition | undefined;
    expect(def).toBeDefined();
    expect(def?.sourceId).toBe("yahoo");
    expect(def?.dataset).toBe("technicals");
    expect(def?.elements).toEqual(["historicalBars"]);
    expect(def?.parameterizedUniverse).toBe(true);
    expect(def?.universe.index).toBe("nasdaq100");
    // One job per data type — no per-universe technicals jobs.
    expect(
      registry.list().filter((j) => j.dataset === "technicals"),
    ).toHaveLength(1);
    expect(resolveFeedJob("technicals")?.jobId).toBe(TECH_ID);
    expect(resolveFeedJob("yahoo technicals")?.jobId).toBe(TECH_ID);
  });

  it("one job serves two universes: the run input names the list", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const deps = {
      provider: yahooProvider(),
      universeStore: await universeStore(),
      datasetStore,
    };
    const nasdaq = await runFeedTechnicalsJob(registry, deps, TECH_ID, {
      universe: "nasdaq100",
      runId: "feed-tech-nq",
      now: () => new Date(T0),
    });
    expect(nasdaq.status).toBe("completed");
    expect(nasdaq.received).toBe(2);
    const sp100 = await runFeedTechnicalsJob(registry, deps, TECH_ID, {
      universe: "sp100",
      runId: "feed-tech-sp",
      now: () => new Date(T0 + 60_000),
    });
    expect(sp100.status).toBe("completed");
    expect(sp100.received).toBe(2);

    // Both artifacts persist under the SAME job id, each
    // recording the universe actually run, with bars per symbol.
    const history = await datasetStore.listRuns("yahoo", "technicals", 10);
    expect(history).toHaveLength(2);
    expect(history.map((a) => a.jobId)).toEqual([TECH_ID, TECH_ID]);
    const byUniverse = new Map(history.map((a) => [a.universe.index, a]));
    expect(byUniverse.get("nasdaq100")?.bars?.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(byUniverse.get("nasdaq100")?.bars?.[0].bars).toHaveLength(30);
    expect(byUniverse.get("sp100")?.bars?.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "XOM",
    ]);
    // A bars artifact is usable (row count counts bars, not quotes).
    expect(await datasetStore.latestUsable("yahoo", "technicals")).toBeDefined();
  });

  it("no universe input runs the default (nasdaq100)", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: yahooProvider(),
        universeStore: await universeStore(),
        datasetStore,
      },
      TECH_ID,
      { runId: "feed-tech-default", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    const artifact = await datasetStore.latest("yahoo", "technicals");
    expect(artifact?.universe.index).toBe("nasdaq100");
  });

  it("an unknown universe input refuses by name", async () => {
    const registry = buildFeedJobRegistry({});
    await expect(
      runFeedTechnicalsJob(
        registry,
        {
          provider: yahooProvider(),
          universeStore: await universeStore(),
          datasetStore: new InMemoryFeedDatasetStore(),
        },
        TECH_ID,
        { universe: "nope" as IndexId, now: () => new Date(T0) },
      ),
    ).rejects.toMatchObject({ code: FEED_JOB_CODES.universeUnknown });
  });

  it("a universe with no stored list fails FEED_UNIVERSE_MISSING, never an invented universe", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: yahooProvider(),
        universeStore: await universeStore(),
        datasetStore,
      },
      TECH_ID,
      { universe: "dow", runId: "feed-tech-dow", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });

  it("a provider without historicalBars refuses by name", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const { getHistoricalBars: _drop, ...rest } = yahooProvider() as unknown as Record<
      string,
      unknown
    >;
    void _drop;
    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: rest as unknown as DataProvider,
        universeStore: await universeStore(),
        datasetStore,
      },
      TECH_ID,
      { runId: "feed-tech-nobars", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.historicalBarsUnsupported);
  });

  it("non-live bars are skipped per symbol, never persisted as data", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: yahooProvider({ generatedFor: ["MSFT"] }),
        universeStore: await universeStore(),
        datasetStore,
      },
      TECH_ID,
      { runId: "feed-tech-gen", now: () => new Date(T0) },
    );
    expect(result.status).toBe("partial");
    expect(result.received).toBe(1);
    expect(result.missingSymbols).toEqual(["MSFT"]);
    const artifact = await datasetStore.latestUsable("yahoo", "technicals");
    expect(artifact?.bars?.map((r) => r.symbol)).toEqual(["AAPL"]);
  });

  it("a run that fetched no bars fails, never an empty success", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: yahooProvider({ generatedFor: ["AAPL", "MSFT"] }),
        universeStore: await universeStore(),
        datasetStore,
      },
      TECH_ID,
      { runId: "feed-tech-none", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.noBarsReturned);
  });
});

describe("the enrich join computes rsi / macd / atr from persisted bars (#3931)", () => {
  it("every quotes enrich job joins the technicals dataset for its own universe", () => {
    const registry = buildEnrichJobRegistry({});
    for (const def of registry.list()) {
      expect(def.enrichFrom).toContainEqual({
        feedJobId: TECH_ID,
        sourceId: "yahoo",
        dataset: "technicals",
        universe: def.universe.index,
      });
      for (const element of ENRICH_HISTORY_ELEMENTS) {
        expect(def.elements).toContain(element);
      }
    }
    expect(registry.list()).toHaveLength(7);
  });

  it("the technicals join knob opts one job out of the history elements", () => {
    const off = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_TECHNICALS_JOIN: "off",
    });
    const alpaca = off.get("alpaca-nasdaq100-quotes-enrich")!;
    // The knob is per join: opting the technicals join out
    // leaves the fundamentals and sentiment joins in place.
    expect(alpaca.enrichFrom.map((s) => s.dataset)).toEqual(["fundamentals", "sentiment"]);
    for (const element of ENRICH_HISTORY_ELEMENTS) {
      expect(alpaca.elements).not.toContain(element);
    }
    // The knob is per job: the other broker jobs keep the join.
    expect(off.get("etrade-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(3);
    const bogus = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_TECHNICALS_JOIN: "bogus",
    });
    expect(bogus.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(3);
  });

  it("a broker enrich run carries rsi / macd / atr from the persisted bars", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(
      feedArtifact("feed-alpaca", T0, {
        index: "nasdaq100",
        sourceId: "alpaca",
        jobId: "alpaca-nasdaq100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("MSFT", { price: 210, lastPrice: 210 })],
      }),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f", T0, "nasdaq100", [
        { symbol: "AAPL", peTrailing: 28.5 },
        { symbol: "MSFT", peTrailing: 22 },
      ]),
    );
    await datasetStore.store(
      technicalsArtifact("feed-t", T0, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
        { symbol: "MSFT", bars: risingBars("MSFT") },
      ]),
    );
    // #3932: and the sentiment join, so the run completes on
    // all three joins.
    await datasetStore.store(
      sentimentArtifact("feed-s", T0, "nasdaq100", [
        { symbol: "AAPL", label: "bullish", score: 1 },
        { symbol: "MSFT", label: "bearish", score: -0.5 },
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-tech-1", nowMs: T0 },
    );
    expect(result.status).toBe("completed");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL")!;
    // Independently pinned values for the +1/day ramp (see risingBars).
    expect(aapl.features.rsi).toBe(100);
    expect(aapl.features.atr).toBe(2);
    expect(typeof aapl.features.macdLine).toBe("number");
    expect(aapl.features.macdLine as number).toBeGreaterThan(0);
    expect(aapl.features.macdHistogram as number).toBeGreaterThan(0);
    expect(aapl.unavailable).not.toContain("rsi");
    expect(aapl.unavailable).not.toContain("macd");
    expect(aapl.unavailable).not.toContain("atr");
    expect(artifact?.gaps.filter((g) => ["rsi", "macd", "atr"].includes(g.element))).toEqual(
      [],
    );
  });

  it("a symbol missing from the technicals copy is partial with a named gap", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(
      feedArtifact("feed-alpaca", T0, {
        index: "nasdaq100",
        sourceId: "alpaca",
        jobId: "alpaca-nasdaq100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("MSFT", { price: 210, lastPrice: 210 })],
      }),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f", T0, "nasdaq100", [
        { symbol: "AAPL", peTrailing: 28.5 },
        { symbol: "MSFT", peTrailing: 22 },
      ]),
    );
    await datasetStore.store(
      technicalsArtifact("feed-t", T0, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-tech-2", nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const msft = artifact?.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.unavailable).toContain("rsi");
    expect(msft.unavailable).toContain("macd");
    expect(msft.unavailable).toContain("atr");
    expect(artifact?.gaps).toContainEqual({
      element: "rsi",
      reason: "symbol_not_in_join_dataset",
      symbols: ["MSFT"],
    });
  });

  it("bars too short for an element are a named gap, never a fabricated value", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(
      feedArtifact("feed-alpaca", T0, {
        index: "nasdaq100",
        sourceId: "alpaca",
        jobId: "alpaca-nasdaq100-quotes",
        quotes: [quoteRow("AAPL")],
      }),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f", T0, "nasdaq100", [
        { symbol: "AAPL", peTrailing: 28.5 },
      ]),
    );
    await datasetStore.store(
      technicalsArtifact("feed-t", T0, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL", 10) },
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-tech-3", nowMs: T0 },
    );
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.rsi).toBeUndefined();
    expect(aapl.features.macdLine).toBeUndefined();
    expect(aapl.features.atr).toBeUndefined();
    expect(artifact?.gaps).toContainEqual({
      element: "rsi",
      reason: "insufficient_daily_bars",
      symbols: ["AAPL"],
    });
    expect(artifact?.gaps).toContainEqual({
      element: "atr",
      reason: "insufficient_daily_bars",
      symbols: ["AAPL"],
    });
  });

  it("no technicals copy at all keeps the history elements named-unavailable, never failed", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(
      feedArtifact("feed-alpaca", T0, {
        index: "nasdaq100",
        sourceId: "alpaca",
        jobId: "alpaca-nasdaq100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("MSFT", { price: 210, lastPrice: 210 })],
      }),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f", T0, "nasdaq100", [
        { symbol: "AAPL", peTrailing: 28.5 },
        { symbol: "MSFT", peTrailing: 22 },
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-tech-4", nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    expect(artifact?.gaps).toContainEqual({
      element: "rsi",
      reason: "requires_daily_bar_history",
      symbols: [],
    });
    expect(artifact?.rows.find((r) => r.symbol === "AAPL")?.unavailable).toContain("rsi");
  });

  it("the join matches the enrich job's universe, never the newest artifact in the bucket", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // The sp100 technicals copy is stored FIRST, the nasdaq100
    // copy second (newest) — an unfiltered "newest wins" join
    // would hand the sp100 enrich the nasdaq100 bars.
    await datasetStore.store(
      technicalsArtifact("feed-t-sp", T0, "sp100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
        { symbol: "XOM", bars: risingBars("XOM") },
      ]),
    );
    await datasetStore.store(
      technicalsArtifact("feed-t-nq", T0 + 60_000, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
        { symbol: "MSFT", bars: risingBars("MSFT") },
      ]),
    );
    await datasetStore.store(
      feedArtifact("feed-sp", T0, {
        index: "sp100",
        jobId: "yahoo-sp100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("XOM", { price: 90, lastPrice: 90 })],
      }),
    );
    await datasetStore.store(
      feedArtifact("feed-nq", T0, {
        index: "nasdaq100",
        quotes: [quoteRow("AAPL"), quoteRow("MSFT")],
      }),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f-sp", T0, "sp100", [
        { symbol: "AAPL", peTrailing: 99.5 },
        { symbol: "XOM", peTrailing: 12 },
      ]),
    );
    await datasetStore.store(
      fundamentalsArtifact("feed-f-nq", T0, "nasdaq100", [
        { symbol: "AAPL", peTrailing: 28.5 },
        { symbol: "MSFT", peTrailing: 22 },
      ]),
    );
    // #3932: and the sentiment join for both universes, so both
    // enrich runs complete on all three joins.
    await datasetStore.store(
      sentimentArtifact("feed-s-sp", T0, "sp100", [
        { symbol: "AAPL", label: "bullish", score: 1 },
        { symbol: "XOM", label: "neutral", score: 0 },
      ]),
    );
    await datasetStore.store(
      sentimentArtifact("feed-s-nq", T0 + 60_000, "nasdaq100", [
        { symbol: "AAPL", label: "bullish", score: 1 },
        { symbol: "MSFT", label: "bearish", score: -0.5 },
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const sp100 = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "yahoo-sp100-quotes-enrich",
      { runId: "enrich-sp100-tech-1", nowMs: T0 },
    );
    expect(sp100.status).toBe("completed");
    const spArtifact = await enrichedStore.latestUsable("yahoo-sp100-quotes-enrich");
    expect(spArtifact?.rows.find((r) => r.symbol === "AAPL")?.features.rsi).toBe(100);
    expect(spArtifact?.rows.find((r) => r.symbol === "XOM")?.features.atr).toBe(2);
  });
});

describe("every chain folds the technicals node in (#3931)", () => {
  it("each chain carries the technicals node before enrich, with the chain's universe", () => {
    const registry = buildPipelineChainRegistry({});
    for (const chain of registry.list()) {
      expect(chain.technicalsJobId).toBe(TECH_ID);
      // #3932: the sentiment node follows the technicals node.
      expect(chain.sentimentJobId).toBe(SENT_ID);
      const ids = chain.nodes.map((n) => n.jobId);
      expect(ids).toEqual([
        chain.feedJobId,
        "yahoo-nasdaq100-fundamentals",
        TECH_ID,
        SENT_ID,
        chain.enrichJobId,
        chain.analyzeJobId,
        chain.generateJobId,
        chain.deliverJobId,
      ]);
    }
    expect(registry.list()).toHaveLength(7);
  });

  it("the chain's technicals node runs with the chain's universe", () => {
    const raws = buildAllChainPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: {
        kind: string;
        steps?: Array<{ step?: string; params?: Record<string, unknown> }>;
        children?: Array<unknown>;
      };
    }>;
    expect(raws).toHaveLength(7);
    const walk = (raw: (typeof raws)[number]) => {
      const nodes: Array<{ step?: string; params?: Record<string, unknown> }> = [];
      let node: (typeof raw)["root"] | undefined = raw.root;
      while (node) {
        nodes.push(node.steps?.[0] ?? {});
        const children = (node as { children?: Array<(typeof raw)["root"]> }).children;
        node = children?.[0];
      }
      return nodes;
    };
    for (const raw of raws) {
      const nodes = walk(raw);
      const techNode = nodes.find((n) => n.params?.feedJobId === TECH_ID);
      expect(techNode).toBeDefined();
      expect(techNode!.step).toBe("feed.pull");
    }
    const byId = new Map(raws.map((r) => [r.jobId, r]));
    expect(
      walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === TECH_ID,
      )?.params,
    ).toMatchObject({ feedJobId: TECH_ID, universe: "nasdaq100" });
    expect(
      walk(byId.get("yahoo-sp100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === TECH_ID,
      )?.params,
    ).toMatchObject({ feedJobId: TECH_ID, universe: "sp100" });
    // The alpaca chain now carries eight nodes (fundamentals,
    // technicals, and sentiment fold in, #3932).
    expect(walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!)).toHaveLength(8);
    expect(walk(byId.get("yahoo-nasdaq100-quotes-pipeline")!)).toHaveLength(8);
  });
});

describe("the feed step passes the universe input through (#3931)", () => {
  async function makeHarness() {
    const stores: JobPipelineStores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const registry = buildFeedJobRegistry({});
    const steps = createFeedStepRegistry({
      registry,
      providerFor: (def: FeedJobDefinition) =>
        def.sourceId === "yahoo" ? yahooProvider() : undefined,
      universeStore: universes,
      datasetStore,
      shardsFor: async (jobId) =>
        (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
      indexRefresh: {
        store: universes,
        service: {
          getMembers: async (index) => ({
            index,
            snapshotDate: "2026-11-06",
            symbols: NASDAQ_SYMBOLS.map((symbol) => ({ symbol })),
            source: "wikipedia",
            sourceLabel: "Wikipedia (Nasdaq-100 table)",
            derivedFromHoldings: false,
          }),
        },
      },
    });
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps,
      now: () => new Date(T0),
    });
    await ensureFeedPipelineJobs(control, stores, {});
    return { control, stores, datasetStore };
  }

  it("a configured universe param runs the technicals job over that list", async () => {
    const h = await makeHarness();
    await h.control.configureJob(TECH_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: TECH_ID, universe: "sp100" } }],
      },
    });
    const dispatch = await h.control.runJob(TECH_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const artifact = await h.datasetStore.latest("yahoo", "technicals");
    expect(artifact?.universe.index).toBe("sp100");
    expect(artifact?.bars?.map((r) => r.symbol).sort()).toEqual(["AAPL", "XOM"]);
    expect(artifact?.bars?.[0].bars).toHaveLength(30);
    expect(artifact?.run.runId).toBe(dispatch.runId);
  });

  it("an unknown universe param fails the pipeline run, by name", async () => {
    const h = await makeHarness();
    await h.control.configureJob(TECH_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: TECH_ID, universe: "nope" } }],
      },
    });
    const dispatch = await h.control.runJob(TECH_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
  });

  it("the built technicals definition carries no universe param (default nasdaq100)", () => {
    const defs = buildAllFeedPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: { steps: Array<{ params: Record<string, unknown> }> };
    }>;
    const tech = defs.find((d) => d.jobId === TECH_ID)!;
    expect(tech.root.steps[0]!.params).toEqual({ feedJobId: TECH_ID });
    expect(buildFeedPipelineJobDefinition(buildFeedJobRegistry({}).get(TECH_ID)!)).toBeDefined();
  });
});

describe("the UX reads persisted technicals first, live as fallback (#3931)", () => {
  it("readPersistedTechnicalsBars serves the stored bars with provenance, or missing", async () => {
    const store = new InMemoryFeedDatasetStore();
    expect(
      await readPersistedTechnicalsBars(store, { nowMs: T0 }),
    ).toBeUndefined();
    await store.store(
      technicalsArtifact("feed-t", T0, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
      ]),
    );
    const read = await readPersistedTechnicalsBars(store, { nowMs: T0 + 60_000 });
    expect(read).toBeDefined();
    expect(read?.barsBySymbol.get("AAPL")).toHaveLength(30);
    expect(read?.asOf).toBe(iso(T0 + 1000));
    expect(read?.universeIndex).toBe("nasdaq100");
    expect(read?.stale).toBe(false);
  });

  it("a stale persisted copy is reported stale so the caller falls back to live", async () => {
    const store = new InMemoryFeedDatasetStore();
    await store.store(
      technicalsArtifact("feed-t", T0, "nasdaq100", [
        { symbol: "AAPL", bars: risingBars("AAPL") },
      ]),
    );
    const read = await readPersistedTechnicalsBars(store, {
      nowMs: T0 + 4 * 3600_000,
      maxAgeSeconds: 180 * 60,
    });
    expect(read?.stale).toBe(true);
  });

  it("persisted bars win over the live fetch and are labelled persisted; missing symbols fall back live", async () => {
    const live: YahooHistoryDeps = {
      fetchBars: async (symbol) =>
        symbol === "MSFT" ? risingDailyBars() : null,
    };
    const persisted = {
      barsBySymbol: new Map([["AAPL", risingDailyBars()]]),
      label: "Persisted Yahoo daily bars (as of 2026-11-07)",
    };
    const deps = withPersistedBarsFirst(live, persisted);
    const map = await fetchPlatformTechnicalsBatch(deps, ["AAPL", "MSFT"]);
    const aapl = map.get("AAPL")!;
    expect(aapl.rsi14).toBe(100);
    expect(aapl.atr14).toBe(2);
    expect(aapl.source).toContain("Persisted");
    const msft = map.get("MSFT")!;
    expect(msft.rsi14).toBe(100);
    expect(msft.source).toBe("Yahoo Finance");
  });

  it("computeTechnicals carries ATR(14) from the same bars, null when history is short", () => {
    expect(computeTechnicals("AAPL", risingDailyBars()).atr14).toBe(2);
    expect(computeTechnicals("AAPL", risingDailyBars(10)).atr14).toBeNull();
    expect(computeAtr(risingDailyBars())).toBe(2);
  });

  it("attachTechnicals carries ATR and the persisted source into the screener rows", () => {
    const stocks = [
      { symbol: "AAPL", rsi14: null, technicals: EMPTY_TECHNICALS },
      { symbol: "MSFT", rsi14: null, technicals: EMPTY_TECHNICALS },
    ] as unknown as ScannedStock[];
    const attached = attachTechnicals(
      stocks,
      new Map([
        [
          "AAPL",
          {
            ...computeTechnicals("AAPL", risingDailyBars()),
            source: "Persisted Yahoo daily bars (as of 2026-11-07)",
          },
        ],
      ]),
    );
    expect(attached[0].technicals.atr14).toBe(2);
    expect(attached[0].technicals.historySource).toContain("Persisted");
    expect(attached[0].rsi14).toBe(100);
    // A symbol with no technicals keeps honest nulls, never zeroed.
    expect(attached[1].technicals.atr14).toBeNull();
    expect(attached[1].technicals.rsi14).toBeNull();
  });
});
