// @vitest-environment node
/**
 * Issue #3911 (ITIL incident) — pipeline quick-start blocked at
 * enrich: the quick-start ran the Yahoo FUNDAMENTALS feed job
 * (yahoo-nasdaq100-fundamentals) and skipped enrich, so analyze
 * refused with ANALYZE_INPUT_MISSING. Fundamentals is a JOIN
 * SOURCE for enrich, not its input — enrich reads the QUOTES
 * dataset persisted by yahoo-nasdaq100-quotes by exact lineage
 * (resolveFeedInputArtifact), and fundamentals has no enrich
 * consumer. The refusal was correct fail-visible behavior; the
 * defect was ORCHESTRATION: no steering named the mandatory
 * stage order, so the copilot ran feed → analyze directly.
 *
 * This file pins the fix at three levels:
 * 1. Steering (RED on pristine main #3911): the Stock Copilot
 *    prompt carries the pipeline stage-order rule — feed →
 *    enrich → analyze → generate → deliver, never skipping a
 *    stage; never analyze directly after feed; the quotes job
 *    is the pipeline's feed input, fundamentals only a join
 *    source; prefer run_pipeline_chain for the yahoo chain.
 * 2. Chain prerequisite (pin): the derived chain definition
 *    for yahoo-nasdaq100-quotes-pipeline already orders enrich
 *    between feed and analyze with the quotes job as its feed
 *    stage — the chain was never broken; the copilot skipped it.
 * 3. Stage seam (pin): a standalone feed run's persisted
 *    quotes dataset is consumed by a standalone enrich run,
 *    whose persisted enriched rows are then found by analyze
 *    via latestUsable — plus the two fail-visible refusals the
 *    incident exercised, unchanged: analyze with no enriched
 *    dataset refuses ANALYZE_INPUT_MISSING, and enrich with
 *    only a fundamentals artifact refuses ENRICH_INPUT_MISSING
 *    (fundamentals can never stand in as the feed input).
 */
import { describe, expect, it } from "vitest";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import {
  buildStockCopilotMcpSteering,
  buildStockCopilotSystemPrompt,
  STOCK_COPILOT_MCP_STEERING,
  type StockCopilotPromptCapability,
} from "../src/agents/prompts/stockCopilotPrompt";
import { buildPipelineChainRegistry } from "../src/services/pipelineChains";
import {
  buildFeedJobRegistry,
  runFeedJob,
} from "../src/services/feedJobs";
import {
  ANALYZE_JOB_CODES,
  buildAnalyzeJobRegistry,
  runAnalyzeJob,
} from "../src/services/analyzeJobs";
import {
  ENRICH_JOB_CODES,
  buildEnrichJobRegistry,
  runEnrichJob,
} from "../src/services/enrichJobs";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { FeedDatasetStoreInput } from "../src/data/feedDatasetPorts";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading";
import type { DataProviderId, IndexId } from "../src/trading";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const FEED_ID = "yahoo-nasdaq100-quotes";
const FUND_ID = "yahoo-nasdaq100-fundamentals";
const TECH_ID = "yahoo-nasdaq100-technicals";
const SENT_ID = "yahoo-nasdaq100-sentiment";
const ENRICH_ID = `${FEED_ID}-enrich`;
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const CHAIN_ID = `${FEED_ID}-pipeline`;

