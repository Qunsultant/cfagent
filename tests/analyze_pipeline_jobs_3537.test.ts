// @vitest-environment node
/**
 * Issue #3537 (Pipeline J4) — the analyze jobs on the J1 pipeline:
 *
 * - Catalog + name resolution: one analyze job per enrich job;
 *   ambiguous/unknown names refuse (null).
 * - Definitions: valid J1 definitions by configuration alone —
 *   analyze kind, the analyze.apply step carrying the rules
 *   (rule sets + thresholds) as params, an enabled schedule.
 * - The chain: a feed run persists its dataset, the enrich run
 *   derives from it, the analyze run consumes THAT persisted
 *   enriched artifact (lineage: the analyzed artifact names
 *   the enrich run), persists under the PIPELINE run id,
 *   records through the JobRunRecordStore machinery (system
 *   "job-pipeline"), publishes job.completed, and surfaces in
 *   the merged status view.
 * - Configuration is live: a configureJob patch changing the
 *   rule sets changes the next run's output (AOP, not code).
 * - Modes: sharded analyze partitions the persisted input.
 * - Management: retry operates through the same control plane.
 * - Refusals: no persisted enriched input fails the run with
 *   ANALYZE_INPUT_MISSING (and the analyzed store records the
 *   same failure); an unwired store refuses
 *   ANALYZE_JOB_NOT_CONFIGURED.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
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
  ANALYZE_APPLY_STEP,
  ANALYZE_PIPELINE_CATALOG,
  buildAllAnalyzePipelineJobDefinitions,
  buildAnalyzeJobSurfaceView,
  ensureAnalyzePipelineJobs,
  resolveAnalyzeJob,
  type AnalyzeStepDeps,
} from "../src/services/analyzePipelineJobs";
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
const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";
const ANALYZE_ID = `${ENRICH_ID}-analyze`;

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

function fakeProvider(id: DataProvider["id"]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
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
  };
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
  datasetStore: InMemoryFeedDatasetStore;
  enrichedStore: InMemoryEnrichedDatasetStore;
  analyzedStore: InMemoryAnalyzedDatasetStore;
  events: string[];
}

async function makeHarness(
  opts: { analyzedStore?: InMemoryAnalyzedDatasetStore | null } = {},
): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore =
    opts.analyzedStore === undefined ? new InMemoryAnalyzedDatasetStore() : opts.analyzedStore;
  const universes = new InMemoryIndexListStore();
  await universes.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  await universes.store({
    index: "sp100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (S&P 100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const events: string[] = [];
  messaging.subscribe("collector", "job.completed", (e) => {
    events.push(e.type);
    return "processed";
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
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(feedDeps, enrichDeps, analyzeDeps),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  return {
    control,
    stores,
    runStore,
    datasetStore,
    enrichedStore,
    analyzedStore: analyzedStore as InMemoryAnalyzedDatasetStore,
    events,
  };
}

async function runOk(h: Harness, jobId: string) {
  const dispatch = await h.control.runJob(jobId);
  const outcome = await dispatch.completion!;
  expect(outcome.state).toBe("completed");
  return dispatch;
}

async function runChain(h: Harness) {
  const feedDispatch = await runOk(h, "yahoo-nasdaq100-quotes");
  await runOk(h, "yahoo-nasdaq100-fundamentals");
  const enrichDispatch = await runOk(h, ENRICH_ID);
  return { feedDispatch, enrichDispatch };
}

describe("analyze pipeline catalog + resolution (#3537)", () => {
  it("carries one analyze job per enrich job", () => {
    expect(ANALYZE_PIPELINE_CATALOG.map((e) => e.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze",
      "yahoo-sp100-quotes-enrich-analyze",
      "yahoo-sp500-quotes-enrich-analyze",
      "yahoo-dow-quotes-enrich-analyze",
      "yahoo-sp400-quotes-enrich-analyze",
      "yahoo-sector-energy-quotes-enrich-analyze",
      "yahoo-sector-materials-quotes-enrich-analyze",
      "yahoo-sector-industrials-quotes-enrich-analyze",
      "yahoo-sector-consumer-discretionary-quotes-enrich-analyze",
      "yahoo-sector-consumer-staples-quotes-enrich-analyze",
      "yahoo-sector-health-care-quotes-enrich-analyze",
      "yahoo-sector-financials-quotes-enrich-analyze",
      "yahoo-sector-information-technology-quotes-enrich-analyze",
      "yahoo-sector-communication-services-quotes-enrich-analyze",
      "yahoo-sector-utilities-quotes-enrich-analyze",
      "yahoo-sector-real-estate-quotes-enrich-analyze",
      "alpaca-nasdaq100-quotes-enrich-analyze",
      "etrade-nasdaq100-quotes-enrich-analyze",
      "public-nasdaq100-quotes-enrich-analyze",
    ]);
    expect(resolveAnalyzeJob("yahoo nasdaq100 analyze")?.jobId).toBe(ANALYZE_ID);
    expect(resolveAnalyzeJob("yahoo analyze")?.jobId).toBe(ANALYZE_ID);
    expect(resolveAnalyzeJob("sp100 analyze")?.jobId).toBe(
      "yahoo-sp100-quotes-enrich-analyze",
    );
    expect(resolveAnalyzeJob("enrich yahoo analyze")?.jobId).toBe(ANALYZE_ID);
    expect(resolveAnalyzeJob("analyze alpaca")?.jobId).toBe(
      "alpaca-nasdaq100-quotes-enrich-analyze",
    );
    expect(resolveAnalyzeJob(ANALYZE_ID)?.jobId).toBe(ANALYZE_ID);
    expect(resolveAnalyzeJob("analyze")).toBeNull(); // ambiguous — refuses
    expect(resolveAnalyzeJob("analyze nasdaq")).toBeNull(); // ambiguous — refuses
    expect(resolveAnalyzeJob("analyze bitcoin")).toBeNull(); // unknown — refuses
  });

  it("every catalog definition resolves as a valid J1 job definition", () => {
    const raws = buildAllAnalyzePipelineJobDefinitions({});
    expect(raws).toHaveLength(19);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("analyze");
      expect(resolved.root.steps[0]?.step).toBe(ANALYZE_APPLY_STEP);
      expect(resolved.config.schedule.enabled).toBe(true);
      const params = resolved.root.steps[0]?.params as { ruleSets?: string[] };
      expect(params.ruleSets).toEqual(["momentum", "range", "volume", "value"]);
    }
  });

  it("registerSchedules registers feed + enrich + analyze jobs (the full plane)", async () => {
    const h = await makeHarness();
    const specs: Array<{ jobId: string }> = [];
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    });
    // #4065 pin update: three options-chains jobs join the plane.
    expect(registrations).toHaveLength(64);
    expect(specs.map((s) => s.jobId)).toContain(ANALYZE_ID);
  });
});

describe("the enrich → analyze chain on the plane (#3537)", () => {
  it("analyze consumes the persisted enriched artifact and persists its own, one run one id", async () => {
    const h = await makeHarness();
    const { enrichDispatch } = await runChain(h);
    const dispatch = await runOk(h, ANALYZE_ID);

    const artifact = await h.analyzedStore.latestUsable(ANALYZE_ID);
    expect(artifact).toBeDefined();
    // One run, one id: the artifact carries the PIPELINE run id.
    expect(artifact?.run.runId).toBe(dispatch.runId);
    // Lineage: the artifact names the enrich run it derives from.
    expect(artifact?.inputRunId).toBe(enrichDispatch.runId);
    expect(artifact?.enrichJobId).toBe(ENRICH_ID);
    expect(artifact?.rows).toHaveLength(SYMBOLS.length);
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL");
    // The fake quotes carry changePercent 1 ⇒ momentum "up", score 10.
    expect(aapl?.signals.momentum).toBe("up");
    expect(aapl?.scores.momentum).toBe(10);
    // Run records + events: the run is on the platform machinery.
    const record = h.runStore.listByJob(ANALYZE_ID)[0];
    expect(record?.system).toBe("job-pipeline");
    expect(record?.outcome).toBe("success");
    expect(h.events).toContain("job.completed");

    const view = await buildAnalyzeJobSurfaceView({
      entry: resolveAnalyzeJob("yahoo nasdaq100 analyze")!,
      analyzedStore: h.analyzedStore,
      registry: buildAnalyzeJobRegistry({}),
      pipeline: await h.control.getJob(ANALYZE_ID),
      nowMs: Date.now(),
    });
    expect(view.analyze?.snapshot?.rowsPersisted).toBe(SYMBOLS.length);
    expect(view.analyze?.snapshot?.inputRunId).toBe(enrichDispatch.runId);
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.nextScheduledRun).not.toBeNull();
  });

  it("a configureJob patch changes the rule sets the next run applies", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(ANALYZE_ID, {
      root: {
        steps: [
          {
            step: ANALYZE_APPLY_STEP,
            params: { analyzeJobId: ANALYZE_ID, ruleSets: ["momentum"] },
          },
        ],
      },
    });
    const dispatch = await runOk(h, ANALYZE_ID);
    void dispatch;
    const artifact = await h.analyzedStore.latestUsable(ANALYZE_ID);
    expect(artifact?.ruleSets).toEqual(["momentum"]);
    expect(Object.keys(artifact?.rows[0]?.signals ?? {})).toEqual(["momentum"]);
    expect(artifact?.run.status).toBe("completed");
  });

  it("thresholds ride the step params: a configured bar reclassifies the run", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(ANALYZE_ID, {
      root: {
        steps: [
          {
            step: ANALYZE_APPLY_STEP,
            params: {
              analyzeJobId: ANALYZE_ID,
              ruleSets: ["momentum"],
              thresholds: { mildMovePercent: 2 },
            },
          },
        ],
      },
    });
    await runOk(h, ANALYZE_ID);
    const artifact = await h.analyzedStore.latestUsable(ANALYZE_ID);
    // changePercent 1 < configured mild bar 2 ⇒ "flat".
    expect(artifact?.rows[0]?.signals.momentum).toBe("flat");
  });
});

describe("analyze refusals on the plane (#3537)", () => {
  it("no persisted enriched input: the run fails ANALYZE_INPUT_MISSING and both records agree", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(ANALYZE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("ANALYZE_INPUT_MISSING");
    expect(h.runStore.listByJob(ANALYZE_ID)[0]?.outcome).toBe("failure");
    const recorded = await h.analyzedStore.latest(ANALYZE_ID);
    expect(recorded?.run.codedError).toBe("ANALYZE_INPUT_MISSING");
    expect(await h.analyzedStore.latestUsable(ANALYZE_ID)).toBeUndefined();
  });

  it("an unwired analyzed store refuses ANALYZE_JOB_NOT_CONFIGURED", async () => {
    const h = await makeHarness({ analyzedStore: null });
    await runChain(h);
    const dispatch = await h.control.runJob(ANALYZE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("ANALYZE_JOB_NOT_CONFIGURED");
  });
});

describe("analyze modes + management (#3537)", () => {
  it("sharded mode partitions the persisted input across units", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(ANALYZE_ID, {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const dispatch = await h.control.runJob(ANALYZE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const runs = await h.analyzedStore.listRuns(ANALYZE_ID, 10);
    const rowSets = runs.map((a) => a.rows.map((r) => r.symbol).sort());
    expect(rowSets).toHaveLength(2);
    expect(rowSets.flat().sort()).toEqual([...SYMBOLS].sort());
    expect(rowSets[0]).not.toEqual(rowSets[1]);
  });

  it("retry re-runs a completed analyze job as a new run", async () => {
    const h = await makeHarness();
    await runChain(h);
    const first = await runOk(h, ANALYZE_ID);
    const retried = await h.control.retryJob(ANALYZE_ID);
    const outcome = await retried.completion!;
    expect(outcome.state).toBe("completed");
    expect(retried.runId).not.toBe(first.runId);
    expect(h.runStore.listByJob(ANALYZE_ID)).toHaveLength(2);
    await expect(h.control.pauseJob(ANALYZE_ID)).rejects.toThrow(/pausable|can pause/i);
  });
});
