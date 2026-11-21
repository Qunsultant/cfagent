// @vitest-environment node
/**
 * Issue #5883 (#4437 slice 6a) — the analyze node's parent
 * hand-off: the `enrich.screener` step registered beside
 * `enrich.apply` (the analyze.ooda / analyze.screener
 * precedent). It runs the enrich job exactly like
 * `enrich.apply` AND returns the gather-shaped hand-off the
 * `analyze.screener` hand-off mode consumes
 * (`resolveScreenerHandOff`: an object with `acquired.quotes`
 * plus `platformRunId` / `taskId` / `timestamp` lineage).
 *
 * The parity pin: the bespoke gather stage spreads its feed
 * output (`screenGatherStage` returns `{...feedOutput,
 * technicalsBySymbol, ...}`), so the gather's
 * `acquired.quotes` ARE the feed stage's quotes verbatim — and
 * in the re-pointed chain the feed artifact's quotes are the
 * quotes `feed.pull` fetched. Same quotes in, same hand-off
 * out: the hand-off's `acquired.quotes` must deep-equal the
 * seeded feed artifact's quotes, the enriched rows must equal
 * `enrich.apply`'s rows for the same input, and the hand-off
 * must drive `analyze.screener` to the same standouts the
 * bespoke analyze produces ([AAPL, MSFT, META] — the #5824 3a
 * universe).
 *
 * The feed freshness decision rides here too (see the
 * engine doc, `<!-- 5883: ... -->`): the re-pointed chain
 * fetches once per run (`feed.pull`) and everything downstream
 * reads the persisted copy — the bespoke double-fetch is gone
 * by construction — so the within-minutes cross-run dedup the
 * slice-1 quote-cache gate provided is accepted as a loss for
 * this slice, with a feed-family freshness check filed as a
 * follow-up. This test pins the one-fetch discipline
 * structurally: `enrich.screener` has no provider dep, so it
 * cannot fetch — the hand-off comes from the persisted feed
 * artifact, never a live call.
 *
 * The step params pin the element set to the default
 * quote-derived elements and skip the joins
 * (`enrichFrom: []`): the registry def's element set includes
 * the fundamentals/history/sentiment elements, which gap
 * per-symbol without seeded join datasets and drive the run
 * "partial" — the hand-off contract is independent of the join
 * data, and the join wiring is the production def's, not this
 * step's, so the test runs the quote-derived elements only and
 * asserts the run completes.
 */
import { describe, expect, it } from "vitest";
import {
  buildEnrichJobRegistry,
  ENRICH_DEFAULT_ELEMENTS,
} from "../src/services/enrichJobs";
import {
  ENRICH_APPLY_STEP,
  ENRICH_SCREENER_STEP,
  registerEnrichStep,
  type EnrichStepDeps,
} from "../src/services/enrichPipelineJobs";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import type { FeedDatasetStoreInput } from "../src/data/feedDatasetPorts";
import {
  AnalyzeJobRegistry,
  resolveScreenerHandOff,
  type AnalyzeJobDefinition,
} from "../src/services/analyzeJobs";
import {
  ANALYZE_SCREENER_STEP,
  registerScreenerAnalyzeStep,
} from "../src/services/analyzePipelineJobs";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import type { DataProviderId, IndexId, QuoteResult } from "../src/trading";

// Relative timestamps only — no fixed calendar dates.
const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";
const ANALYZE_ID = `${ENRICH_ID}-analyze`;

