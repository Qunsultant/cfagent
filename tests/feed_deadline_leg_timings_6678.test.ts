/**
 * Issue #6678 — the 2026-11-26 live-proof stock screen failed
 * FEED_DEADLINE_EXCEEDED after 240000ms at the feed stage with
 * no leg named, the same signature as 2026-11-23 after #6278.
 *
 * RCA: the 240s is the whole-tree execution bound, not a leg
 * bound. Legs are individually bounded, so cumulative legs /
 * retries — or one slow-progressing leg that never fails an
 * attempt — consume the budget. lastLegError (#6278) records
 * only retryable attempt failures, so a leg that is merely slow
 * leaves the terminal error naming nothing.
 *
 * These tests pin the fix:
 * 1. A feed run whose leg hangs without ever failing an attempt
 *    still names the leg and its elapsed time in the terminal
 *    FEED_DEADLINE_EXCEEDED error.
 * 2. Cumulative retrying legs share the execution budget: once
 *    the budget is consumed the engine stops starting attempts
 *    and the terminal error names the budget exhaustion with
 *    the leg timings, instead of dying unnamed at the race.
 */
import { describe, expect, it } from "vitest";
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

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const DEADLINE_MS = 120;

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

async function runWithProvider(provider: DataProvider) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universes = await universeStore();
  const messaging = new InMemoryMessagingAdapter();
  const steps = createFeedStepRegistry({
    registry: buildFeedJobRegistry({}),
    providerFor: () => provider,
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
  return { outcome, runStore, stores };
}

describe("feed deadline names the slow leg (#6678)", () => {
  it("a leg that hangs without failing an attempt is named with its elapsed time", async () => {
    let calls = 0;
    const provider: DataProvider = {
      id: "yahoo",
      name: "yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: () => {
        calls += 1;
        return new Promise<DataResult<QuoteResult[]>>(() => {});
      },
    };
    const { outcome, runStore } = await runWithProvider(provider);
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_DEADLINE_EXCEEDED");
    // No attempt ever failed, so lastLegError (#6278) is null —
    // the leg timings must still name the consuming leg.
    expect(outcome.error).toContain("Leg timings:");
    expect(outcome.error).toContain("job:root");
    expect(outcome.error).toMatch(/\d+ms/);
    expect(calls).toBeGreaterThanOrEqual(1);
    const runs = runStore.listByJob("yahoo-nasdaq100-quotes");
    expect(runs[0]?.error).toContain("Leg timings:");
  });

  it("cumulative retrying legs share the execution budget and stop by name", async () => {
    let calls = 0;
    const provider: DataProvider = {
      id: "yahoo",
      name: "yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: () => {
        calls += 1;
        return Promise.reject(new Error("provider boom"));
      },
    };
    const { outcome } = await runWithProvider(provider);
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("FEED_DEADLINE_EXCEEDED");
    expect(outcome.error).toContain("Leg timings:");
    // The budget gate names itself instead of letting the race
    // kill a fresh attempt unnamed.
    expect(outcome.error).toContain("execution budget");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("a slow-but-bounded provider completes within the deadline", async () => {
    const provider: DataProvider = {
      id: "yahoo",
      name: "yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: async (symbols: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          providerId: "yahoo",
          result: symbols.map((symbol) => ({
            symbol,
            price: 100,
            timestamp: iso(T0),
          })),
        } as unknown as DataResult<QuoteResult[]>;
      },
    };
    const { outcome } = await runWithProvider(provider);
    expect(outcome.state).toBe("completed");
  });
});
