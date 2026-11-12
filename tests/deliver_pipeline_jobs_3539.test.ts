// @vitest-environment node
/**
 * Issue #3539 (Pipeline J6) — the deliver jobs on the J1 pipeline:
 *
 * - Catalog + name resolution: one deliver job per generate
 *   job; ambiguous/unknown names refuse (null).
 * - Definitions: valid J1 definitions by configuration alone —
 *   deliver kind, the deliver.apply step carrying the rules
 *   (channels + targets) as params, an enabled schedule.
 * - The chain: a feed run persists its dataset, the enrich run
 *   derives from it, the analyze run derives from that, the
 *   generate run renders from the analyzed copy, and the
 *   deliver run consumes THAT persisted generated artifact
 *   (lineage: the delivery artifact names the generate run),
 *   persists under the PIPELINE run id, records through the
 *   JobRunRecordStore machinery (system "job-pipeline"), and
 *   publishes job.completed. The email pair records
 *   not_configured here (no recipient is configured in this
 *   residency — recorded, never faked).
 * - Configuration is live: a configureJob patch narrowing the
 *   channels changes the next run's deliveries (AOP, not code).
 * - Modes: sharded deliver partitions the run's (report ×
 *   channel) pairs — each pair delivered by exactly one unit.
 * - Management: retry operates through the same control plane.
 * - Refusals: no persisted generated input fails the run with
 *   DELIVER_INPUT_MISSING (and the delivery store records the
 *   same failure); an unwired store refuses
 *   DELIVER_JOB_NOT_CONFIGURED.
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
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
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
  DELIVER_PIPELINE_CATALOG,
  buildAllDeliverPipelineJobDefinitions,
  buildDeliverJobSurfaceView,
  ensureDeliverPipelineJobs,
  resolveDeliverJob,
  type DeliverStepDeps,
} from "../src/services/deliverPipelineJobs";
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
const DELIVER_ID = `${GENERATE_ID}-deliver`;

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
  generatedStore: InMemoryGeneratedDatasetStore;
  deliveryStore: InMemoryDeliveryDatasetStore | null;
  events: string[];
}

async function makeHarness(
  opts: { deliveryStore?: InMemoryDeliveryDatasetStore | null } = {},
): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore =
    opts.deliveryStore === undefined ? new InMemoryDeliveryDatasetStore() : opts.deliveryStore;
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
  const deliverDeps: DeliverStepDeps = {
    registry: buildDeliverJobRegistry({}),
    generatedStore,
    deliveryStore,
    senders: {
      slack: async () => ({ ok: true }),
      email: async () => ({ ok: true }),
      webhook: async () => ({ ok: true, target: "hooks.example.com" }),
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
  return {
    control,
    stores,
    runStore,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
    deliveryStore,
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
  const generateDispatch = await runOk(h, GENERATE_ID);
  return { feedDispatch, enrichDispatch, analyzeDispatch, generateDispatch };
}

describe("deliver pipeline catalog + resolution (#3539)", () => {
  it("carries one deliver job per generate job", () => {
    expect(DELIVER_PIPELINE_CATALOG.map((e) => e.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp500-quotes-enrich-analyze-generate-deliver",
      "yahoo-dow-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp400-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-energy-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-materials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-industrials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-consumer-discretionary-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-consumer-staples-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-health-care-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-financials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-information-technology-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-communication-services-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-utilities-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-real-estate-quotes-enrich-analyze-generate-deliver",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "etrade-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "public-nasdaq100-quotes-enrich-analyze-generate-deliver",
    ]);
    expect(resolveDeliverJob("yahoo nasdaq100 deliver")?.jobId).toBe(DELIVER_ID);
    expect(resolveDeliverJob("yahoo deliver")?.jobId).toBe(DELIVER_ID);
    expect(resolveDeliverJob("sp100 deliver")?.jobId).toBe(
      "yahoo-sp100-quotes-enrich-analyze-generate-deliver",
    );
    expect(resolveDeliverJob("deliver alpaca")?.jobId).toBe(
      "alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver",
    );
    expect(resolveDeliverJob(DELIVER_ID)?.jobId).toBe(DELIVER_ID);
    expect(resolveDeliverJob("deliver")).toBeNull(); // ambiguous — refuses
    expect(resolveDeliverJob("deliver bitcoin")).toBeNull(); // unknown — refuses
  });

  it("every catalog definition resolves as a valid J1 job definition", () => {
    const raws = buildAllDeliverPipelineJobDefinitions({});
    expect(raws).toHaveLength(19);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("deliver");
      expect(resolved.root.steps[0]?.step).toBe(DELIVER_APPLY_STEP);
      expect(resolved.config.schedule.enabled).toBe(true);
      const params = resolved.root.steps[0]?.params as { channels?: string[] };
      expect(params.channels).toEqual(["slack", "email", "webhook", "ux"]);
    }
  });

  it("registerSchedules registers the full plane incl. deliver (102 declarations)", async () => {
    const h = await makeHarness();
    const specs: Array<{ jobId: string }> = [];
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    });
    // #4065 pin update: three options-chains jobs join the plane.
    expect(registrations).toHaveLength(102);
    expect(specs.map((s) => s.jobId)).toContain(DELIVER_ID);
  });
});

describe("the generate → deliver chain on the plane (#3539)", () => {
  it("deliver consumes the persisted generated artifact and persists its own, one run one id", async () => {
    const h = await makeHarness();
    const { generateDispatch } = await runChain(h);
    const dispatch = await runOk(h, DELIVER_ID);

    const artifact = await h.deliveryStore!.latestUsable(DELIVER_ID);
    expect(artifact).toBeDefined();
    // One run, one id: the artifact carries the PIPELINE run id.
    expect(artifact?.run.runId).toBe(dispatch.runId);
    // Lineage: the artifact names the generate run it derives from.
    expect(artifact?.inputRunId).toBe(generateDispatch.runId);
    expect(artifact?.generateJobId).toBe(GENERATE_ID);
    // Slack + webhook + ux delivered; email recorded
    // not_configured (no recipient configured in this
    // residency) — recorded, never faked, and not a failure.
    expect(artifact?.summary.channelsDelivered).toBe(3);
    expect(artifact?.summary.channelsNotConfigured).toBe(1);
    expect(artifact?.run.status).toBe("completed");
    expect(artifact?.run.requested).toBe(3);
    const email = artifact?.reports[0]?.channels.find((c) => c.channel === "email");
    expect(email?.status).toBe("not_configured");
    expect(email?.codedError).toBe("email_recipient_not_configured");
    // Run records + events: the run is on the platform machinery.
    const record = h.runStore.listByJob(DELIVER_ID)[0];
    expect(record?.system).toBe("job-pipeline");
    expect(record?.outcome).toBe("success");
    expect(h.events).toContain("job.completed");

    const view = await buildDeliverJobSurfaceView({
      entry: resolveDeliverJob("yahoo nasdaq100 deliver")!,
      deliveryStore: h.deliveryStore!,
      registry: buildDeliverJobRegistry({}),
      pipeline: await h.control.getJob(DELIVER_ID),
      nowMs: Date.now(),
    });
    expect(view.deliver?.snapshot?.channelsDelivered).toBe(3);
    expect(view.deliver?.snapshot?.inputRunId).toBe(generateDispatch.runId);
    expect(view.deliver?.snapshot?.reports[0]?.channels.map((c) => c.channel)).toEqual([
      "slack",
      "email",
      "webhook",
      "ux",
    ]);
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.nextScheduledRun).not.toBeNull();
  });

  it("a configureJob patch narrows the channels the next run delivers", async () => {
    const h = await makeHarness();
    await runChain(h);
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
    await runOk(h, DELIVER_ID);
    const artifact = await h.deliveryStore!.latestUsable(DELIVER_ID);
    expect(artifact?.reports[0]?.channels.map((c) => c.channel)).toEqual(["slack"]);
    expect(artifact?.channelsRequested).toEqual(["slack"]);
    expect(artifact?.run.status).toBe("completed");
  });
});

describe("deliver refusals on the plane (#3539)", () => {
  it("no persisted generated input: the run fails DELIVER_INPUT_MISSING and both records agree", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(DELIVER_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("DELIVER_INPUT_MISSING");
    expect(h.runStore.listByJob(DELIVER_ID)[0]?.outcome).toBe("failure");
    const recorded = await h.deliveryStore!.latest(DELIVER_ID);
    expect(recorded?.run.codedError).toBe("DELIVER_INPUT_MISSING");
    expect(await h.deliveryStore!.latestUsable(DELIVER_ID)).toBeUndefined();
  });

  it("an unwired delivery store refuses DELIVER_JOB_NOT_CONFIGURED", async () => {
    const h = await makeHarness({ deliveryStore: null });
    await runChain(h);
    const dispatch = await h.control.runJob(DELIVER_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("DELIVER_JOB_NOT_CONFIGURED");
  });
});

describe("deliver modes + management (#3539)", () => {
  it("sharded mode partitions the (report × channel) pairs across units — no pair twice", async () => {
    const h = await makeHarness();
    await runChain(h);
    await h.control.configureJob(DELIVER_ID, {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const dispatch = await h.control.runJob(DELIVER_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const runs = await h.deliveryStore!.listRuns(DELIVER_ID, 10);
    expect(runs).toHaveLength(2);
    const channelSets = runs.map((a) =>
      a.reports.flatMap((r) => r.channels.map((c) => c.channel)).sort(),
    );
    // Every channel appears in exactly one unit's artifact.
    expect(channelSets.flat().sort()).toEqual(["email", "slack", "ux", "webhook"]);
    expect(channelSets[0]).not.toEqual(channelSets[1]);
  });

  it("retry re-runs a completed deliver job as a new run (already-delivered pairs are not re-sent)", async () => {
    const h = await makeHarness();
    await runChain(h);
    const first = await runOk(h, DELIVER_ID);
    const retried = await h.control.retryJob(DELIVER_ID);
    const outcome = await retried.completion!;
    expect(outcome.state).toBe("completed");
    expect(retried.runId).not.toBe(first.runId);
    expect(h.runStore.listByJob(DELIVER_ID)).toHaveLength(2);
    const retryArtifact = await h.deliveryStore!.latest(DELIVER_ID);
    expect(retryArtifact?.run.runId).toBe(retried.runId);
    // The retry run over the same generated copy recorded the
    // previously delivered pairs as already_delivered.
    expect(retryArtifact?.summary.channelsAlreadyDelivered).toBe(3);
    expect(retryArtifact?.summary.channelsDelivered).toBe(0);
    await expect(h.control.pauseJob(DELIVER_ID)).rejects.toThrow(/pausable|can pause/i);
  });
});
