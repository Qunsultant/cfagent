// @vitest-environment node
/**
 * Issue #3930 (sub-issue of #3929) — the fundamentals join for
 * broker enrich, on the PARAMETERIZED fundamentals job
 * (Correction 2, issue comment 6760544285, owner 2026-11-10):
 * ONE fundamentals job per data type, parameterized by the
 * symbol list as its run input. The universe is just the input
 * — the stored index list for the run's universe — never a
 * second job definition per universe. The follow-up "define
 * sp100/sp500/dow fundamentals jobs" is CANCELLED; there will
 * be no per-universe fundamentals jobs.
 *
 * Pinned here (TDD Red first, on pristine main):
 * - The same `yahoo-nasdaq100-fundamentals` job serves two
 *   universes: the run input names the list; the artifact
 *   records the universe actually run; the default (no input)
 *   stays nasdaq100. An unknown universe refuses by name
 *   (FEED_UNIVERSE_UNKNOWN); a universe with no stored list
 *   fails FEED_UNIVERSE_MISSING, never an invented universe.
 * - Every quotes enrich job (Yahoo, Alpaca, E*TRADE, Public —
 *   every universe) joins the parameterized fundamentals
 *   dataset for ITS OWN universe, carrying the 14 fundamentals
 *   elements; the join knob opts one job out (quotes-only).
 * - The join matches the enrich job's universe, never the
 *   newest artifact in the shared (yahoo, fundamentals)
 *   bucket: a nasdaq100 enrich joins the nasdaq100 copy, an
 *   sp100 enrich the sp100 copy. A missing copy for the
 *   enrich job's universe is partial with a named gap, never
 *   a failure.
 * - Every chain folds the fundamentals node in, and the
 *   chain's fundamentals node runs with the chain's universe.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import {
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  FeedJobError,
  runFeedFundamentalsJob,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  buildEnrichJobRegistry,
  ENRICH_FUNDAMENTALS_ELEMENTS,
  resolveFeedInputArtifact,
  runEnrichJob,
} from "../src/services/enrichJobs";
import {
  buildAllEnrichPipelineJobDefinitions,
  ENRICH_PIPELINE_CATALOG,
} from "../src/services/enrichPipelineJobs";
import {
  buildAllFeedPipelineJobDefinitions,
  buildFeedPipelineJobDefinition,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  FEED_PULL_STEP,
} from "../src/services/feedPipelineJobs";
import {
  buildAllChainPipelineJobDefinitions,
  CHAIN_PIPELINE_CATALOG,
} from "../src/services/chainPipelineJobs";
import { buildPipelineChainRegistry } from "../src/services/pipelineChains";
import type {
  FeedDatasetStoreInput,
} from "../src/data/feedDatasetPorts";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { IndexId } from "../src/trading";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
} from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const FUND_ID = "yahoo-nasdaq100-fundamentals";
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;
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

/** A persisted feed artifact, seeded straight into the store. */
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

