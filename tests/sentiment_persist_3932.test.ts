// @vitest-environment node
/**
 * Issue #3932 (sub-issue of #3929) — a real sentiment dataset for
 * enrich and the UX, read from persisted data (Correction 2,
 * issue comments 6760487336 + 6760547214, owner 2026-11-10): ONE
 * parameterized sentiment job per data type, parameterized by the
 * symbol list as its run input. The universe is just the input —
 * the stored index list for the run's universe — never a second
 * job definition per universe. There will be no per-universe
 * sentiment jobs.
 *
 * Source decision (this slice): Yahoo News — the same Yahoo
 * `v1/finance/search` feed #132/#145's fetchRealMarketNews reads —
 * classified by the existing batched LLM classifier from #132
 * (classifyNewsSentiment, with the #881 instruction/data
 * separation), following #145's provenance + honest-degradation
 * pattern: a row carries its label + score + method ("llm" + the
 * model id, or "unavailable" with a null label — never a
 * fabricated assessment), the headline evidence behind it, and
 * the source name. The price-derived heuristic label is renamed
 * to `dayAction` wherever it stays (enrich element, screener
 * indicators, UX column); `sentiment` means the sourced value.
 *
 * Pinned here (TDD Red first, on pristine main):
 * - The same `yahoo-nasdaq100-sentiment` job serves two
 *   universes: the run input names the list; the artifact
 *   records the universe actually run; the default (no input)
 *   stays nasdaq100. An unknown universe refuses by name
 *   (FEED_UNIVERSE_UNKNOWN); a universe with no stored list
 *   fails FEED_UNIVERSE_MISSING, never an invented universe.
 *   A provider without getNews refuses by name
 *   (FEED_PROVIDER_NEWS_UNSUPPORTED); a run that fetched no
 *   news fails (FEED_NO_NEWS_RETURNED), never an empty success;
 *   per-symbol fetch failures are named in missingSymbols.
 * - Classified rows carry label + score + method "llm" + model
 *   + headline evidence; without an AI binding the same rows
 *   persist with method "unavailable" and a null label — the
 *   news was fetched, the assessment is honestly absent.
 * - The Yahoo adapter declares "news" (the contract's
 *   contract-only capability, now served): getNews returns the
 *   normalized articles in a provenance envelope, and the
 *   conformance kit passes it.
 * - Every quotes enrich job joins the parameterized sentiment
 *   dataset for ITS OWN universe and carries the sourced
 *   sentiment (label + score + source + method); the join knob
 *   opts one job out; a symbol missing from the copy is partial
 *   with a named gap; an unclassified row is a
 *   sentiment_unclassified gap; no copy at all keeps the
 *   element named-unavailable (requires_sentiment_dataset).
 * - Every chain folds the sentiment node in, and the chain's
 *   sentiment node runs with the chain's universe.
 * - The UX read path is persisted-first: persisted sentiment
 *   wins (labelled with its source), a gap stays a gap ("—",
 *   never the heuristic), and the heuristic rides alongside
 *   as "Day action".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";

// Same mocking pattern as tests/news_sentiment.test.ts: the app's
// LLM path is the Vercel AI SDK over the Workers AI binding;
// generateText is the seam. The mock labels by headline keyword
// (the classifier's prompt carries the headlines verbatim), so
// the job's real classification path runs deterministically.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  aggregateHeadlineSentiment,
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  readPersistedSentiment,
  runFeedSentimentJob,
  SENTIMENT_CLASSIFY_BATCH_SIZE,
  YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  buildEnrichJobRegistry,
  ENRICH_SENTIMENT_ELEMENTS,
  resolveSentimentJoinMode,
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
  attachPersistedSentiment,
  attachTechnicals,
  EMPTY_TECHNICALS,
  toScannedStock,
  type ScannedStock,
} from "../src/trading/screenerPipeline";
import {
  createYahooDataProvider,
  fetchYahooNewsArticles,
} from "../src/trading/dataProviders/adapters";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import type {
  FeedDatasetStoreInput,
  FeedSentimentRow,
} from "../src/data/feedDatasetPorts";
import type {
  DataNewsArticle,
  DataProvider,
  DataResult,
  NewsResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { IndexId } from "../src/trading";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
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

const mockEnv = {
  AI: { run: vi.fn() },
  AI_SEARCH_ENDPOINT: "https://mock.search",
  ORCHESTRATOR_AGENT: {},
  AGENT_SESSIONS: {},
} as unknown as Env;

/** Label the classifier prompt's headlines by keyword, as the mock model. */
function mockLabelsForPrompt(prompt: string): Array<{ id: string; sentiment: string }> {
  const labels: Array<{ id: string; sentiment: string }> = [];
  for (const line of prompt.split("\n")) {
    const m = line.match(/id=(\S+) \| tickers: [^|]+ \| headline: "(.*)"$/);
    if (!m) continue;
    const headline = m[2];
    const sentiment = /surge|beat|record|jump|rally|strong/i.test(headline)
      ? "bullish"
      : /plunge|cut|slip|fall|drop|miss|warn/i.test(headline)
        ? "bearish"
        : "neutral";
    labels.push({ id: m[1], sentiment });
  }
  return labels;
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockImplementation(async (args: unknown) => {
    const prompt = (args as { prompt?: string }).prompt ?? "";
    return {
      text: JSON.stringify({ labels: mockLabelsForPrompt(prompt) }),
    } as never;
  });
  delete process.env.CFAGENT_NEWS_SENTIMENT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CFAGENT_NEWS_SENTIMENT;
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

function sentimentArtifact(
  runId: string,
  atMs: number,
  index: IndexId,
  rows: FeedSentimentRow[],
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
    sentiment: rows,
    run: runRecord(runId, atMs, rows.length),
    nowIso: iso(atMs + 1000),
  } as unknown as FeedDatasetStoreInput;
}

