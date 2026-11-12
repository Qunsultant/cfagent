// @vitest-environment node
/**
 * Issue #3536 (Pipeline J3) — the enrich service: computation
 * over PERSISTED feed artifacts (never a fetch), the element
 * vocabulary (supported computed, unsupported named-unavailable
 * — never fabricated), the fundamentals join, the snapshot
 * series, and the fail-closed input rule (ENRICH_INPUT_MISSING
 * with the failed run recorded, one run one id).
 */
import { describe, expect, it } from "vitest";
import {
  buildEnrichJobRegistry,
  buildEnrichStatus,
  computeEnrichment,
  ENRICH_GAP_REASONS,
  ENRICH_JOB_CODES,
  EnrichJobError,
  EnrichJobRegistry,
  resolveFeedInputArtifact,
  runEnrichJob,
  validateEnrichElements,
  type EnrichJobDefinition,
} from "../src/services/enrichJobs";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import type {
  FeedDatasetArtifact,
  FeedDatasetStoreInput,
} from "../src/data/feedDatasetPorts";
import type { DataProviderId, IndexId, QuoteResult } from "../src/trading";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function def(overrides: Partial<EnrichJobDefinition> = {}): EnrichJobDefinition {
  return {
    id: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: { kind: "index", index: "nasdaq100" as IndexId, label: "Nasdaq-100" },
    elements: ["momentum", "intradayPosition", "relativeVolume"],
    enrichFrom: [],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
    ...overrides,
  };
}

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

function feedInput(
  runId: string,
  atMs: number,
  overrides: Partial<FeedDatasetStoreInput> = {},
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    jobId: "yahoo-nasdaq100-quotes",
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 2,
      received: 2,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    quotes: [quoteRow("AAPL"), quoteRow("MSFT", { price: 210, lastPrice: 210, changePercent: -2 })],
    asOf: iso(atMs + 1000),
    nowIso: iso(atMs + 1000),
    ...overrides,
  };
}

async function seededStores() {
  const datasetStore = new InMemoryFeedDatasetStore();
  await datasetStore.store(feedInput("feed-run-1", T0));
  return { datasetStore, enrichedStore: new InMemoryEnrichedDatasetStore() };
}

