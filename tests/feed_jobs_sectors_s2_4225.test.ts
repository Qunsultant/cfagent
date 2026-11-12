/**
 * Issue #4225 (CDO, #3667 universe integration, sectors slice 2) — four
 * GICS sector Yahoo quotes feed jobs (Consumer Staples, Health Care,
 * Financials, Information Technology). TDD Red first.
 *
 * Scope pinned here:
 * - Registry: buildFeedJobRegistry lists "yahoo-sector-<slug>-quotes"
 *   per sector (source yahoo, dataset quotes, universe index
 *   "sector-<slug>", label the GICS name), registered on the same
 *   contract as the S1 sector jobs.
 * - Lineage derivation: the enrich registry derives
 *   "yahoo-sector-<slug>-quotes-enrich" and the analyze registry
 *   derives "yahoo-sector-<slug>-quotes-enrich-analyze" from it —
 *   each new feed job flows through the pipeline families by
 *   derivation, never by a second literal.
 * - Surface resolution: resolveFeedJob("<slug>") and the sector
 *   alias ("sector-<slug>", "yahoo sector <slug>") resolve to the
 *   new job; the pre-existing resolutions are unchanged ("sp400"
 *   still resolves to yahoo-sp400-quotes; "dow" still resolves to
 *   yahoo-dow-quotes; "sp500" still resolves to
 *   yahoo-sp500-quotes; the four S1 sectors still resolve to their
 *   jobs; bare "yahoo" still resolves to the Nasdaq-100 job — no
 *   sector entry may claim it).
 * - Run level (the feed_jobs_s1_3530 harness pattern): with a
 *   stored sector list the run persists a quotes artifact; with
 *   NO stored list the run fails typed FEED_UNIVERSE_MISSING
 *   with the honest "No stored <GICS name> index list exists"
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
  YAHOO_SECTOR_CONSUMER_STAPLES_QUOTES_JOB_ID,
  YAHOO_SECTOR_HEALTH_CARE_QUOTES_JOB_ID,
  YAHOO_SECTOR_FINANCIALS_QUOTES_JOB_ID,
  YAHOO_SECTOR_INFORMATION_TECHNOLOGY_QUOTES_JOB_ID,
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

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
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

/** The four S2 sectors, in the file's own SECTOR_IDS (GICS code) order. */
const SECTORS = [
  {
    index: "sector-consumer-staples",
    slug: "consumer-staples",
    label: "Consumer Staples",
    jobId: "yahoo-sector-consumer-staples-quotes",
    constant: YAHOO_SECTOR_CONSUMER_STAPLES_QUOTES_JOB_ID,
  },
  {
    index: "sector-health-care",
    slug: "health-care",
    label: "Health Care",
    jobId: "yahoo-sector-health-care-quotes",
    constant: YAHOO_SECTOR_HEALTH_CARE_QUOTES_JOB_ID,
  },
  {
    index: "sector-financials",
    slug: "financials",
    label: "Financials",
    jobId: "yahoo-sector-financials-quotes",
    constant: YAHOO_SECTOR_FINANCIALS_QUOTES_JOB_ID,
  },
  {
    index: "sector-information-technology",
    slug: "information-technology",
    label: "Information Technology",
    jobId: "yahoo-sector-information-technology-quotes",
    constant: YAHOO_SECTOR_INFORMATION_TECHNOLOGY_QUOTES_JOB_ID,
  },
] as const;

