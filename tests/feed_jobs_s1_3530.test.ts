/**
 * Issue #3530 (one-of-everything, S1) — feed-job pins. TDD Red first.
 *
 * Scope pinned here:
 * - Feed dataset store conformance: in-memory + D1 (fake D1Database)
 *   adapters share one semantics — store/latest/latestUsable/listRuns,
 *   keep-per-(source,dataset) prune, run record carried on every
 *   artifact (failed runs included), missing-table reads resolve to
 *   undefined rather than throwing or inventing a row.
 * - Job contract + registry: the built-in Yahoo job
 *   (yahoo-nasdaq100-quotes: quotes over the stored Nasdaq-100 index
 *   list), duplicate registration refuses, unknown job is a typed
 *   FeedJobError, cadence/staleness knobs resolve from env with
 *   defaults and garbage-tolerant parsing.
 * - runFeedJob: happy path persists quotes verbatim + run record;
 *   captures fire through the capture-wired Yahoo adapter with the
 *   job's run id (the same recordCaptureViaDeps path screening uses);
 *   partial names the missing symbols and still stores; an empty
 *   batch is a failed run; a throwing provider is a failed run with a
 *   scrubbed message and never rethrows; a missing universe is a
 *   typed FEED_UNIVERSE_MISSING failure AND a recorded failed run;
 *   an envelope from the wrong provider is refused.
 * - Read path: serves the persisted copy with age + provenance,
 *   labels staleness instead of refusing, never fetches (no provider
 *   exists in its inputs), serves the last GOOD snapshot after a
 *   later failed run, and reports missing honestly.
 * - Status: never-run before the first run; last run + snapshot age
 *   after one.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
} from "../src/data/feedDatasetPorts";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { D1FeedDatasetStore } from "../src/data/d1FeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { IndexListStore } from "../src/data/indexListPorts";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  readFeedQuotes,
  resolveFeedJobCadenceMinutes,
  runFeedJob,
  FeedJobError,
  FEED_JOB_CODES,
} from "../src/services/feedJobs";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import { createYahooDataProvider } from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByRun,
} from "../src/trading/dataProviders/captureStore";
import type { MarketDataResearchQuote } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
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

async function universeStore(symbols: string[] = SYMBOLS): Promise<IndexListStore> {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
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

/** Minimal fake D1Database: supports exactly the statements the D1 feed-dataset adapter issues. */
function makeFakeD1() {
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  let tableExists = false;
  const byNewest = (a: Row, b: Row) =>
    a.created_at !== b.created_at
      ? (a.created_at as string) < (b.created_at as string)
        ? 1
        : -1
      : (b.id as string).localeCompare(a.id as string);
  const mine = (params: unknown[]) =>
    rows.filter(
      (r) => r.source_id === params[0] && r.dataset === params[1],
    );
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              if (/^\s*CREATE TABLE/i.test(sql)) {
                tableExists = true;
                return { success: true };
              }
              if (!tableExists) throw new Error("no such table: mas_feed_datasets");
              if (/^\s*INSERT INTO/i.test(sql)) {
                const [id, created_at, source_id, dataset, job_id, run_id, status, as_of, rows_persisted, artifact_json] =
                  params as [string, string, string, string, string, string, string, string, number, string];
                rows.push({ id, created_at, source_id, dataset, job_id, run_id, status, as_of, rows_persisted, artifact_json });
              } else if (/^\s*DELETE FROM/i.test(sql)) {
                const at = rows.findIndex((r) => r.id === params[0]);
                if (at !== -1) rows.splice(at, 1);
              }
              return { success: true };
            },
            first: async <T>() => {
              if (!tableExists) throw new Error("no such table: mas_feed_datasets");
              if (/ORDER BY created_at DESC, id DESC LIMIT 1/i.test(sql)) {
                let found = mine(params);
                if (/status != 'failed'/i.test(sql)) {
                  found = found.filter(
                    (r) => r.status !== "failed" && (r.rows_persisted as number) > 0,
                  );
                }
                const top = found.sort(byNewest)[0];
                return (top ? { artifact_json: top.artifact_json } : null) as T | null;
              }
              return null as T | null;
            },
            all: async <T>() => {
              if (!tableExists) throw new Error("no such table: mas_feed_datasets");
              if (/SELECT id FROM/i.test(sql)) {
                return {
                  results: mine(params).sort(byNewest).map((r) => ({ id: r.id })),
                } as T;
              }
              if (/SELECT artifact_json FROM/i.test(sql)) {
                const limit = params[2] as number;
                return {
                  results: mine(params)
                    .sort(byNewest)
                    .slice(0, limit)
                    .map((r) => ({ artifact_json: r.artifact_json })),
                } as T;
              }
              return { results: [] } as T;
            },
          };
        },
        run: async () => {
          if (/^\s*CREATE TABLE/i.test(sql)) tableExists = true;
          return { success: true };
        },
      };
    },
    _rows: rows,
  };
  return db;
}