function sentimentRow(
  symbol: string,
  overrides: Partial<FeedSentimentRow["sentiment"]> = {},
): FeedSentimentRow {
  return {
    symbol,
    sentiment: {
      label: "bullish",
      score: 1,
      method: "llm",
      model: "@cf/zai-org/glm-4.7-flash",
      headlineCount: 2,
      headlines: [
        {
          headline: "Acme surges on record earnings beat",
          source: "Fixture Wire",
          publishedAt: iso(T0),
          url: "https://example.test/aapl-1",
        },
      ],
      source: "yahoo-news",
      asOf: iso(T0 + 1000),
      ...overrides,
    },
  };
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

function article(
  headline: string,
  symbol: string,
  publishedAt = iso(T0),
): DataNewsArticle {
  return {
    headline,
    source: "Fixture Wire",
    publishedAt,
    symbol,
    url: `https://example.test/${symbol.toLowerCase()}`,
  };
}

/** A Yahoo-shaped provider serving fixture news per symbol. */
function yahooProvider(opts: {
  newsFor?: Record<string, DataNewsArticle[]>;
  throwFor?: string[];
} = {}): DataProvider {
  const newsFor: Record<string, DataNewsArticle[]> = opts.newsFor ?? {
    AAPL: [
      article("Acme surges on record earnings beat", "AAPL"),
      article("Acme jumps after strong guidance", "AAPL"),
    ],
    MSFT: [
      article("Globex plunges after guidance cut", "MSFT"),
      article("Globex reports quarterly results", "MSFT"),
    ],
    XOM: [article("XOM reports quarterly results", "XOM")],
  };
  return {
    id: "yahoo",
    name: "yahoo",
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quoteRow(s)),
      }) as DataResult<QuoteResult[]>,
    getNews: async (symbol: string) => {
      if (opts.throwFor?.includes(symbol)) {
        throw new Error(`Yahoo news fetch failed for "${symbol}"`);
      }
      return {
        providerId: "yahoo",
        capability: "news",
        result: newsFor[symbol] ?? [],
      } as DataResult<NewsResult>;
    },
  } as unknown as DataProvider;
}