async function sectorUniverseStore(
  index: string,
  label: string,
  symbols: string[] = SYMBOLS,
): Promise<IndexListStore> {
  const store = new InMemoryIndexListStore();
  await store.store({
    index,
    snapshotDate: "2026-11-08",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: `Wikipedia S&P 500 GICS Sector column (sector ${label})`,
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

describe("sector Yahoo quotes feed jobs (#4225)", () => {
  for (const s of SECTORS) {
    it(`the built-in registry lists the ${s.label} quotes job on the Yahoo quotes contract`, () => {
      const registry = buildFeedJobRegistry({});
      const job = registry.get(s.constant);
      expect(job).toBeDefined();
      expect(job?.id).toBe(s.jobId);
      expect(job?.sourceId).toBe("yahoo");
      expect(job?.dataset).toBe("quotes");
      expect(job?.elements).toEqual(["quotes"]);
      expect(job?.universe).toMatchObject({
        kind: "index",
        index: s.index,
        label: s.label,
      });
      expect(job?.cadenceMinutes).toBeGreaterThan(0);
      expect(job?.staleAfterMinutes).toBeGreaterThan(
        job?.cadenceMinutes ?? 0,
      );
      expect(registry.list().map((j) => j.id)).toContain(s.jobId);
    });

    it(`the enrich registry derives ${s.jobId}-enrich from the new feed job`, () => {
      const enrich = buildEnrichJobRegistry({});
      const job = enrich.get(`${s.jobId}-enrich`);
      expect(job).toBeDefined();
      expect(job?.feedJobId).toBe(s.jobId);
    });

    it(`the analyze registry derives ${s.jobId}-enrich-analyze from the enrich job`, () => {
      const analyze = buildAnalyzeJobRegistry({});
      const job = analyze.get(`${s.jobId}-enrich-analyze`);
      expect(job).toBeDefined();
      expect(job?.enrichJobId).toBe(`${s.jobId}-enrich`);
    });
  }

  it("surface resolution: sector names resolve to the new jobs; existing resolutions are unchanged", () => {
    for (const s of SECTORS) {
      expect(resolveFeedJob(s.slug)?.jobId).toBe(s.jobId);
      expect(resolveFeedJob(s.index)?.jobId).toBe(s.jobId);
      expect(resolveFeedJob(`yahoo sector ${s.slug}`)?.jobId).toBe(s.jobId);
    }
    expect(resolveFeedJob("sp400")?.jobId).toBe("yahoo-sp400-quotes");
    expect(resolveFeedJob("dow")?.jobId).toBe("yahoo-dow-quotes");
    expect(resolveFeedJob("sp500")?.jobId).toBe("yahoo-sp500-quotes");
    expect(resolveFeedJob("energy")?.jobId).toBe(
      "yahoo-sector-energy-quotes",
    );
    expect(resolveFeedJob("materials")?.jobId).toBe(
      "yahoo-sector-materials-quotes",
    );
    expect(resolveFeedJob("industrials")?.jobId).toBe(
      "yahoo-sector-industrials-quotes",
    );
    expect(resolveFeedJob("consumer-discretionary")?.jobId).toBe(
      "yahoo-sector-consumer-discretionary-quotes",
    );
    expect(resolveFeedJob("yahoo")?.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(resolveFeedJob("yahoo quotes")?.jobId).toBe(
      "yahoo-nasdaq100-quotes",
    );
  });
});

// ---------------------------------------------------------------------------
// Run level
// ---------------------------------------------------------------------------

describe("runFeedJob sector Yahoo quotes jobs (#4225)", () => {
  const registry = buildFeedJobRegistry({});

  for (const s of SECTORS) {
    it(`with a stored ${s.label} list, the run persists a quotes artifact`, async () => {
      const datasetStore = new InMemoryFeedDatasetStore();
      const { provider, calls } = fakeProvider(SYMBOLS.map((x) => quote(x)));
      const result = await runFeedJob(
        registry,
        {
          provider,
          universeStore: await sectorUniverseStore(s.index, s.label),
          datasetStore,
        },
        s.jobId,
        { runId: `feed-run-${s.slug}-happy`, now: () => new Date(T0) },
      );
      expect(result.status).toBe("completed");
      expect(result.requested).toBe(3);
      expect(result.received).toBe(3);
      expect(result.failed).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].symbols).toEqual(SYMBOLS);
      const artifact = await datasetStore.latest("yahoo", "quotes");
      expect(artifact?.jobId).toBe(s.jobId);
      expect(
        artifact?.quotes.map((q) => (q as MarketDataResearchQuote).symbol),
      ).toEqual(SYMBOLS);
      expect(artifact?.universe).toMatchObject({
        index: s.index,
        label: s.label,
        size: 3,
      });
      expect(artifact?.run).toMatchObject({
        runId: `feed-run-${s.slug}-happy`,
        status: "completed",
      });
    });

    it(`with NO stored ${s.label} list, the run fails honestly: FEED_UNIVERSE_MISSING, named message, never fetches`, async () => {
      const datasetStore = new InMemoryFeedDatasetStore();
      const { provider, calls } = fakeProvider(SYMBOLS.map((x) => quote(x)));
      const result = await runFeedJob(
        registry,
        {
          provider,
          universeStore: new InMemoryIndexListStore(),
          datasetStore,
        },
        s.jobId,
        { runId: `feed-run-${s.slug}-nouniverse`, now: () => new Date(T0) },
      );
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
      expect(calls).toHaveLength(0);
      const artifact = await datasetStore.latest("yahoo", "quotes");
      expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.universeMissing);
      expect(artifact?.run.errorMessage ?? "").toContain(
        `No stored ${s.label} index list exists`,
      );
    });
  }
});
