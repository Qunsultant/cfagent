// @vitest-environment node
/**
 * Issue #3992 PR-3 — the provider-fetch and capture-leg
 * bounds: every provider await in the four runners is raced
 * against FEED_JOB_TIMEOUTS.fetchMs, and the run-record store
 * write inside each record() is raced against
 * FEED_JOB_TIMEOUTS.captureMs (PR-1 substrate, withFeedDeadline).
 *
 * Before this PR both legs were bare awaits: a provider fetch
 * that never settled, or a dataset-store write that never
 * settled, hung the run forever and nothing was recorded (the
 * #3976 hang class, on the legs PR-2 did not cover).
 *
 * Fetch pins:
 *  - Quotes (one batch await): never-resolves ⇒ unsettled at
 *    fetchMs−1, then exactly one record FEED_FETCH_TIMEOUT;
 *    late-resolves ⇒ still one record, still the timeout;
 *    in-time ⇒ completes, no dangling timer; quick-throw ⇒
 *    FEED_FETCH_FAILED (regression).
 *  - Per-symbol loops (fundamentals / technicals-bars /
 *    sentiment-news): ONE deadline for the whole loop — the
 *    first symbol hanging consumes the budget, the remaining
 *    symbols are never fetched (provider call counts prove
 *    it), the run records exactly once with the runner's
 *    no*Returned code and firstError naming FEED_FETCH_TIMEOUT.
 *    Fundamentals also pins per-symbol granularity: symbol 1
 *    in time + symbol 2 hanging ⇒ partial, symbol 2 missing,
 *    the timeout named. Loop in-time regression: a small
 *    universe completes with timer count 0.
 *  The sentiment classification batches are NOT raced in this
 *  PR (the PR-4 execution deadline covers them) — no pin here
 *  touches the classifier; no env is threaded, so fetched
 *  headlines degrade honestly to "unavailable".
 *
 * Capture pins (quotes runner, InMemory store variants):
 *  - Store hanging on the primary write only ⇒ the run settles
 *    past captureMs on ONE degraded fallback record
 *    (FEED_CAPTURE_TIMEOUT, failed, received 0), and the
 *    result's artifactId is the fallback artifact's id.
 *  - Store hanging on every write ⇒ the run still settles with
 *    FEED_CAPTURE_TIMEOUT and artifactId "" (never fabricated);
 *    store() was called exactly twice (primary + one fallback).
 *  - Store throwing immediately ⇒ the runner rejects with the
 *    original error (today's propagation), no fallback (one
 *    store call).
 *  - Healthy store ⇒ unchanged: one record, artifactId match,
 *    timer count 0.
 *
 * Time is driven with vitest fake timers: withFeedDeadline's
 * default seam reaches the global timers AND Date.now (the
 * loop deadline's clock), so advancing the fake clock drives
 * both deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  buildFeedJobRegistry,
  runFeedJob,
  runFeedFundamentalsJob,
  runFeedTechnicalsJob,
  runFeedSentimentJob,
  FEED_JOB_CODES,
  YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
} from "../src/services/feedJobs";
import { FEED_JOB_TIMEOUTS } from "../src/services/feedJobTimeouts";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedDatasetStoreInput,
} from "../src/data/feedDatasetPorts";
import type {
  DataNewsArticle,
  DataProvider,
  DataResult,
  HistoricalBarsResult,
  NewsResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
} from "../src/types";

const MEMBERS = ["AAPL", "MSFT", "NVDA"];
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const FETCH_MS = FEED_JOB_TIMEOUTS.fetchMs;
const CAPTURE_MS = FEED_JOB_TIMEOUTS.captureMs;
const FUND_ID = YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID;
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;
const SENT_ID = YAHOO_NASDAQ100_SENTIMENT_JOB_ID;

/** Seed the stored universe list directly (no refresh leg in play). */
async function seedUniverse(
  store: InMemoryIndexListStore,
  symbols: string[] = MEMBERS,
): Promise<void> {
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-09",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia component table",
    derivedFromHoldings: false,
    nowIso: iso(T0),
  });
}

/** Flush pending microtasks without advancing any clock. */
async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* Provider fakes                                                      */
/* ------------------------------------------------------------------ */

function quoteEnvelope(symbols: string[]): DataResult<QuoteResult[]> {
  return {
    providerId: "yahoo",
    capability: "quotes",
    result: symbols.map((symbol) => ({ symbol, price: 150, lastPrice: 150 })),
  } as DataResult<QuoteResult[]>;
}