describe("the parameterized sentiment job (#3932)", () => {
  it("registers one parameterized sentiment job (dataset sentiment, news)", () => {
    const registry = buildFeedJobRegistry({});
    const def = registry.get(SENT_ID) as FeedJobDefinition | undefined;
    expect(def).toBeDefined();
    expect(def?.sourceId).toBe("yahoo");
    expect(def?.dataset).toBe("sentiment");
    expect(def?.elements).toEqual(["news"]);
    expect(def?.parameterizedUniverse).toBe(true);
    expect(def?.universe.index).toBe("nasdaq100");
    // One job per data type — no per-universe sentiment jobs.
    expect(
      registry.list().filter((j) => j.dataset === "sentiment"),
    ).toHaveLength(1);
    expect(resolveFeedJob("sentiment")?.jobId).toBe(SENT_ID);
    expect(resolveFeedJob("yahoo sentiment")?.jobId).toBe(SENT_ID);
  });

  it("one job serves two universes: the run input names the list", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const sp = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider(), universeStore: universes, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-sp", universe: "sp100", now: () => new Date(T0) },
    );
    expect(sp.status).toBe("completed");
    expect(sp.requested).toBe(2);
    expect(sp.received).toBe(2);
    const artifact = await datasetStore.latest("yahoo", "sentiment");
    expect(artifact?.universe.index).toBe("sp100");
    expect(artifact?.sentiment?.map((r) => r.symbol).sort()).toEqual(["AAPL", "XOM"]);
    // AAPL: 2 bullish headlines -> score 1, label bullish.
    const aapl = artifact?.sentiment?.find((r) => r.symbol === "AAPL")!;
    expect(aapl.sentiment.label).toBe("bullish");
    expect(aapl.sentiment.score).toBe(1);
    expect(aapl.sentiment.method).toBe("llm");
    expect(typeof aapl.sentiment.model).toBe("string");
    expect(aapl.sentiment.headlineCount).toBe(2);
    expect(aapl.sentiment.source).toBe("yahoo-news");
    // XOM: 1 neutral headline -> score 0, label neutral.
    const xom = artifact?.sentiment?.find((r) => r.symbol === "XOM")!;
    expect(xom.sentiment.label).toBe("neutral");
    expect(xom.sentiment.score).toBe(0);
    // MSFT is not in the sp100 list — the run never fetched it.
    expect(artifact?.sentiment?.some((r) => r.symbol === "MSFT")).toBe(false);
    // The whole batch classified in ONE model call per chunk.
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("no universe input runs the default (nasdaq100)", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const result = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider(), universeStore: universes, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-nq", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    const artifact = await datasetStore.latest("yahoo", "sentiment");
    expect(artifact?.universe.index).toBe("nasdaq100");
    expect(artifact?.sentiment?.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    // MSFT: 1 bearish + 1 neutral -> score -0.5, label bearish.
    const msft = artifact?.sentiment?.find((r) => r.symbol === "MSFT")!;
    expect(msft.sentiment.label).toBe("bearish");
    expect(msft.sentiment.score).toBe(-0.5);
    expect(msft.sentiment.headlines).toHaveLength(2);
  });

  it("an unknown universe input refuses by name", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    await expect(
      runFeedSentimentJob(
        registry,
        { provider: yahooProvider(), universeStore: universes, datasetStore, env: mockEnv },
        SENT_ID,
        { universe: "nope" as never },
      ),
    ).rejects.toMatchObject({ code: FEED_JOB_CODES.universeUnknown });
  });

  it("a universe with no stored list fails FEED_UNIVERSE_MISSING, never an invented universe", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const store = new InMemoryIndexListStore();
    const registry = buildFeedJobRegistry({});
    const result = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider(), universeStore: store, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-missing", universe: "sp500", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });

  it("a provider without getNews refuses by name", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const noNews = {
      id: "yahoo",
      name: "yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
    } as unknown as DataProvider;
    const result = await runFeedSentimentJob(
      registry,
      { provider: noNews, universeStore: universes, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-nonews", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.newsUnsupported);
  });

  it("a run that fetched no news fails, never an empty success", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const result = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider({ newsFor: {} }), universeStore: universes, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-empty", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.noNewsReturned);
    expect(result.received).toBe(0);
  });

  it("a per-symbol fetch failure is named in missingSymbols, never fatal", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const result = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider({ throwFor: ["MSFT"] }), universeStore: universes, datasetStore, env: mockEnv },
      SENT_ID,
      { runId: "feed-sent-partial", now: () => new Date(T0) },
    );
    expect(result.status).toBe("partial");
    expect(result.received).toBe(1);
    expect(result.missingSymbols).toEqual(["MSFT"]);
  });

  it("without an AI binding the news still persists, honestly unassessed", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const registry = buildFeedJobRegistry({});
    const result = await runFeedSentimentJob(
      registry,
      { provider: yahooProvider(), universeStore: universes, datasetStore },
      SENT_ID,
      { runId: "feed-sent-noai", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    expect(generateText).not.toHaveBeenCalled();
    const artifact = await datasetStore.latest("yahoo", "sentiment");
    const aapl = artifact?.sentiment?.find((r) => r.symbol === "AAPL")!;
    // The headlines were fetched and persisted; the assessment
    // is honestly absent — a null label, never a guessed one.
    expect(aapl.sentiment.method).toBe("unavailable");
    expect(aapl.sentiment.label).toBeNull();
    expect(aapl.sentiment.score).toBeNull();
    expect(aapl.sentiment.headlineCount).toBe(2);
    expect(aapl.sentiment.model).toBeUndefined();
  });

  it("classifies in bounded batches, never one call per headline", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // The job caps each symbol at SENTIMENT_NEWS_PER_SYMBOL (5)
    // headlines, so one symbol can never fill two batches: five
    // symbols x five headlines each is what crosses the boundary.
    const batchSymbols = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"];
    const universes = new InMemoryIndexListStore();
    await universes.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: batchSymbols.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
    const registry = buildFeedJobRegistry({});
    expect(SENTIMENT_CLASSIFY_BATCH_SIZE).toBe(20);
    const newsFor: Record<string, DataNewsArticle[]> = {};
    for (const symbol of batchSymbols) {
      newsFor[symbol] = Array.from({ length: 5 }, (_, i) =>
        article(`Acme surges on record earnings beat ${i}`, symbol),
      );
    }
    await runFeedSentimentJob(
      registry,
      {
        provider: yahooProvider({ newsFor }),
        universeStore: universes,
        datasetStore,
        env: mockEnv,
      },
      SENT_ID,
      { runId: "feed-sent-batch", now: () => new Date(T0) },
    );
    // 25 headlines -> two bounded batches (20 + 5), never 25 calls.
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("aggregateHeadlineSentiment scores the bull/bear balance, never invents a label", () => {
    expect(aggregateHeadlineSentiment(["bullish", "bullish"])).toEqual({
      label: "bullish",
      score: 1,
    });
    expect(aggregateHeadlineSentiment(["bearish", "neutral"])).toEqual({
      label: "bearish",
      score: -0.5,
    });
    expect(aggregateHeadlineSentiment(["bullish", "bearish"])).toEqual({
      label: "neutral",
      score: 0,
    });
    expect(aggregateHeadlineSentiment([])).toEqual({ label: null, score: null });
  });
});