describe("the element vocabulary (#3536)", () => {
  it("refuses an unknown element by name", () => {
    expect(() => validateEnrichElements(["momentum", "rsi14x"])).toThrowError(
      expect.objectContaining({ code: ENRICH_JOB_CODES.elementUnknown }),
    );
    expect(validateEnrichElements(["momentum", "momentum"])).toEqual(["momentum"]);
  });

  it("the built-in registry carries one enrich job per quotes feed job", () => {
    const registry = buildEnrichJobRegistry({});
    const ids = registry.list().map((j) => j.id).sort();
    expect(ids).toEqual([
      "alpaca-nasdaq100-quotes-enrich",
      "etrade-nasdaq100-quotes-enrich",
      "public-nasdaq100-quotes-enrich",
      "yahoo-dow-quotes-enrich",
      "yahoo-nasdaq100-quotes-enrich",
      "yahoo-sector-consumer-discretionary-quotes-enrich",
"yahoo-sector-consumer-staples-quotes-enrich",
      "yahoo-sector-energy-quotes-enrich",
"yahoo-sector-financials-quotes-enrich",
"yahoo-sector-health-care-quotes-enrich",
      "yahoo-sector-industrials-quotes-enrich",
"yahoo-sector-information-technology-quotes-enrich",
      "yahoo-sector-materials-quotes-enrich",
      "yahoo-sp100-quotes-enrich",
      "yahoo-sp400-quotes-enrich",
      "yahoo-sp500-quotes-enrich"
    ]);
    const yahoo = registry.get("yahoo-nasdaq100-quotes-enrich")!;
    expect(yahoo.enrichFrom).toEqual([
      { feedJobId: "yahoo-nasdaq100-fundamentals", sourceId: "yahoo", dataset: "fundamentals", universe: "nasdaq100" },
      { feedJobId: "yahoo-nasdaq100-technicals", sourceId: "yahoo", dataset: "technicals", universe: "nasdaq100" },
      { feedJobId: "yahoo-nasdaq100-sentiment", sourceId: "yahoo", dataset: "sentiment", universe: "nasdaq100" },
    ]);
    expect(yahoo.elements).toContain("peTrailing");
    // #3930: every quotes enrich job joins the parameterized
    // fundamentals dataset for its own universe (broker jobs
    // included — the join is no longer Yahoo-only).
    // #3931: and the parameterized technicals dataset, the same way.
    // #3932: and the parameterized sentiment dataset, the same way.
    expect(registry.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toEqual([
      { feedJobId: "yahoo-nasdaq100-fundamentals", sourceId: "yahoo", dataset: "fundamentals", universe: "nasdaq100" },
      { feedJobId: "yahoo-nasdaq100-technicals", sourceId: "yahoo", dataset: "technicals", universe: "nasdaq100" },
      { feedJobId: "yahoo-nasdaq100-sentiment", sourceId: "yahoo", dataset: "sentiment", universe: "nasdaq100" },
    ]);
    expect(registry.get("yahoo-sp100-quotes-enrich")!.enrichFrom).toEqual([
      { feedJobId: "yahoo-nasdaq100-fundamentals", sourceId: "yahoo", dataset: "fundamentals", universe: "sp100" },
      { feedJobId: "yahoo-nasdaq100-technicals", sourceId: "yahoo", dataset: "technicals", universe: "sp100" },
      { feedJobId: "yahoo-nasdaq100-sentiment", sourceId: "yahoo", dataset: "sentiment", universe: "sp100" },
    ]);
    expect(registry.forFeedJob("yahoo-nasdaq100-quotes")?.id).toBe(
      "yahoo-nasdaq100-quotes-enrich",
    );
    expect(registry.forFeedJob("yahoo-nasdaq100-fundamentals")).toBeUndefined();
  });

  it("env knobs externalize cadence and elements", () => {
    const registry = buildEnrichJobRegistry({
      ENRICH_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_CADENCE_MINUTES: "15",
      ENRICH_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ELEMENTS: "momentum,rsi",
    });
    const yahoo = registry.get("yahoo-nasdaq100-quotes-enrich")!;
    expect(yahoo.cadenceMinutes).toBe(15);
    expect(yahoo.elements).toEqual(["momentum", "rsi"]);
  });
});

describe("the computation (#3536)", () => {
  it("computes snapshot elements from the persisted quote", async () => {
    const { datasetStore } = await seededStores();
    const input = (await datasetStore.latest("yahoo", "quotes"))!;
    const out = computeEnrichment({
      inputArtifact: input,
      seriesArtifacts: [input],
      joinArtifacts: new Map(),
      elements: ["momentum", "intradayPosition", "dayRangePercent", "gapPercent", "relativeVolume", "vwapDeviationPercent", "spreadPercent", "rangePosition52w", "dayAction", "sentiment", "screenScore"],
      enrichFrom: [],
    });
    const aapl = out.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.momentum).toBe(10);
    expect(aapl.features.intradayPosition).toBeCloseTo(6 / 11, 5);
    expect(aapl.features.dayRangePercent).toBe(11);
    expect(aapl.features.gapPercent).toBe(5);
    expect(aapl.features.relativeVolume).toBe(2);
    expect(aapl.features.vwapDeviationPercent).toBeCloseTo((2 / 108) * 100, 5);
    expect(aapl.features.spreadPercent).toBeCloseTo((0.2 / 110) * 100, 5);
    expect(aapl.features.rangePosition52w).toBe(0.75);
    // #3932: the price-derived label is dayAction now; sentiment
    // is sourced — with no sentiment copy here it is absent and
    // the gap is named, never guessed.
    expect(typeof aapl.features.dayAction).toBe("string");
    expect(aapl.features.sentiment).toBeUndefined();
    expect(out.gaps).toContainEqual({
      element: "sentiment",
      reason: ENRICH_GAP_REASONS.requiresSentimentDataset,
      symbols: [],
    });
    expect(typeof aapl.features.screenScore).toBe("number");
    expect(out.elementCoverage.relativeVolume).toEqual({ computed: 2, unavailable: 0 });
  });

  it("names unsupported fields unavailable instead of fabricating them", async () => {
    const { datasetStore } = await seededStores();
    // E*TRADE-shaped quote: no averageVolume, no vwap, no 52-week range.
    const etradeArtifact: FeedDatasetArtifact = {
      ...(await datasetStore.latest("yahoo", "quotes"))!,
      quotes: [
        {
          symbol: "AAPL",
          lastPrice: 110,
          change: 10,
          changePercent: 10,
          bid: 109.9,
          ask: 110.1,
          volume: 2_000_000,
          open: 105,
          high: 115,
          low: 104,
          previousClose: 100,
          timestamp: iso(T0),
        } as unknown as QuoteResult,
      ],
    };
    const out = computeEnrichment({
      inputArtifact: etradeArtifact,
      seriesArtifacts: [etradeArtifact],
      joinArtifacts: new Map(),
      elements: ["relativeVolume", "vwapDeviationPercent", "rangePosition52w", "rsi"],
      enrichFrom: [],
    });
    const row = out.rows[0]!;
    expect(row.features).toEqual({});
    expect(row.unavailable.sort()).toEqual([
      "rangePosition52w",
      "relativeVolume",
      "rsi",
      "vwapDeviationPercent",
    ]);
    expect(out.gaps).toContainEqual({
      element: "rsi",
      reason: "requires_daily_bar_history",
      symbols: [],
    });
    expect(out.gaps).toContainEqual({
      element: "relativeVolume",
      reason: "field_not_in_snapshot",
      symbols: ["AAPL"],
    });
  });

  it("computes series elements over the persisted snapshot series only", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // Three persisted runs, closes 100 → 110 → 120 for AAPL.
    for (const [i, price] of [100, 110, 120].entries()) {
      await datasetStore.store(
        feedInput(`feed-series-${i}`, T0 + i * 3_600_000, {
          quotes: [quoteRow("AAPL", { price, lastPrice: price }), quoteRow("MSFT")],
        }),
      );
    }
    const input = (await datasetStore.latest("yahoo", "quotes"))!;
    const history = await datasetStore.listRuns("yahoo", "quotes", 10);
    const out = computeEnrichment({
      inputArtifact: input,
      seriesArtifacts: history,
      joinArtifacts: new Map(),
      elements: ["sma", "bollinger"],
      seriesPeriod: 3,
      enrichFrom: [],
    });
    const aapl = out.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.sma).toBe(110);
    expect(aapl.features.bollingerMiddle).toBe(110);
    // MSFT's series is flat (110 ×3 at the fixture default) — sma exists.
    const msft = out.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.features.sma).toBe(110);

    // A single snapshot cannot support a 3-period series: named gap.
    const short = computeEnrichment({
      inputArtifact: input,
      seriesArtifacts: [input],
      joinArtifacts: new Map(),
      elements: ["sma"],
      seriesPeriod: 3,
      enrichFrom: [],
    });
    expect(short.rows[0]!.features.sma).toBeUndefined();
    expect(short.gaps).toContainEqual({
      element: "sma",
      reason: "insufficient_snapshot_series",
      symbols: ["AAPL", "MSFT"],
    });
  });

  it("joins fundamentals by symbol and reports misses as gaps", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(feedInput("feed-q", T0));
    await datasetStore.store(
      feedInput("feed-f", T0, {
        jobId: "yahoo-nasdaq100-fundamentals",
        dataset: "fundamentals",
        quotes: [],
        fundamentals: [
          {
            symbol: "AAPL",
            fundamentals: {
              marketCap: 3_000_000_000,
              peTrailing: 28.5,
              peForward: 25,
              targetMeanPrice: 132,
              recommendationKey: "buy",
            },
          } as unknown as FeedDatasetStoreInput["fundamentals"][number],
        ],
      }),
    );
    const input = await resolveFeedInputArtifact(
      datasetStore,
      "yahoo-nasdaq100-quotes",
      "yahoo",
      "quotes",
    );
    const join = await resolveFeedInputArtifact(
      datasetStore,
      "yahoo-nasdaq100-fundamentals",
      "yahoo",
      "fundamentals",
    );
    const out = computeEnrichment({
      inputArtifact: input!,
      seriesArtifacts: [input!],
      joinArtifacts: new Map([["yahoo-nasdaq100-fundamentals", join!]]),
      elements: ["peTrailing", "analystUpsidePercent", "recommendationKey"],
      enrichFrom: [
        { feedJobId: "yahoo-nasdaq100-fundamentals", sourceId: "yahoo", dataset: "fundamentals" },
      ],
    });
    const aapl = out.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.peTrailing).toBe(28.5);
    expect(aapl.features.analystUpsidePercent).toBe(20); // (132-110)/110
    expect(aapl.features.recommendationKey).toBe("buy");
    const msft = out.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.unavailable).toContain("peTrailing");
    expect(out.joinMissingSymbols).toEqual(["MSFT"]);
    expect(out.gaps).toContainEqual({
      element: "peTrailing",
      reason: "symbol_not_in_join_dataset",
      symbols: ["MSFT"],
    });
  });
});

