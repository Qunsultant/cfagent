// @vitest-environment node
/**
 * Issue #3992 PR-2 — the refresh-leg bound: the universe
 * hydration await inside resolveUniverseListWithHydration is
 * raced against FEED_JOB_TIMEOUTS.refreshMs (PR-1 substrate,
 * withFeedDeadline).
 *
 * Before this PR, the refresh await was unbounded: a refresh
 * that never settled hung the run forever and nothing was
 * recorded (the #3976 live-confirmation hang). The bound routes
 * through the helper's EXISTING failure channel: the helper
 * flags the timeout, and each runner records it through its own
 * record() — exactly one failed run record, coded
 * FEED_REFRESH_TIMEOUT, distinctly from
 * FEED_UNIVERSE_REFRESH_FAILED (a refresh that failed) and from
 * the bare FEED_UNIVERSE_MISSING (no refresh wired).
 *
 * Pins, for EACH of the four runners (quotes / fundamentals /
 * technicals / sentiment — #3932's runner consumes the same
 * helper and carries the identical refreshTimedOut branch):
 *  1. Stored list missing + wired refresh that NEVER resolves
 *     ⇒ advancing past refreshMs settles the run: exactly one
 *     recorded run, code FEED_REFRESH_TIMEOUT.
 *  2. Refresh resolving AFTER the bound ⇒ still exactly one
 *     record, still the timeout code (the late snapshot write
 *     to the index-list store is not a run record and is not
 *     pinned against).
 *  3. Refresh resolving WITHIN the bound with a usable list ⇒
 *     the run proceeds past the universe step and completes.
 *  4. Refresh throwing quickly ⇒ FEED_UNIVERSE_REFRESH_FAILED,
 *     exactly as before this PR (regression pin).
 *  5. Unwired runner ⇒ bare FEED_UNIVERSE_MISSING (regression
 *     pin).
 *
 * Time is driven with vitest fake timers: withFeedDeadline's
 * default seam reaches the global timers, so advancing the fake
 * clock past refreshMs fires the bound deterministically.
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
  DataNewsArticle,
  DataProvider,
  DataResult,
  HistoricalBarsResult,
  NewsResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { IndexListFetchService } from "../src/services/indexListProducer";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
} from "../src/types";

const MEMBERS = ["AAPL", "MSFT", "NVDA"];
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const REFRESH_MS = FEED_JOB_TIMEOUTS.refreshMs;
const FUND_ID = YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID;
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;
const SENT_ID = YAHOO_NASDAQ100_SENTIMENT_JOB_ID;

type MembersResult = Awaited<ReturnType<IndexListFetchService["getMembers"]>>;

function membersPayload(symbols: string[] = MEMBERS): MembersResult {
  return {
    // The runners only ever request the run's own universe
    // index; the fake answers for whichever index is asked.
    index: "nasdaq100" as MembersResult["index"],
    snapshotDate: "2026-11-09",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia component table",
    derivedFromHoldings: false,
  };
}

/** A refresh whose getMembers NEVER settles — the #3992 hang. */
function neverService(): IndexListFetchService {
  return { getMembers: () => new Promise<MembersResult>(() => {}) };
}

/** A refresh the test settles by hand, when it chooses. */
function deferredService(): {
  service: IndexListFetchService;
  resolve: (value: MembersResult) => void;
} {
  let resolve!: (value: MembersResult) => void;
  const gate = new Promise<MembersResult>((res) => {
    resolve = res;
  });
  return { service: { getMembers: () => gate }, resolve };
}

function memberService(symbols: string[] = MEMBERS): IndexListFetchService {
  return { getMembers: async () => membersPayload(symbols) };
}

function throwingService(message: string): IndexListFetchService {
  return {
    getMembers: async () => {
      throw new Error(message);
    },
  };
}

function quotesAndFundamentalsProvider(): DataProvider {
  return {
    id: "yahoo",
    name: "Yahoo",
    capabilities: ["quotes", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((symbol) => ({ symbol, price: 150, lastPrice: 150 })),
      }) as DataResult<QuoteResult[]>,
    getFundamentals: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "fundamentals",
        result: {
          symbol,
          marketCap: 3_000_000_000,
          peTrailing: 28.5,
        } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
  } as DataProvider;
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

function barsProvider(): DataProvider {
  return {
    id: "yahoo",
    name: "Yahoo",
    capabilities: ["quotes", "historicalBars"],
    isConfigured: () => true,
    getHistoricalBars: async () =>
      ({
        providerId: "yahoo",
        capability: "historicalBars",
        result: risingBars(),
      }) as DataResult<HistoricalBarsResult>,
  } as DataProvider;
}

/**
 * A Yahoo-shaped provider serving fixture news per symbol (the
 * #3932 suite's fake shape). No env is threaded into the
 * sentiment runs below, so classification degrades honestly to
 * "unavailable" — the pins exercise the universe/refresh seam,
 * not the classifier.
 */
