// @vitest-environment node
/**
 * Issue #3992 — the feed Run-now hang (live evidence 2026-11-27):
 * one Run-now click left three POST feed-run async jobs running
 * for 10+ minutes, no capture attempt, no run record, and the
 * 240s execution bound never settled the run.
 *
 * Pins:
 * - Concurrent dispatches: two simultaneous runJob calls for the
 *   same feed job — exactly one executes; the other refuses
 *   job_already_running by name. (Pre-fix: the guard is
 *   check-then-write across awaits, so both pass and both run.)
 * - Setup hang: a feed run whose instance setup (the queued
 *   stamp) never settles is settled FAILED at the execution
 *   bound with a terminal record naming FEED_DEADLINE_EXCEEDED.
 *   (Pre-fix: the race covers only the execution await, so a
 *   setup hang never settles and records nothing.)
 * - Step hydration hang: a sharded unit whose pre-partition
 *   index refresh never settles fails by name with
 *   FEED_REFRESH_TIMEOUT at the refresh bound. (Pre-fix: the
 *   step-level hydration await is unbounded; only the whole-run
 *   deadline eventually fires, naming the wrong leg.)
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

const T0 = Date.parse("2026-11-27T16:22:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];

function quote(symbol: string): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price: 100,
    lastPrice: 100,
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

async function seededUniverses() {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-26",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0),
  });
  return store;
}

function healthyProvider() {
  let calls = 0;
  const provider: DataProvider = {
    id: "yahoo",
    name: "yahoo",
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      calls += 1;
      return {
        providerId: "yahoo",
        capability: "quotes",
        result: SYMBOLS.filter((s) => symbols.includes(s)).map((s) => quote(s)),
      } as unknown as DataResult<QuoteResult[]>;
    },
  };
  return { provider, calls: () => calls };
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
}

async function makeHarness(opts: {
  feedExecutionDeadlineMs: number;
  universes?: InMemoryIndexListStore;
  refreshNeverSettles?: boolean;
  env?: Record<string, string>;
}): Promise<{ harness: Harness; healthy: ReturnType<typeof healthyProvider> }> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universes = opts.universes ?? (await seededUniverses());
  const messaging = new InMemoryMessagingAdapter();
  const healthy = healthyProvider();
  const steps = createFeedStepRegistry({
    registry: buildFeedJobRegistry({}),
    providerFor: () => healthy.provider,
    universeStore: universes,
    datasetStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
    indexRefresh: {
      store: universes,
      service: {
        getMembers: opts.refreshNeverSettles
          ? () => new Promise<never>(() => {})
          : async (index) => ({
              index,
              snapshotDate: "2026-11-27",
              symbols: SYMBOLS.map((symbol) => ({ symbol })),
              source: "wikipedia",
              sourceLabel: "Wikipedia (Nasdaq-100 table)",
              derivedFromHoldings: false,
            }),
      },
    },
    ...(opts.env ? { env: opts.env as never } : {}),
  });
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: messaging,
    steps,
    now: () => new Date(T0),
    feedExecutionDeadlineMs: opts.feedExecutionDeadlineMs,
  });
  await ensureFeedPipelineJobs(control, stores, {});
  return { harness: { control, stores, runStore }, healthy };
}

describe("feed Run-now hang (#3992)", () => {
  it("concurrent dispatches: exactly one executes, the other refuses job_already_running", async () => {
    const { harness: h } = await makeHarness({ feedExecutionDeadlineMs: 5_000 });
    const results = await Promise.allSettled([
      h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" }),
      h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "job_already_running",
    });
    const outcome = await (fulfilled[0] as PromiseFulfilledResult<{ completion?: Promise<{ state: string }> }>).value.completion!;
    expect(outcome.state).toBe("completed");
    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("success");
  });

  it("setup hang: a queued-stamp write that never settles still settles FAILED at the bound with a terminal record", async () => {
    const { harness: h } = await makeHarness({ feedExecutionDeadlineMs: 80 });
    const originalSave = h.stores.instances.saveInstance.bind(h.stores.instances);
    h.stores.instances.saveInstance = async (record) => {
      if (record.state === "queued") return new Promise<never>(() => {});
      return originalSave(record);
    };
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await Promise.race([
      dispatch.completion!,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("run never settled")), 2_000),
      ),
    ]);
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_DEADLINE_EXCEEDED");
    const runs = h.runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("failure");
    expect(runs[0]?.error).toContain("FEED_DEADLINE_EXCEEDED");
    const instance = await h.stores.instances.getInstance("yahoo-nasdaq100-quotes");
    expect(instance?.state).toBe("failed");
  });

  it("step hydration hang: a pre-partition refresh that never settles fails with FEED_REFRESH_TIMEOUT at the refresh bound", async () => {
    const emptyUniverses = new InMemoryIndexListStore();
    const { harness: h } = await makeHarness({
      feedExecutionDeadlineMs: 5_000,
      universes: emptyUniverses,
      refreshNeverSettles: true,
      env: { FEED_JOB_REFRESH_MS: "80" },
    });
    const dispatch = await h.control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await Promise.race([
      dispatch.completion!,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("run never settled")), 3_000),
      ),
    ]);
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_REFRESH_TIMEOUT");
  });
});
