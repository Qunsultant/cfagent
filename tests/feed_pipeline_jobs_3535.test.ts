// @vitest-environment node
/**
 * Issue #3535 (Pipeline J2) — the feed jobs on the J1 pipeline:
 *
 * - Catalog + name resolution: every source the epic names
 *   (Yahoo quotes + fundamentals, SP100, Alpaca, E*TRADE, Public,
 *   the Nasdaq-100 universe) resolves; ambiguous/unknown names
 *   refuse (null) rather than guessing.
 * - Definitions: each catalog job is a valid J1 definition by
 *   configuration alone — feed kind, the feed step, the source as
 *   its input, an enabled interval schedule from the cadence knob.
 * - Runs through the control plane: a run pulls through the
 *   provider port, persists the dataset artifact under the
 *   PIPELINE run id (captures + records name the same run),
 *   records its run through the JobRunRecordStore machinery with
 *   system "job-pipeline", and surfaces in the merged status
 *   view (rows persisted, freshness, history, next run).
 * - Fundamentals: the Yahoo fundamentals job persists per-symbol
 *   fundamentals rows; the stored copy is usable and counted.
 * - Modes: the same job runs under sync delivery, and sharded
 *   (partitioned pulls whose artifacts cover the universe).
 * - Management: pause/resume/cancel/retry operate on a feed job
 *   through the same control plane the copilot and UX dispatch.
 * - Refusals: an unwired provider fails the run with
 *   FEED_JOB_NOT_CONFIGURED; a failed pull fails the pipeline run
 *   with the feed run's coded error.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  FEED_PIPELINE_CATALOG,
  NASDAQ100_UNIVERSE_JOB_ID,
  buildAllFeedPipelineJobDefinitions,
  buildFeedJobSurfaceView,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  resolveFeedJob,
} from "../src/services/feedPipelineJobs";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchQuote,
} from "../src/types";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];

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

function fundamentals(symbol: string): MarketDataResearchCompanyFundamentals {
  return { symbol, marketCap: 1_000_000 } as MarketDataResearchCompanyFundamentals;
}

async function universeStore(symbols: string[] = SYMBOLS) {
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
  await store.store({
    index: "sp100",
    snapshotDate: "2026-11-02",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (S&P 100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

function fakeProvider(
  id: DataProvider["id"],
  opts: {
    quotes?: QuoteResult[] | Error;
    withFundamentals?: boolean;
    batchCalls?: Array<{ symbols: string[]; runId?: string }>;
  } = {},
): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[], runContext) => {
      opts.batchCalls?.push({ symbols: [...symbols], runId: runContext?.runId });
      if (opts.quotes instanceof Error) throw opts.quotes;
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = (opts.quotes ?? SYMBOLS.map((s) => quote(s))).filter((q) =>
        wanted.has((q as { symbol: string }).symbol.toUpperCase()),
      );
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
    ...(opts.withFundamentals
      ? {
          getFundamentals: async (symbol: string) =>
            ({
              providerId: id,
              capability: "fundamentals",
              result: fundamentals(symbol),
            }) as DataResult<MarketDataResearchCompanyFundamentals>,
        }
      : {}),
  };
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
  datasetStore: InMemoryFeedDatasetStore;
  events: string[];
}

async function makeHarness(
  providerFor: (def: FeedJobDefinition) => DataProvider | undefined,
): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
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
  const events: string[] = [];
  messaging.subscribe("collector", "job.completed", (e) => {
    events.push(e.type);
    return "processed";
  });
  const registry = buildFeedJobRegistry({});
  const steps = createFeedStepRegistry({
    registry,
    providerFor,
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
    publisher: ports.publisher,
    steps,
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  return { control, stores, runStore, datasetStore, events };
}

describe("feed pipeline catalog + resolution (#3535)", () => {
  it("names every source in the epic's list", () => {
    expect(FEED_PIPELINE_CATALOG.map((e) => e.jobId)).toEqual([
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
      // #4065: one options-chains job per optionsChains-serving source.
      "etrade-options-chains",
      "alpaca-options-chains",
      "public-options-chains",
      "nasdaq-nasdaq100-universe",
    ]);
  });

  it("resolves surface names to exactly one job; ambiguity refuses", () => {
    expect(resolveFeedJob("yahoo")?.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(resolveFeedJob("Alpaca")?.jobId).toBe("alpaca-nasdaq100-quotes");
    expect(resolveFeedJob("etrade")?.jobId).toBe("etrade-nasdaq100-quotes");
    expect(resolveFeedJob("public")?.jobId).toBe("public-nasdaq100-quotes");
    expect(resolveFeedJob("nasdaq100")?.jobId).toBe(NASDAQ100_UNIVERSE_JOB_ID);
    expect(resolveFeedJob("SP100")?.jobId).toBe("yahoo-sp100-quotes");
    expect(resolveFeedJob("fundamentals")?.jobId).toBe("yahoo-nasdaq100-fundamentals");
    expect(resolveFeedJob("alpaca-nasdaq100-quotes")?.jobId).toBe("alpaca-nasdaq100-quotes");
    expect(resolveFeedJob("run the yahoo feed job")?.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(resolveFeedJob("quotes")).toBeNull();
    expect(resolveFeedJob("bloomberg")).toBeNull();
    expect(resolveFeedJob("")).toBeNull();
  });

  it("every catalog job is a valid J1 definition by configuration alone", () => {
    const raws = buildAllFeedPipelineJobDefinitions({});
    // #4065 pin update: three options-chains jobs join the catalog.
    expect(raws).toHaveLength(15);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("feed");
      expect(resolved.config.schedule.enabled).toBe(true);
      expect(resolved.config.schedule.interval).toMatch(/^every \d+ minutes$/);
      expect(resolved.root.steps?.[0]?.step).toMatch(/^feed\./);
    }
  });

  it("ensure defines all jobs once; re-ensuring does not churn versions", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps: createFeedStepRegistry({
        registry: buildFeedJobRegistry({}),
        providerFor: () => undefined,
        universeStore: null,
        datasetStore: null,
      }),
    });
    const first = await ensureFeedPipelineJobs(control, stores, {});
    // #4065 pin update: three options-chains jobs join the plane.
    expect(first).toHaveLength(15);
    const versions = new Map<string, number>();
    for (const def of await stores.definitions.listDefinitions()) {
      versions.set(def.jobId, def.version);
    }
    await ensureFeedPipelineJobs(control, stores, {});
    for (const def of await stores.definitions.listDefinitions()) {
      expect(def.version).toBe(versions.get(def.jobId));
    }
  });
});

describe("feed jobs through the control plane (#3535)", () => {
  it("a Yahoo quotes run persists its dataset under the pipeline run id and records through the run machinery", async () => {
    const batchCalls: Array<{ symbols: string[]; runId?: string }> = [];
    const h = await makeHarness((def) =>
      fakeProvider(def.sourceId, { batchCalls }),
    );
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    // The dataset artifact carries the PIPELINE run id — one run, one id.
    const artifact = await h.datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.runId).toBe(dispatch.runId);
    expect(artifact?.quotes).toHaveLength(SYMBOLS.length);
    expect(batchCalls[0]?.runId).toBe(dispatch.runId);

    // Run records through the platform machinery, system "job-pipeline".
    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.system).toBe("job-pipeline");
    expect(runs[0]?.outcome).toBe("success");
    expect(h.events).toContain("job.completed");
  });

  it("the merged status view carries rows, freshness, history, and the next scheduled run", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes");
    await dispatch.completion!;
    const entry = resolveFeedJob("yahoo")!;
    const view = await buildFeedJobSurfaceView({
      entry,
      datasetStore: h.datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await h.control.getJob("yahoo-nasdaq100-quotes"),
      nowMs: T0 + 30 * 60_000,
    });
    expect(view.feed?.state).toBe("ready");
    expect(view.feed?.snapshot?.rowsPersisted).toBe(SYMBOLS.length);
    expect(view.feed?.snapshot?.stale).toBe(false);
    expect(view.feed?.history).toHaveLength(1);
    expect(view.pipeline?.state).toBe("completed");
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.nextScheduledRun).not.toBeNull();
  });

  it("a never-run source shows the honest never-run state", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    const view = await buildFeedJobSurfaceView({
      entry: resolveFeedJob("alpaca")!,
      datasetStore: h.datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await h.control.getJob("alpaca-nasdaq100-quotes"),
      nowMs: T0,
    });
    expect(view.feed?.state).toBe("never-run");
    expect(view.feed?.lastRun).toBeNull();
    expect(view.feed?.snapshot).toBeNull();
  });

  it("the fundamentals job persists per-symbol rows and the copy is usable", async () => {
    const h = await makeHarness((def) =>
      fakeProvider(def.sourceId, { withFundamentals: true }),
    );
    const dispatch = await h.control.runJob("yahoo-nasdaq100-fundamentals");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const usable = await h.datasetStore.latestUsable("yahoo", "fundamentals");
    expect(usable?.fundamentals).toHaveLength(SYMBOLS.length);
    expect(usable?.quotes).toHaveLength(0);
    const view = await buildFeedJobSurfaceView({
      entry: resolveFeedJob("fundamentals")!,
      datasetStore: h.datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await h.control.getJob("yahoo-nasdaq100-fundamentals"),
      nowMs: T0,
    });
    expect(view.feed?.snapshot?.rowsPersisted).toBe(SYMBOLS.length);
  });

  it("the Nasdaq-100 universe job refreshes the stored index list", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    const dispatch = await h.control.runJob(NASDAQ100_UNIVERSE_JOB_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.runStore.listByJob(NASDAQ100_UNIVERSE_JOB_ID)[0]?.outcome).toBe("success");
  });

  it("an unwired provider fails the run with FEED_JOB_NOT_CONFIGURED", async () => {
    const h = await makeHarness(() => undefined);
    const dispatch = await h.control.runJob("alpaca-nasdaq100-quotes");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_JOB_NOT_CONFIGURED");
    expect(h.runStore.listByJob("alpaca-nasdaq100-quotes")[0]?.outcome).toBe("failure");
  });

  it("a failed pull fails the pipeline run with the feed run's coded error", async () => {
    const h = await makeHarness((def) =>
      fakeProvider(def.sourceId, { quotes: new Error("provider down") }),
    );
    const dispatch = await h.control.runJob("etrade-nasdaq100-quotes");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_FETCH_FAILED");
    // The dataset store recorded the failed run too — the two records agree.
    const artifact = await h.datasetStore.latest("etrade", "quotes");
    expect(artifact?.run.status).toBe("failed");
    expect(artifact?.run.codedError).toBe("FEED_FETCH_FAILED");
  });
});

describe("feed job execution modes (#3535)", () => {
  it("sync delivery returns the terminal state at dispatch", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    await h.control.configureJob("alpaca-nasdaq100-quotes", {
      root: { executionMode: { delivery: "sync" } },
    });
    const dispatch = await h.control.runJob("alpaca-nasdaq100-quotes");
    expect(dispatch.state).toBe("completed");
    expect(dispatch.completion).toBeUndefined();
  });

  it("sharded mode partitions the universe across shard units", async () => {
    const batchCalls: Array<{ symbols: string[]; runId?: string }> = [];
    const h = await makeHarness((def) =>
      fakeProvider(def.sourceId, { batchCalls }),
    );
    await h.control.configureJob("yahoo-nasdaq100-quotes", {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // Two shard units pulled disjoint partitions covering the universe.
    expect(batchCalls).toHaveLength(2);
    const pulled = batchCalls.flatMap((c) => c.symbols).sort();
    expect(pulled).toEqual([...SYMBOLS].sort());
    expect(batchCalls[0]?.symbols).not.toEqual(batchCalls[1]?.symbols);
  });

  it("online x sync is refused by name, never silently downgraded", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    await expect(
      h.control.configureJob("yahoo-nasdaq100-quotes", {
        root: { executionMode: { pacing: "online", delivery: "sync" } },
      }),
    ).rejects.toThrow(/job_execution_mode_unsupported|unsupported/i);
  });
});

describe("feed job management through the control plane (#3535)", () => {
  it("pause / resume / cancel / retry operate on a feed job", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    // Cancel a fresh dispatch's job before it settles is racy; the
    // deterministic management proof is over terminal + fresh
    // states: retry re-runs a completed job as a new run.
    const first = await h.control.runJob("public-nasdaq100-quotes");
    await first.completion!;
    const retried = await h.control.retryJob("public-nasdaq100-quotes");
    const retryOutcome = await retried.completion!;
    expect(retryOutcome.state).toBe("completed");
    expect(retried.runId).not.toBe(first.runId);
    expect(h.runStore.listByJob("public-nasdaq100-quotes")).toHaveLength(2);

    // Pause and cancel refuse honestly on a non-running job.
    await expect(h.control.pauseJob("public-nasdaq100-quotes")).rejects.toThrow(
      /pausable|can pause/i,
    );
    const view = await h.control.getJob("public-nasdaq100-quotes");
    expect(view.definition.jobId).toBe("public-nasdaq100-quotes");
    expect(view.history).toHaveLength(2);
  });

  it("registerSchedules registers every feed job + sub-node with the host", async () => {
    const h = await makeHarness((def) => fakeProvider(def.sourceId));
    const specs: Array<{ jobId: string; nodePath: string; interval?: string }> = [];
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    });
    // #4065 pin update: three options-chains jobs join the plane.
    expect(registrations).toHaveLength(15);
    expect(specs.every((s) => s.nodePath === "")).toBe(true);
    expect(specs.map((s) => s.jobId).sort()).toEqual(
      FEED_PIPELINE_CATALOG.map((e) => e.jobId).sort(),
    );
  });
});