describe("the Yahoo adapter declares news (#3932)", () => {
  it("declares news and serves normalized articles in a provenance envelope", async () => {
    const stubNews: DataNewsArticle[] = [
      {
        headline: "Acme surges on record earnings beat",
        source: "Fixture Wire",
        publishedAt: iso(T0),
        symbol: "AAPL",
        url: "https://example.test/aapl-1",
      },
    ];
    const adapter = createYahooDataProvider(
      { isConfigured: () => true } as never,
      undefined,
      { news: async () => stubNews },
    );
    expect(adapter.capabilities).toContain("news");
    expect(adapter.capabilities).toEqual([
      "quotes",
      "historicalBars",
      "fundamentals",
      "news",
    ]);
    const envelope = await adapter.getNews!("AAPL", { runId: "run-news-1" });
    expect(envelope.providerId).toBe("yahoo");
    expect(envelope.capability).toBe("news");
    expect(envelope.result).toBe(stubNews);
  });

  it("the news capability passes the conformance kit", async () => {
    const adapter = createYahooDataProvider(
      { isConfigured: () => true } as never,
      undefined,
      {
        news: async (symbol: string) => [
          {
            headline: "Acme surges on record earnings beat",
            source: "Fixture Wire",
            publishedAt: iso(T0),
            symbol,
          },
        ],
      },
    );
    const report = await runDataProviderConformance(adapter, { symbol: "AAPL" });
    const news = report.checks.find((c) => c.capability === "news");
    expect(news?.ok).toBe(true);
  });

  it("fetchYahooNewsArticles normalizes the Yahoo search payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          news: [
            {
              uuid: "uuid-1",
              title: "Acme surges on record earnings beat",
              publisher: "Fixture Wire",
              providerPublishTime: 1760000000,
              link: "https://example.test/uuid-1",
              relatedTickers: ["AAPL"],
            },
            {
              uuid: "uuid-2",
              title: "Acme names new director",
              publisher: "Other Wire",
              providerPublishTime: 1760000600,
              link: "https://example.test/uuid-2",
              relatedTickers: [],
            },
          ],
        }),
      })),
    );
    const articles = await fetchYahooNewsArticles("AAPL");
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      headline: "Acme surges on record earnings beat",
      source: "Fixture Wire",
      publishedAt: new Date(1760000000 * 1000).toISOString(),
      symbol: "AAPL",
      url: "https://example.test/uuid-1",
    });
    // No related tickers -> the queried symbol is the subject.
    expect(articles[1].symbol).toBe("AAPL");
  });

  it("fetchYahooNewsArticles throws on a failed Yahoo response, never an empty lie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    );
    await expect(fetchYahooNewsArticles("AAPL")).rejects.toThrow(/429/);
  });
});