/** The #5824 3a universe: six quotes spanning every screen signal; one carries no P/E. */
function universeQuotes(): QuoteResult[] {
  const q = (overrides: Record<string, unknown>): QuoteResult =>
    ({
      symbol: "NVDA",
      companyName: "NVIDIA Corporation",
      lastPrice: 130,
      price: 130,
      change: 0.26,
      changePercent: 0.2,
      bid: 0,
      ask: 0,
      volume: 80_000_000,
      averageVolume: 60_000_000,
      open: 128,
      high: 132,
      low: 127,
      week52High: 150,
      week52Low: 100,
      peRatio: null,
      rsi: 80,
      sector: "Technology",
      source: "test",
      timestamp: iso(T0),
      ...overrides,
    }) as unknown as QuoteResult;
  return [
    q({
      symbol: "AAPL",
      companyName: "Apple Inc.",
      lastPrice: 180,
      price: 180,
      change: 5.24,
      changePercent: 3.0,
      open: 176,
      high: 182,
      low: 175,
      week52High: 200,
      week52Low: 150,
      peRatio: 25,
      rsi: 45,
      volume: 50_000_000,
      averageVolume: 40_000_000,
    }),
    q({
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      lastPrice: 400,
      price: 400,
      change: -16.67,
      changePercent: -4.0,
      open: 410,
      high: 412,
      low: 398,
      week52High: 450,
      week52Low: 350,
      peRatio: 30,
      rsi: 25,
      volume: 30_000_000,
      averageVolume: 25_000_000,
    }),
    q({}),
    q({
      symbol: "AMZN",
      companyName: "Amazon.com, Inc.",
      lastPrice: 200,
      price: 200,
      change: 0.2,
      changePercent: 0.1,
      open: 199,
      high: 201,
      low: 198,
      week52High: 220,
      week52Low: 170,
      peRatio: 40,
      rsi: undefined,
      volume: 20_000_000,
      averageVolume: 22_000_000,
    }),
    q({
      symbol: "META",
      companyName: "Meta Platforms, Inc.",
      lastPrice: 500,
      price: 500,
      change: 28.3,
      changePercent: 6.0,
      open: 490,
      high: 505,
      low: 488,
      week52High: 550,
      week52Low: 400,
      peRatio: 20,
      rsi: 60,
      volume: 15_000_000,
      averageVolume: 12_000_000,
    }),
    q({
      symbol: "GOOGL",
      companyName: "Alphabet Inc.",
      lastPrice: 170,
      price: 170,
      change: -0.51,
      changePercent: -0.3,
      open: 171,
      high: 172,
      low: 168,
      week52High: 190,
      week52Low: 140,
      peRatio: 22,
      rsi: 50,
      volume: 25_000_000,
      averageVolume: 25_000_000,
    }),
  ];
}

function feedInput(
  runId: string,
  atMs: number,
  quotes: QuoteResult[],
): FeedDatasetStoreInput {
  return {
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    jobId: "yahoo-nasdaq100-quotes",
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: null,
      sourceLabel: null,
      size: quotes.length,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: quotes.length,
      received: quotes.length,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    quotes,
    asOf: iso(atMs + 1000),
    nowIso: iso(atMs + 1000),
  };
}

function analyzeDef(): AnalyzeJobDefinition {
  return {
    id: ANALYZE_ID,
    enrichJobId: ENRICH_ID,
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: { kind: "index", index: "nasdaq100" as IndexId, label: "Nasdaq-100" },
    ruleSets: ["screen", "factors"],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
  };
}

function stepCtx(overrides: {
  jobId: string;
  runId?: string;
  shardKey?: string | null;
  params?: Record<string, unknown>;
  input?: unknown;
}) {
  return {
    jobId: overrides.jobId,
    runId: overrides.runId ?? "engine-run-1",
    nodePath: "0",
    kind: "enrich",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: overrides.shardKey ?? null,
    params: overrides.params ?? {},
    input: overrides.input ?? null,
    now: iso(T0),
    trigger: "manual",
    runKind: "original",
  };
}

async function seededStores(quotes: QuoteResult[]) {
  const datasetStore = new InMemoryFeedDatasetStore();
  const artifact = await datasetStore.store(feedInput("feed-run-1", T0, quotes));
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  return { datasetStore, enrichedStore, feedArtifact: artifact };
}

function enrichDeps(
  datasetStore: InMemoryFeedDatasetStore,
  enrichedStore: InMemoryEnrichedDatasetStore | null,
): EnrichStepDeps {
  return {
    registry: buildEnrichJobRegistry({}),
    datasetStore,
    enrichedStore,
  };
}

