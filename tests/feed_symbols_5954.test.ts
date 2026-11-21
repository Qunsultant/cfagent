// @vitest-environment node
/**
 * Issue #5954 (#4437 slice 6b0) — feed-family explicit-symbols
 * feed support (the premium path): `feed.pull` serves a
 * symbols-fed run, fetching exactly the caller-named symbols
 * without a stored index list.
 *
 * The gap (verified 2026-11-21 at base `2c4a419a`): no generic
 * step reads the run's `symbols` param, and the quotes runner
 * requires a stored index list (`feedJobs.ts`: "the stored index
 * list, never an invented one") with `opts.symbols` only
 * filtering it — so a premium command (`premium.ts:737,789`,
 * `shards: [{ shardId: "symbols", symbols: listings }]`)
 * would screen the nasdaq100 default list instead of the
 * payer's symbols, silently. This slice closes the gap by
 * extending the #4065 symbols-universe mode (built for the
 * options-chains runner) to the quotes runner, and teaching
 * `feed.pull` to serve it.
 *
 * The design, following the bespoke feed stage's idiom
 * (`screenFeedStage`: "Explicit symbols (the shard's row, or
 * the goal descriptor's list) win; otherwise the listings
 * directory resolves membership") and the #4065 membership
 * rule: a run that names its symbols is a caller-supplied
 * universe. When every named symbol is a member of the stored
 * list the run resolves, the run is a subset of that list
 * (index-kind universe, size the subset's). When ANY named
 * symbol is not a member, the run is an explicit-symbol run
 * (symbols-kind universe, the symbols used as-is — filtering
 * them against the list would silently drop the caller's
 * symbols). The membership check is a plain store read — a run
 * that names its symbols never triggers an index refresh for a
 * list it may not need.
 *
 * The invariant is HONORED, not changed: the feed family never
 * invents membership. The explicit symbols are the caller's own
 * list (the premium fulfillment's payer-chosen listings),
 * supplied through the command's shard table, and the run
 * records them as a caller-supplied "symbols" universe — the
 * symbols themselves ARE the provenance (the #4065
 * `FeedDatasetSymbolUniverse`). The stored-list requirement
 * applies to *index* universes; the symbols universe is a
 * different kind with its own provenance.
 */
