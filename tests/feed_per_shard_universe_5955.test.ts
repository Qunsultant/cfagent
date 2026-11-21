// @vitest-environment node
/**
 * Issue #5955 (#4437 slice 6b1) — feed-family per-shard universe in
 * `feed.pull` (ALL runs): one job definition serves multi-universe
 * commands by reading the unit's shard universe from the shard
 * table.
 *
 * The gap (verified 2026-11-21 at base `dc6afb03`): the feed node
 * carries ONE `universe` param baked into the definition and the
 * feed step reads it once per node, not per unit — while
 * `shardsForUniverse("ALL")` (`screenExecutionBroker.ts`) fans out
 * into six shards with six DIFFERENT universes. Post-flip every
 * unit of an ALL run would pull the same single universe (today:
 * a partition of the nasdaq100 default) and the ALL screen would
 * be silently wrong. This slice closes the gap: the step reads the
 * unit's shard universe (the bespoke `screenRequestFromParams`
 * idiom — the shard table's row for the unit's shard key), and the
 * quotes jobs become parameterized on the #3930 idiom so the run
 * can name the stored list it actually pulls.
 *
 * Two load-bearing rules, both pinned here:
 * (1) A universe-shard unit pulls its WHOLE universe, not a
 * partition of it. The bespoke feed resolves the shard's universe
 * to its full symbol list (`resolveUniverse(universe, listings)`,
 * no partitioning); the generic step's `feedShardSymbols`
 * partition splits ONE universe across N units, which for a
 * universe-shard would silently drop 5/6 of the universe. The
 * partition applies only when the shard row carries NO universe
 * (the feed family's own s0/s1 sharding).
 * (2) Explicit symbols (6b0) still win over the shard universe.
 *
 * Interim state, pinned, not silent: a shard universe with no
 * stored index list (ETF / LEV_ETF — no `IndexId`, 6b2's slice)
 * refuses by name (`FEED_UNIVERSE_UNKNOWN`) before any fetch.
 */
import { describe, expect, it } from "vitest";
import { buildFeedJobRegistry, FEED_JOB_CODES } from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  FEED_PULL_STEP,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { DataProvider, DataResult } from "../src/trading";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { QuoteResult } from "../src/trading";

// Relative timestamps only — no fixed calendar dates.
const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const QUOTES_JOB_ID = "yahoo-nasdaq100-quotes";

/** The ALL shard table, exactly as `shardsForUniverse("ALL")` builds it. */
const ALL_SHARDS = [
  { shardId: "NASDAQ100", universe: "NASDAQ100" },
  { shardId: "SP100", universe: "SP100" },
  { shardId: "SP500", universe: "SP500" },
  { shardId: "RUSSELL2000", universe: "RUSSELL2000" },
  { shardId: "ETF", universe: "ETF" },
  { shardId: "LEV_ETF", universe: "LEV_ETF" },
];
const ALL_SHARD_KEYS = ALL_SHARDS.map((s) => s.shardId);

