// @vitest-environment node
/**
 * Issue #3540 (Pipeline J7) — the PROOF RUNS: the composed
 * chain executed end-to-end over the real machinery (the J1
 * engine + the five stage families' own steps + the persisted
 * dataset stores), composed exactly the way production
 * composes it (the deliver_pipeline_jobs_3539 harness, plus
 * the chain ensure). No stage is mocked; the only fake is the
 * data-provider seam every family test uses.
 *
 * - Combination A (defaults): sequential / batch / async /
 *   monolith — a NASDAQ100 feed through to a delivered report,
 *   every stage artifact carrying the CHAIN run id (one run,
 *   one lineage).
 * - Combination B: sync delivery at the chain root + the
 *   deliver stage sharded (configured on the deliver stage job,
 *   flowing into the chain by re-derivation) — the run settles
 *   inside runJob, and the (report × channel) pairs partition
 *   across the deliver units with no pair delivered twice.
 * - Failure semantics: a failing deliver stage halts the chain
 *   at the deliver frontier (visible in the roll-up), upstream
 *   artifacts intact, downstream nothing; re-running the failed
 *   stage from its persisted input completes the chain WITHOUT
 *   re-fetching the feed.
 * - Stage control in-chain: stop the running feed stage (the
 *   run pauses, recorded stopped, never failed) and resume it
 *   from its checkpoint; cancel a not-yet-run stage of a live
 *   run (it never executes, the run settles cancelled).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  buildFeedJobRegistry as buildFeedRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import {
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
  type EnrichStepDeps,
} from "../src/services/enrichPipelineJobs";
import {
  ensureAnalyzePipelineJobs,
  type AnalyzeStepDeps,
} from "../src/services/analyzePipelineJobs";
import {
  ensureGeneratePipelineJobs,
  type GenerateStepDeps,
} from "../src/services/generatePipelineJobs";
import {
  DELIVER_APPLY_STEP,
  ensureDeliverPipelineJobs,
  type DeliverStepDeps,
} from "../src/services/deliverPipelineJobs";
import {
  buildPipelineChainRegistry,
  chainStageNodePath,
} from "../src/services/pipelineChains";
import {
  CHAIN_PIPELINE_CATALOG,
  buildChainSurfaceView,
  ensureChainPipelineJobs,
  refreshChainDefinitionFromStoredStages,
  type PipelineChainSurfaceView,
} from "../src/services/chainPipelineJobs";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchQuote,
} from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const FEED_ID = "yahoo-nasdaq100-quotes";
const ENRICH_ID = `${FEED_ID}-enrich`;
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const GENERATE_ID = `${ANALYZE_ID}-generate`;
const DELIVER_ID = `${GENERATE_ID}-deliver`;
const CHAIN_ID = `${FEED_ID}-pipeline`;

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

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
  datasetStore: InMemoryFeedDatasetStore;
  enrichedStore: InMemoryEnrichedDatasetStore;
  analyzedStore: InMemoryAnalyzedDatasetStore;
  generatedStore: InMemoryGeneratedDatasetStore;
  deliveryStore: InMemoryDeliveryDatasetStore;
  quotesCalls: () => number;
  senderCalls: string[];
  flags: { failSlack: boolean };
  gate: { entered: Promise<void>; release: () => void } | null;
}

async function makeHarness(opts: { gated?: boolean } = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const universes = new InMemoryIndexListStore();
  for (const index of ["nasdaq100", "sp100"] as const) {
    await universes.store({
      index,
      snapshotDate: "2026-11-02",
      symbols: SYMBOLS.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (index table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
  }
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  let quotesCalls = 0;
  const senderCalls: string[] = [];
  const flags = { failSlack: false };
  let gate: Harness["gate"] = null;
  if (opts.gated) {
    let enteredResolve: () => void = () => {};
    let releaseResolve: () => void = () => {};
    const entered = new Promise<void>((r) => (enteredResolve = r));
    const released = new Promise<void>((r) => (releaseResolve = r));
    gate = { entered, release: () => releaseResolve() };
    // The gate blocks only the FIRST quotes fetch (the chain's
    // feed stage); later fetches pass through.
    let armed = true;
    var gateHook = async () => {
      if (!armed) return;
      armed = false;
      enteredResolve();
      await released;
    };
  }
  const fakeProvider = (id: DataProvider["id"]): DataProvider => ({
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      quotesCalls += 1;
      if (typeof gateHook !== "undefined") await gateHook();
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = SYMBOLS.map((s) => quote(s)).filter((q) =>
        wanted.has(q.symbol.toUpperCase()),
      );
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
    getFundamentals: async (symbol: string) =>
      ({
        providerId: id,
        capability: "fundamentals",
        result: { symbol, marketCap: 1_000_000, peTrailing: 25 } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
  });
  const feedDeps: FeedStepDeps = {
    registry: buildFeedRegistry({}),
    providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId),
    universeStore: universes,
    datasetStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
    indexRefresh: null,
  };
  const enrichDeps: EnrichStepDeps = {
    registry: buildEnrichJobRegistry({}),
    datasetStore,
    enrichedStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const analyzeDeps: AnalyzeStepDeps = {
    registry: buildAnalyzeJobRegistry({}),
    enrichedStore,
    analyzedStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const generateDeps: GenerateStepDeps = {
    registry: buildGenerateJobRegistry({}),
    analyzedStore,
    generatedStore,
    canonicalReportStore: null,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const deliverDeps: DeliverStepDeps = {
    registry: buildDeliverJobRegistry({}),
    generatedStore,
    deliveryStore,
    senders: {
      slack: async () => {
        senderCalls.push("slack");
        return flags.failSlack ? { ok: false, error: "slack transport down" } : { ok: true };
      },
      email: async () => {
        senderCalls.push("email");
        return { ok: true };
      },
      webhook: async () => {
        senderCalls.push("webhook");
        return { ok: true, target: "hooks.example.com" };
      },
    },
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(feedDeps, enrichDeps, analyzeDeps, generateDeps, deliverDeps),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  await ensureChainPipelineJobs(control, stores, {});
  return {
    control,
    stores,
    runStore,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
    deliveryStore,
    quotesCalls: () => quotesCalls,
    senderCalls,
    flags,
    gate,
  };
}

async function chainView(h: Harness): Promise<PipelineChainSurfaceView> {
  const registry = buildPipelineChainRegistry({});
  const chain = registry.forId(CHAIN_ID)!;
  const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === CHAIN_ID)!;
  const stagePipelines: Record<string, Awaited<ReturnType<JobPipelineControl["getJob"]>>> = {};
  for (const node of chain.nodes) {
    stagePipelines[node.jobId] = await h.control.getJob(node.jobId);
  }
  return buildChainSurfaceView({
    entry,
    chain,
    pipeline: await h.control.getJob(CHAIN_ID),
    stagePipelines,
    nowMs: T0,
  });
}

describe("proof run — combination A: defaults (sequential/batch/async/monolith) (#3540)", () => {
  it("a NASDAQ100 feed runs through to a delivered report, one run one lineage", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(CHAIN_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    // Every stage's persisted artifact carries the CHAIN run id.
    expect((await h.datasetStore.latestUsable("yahoo", "quotes"))?.run.runId).toBe(dispatch.runId);
    expect((await h.enrichedStore.latestUsable(ENRICH_ID))?.run.runId).toBe(dispatch.runId);
    expect((await h.analyzedStore.latestUsable(ANALYZE_ID))?.run.runId).toBe(dispatch.runId);
    expect((await h.generatedStore.latestUsable(GENERATE_ID))?.run.runId).toBe(dispatch.runId);
    const delivery = await h.deliveryStore.latestUsable(DELIVER_ID);
    expect(delivery?.run.runId).toBe(dispatch.runId);
    expect(delivery?.run.status).toBe("completed");
    expect(delivery?.summary.channelsDelivered).toBeGreaterThan(0);
    // The run is on the platform run-record machinery, as the chain job.
    const record = h.runStore.listByJob(CHAIN_ID)[0];
    expect(record?.system).toBe("job-pipeline");
    expect(record?.outcome).toBe("success");
    // The stage jobs themselves were NOT run standalone — the
    // chain composed them; their own run histories stay empty.
    expect(h.runStore.listByJob(FEED_ID)).toHaveLength(0);
    expect(h.runStore.listByJob(DELIVER_ID)).toHaveLength(0);
  });
});

describe("proof run — combination B: sync delivery + sharded deliver stage (#3540)", () => {
  it("the run settles inside runJob and the deliver pairs partition across units", async () => {
    const h = await makeHarness();
    // Configure the DELIVER STAGE JOB (sharded shape) — the
    // chain re-derives its deliver child from the stored stage
    // definition, so the stage's configuration IS the chain's.
    await h.control.configureJob(DELIVER_ID, {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const registry = buildPipelineChainRegistry({});
    await refreshChainDefinitionFromStoredStages(
      h.control,
      h.stores,
      registry.forId(CHAIN_ID)!,
    );
    // Sync delivery at the chain root.
    await h.control.configureJob(CHAIN_ID, {
      root: { executionMode: { delivery: "sync" } },
    });
    const dispatch = await h.control.runJob(CHAIN_ID);
    // Sync: runJob itself awaited the terminal state.
    expect(dispatch.state).toBe("completed");
    const runs = await h.deliveryStore.listRuns(DELIVER_ID, 10);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.run.runId === dispatch.runId)).toBe(true);
    const channelSets = runs.map((a) =>
      a.reports.flatMap((r) => r.channels.map((c) => c.channel)).sort(),
    );
    // Every channel delivered by exactly one unit — no pair twice.
    expect(channelSets.flat().sort()).toEqual(["email", "slack", "ux", "webhook"]);
    expect(channelSets[0]).not.toEqual(channelSets[1]);
    const view = await chainView(h);
    expect(view.stages.find((s) => s.stage === "deliver")?.units).toBe(2);
    expect(view.frontier).toBeNull();
  });
});

describe("chain failure semantics (#3540)", () => {
  it("a failing stage halts the chain at its frontier; re-running that stage completes it without re-fetching", async () => {
    const h = await makeHarness();
    // Narrow the deliver stage to slack only and break slack:
    // every pair fails, so the deliver run (and the chain) fail.
    await h.control.configureJob(DELIVER_ID, {
      root: {
        steps: [
          {
            step: DELIVER_APPLY_STEP,
            params: { deliverJobId: DELIVER_ID, channels: ["slack"] },
          },
        ],
      },
    });
    const registry = buildPipelineChainRegistry({});
    const chain = registry.forId(CHAIN_ID)!;
    await refreshChainDefinitionFromStoredStages(h.control, h.stores, chain);
    h.flags.failSlack = true;
    const dispatch = await h.control.runJob(CHAIN_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("DELIVER_ALL_CHANNELS_FAILED");

    // The halt is VISIBLE: frontier = deliver, upstream stages
    // completed, the deliver stage failed, nothing downstream
    // exists (deliver is last) and no usable delivery landed.
    const view = await chainView(h);
    expect(view.frontier).toBe("deliver");
    expect(view.stages.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "failed",
    ]);
    expect(await h.deliveryStore.latestUsable(DELIVER_ID)).toBeUndefined();
    expect((await h.generatedStore.latestUsable(GENERATE_ID))?.run.runId).toBe(dispatch.runId);
    const quotesAfterFailure = h.quotesCalls();
    expect(quotesAfterFailure).toBeGreaterThan(0);

    // Fix the transport and re-run ONLY the failed stage from
    // its persisted input: the chain completes its frontier
    // without re-running the completed stages (no new fetch).
    h.flags.failSlack = false;
    const rerun = await h.control.rerunStage(CHAIN_ID, chainStageNodePath(chain, "deliver"));
    expect(rerun.state).toBe("completed");
    expect(rerun.runId).toBe(dispatch.runId);
    expect(h.quotesCalls()).toBe(quotesAfterFailure);
    const delivery = await h.deliveryStore.latestUsable(DELIVER_ID);
    expect(delivery?.run.runId).toBe(dispatch.runId);
    expect(delivery?.run.status).toBe("completed");
    const after = await chainView(h);
    expect(after.stages.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(after.frontier).toBeNull();
  });

  it("a stage with no persisted input refuses by name inside the chain (downstream never fabricates)", async () => {
    const h = await makeHarness();
    // Run ONLY the enrich stage of the chain standalone via a
    // scoped dispatch... the chain as a whole with the feed
    // stage's dataset absent is the same refusal one level up:
    // dispatch the deliver stage job alone (no generated input
    // exists) and the named refusal is the surface.
    const dispatch = await h.control.runJob(DELIVER_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("DELIVER_INPUT_MISSING");
    expect(await h.deliveryStore.latestUsable(DELIVER_ID)).toBeUndefined();
  });
});

describe("stage control inside the chain (#3540)", () => {
  it("stops the running feed stage (paused, never failed) and resumes it from its checkpoint", async () => {
    const h = await makeHarness({ gated: true });
    const registry = buildPipelineChainRegistry({});
    const chain = registry.forId(CHAIN_ID)!;
    const dispatch = await h.control.runJob(CHAIN_ID);
    await h.gate!.entered;
    await h.control.stopStage(CHAIN_ID, chainStageNodePath(chain, "feed"));
    h.gate!.release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    const view = await chainView(h);
    expect(view.pipeline?.state).toBe("paused");
    expect(view.stages[0]?.status).toBe("stopped");
    expect(view.stages[1]?.status).toBe("not-run");
    expect(await h.deliveryStore.latestUsable(DELIVER_ID)).toBeUndefined();

    const resumed = await h.control.resumeStage(CHAIN_ID, chainStageNodePath(chain, "feed"));
    const resumedOutcome = await resumed.completion!;
    expect(resumedOutcome.state).toBe("completed");
    expect(resumed.runId).toBe(dispatch.runId);
    const delivery = await h.deliveryStore.latestUsable(DELIVER_ID);
    expect(delivery?.run.runId).toBe(dispatch.runId);
  });

  it("cancels a not-yet-run stage of a live run: it never executes and the run settles cancelled", async () => {
    const h = await makeHarness({ gated: true });
    const registry = buildPipelineChainRegistry({});
    const chain = registry.forId(CHAIN_ID)!;
    const dispatch = await h.control.runJob(CHAIN_ID);
    await h.gate!.entered;
    await h.control.cancelStage(CHAIN_ID, chainStageNodePath(chain, "enrich"));
    h.gate!.release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    // The feed stage completed; enrich never executed, and no
    // downstream stage produced anything.
    expect((await h.datasetStore.latestUsable("yahoo", "quotes"))?.run.runId).toBe(dispatch.runId);
    expect(await h.enrichedStore.latestUsable(ENRICH_ID)).toBeUndefined();
    expect(await h.deliveryStore.latestUsable(DELIVER_ID)).toBeUndefined();
    const view = await chainView(h);
    expect(view.stages.find((s) => s.stage === "enrich")?.status).toBe("cancelled");
  });
});