function fundamentalsArtifact(
  runId: string,
  atMs: number,
  index: IndexId,
  rows: Array<{ symbol: string; peTrailing: number }>,
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo",
    dataset: "fundamentals",
    jobId: FUND_ID,
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

/**
 * Thirty live daily bars, closes 100..129 (+1/day), high=close+1,
 * low=close-1 — RSI(14)=100, ATR(14)=2 exactly (#3931 fixture).
 * Seeds the technicals join so a run can complete on both joins.
 */
function risingBars(symbol: string, count = 30): MarketDataResearchHistoricalBar[] {
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

/** A Yahoo-shaped provider whose fundamentals differ per symbol. */
function yahooProvider(): DataProvider {
  return {
    id: "yahoo",
    name: "yahoo",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => ({
      providerId: "yahoo",
      capability: "quotes",
      result: symbols.map((s) => quoteRow(s)),
    }) as DataResult<QuoteResult[]>,
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
        } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
  } as DataProvider;
}

describe("the parameterized fundamentals job (#3930)", () => {
  it("one job serves two universes: the run input names the list", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const deps = {
      provider: yahooProvider(),
      universeStore: await universeStore(),
      datasetStore,
    };
    const nasdaq = await runFeedFundamentalsJob(registry, deps, FUND_ID, {
      universe: "nasdaq100",
      runId: "feed-nasdaq",
      now: () => new Date(T0),
    });
    expect(nasdaq.status).toBe("completed");
    expect(nasdaq.received).toBe(2);
    const sp100 = await runFeedFundamentalsJob(registry, deps, FUND_ID, {
      universe: "sp100",
      runId: "feed-sp100",
      now: () => new Date(T0 + 60_000),
    });
    expect(sp100.status).toBe("completed");
    expect(sp100.received).toBe(2);

    // Both artifacts persist under the SAME job id, each
    // recording the universe actually run.
    const history = await datasetStore.listRuns("yahoo", "fundamentals", 10);
    expect(history).toHaveLength(2);
    expect(history.map((a) => a.jobId)).toEqual([FUND_ID, FUND_ID]);
    const byUniverse = new Map(history.map((a) => [a.universe.index, a]));
    expect(byUniverse.get("nasdaq100")?.universe.label).toBe("Nasdaq-100");
    expect(byUniverse.get("nasdaq100")?.fundamentals?.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(byUniverse.get("sp100")?.universe.label).toBe("S&P 100");
    expect(byUniverse.get("sp100")?.fundamentals?.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "XOM",
    ]);

    // Universe-aware resolution: each universe reads its own copy.
    const nasdaqArtifact = await resolveFeedInputArtifact(
      datasetStore,
      FUND_ID,
      "yahoo",
      "fundamentals",
      "nasdaq100",
    );
    expect(nasdaqArtifact?.universe.index).toBe("nasdaq100");
    const sp100Artifact = await resolveFeedInputArtifact(
      datasetStore,
      FUND_ID,
      "yahoo",
      "fundamentals",
      "sp100",
    );
    expect(sp100Artifact?.universe.index).toBe("sp100");
  });

  it("no universe input runs the default (nasdaq100)", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedFundamentalsJob(
      registry,
      {
        provider: yahooProvider(),
        universeStore: await universeStore(),
        datasetStore,
      },
      FUND_ID,
      { runId: "feed-default", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    const artifact = await datasetStore.latest("yahoo", "fundamentals");
    expect(artifact?.universe.index).toBe("nasdaq100");
    expect(artifact?.fundamentals?.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("an unknown universe input refuses by name", async () => {
    const registry = buildFeedJobRegistry({});
    await expect(
      runFeedFundamentalsJob(
        registry,
        {
          provider: yahooProvider(),
          universeStore: await universeStore(),
          datasetStore: new InMemoryFeedDatasetStore(),
        },
        FUND_ID,
        { universe: "nope" as IndexId, now: () => new Date(T0) },
      ),
    ).rejects.toBeInstanceOf(FeedJobError);
    await expect(
      runFeedFundamentalsJob(
        registry,
        {
          provider: yahooProvider(),
          universeStore: await universeStore(),
          datasetStore: new InMemoryFeedDatasetStore(),
        },
        FUND_ID,
        { universe: "nope" as IndexId, now: () => new Date(T0) },
      ),
    ).rejects.toMatchObject({ code: FEED_JOB_CODES.universeUnknown });
  });

  it("a universe with no stored list fails FEED_UNIVERSE_MISSING, never an invented universe", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedFundamentalsJob(
      registry,
      {
        provider: yahooProvider(),
        universeStore: await universeStore(),
        datasetStore,
      },
      FUND_ID,
      { universe: "dow", runId: "feed-dow", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });

  it("the symbols partition filters the OVERRIDE universe's list", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const deps = {
      provider: yahooProvider(),
      universeStore: await universeStore(),
      datasetStore,
    };
    const xom = await runFeedFundamentalsJob(registry, deps, FUND_ID, {
      universe: "sp100",
      symbols: ["XOM"],
      runId: "feed-sp100-xom",
      now: () => new Date(T0),
    });
    expect(xom.status).toBe("completed");
    expect(xom.received).toBe(1);
    expect(xom.requested).toBe(1);
    // A partition naming no member of the override list is an
    // empty pull — the same named failure as no list at all.
    const msft = await runFeedFundamentalsJob(registry, deps, FUND_ID, {
      universe: "sp100",
      symbols: ["MSFT"],
      runId: "feed-sp100-msft",
      now: () => new Date(T0 + 60_000),
    });
    expect(msft.status).toBe("failed");
    expect(msft.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });
});

describe("the enrich join attaches the parameterized job (#3930)", () => {
  it("every quotes enrich job joins the fundamentals dataset for its own universe", () => {
    const registry = buildEnrichJobRegistry({});
    for (const def of registry.list()) {
      // #3931: every quotes enrich job joins BOTH gap-filling
      // datasets for its own universe — fundamentals and technicals.
      expect(def.enrichFrom).toEqual([
        {
          feedJobId: FUND_ID,
          sourceId: "yahoo",
          dataset: "fundamentals",
          universe: def.universe.index,
        },
        {
          feedJobId: TECH_ID,
          sourceId: "yahoo",
          dataset: "technicals",
          universe: def.universe.index,
        },
      ]);
      for (const element of ENRICH_FUNDAMENTALS_ELEMENTS) {
        expect(def.elements).toContain(element);
      }
    }
    expect(registry.list()).toHaveLength(7);
  });

  it("the join knob opts one job out (quotes-only preserved) and falls back to auto on bad values", () => {
    const off = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_FUNDAMENTALS_JOIN: "off",
    });
    // The knob is per job and per join: opting the fundamentals join
    // out leaves the technicals join in place (quotes-only for the
    // fundamentals elements, technicals still joined).
    expect(off.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toEqual([
      {
        feedJobId: TECH_ID,
        sourceId: "yahoo",
        dataset: "technicals",
        universe: "nasdaq100",
      },
    ]);
    expect(off.get("alpaca-nasdaq100-quotes-enrich")!.elements).not.toContain("peTrailing");
    // The knob is per job: the other broker jobs keep the join.
    expect(off.get("etrade-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(2);
    expect(off.get("yahoo-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(2);

    const on = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_FUNDAMENTALS_JOIN: "on",
    });
    expect(on.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(2);

    const bogus = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_FUNDAMENTALS_JOIN: "bogus",
    });
    expect(bogus.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(2);
  });

  it("a broker enrich run carries fundamentals values from the persisted join", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(
      feedArtifact("feed-alpaca", T0, {
        index: "nasdaq100",
        sourceId: "alpaca",
        jobId: "alpaca-nasdaq100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("MSFT", { price: 210, lastPrice: 210 })],
      }),
    );
    await datasetStore.store(fundamentalsArtifact("feed-f", T0, "nasdaq100", [
      { symbol: "AAPL", peTrailing: 28.5 },
    ]));
    // #3931: the technicals join is present for both symbols, so the
    // run's only miss is MSFT in the fundamentals join.
    await datasetStore.store(technicalsArtifact("feed-t", T0, "nasdaq100", [
      { symbol: "AAPL", bars: risingBars("AAPL") },
      { symbol: "MSFT", bars: risingBars("MSFT") },
    ]));
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-1", nowMs: T0 },
    );
    // MSFT is not in the join dataset: partial, with the miss
    // named — never a failure, never a fabricated value.
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.peTrailing).toBe(28.5);
    expect(aapl.features.analystUpsidePercent).toBe(20); // (132-110)/110
    expect(aapl.features.recommendationKey).toBe("buy");
    expect(aapl.unavailable).not.toContain("peTrailing");
    expect(artifact?.gaps).toContainEqual({
      element: "peTrailing",
      reason: "symbol_not_in_join_dataset",
      symbols: ["MSFT"],
    });
  });

  it("the join matches the enrich job's universe, never the newest artifact in the bucket", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // The sp100 fundamentals copy is stored FIRST, the nasdaq100
    // copy second (newest) — an unfiltered "newest wins" join
    // would hand the sp100 enrich the nasdaq100 values.
    await datasetStore.store(fundamentalsArtifact("feed-f-sp", T0, "sp100", [
      { symbol: "AAPL", peTrailing: 99.5 },
      { symbol: "XOM", peTrailing: 12 },
    ]));
    await datasetStore.store(fundamentalsArtifact("feed-f-nq", T0 + 60_000, "nasdaq100", [
      { symbol: "AAPL", peTrailing: 28.5 },
      { symbol: "MSFT", peTrailing: 22 },
    ]));
    // #3931: the technicals join is present for both universes, so
    // both enrich runs complete on both joins.
    await datasetStore.store(technicalsArtifact("feed-t-sp", T0, "sp100", [
      { symbol: "AAPL", bars: risingBars("AAPL") },
      { symbol: "XOM", bars: risingBars("XOM") },
    ]));
    await datasetStore.store(technicalsArtifact("feed-t-nq", T0 + 60_000, "nasdaq100", [
      { symbol: "AAPL", bars: risingBars("AAPL") },
      { symbol: "MSFT", bars: risingBars("MSFT") },
    ]));
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
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const sp100 = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "yahoo-sp100-quotes-enrich",
      { runId: "enrich-sp100-1", nowMs: T0 },
    );
    expect(sp100.status).toBe("completed");
    const spArtifact = await enrichedStore.latestUsable("yahoo-sp100-quotes-enrich");
    expect(spArtifact?.rows.find((r) => r.symbol === "AAPL")?.features.peTrailing).toBe(99.5);
    expect(spArtifact?.rows.find((r) => r.symbol === "XOM")?.features.peTrailing).toBe(12);
    const nasdaq = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "yahoo-nasdaq100-quotes-enrich",
      { runId: "enrich-nq-1", nowMs: T0 },
    );
    expect(nasdaq.status).toBe("completed");
    const nqArtifact = await enrichedStore.latestUsable("yahoo-nasdaq100-quotes-enrich");
    expect(nqArtifact?.rows.find((r) => r.symbol === "AAPL")?.features.peTrailing).toBe(28.5);
  });

  it("a join with no artifact for the enrich job's universe is partial, never failed", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(fundamentalsArtifact("feed-f-nq", T0, "nasdaq100", [
      { symbol: "AAPL", peTrailing: 28.5 },
    ]));
    await datasetStore.store(
      feedArtifact("feed-sp", T0, {
        index: "sp100",
        jobId: "yahoo-sp100-quotes",
        quotes: [quoteRow("AAPL"), quoteRow("XOM", { price: 90, lastPrice: 90 })],
      }),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "yahoo-sp100-quotes-enrich",
      { runId: "enrich-sp100-2", nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("yahoo-sp100-quotes-enrich");
    expect(artifact?.gaps).toContainEqual({
      element: "peTrailing",
      reason: "join_dataset_missing",
      symbols: [],
    });
    expect(artifact?.rows.find((r) => r.symbol === "AAPL")?.features.peTrailing).toBeUndefined();
  });

  it("the enrich pipeline definition carries the join universe in its step params", () => {
    const defs = buildAllEnrichPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: { steps: Array<{ params: { enrichFrom?: Array<Record<string, unknown>> } }> };
    }>;
    const byId = new Map(defs.map((d) => [d.jobId, d]));
    expect(
      byId.get("alpaca-nasdaq100-quotes-enrich")!.root.steps[0]!.params.enrichFrom,
    ).toEqual([
      {
        feedJobId: FUND_ID,
        sourceId: "yahoo",
        dataset: "fundamentals",
        universe: "nasdaq100",
      },
      {
        feedJobId: TECH_ID,
        sourceId: "yahoo",
        dataset: "technicals",
        universe: "nasdaq100",
      },
    ]);
    expect(
      byId.get("yahoo-sp100-quotes-enrich")!.root.steps[0]!.params.enrichFrom,
    ).toEqual([
      {
        feedJobId: FUND_ID,
        sourceId: "yahoo",
        dataset: "fundamentals",
        universe: "sp100",
      },
      {
        feedJobId: TECH_ID,
        sourceId: "yahoo",
        dataset: "technicals",
        universe: "sp100",
      },
    ]);
    expect(ENRICH_PIPELINE_CATALOG).toHaveLength(7);
  });
});

