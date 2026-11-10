// @vitest-environment node
/**
 * Issue #3982 — follow-up to #3976: the technicals feed runner
 * must route its universe resolution through the same
 * `resolveUniverseListWithHydration` helper as the quotes and
 * fundamentals runners (#3976).
 *
 * Before this fix, `runFeedTechnicalsJob` (#3931) read the
 * stored index list directly and recorded a bare
 * FEED_UNIVERSE_MISSING on a cold store, even when the host had
 * wired the index refresh into the runner deps — the #3976
 * incident class on the runner #3931 added afterwards.
 *
 * Pins:
 *  1. Runner hydration: empty store + wired refresh ⇒ the
 *     technicals run completes, rows are persisted to the
 *     dataset store, and the list is now stored.
 *  2. Refresh throws ⇒ the run is recorded failed with
 *     FEED_UNIVERSE_REFRESH_FAILED and the refresh error text
 *     in the message — NOT FEED_UNIVERSE_MISSING.
 *  3. Unwired regression: no indexRefresh dep ⇒ bare
 *     FEED_UNIVERSE_MISSING, exactly as before this fix.
 */
import { describe, it, expect } from "vitest";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  buildFeedJobRegistry,
  runFeedTechnicalsJob,
  FEED_JOB_CODES,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
} from "../src/services/feedJobs";
import type {
  DataProvider,
  DataResult,
  HistoricalBarsResult,
} from "../src/trading/dataProviders/contract";
import type { IndexListFetchService } from "../src/services/indexListProducer";
import type { MarketDataResearchHistoricalBar } from "../src/types";

const MEMBERS = ["AAPL", "MSFT", "NVDA"];
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;

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

/**
 * 30 live daily bars with a steady +1/day ramp (the same shape
 * as tests/technicals_persist_3931.test.ts's risingBars): every
 * bar is provenance "live", so a hydrated technicals run can
 * complete and persist rows.
 */
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

/** A Yahoo-shaped provider serving live daily bars per symbol. */
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

describe("Issue #3982 — technicals runner universe auto-hydrate (follow-up to #3976)", () => {
  it("runner hydration: an empty universe store + wired refresh completes the technicals run, persists rows, and stores the list", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    expect(await universeStore.latest("nasdaq100")).toBeUndefined();

    const result = await runFeedTechnicalsJob(
      registry,
      {
        provider: barsProvider(),
        universeStore,
        datasetStore,
        indexRefresh: { store: universeStore, service: memberService() },
      },
      TECH_ID,
      { runId: "feed-3982-hydrate", now: () => new Date(T0) },
    );

    expect(result.status).toBe("completed");
    expect(result.received).toBe(3);
    expect(result.codedError).toBeNull();
    const stored = await universeStore.latest("nasdaq100");
    expect(stored?.symbols.map((s) => s.symbol)).toEqual(MEMBERS);
    const artifact = await datasetStore.latest("yahoo", "technicals");
    expect(artifact?.run.status).toBe("completed");
    expect(artifact?.run.received).toBe(3);
    expect(artifact?.bars?.map((r) => r.symbol).sort()).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
    ]);
    expect(artifact?.bars?.[0].bars).toHaveLength(30);
  });

  it("runner refresh failure: a throwing refresh is recorded as FEED_UNIVERSE_REFRESH_FAILED with the refresh error named", async () => {
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
      { runId: "feed-3982-refresh-throws", now: () => new Date(T0) },
    );

    expect(result.status).toBe("failed");
    expect(result.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    expect(result.codedError).not.toBe(FEED_JOB_CODES.universeMissing);
    const artifact = await datasetStore.latest("yahoo", "technicals");
    expect(artifact?.run.codedError).toBe("FEED_UNIVERSE_REFRESH_FAILED");
    expect(artifact?.run.errorMessage).toContain("wikipedia fetch exploded");
    expect(artifact?.run.errorMessage).toContain(
      "The feed job has no universe to pull.",
    );
  });

  it("unwired regression: no indexRefresh dep ⇒ bare FEED_UNIVERSE_MISSING, exactly as before", async () => {
    const registry = buildFeedJobRegistry({});
    const universeStore = new InMemoryIndexListStore();
    const datasetStore = new InMemoryFeedDatasetStore();

    const result = await runFeedTechnicalsJob(
      registry,
      { provider: barsProvider(), universeStore, datasetStore },
      TECH_ID,
      { runId: "feed-3982-unwired", now: () => new Date(T0) },
    );

    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
    const artifact = await datasetStore.latest("yahoo", "technicals");
    expect(artifact?.run.errorMessage).toContain(
      "Refresh the index list first.",
    );
  });
});
