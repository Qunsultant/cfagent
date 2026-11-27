/**
 * Issue #6278 — two manual Nasdaq-100 stock screens failed
 * identically at the feed stage on 2026-11-23 ("Feed job leg
 * timed out after 240000ms (FEED_DEADLINE_EXCEEDED)") and the
 * production error named only the whole-execution deadline, so
 * the slow leg was undiagnosable.
 *
 * RCA: AlpacaMarketDataProvider.getQuotes sends all ~100
 * Nasdaq-100 symbols in ONE unchunked /v2/stocks/snapshots
 * request with no per-request timeout (bare fetch, no
 * AbortSignal) — the same single-request shape that broke
 * options-chains (#6208).
 *
 * These tests pin the fix:
 * 1. getQuotes chunks into ≤50-symbol requests and merges the
 *    results, in request order.
 * 2. Every Alpaca HTTP request carries the existing
 *    fetchTimeoutMs policy (15s default) via AbortSignal.timeout,
 *    so a hung connection fails fast instead of waiting for the
 *    60s fetch race.
 * 3. When a feed run dies at the whole-run deadline mid-retry,
 *    the terminal error carries the last leg's codedError and
 *    attempt count.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import type { Env } from "../src/types";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAPER_ENV = {
  ALPACA_PAPER_API_KEY: "PAPER_KEY",
  ALPACA_PAPER_SECRET_KEY: "PAPER_SECRET",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as unknown as Env;

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const DEADLINE_MS = 60;

/** 120 distinct symbols, so the batch spans several chunks. */
function manySymbols(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `SYM${String(i + 1).padStart(3, "0")}`);
}

function snapshotRow() {
  return {
    latestTrade: { p: 100, t: "2026-11-23T14:00:00.000Z" },
    prevDailyBar: { c: 99 },
    dailyBar: { o: 99, h: 101, l: 98, c: 100, v: 1000, vw: 100 },
    latestQuote: { bp: 99.5, ap: 100.5, bs: 10, as: 10 },
  };
}

describe("Alpaca batch quotes chunking + per-request timeout (#6278)", () => {
  it("fetches 120 symbols in ≤50-symbol requests and merges the results in request order", async () => {
    const seen: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const symbols = (new URL(url).searchParams.get("symbols") ?? "")
          .split(",")
          .filter(Boolean);
        seen.push(symbols);
        const snapshots: Record<string, unknown> = {};
        for (const s of symbols) snapshots[s] = snapshotRow();
        // Issue #6690: documented top-level symbol map, not wrapped.
        return { ok: true, json: async () => snapshots } as Response;
      }),
    );
    const provider = new AlpacaMarketDataProvider(PAPER_ENV);
    const wanted = manySymbols(120);
    const quotes = await provider.getQuotes(wanted);
    expect(seen.length).toBe(3);
    for (const chunk of seen) expect(chunk.length).toBeLessThanOrEqual(50);
    expect(seen.flat()).toEqual(wanted);
    expect(quotes.map((q) => q.symbol)).toEqual(wanted);
  });

  it("fails fast when the connection hangs: the request carries an abort signal that fires at the fetch timeout", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        // Never settles on its own — only the abort signal can end it.
        await new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      }),
    );
    const provider = new AlpacaMarketDataProvider({
      ...PAPER_ENV,
      PIPELINE_FETCH_TIMEOUT_MS: "1000",
    } as Env);
    const start = Date.now();
    await expect(provider.getQuotes(["AAPL"])).rejects.toMatchObject({
      name: "AbortError",
    });
    // The 60s fetch race is the wrong bound for a hung connection:
    // the per-request timeout must fire in ~1s, not ~60s.
    expect(Date.now() - start).toBeLessThan(5000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

function quote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yahoo",
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
  } as unknown as MarketDataResearchQuote;
}

async function universeStore() {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

/**
 * The provider double for the deadline test: call #1 rejects
 * immediately (a coded feed failure the step throws and the
 * engine retries); every later call hangs, so the whole-run
 * deadline fires mid-retry.
 */
function failingThenHangingProvider(id: DataProvider["id"]) {
  let calls = 0;
  const provider: DataProvider = {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuotesBatch: (symbols: string[]) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("provider boom"));
      }
      return new Promise<DataResult<QuoteResult[]>>(() => {});
    },
  };
  return { provider, calls: () => calls };
}

describe("deadline terminal error surfaces the last leg error (#6278)", () => {
  it("a feed run that dies at the deadline mid-retry names the last leg codedError and its attempt count", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const messaging = new InMemoryMessagingAdapter();
    const failing = failingThenHangingProvider("yahoo");
    const steps = createFeedStepRegistry({
      registry: buildFeedJobRegistry({}),
      providerFor: () => failing.provider,
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
            symbols: SYMBOLS.map((symbol) => ({ symbol })),
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
      publisher: messaging,
      steps,
      now: () => new Date(T0),
      feedExecutionDeadlineMs: DEADLINE_MS,
    });
    await ensureFeedPipelineJobs(control, stores, {});
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_DEADLINE_EXCEEDED");
    // The first attempt failed with a coded feed error before the
    // deadline fired mid-retry: the terminal error must name it
    // and the attempt it came from, or the next timeout is as
    // undiagnosable as the 2026-11-23 ones.
    expect(outcome.error).toContain("FEED_FETCH_FAILED");
    expect(outcome.error).toContain("attempt 1");

    const runs = runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failure");
    expect(runs[0]?.error).toContain("FEED_DEADLINE_EXCEEDED");
    expect(runs[0]?.error).toContain("FEED_FETCH_FAILED");
    const instance = await stores.instances.getInstance("yahoo-nasdaq100-quotes");
    expect(instance?.state).toBe("failed");
    expect(instance?.lastError).toContain("FEED_FETCH_FAILED");
  });
});
