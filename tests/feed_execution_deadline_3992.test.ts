// @vitest-environment node
/**
 * Issue #3992 PR-4 — the pipeline-level execution deadline for
 * feed jobs, and the concurrency truthfulness around it:
 *
 * - Deadline settle: a feed run whose provider fetch never
 *   settles is settled FAILED by the engine at the injected
 *   bound; the terminal run record, the job instance, and the
 *   dispatch outcome all name FEED_DEADLINE_EXCEEDED, and
 *   exactly ONE terminal run record exists for the run.
 * - Exactly once under the zombie: when the abandoned fetch
 *   later resolves, the settled outcome does not flip — still
 *   one terminal record, instance still failed with the
 *   deadline error (abandon-not-abort: the zombie's late writes
 *   land in the step journal and the feed dataset store, never
 *   in the run's terminal path).
 * - Busy truthfulness, both directions: a genuinely live run
 *   refuses a second dispatch with job_already_running; after
 *   a deadline settle the job is NOT wedged — a new dispatch
 *   runs and completes against the now-healthy provider.
 * - In-time regression: a healthy feed run under the deadline
 *   completes with its normal success record and no deadline
 *   error anywhere.
 * - Scope: a NON-feed job whose step never settles is NOT
 *   killed by the feed deadline — past the bound it has no
 *   terminal record and its instance is still running.
 * - Bound resolution: resolveFeedExecutionDeadlineMs — a
 *   positive finite injected value wins; absent / zero /
 *   negative / NaN / Infinity fall back to the catalogue
 *   FEED_JOB_TIMEOUTS.executionMs.
 *
 * Timer idiom: REAL timers with a small injected bound (60ms),
 * matching the harness style of the #3535 suite (which uses no
 * fake timers). The never-settling doubles are released by the
 * tests themselves, so nothing here waits on a real backstop.
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
  resolveFeedExecutionDeadlineMs,
} from "../src/services/jobPipelineEngine";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { FEED_JOB_TIMEOUTS } from "../src/services/feedJobTimeouts";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const DEADLINE_MS = 60;
const PAST_DEADLINE_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 * The call-count-switched provider double: getQuotesBatch call
 * #1 never settles until the test releases it; every later call
 * resolves healthy immediately.
 */
function switchedProvider(id: DataProvider["id"]) {
  let calls = 0;
  let releaseFirst: (() => void) | null = null;
  const healthy = (symbols: string[]) =>
    ({
      providerId: id,
      capability: "quotes",
      result: SYMBOLS.filter((s) => symbols.includes(s)).map((s) => quote(s)),
    }) as unknown as DataResult<QuoteResult[]>;
  const provider: DataProvider = {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuotesBatch: (symbols: string[]) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<DataResult<QuoteResult[]>>((resolve) => {
          releaseFirst = () => resolve(healthy(symbols));
        });
      }
      return Promise.resolve(healthy(symbols));
    },
  };
  return {
    provider,
    calls: () => calls,
    releaseFirst: () => releaseFirst?.(),
  };
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
}

