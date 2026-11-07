/**
 * Issue #3535 — the Data Providers surface's pipeline feed-jobs routes.
 *
 * The provider view gains a `feedJobs` array (every feed job for the
 * provider as a merged surface view from the pipeline host), plus:
 * - GET  /data-providers/:id/feed-jobs — the provider's feed jobs;
 * - POST /data-providers/:id/feed-jobs/:jobId/:action — run / pause /
 *   resume / cancel / retry through the pipeline host door (NOT a
 *   second engine entry), session-gated like every mutation here,
 *   audited, with the control plane's refusals surfaced as 409.
 *
 * The door is injected through the route context (fake here, built
 * over the in-memory harness); the dataset/index stores are the
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
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  buildFeedJobRegistry,
  YAHOO_NASDAQ100_QUOTES_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
  type FeedJobSurfaceView,
} from "../src/services/feedPipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-06T12:00:00.000Z");

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
  const universeStore = new InMemoryIndexListStore();
  await universeStore.store({
    index: "nasdaq100",
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
  const registry = buildFeedJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    steps: createFeedStepRegistry({
      registry,
      providerFor: (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined),
      universeStore,
      datasetStore,
    }),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  const door: FeedPipelineDoorLike = {
    listFeedJobSurfaceStatuses: async () =>
      Promise.all(
        FEED_PIPELINE_CATALOG.map(async (entry) =>
          buildFeedJobSurfaceView({
            entry,
            datasetStore,
            registry,
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
        registry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: T0,
      });
    },
    runPipelineJob: async (jobId: string) => {
      const dispatch = await control.runJob(jobId, { trigger: "manual" });
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) => {
      const dispatch = await control.resumeJob(jobId, { trigger: "manual" });
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) => {
      const dispatch = await control.retryJob(jobId, { trigger: "manual" });
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
  };
  return { door, datasetStore };
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
  return { ctx, auditRows };
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

describe("pipeline feed-jobs routes (#3535)", () => {
  it("GET /data-providers/:id/feed-jobs returns only that provider's jobs", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/yahoo/feed-jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: FeedJobSurfaceView[] };
    expect(body.jobs.map((j) => j.jobId)).toEqual([
      "yahoo-nasdaq100-quotes",
      "yahoo-nasdaq100-fundamentals",
      "yahoo-sp100-quotes",
    ]);
    const alpaca = await callRoute(ctx, "GET", "/data-providers/alpaca/feed-jobs");
    const alpacaBody = (await alpaca.json()) as { jobs: FeedJobSurfaceView[] };
    expect(alpacaBody.jobs.map((j) => j.jobId)).toEqual(["alpaca-nasdaq100-quotes"]);
  });

  it("the provider list view carries the feedJobs array", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(Array.isArray(yahoo.feedJobs)).toBe(true);
    expect(yahoo.feedJobs).toHaveLength(3);
    expect(yahoo.feedJobs[0]).toMatchObject({ jobId: YAHOO_NASDAQ100_QUOTES_JOB_ID, feed: { state: "never-run" } });
  });

  it("POST run dispatches through the door with the session login and audits", async () => {
    const { ctx, auditRows } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/feed-jobs/${YAHOO_NASDAQ100_QUOTES_JOB_ID}/run`,
      {},
    );
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`run failed: ${JSON.stringify(body)}`);
    expect(body.result.state, JSON.stringify(body.result)).toBe("completed");
    expect(body.status.feed.state).toBe("ready");
    expect(body.status.feed.snapshot.rowsPersisted).toBe(2);
    expect(
      auditRows.some(
        (r) => r.type === "data_provider.feed_job_action" && r.payload.action === "run",
      ),
    ).toBe(true);
  });

  it("POST action without a verified login is refused 401", async () => {
    const { ctx } = await makeCtx({ userLogin: "" });
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/feed-jobs/${YAHOO_NASDAQ100_QUOTES_JOB_ID}/run`,
      {},
    );
    expect(res.status).toBe(401);
  });

  it("POST a job that belongs to another provider is a typed 404", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      "/data-providers/alpaca/feed-jobs/yahoo-nasdaq100-quotes/run",
      {},
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_FOUND");
  });

  it("a control-plane refusal (pause an idle job) surfaces as 409", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/feed-jobs/${YAHOO_NASDAQ100_QUOTES_JOB_ID}/pause`,
      {},
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_ACTION_REFUSED");
  });

  it("door unbound: GET still answers (empty jobs), POST refuses by name", async () => {
    const { ctx } = await makeCtx({ feedPipelineDoor: null });
    const get = await callRoute(ctx, "GET", "/data-providers/yahoo/feed-jobs");
    expect(get.status).toBe(200);
    expect(((await get.json()) as any).jobs).toEqual([]);
    const post = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/feed-jobs/${YAHOO_NASDAQ100_QUOTES_JOB_ID}/run`,
      {},
    );
    expect(post.status).toBe(500);
    expect(((await post.json()) as any).code).toBe("FEED_JOB_NOT_CONFIGURED");
  });
});
