// @vitest-environment node
/**
 * Issue #3536 (Pipeline J3) — the enrich jobs on the J1 pipeline:
 *
 * - Catalog + name resolution: one enrich job per quotes feed
 *   job; ambiguous/unknown names refuse (null).
 * - Definitions: valid J1 definitions by configuration alone —
 *   enrich kind, the enrich.apply step carrying the rules
 *   (elements + join sources) as params, an enabled schedule.
 * - The chain: a feed run persists its dataset; the enrich run
 *   consumes THAT artifact (lineage: the enriched artifact names
 *   the feed run), persists under the PIPELINE run id, records
 *   through the JobRunRecordStore machinery (system
 *   "job-pipeline"), publishes job.completed, and surfaces in
 *   the merged status view.
 * - Configuration is live: a configureJob patch changing the
 *   elements changes the next run's output (AOP, not code).
 * - Modes: sharded enrich partitions the persisted input.
 * - Management: retry operates through the same control plane.
 * - Refusals: no persisted input fails the run with
 *   ENRICH_INPUT_MISSING (and the enriched store records the
 *   same failure); an unwired store refuses
 *   ENRICH_JOB_NOT_CONFIGURED.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
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
import {
  buildFeedJobRegistry as buildFeedRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import {
  ENRICH_APPLY_STEP,
  ENRICH_PIPELINE_CATALOG,
  buildAllEnrichPipelineJobDefinitions,
  buildEnrichJobSurfaceView,
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
  resolveEnrichJob,
  type EnrichStepDeps,
} from "../src/services/enrichPipelineJobs";
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
  events: string[];
}

async function makeHarness(opts: { enrichedStore?: InMemoryEnrichedDatasetStore | null } = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore =
    opts.enrichedStore === undefined ? new InMemoryEnrichedDatasetStore() : opts.enrichedStore;
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
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(feedDeps, enrichDeps),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  return {
    control,
    stores,
    runStore,
    datasetStore,
    enrichedStore: enrichedStore as InMemoryEnrichedDatasetStore,
    events,
  };
}

async function runFeed(h: Harness, jobId = "yahoo-nasdaq100-quotes") {
  const dispatch = await h.control.runJob(jobId);
  const outcome = await dispatch.completion!;
  expect(outcome.state).toBe("completed");
  return dispatch;
}

describe("enrich pipeline catalog + resolution (#3536)", () => {
  it("carries one enrich job per quotes feed job", () => {
    expect(ENRICH_PIPELINE_CATALOG.map((e) => e.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-enrich",
      "yahoo-sp100-quotes-enrich",
      "yahoo-sp500-quotes-enrich",
      "yahoo-dow-quotes-enrich",
      "yahoo-sp400-quotes-enrich",
      "yahoo-sector-energy-quotes-enrich",
      "yahoo-sector-materials-quotes-enrich",
      "yahoo-sector-industrials-quotes-enrich",
      "yahoo-sector-consumer-discretionary-quotes-enrich",
      "yahoo-sector-consumer-staples-quotes-enrich",
      "yahoo-sector-health-care-quotes-enrich",
      "yahoo-sector-financials-quotes-enrich",
      "yahoo-sector-information-technology-quotes-enrich",
      "yahoo-sector-communication-services-quotes-enrich",
      "yahoo-sector-utilities-quotes-enrich",
      "yahoo-sector-real-estate-quotes-enrich",
      "alpaca-nasdaq100-quotes-enrich",
      "etrade-nasdaq100-quotes-enrich",
      "public-nasdaq100-quotes-enrich",
    ]);
    expect(resolveEnrichJob("yahoo nasdaq100 enrich")?.jobId).toBe(ENRICH_ID);
    expect(resolveEnrichJob("sp100 enrich")?.jobId).toBe("yahoo-sp100-quotes-enrich");
    expect(resolveEnrichJob("enrich alpaca")?.jobId).toBe("alpaca-nasdaq100-quotes-enrich");
    expect(resolveEnrichJob(ENRICH_ID)?.jobId).toBe(ENRICH_ID);
    // The bare source name inherits the FEED catalog's own
    // resolution ("yahoo" is the Nasdaq-100 quotes job's exact
    // alias there — unique, so no guess is involved).
    expect(resolveEnrichJob("yahoo enrich")?.jobId).toBe(ENRICH_ID);
    expect(resolveEnrichJob("enrich")).toBeNull(); // ambiguous — refuses
    expect(resolveEnrichJob("enrich nasdaq")).toBeNull(); // ambiguous — refuses
    expect(resolveEnrichJob("enrich bitcoin")).toBeNull(); // unknown — refuses
  });

  it("every catalog definition resolves as a valid J1 job definition", () => {
    const raws = buildAllEnrichPipelineJobDefinitions({});
    expect(raws).toHaveLength(19);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("enrich");
      expect(resolved.root.steps[0]?.step).toBe(ENRICH_APPLY_STEP);
      expect(resolved.config.schedule.enabled).toBe(true);
      const params = resolved.root.steps[0]?.params as {
        elements?: string[];
        enrichFrom?: unknown[];
      };
      expect(params.elements?.length).toBeGreaterThan(0);
    }
    const yahoo = resolveJobDefinition(
      buildAllEnrichPipelineJobDefinitions({}).find(
        (r) => (r as { jobId: string }).jobId === ENRICH_ID,
      ),
    );
    const yahooParams = yahoo.root.steps[0]?.params as {
      enrichFrom?: Array<{ feedJobId: string }>;
    };
    expect(yahooParams.enrichFrom?.[0]?.feedJobId).toBe("yahoo-nasdaq100-fundamentals");
  });

  it("registerSchedules registers feed + enrich jobs (the full plane)", async () => {
    const h = await makeHarness();
    const specs: Array<{ jobId: string }> = [];
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    });
    // #4065 pin update: three options-chains jobs join the plane.
    expect(registrations).toHaveLength(45);
    expect(specs.map((s) => s.jobId)).toContain(ENRICH_ID);
  });
});

describe("the feed → enrich chain on the plane (#3536)", () => {
  it("enrich consumes the persisted feed artifact and persists its own, one run one id", async () => {
    const h = await makeHarness();
    const feedDispatch = await runFeed(h);
    // The fundamentals join source runs too (the yahoo enrich joins it).
    await runFeed(h, "yahoo-nasdaq100-fundamentals");
    const dispatch = await h.control.runJob(ENRICH_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    const artifact = await h.enrichedStore.latestUsable(ENRICH_ID);
    expect(artifact).toBeDefined();
    // One run, one id: the artifact carries the PIPELINE run id.
    expect(artifact?.run.runId).toBe(dispatch.runId);
    // Lineage: the artifact names the feed run it derives from.
    expect(artifact?.inputRunId).toBe(feedDispatch.runId);
    expect(artifact?.rows).toHaveLength(SYMBOLS.length);
    const aapl = artifact?.rows.find((r) => r.symbol === "AAPL");
    expect(aapl?.features.momentum).toBe(1);
    expect(aapl?.features.peTrailing).toBe(25); // the fundamentals join
    // Run records + events: the run is on the platform machinery.
    const record = h.runStore.listByJob(ENRICH_ID)[0];
    expect(record?.system).toBe("job-pipeline");
    expect(record?.outcome).toBe("success");
    expect(h.events).toContain("job.completed");

    const view = await buildEnrichJobSurfaceView({
      entry: resolveEnrichJob("yahoo nasdaq100 enrich")!,
      enrichedStore: h.enrichedStore,
      registry: buildEnrichJobRegistry({}),
      pipeline: await h.control.getJob(ENRICH_ID),
      nowMs: Date.now(),
    });
    expect(view.enrich?.snapshot?.rowsPersisted).toBe(SYMBOLS.length);
    expect(view.enrich?.snapshot?.inputRunId).toBe(feedDispatch.runId);
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.nextScheduledRun).not.toBeNull();
  });

  it("a configureJob patch changes the elements the next run computes", async () => {
    const h = await makeHarness();
    await runFeed(h);
    await h.control.configureJob(ENRICH_ID, {
      root: {
        steps: [
          {
            step: ENRICH_APPLY_STEP,
            params: { enrichJobId: ENRICH_ID, elements: ["momentum"], enrichFrom: [] },
          },
        ],
      },
    });
    const dispatch = await h.control.runJob(ENRICH_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const artifact = await h.enrichedStore.latestUsable(ENRICH_ID);
    expect(artifact?.elements).toEqual(["momentum"]);
    expect(Object.keys(artifact?.rows[0]?.features ?? {})).toEqual(["momentum"]);
  });
});

describe("enrich refusals on the plane (#3536)", () => {
  it("no persisted input: the run fails ENRICH_INPUT_MISSING and both records agree", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(ENRICH_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("ENRICH_INPUT_MISSING");
    expect(h.runStore.listByJob(ENRICH_ID)[0]?.outcome).toBe("failure");
    const recorded = await h.enrichedStore.latest(ENRICH_ID);
    expect(recorded?.run.codedError).toBe("ENRICH_INPUT_MISSING");
    expect(await h.enrichedStore.latestUsable(ENRICH_ID)).toBeUndefined();
  });

  it("an unwired enriched store refuses ENRICH_JOB_NOT_CONFIGURED", async () => {
    const h = await makeHarness({ enrichedStore: null });
    await runFeed(h);
    const dispatch = await h.control.runJob(ENRICH_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("ENRICH_JOB_NOT_CONFIGURED");
  });
});

describe("enrich modes + management (#3536)", () => {
  it("sharded mode partitions the persisted input across units", async () => {
    const h = await makeHarness();
    await runFeed(h);
    await h.control.configureJob(ENRICH_ID, {
      root: {
        executionMode: { shape: "sharded", concurrency: "parallel" },
        processing: { shards: ["s0", "s1"] },
      },
    });
    const dispatch = await h.control.runJob(ENRICH_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const runs = await h.enrichedStore.listRuns(ENRICH_ID, 10);
    const rowSets = runs.map((a) => a.rows.map((r) => r.symbol).sort());
    expect(rowSets).toHaveLength(2);
    expect(rowSets.flat().sort()).toEqual([...SYMBOLS].sort());
    expect(rowSets[0]).not.toEqual(rowSets[1]);
  });

  it("retry re-runs a completed enrich job as a new run", async () => {
    const h = await makeHarness();
    await runFeed(h);
    const first = await h.control.runJob(ENRICH_ID);
    await first.completion!;
    const retried = await h.control.retryJob(ENRICH_ID);
    const outcome = await retried.completion!;
    expect(outcome.state).toBe("completed");
    expect(retried.runId).not.toBe(first.runId);
    expect(h.runStore.listByJob(ENRICH_ID)).toHaveLength(2);
    await expect(h.control.pauseJob(ENRICH_ID)).rejects.toThrow(/pausable|can pause/i);
  });
});
