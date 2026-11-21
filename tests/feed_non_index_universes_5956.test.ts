// @vitest-environment node
/**
 * Issue #5956 (#4437 slice 6b2) — feed-family non-index universe
 * coverage (TECH / ETF / LEV_ETF): the three screener universes
 * with no stored index list resolve and screen on the generic
 * chain.
 *
 * The gap (verified 2026-11-21 at base `1be4634a`): `IndexId`
 * (`indexMembership.ts`) is the base indices plus the sector
 * keys — there is no "tech", "etf", or "lev_etf" list, so
 * `resolveRunUniverse` throws `universeUnknown` for those shard
 * universes. TECH is the planner's default universe and ETF /
 * LEV_ETF are shardable (they ride ALL runs); the bespoke feed
 * resolves them by selector over the live listings directory
 * (`resolveUniverse` in `universes.ts` — TECH keyword discovery,
 * ETF flag/name match, leveraged-ETF subset). The generic feed
 * node has no equivalent. This slice closes the gap: the three
 * lists are stored index lists, produced by a third adapter of
 * the #1852 port family — the listings-derived adapter — which
 * runs the SAME selectors over the listings directory and stores
 * the result through the existing refresh job, so a TECH/ETF/
 * LEV_ETF run resolves exactly the list the bespoke feed would
 * have computed, with a snapshot date and provenance, never an
 * invented list.
 *
 * Load-bearing rules, pinned here:
 * (1) The stored list IS the selector's output: the adapter
 * runs `resolveUniverse` unchanged (no second selector, no
 * re-implementation) — the bespoke and generic paths can never
 * disagree on what TECH/ETF/LEV_ETF contain.
 * (2) The runner's invariant holds: the feed family still pulls
 * a stored list, never a live-computed one — the listings
 * fetch happens in the refresh (scheduled goal or cold-store
 * hydration), never in the run itself.
 * (3) Explicit symbols (6b0) still win over the shard universe,
 * and a universe input naming no known list still refuses by
 * name before any fetch.
 */
import { describe, expect, it } from "vitest";
import {
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  resolveRunUniverse,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  FEED_PULL_STEP,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  createIndexMembershipService,
  createListingsDerivedIndexMembershipAdapter,
  createWikipediaIndexMembershipAdapter,
  UnknownIndexError,
} from "../src/trading";
import {
  executeIndexListRefreshJob,
  indicesForRefreshOperation,
} from "../src/services/indexListJob";
import type { DataProvider, DataResult } from "../src/trading";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { QuoteResult } from "../src/trading";

// Relative timestamps only — no fixed calendar dates.
const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const TODAY = iso(T0).slice(0, 10);

const QUOTES_JOB_ID = "yahoo-nasdaq100-quotes";

/** Fixture listings: every selector's membership is decided here. */
const FIXTURE_LISTINGS: NasdaqStockListing[] = [
  { symbol: "TSW", companyName: "TechSoft Software" },
  { symbol: "CHP", companyName: "Chipmaker Semiconductor" },
  { symbol: "CLD", companyName: "Cloud Data Holdings" },
  { symbol: "BNK", companyName: "First National Bank" },
  { symbol: "FRM", companyName: "Sunny Farms Foods" },
  { symbol: "ETF1", companyName: "Plain Index ETF" },
  { symbol: "ULT", companyName: "Ultra ProShares Bull Fund" },
  { symbol: "DB3", companyName: "Direxion Daily Bull 3X Fund" },
  { symbol: "BND", companyName: "Bond Index ETF" },
] as NasdaqStockListing[];

const TECH_SYMBOLS = ["TSW", "CHP", "CLD"];
const ETF_SYMBOLS = ["ETF1", "ULT", "DB3", "BND"];
const LEV_ETF_SYMBOLS = ["ULT", "DB3"];

/** The TECH shard table: TECH is not shardable, so it rides alone. */
const TECH_SHARDS = [{ shardId: "TECH", universe: "TECH" }];

function quoteFor(symbol: string): QuoteResult {
  return {
    symbol,
    companyName: `${symbol} Inc.`,
    lastPrice: 100,
    price: 100,
    change: 0,
    changePercent: 0,
    bid: 0,
    ask: 0,
    volume: 1_000_000,
    averageVolume: 1_000_000,
    open: 100,
    high: 100,
    low: 100,
    week52High: 120,
    week52Low: 80,
    peRatio: 20,
    rsi: 50,
    sector: "Technology",
    source: "test",
    timestamp: iso(T0),
  } as unknown as QuoteResult;
}

function listing(symbol: string): NasdaqStockListing {
  return { symbol, companyName: `${symbol} Inc.` } as NasdaqStockListing;
}

function fakeProvider(): {
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
      return {
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quoteFor(s)),
      } as DataResult<QuoteResult[]>;
    },
  };
  return { provider, calls };
}