const PROMPT_BASE = {
  route: { agent: "search" as const, confidence: 0.92, reason: "test route" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
};

/** An E*TRADE/paper capability: exercises the broker-aware steering branch. */
const ETRADE_CAPABILITY: StockCopilotPromptCapability = {
  brokerId: "etrade",
  brokerLabel: "E*TRADE",
  mode: "paper",
  environment: "TEST",
  tools: {
    quote: "etrade_get_quote",
    preview: "etrade_preview_order",
    place: "etrade_execute_order",
    orders: null,
    cancel: null,
  },
  bracketOrders: "preview",
  percentBrackets: false,
};

/** The stage-order rule, asserted verbatim in every steering surface. */
function expectStageOrderRule(prompt: string): void {
  expect(prompt).toContain("feed → enrich → analyze → generate → deliver");
  expect(prompt).toContain("never skipping a stage");
  expect(prompt).toMatch(/never run analyze directly after feed/i);
  expect(prompt).toContain("yahoo-nasdaq100-quotes");
  expect(prompt).toContain("yahoo-nasdaq100-quotes-pipeline");
  expect(prompt).toContain("run_pipeline_chain");
  expect(prompt).toMatch(/fundamentals.*join source/i);
  expect(prompt).toMatch(/fundamentals.*never.*feed input/i);
}

describe("pipeline stage-order steering (#3911)", () => {
  it("the default Stock Copilot steering names the mandatory stage order", () => {
    expectStageOrderRule(STOCK_COPILOT_MCP_STEERING);
  });

  it("the broker-aware steering names the stage order for a non-Alpaca broker", () => {
    expectStageOrderRule(buildStockCopilotMcpSteering(ETRADE_CAPABILITY));
  });

  it("an activated Stock Copilot turn carries the stage-order rule", () => {
    expectStageOrderRule(buildStockCopilotSystemPrompt(PROMPT_BASE));
    expectStageOrderRule(
      buildOrchestratorSystemPrompt({ ...PROMPT_BASE, stockCopilotMcpActive: true }),
    );
  });
});

describe("chain prerequisite (#3911)", () => {
  it("the yahoo chain orders enrich between feed and analyze, on the quotes job", () => {
    const registry = buildPipelineChainRegistry({});
    const yahoo = registry.forId(CHAIN_ID)!;
    expect(yahoo.feedJobId).toBe(FEED_ID);
    expect(yahoo.fundamentalsJobId).toBe(FUND_ID);
    expect(yahoo.technicalsJobId).toBe(TECH_ID);
    expect(yahoo.sentimentJobId).toBe(SENT_ID);
    expect(yahoo.stages.map((s) => [s.stage, s.jobId])).toEqual([
      ["feed", FEED_ID],
      ["enrich", ENRICH_ID],
      ["analyze", ANALYZE_ID],
      ["generate", `${ANALYZE_ID}-generate`],
      ["deliver", `${ANALYZE_ID}-generate-deliver`],
    ]);
    // Fundamentals, technicals, and sentiment are the enrich
    // joins, folded into the feed stage as nodes — never stage
    // jobs of their own.
    expect(yahoo.stages.map((s) => s.jobId)).not.toContain(FUND_ID);
    expect(yahoo.stages.map((s) => s.jobId)).not.toContain(TECH_ID);
    expect(yahoo.stages.map((s) => s.jobId)).not.toContain(SENT_ID);
    expect(yahoo.nodes.map((n) => n.jobId)).toEqual([
      FEED_ID,
      FUND_ID,
      TECH_ID,
      SENT_ID,
      ENRICH_ID,
      ANALYZE_ID,
      `${ANALYZE_ID}-generate`,
      `${ANALYZE_ID}-generate-deliver`,
    ]);
  });
});

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

async function seededUniverseStore(): Promise<InMemoryIndexListStore> {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3_600_000),
  });
  return store;
}

function fakeYahooProvider(): DataProvider {
  const rows = [
    quoteRow("AAPL"),
    quoteRow("MSFT", { price: 210, lastPrice: 210, changePercent: -2 }),
  ];
  return {
    id: "yahoo",
    name: "yahoo",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = rows.filter((q) => wanted.has(q.symbol.toUpperCase()));
      return { providerId: "yahoo", capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
  } as unknown as DataProvider;
}

function fundamentalsInput(runId: string): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo" as DataProviderId,
    dataset: "fundamentals",
    jobId: FUND_ID,
    universe: {
      kind: "index",
      index: "nasdaq100" as IndexId,
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(T0),
      finishedAt: iso(T0 + 1000),
      status: "completed",
      requested: 2,
      received: 2,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
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
      },
      {
        symbol: "MSFT",
        fundamentals: {
          marketCap: 2_500_000_000,
          peTrailing: 30,
          peForward: 27,
          targetMeanPrice: 230,
          recommendationKey: "buy",
        },
      },
    ] as unknown as FeedDatasetStoreInput["fundamentals"],
    asOf: iso(T0 + 1000),
    nowIso: iso(T0 + 1000),
  };
}

/** #3931: the technicals join the enrich job declares — thirty live
 *  daily bars per symbol (closes 100..129), persisted alongside the
 *  fundamentals copy so the enrich run completes on both joins. */
function technicalsInput(runId: string): FeedDatasetStoreInput {
  const barsFor = (symbol: string) => {
    const bars = [];
    for (let i = 0; i < 30; i++) {
      const close = 100 + i;
      bars.push({
        provenance: "live",
        timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000_000,
      });
    }
    return { symbol, bars };
  };
  return {
    sourceId: "yahoo" as DataProviderId,
    dataset: "technicals",
    jobId: TECH_ID,
    universe: {
      kind: "index",
      index: "nasdaq100" as IndexId,
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(T0),
      finishedAt: iso(T0 + 1000),
      status: "completed",
      requested: 2,
      received: 2,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    quotes: [],
    bars: [barsFor("AAPL"), barsFor("MSFT")],
    asOf: iso(T0 + 1000),
    nowIso: iso(T0 + 1000),
  } as unknown as FeedDatasetStoreInput;
}

/** #3932: the sentiment join the enrich job declares — sourced
 *  news sentiment per symbol (AAPL bullish, MSFT bearish),
 *  persisted alongside the other joins so the enrich run
 *  completes on all three joins. */
function sentimentInput(runId: string): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo" as DataProviderId,
    dataset: "sentiment",
    jobId: SENT_ID,
    universe: {
      kind: "index",
      index: "nasdaq100" as IndexId,
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(T0),
      finishedAt: iso(T0 + 1000),
      status: "completed",
      requested: 2,
      received: 2,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    quotes: [],
    sentiment: [
      {
        symbol: "AAPL",
        sentiment: {
          label: "bullish",
          score: 1,
          method: "llm",
          model: "fixture-model",
          headlineCount: 2,
          headlines: [
            { headline: "Acme surges on record earnings beat", source: "Yahoo Finance", publishedAt: iso(T0) },
            { headline: "Acme jumps after strong guidance", source: "Yahoo Finance", publishedAt: iso(T0) },
          ],
          source: "yahoo-news",
          asOf: iso(T0 + 1000),
        },
      },
      {
        symbol: "MSFT",
        sentiment: {
          label: "bearish",
          score: -0.5,
          method: "llm",
          model: "fixture-model",
          headlineCount: 2,
          headlines: [
            { headline: "Globex plunges after guidance cut", source: "Yahoo Finance", publishedAt: iso(T0) },
            { headline: "Globex reports quarterly results", source: "Yahoo Finance", publishedAt: iso(T0) },
          ],
          source: "yahoo-news",
          asOf: iso(T0 + 1000),
        },
      },
    ],
    asOf: iso(T0 + 1000),
    nowIso: iso(T0 + 1000),
  } as unknown as FeedDatasetStoreInput;
}