import { describe, expect, it } from "vitest";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
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
const FUNDAMENTALS_JOB_ID = "yahoo-nasdaq100-fundamentals";

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
  seedList?: string[];
  provider?: DataProvider;
}): Promise<{
  steps: JobStepRegistry;
  datasetStore: InMemoryFeedDatasetStore;
  calls: Array<{ symbols: string[]; runId?: string }>;
}> {
  const { provider, calls } = fakeProvider();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  if (opts?.seedList) {
    await universeStore.store({
      index: "nasdaq100",
      snapshotDate: iso(T0 - 86_400_000),
      symbols: opts.seedList.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
    });
  }
  const deps: FeedStepDeps = {
    registry: buildFeedJobRegistry({}),
    providerFor: () => opts?.provider ?? provider,
    universeStore,
    datasetStore,
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

describe("feed.pull — explicit-symbols feed support (#5954 6b0)", () => {
  it("a premium symbols shard fetches exactly the requested symbols, with no stored list", async () => {
    // Cold universe store: no index list seeded anywhere. The
    // symbols are the payer's listings — AAPL/MSFT happen to be
    // nasdaq100 members, BRK.B is not; a duplicate AAPL proves
    // the run normalizes + dedupes instead of fetching twice.
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "symbols",
        params: {
          feedJobId: QUOTES_JOB_ID,
          universe: "symbols",
          shards: [
            {
              shardId: "symbols",
              symbols: [
                listing("AAPL"),
                listing("MSFT"),
                listing("AAPL"),
                listing("BRK.B"),
              ],
            },
          ],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL", "MSFT", "BRK.B"]);
    expect(result.output).toMatchObject({
      feedJobId: QUOTES_JOB_ID,
      status: "completed",
      requested: 3,
      received: 3,
    });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact).toBeDefined();
    expect(artifact!.universe).toEqual({
      kind: "symbols",
      symbols: ["AAPL", "MSFT", "BRK.B"],
      label: "Run symbols (3)",
      snapshotDate: null,
      sourceLabel: null,
      size: 3,
    });
    expect(artifact!.quotes.map((q) => q.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "BRK.B",
    ]);
  });

  it("symbols that are all members of the stored list run as an index-kind subset", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedList: ["AAPL", "MSFT"],
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "symbols",
        params: {
          feedJobId: QUOTES_JOB_ID,
          universe: "symbols",
          shards: [{ shardId: "symbols", symbols: [listing("AAPL")] }],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 1 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 1,
    });
  });

  it("symbols partially outside the list are fetched as-is, never silently dropped", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedList: ["AAPL", "MSFT"],
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "symbols",
        params: {
          feedJobId: QUOTES_JOB_ID,
          universe: "symbols",
          shards: [
            { shardId: "symbols", symbols: [listing("AAPL"), listing("BRK.B")] },
          ],
        },
      }),
    );
    // BRK.B is outside nasdaq100: the old filter would have
    // dropped it. The symbols run fetches it.
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL", "BRK.B"]);
    expect(result.output).toMatchObject({
      status: "completed",
      requested: 2,
      received: 2,
    });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe.kind).toBe("symbols");
    expect(artifact!.quotes.map((q) => q.symbol)).toEqual(["AAPL", "BRK.B"]);
  });

  it("a monolith run reads the flat symbols list", async () => {
    const { steps, datasetStore, calls } = await makeSteps();
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        params: {
          feedJobId: QUOTES_JOB_ID,
          universe: "symbols",
          symbols: [listing("NVDA"), listing("META")],
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["NVDA", "META"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 2 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toMatchObject({
      kind: "symbols",
      symbols: ["NVDA", "META"],
    });
  });

  it("a symbols universe with no explicit symbols refuses loudly, never pulls the default list", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedList: ["AAPL", "MSFT"],
    });
    const err = await steps
      .resolve(FEED_PULL_STEP)(
        stepCtx({
          params: { feedJobId: QUOTES_JOB_ID, universe: "symbols" },
        }),
      )
      .catch((e: unknown) => e);
    // The coded refusal: the quotes job takes no universe
    // input, and "symbols" names no stored list — the message
    // carries the human text, the code carries the refusal.
    expect((err as { code?: string }).code).toBe("FEED_UNIVERSE_UNKNOWN");
    // Nothing was fetched and nothing was persisted: the run
    // refused before any fetch, so no default-universe pull
    // could silently stand in for the caller's symbols.
    expect(calls).toHaveLength(0);
    expect(await storedArtifact(datasetStore, "engine-run-1")).toBeUndefined();
  });

  it("explicit symbols on a non-quotes dataset refuse by name", async () => {
    const { steps, calls } = await makeSteps();
    // The step's refusals are plain Errors with the code in
    // the message (the file's idiom — cf. the jobNotFound
    // throw above the symbols gate).
    await expect(
      steps.resolve(FEED_PULL_STEP)(
        stepCtx({
          jobId: FUNDAMENTALS_JOB_ID,
          params: {
            feedJobId: FUNDAMENTALS_JOB_ID,
            universe: "symbols",
            symbols: [listing("AAPL")],
          },
        }),
      ),
    ).rejects.toThrow("FEED_SYMBOLS_UNSUPPORTED");
    expect(calls).toHaveLength(0);
  });

  it("an ordinary index run is unchanged: the stored list, no explicit symbols", async () => {
    const { steps, datasetStore, calls } = await makeSteps({
      seedList: ["AAPL", "MSFT"],
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({ params: { feedJobId: QUOTES_JOB_ID } }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL", "MSFT"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 2 });
    const artifact = await storedArtifact(datasetStore, "engine-run-1");
    expect(artifact!.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: iso(T0 - 86_400_000),
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    });
  });

  it("a sharded index partition is unchanged: the partition filters the stored list", async () => {
    const { steps, calls } = await makeSteps({
      seedList: ["AAPL", "MSFT", "NVDA", "AMZN"],
    });
    const result = await steps.resolve(FEED_PULL_STEP)(
      stepCtx({
        shardKey: "p0",
        params: { feedJobId: QUOTES_JOB_ID, shards: ["p0", "p1"] },
      }),
    );
    // Even indices of the universe order: AAPL, NVDA.
    expect(calls).toHaveLength(1);
    expect(calls[0].symbols).toEqual(["AAPL", "NVDA"]);
    expect(result.output).toMatchObject({ status: "completed", requested: 2 });
  });
});