describe("the run service (#3536)", () => {
  it("refuses by name when no persisted input exists — and records the failed run", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = new EnrichJobRegistry();
    registry.register(def());
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      def().id,
      { runId: "pipeline-run-1", nowMs: T0 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(ENRICH_JOB_CODES.inputMissing);
    expect(result.runId).toBe("pipeline-run-1");
    const recorded = await enrichedStore.latest(def().id);
    expect(recorded?.run.codedError).toBe(ENRICH_JOB_CODES.inputMissing);
    expect(recorded?.rows).toEqual([]);
    // The failed copy never poisons reads.
    expect(await enrichedStore.latestUsable(def().id)).toBeUndefined();
  });

  it("never substitutes a sibling job's copy in the shared bucket", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // The SP100 job shares the (yahoo, quotes) bucket.
    await datasetStore.store(feedInput("feed-sp", T0, { jobId: "yahoo-sp100-quotes" }));
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = new EnrichJobRegistry();
    registry.register(def());
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      def().id,
      { nowMs: T0 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(ENRICH_JOB_CODES.inputMissing);
  });

  it("enriches end to end and persists lineage", async () => {
    const { datasetStore, enrichedStore } = await seededStores();
    const registry = new EnrichJobRegistry();
    registry.register(def());
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      def().id,
      { runId: "pipeline-run-9", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.received).toBe(2);
    expect(result.inputRunId).toBe("feed-run-1");
    const artifact = await enrichedStore.latestUsable(def().id);
    expect(artifact?.inputRunId).toBe("feed-run-1");
    expect(artifact?.rows).toHaveLength(2);
    expect(artifact?.run.runId).toBe("pipeline-run-9");

    const status = await buildEnrichStatus(enrichedStore, def(), T0 + 120_000);
    expect(status.state).toBe("ready");
    expect(status.snapshot?.rowsPersisted).toBe(2);
    expect(status.snapshot?.inputRunId).toBe("feed-run-1");
    expect(status.snapshot?.stale).toBe(false);
  });

  it("throws for an unknown job id (a caller bug, the #3530 idiom)", async () => {
    const { datasetStore, enrichedStore } = await seededStores();
    await expect(
      runEnrichJob(new EnrichJobRegistry(), { datasetStore, enrichedStore }, "nope"),
    ).rejects.toBeInstanceOf(EnrichJobError);
  });

  it("a configured-but-missing join dataset yields partial, with the gap recorded", async () => {
    const { datasetStore, enrichedStore } = await seededStores();
    const registry = new EnrichJobRegistry();
    registry.register(
      def({
        elements: ["peTrailing"],
        enrichFrom: [
          { feedJobId: "yahoo-nasdaq100-fundamentals", sourceId: "yahoo", dataset: "fundamentals" },
        ],
      }),
    );
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      def().id,
      { nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable(def().id);
    expect(artifact?.gaps).toContainEqual({
      element: "peTrailing",
      reason: "join_dataset_missing",
      symbols: [],
    });
  });
});
