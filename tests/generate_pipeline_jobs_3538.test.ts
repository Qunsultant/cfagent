// @vitest-environment node
/**
 * Issue #3538 (Pipeline J5) — the generate jobs on the J1 pipeline:
 *
 * - Catalog + name resolution: one generate job per analyze job;
 *   ambiguous/unknown names refuse (null).
 * - Definitions: valid J1 definitions by configuration alone —
 *   generate kind, the generate.apply step carrying the rules
 *   (reports + formats) as params, an enabled schedule.
 * - The chain: a feed run persists its dataset, the enrich run
 *   derives from it, the analyze run derives from that, and the
 *   generate run consumes THAT persisted analyzed artifact
 *   (lineage: the generated artifact names the analyze run),
 *   persists under the PIPELINE run id, records through the
 *   JobRunRecordStore machinery (system "job-pipeline"),
 *   publishes job.completed, and surfaces in the merged status
 *   view. The canonical leg is recorded not_wired here (no host
 *   wires the canonical seam in this residency — recorded per
 *   report, never claimed as stored).
 * - Configuration is live: a configureJob patch narrowing the
 *   formats changes the next run's output (AOP, not code).
 * - Modes: sharded generate partitions the persisted input.
 * - Management: retry operates through the same control plane.
 * - Refusals: no persisted analyzed input fails the run with
 *   GENERATE_INPUT_MISSING (and the generated store records the
 *   same failure); an unwired store refuses
 *   GENERATE_JOB_NOT_CONFIGURED.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
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
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
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
  GENERATE_APPLY_STEP,
  GENERATE_PIPELINE_CATALOG,
  buildAllGeneratePipelineJobDefinitions,
  buildGenerateJobSurfaceView,
  ensureGeneratePipelineJobs,
  resolveGenerateJob,
  type GenerateStepDeps,
} from "../src/services/generatePipelineJobs";
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
const GENERATE_ID = `${ANALYZE_ID}-generate`;

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
  generatedStore: InMemoryGeneratedDatasetStore | null;
  events: string[];
}

async function makeHarness(
  opts: { generatedStore?: InMemoryGeneratedDatasetStore | null } = {},
): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore =
    opts.generatedStore === undefined ? new InMemoryGeneratedDatasetStore() : opts.generatedStore;
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
  const generateDeps: GenerateStepDeps = {
    registry: buildGenerateJobRegistry({}),
    analyzedStore,
    generatedStore,
    canonicalReportStore: null,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(feedDeps, enrichDeps, analyzeDeps, generateDeps),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  return {
    control,
    stores,
    runStore,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
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
  const analyzeDispatch = await runOk(h, ANALYZE_ID);
  return { feedDispatch, enrichDispatch, analyzeDispatch };
}

describe("generate pipeline catalog + resolution (#3538)", () => {
  it("carries one generate job per analyze job", () => {
    expect(GENERATE_PIPELINE_CATALOG.map((e) => e.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
      "yahoo-sp100-quotes-enrich-analyze-generate",
      "yahoo-sp500-quotes-enrich-analyze-generate",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate",
      "etrade-nasdaq100-quotes-enrich-analyze-generate",
      "public-nasdaq100-quotes-enrich-analyze-generate",
    ]);
    expect(resolveGenerateJob("yahoo nasdaq100 generate")?.jobId).toBe(GENERATE_ID);
    expect(resolveGenerateJob("yahoo generate")?.jobId).toBe(GENERATE_ID);
    expect(resolveGenerateJob("sp100 generate")?.jobId).toBe(
      "yahoo-sp100-quotes-enrich-analyze-generate",
    );
    expect(resolveGenerateJob("generate alpaca")?.jobId).toBe(
      "alpaca-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(resolveGenerateJob(GENERATE_ID)?.jobId).toBe(GENERATE_ID);
    expect(resolveGenerateJob("generate")).toBeNull(); // ambiguous — refuses
    expect(resolveGenerateJob("generate bitcoin")).toBeNull(); // unknown — refuses
  });

  it("every catalog definition resolves as a valid J1 job definition", () => {
    const raws = buildAllGeneratePipelineJobDefinitions({});
    expect(raws).toHaveLength(6);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("generate");
      expect(resolved.root.steps[0]?.step).toBe(GENERATE_APPLY_STEP);
      expect(resolved.config.schedule.enabled).toBe(true);
      const params = resolved.root.steps[0]?.params as {
        reports?: string[];
        formats?: string[];
      };
      expect(params.reports).toEqual(["analysis"]);
      expect(params.formats).toEqual(["json", "markdown", "csv", "pdf"]);
    }
  });

  it("registerSchedules registers feed + enrich + analyze + generate jobs (the full plane)", async () => {
    const h = await makeHarness();
    const specs: Array<{ jobId: string }> = [];
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    });
    expect(registrations).toHaveLength(26);
    expect(specs.map((s) => s.jobId)).toContain(GENERATE_ID);
  });
});

describe("the analyze → generate chain on the plane (#3538)", () => {
  it("generate consumes the persisted analyzed artifact and persists its own, one run one id", async () => {
    const h = await makeHarness();
    const { analyzeDispatch } = await runChain(h);
    const dispatch = await runOk(h, GENERATE_ID);

    const artifact = await h.generatedStore!.latestUsable(GENERATE_ID);
    expect(artifact).toBeDefined();
    // One run, one id: the artifact carries the PIPELINE run id.
    expect(artifact?.run.runId).toBe(dispatch.runId);
    // Lineage: the artifact names the analyze run it derives from.
    expect(artifact?.inputRunId).toBe(analyzeDispatch.runId);
    expect(artifact?.analyzeJobId).toBe(ANALYZE_ID);
    // All four formats rendered; the canonical leg is recorded.
    expect(artifact?.summary.formatsGenerated).toBe(4);
    expect(artifact?.reports[0]?.formats.map((f) => f.format)).toEqual([
      "json",
      "markdown",
      "csv",
      "pdf",
    ]);
    expect(artifact?.reports[0]?.canonical.status).toBe("not_wired");
    expect(artifact?.reports[0]?.canonical.reason).toBe(
      "canonical_report_store_not_wired",
    );
    // Run records + events: the run is on the platform machinery.
    const record = h.runStore.listByJob(GENERATE_ID)[0];
    expect(record?.system).toBe("job-pipeline");
    expect(record?.outcome).toBe("success");
    expect(h.events).toContain("job.completed");

    const view = await buildGenerateJobSurfaceView({
      entry: resolveGenerateJob("yahoo nasdaq100 generate")!,
      generatedStore: h.generatedStore!,
      registry: buildGenerateJobRegistry({}),
      pipeline: await h.control.getJob(GENERATE_ID),
      nowMs: Date.now(),
    });
    expect(view.generate?.snapshot?.reportsPersisted).toBe(1);
    expect(view.generate?.snapshot?.formatsPersisted).toBe(4);
    expect(view.generate?.snapshot?.inputRunId).toBe(analyzeDispatch.runId);
    expect(view.generate?.snapshot?.reports[0]?.canonicalStatus).toBe("not_wired");
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.nextScheduledRun).not.toBeNull();
  });

  it("a configureJob patch narrows the formats the next run renders", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(GENERATE_ID, {
      root: {
        steps: [
          {
            step: GENERATE_APPLY_STEP,
            params: { generateJobId: GENERATE_ID, reports: ["analysis"], formats: ["json"] },
          },
        ],
      },
    });
    await runOk(h, GENERATE_ID);
    const artifact = await h.generatedStore!.latestUsable(GENERATE_ID);
    expect(artifact?.reports[0]?.formats.map((f) => f.format)).toEqual(["json"]);
    expect(artifact?.formatsRequested).toEqual(["json"]);
    expect(artifact?.run.status).toBe("completed");
  });
});

describe("generate refusals on the plane (#3538)", () => {
  it("no persisted analyzed input: the run fails GENERATE_INPUT_MISSING and both records agree", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(GENERATE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("GENERATE_INPUT_MISSING");
    expect(h.runStore.listByJob(GENERATE_ID)[0]?.outcome).toBe("failure");
    const recorded = await h.generatedStore!.latest(GENERATE_ID);
    expect(recorded?.run.codedError).toBe("GENERATE_INPUT_MISSING");
    expect(await h.generatedStore!.latestUsable(GENERATE_ID)).toBeUndefined();
  });

  it("an unwired generated store refuses GENERATE_JOB_NOT_CONFIGURED", async () => {
    const h = await makeHarness({ generatedStore: null });
    await runChain(h);
    const dispatch = await h.control.runJob(GENERATE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("GENERATE_JOB_NOT_CONFIGURED");
  });
});

describe("generate modes + management (#3538)", () => {
  it("sharded mode partitions the persisted input across units", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(GENERATE_ID, {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const dispatch = await h.control.runJob(GENERATE_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const runs = await h.generatedStore!.listRuns(GENERATE_ID, 10);
    expect(runs).toHaveLength(2);
    const symbolSets = runs.map((a) => {
      const json = a.reports[0]!.formats.find((f) => f.format === "json")!;
      const document = JSON.parse(json.bodyText!) as any;
      return (document.rows as Array<{ symbol: string }>).map((r) => r.symbol).sort();
    });
    expect(symbolSets.flat().sort()).toEqual([...SYMBOLS].sort());
    expect(symbolSets[0]).not.toEqual(symbolSets[1]);
  });

  it("retry re-runs a completed generate job as a new run", async () => {
    const h = await makeHarness();
    await runChain(h);
    const first = await runOk(h, GENERATE_ID);
    const retried = await h.control.retryJob(GENERATE_ID);
    const outcome = await retried.completion!;
    expect(outcome.state).toBe("completed");
    expect(retried.runId).not.toBe(first.runId);
    expect(h.runStore.listByJob(GENERATE_ID)).toHaveLength(2);
    await expect(h.control.pauseJob(GENERATE_ID)).rejects.toThrow(/pausable|can pause/i);
  });
});