async function makeSteps(opts?: {
  seedLists?: Partial<Record<"tech" | "etf" | "lev_etf" | "nasdaq100", string[]>>;
  listingsFetchCount?: { n: number };
}): Promise<{
  steps: JobStepRegistry;
  datasetStore: InMemoryFeedDatasetStore;
  universeStore: InMemoryIndexListStore;
  calls: Array<{ symbols: string[]; runId?: string }>;
}> {
  const { provider, calls } = fakeProvider();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  for (const [index, symbols] of Object.entries(opts?.seedLists ?? {})) {
    await universeStore.store({
      index: index as "tech" | "etf" | "lev_etf" | "nasdaq100",
      snapshotDate: iso(T0 - 86_400_000),
      symbols: (symbols as string[]).map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: `seeded (${index} list)`,
      derivedFromHoldings: false,
    });
  }
  const counter = opts?.listingsFetchCount;
  const service = createIndexMembershipService({
    wikipedia: {
      getMembers: async () => {
        throw new Error("wikipedia adapter must not serve a listings-derived index");
      },
    },
    holdings: {
      getMembers: async () => {
        throw new Error("holdings adapter must not serve a listings-derived index");
      },
    },
    listings: createListingsDerivedIndexMembershipAdapter(
      async () => {
        if (counter) counter.n += 1;
        return FIXTURE_LISTINGS;
      },
      TODAY,
    ),
  });
  const deps: FeedStepDeps = {
    registry: buildFeedJobRegistry({}),
    providerFor: () => provider,
    universeStore,
    datasetStore,
    indexRefresh: { store: universeStore, service },
  };
  const steps = createFeedStepRegistry(deps);
  return { steps, datasetStore, universeStore, calls };
}

function stepCtx(overrides: {
  jobId?: string;
  shardKey?: string | null;
  params?: Record<string, unknown>;
}) {
  return {
    jobId: overrides.jobId ?? QUOTES_JOB_ID,
    runId: "engine-run-1",
    nodePath: "0",
    kind: "feed",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: overrides.shardKey ?? null,
    params: overrides.params ?? {},
    input: null,
    now: iso(T0),
    trigger: "manual",
    runKind: "original",
  } as unknown as Parameters<
    ReturnType<JobStepRegistry["resolve"]>
  >[0];
}

async function storedArtifact(
  datasetStore: InMemoryFeedDatasetStore,
  runId: string,
) {
  const history = await datasetStore.listRuns("yahoo", "quotes", 10);
  return history.find((a) => a.run.runId === runId);
}