describe("the enrich join carries sourced sentiment (#3932)", () => {
  it("every quotes enrich job joins the sentiment dataset for its own universe", () => {
    const registry = buildEnrichJobRegistry({});
    for (const def of registry.list()) {
      expect(def.enrichFrom).toContainEqual({
        feedJobId: SENT_ID,
        sourceId: "yahoo",
        dataset: "sentiment",
        universe: def.universe.index,
      });
      for (const element of ENRICH_SENTIMENT_ELEMENTS) {
        expect(def.elements).toContain(element);
      }
    }
    expect(registry.list()).toHaveLength(19);
  });

  it("the sentiment join knob opts one job out of the sentiment element", () => {
    const off = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_SENTIMENT_JOIN: "off",
    });
    const alpaca = off.get("alpaca-nasdaq100-quotes-enrich")!;
    expect(alpaca.enrichFrom.map((s) => s.dataset)).toEqual([
      "fundamentals",
      "technicals",
    ]);
    for (const element of ENRICH_SENTIMENT_ELEMENTS) {
      expect(alpaca.elements).not.toContain(element);
    }
    // The knob is per job: the other broker jobs keep the join.
    expect(off.get("etrade-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(3);
    const bogus = buildEnrichJobRegistry({
      ENRICH_JOB_ALPACA_NASDAQ100_QUOTES_ENRICH_SENTIMENT_JOIN: "bogus",
    });
    expect(bogus.get("alpaca-nasdaq100-quotes-enrich")!.enrichFrom).toHaveLength(3);
    expect(resolveSentimentJoinMode({}, "x-enrich")).toBe("auto");
  });

  it("a broker enrich run carries sourced sentiment, and the heuristic is dayAction", async () => {
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
      sentimentArtifact("feed-s", T0, "nasdaq100", [
        sentimentRow("AAPL"),
        sentimentRow("MSFT", { label: "bearish", score: -0.5, headlineCount: 2 }),
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-sent-1", nowMs: T0 },
    );
    // No technicals copy is stored here, so the run is partial
    // on the history elements — sentiment itself is complete.
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.features.sentiment).toBe("bullish");
    expect(aapl.features.sentimentScore).toBe(1);
    expect(aapl.features.sentimentSource).toBe("yahoo-news");
    expect(aapl.features.sentimentMethod).toBe("llm");
    expect(aapl.unavailable).not.toContain("sentiment");
    // The price-derived label stays, renamed: changePercent +10%
    // is the old "sentiment" value, now the dayAction element.
    expect(aapl.features.dayAction).toBe("very_bullish");
    expect(aapl.unavailable).not.toContain("dayAction");
    const msft = artifact?.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.features.sentiment).toBe("bearish");
    expect(msft.features.sentimentScore).toBe(-0.5);
    expect(artifact?.gaps.filter((g) => g.element === "sentiment")).toEqual([]);
  });

  it("a symbol missing from the sentiment copy is partial with a named gap", async () => {
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
      sentimentArtifact("feed-s", T0, "nasdaq100", [sentimentRow("AAPL")]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const result = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-sent-2", nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const msft = artifact?.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.unavailable).toContain("sentiment");
    expect(msft.features.sentiment).toBeUndefined();
    expect(artifact?.gaps).toContainEqual({
      element: "sentiment",
      reason: "symbol_not_in_join_dataset",
      symbols: ["MSFT"],
    });
  });

  it("an unclassified row is a named gap, never a guessed label", async () => {
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
      sentimentArtifact("feed-s", T0, "nasdaq100", [
        sentimentRow("AAPL", {
          label: null,
          score: null,
          method: "unavailable",
          model: undefined,
        }),
      ]),
    );
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "alpaca-nasdaq100-quotes-enrich",
      { runId: "enrich-alpaca-sent-3", nowMs: T0 },
    );
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.unavailable).toContain("sentiment");
    expect(aapl.features.sentiment).toBeUndefined();
    expect(artifact?.gaps).toContainEqual({
      element: "sentiment",
      reason: "sentiment_unclassified",
      symbols: ["AAPL"],
    });
  });

  it("no sentiment copy at all keeps the element named-unavailable, never failed", async () => {
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
      { runId: "enrich-alpaca-sent-4", nowMs: T0 },
    );
    expect(result.status).toBe("partial");
    const artifact = await enrichedStore.latestUsable("alpaca-nasdaq100-quotes-enrich");
    expect(artifact?.gaps).toContainEqual({
      element: "sentiment",
      reason: "requires_sentiment_dataset",
      symbols: [],
    });
    expect(artifact?.rows.find((r) => r.symbol === "AAPL")?.unavailable).toContain(
      "sentiment",
    );
  });

  it("the join matches the enrich job's universe, never the newest artifact in the bucket", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    // The sp100 sentiment copy is stored FIRST, the nasdaq100
    // copy second (newest) — an unfiltered "newest wins" join
    // would hand the sp100 enrich the nasdaq100 labels.
    await datasetStore.store(
      sentimentArtifact("feed-s-sp", T0, "sp100", [
        sentimentRow("AAPL", { label: "bearish", score: -1 }),
        sentimentRow("XOM", { label: "neutral", score: 0 }),
      ]),
    );
    await datasetStore.store(
      sentimentArtifact("feed-s-nq", T0 + 60_000, "nasdaq100", [
        sentimentRow("AAPL", { label: "bullish", score: 1 }),
        sentimentRow("MSFT", { label: "bullish", score: 1 }),
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
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const registry = buildEnrichJobRegistry({});
    const sp100 = await runEnrichJob(
      registry,
      { datasetStore, enrichedStore },
      "yahoo-sp100-quotes-enrich",
      { runId: "enrich-sp100-sent-1", nowMs: T0 },
    );
    expect(sp100.status).toBe("partial");
    const spArtifact = await enrichedStore.latestUsable("yahoo-sp100-quotes-enrich");
    expect(spArtifact?.rows.find((r) => r.symbol === "AAPL")?.features.sentiment).toBe(
      "bearish",
    );
    expect(spArtifact?.rows.find((r) => r.symbol === "XOM")?.features.sentiment).toBe(
      "neutral",
    );
  });
});

