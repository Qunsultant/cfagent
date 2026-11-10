/**
 * Issue #3976 — incident pins: feed runners must auto-hydrate a
 * cold universe through the wired index refresh (#3875's
 * machinery), and a refresh failure must be NAMED
 * (FEED_UNIVERSE_REFRESH_FAILED), never swallowed into the bare
 * FEED_UNIVERSE_MISSING.
 *
 * Before this fix, the #3875 auto-hydrate lived only in the
 * FEED_PULL_STEP, with its refresh error swallowed by
 * `.catch(() => undefined)`; the direct runner path (and any
 * host composing the runners without the step) had no refresh
 * capability at all, so a cold universe state — e.g. a fresh
 * database with no stored Nasdaq-100 list — failed
 * yahoo-nasdaq100-quotes with FEED_UNIVERSE_MISSING even though
 * the refresh wiring existed on the host.
 *
 * Pins:
 *  1. Runner hydration: empty store + wired refresh ⇒ the run
 *     completes, the list is stored, the artifact is persisted.
 *  2. Refresh throws ⇒ the run is recorded failed with
 *     FEED_UNIVERSE_REFRESH_FAILED and the refresh error text in
 *     the message — NOT FEED_UNIVERSE_MISSING.
 *  3. Refresh completes but produces no list for the requested
 *     index ⇒ FEED_UNIVERSE_REFRESH_FAILED.
 *  4. Unwired regression: no indexRefresh dep ⇒ bare
 *     FEED_UNIVERSE_MISSING, byte-identical to the pre-fix run.
 *  5. The fundamentals runner names refresh failures the same
 *     way.
 *  6. Step path: FEED_PULL_STEP with a failing refresh fails the
 *     pipeline run naming FEED_UNIVERSE_REFRESH_FAILED (the
 *     guarantee now lives in the runner; the step no longer
 *     swallows the refresh error).
 */
import { describe, it, expect } from "vitest";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  buildFeedJobRegistry,
  runFeedJob,
  runFeedFundamentalsJob,
  FEED_JOB_CODES,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { IndexListFetchService } from "../src/services/indexListProducer";
import type { MarketDataResearchCompanyFundamentals } from "../src/types";

const MEMBERS = ["AAPL", "MSFT", "NVDA"];

function memberService(symbols: string[] = MEMBERS): IndexListFetchService {
  return {
    getMembers: async (index) => ({
      index,
      snapshotDate: "2026-11-09",
      symbols: symbols.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia component table",
      derivedFromHoldings: false,
    }),
  };
}

function throwingService(message: string): IndexListFetchService {
  return {
    getMembers: async () => {
      throw new Error(message);
    },
  };
}

function quotesProvider(): DataProvider {
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

describe("Issue #3976 — feed-runner universe auto-hydrate (incident)", () => {
  it("the coded vocabulary names a universe refresh failure", () => {
    expect(FEED_JOB_CODES.universeRefreshFailed).toBe(
      "FEED_UNIVERSE_REFRESH_FAILED",
    );
  });

  it("runner hydration: an empty universe store + wired refresh completes the run and stores the list", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    expect(await universeStore.latest("nasdaq100")).toBeUndefined();

    const result = await runFeedJob(
      registry,
      {
        provider: quotesProvider(),
        universeStore,
        datasetStore,
        indexRefresh: { store: universeStore, service: memberService() },
      },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-3976-hydrate" },
    );

    expect(result.status).toBe("completed");
    expect(result.received).toBe(3);
    expect(result.codedError).toBeNull();
    const stored = await universeStore.latest("nasdaq100");
    expect(stored?.symbols.map((s) => s.symbol)).toEqual(MEMBERS);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.status).toBe("completed");
    expect(artifact?.run.received).toBe(3);
  });

  it("runner refresh failure: a throwing refresh is recorded as FEED_UNIVERSE_REFRESH_FAILED with the refresh error named", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();

    const result = await runFeedJob(
      registry,
      {
        provider: quotesProvider(),
        universeStore,
        datasetStore,
        indexRefresh: {
          store: universeStore,
          service: throwingService("wikipedia fetch exploded"),
        },
      },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-3976-refresh-throws" },
    );

    expect(result.status).toBe("failed");
    expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    expect(result.codedError).not.toBe(FEED_JOB_CODES.universeMissing);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    expect(artifact?.run.errorMessage).toContain("wikipedia fetch exploded");
  });

  it("refresh completes but produces no list for the requested index ⇒ FEED_UNIVERSE_REFRESH_FAILED", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    // The refresh writes into a DIFFERENT store (a miswired host):
    // the refresh itself succeeds, but the runner's store still
    // has no list for the requested index after the refresh.
    const refreshStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();

    const result = await runFeedJob(
      registry,
      {
        provider: quotesProvider(),
        universeStore,
        datasetStore,
        indexRefresh: { store: refreshStore, service: memberService() },
      },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-3976-refresh-no-list" },
    );

    expect(await refreshStore.latest("nasdaq100")).toBeDefined();
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.errorMessage).toContain("no usable");
  });

  it("unwired regression: no indexRefresh dep ⇒ bare FEED_UNIVERSE_MISSING, exactly as before", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();

    const result = await runFeedJob(
      registry,
      { provider: quotesProvider(), universeStore, datasetStore },
      "yahoo-nasdaq100-quotes",
      { runId: "feed-3976-unwired" },
    );

    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.errorMessage).toContain(
      "Refresh the index list first.",
    );
  });

  it("fundamentals runner: a throwing refresh is recorded as FEED_UNIVERSE_REFRESH_FAILED", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();

    const result = await runFeedFundamentalsJob(
      registry,
      {
        provider: quotesProvider(),
        universeStore,
        datasetStore,
        indexRefresh: {
          store: universeStore,
          service: throwingService("holdings feed unavailable"),
        },
      },
      "yahoo-nasdaq100-fundamentals",
      { runId: "feed-3976-fundamentals-refresh-throws" },
    );

    expect(result.status).toBe("failed");
    expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    const artifact = await datasetStore.latest("yahoo", "fundamentals");
    expect(artifact?.run.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    expect(artifact?.run.errorMessage).toContain("holdings feed unavailable");
  });

  it("step path: FEED_PULL_STEP with a failing refresh fails naming FEED_UNIVERSE_REFRESH_FAILED", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    const universeStore = new InMemoryIndexListStore();
    const provider = quotesProvider();

    const steps = createFeedStepRegistry({
      registry: buildFeedJobRegistry({}),
      providerFor: (_def: FeedJobDefinition) => provider,
      universeStore,
      datasetStore,
      indexRefresh: {
        store: universeStore,
        service: throwingService("wikipedia fetch exploded"),
      },
    });
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      steps,
    });
    await ensureFeedPipelineJobs(control, stores, {});

    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", {
      trigger: "manual",
    });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(JSON.stringify(outcome)).toContain("FEED_UNIVERSE_REFRESH_FAILED");
    expect(JSON.stringify(outcome)).not.toContain("FEED_UNIVERSE_MISSING");
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
  });
});