function artifactInput(overrides?: Partial<FeedDatasetArtifact>): {
  jobId: string;
  sourceId: "yahoo";
  dataset: string;
  elements: string[];
  universe: FeedDatasetArtifact["universe"];
  providerId: "yahoo";
  asOf: string;
  quotes: QuoteResult[];
  run: FeedDatasetArtifact["run"];
} {
  return {
    jobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 3,
    },
    providerId: "yahoo",
    asOf: iso(T0),
    quotes: SYMBOLS.map((s) => quote(s)),
    run: {
      runId: "feed-run-1",
      trigger: "manual",
      startedAt: iso(T0 - 1000),
      finishedAt: iso(T0),
      status: "completed",
      requested: 3,
      received: 3,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Store conformance
// ---------------------------------------------------------------------------

describe("feed dataset store conformance (#3530 S1)", () => {
  const stores: Array<{ name: string; make: () => FeedDatasetStore }> = [
    { name: "in-memory", make: () => new InMemoryFeedDatasetStore() },
    { name: "d1", make: () => new D1FeedDatasetStore(makeFakeD1() as never) },
  ];

  for (const { name, make } of stores) {
    it(`${name}: store → latest returns the artifact verbatim with its run record`, async () => {
      const store = make();
      const stored = await store.store(artifactInput());
      const latest = await store.latest("yahoo", "quotes");
      expect(latest?.id).toBe(stored.id);
      expect(latest?.quotes).toHaveLength(3);
      expect(latest?.run.runId).toBe("feed-run-1");
      expect(latest?.run.status).toBe("completed");
      expect(latest?.universe.snapshotDate).toBe("2026-11-02");
    });

    it(`${name}: newest run wins latest(); latestUsable() skips a failed run`, async () => {
      const store = make();
      await store.store({ ...artifactInput(), nowIso: iso(T0) });
      const failed = artifactInput({
        asOf: iso(T0 + 60_000),
        quotes: [],
        run: {
          runId: "feed-run-2",
          trigger: "manual",
          startedAt: iso(T0 + 59_000),
          finishedAt: iso(T0 + 60_000),
          status: "failed",
          requested: 3,
          received: 0,
          failed: 3,
          missingSymbols: SYMBOLS,
          codedError: "FEED_FETCH_FAILED",
          errorMessage: "boom",
        },
      });
      await store.store({ ...failed, nowIso: iso(T0 + 60_000) });
      const latest = await store.latest("yahoo", "quotes");
      expect(latest?.run.runId).toBe("feed-run-2");
      const usable = await store.latestUsable("yahoo", "quotes");
      expect(usable?.run.runId).toBe("feed-run-1");
      expect(usable?.quotes).toHaveLength(3);
    });

    it(`${name}: listRuns is newest-first and bounded`, async () => {
      const store = make();
      for (let i = 1; i <= 3; i++) {
        await store.store({
          ...artifactInput(),
          nowIso: iso(T0 + i * 1000),
          run: { ...artifactInput().run, runId: `feed-run-${i}` },
        });
      }
      const runs = await store.listRuns("yahoo", "quotes", 2);
      expect(runs.map((r) => r.run.runId)).toEqual(["feed-run-3", "feed-run-2"]);
    });

    it(`${name}: empty store reads resolve to undefined (never-run is a state, not an error)`, async () => {
      const store = make();
      expect(await store.latest("yahoo", "quotes")).toBeUndefined();
      expect(await store.latestUsable("yahoo", "quotes")).toBeUndefined();
      expect(await store.listRuns("yahoo", "quotes")).toEqual([]);
    });

    it(`${name}: prune keeps only the newest keepPerDataset artifacts per (source, dataset)`, async () => {
      const store = make();
      for (let i = 1; i <= 12; i++) {
        await store.store({
          ...artifactInput(),
          nowIso: iso(T0 + i * 1000),
          run: { ...artifactInput().run, runId: `feed-run-${i}` },
        });
      }
      const runs = await store.listRuns("yahoo", "quotes", 50);
      expect(runs).toHaveLength(10);
      expect(runs[0].run.runId).toBe("feed-run-12");
    });
  }

  it("d1: reads against a missing table resolve to undefined instead of throwing", async () => {
    const store = new D1FeedDatasetStore(makeFakeD1() as never);
    expect(await store.latest("yahoo", "quotes")).toBeUndefined();
    expect(await store.latestUsable("yahoo", "quotes")).toBeUndefined();
    expect(await store.listRuns("yahoo", "quotes")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Job contract + registry + knobs
// ---------------------------------------------------------------------------

describe("feed job contract + registry (#3530 S1)", () => {
  it("the built-in registry carries the S1 Yahoo Nasdaq-100 quotes job first, plus the #3535 per-source set (S2's E*TRADE + Alpaca included)", () => {
    const registry = buildFeedJobRegistry({});
    const jobs = registry.list();
    // S1's pin was exactly one job. S2 adaptation (#3530 S2,
    // disclosed): S2 registers the E*TRADE and Alpaca jobs on the
    // same contract, replacing the pre-S2 count/exclusivity world.
    // #3535 (Pipeline J2) extends the registry to the full
    // per-source set — the S1 job stays first (forSource
    // resolution order is registration order), and every assertion
    // about the YAHOO job's own contract below is the original S1
    // pin, unchanged.
    expect(jobs.map((j) => j.id)).toEqual([
      "yahoo-nasdaq100-quotes",
      "yahoo-nasdaq100-fundamentals",
      "yahoo-nasdaq100-technicals",
      // #3932: one parameterized sentiment job (one definition,
      // parameterized by universe — no per-universe copies).
      "yahoo-nasdaq100-sentiment",
      "yahoo-sp100-quotes",
      "yahoo-sp500-quotes",
      "yahoo-dow-quotes",
      "yahoo-sp400-quotes",
      "alpaca-nasdaq100-quotes",
      "etrade-nasdaq100-quotes",
      "public-nasdaq100-quotes",
      // #4065: one options-chains job per optionsChains-serving
      // source (one definition each, parameterized by universe).
      "etrade-options-chains",
      "alpaca-options-chains",
      "public-options-chains",
    ]);
    const job = jobs[0];
    expect(job.id).toBe("yahoo-nasdaq100-quotes");
    expect(job.sourceId).toBe("yahoo");
    expect(job.dataset).toBe("quotes");
    expect(job.elements).toEqual(["quotes"]);
    expect(job.universe).toMatchObject({ kind: "index", index: "nasdaq100" });
    expect(job.cadenceMinutes).toBeGreaterThan(0);
    expect(job.staleAfterMinutes).toBeGreaterThan(job.cadenceMinutes);
    expect(registry.forSource("yahoo")?.id).toBe("yahoo-nasdaq100-quotes");
    expect(registry.forSource("etrade")?.id).toBe("etrade-nasdaq100-quotes");
    expect(registry.get("yahoo-nasdaq100-fundamentals")).toMatchObject({
      sourceId: "yahoo",
      dataset: "fundamentals",
      elements: ["fundamentals"],
    });
    expect(registry.get("yahoo-sp100-quotes")?.universe).toMatchObject({
      kind: "index",
      index: "sp100",
    });
  });

  it("duplicate registration refuses (registry idiom: provenance ids stay unambiguous)", () => {
    const registry = buildFeedJobRegistry({});
    const job = registry.get("yahoo-nasdaq100-quotes")!;
    expect(() => registry.register(job)).toThrow(/already registered/);
  });

  it("cadence knobs: defaults hold, env overrides win, garbage falls back to the default", () => {
    expect(resolveFeedJobCadenceMinutes({}, "yahoo-nasdaq100-quotes", 60)).toBe(60);
    expect(
      resolveFeedJobCadenceMinutes(
        { FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "15" },
        "yahoo-nasdaq100-quotes",
        60,
      ),
    ).toBe(15);
    expect(
      resolveFeedJobCadenceMinutes(
        { FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "soon" },
        "yahoo-nasdaq100-quotes",
        60,
      ),
    ).toBe(60);
    expect(
      resolveFeedJobCadenceMinutes(
        { FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "-5" },
        "yahoo-nasdaq100-quotes",
        60,
      ),
    ).toBe(60);
    const registry = buildFeedJobRegistry({
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "30",
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_STALE_MINUTES: "90",
    });
    expect(registry.get("yahoo-nasdaq100-quotes")?.cadenceMinutes).toBe(30);
    expect(registry.get("yahoo-nasdaq100-quotes")?.staleAfterMinutes).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// runFeedJob
// ---------------------------------------------------------------------------

describe("runFeedJob (#3530 S1)", () => {
  const registry = buildFeedJobRegistry({});

  it("happy path: pulls the universe through the port, persists quotes verbatim + the run record", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider, calls } = fakeProvider(SYMBOLS.map((s) => quote(s)));
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-happy", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(3);
    expect(result.received).toBe(3);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(SYMBOLS);
    expect(calls[0].runId).toBe("feed-run-happy");
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.quotes.map((q) => (q as MarketDataResearchQuote).symbol)).toEqual(SYMBOLS);
    expect(artifact?.run).toMatchObject({
      runId: "feed-run-happy",
      status: "completed",
      requested: 3,
      received: 3,
      failed: 0,
      codedError: null,
    });
    expect(artifact?.universe).toMatchObject({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      size: 3,
    });
    expect(artifact?.providerId).toBe("yahoo");
  });

  it("captures fire through the capture-wired Yahoo adapter under the job's run id (screening's own write path)", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql);
    const blobMap = new Map<string, unknown>();
    const blobStorage = {
      get: async <T>(key: string) => blobMap.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        blobMap.set(key, value);
      },
    };
    const inner = {
      isConfigured: () => true,
      getQuotes: async (symbols: string[]) => symbols.map((s) => quote(s)),
    };
    const provider = createYahooDataProvider(inner as never, {} as never, {
      capture: { sql, blobStorage, env: {} },
    });
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-capture", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    const captures = listCapturesByRun(sql, "default", "feed-run-capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      providerId: "yahoo",
      capability: "quotes",
      status: "captured",
      rawKind: "provider-result",
      runId: "feed-run-capture",
      tenantId: "default",
    });
  });

  it("partial: a symbol the provider did not return is named missing; the rest still persist", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider } = fakeProvider([quote("AAPL"), quote("NVDA")]);
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-partial", now: () => new Date(T0) },
    );
    expect(result.status).toBe("partial");
    expect(result.received).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.missingSymbols).toEqual(["MSFT"]);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.status).toBe("partial");
    expect(artifact?.quotes).toHaveLength(2);
  });

  it("empty batch: a completed fetch that returned nothing is a failed run, not an empty success", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider } = fakeProvider([]);
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-empty", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.noQuotesReturned);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.status).toBe("failed");
    expect(await datasetStore.latestUsable("yahoo", "quotes")).toBeUndefined();
  });

  it("provider throws: the run is recorded failed with a scrubbed message and never rethrows", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider } = fakeProvider(
      new Error("GET https://query2.finance.yahoo.com failed token=supersecretvalue"),
    );
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-throw", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    expect(artifact?.run.errorMessage ?? "").not.toContain("supersecretvalue");
  });

  it("missing universe: typed FEED_UNIVERSE_MISSING failure AND a recorded failed run (status surface can show it)", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider, calls } = fakeProvider(SYMBOLS.map((s) => quote(s)));
    const result = await runFeedJob(
      registry,
      { provider, universeStore: new InMemoryIndexListStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-nouniverse", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
    expect(calls).toHaveLength(0); // never fetched against an unnamed universe
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });

  it("wrong-provider envelope is refused: provenance must name the job's source", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const lying: DataProvider = {
      id: "yahoo",
      name: "Yahoo Finance",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: async () =>
        ({
          providerId: "alpaca",
          capability: "quotes",
          result: SYMBOLS.map((s) => quote(s)),
        }) as DataResult<QuoteResult[]>,
    };
    const result = await runFeedJob(
      registry,
      { provider: lying, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-liar", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.providerMismatch);
    expect(await datasetStore.latestUsable("yahoo", "quotes")).toBeUndefined();
  });

  it("a provider without the batch method fails typed, not with an undefined-call crash", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const noBatch: DataProvider = {
      id: "yahoo",
      name: "Yahoo Finance",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuote: async (symbol: string) =>
        ({ providerId: "yahoo", capability: "quotes", result: quote(symbol) }) as DataResult<QuoteResult>,
    };
    const result = await runFeedJob(
      registry,
      { provider: noBatch, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-nobatch", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.batchUnsupported);
  });

  it("unknown job id is a contract violation: typed FeedJobError, nothing stored", async () => {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider } = fakeProvider([]);
    await expect(
      runFeedJob(
        registry,
        { provider, universeStore: await universeStore(), datasetStore },
        "yahoo-ftse-quotes",
        {},
      ),
    ).rejects.toMatchObject({ name: "FeedJobError", code: FEED_JOB_CODES.jobNotFound });
    expect(await datasetStore.latest("yahoo", "quotes")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Read path + status
// ---------------------------------------------------------------------------

describe("feed read path + status (#3530 S1)", () => {
  const registry = buildFeedJobRegistry({});

  async function ranStore(): Promise<InMemoryFeedDatasetStore> {
    const datasetStore = new InMemoryFeedDatasetStore();
    const { provider } = fakeProvider(SYMBOLS.map((s) => quote(s)));
    await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-read", now: () => new Date(T0) },
    );
    return datasetStore;
  }

  it("serves the persisted copy with provenance + age; a symbol filter names what is absent", async () => {
    const datasetStore = await ranStore();
    const read = await readFeedQuotes(datasetStore, {
      sourceId: "yahoo",
      dataset: "quotes",
      symbols: ["AAPL", "TSLA"],
      nowMs: T0 + 10 * 60_000,
    });
    expect(read.status).toBe("hit");
    if (read.status !== "hit") throw new Error("unreachable");
    expect(read.quotes.map((q) => (q as MarketDataResearchQuote).symbol)).toEqual(["AAPL"]);
    expect(read.missingSymbols).toEqual(["TSLA"]);
    expect(read.ageSeconds).toBe(600);
    expect(read.stale).toBe(false);
    expect(read.provenance).toMatchObject({
      providerId: "yahoo",
      runId: "feed-run-read",
      universeIndex: "nasdaq100",
      universeSnapshotDate: "2026-11-02",
    });
  });

  it("staleness is labelled, never hidden and never a silent refetch: past the budget the hit is flagged stale", async () => {
    const datasetStore = await ranStore();
    const read = await readFeedQuotes(datasetStore, {
      sourceId: "yahoo",
      dataset: "quotes",
      maxAgeSeconds: 900,
      nowMs: T0 + 3600_000,
    });
    expect(read.status).toBe("hit");
    if (read.status !== "hit") throw new Error("unreachable");
    expect(read.stale).toBe(true);
    expect(read.ageSeconds).toBe(3600);
  });

  it("a later failed run does not poison reads: the last good snapshot still serves, labelled with ITS run", async () => {
    const datasetStore = await ranStore();
    const { provider } = fakeProvider(new Error("provider down"));
    await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-run-later-fail", now: () => new Date(T0 + 7200_000) },
    );
    const read = await readFeedQuotes(datasetStore, {
      sourceId: "yahoo",
      dataset: "quotes",
      nowMs: T0 + 7200_000,
    });
    expect(read.status).toBe("hit");
    if (read.status !== "hit") throw new Error("unreachable");
    expect(read.provenance.runId).toBe("feed-run-read");
    expect(read.quotes).toHaveLength(3);
  });

  it("no snapshot at all: a typed missing outcome with a reason, not an error and not fabricated data", async () => {
    const read = await readFeedQuotes(new InMemoryFeedDatasetStore(), {
      sourceId: "yahoo",
      dataset: "quotes",
      nowMs: T0,
    });
    expect(read.status).toBe("missing");
    if (read.status !== "missing") throw new Error("unreachable");
    expect(read.reason).toMatch(/no stored feed snapshot/);
  });

  it("status: never-run before the first run; last run + snapshot age after", async () => {
    const def = registry.get("yahoo-nasdaq100-quotes")!;
    const empty = await buildFeedStatus(new InMemoryFeedDatasetStore(), def, T0);
    expect(empty.state).toBe("never-run");
    expect(empty.lastRun).toBeNull();
    expect(empty.snapshot).toBeNull();

    const datasetStore = await ranStore();
    const status = await buildFeedStatus(datasetStore, def, T0 + 30 * 60_000);
    expect(status.state).toBe("ready");
    expect(status.lastRun).toMatchObject({ runId: "feed-run-read", status: "completed", received: 3 });
    expect(status.snapshot).toMatchObject({ rowsPersisted: 3, ageSeconds: 1800, stale: false });

    const staleStatus = await buildFeedStatus(datasetStore, def, T0 + 10 * 3600_000);
    expect(staleStatus.snapshot?.stale).toBe(true);
  });

  it("FeedJobError is a typed error carrying its stable code", () => {
    const err = new FeedJobError(FEED_JOB_CODES.jobNotFound, "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(FEED_JOB_CODES.jobNotFound);
  });
});