describe("every chain folds the sentiment node in (#3932)", () => {
  it("each chain carries the sentiment node before enrich, with the chain's universe", () => {
    const registry = buildPipelineChainRegistry({});
    for (const chain of registry.list()) {
      expect(chain.sentimentJobId).toBe(SENT_ID);
      const ids = chain.nodes.map((n) => n.jobId);
      expect(ids).toEqual([
        chain.feedJobId,
        "yahoo-nasdaq100-fundamentals",
        "yahoo-nasdaq100-technicals",
        SENT_ID,
        chain.enrichJobId,
        chain.analyzeJobId,
        chain.generateJobId,
        chain.deliverJobId,
      ]);
    }
    expect(registry.list()).toHaveLength(19);
  });

  it("the chain's sentiment node runs with the chain's universe", () => {
    const raws = buildAllChainPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: {
        kind: string;
        steps?: Array<{ step?: string; params?: Record<string, unknown> }>;
        children?: Array<unknown>;
      };
    }>;
    expect(raws).toHaveLength(19);
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
      const sentNode = nodes.find((n) => n.params?.feedJobId === SENT_ID);
      expect(sentNode).toBeDefined();
      expect(sentNode!.step).toBe("feed.pull");
    }
    const byId = new Map(raws.map((r) => [r.jobId, r]));
    expect(
      walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === SENT_ID,
      )?.params,
    ).toMatchObject({ feedJobId: SENT_ID, universe: "nasdaq100" });
    expect(
      walk(byId.get("yahoo-sp100-quotes-pipeline")!).find(
        (n) => n.params?.feedJobId === SENT_ID,
      )?.params,
    ).toMatchObject({ feedJobId: SENT_ID, universe: "sp100" });
    // The alpaca chain now carries eight nodes (fundamentals +
    // technicals + sentiment fold in).
    expect(walk(byId.get("alpaca-nasdaq100-quotes-pipeline")!)).toHaveLength(8);
    expect(walk(byId.get("yahoo-nasdaq100-quotes-pipeline")!)).toHaveLength(8);
  });
});