describe("feed.pull — non-index universe coverage (#5956 6b2)", () => {
  it("a TECH command hydrates a cold store through the listings adapter and fetches exactly the TECH symbols", async () => {
    const counter = { n: 0 };
    const { steps, datasetStore, calls } = await makeSteps({
      listingsFetchCount: counter,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "TECH",
        params: { feedJobId: QUOTES_JOB_ID, shards: TECH_SHARDS },
      }),
    );
    expect(counter.n).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(TECH_SYMBOLS);
    expect(result.output).toMatchObject({
      feedJobId: QUOTES_JOB_ID,
      status: "completed",
      requested: 3,
      received: 3,
    });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact).toBeDefined();
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "tech",
      label: "tech",
      snapshotDate: TODAY,
      sourceLabel: "Listings-directory Technology keyword discovery, fetched " + TODAY,
      size: 3,
    });
    expect(artifact!.quotes.map((q) => q.symbol)).toEqual(TECH_SYMBOLS);
  });

  it("an ETF command fetches exactly the ETF symbols", async () => {
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "ETF",
        params: {
          feedJobId: QUOTES_JOB_ID,
          shards: [{ shardId: "ETF", universe: "ETF" }],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(ETF_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 4 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "etf",
      label: "etf",
      snapshotDate: TODAY,
      sourceLabel: "Listings-directory ETF flag/name match, fetched " + TODAY,
      size: 4,
    });
  });

  it("a LEV_ETF command fetches exactly the leveraged subset", async () => {
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "LEV_ETF",
        params: {
          feedJobId: QUOTES_JOB_ID,
          shards: [{ shardId: "LEV_ETF", universe: "LEV_ETF" }],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(LEV_ETF_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 2 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "lev_etf",
      label: "lev_etf",
      snapshotDate: TODAY,
      sourceLabel: "Listings-directory leveraged-ETF subset, fetched " + TODAY,
      size: 2,
    });
  });

  it("a seeded tech list is used as-is: no listings fetch, provider fetches the stored symbols", async () => {
    const counter = { n: 0 };
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { tech: TECH_SYMBOLS },
      listingsFetchCount: counter,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "TECH",
        params: { feedJobId: QUOTES_JOB_ID, shards: TECH_SHARDS },
      }),
    );
    expect(counter.n).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(TECH_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 3 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "tech",
      label: "tech",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "seeded (tech list)",
      size: 3,
    });
  });

  it("the node universe param names the tech list on the parameterized quotes job (monolith)", async () => {
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        params: { feedJobId: QUOTES_JOB_ID, universe: "tech" },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(TECH_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 3 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe.index).toBe("tech");
  });

  it("an unknown universe still refuses by name before any fetch", async () => {
    const { steps, calls } = await makeSteps();
    await expect(
      steps.resolve(FEED_PULL_STEP)(
        stepCtx({
          params: { feedJobId: QUOTES_JOB_ID, universe: "bogus" },
        }),
      ),
    ).rejects.toMatchObject({ code: FEED_JOB_CODES.universeUnknown });
    expect(calls).toHaveLength(0);
  });

  it("explicit symbols still win over the shard universe (6b0 composition)", async () => {
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "TECH",
        params: {
          feedJobId: QUOTES_JOB_ID,
          shards: [
            { shardId: "TECH", universe: "TECH", symbols: [listing("AAPL")] },
          ],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 1 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    // AAPL is in no seeded list, so the #4065 membership rule
    // records a symbols-kind universe, not the shard's.
    expect(artifact!.universe).toEqual({
      kind: "symbols",
      symbols: ["AAPL"],
      label: "Run symbols (1)",
      snapshotDate: null,
      sourceLabel: null,
      size: 1,
    });
  });

  it("the refresh job stores all three lists through the service (the index-refresh path)", async () => {
    const universeStore = new InMemoryIndexListStore();
    const service = createIndexMembershipService({
      wikipedia: {
        getMembers: async () => {
          throw new Error("wikipedia adapter must not serve a listings-derived index");
        },
      },
      holdings: {
        getMembers: async () => {
          throw new Error("holdings adapter must not serve a listings-derived index");
        },
      },
      listings: createListingsDerivedIndexMembershipAdapter(
        async () => FIXTURE_LISTINGS,
        TODAY,
      ),
    });
    const result = await executeIndexListRefreshJob({
      store: universeStore,
      service,
      indices: ["tech", "etf", "lev_etf"],
    });
    expect(result.status).toBe("completed");
    expect(result.failures).toEqual([]);
    expect(result.artifacts.map((a) => [a.index, a.memberCount])).toEqual([
      ["tech", 3],
      ["etf", 4],
      ["lev_etf", 2],
    ]);
    for (const [index, symbols] of [
      ["tech", TECH_SYMBOLS],
      ["etf", ETF_SYMBOLS],
      ["lev_etf", LEV_ETF_SYMBOLS],
    ] as const) {
      const stored = await universeStore.latest(index);
      expect(stored?.symbols.map((m) => m.symbol)).toEqual(symbols);
      expect(stored?.snapshotDate).toBe(TODAY);
      expect(stored?.source).toBe("listings");
    }
    expect(indicesForRefreshOperation("index.refresh_listings")).toEqual([
      "tech",
      "etf",
      "lev_etf",
    ]);
  });

  it("the service routes tech/etf/lev_etf to the listings adapter and nasdaq100 to the wikipedia adapter", async () => {
    const service = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(
        async () =>
          `<table><tr><th>Ticker</th><th>Company</th><th>ISIN</th><th>ICB Industry</th></tr><tr><td>NAA</td><td>Naa Inc.</td><td>US0000000000</td><td>Tech</td></tr></table>`,
        TODAY,
      ),
      holdings: {
        getMembers: async () => {
          throw new Error("holdings adapter must not serve this index");
        },
      },
      listings: createListingsDerivedIndexMembershipAdapter(
        async () => FIXTURE_LISTINGS,
        TODAY,
      ),
    });
    const tech = await service.getMembers("tech");
    expect(tech.symbols.map((m) => m.symbol)).toEqual(TECH_SYMBOLS);
    expect(tech.source).toBe("listings");
    const etf = await service.getMembers("etf");
    expect(etf.symbols.map((m) => m.symbol)).toEqual(ETF_SYMBOLS);
    const lev = await service.getMembers("lev_etf");
    expect(lev.symbols.map((m) => m.symbol)).toEqual(LEV_ETF_SYMBOLS);
    const ndx = await service.getMembers("nasdaq100");
    expect(ndx.symbols.map((m) => m.symbol)).toEqual(["NAA"]);
    expect(ndx.source).toBe("wikipedia");
    // The service routes synchronously, so the refusal is a sync
    // throw, not a rejected promise (same as #2962).
    expect(() => service.getMembers("bogus" as never)).toThrow(UnknownIndexError);
  });

  it("resolveRunUniverse accepts tech/etf/lev_etf on a parameterized quotes job", () => {
    const registry = buildFeedJobRegistry({});
    const def = registry.get(QUOTES_JOB_ID)!;
    expect(def.parameterizedUniverse).toBe(true);
    expect(resolveRunUniverse(def, "tech")).toBe("tech");
    expect(resolveRunUniverse(def, "etf")).toBe("etf");
    expect(resolveRunUniverse(def, "lev_etf")).toBe("lev_etf");
    expect(resolveRunUniverse(def, undefined)).toBe("nasdaq100");
    let thrown: unknown;
    try {
      resolveRunUniverse(def, "bogus");
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe(
      FEED_JOB_CODES.universeUnknown,
    );
  });
});