function fundamentalsEnvelope(
  symbol: string,
): DataResult<MarketDataResearchCompanyFundamentals> {
  return {
    providerId: "yahoo",
    capability: "fundamentals",
    result: {
      symbol,
      marketCap: 3_000_000_000,
      peTrailing: 28.5,
    } as MarketDataResearchCompanyFundamentals,
  } as DataResult<MarketDataResearchCompanyFundamentals>;
}

/** 30 live daily bars with a steady +1/day ramp (the #3982 shape). */
function risingBars(count = 30): MarketDataResearchHistoricalBar[] {
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

function barsEnvelope(): DataResult<HistoricalBarsResult> {
  return {
    providerId: "yahoo",
    capability: "historicalBars",
    result: risingBars(),
  } as DataResult<HistoricalBarsResult>;
}

function newsEnvelope(symbol: string): DataResult<NewsResult> {
  return {
    providerId: "yahoo",
    capability: "news",
    result: [
      {
        headline: `${symbol} reports quarterly results`,
        source: "Fixture Wire",
        publishedAt: iso(T0),
        symbol,
        url: `https://example.test/${symbol.toLowerCase()}`,
      },
    ] as DataNewsArticle[],
  } as DataResult<NewsResult>;
}

/* ------------------------------------------------------------------ */
/* Dataset-store fakes (the capture leg)                               */
/* ------------------------------------------------------------------ */

/**
 * A store whose first `hangs` store() calls never settle (the
 * capture hang); later calls delegate to a real in-memory
 * store, so a fallback write CAN land and be read back.
 */
class FlakyStore implements FeedDatasetStore {
  readonly inner = new InMemoryFeedDatasetStore();
  calls = 0;
  constructor(private readonly hangs: number) {}
  store(input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> {
    this.calls += 1;
    if (this.calls <= this.hangs) {
      return new Promise<FeedDatasetArtifact>(() => {});
    }
    return this.inner.store(input);
  }
  latest(
    sourceId: Parameters<FeedDatasetStore["latest"]>[0],
    dataset: string,
  ) {
    return this.inner.latest(sourceId, dataset);
  }
  latestUsable(
    sourceId: Parameters<FeedDatasetStore["latestUsable"]>[0],
    dataset: string,
  ) {
    return this.inner.latestUsable(sourceId, dataset);
  }
  listRuns(
    sourceId: Parameters<FeedDatasetStore["listRuns"]>[0],
    dataset: string,
    limit?: number,
  ) {
    return this.inner.listRuns(sourceId, dataset, limit);
  }
}

/** A store whose store() always throws the same error object. */
class ThrowingStore extends FlakyStore {
  readonly boom = new Error("dataset store write exploded");
  constructor() {
    super(0);
  }
  override store(
    input: FeedDatasetStoreInput,
  ): Promise<FeedDatasetArtifact> {
    this.calls += 1;
    return Promise.reject(this.boom);
  }
}

/* ------------------------------------------------------------------ */

describe("Issue #3992 PR-3 — fetch + capture legs (FEED_FETCH_TIMEOUT / FEED_CAPTURE_TIMEOUT)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the coded vocabulary names the fetch and capture timeouts distinctly", () => {
    expect(FEED_JOB_CODES.fetchTimeout).toBe("FEED_FETCH_TIMEOUT");
    expect(FEED_JOB_CODES.captureTimeout).toBe("FEED_CAPTURE_TIMEOUT");
    expect(FEED_JOB_CODES.fetchTimeout).not.toBe(FEED_JOB_CODES.fetchFailed);
    expect(FEED_JOB_CODES.captureTimeout).not.toBe(FEED_JOB_CODES.fetchTimeout);
    expect(FETCH_MS).toBeGreaterThan(0);
    expect(CAPTURE_MS).toBeGreaterThan(0);
  });

  describe("quotes runner — fetch leg (runFeedJob)", () => {
    it("never-resolving batch fetch ⇒ unsettled at fetchMs−1, then exactly one record, FEED_FETCH_TIMEOUT", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["quotes"],
        isConfigured: () => true,
        getQuotesBatch: () => new Promise(() => {}),
      } as unknown as DataProvider;

      const run = runFeedJob(
        registry,
        { provider, universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-quotes-never" },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(await datasetStore.listRuns("yahoo", "quotes")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(settled).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_FETCH_TIMEOUT");
      expect(result.codedError).not.toBe(FEED_JOB_CODES.fetchFailed);
      expect(result.missingSymbols).toEqual(MEMBERS);
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_FETCH_TIMEOUT");
      expect(runs[0].run.errorMessage).toContain("did not settle within");
    });

    it("batch fetch resolving after the bound ⇒ still exactly one record, still the timeout code", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      let resolveFetch!: (value: DataResult<QuoteResult[]>) => void;
      const gate = new Promise<DataResult<QuoteResult[]>>((res) => {
        resolveFetch = res;
      });
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["quotes"],
        isConfigured: () => true,
        getQuotesBatch: () => gate,
      } as unknown as DataProvider;

      const run = runFeedJob(
        registry,
        { provider, universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-quotes-late" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS + 1);
      const result = await run;
      expect(result.codedError).toBe("FEED_FETCH_TIMEOUT");
      expect(await datasetStore.listRuns("yahoo", "quotes")).toHaveLength(1);

      // The abandoned fetch now lands — its late result is
      // dropped; the recorded outcome must not move.
      resolveFetch(quoteEnvelope(MEMBERS));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_FETCH_TIMEOUT");
    });

    it("batch fetch in time ⇒ completes normally, no dangling timer", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["quotes"],
        isConfigured: () => true,
        getQuotesBatch: async (symbols: string[]) => quoteEnvelope(symbols),
      } as unknown as DataProvider;

      const result = await runFeedJob(
        registry,
        { provider, universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-quotes-in-time" },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("batch fetch throwing quickly ⇒ FEED_FETCH_FAILED, exactly as before (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["quotes"],
        isConfigured: () => true,
        getQuotesBatch: async () => {
          throw new Error("yahoo batch exploded");
        },
      } as unknown as DataProvider;

      const result = await runFeedJob(
        registry,
        { provider, universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-quotes-throws" },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_FETCH_FAILED");
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("yahoo batch exploded");
    });
  });

  describe("fundamentals runner — fetch loop (runFeedFundamentalsJob)", () => {
    it("first symbol never resolves ⇒ budget stops the loop (one provider call), one record, noFundamentalsReturned + FEED_FETCH_TIMEOUT named", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      let calls = 0;
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["fundamentals"],
        isConfigured: () => true,
        getFundamentals: () => {
          calls += 1;
          return new Promise(() => {});
        },
      } as unknown as DataProvider;

      const run = runFeedFundamentalsJob(
        registry,
        { provider, universeStore, datasetStore },
        FUND_ID,
        { runId: "feed-3992-pr3-fundamentals-hang" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS + 1);
      const result = await run;

      expect(calls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.noFundamentalsReturned);
      expect(result.missingSymbols).toEqual(MEMBERS);
      const runs = await datasetStore.listRuns("yahoo", "fundamentals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("FEED_FETCH_TIMEOUT");
    });

    it("symbol 1 in time, symbol 2 hangs ⇒ partial run, symbol 2 missing, provider called exactly twice, timeout named in the record", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore, ["AAPL", "MSFT"]);
      let calls = 0;
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["fundamentals"],
        isConfigured: () => true,
        getFundamentals: (symbol: string) => {
          calls += 1;
          if (symbol === "MSFT") return new Promise(() => {});
          return Promise.resolve(fundamentalsEnvelope(symbol));
        },
      } as unknown as DataProvider;

      const run = runFeedFundamentalsJob(
        registry,
        { provider, universeStore, datasetStore },
        FUND_ID,
        { runId: "feed-3992-pr3-fundamentals-partial" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS + 1);
      const result = await run;

      expect(calls).toBe(2);
      expect(result.status).toBe("partial");
      expect(result.received).toBe(1);
      expect(result.missingSymbols).toEqual(["MSFT"]);
      const runs = await datasetStore.listRuns("yahoo", "fundamentals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.status).toBe("partial");
    });

    it("small universe in time ⇒ completes normally, no dangling timer (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["fundamentals"],
        isConfigured: () => true,
        getFundamentals: async (symbol: string) =>
          fundamentalsEnvelope(symbol),
      } as unknown as DataProvider;

      const result = await runFeedFundamentalsJob(
        registry,
        { provider, universeStore, datasetStore },
        FUND_ID,
        { runId: "feed-3992-pr3-fundamentals-in-time" },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("technicals runner — fetch loop (runFeedTechnicalsJob)", () => {
    it("first symbol never resolves ⇒ budget stops the loop (one provider call), one record, noBarsReturned + FEED_FETCH_TIMEOUT named", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      let calls = 0;
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["historicalBars"],
        isConfigured: () => true,
        getHistoricalBars: () => {
          calls += 1;
          return new Promise(() => {});
        },
      } as unknown as DataProvider;

      const run = runFeedTechnicalsJob(
        registry,
        { provider, universeStore, datasetStore },
        TECH_ID,
        { runId: "feed-3992-pr3-technicals-hang", now: () => new Date(T0) },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS + 1);
      const result = await run;

      expect(calls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.noBarsReturned);
      expect(result.missingSymbols).toEqual(MEMBERS);
      const runs = await datasetStore.listRuns("yahoo", "technicals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("FEED_FETCH_TIMEOUT");
    });
  });

  describe("sentiment runner — news fetch loop (runFeedSentimentJob)", () => {
    it("first symbol never resolves ⇒ budget stops the loop (one provider call), one record, noNewsReturned + FEED_FETCH_TIMEOUT named", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);
      let calls = 0;
      const provider = {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["news"],
        isConfigured: () => true,
        getNews: () => {
          calls += 1;
          return new Promise(() => {});
        },
      } as unknown as DataProvider;

      const run = runFeedSentimentJob(
        registry,
        { provider, universeStore, datasetStore },
        SENT_ID,
        { runId: "feed-3992-pr3-sentiment-hang", now: () => new Date(T0) },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(FETCH_MS + 1);
      const result = await run;

      expect(calls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.noNewsReturned);
      expect(result.missingSymbols).toEqual(MEMBERS);
      const runs = await datasetStore.listRuns("yahoo", "sentiment");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("FEED_FETCH_TIMEOUT");
    });
  });

  describe("quotes runner — capture leg (runFeedJob record store)", () => {
    function healthyProvider(): DataProvider {
      return {
        id: "yahoo",
        name: "Yahoo",
        capabilities: ["quotes"],
        isConfigured: () => true,
        getQuotesBatch: async (symbols: string[]) => quoteEnvelope(symbols),
      } as unknown as DataProvider;
    }

    it("primary store write hangs ⇒ run settles past captureMs on the degraded fallback record (exactly one artifact, FEED_CAPTURE_TIMEOUT)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new FlakyStore(1);
      await seedUniverse(universeStore);

      const run = runFeedJob(
        registry,
        { provider: healthyProvider(), universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-capture-fallback" },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(CAPTURE_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(settled).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_CAPTURE_TIMEOUT");
      expect(result.received).toBe(0);
      expect(result.missingSymbols).toEqual(MEMBERS);
      expect(datasetStore.calls).toBe(2);

      // Exactly one artifact exists — the degraded fallback.
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.runId).toBe("feed-3992-pr3-capture-fallback");
      expect(runs[0].run.status).toBe("failed");
      expect(runs[0].run.codedError).toBe("FEED_CAPTURE_TIMEOUT");
      expect(runs[0].run.received).toBe(0);
      expect(result.artifactId).toBe(runs[0].id);
      expect(result.artifactId).not.toBe("");
    });

    it("store hangs on every write ⇒ run still settles: FEED_CAPTURE_TIMEOUT, artifactId \"\", exactly two store calls", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new FlakyStore(Number.POSITIVE_INFINITY);
      await seedUniverse(universeStore);

      const run = runFeedJob(
        registry,
        { provider: healthyProvider(), universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-capture-double-hang" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(CAPTURE_MS * 2 + 2);
      const result = await run;

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_CAPTURE_TIMEOUT");
      expect(result.artifactId).toBe("");
      expect(datasetStore.calls).toBe(2);
      expect(await datasetStore.listRuns("yahoo", "quotes")).toHaveLength(0);
    });

    it("store throws immediately ⇒ the runner rejects with the original error, no fallback (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new ThrowingStore();
      await seedUniverse(universeStore);

      await expect(
        runFeedJob(
          registry,
          { provider: healthyProvider(), universeStore, datasetStore },
          "yahoo-nasdaq100-quotes",
          { runId: "feed-3992-pr3-capture-throws" },
        ),
      ).rejects.toBe(datasetStore.boom);
      expect(datasetStore.calls).toBe(1);
    });

    it("healthy store ⇒ unchanged behaviour: one record, artifactId matches, no dangling timer (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      await seedUniverse(universeStore);

      const result = await runFeedJob(
        registry,
        { provider: healthyProvider(), universeStore, datasetStore },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-pr3-capture-healthy" },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(result.artifactId).toBe(runs[0].id);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