describe("the feed step passes the universe input through (#3932)", () => {
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

  it("a configured universe param runs the sentiment job over that list", async () => {
    const h = await makeHarness();
    await h.control.configureJob(SENT_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: SENT_ID, universe: "sp100" } }],
      },
    });
    const dispatch = await h.control.runJob(SENT_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const artifact = await h.datasetStore.latest("yahoo", "sentiment");
    expect(artifact?.universe.index).toBe("sp100");
    expect(artifact?.sentiment?.map((r) => r.symbol).sort()).toEqual(["AAPL", "XOM"]);
    // No env is threaded in this harness — the rows persist
    // honestly unassessed, never classified without a binding.
    expect(
      artifact?.sentiment?.every((r) => r.sentiment.method === "unavailable"),
    ).toBe(true);
    expect(artifact?.run.runId).toBe(dispatch.runId);
  });

  it("an unknown universe param fails the pipeline run, by name", async () => {
    const h = await makeHarness();
    await h.control.configureJob(SENT_ID, {
      root: {
        steps: [{ step: FEED_PULL_STEP, params: { feedJobId: SENT_ID, universe: "nope" } }],
      },
    });
    const dispatch = await h.control.runJob(SENT_ID, { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
  });

  it("the built sentiment definition carries no universe param (default nasdaq100)", () => {
    const defs = buildAllFeedPipelineJobDefinitions({}) as Array<{
      jobId: string;
      root: { steps: Array<{ params: Record<string, unknown> }> };
    }>;
    const sent = defs.find((d) => d.jobId === SENT_ID)!;
    expect(sent.root.steps[0]!.params).toEqual({ feedJobId: SENT_ID });
    expect(buildFeedPipelineJobDefinition(buildFeedJobRegistry({}).get(SENT_ID)!)).toBeDefined();
  });
});

