/**
 * Issue #3876 (CDO, #3667 universe integration, slice 1) — the
 * Yahoo S&P 500 quotes feed job. TDD Red first.
 *
 * Scope pinned here:
 * - Registry: buildFeedJobRegistry lists "yahoo-sp500-quotes"
 *   (source yahoo, dataset quotes, universe index "sp500",
 *   label "S&P 500"), registered on the same contract as the
 *   S&P 100 job.
 * - Lineage derivation: the enrich registry derives
 *   "yahoo-sp500-quotes-enrich" and the analyze registry derives
 *   "yahoo-sp500-quotes-enrich-analyze" from it — the new feed
 *   job flows through the pipeline families by derivation,
 *   never by a second literal.
 * - Surface resolution: resolveFeedJob("sp500") and
 *   ("SP500") resolve to the new job; the pre-existing
 *   resolutions are unchanged ("SP100" still resolves to
 *   yahoo-sp100-quotes; bare "yahoo" still resolves to the
 *   Nasdaq-100 job — the sp500 entry must not claim it).
 * - Run level (the feed_jobs_s1_3530 harness pattern): with a
 *   stored sp500 list the run persists a quotes artifact; with
 *   NO stored list the run fails typed FEED_UNIVERSE_MISSING
 *   with the honest "No stored S&P 500 index list exists"
 *   message and never fetches.
 */
import { describe, it, expect } from "vitest";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { IndexListStore } from "../src/data/indexListPorts";
import {
  buildFeedJobRegistry,
  runFeedJob,
  FEED_JOB_CODES,
  YAHOO_SP500_QUOTES_JOB_ID,
} from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { resolveFeedJob } from "../src/services/feedPipelineJobs";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures (the feed_jobs_s1_3530 harness pattern)
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function quote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

const SYMBOLS = ["AAPL", "MSFT", "NVDA"];

async function sp500UniverseStore(
  symbols: string[] = SYMBOLS,
): Promise<IndexListStore> {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "sp500",
    snapshotDate: "2026-11-02",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (S&P 500 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

function fakeProvider(result: QuoteResult[] | Error): {
  provider: DataProvider;
  calls: Array<{ symbols: string[]; runId?: string }>;
} {
  const calls: Array<{ symbols: string[]; runId?: string }> = [];
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[], runContext) => {
      calls.push({ symbols: [...symbols], runId: runContext?.runId });
      if (result instanceof Error) throw result;
      return {
        providerId: "yahoo",
        capability: "quotes",
        result,
      } as DataResult<QuoteResult[]>;
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Registry + derivation + resolution
// ---------------------------------------------------------------------------

describe("yahoo-sp500-quotes feed job (#3876)", () => {
  it("the built-in registry lists the S&P 500 quotes job on the Yahoo quotes contract", () => {
    const registry = buildFeedJobRegistry({});
    const job = registry.get(YAHOO_SP500_QUOTES_JOB_ID);
    expect(job).toBeDefined();
    expect(job?.id).toBe("yahoo-sp500-quotes");
    expect(job?.sourceId).toBe("yahoo");
    expect(job?.dataset).toBe("quotes");
    expect(job?.elements).toEqual(["quotes"]);
    expect(job?.universe).toMatchObject({
      kind: "index",
      index: "sp500",
      label: "S&P 500",
    });
    expect(job?.cadenceMinutes).toBeGreaterThan(0);
    expect(job?.staleAfterMinutes).toBeGreaterThan(job?.cadenceMinutes ?? 0);
    expect(registry.list().map((j) => j.id)).toContain("yahoo-sp500-quotes");
  });

  it("the enrich registry derives yahoo-sp500-quotes-enrich from the new feed job", () => {
    const enrich = buildEnrichJobRegistry({});
    const job = enrich.get("yahoo-sp500-quotes-enrich");
    expect(job).toBeDefined();
    expect(job?.feedJobId).toBe("yahoo-sp500-quotes");
  });

  it("the analyze registry derives yahoo-sp500-quotes-enrich-analyze from the enrich job", () => {
    const analyze = buildAnalyzeJobRegistry({});
    const job = analyze.get("yahoo-sp500-quotes-enrich-analyze");
    expect(job).toBeDefined();
    expect(job?.enrichJobId).toBe("yahoo-sp500-quotes-enrich");
  });

  it("surface resolution: sp500 names resolve to the new job; existing resolutions are unchanged", () => {
    expect(resolveFeedJob("sp500")?.jobId).toBe("yahoo-sp500-quotes");
    expect(resolveFeedJob("SP500")?.jobId).toBe("yahoo-sp500-quotes");
    expect(resolveFeedJob("SP100")?.jobId).toBe("yahoo-sp100-quotes");
    expect(resolveFeedJob("yahoo")?.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(resolveFeedJob("yahoo quotes")?.jobId).toBe(
      "yahoo-nasdaq100-quotes",
    );
  });
});

// ---------------------------------------------------------------------------
// Run level
// ---------------------------------------------------------------------------

describe("runFeedJob yahoo-sp500-quotes (#3876)", () => {
  const registry = buildFeedJobRegistry({});

  it("with a stored sp500 list, the run persists a quotes artifact", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider, calls } = fakeProvider(SYMBOLS.map((s) => quote(s)));
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await sp500UniverseStore(), datasetStore },
      "yahoo-sp500-quotes",
      { runId: "feed-run-sp500-happy", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(3);
    expect(result.received).toBe(3);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(SYMBOLS);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.jobId).toBe("yahoo-sp500-quotes");
    expect(
      artifact?.quotes.map((q) => (q as MarketDataResearchQuote).symbol),
    ).toEqual(SYMBOLS);
    expect(artifact?.universe).toMatchObject({
      index: "sp500",
      label: "S&P 500",
      size: 3,
    });
    expect(artifact?.run).toMatchObject({
      runId: "feed-run-sp500-happy",
      status: "completed",
    });
  });

  it("with NO stored sp500 list, the run fails honestly: FEED_UNIVERSE_MISSING, named message, never fetches", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider, calls } = fakeProvider(SYMBOLS.map((s) => quote(s)));
    const result = await runFeedJob(
      registry,
      { provider, universeStore: new InMemoryIndexListStore(), datasetStore },
      "yahoo-sp500-quotes",
      { runId: "feed-run-sp500-nouniverse", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
    expect(calls).toHaveLength(0);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.universeMissing);
    expect(artifact?.run.errorMessage ?? "").toContain(
      "No stored S&P 500 index list exists",
    );
  });
});