async function makeHarness(feedExecutionDeadlineMs?: number): Promise<{
  harness: Harness;
  switched: ReturnType<typeof switchedProvider>;
}> {
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
  const switched = switchedProvider("yahoo");
  const registry = buildFeedJobRegistry({});
  const steps = createFeedStepRegistry({
    registry,
    providerFor: () => switched.provider,
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
    ...(feedExecutionDeadlineMs !== undefined ? { feedExecutionDeadlineMs } : {}),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  return { harness: { control, stores, runStore }, switched };
}

describe("feed execution deadline (#3992 PR-4)", () => {
  it("a feed run whose fetch never settles settles FAILED at the bound, naming FEED_DEADLINE_EXCEEDED, with exactly one terminal record", async () => {
    const { harness: h } = await makeHarness(DEADLINE_MS);
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_DEADLINE_EXCEEDED");

    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failure");
    expect(runs[0]?.error).toContain("FEED_DEADLINE_EXCEEDED");

    const instance = await h.stores.instances.getInstance("yahoo-nasdaq100-quotes");
    expect(instance?.state).toBe("failed");
    expect(instance?.lastError).toContain("FEED_DEADLINE_EXCEEDED");
  });

  it("exactly once under the zombie: the abandoned fetch resolving late flips nothing", async () => {
    const { harness: h, switched } = await makeHarness(DEADLINE_MS);
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");

    switched.releaseFirst();
    await sleep(PAST_DEADLINE_MS);

    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failure");
    expect(runs[0]?.error).toContain("FEED_DEADLINE_EXCEEDED");
    const instance = await h.stores.instances.getInstance("yahoo-nasdaq100-quotes");
    expect(instance?.state).toBe("failed");
    expect(instance?.lastError).toContain("FEED_DEADLINE_EXCEEDED");
  });

  it("busy truthfulness: a live run refuses a second dispatch, and after a deadline settle a new run dispatches and completes", async () => {
    const { harness: h } = await makeHarness(DEADLINE_MS);
    const first = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    // The first run is genuinely live (its fetch never settles):
    // a second dispatch is refused while it runs.
    await expect(h.control.runJob("yahoo-nasdaq100-quotes")).rejects.toMatchObject({
      code: "job_already_running",
    });
    const firstOutcome = await first.completion!;
    expect(firstOutcome.state).toBe("failed");
    expect(firstOutcome.error).toContain("FEED_DEADLINE_EXCEEDED");

    // The deadline settled the durable instance state, so the
    // job is not wedged: a new dispatch runs — a NEW run id —
    // and completes against the now-healthy provider.
    const second = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    expect(second.runId).not.toBe(first.runId);
    const secondOutcome = await second.completion!;
    expect(secondOutcome.state).toBe("completed");

    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.outcome).sort()).toEqual(["failure", "success"]);
  });

  it("in-time regression: a healthy feed run under the deadline completes with its normal success record and no deadline error", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    const universes = await universeStore();
    const messaging = new InMemoryMessagingAdapter();
    const healthyProvider: DataProvider = {
      id: "yahoo",
      name: "yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: async (symbols: string[]) =>
        ({
          providerId: "yahoo",
          capability: "quotes",
          result: SYMBOLS.filter((s) => symbols.includes(s)).map((s) => quote(s)),
        }) as unknown as DataResult<QuoteResult[]>,
    };
    const steps = createFeedStepRegistry({
      registry: buildFeedJobRegistry({}),
      providerFor: () => healthyProvider,
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
    expect(outcome.state).toBe("completed");
    expect(outcome.error).toBeUndefined();
    const runs = runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("success");
    expect(runs[0]?.error).toBeUndefined();
    expect(JSON.stringify(runs)).not.toContain("FEED_DEADLINE_EXCEEDED");
    const instance = await stores.instances.getInstance("yahoo-nasdaq100-quotes");
    expect(instance?.state).toBe("completed");
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.quotes).toHaveLength(SYMBOLS.length);
  });

  it("scope: a non-feed job whose step never settles is NOT killed by the feed deadline", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const steps = createBuiltinStepRegistry();
    steps.register("test.hang", () => new Promise<never>(() => {}));
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps,
      now: () => new Date(T0),
      feedExecutionDeadlineMs: DEADLINE_MS,
    });
    await control.defineJob({
      jobId: "hang-probe",
      name: "Non-feed hanging probe",
      root: { kind: "probe", steps: [{ step: "test.hang" }] },
    });
    const dispatch = await control.runJob("hang-probe", { trigger: "manual" });
    void dispatch;
    await sleep(PAST_DEADLINE_MS);
    expect(runStore.listByJob("hang-probe")).toHaveLength(0);
    const instance = await stores.instances.getInstance("hang-probe");
    expect(instance?.state).toBe("running");
  });

  it("bound resolution: a positive finite value wins; absent / zero / negative / NaN / Infinity take the catalogue value", () => {
    expect(resolveFeedExecutionDeadlineMs(60)).toBe(60);
    expect(resolveFeedExecutionDeadlineMs(1)).toBe(1);
    expect(resolveFeedExecutionDeadlineMs(undefined)).toBe(FEED_JOB_TIMEOUTS.executionMs);
    expect(resolveFeedExecutionDeadlineMs()).toBe(FEED_JOB_TIMEOUTS.executionMs);
    expect(resolveFeedExecutionDeadlineMs(0)).toBe(FEED_JOB_TIMEOUTS.executionMs);
    expect(resolveFeedExecutionDeadlineMs(-5)).toBe(FEED_JOB_TIMEOUTS.executionMs);
    expect(resolveFeedExecutionDeadlineMs(Number.NaN)).toBe(FEED_JOB_TIMEOUTS.executionMs);
    expect(resolveFeedExecutionDeadlineMs(Number.POSITIVE_INFINITY)).toBe(
      FEED_JOB_TIMEOUTS.executionMs,
    );
    expect(FEED_JOB_TIMEOUTS.executionMs).toBe(240_000);
  });
});