describe("enrich.screener — the analyze node's parent hand-off (#5883 6a)", () => {
  it("registers beside enrich.apply with the screener step name", () => {
    const steps = new JobStepRegistry();
    registerEnrichStep(steps, {
      registry: buildEnrichJobRegistry({}),
      datasetStore: new InMemoryFeedDatasetStore(),
      enrichedStore: new InMemoryEnrichedDatasetStore(),
    });
    expect(ENRICH_SCREENER_STEP).toBe("enrich.screener");
    expect(steps.has(ENRICH_SCREENER_STEP)).toBe(true);
    expect(steps.has(ENRICH_APPLY_STEP)).toBe(true);
  });

  it("same quotes → same acquired.quotes hand-off as screener.gather", async () => {
    const quotes = universeQuotes();
    const { datasetStore, enrichedStore, feedArtifact } = await seededStores(quotes);
    const steps = new JobStepRegistry();
    registerEnrichStep(steps, enrichDeps(datasetStore, enrichedStore));

    const result = await steps.resolve(ENRICH_SCREENER_STEP)(
      stepCtx({
        jobId: ENRICH_ID,
        params: {
          enrichJobId: ENRICH_ID,
          elements: [...ENRICH_DEFAULT_ELEMENTS],
          enrichFrom: [],
        },
      }) as never,
    );
    const output = result.output as Record<string, unknown>;

    // The hand-off carries the feed artifact's quotes verbatim —
    // exactly what the bespoke gather's acquired.quotes carries
    // (screenGatherStage spreads its feed output).
    expect(output.acquired).toEqual({ quotes });
    // Lineage names the run that produced this hand-off.
    expect(output.platformRunId).toBe("engine-run-1");
    expect(output.taskId).toBe(ENRICH_ID);
    expect(output.timestamp).toBe(iso(T0));
    // The enrich summary rides along (what enrich.apply records).
    expect(output).toMatchObject({
      enrichJobId: ENRICH_ID,
      feedJobId: "yahoo-nasdaq100-quotes",
      sourceId: "yahoo",
      dataset: "quotes",
      status: "completed",
      requested: 6,
      received: 6,
      failed: 0,
      inputArtifactId: feedArtifact.id,
      inputRunId: "feed-run-1",
    });
    expect(typeof output.artifactId).toBe("string");

    // The enrich job ran: the enriched artifact persisted with
    // the same rows enrich.apply produces for this input.
    const artifact = await enrichedStore.latestUsable(ENRICH_ID);
    expect(artifact).toBeDefined();
    expect(artifact?.rows).toHaveLength(6);
    expect(artifact?.run.runId).toBe("engine-run-1");
    expect(artifact?.inputRunId).toBe("feed-run-1");

    // The hand-off feeds analyze.screener: the mapper accepts it
    // and the peRatio rides the quote fields (not the store).
    const handOff = resolveScreenerHandOff(output);
    expect(handOff.rows).toHaveLength(6);
    expect(handOff.rows.find((r) => r.symbol === "AAPL")?.features.peRatio).toBe(25);
    expect(handOff.inputArtifactId).toBe("engine-run-1");
    expect(handOff.inputRunId).toBe(ENRICH_ID);

    // End to end: the hand-off drives analyze.screener to the
    // same standouts the bespoke analyze produces.
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const analyzeRegistry = new AnalyzeJobRegistry();
    analyzeRegistry.register(analyzeDef());
    const analyzeSteps = new JobStepRegistry();
    registerScreenerAnalyzeStep(analyzeSteps, {
      registry: analyzeRegistry,
      enrichedStore: null,
      analyzedStore,
    });
    const analyzed = await analyzeSteps.resolve(ANALYZE_SCREENER_STEP)(
      stepCtx({
        jobId: ANALYZE_ID,
        params: { analyzeJobId: ANALYZE_ID, inputMode: "handOff", ruleSets: ["screen", "factors"] },
        input: output,
      }) as never,
    );
    expect((analyzed.output as { status: string }).status).toBe("completed");
    const analyzedArtifact = await analyzedStore.latest(ANALYZE_ID);
    expect(analyzedArtifact!.summary.standouts.map((s) => s.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "META",
    ]);
  });

  it("sharded: the hand-off carries only the shard's quotes", async () => {
    const quotes = universeQuotes();
    const { datasetStore, enrichedStore } = await seededStores(quotes);
    const steps = new JobStepRegistry();
    registerEnrichStep(steps, enrichDeps(datasetStore, enrichedStore));

    const result = await steps.resolve(ENRICH_SCREENER_STEP)(
      stepCtx({
        jobId: ENRICH_ID,
        shardKey: "0",
        params: {
          enrichJobId: ENRICH_ID,
          elements: [...ENRICH_DEFAULT_ELEMENTS],
          enrichFrom: [],
          shards: ["0", "1"],
        },
      }) as never,
    );
    const output = result.output as Record<string, unknown>;
    const handOffQuotes = (output.acquired as { quotes: QuoteResult[] }).quotes;
    // Partition 0 of 6 quotes in universe order: indices 0, 2, 4.
    expect(handOffQuotes.map((q) => q.symbol)).toEqual(["AAPL", "NVDA", "META"]);
    expect(output.requested).toBe(3);
    expect(output.received).toBe(3);
    const artifact = await enrichedStore.latestUsable(ENRICH_ID);
    expect(artifact?.rows.map((r) => r.symbol)).toEqual(["AAPL", "NVDA", "META"]);
  });

  it("refuses by name: unknown job, unwired stores, no persisted input", async () => {
    const quotes = universeQuotes();
    const { datasetStore, enrichedStore } = await seededStores(quotes);
    const steps = new JobStepRegistry();
    registerEnrichStep(steps, enrichDeps(datasetStore, enrichedStore));

    await expect(
      steps.resolve(ENRICH_SCREENER_STEP)(
        stepCtx({
          jobId: ENRICH_ID,
          params: { enrichJobId: "no-such-enrich-job", enrichFrom: [] },
        }) as never,
      ),
    ).rejects.toThrow("ENRICH_JOB_NOT_FOUND");

    const noDatasetSteps = new JobStepRegistry();
    registerEnrichStep(noDatasetSteps, {
      registry: buildEnrichJobRegistry({}),
      datasetStore: null,
      enrichedStore,
    });
    await expect(
      noDatasetSteps.resolve(ENRICH_SCREENER_STEP)(
        stepCtx({
          jobId: ENRICH_ID,
          params: { enrichJobId: ENRICH_ID, enrichFrom: [] },
        }) as never,
      ),
    ).rejects.toThrow("ENRICH_JOB_NOT_CONFIGURED");

    const noEnrichedSteps = new JobStepRegistry();
    registerEnrichStep(noEnrichedSteps, enrichDeps(datasetStore, null));
    await expect(
      noEnrichedSteps.resolve(ENRICH_SCREENER_STEP)(
        stepCtx({
          jobId: ENRICH_ID,
          params: { enrichJobId: ENRICH_ID, enrichFrom: [] },
        }) as never,
      ),
    ).rejects.toThrow("ENRICH_JOB_NOT_CONFIGURED");

    const emptyDataset = new InMemoryFeedDatasetStore();
    const emptyEnriched = new InMemoryEnrichedDatasetStore();
    const emptySteps = new JobStepRegistry();
    registerEnrichStep(emptySteps, enrichDeps(emptyDataset, emptyEnriched));
    await expect(
      emptySteps.resolve(ENRICH_SCREENER_STEP)(
        stepCtx({
          jobId: ENRICH_ID,
          params: { enrichJobId: ENRICH_ID, enrichFrom: [] },
        }) as never,
      ),
    ).rejects.toThrow("ENRICH_INPUT_MISSING");
    const recorded = await emptyEnriched.latest(ENRICH_ID);
    expect(recorded?.run.codedError).toBe("ENRICH_INPUT_MISSING");
  });
});