describe("the chains fold the parameterized fundamentals node (#3930)", () => {
  it("every chain declares the fundamentals job and its own universe", () => {
    const registry = buildPipelineChainRegistry({});
    expect(registry.list()).toHaveLength(7);
    for (const chain of registry.list()) {
      expect(chain.fundamentalsJobId).toBe(FUND_ID);
    }
    expect(registry.forId("yahoo-nasdaq100-quotes-pipeline")!.universeIndex).toBe("nasdaq100");
    expect(registry.forId("yahoo-sp100-quotes-pipeline")!.universeIndex).toBe("sp100");
    expect(registry.forId("yahoo-sp500-quotes-pipeline")!.universeIndex).toBe("sp500");
    expect(registry.forId("yahoo-dow-quotes-pipeline")!.universeIndex).toBe("dow");
    expect(registry.forId("alpaca-nasdaq100-quotes-pipeline")!.universeIndex).toBe("nasdaq100");
    expect(registry.forId("etrade-nasdaq100-quotes-pipeline")!.universeIndex).toBe("nasdaq100");
    expect(registry.forId("public-nasdaq100-quotes-pipeline")!.universeIndex).toBe("nasdaq100");
  });

  it("the chain's fundamentals node runs with the chain's universe", () => {
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
      const fundNode = nodes.find((n) => n.params?.feedJobId === FUND_ID);
      expect(fundNode).toBeDefined();
      expect(fundNode!.step).toBe("feed.pull");
    }
    const byId = new Map(raws.map((r) => [r.jobId, r]));
    expect(
      walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === FUND_ID,
      )?.params,
    ).toMatchObject({ feedJobId: FUND_ID, universe: "nasdaq100" });
    expect(
      walk(byId.get("yahoo-sp100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === FUND_ID,
      )?.params,
    ).toMatchObject({ feedJobId: FUND_ID, universe: "sp100" });
    // The alpaca chain now carries seven nodes (fundamentals and
    // technicals fold in, #3931).
    expect(walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!)).toHaveLength(7);
    expect(walk(byId.get("yahoo-nasdaq100-quotes-pipeline")!)).toHaveLength(7);
    expect(CHAIN_PIPELINE_CATALOG).toHaveLength(7);
  });
});