function newsProvider(): DataProvider {
  return {
    id: "yahoo",
    name: "Yahoo",
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getNews: async (symbol: string) =>
      ({
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
      }) as DataResult<NewsResult>,
  } as DataProvider;
}

/** Flush pending microtasks without advancing any clock. */
async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("Issue #3992 PR-2 — refresh-leg timeout (FEED_REFRESH_TIMEOUT)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the coded vocabulary names the refresh timeout distinctly", () => {
    expect(FEED_JOB_CODES.refreshTimeout).toBe("FEED_REFRESH_TIMEOUT");
    expect(FEED_JOB_CODES.refreshTimeout).not.toBe(
      FEED_JOB_CODES.universeRefreshFailed,
    );
    expect(FEED_JOB_CODES.refreshTimeout).not.toBe(
      FEED_JOB_CODES.universeMissing,
    );
    expect(REFRESH_MS).toBeGreaterThan(0);
  });

  describe("quotes runner (runFeedJob)", () => {
    it("never-resolving refresh ⇒ the run settles past refreshMs with exactly one record, FEED_REFRESH_TIMEOUT", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const run = runFeedJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: neverService() },
        },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-quotes-never" },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      // Still inside the bound: the run must NOT have settled.
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(await datasetStore.listRuns("yahoo", "quotes")).toHaveLength(0);

      // Past the bound: the run settles and records the timeout.
      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(settled).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(result.codedError).not.toBe(
        FEED_JOB_CODES.universeRefreshFailed,
      );
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(runs[0].run.errorMessage).toContain("did not settle within");
    });

    it("refresh resolving after the bound ⇒ still exactly one record, still the timeout code", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      const deferred = deferredService();

      const run = runFeedJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: deferred.service },
        },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-quotes-late" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1);
      const result = await run;
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(await datasetStore.listRuns("yahoo", "quotes")).toHaveLength(1);

      // The abandoned refresh now lands — its snapshot write is
      // not a run record, and the recorded outcome must not move.
      deferred.resolve(membersPayload());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving within the bound ⇒ the run proceeds and completes", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: memberService() },
        },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-quotes-in-time" },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      // The deadline timer was cleared on settle — none dangle.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refresh throwing quickly ⇒ FEED_UNIVERSE_REFRESH_FAILED, exactly as before (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: {
            store: universeStore,
            service: throwingService("wikipedia fetch exploded"),
          },
        },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-quotes-throws" },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
      const runs = await datasetStore.listRuns("yahoo", "quotes");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("wikipedia fetch exploded");
    });

    it("unwired runner ⇒ bare FEED_UNIVERSE_MISSING (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
        },
        "yahoo-nasdaq100-quotes",
        { runId: "feed-3992-quotes-unwired" },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
      // No race was started for the unwired case: no timer exists.
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("fundamentals runner (runFeedFundamentalsJob)", () => {
    it("never-resolving refresh ⇒ exactly one record, FEED_REFRESH_TIMEOUT", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const run = runFeedFundamentalsJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: neverService() },
        },
        FUND_ID,
        { runId: "feed-3992-fundamentals-never" },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      const runs = await datasetStore.listRuns("yahoo", "fundamentals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving after the bound ⇒ still exactly one record, still the timeout code", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      const deferred = deferredService();

      const run = runFeedFundamentalsJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: deferred.service },
        },
        FUND_ID,
        { runId: "feed-3992-fundamentals-late" },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1);
      const result = await run;
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");

      deferred.resolve(membersPayload());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      const runs = await datasetStore.listRuns("yahoo", "fundamentals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving within the bound ⇒ the run proceeds and completes", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedFundamentalsJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: memberService() },
        },
        FUND_ID,
        { runId: "feed-3992-fundamentals-in-time" },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refresh throwing quickly ⇒ FEED_UNIVERSE_REFRESH_FAILED (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedFundamentalsJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: {
            store: universeStore,
            service: throwingService("holdings feed unavailable"),
          },
        },
        FUND_ID,
        { runId: "feed-3992-fundamentals-throws" },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
      const runs = await datasetStore.listRuns("yahoo", "fundamentals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("holdings feed unavailable");
    });

    it("unwired runner ⇒ bare FEED_UNIVERSE_MISSING (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedFundamentalsJob(
        registry,
        {
          provider: quotesAndFundamentalsProvider(),
          universeStore,
          datasetStore,
        },
        FUND_ID,
        { runId: "feed-3992-fundamentals-unwired" },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("technicals runner (runFeedTechnicalsJob)", () => {
    it("never-resolving refresh ⇒ exactly one record, FEED_REFRESH_TIMEOUT", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const run = runFeedTechnicalsJob(
        registry,
        {
          provider: barsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: neverService() },
        },
        TECH_ID,
        { runId: "feed-3992-technicals-never", now: () => new Date(T0) },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      const runs = await datasetStore.listRuns("yahoo", "technicals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving after the bound ⇒ still exactly one record, still the timeout code", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      const deferred = deferredService();

      const run = runFeedTechnicalsJob(
        registry,
        {
          provider: barsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: deferred.service },
        },
        TECH_ID,
        { runId: "feed-3992-technicals-late", now: () => new Date(T0) },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1);
      const result = await run;
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");

      deferred.resolve(membersPayload());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      const runs = await datasetStore.listRuns("yahoo", "technicals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving within the bound ⇒ the run proceeds and completes", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedTechnicalsJob(
        registry,
        {
          provider: barsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: memberService() },
        },
        TECH_ID,
        { runId: "feed-3992-technicals-in-time", now: () => new Date(T0) },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refresh throwing quickly ⇒ FEED_UNIVERSE_REFRESH_FAILED (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedTechnicalsJob(
        registry,
        {
          provider: barsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: {
            store: universeStore,
            service: throwingService("wikipedia fetch exploded"),
          },
        },
        TECH_ID,
        { runId: "feed-3992-technicals-throws", now: () => new Date(T0) },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
      const runs = await datasetStore.listRuns("yahoo", "technicals");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("wikipedia fetch exploded");
    });

    it("unwired runner ⇒ bare FEED_UNIVERSE_MISSING (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedTechnicalsJob(
        registry,
        { provider: barsProvider(), universeStore, datasetStore },
        TECH_ID,
        { runId: "feed-3992-technicals-unwired", now: () => new Date(T0) },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("sentiment runner (runFeedSentimentJob)", () => {
    it("never-resolving refresh ⇒ the run settles past refreshMs with exactly one record, FEED_REFRESH_TIMEOUT", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const run = runFeedSentimentJob(
        registry,
        {
          provider: newsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: neverService() },
        },
        SENT_ID,
        { runId: "feed-3992-sentiment-never", now: () => new Date(T0) },
      );
      let settled = false;
      void run.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      // Still inside the bound: the run must NOT have settled.
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(await datasetStore.listRuns("yahoo", "sentiment")).toHaveLength(0);

      // Past the bound: the run settles and records the timeout.
      await vi.advanceTimersByTimeAsync(2);
      const result = await run;
      expect(settled).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(result.codedError).not.toBe(
        FEED_JOB_CODES.universeRefreshFailed,
      );
      const runs = await datasetStore.listRuns("yahoo", "sentiment");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(runs[0].run.errorMessage).toContain("did not settle within");
    });

    it("refresh resolving after the bound ⇒ still exactly one record, still the timeout code", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();
      const deferred = deferredService();

      const run = runFeedSentimentJob(
        registry,
        {
          provider: newsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: deferred.service },
        },
        SENT_ID,
        { runId: "feed-3992-sentiment-late", now: () => new Date(T0) },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1);
      const result = await run;
      expect(result.codedError).toBe("FEED_REFRESH_TIMEOUT");
      expect(await datasetStore.listRuns("yahoo", "sentiment")).toHaveLength(1);

      // The abandoned refresh now lands — its snapshot write is
      // not a run record, and the recorded outcome must not move.
      deferred.resolve(membersPayload());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      const runs = await datasetStore.listRuns("yahoo", "sentiment");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.codedError).toBe("FEED_REFRESH_TIMEOUT");
    });

    it("refresh resolving within the bound ⇒ the run proceeds and completes", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedSentimentJob(
        registry,
        {
          provider: newsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: { store: universeStore, service: memberService() },
        },
        SENT_ID,
        { runId: "feed-3992-sentiment-in-time", now: () => new Date(T0) },
      );

      expect(result.status).toBe("completed");
      expect(result.received).toBe(3);
      expect(result.codedError).toBeNull();
      // The deadline timer was cleared on settle — none dangle.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refresh throwing quickly ⇒ FEED_UNIVERSE_REFRESH_FAILED, exactly as before (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedSentimentJob(
        registry,
        {
          provider: newsProvider(),
          universeStore,
          datasetStore,
          indexRefresh: {
            store: universeStore,
            service: throwingService("wikipedia fetch exploded"),
          },
        },
        SENT_ID,
        { runId: "feed-3992-sentiment-throws", now: () => new Date(T0) },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
      const runs = await datasetStore.listRuns("yahoo", "sentiment");
      expect(runs).toHaveLength(1);
      expect(runs[0].run.errorMessage).toContain("wikipedia fetch exploded");
    });

    it("unwired runner ⇒ bare FEED_UNIVERSE_MISSING (regression)", async () => {
      const registry = buildFeedJobRegistry({});
      const universeStore = new InMemoryIndexListStore();
      const datasetStore = new InMemoryFeedDatasetStore();

      const result = await runFeedSentimentJob(
        registry,
        {
          provider: newsProvider(),
          universeStore,
          datasetStore,
        },
        SENT_ID,
        { runId: "feed-3992-sentiment-unwired", now: () => new Date(T0) },
      );

      expect(result.status).toBe("failed");
      expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
      // No race was started for the unwired case: no timer exists.
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