describe("the UX reads persisted sentiment first (#3932)", () => {
  it("readPersistedSentiment serves the stored rows with provenance, or missing", async () => {
    const store = new InMemoryFeedDatasetStore();
    expect(await readPersistedSentiment(store, { nowMs: T0 })).toBeUndefined();
    await store.store(
      sentimentArtifact("feed-s", T0, "nasdaq100", [
        sentimentRow("AAPL"),
        sentimentRow("MSFT", { label: "bearish", score: -0.5 }),
      ]),
    );
    const read = await readPersistedSentiment(store, { nowMs: T0 + 60_000 });
    expect(read).toBeDefined();
    expect(read?.sentimentBySymbol.get("AAPL")?.sentiment.label).toBe("bullish");
    expect(read?.sentimentBySymbol.get("MSFT")?.sentiment.score).toBe(-0.5);
    expect(read?.asOf).toBe(iso(T0 + 1000));
    expect(read?.universeIndex).toBe("nasdaq100");
    expect(read?.label).toMatch(/Yahoo News/);
    expect(read?.stale).toBe(false);
  });

  it("a stale persisted copy is reported stale so the caller falls back to a gap", async () => {
    const store = new InMemoryFeedDatasetStore();
    await store.store(
      sentimentArtifact("feed-s", T0, "nasdaq100", [sentimentRow("AAPL")]),
    );
    const read = await readPersistedSentiment(store, {
      nowMs: T0 + 4 * 3600_000,
      maxAgeSeconds: 180 * 60,
    });
    expect(read?.stale).toBe(true);
  });

  it("attachPersistedSentiment carries sourced labels into screener rows; gaps stay gaps", () => {
    const stocks = [
      toScannedStock(quoteRow("AAPL")),
      toScannedStock(quoteRow("MSFT", { price: 210, lastPrice: 210 })),
    ] as ScannedStock[];
    // Before attaching, the row carries no sourced sentiment —
    // only the price-derived day action.
    expect(stocks[0].indicators.sentiment).toBeNull();
    expect(stocks[0].indicators.dayAction).toBe("very_bullish");
    const attached = attachPersistedSentiment(
      stocks,
      new Map([
        ["AAPL", sentimentRow("AAPL")],
        ["MSFT", sentimentRow("MSFT", { label: null, score: null, method: "unavailable", model: undefined })],
      ]),
      "Yahoo News (persisted, as of 2026-11-07)",
    );
    expect(attached[0].indicators.sentiment).toBe("bullish");
    expect(attached[0].indicators.sentimentSource).toContain("Yahoo News");
    // The day action rides alongside, renamed — never presented as sentiment.
    expect(attached[0].indicators.dayAction).toBe("very_bullish");
    // An unclassified row is a gap, not a guessed label.
    expect(attached[1].indicators.sentiment).toBeNull();
    expect(attached[1].indicators.sentimentSource).toBeNull();
    expect(attached[1].indicators.dayAction).toBe("very_bullish");
    // attachTechnicals still works on the same rows.
    const withTech = attachTechnicals(attached, new Map());
    expect(withTech[0].technicals.atr14).toBeNull();
    expect(withTech[0].indicators.sentiment).toBe("bullish");
  });
});