describe("the feed → enrich → analyze seam (#3911)", () => {
  it("a standalone feed run's quotes are enriched, then analyzed, by exact lineage", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const universeStore = await seededUniverseStore();

    // Stage 1 — feed: the standalone QUOTES job persists its dataset.
    const feed = await runFeedJob(
      buildFeedJobRegistry({}),
      { provider: fakeYahooProvider(), universeStore, datasetStore },
      FEED_ID,
      { runId: "feed-run-3911", now: () => new Date(T0) },
    );
    expect(feed.status).toBe("completed");
    expect(feed.received).toBe(2);
    expect(feed.artifactId).toBeTruthy();

    // The fundamentals join the enrich job declares (the incident
    // ran this job — it is a join source, never the feed input).
    await datasetStore.store(fundamentalsInput("feed-fund-3911"));
    // #3931: and the technicals join it declares — both joins
    // present, so the enrich run completes.
    await datasetStore.store(technicalsInput("feed-tech-3911"));
    // #3932: and the sentiment join it declares — all three
    // joins present, so the enrich run completes.
    await datasetStore.store(sentimentInput("feed-sent-3911"));

    // Stage 2 — enrich: resolves the feed run's artifact by feed
    // job id and persists enriched rows naming that input.
    const enrich = await runEnrichJob(
      buildEnrichJobRegistry({}),
      { datasetStore, enrichedStore },
      ENRICH_ID,
      { runId: "enrich-run-3911", nowMs: T0 },
    );
    expect(enrich.status).toBe("completed");
    expect(enrich.received).toBe(2);
    expect(enrich.inputArtifactId).toBe(feed.artifactId);
    expect(enrich.inputRunId).toBe("feed-run-3911");
    const usable = await enrichedStore.latestUsable(ENRICH_ID);
    expect(usable?.id).toBe(enrich.artifactId);
    expect(usable?.rows).toHaveLength(2);

    // Stage 3 — analyze: finds the enriched rows via latestUsable
    // by enrich job id and persists the analysis naming them.
    const analyze = await runAnalyzeJob(
      buildAnalyzeJobRegistry({}),
      { enrichedStore, analyzedStore },
      ANALYZE_ID,
      { runId: "analyze-run-3911", nowMs: T0 },
    );
    expect(analyze.status).toBe("completed");
    expect(analyze.received).toBe(2);
    expect(analyze.codedError).toBeNull();
    expect(analyze.inputArtifactId).toBe(enrich.artifactId);
    expect(analyze.inputRunId).toBe("enrich-run-3911");
  });

  it("analyze with no enriched dataset still refuses ANALYZE_INPUT_MISSING (the incident refusal, unchanged)", async () => {
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const analyze = await runAnalyzeJob(
      buildAnalyzeJobRegistry({}),
      { enrichedStore, analyzedStore },
      ANALYZE_ID,
      { runId: "analyze-run-3911-refused", nowMs: T0 },
    );
    expect(analyze.status).toBe("failed");
    expect(analyze.codedError).toBe(ANALYZE_JOB_CODES.inputMissing);
    expect(analyze.artifactId).toBeTruthy();
    expect(await analyzedStore.latestUsable(ANALYZE_ID)).toBeUndefined();
  });

  it("enrich with only a fundamentals artifact still refuses ENRICH_INPUT_MISSING — fundamentals is never the feed input", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    await datasetStore.store(fundamentalsInput("feed-fund-only-3911"));
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const enrich = await runEnrichJob(
      buildEnrichJobRegistry({}),
      { datasetStore, enrichedStore },
      ENRICH_ID,
      { runId: "enrich-run-3911-refused", nowMs: T0 },
    );
    expect(enrich.status).toBe("failed");
    expect(enrich.codedError).toBe(ENRICH_JOB_CODES.inputMissing);
    expect(await enrichedStore.latestUsable(ENRICH_ID)).toBeUndefined();
  });
});
