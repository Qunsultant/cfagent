// @vitest-environment node
/**
 * Issue #3538 — the Data Providers surface's pipeline generate-jobs routes.
 *
 * The provider view gains a `generateJobs` array (every generate
 * job for the provider as a merged surface view from the pipeline
 * host), plus:
 * - GET  /data-providers/:id/generate-jobs — the provider's generate jobs;
 * - POST /data-providers/:id/generate-jobs/:jobId/:action — run /
 *   pause / resume / cancel / retry through the pipeline host
 *   door (NOT a second engine entry), session-gated like every
 *   mutation here, audited, with the control plane's refusals
 *   surfaced as 409 — the analyze_pipeline_routes_3537 shape, one
 *   stage later.
 *
 * The door is injected through the route context (fake here,
 * built over the in-memory harness); the dataset stores are the
 * in-memory adapters. No live network.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
  type FeedPipelineDoorLike,
} from "../src/agents/routes/dataProviders";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
} from "../src/services/feedPipelineJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import {
  ENRICH_PIPELINE_CATALOG,
  buildEnrichJobSurfaceView,
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
} from "../src/services/enrichPipelineJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import {
  ANALYZE_PIPELINE_CATALOG,
  buildAnalyzeJobSurfaceView,
  ensureAnalyzePipelineJobs,
} from "../src/services/analyzePipelineJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import {
  GENERATE_PIPELINE_CATALOG,
  buildGenerateJobSurfaceView,
  ensureGeneratePipelineJobs,
  type GenerateJobSurfaceView,
} from "../src/services/generatePipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const GENERATE_ID = `${ANALYZE_ID}-generate`;

function quote(symbol: string): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price: 100,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: new Date(T0).toISOString(),
  } as MarketDataResearchQuote;
}

async function makeHarness() {
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  await universeStore.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "manual",
    sourceLabel: "Test seed",
    derivedFromHoldings: false,
  });
  await universeStore.store({
    index: "sp100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "manual",
    sourceLabel: "Test seed",
    derivedFromHoldings: false,
  });
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quote(s)),
      }) as DataResult<QuoteResult[]>,
  };
  const feedRegistry = buildFeedJobRegistry({});
  const enrichRegistry = buildEnrichJobRegistry({});
  const analyzeRegistry = buildAnalyzeJobRegistry({});
  const generateRegistry = buildGenerateJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    steps: createPipelineStepRegistry(
      {
        registry: feedRegistry,
        providerFor: (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined),
        universeStore,
        datasetStore,
      },
      { registry: enrichRegistry, datasetStore, enrichedStore },
      { registry: analyzeRegistry, enrichedStore, analyzedStore },
      {
        registry: generateRegistry,
        analyzedStore,
        generatedStore,
        canonicalReportStore: null,
      },
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  const settle = async (jobId: string, dispatch: { runId: string; completion?: Promise<{ state: string; error?: string }> }) => {
    const outcome = await dispatch.completion;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  const door: FeedPipelineDoorLike = {
    listFeedJobSurfaceStatuses: async () =>
      Promise.all(
        FEED_PIPELINE_CATALOG.map(async (entry) =>
          buildFeedJobSurfaceView({
            entry,
            datasetStore,
            registry: feedRegistry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: T0,
          }),
        ),
      ),
    getFeedJobSurfaceStatus: async (jobId: string) => {
      const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildFeedJobSurfaceView({
        entry,
        datasetStore,
        registry: feedRegistry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: T0,
      });
    },
    listEnrichJobSurfaceStatuses: async () =>
      Promise.all(
        ENRICH_PIPELINE_CATALOG.map(async (entry) =>
          buildEnrichJobSurfaceView({
            entry,
            enrichedStore,
            registry: enrichRegistry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: Date.now(),
          }),
        ),
      ),
    getEnrichJobSurfaceStatus: async (jobId: string) => {
      const entry = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildEnrichJobSurfaceView({
        entry,
        enrichedStore,
        registry: enrichRegistry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: Date.now(),
      });
    },
    listAnalyzeJobSurfaceStatuses: async () =>
      Promise.all(
        ANALYZE_PIPELINE_CATALOG.map(async (entry) =>
          buildAnalyzeJobSurfaceView({
            entry,
            analyzedStore,
            registry: analyzeRegistry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: Date.now(),
          }),
        ),
      ),
    getAnalyzeJobSurfaceStatus: async (jobId: string) => {
      const entry = ANALYZE_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildAnalyzeJobSurfaceView({
        entry,
        analyzedStore,
        registry: analyzeRegistry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: Date.now(),
      });
    },
    listGenerateJobSurfaceStatuses: async () =>
      Promise.all(
        GENERATE_PIPELINE_CATALOG.map(async (entry) =>
          buildGenerateJobSurfaceView({
            entry,
            generatedStore,
            registry: generateRegistry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: Date.now(),
          }),
        ),
      ),
    getGenerateJobSurfaceStatus: async (jobId: string) => {
      const entry = GENERATE_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildGenerateJobSurfaceView({
        entry,
        generatedStore,
        registry: generateRegistry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: Date.now(),
      });
    },
    runPipelineJob: async (jobId: string) =>
      settle(jobId, await control.runJob(jobId, { trigger: "manual" })),
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) =>
      settle(jobId, await control.resumeJob(jobId, { trigger: "manual" })),
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) =>
      settle(jobId, await control.retryJob(jobId, { trigger: "manual" })),
  };
  return { door, datasetStore, enrichedStore, analyzedStore, generatedStore };
}

async function makeCtx(overrides?: Partial<DataProviderRoutesContext>) {
  const { door } = await makeHarness();
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  const auditRows: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: ACTOR,
    recordAudit: (type, _agent, payload) => {
      auditRows.push({ type, payload });
      return { id: "audit-1" };
    },
    feedPipelineDoor: door,
    ...overrides,
  };
  return { ctx, auditRows, door };
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleDataProviderRoutes(request, url, url.pathname, "session-1", ctx) as Promise<Response>;
}

describe("pipeline generate-jobs routes (#3538)", () => {
  it("GET /data-providers/:id/generate-jobs returns only that provider's jobs", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/yahoo/generate-jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: GenerateJobSurfaceView[] };
    expect(body.jobs.map((j) => j.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
      "yahoo-sp100-quotes-enrich-analyze-generate",
      "yahoo-sp500-quotes-enrich-analyze-generate",
      "yahoo-dow-quotes-enrich-analyze-generate",
      "yahoo-sp400-quotes-enrich-analyze-generate",
      "yahoo-sector-energy-quotes-enrich-analyze-generate",
      "yahoo-sector-materials-quotes-enrich-analyze-generate",
      "yahoo-sector-industrials-quotes-enrich-analyze-generate",
      "yahoo-sector-consumer-discretionary-quotes-enrich-analyze-generate",
      "yahoo-sector-consumer-staples-quotes-enrich-analyze-generate",
      "yahoo-sector-health-care-quotes-enrich-analyze-generate",
      "yahoo-sector-financials-quotes-enrich-analyze-generate",
      "yahoo-sector-information-technology-quotes-enrich-analyze-generate",
      "yahoo-sector-communication-services-quotes-enrich-analyze-generate",
      "yahoo-sector-utilities-quotes-enrich-analyze-generate",
      "yahoo-sector-real-estate-quotes-enrich-analyze-generate",
    ]);
    const alpaca = await callRoute(ctx, "GET", "/data-providers/alpaca/generate-jobs");
    const alpacaBody = (await alpaca.json()) as { jobs: GenerateJobSurfaceView[] };
    expect(alpacaBody.jobs.map((j) => j.jobId)).toEqual(["alpaca-nasdaq100-quotes-enrich-analyze-generate"]);
  });

  it("the provider list view carries the generateJobs array", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(Array.isArray(yahoo.generateJobs)).toBe(true);
    expect(yahoo.generateJobs).toHaveLength(16);
    expect(yahoo.generateJobs[0]).toMatchObject({ jobId: GENERATE_ID, generate: { state: "never-run" } });
  });

  it("POST run generates from the persisted analyzed copy through the door and audits", async () => {
    const { ctx, auditRows, door } = await makeCtx();
    // The chain's persisted copies are the generate run's input.
    await door.runPipelineJob("yahoo-nasdaq100-quotes");
    await door.runPipelineJob(ENRICH_ID);
    await door.runPipelineJob(ANALYZE_ID);
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/generate-jobs/${GENERATE_ID}/run`,
      {},
    );
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`run failed: ${JSON.stringify(body)}`);
    expect(body.result.state, JSON.stringify(body.result)).toBe("completed");
    expect(body.status.generate.state).toBe("ready");
    expect(body.status.generate.snapshot.reportsPersisted).toBe(1);
    expect(body.status.generate.snapshot.formatsPersisted).toBe(4);
    expect(body.status.generate.snapshot.reports[0].canonicalStatus).toBe("not_wired");
    expect(body.status.generate.snapshot.inputRunId).toBeTruthy();
    expect(
      auditRows.some(
        (r) => r.type === "data_provider.generate_job_action" && r.payload.action === "run",
      ),
    ).toBe(true);
  });

  it("POST run with no persisted analyzed copy surfaces the coded refusal state", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/generate-jobs/${GENERATE_ID}/run`,
      {},
    );
    const body = (await res.json()) as any;
    expect(body.result.state).toBe("failed");
    expect(body.result.error).toContain("GENERATE_INPUT_MISSING");
    expect(body.status.generate.snapshot).toBeNull();
  });

  it("POST action without a verified login is refused 401", async () => {
    const { ctx } = await makeCtx({ userLogin: "" });
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/generate-jobs/${GENERATE_ID}/run`,
      {},
    );
    expect(res.status).toBe(401);
  });

  it("POST a job that belongs to another provider is a typed 404", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/alpaca/generate-jobs/${GENERATE_ID}/run`,
      {},
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("GENERATE_JOB_NOT_FOUND");
  });

  it("a control-plane refusal (pause an idle job) surfaces as 409", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/generate-jobs/${GENERATE_ID}/pause`,
      {},
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("GENERATE_JOB_ACTION_REFUSED");
  });

  it("door unbound: GET still answers (empty jobs), POST refuses by name", async () => {
    const { ctx } = await makeCtx({ feedPipelineDoor: null });
    const get = await callRoute(ctx, "GET", "/data-providers/yahoo/generate-jobs");
    expect(get.status).toBe(200);
    expect(((await get.json()) as any).jobs).toEqual([]);
    const post = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/generate-jobs/${GENERATE_ID}/run`,
      {},
    );
    expect(post.status).toBe(500);
    const body = (await post.json()) as any;
    expect(body.code).toBe("GENERATE_JOB_NOT_CONFIGURED");
  });
});