const NASDAQ100_SYMBOLS = ["NAA", "NBB", "NCC", "NDD"];
const SP500_SYMBOLS = ["SAA", "SBB", "SCC", "SDD", "SEE", "SFF"];
const RUSSELL2000_SYMBOLS = ["RAA", "RBB", "RCC"];

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
  seedLists?: Partial<Record<"nasdaq100" | "sp500" | "russell2000", string[]>>;
  shardKeys?: readonly string[];
}): Promise<{
  steps: JobStepRegistry;
  datasetStore: InMemoryFeedDatasetStore;
  calls: Array<{ symbols: string[]; runId?: string }>;
}> {
  const { provider, calls } = fakeProvider();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  for (const [index, symbols] of Object.entries(opts?.seedLists ?? {})) {
    await universeStore.store({
      index: index as "nasdaq100" | "sp500" | "russell2000",
      snapshotDate: iso(T0 - 86_400_000),
      symbols: (symbols as string[]).map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: `Wikipedia (${index} table)`,
      derivedFromHoldings: false,
    });
  }
  const deps: FeedStepDeps = {
    registry: buildFeedJobRegistry({}),
    providerFor: () => provider,
    universeStore,
    datasetStore,
    ...(opts?.shardKeys
      ? { shardsFor: async () => opts.shardKeys! }
      : {}),
  };
  const steps = createFeedStepRegistry(deps);
  return { steps, datasetStore, calls };
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

describe("feed.pull — per-shard universe (#5955 6b1)", () => {
  it("an ALL command's SP500 unit fetches its whole universe, not a partition of nasdaq100", async () => {
    // Six shard keys: a partition would fetch 1 of 6 SP500
    // symbols; the whole-universe rule fetches all 6. The
    // nasdaq100 list is seeded too, so pulling the wrong
    // universe (or a partition of it) is visible in the call.
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS, sp500: SP500_SYMBOLS },
      shardKeys: ALL_SHARD_KEYS,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "SP500",
        params: { feedJobId: QUOTES_JOB_ID, shards: ALL_SHARDS },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(SP500_SYMBOLS);
    expect(result.output).toMatchObject({
      feedJobId: QUOTES_JOB_ID,
      status: "completed",
      requested: 6,
      received: 6,
    });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact).toBeDefined();
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "sp500",
      label: "S&P 500",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (sp500 table)",
      size: 6,
    });
    expect(artifact!.quotes.map((q) => q.symbol)).toEqual(SP500_SYMBOLS);
  });

  it("an ALL command's NASDAQ100 unit fetches its whole universe", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS, sp500: SP500_SYMBOLS },
      shardKeys: ALL_SHARD_KEYS,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "NASDAQ100",
        params: { feedJobId: QUOTES_JOB_ID, shards: ALL_SHARDS },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(NASDAQ100_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 4 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (nasdaq100 table)",
      size: 4,
    });
  });

  it("an ALL command's RUSSELL2000 unit fetches its whole universe (label falls back to the index id)", async () => {
    // No russell2000 quotes job exists in the registry, so the
    // artifact label is the honest index id, never fabricated.
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { russell2000: RUSSELL2000_SYMBOLS },
      shardKeys: ALL_SHARD_KEYS,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "RUSSELL2000",
        params: { feedJobId: QUOTES_JOB_ID, shards: ALL_SHARDS },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(RUSSELL2000_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 3 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "russell2000",
      label: "russell2000",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (russell2000 table)",
      size: 3,
    });
  });

  it("a single-universe monolith command is unaffected (no shard table, job default)", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS },
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({ params: { feedJobId: QUOTES_JOB_ID } }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(NASDAQ100_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 4 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (nasdaq100 table)",
      size: 4,
    });
  });

  it("the node universe param names the stored list on the now-parameterized quotes job (monolith)", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS, sp500: SP500_SYMBOLS },
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        params: { feedJobId: QUOTES_JOB_ID, universe: "sp500" },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(SP500_SYMBOLS);
    expect(result.output).toMatchObject({ status: "completed", requested: 6 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "sp500",
      label: "S&P 500",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (sp500 table)",
      size: 6,
    });
  });

  it("the four nasdaq100 quotes jobs are parameterized (the #3930 idiom)", () => {
    const registry = buildFeedJobRegistry({});
    for (const jobId of [
      "yahoo-nasdaq100-quotes",
      "alpaca-nasdaq100-quotes",
      "etrade-nasdaq100-quotes",
      "public-nasdaq100-quotes",
    ]) {
      expect(registry.get(jobId)?.parameterizedUniverse).toBe(true);
    }
  });

  it("explicit symbols still win over the shard universe (6b0 composition)", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS, sp500: SP500_SYMBOLS },
      shardKeys: ALL_SHARD_KEYS,
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "SP500",
        params: {
          feedJobId: QUOTES_JOB_ID,
          shards: [
            ...ALL_SHARDS.filter((s) => s.shardId !== "SP500"),
            { shardId: "SP500", universe: "SP500", symbols: [listing("AAPL")] },
          ],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 1 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    // AAPL is in neither seeded list, so the #4065 membership
    // rule records a symbols-kind universe, not the shard's.
    expect(artifact!.universe).toEqual({
      kind: "symbols",
      symbols: ["AAPL"],
      label: "Run symbols (1)",
      snapshotDate: null,
      sourceLabel: null,
      size: 1,
    });
  });

  it("an unknown shard universe still refuses by name before any fetch", async () => {
    // #5956 (6b2) closed the ETF case this test used to pin:
    // an ETF shard now resolves its stored list (see
    // feed_non_index_universes_5956.test.ts). The refusal rule
    // itself stands — an input naming no known list still
    // refuses by name before any fetch.
    const { steps, calls } = await makeSteps({
      seedLists: { nasdaq100: NASDAQ100_SYMBOLS },
      shardKeys: ALL_SHARD_KEYS,
    });
    await expect(
      steps.resolve(FEED_PULL_STEP)(
        stepCtx({
          shardKey: "BOGUS",
          params: {
            feedJobId: QUOTES_JOB_ID,
            shards: [...ALL_SHARDS, { shardId: "BOGUS", universe: "bogus" }],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: FEED_JOB_CODES.universeUnknown });
    expect(calls).toHaveLength(0);
  });

  it("a partition shard with no universe in its row still pulls only its partition (feed-family sharding)", async () => {
    // The feed family's own s0/s1 sharding splits ONE universe
    // across units; no shard table rides params, so the keys
    // come from the shardsFor dep and the partition applies.
    const { steps, datasetStore, calls } = await makeSteps({
      seedLists: { nasdaq100: ["A", "B", "C", "D"] },
      shardKeys: ["s0", "s1"],
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "s0",
        params: { feedJobId: QUOTES_JOB_ID },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["A", "C"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 2 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (nasdaq100 table)",
      size: 2,
    });
  });
});