describe("the feed step passes the universe input through (#3930)", () => {
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

  it("a configured universe param runs the fundamentals job over that list", async () => {
    const h = await makeHarness();
    await h.control.configureJob(FUND_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: FUND_ID, universe: "sp100" } }],
      },
    });
    const dispatch = await h.control.runJob(FUND_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const artifact = await h.datasetStore.latest("yahoo", "fundamentals");
    expect(artifact?.universe.index).toBe("sp100");
    expect(artifact?.fundamentals?.map((r) => r.symbol).sort()).toEqual(["AAPL", "XOM"]);
    expect(artifact?.run.runId).toBe(dispatch.runId);
  });

  it("an unknown universe param fails the pipeline run, by name", async () => {
    const h = await makeHarness();
    await h.control.configureJob(FUND_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: FUND_ID, universe: "nope" } }],
      },
    });
    const dispatch = await h.control.runJob(FUND_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
  });

  it("the built fundamentals definition carries no universe param (default nasdaq100)", () => {
    const defs = buildAllFeedPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: { steps: Array<{ params: Record<string, unknown> }> };
    }>;
    const fund = defs.find((d) => d.jobId === FUND_ID)!;
    expect(fund.root.steps[0]!.params).toEqual({ feedJobId: FUND_ID });
    expect(buildFeedPipelineJobDefinition(buildFeedJobRegistry({}).get(FUND_ID)!)).toBeDefined();
  });
});
