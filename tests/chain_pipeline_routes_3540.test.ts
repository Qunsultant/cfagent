// @vitest-environment node
/**
 * Issue #3540 — the Data Providers surface's pipeline-chain routes.
 *
 * The provider view gains a `pipelineChains` array (every
 * composed chain for the provider as an end-to-end roll-up
 * view from the pipeline host), plus:
 * - GET  /data-providers/:id/pipeline-chains — the provider's chains;
 * - POST /data-providers/:id/pipeline-chains/:jobId/:action —
 *   run / pause / resume / cancel / retry a chain, or
 *   stage_pause / stage_resume / stage_cancel one of its stages
 *   (the stage names itself in the JSON body), through the
 *   pipeline host door (NOT a second engine entry),
 *   session-gated like every mutation here, audited, with the
 *   control plane's refusals surfaced as 409 — the
 *   deliver_pipeline_routes_3539 shape, transposed to the
 *   composition.
 *
 * The door is injected through the route context (fake here,
 * built over the in-memory harness, mirroring the host RPC
 * shapes including the chain refresh); the dataset stores are
 * the in-memory adapters. No live network.
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
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
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
} from "../src/services/generatePipelineJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  DELIVER_PIPELINE_CATALOG,
  buildDeliverJobSurfaceView,
  ensureDeliverPipelineJobs,
} from "../src/services/deliverPipelineJobs";
import {
  buildPipelineChainRegistry,
  chainStageNodePath,
  PIPELINE_CHAIN_STAGE_ORDER,
} from "../src/services/pipelineChains";
import {
  CHAIN_PIPELINE_CATALOG,
  buildChainSurfaceView,
  ensureChainPipelineJobs,
  refreshChainDefinitionFromStoredStages,
  type PipelineChainSurfaceView,
} from "../src/services/chainPipelineJobs";
import type { DataProvider, DataResult, NewsResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const FEED_ID = "yahoo-nasdaq100-quotes";
const CHAIN_ID = `${FEED_ID}-pipeline`;

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
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  for (const index of ["nasdaq100", "sp100"] as const) {
    await universeStore.store({
      index,
      snapshotDate: "2026-11-02",
      symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      source: "manual",
      sourceLabel: "Test seed",
      derivedFromHoldings: false,
    });
  }
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quote(s)),
      }) as DataResult<QuoteResult[]>,
    getFundamentals: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "fundamentals",
        result: { symbol, marketCap: 1_000_000, peTrailing: 25 } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
    // #3931: the technicals node pulls daily bars through the
    // historicalBars capability — 30 live bars, closes 100..129.
    getHistoricalBars: async (symbol: string) => {
      const bars: MarketDataResearchHistoricalBar[] = [];
      for (let i = 0; i < 30; i++) {
        const close = 100 + i;
        bars.push({
          provenance: "live",
          timestamp: new Date(T0 - (30 - 1 - i) * 24 * 3600_000).toISOString(),
          open: close - 0.5,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1_000_000,
        });
      }
      return {
        providerId: "yahoo",
        capability: "historicalBars",
        result: bars,
      } as DataResult<MarketDataResearchHistoricalBar[]>;
    },
    // #3932: the sentiment node pulls headlines through the
    // news capability — one fixture headline per symbol. No AI
    // binding in this harness, so the rows persist unclassified
    // (method "unavailable") and the job still completes.
    getNews: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "news",
        result: [
          {
            headline: `${symbol} reports quarterly results`,
            source: "Yahoo Finance",
            publishedAt: new Date(T0).toISOString(),
            symbol,
          },
        ],
      }) as DataResult<NewsResult>,
  };
  const feedRegistry = buildFeedJobRegistry({});
  const enrichRegistry = buildEnrichJobRegistry({});
  const analyzeRegistry = buildAnalyzeJobRegistry({});
  const generateRegistry = buildGenerateJobRegistry({});
  const deliverRegistry = buildDeliverJobRegistry({});
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
      {
        registry: deliverRegistry,
        generatedStore,
        deliveryStore,
        senders: {
          slack: async () => ({ ok: true }),
          email: async () => ({ ok: true }),
          webhook: async () => ({ ok: true, target: "hooks.example.com" }),
        },
      },
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  await ensureChainPipelineJobs(control, stores, {});
  const chainRegistry = buildPipelineChainRegistry({});
  const settle = async (jobId: string, dispatch: { runId: string; state: string; completion?: Promise<{ state: string; error?: string }> }) => {
    if (!dispatch.completion) return { jobId, runId: dispatch.runId, state: dispatch.state };
    const outcome = await dispatch.completion;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  const refresh = async (jobId: string) => {
    const chain = chainRegistry.forId(jobId);
    if (!chain) throw new Error(`PIPELINE_CHAIN_NOT_FOUND: no pipeline chain with id "${jobId}".`);
    await refreshChainDefinitionFromStoredStages(control, stores, chain);
  };
  const stageNodePath = (jobId: string, stage: string) => {
    const chain = chainRegistry.forId(jobId);
    if (!chain) throw new Error(`PIPELINE_CHAIN_NOT_FOUND: no pipeline chain with id "${jobId}".`);
    if (!(PIPELINE_CHAIN_STAGE_ORDER as readonly string[]).includes(stage)) {
      throw new Error(`PIPELINE_CHAIN_STAGE_UNKNOWN: chain "${jobId}" has no stage "${stage}".`);
    }
    return chainStageNodePath(chain, stage as (typeof PIPELINE_CHAIN_STAGE_ORDER)[number]);
  };
  const chainSurface = async (jobId: string): Promise<PipelineChainSurfaceView> => {
    const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    const chain = chainRegistry.forId(jobId)!;
    await refresh(jobId);
    const stagePipelines: Record<string, Awaited<ReturnType<JobPipelineControl["getJob"]>>> = {};
    for (const node of chain.nodes) {
      stagePipelines[node.jobId] = await control.getJob(node.jobId);
    }
    return buildChainSurfaceView({
      entry,
      chain,
      pipeline: await control.getJob(jobId).catch(() => null),
      stagePipelines,
      nowMs: Date.now(),
    });
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
    listDeliverJobSurfaceStatuses: async () =>
      Promise.all(
        DELIVER_PIPELINE_CATALOG.map(async (entry) =>
          buildDeliverJobSurfaceView({
            entry,
            deliveryStore,
            registry: deliverRegistry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: Date.now(),
          }),
        ),
      ),
    getDeliverJobSurfaceStatus: async (jobId: string) => {
      const entry = DELIVER_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildDeliverJobSurfaceView({
        entry,
        deliveryStore,
        registry: deliverRegistry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: Date.now(),
      });
    },
    listPipelineChainSurfaceStatuses: async () =>
      Promise.all(CHAIN_PIPELINE_CATALOG.map((e) => chainSurface(e.jobId))),
    getPipelineChainSurfaceStatus: chainSurface,
    runPipelineChain: async (jobId: string) => {
      await refresh(jobId);
      return settle(jobId, await control.runJob(jobId, { trigger: "manual" }));
    },
    resumePipelineChain: async (jobId: string) => {
      await refresh(jobId);
      return settle(jobId, await control.resumeJob(jobId));
    },
    retryPipelineChain: async (jobId: string) => {
      await refresh(jobId);
      return settle(jobId, await control.retryJob(jobId));
    },
    stopPipelineChainStage: async (jobId: string, stage: string) =>
      control.stopStage(jobId, stageNodePath(jobId, stage)),
    resumePipelineChainStage: async (jobId: string, stage: string) =>
      settle(jobId, await control.resumeStage(jobId, stageNodePath(jobId, stage))),
    cancelPipelineChainStage: async (jobId: string, stage: string) =>
      control.cancelStage(jobId, stageNodePath(jobId, stage)),
    runPipelineJob: async (jobId: string) =>
      settle(jobId, await control.runJob(jobId, { trigger: "manual" })),
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) =>
      settle(jobId, await control.resumeJob(jobId)),
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) =>
      settle(jobId, await control.retryJob(jobId)),
  };
  return { door, control, deliveryStore };
}

async function makeCtx(overrides?: Partial<DataProviderRoutesContext>) {
  const { door, control, deliveryStore } = await makeHarness();
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
  return { ctx, auditRows, door, control, deliveryStore };
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

describe("pipeline-chain routes (#3540)", () => {
  it("GET /data-providers/:id/pipeline-chains returns only that provider's chains", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/yahoo/pipeline-chains");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: PipelineChainSurfaceView[] };
    expect(body.jobs.map((j) => j.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-pipeline",
      "yahoo-sp100-quotes-pipeline",
      "yahoo-sp500-quotes-pipeline",
      "yahoo-dow-quotes-pipeline",
      "yahoo-sp400-quotes-pipeline",
      "yahoo-sector-energy-quotes-pipeline",
      "yahoo-sector-materials-quotes-pipeline",
      "yahoo-sector-industrials-quotes-pipeline",
      "yahoo-sector-consumer-discretionary-quotes-pipeline",
    ]);
    expect(body.jobs[0].frontier).toBe("feed");
    expect(body.jobs[0].stages).toHaveLength(5);
    const alpaca = await callRoute(ctx, "GET", "/data-providers/alpaca/pipeline-chains");
    const alpacaBody = (await alpaca.json()) as { jobs: PipelineChainSurfaceView[] };
    expect(alpacaBody.jobs.map((j) => j.jobId)).toEqual(["alpaca-nasdaq100-quotes-pipeline"]);
  });

  it("the provider list view carries the pipelineChains array", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.pipelineChains.map((j: any) => j.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-pipeline",
      "yahoo-sp100-quotes-pipeline",
      "yahoo-sp500-quotes-pipeline",
      "yahoo-dow-quotes-pipeline",
      "yahoo-sp400-quotes-pipeline",
      "yahoo-sector-energy-quotes-pipeline",
      "yahoo-sector-materials-quotes-pipeline",
      "yahoo-sector-industrials-quotes-pipeline",
      "yahoo-sector-consumer-discretionary-quotes-pipeline",
    ]);
  });

  it("POST run executes the chain end-to-end and audits the action", async () => {
    const { ctx, auditRows } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/run`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jobId).toBe(CHAIN_ID);
    expect(body.action).toBe("run");
    expect(body.result.state).toBe("completed");
    expect(body.status.frontier).toBeNull();
    expect(body.status.stages.map((s: any) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(
      auditRows.some(
        (r) =>
          r.type === "data_provider.pipeline_chain_action" &&
          r.payload.jobId === CHAIN_ID &&
          r.payload.action === "run" &&
          r.payload.actor === ACTOR,
      ),
    ).toBe(true);
  });

  it("POST stage actions require a stage in the body and surface control-plane refusals as 409", async () => {
    const { ctx } = await makeCtx();
    const noStage = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/stage_cancel`,
    );
    expect(noStage.status).toBe(400);
    expect(((await noStage.json()) as any).code).toBe("PIPELINE_CHAIN_STAGE_REQUIRED");

    await callRoute(ctx, "POST", `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/run`);
    const refused = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/stage_cancel`,
      { stage: "deliver" },
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).code).toBe("PIPELINE_CHAIN_ACTION_REFUSED");

    const unknownStage = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/stage_cancel`,
      { stage: "publish" },
    );
    expect(unknownStage.status).toBe(409);
    expect(((await unknownStage.json()) as any).error).toContain("PIPELINE_CHAIN_STAGE_UNKNOWN");
  });

  it("POST refuses unknown chains, cross-provider chains, unknown actions, and anonymous callers", async () => {
    const { ctx } = await makeCtx();
    const unknown = await callRoute(
      ctx,
      "POST",
      "/data-providers/yahoo/pipeline-chains/nope-pipeline/run",
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).code).toBe("PIPELINE_CHAIN_NOT_FOUND");
    const cross = await callRoute(
      ctx,
      "POST",
      "/data-providers/yahoo/pipeline-chains/alpaca-nasdaq100-quotes-pipeline/run",
    );
    expect(cross.status).toBe(404);
    const badAction = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/explode`,
    );
    expect(badAction.status).toBe(404);
    const anon = await makeCtx({ userLogin: "" });
    const refused = await callRoute(
      anon.ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/run`,
    );
    expect(refused.status).toBe(401);
  });

  it("an unbound pipeline host reads empty and refuses actions by name", async () => {
    const { ctx } = await makeCtx({ feedPipelineDoor: null });
    const res = await callRoute(ctx, "GET", "/data-providers/yahoo/pipeline-chains");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).jobs).toEqual([]);
    const action = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/pipeline-chains/${CHAIN_ID}/run`,
    );
    expect(action.status).toBe(500);
    expect(((await action.json()) as any).code).toBe("PIPELINE_CHAIN_NOT_CONFIGURED");
  });
});
