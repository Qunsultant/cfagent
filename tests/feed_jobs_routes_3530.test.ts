/**
 * Issue #3530 (one-of-everything, S1) — feed-job route pins. TDD Red first.
 *
 * The data-providers surface gains, per provider with a registered
 * feed job:
 * - a `feed` block on the provider view (never-run before the first
 *   run; last run + snapshot age after one; null for providers with
 *   no job — S1 registered Yahoo only; S2 adds E*TRADE + Alpaca, so
 *   the no-job pins below use nasdaq, which remains jobless — see
 *   the S2 adaptation notes on those pins);
 * - POST /data-providers/:id/feed-run — an admin run under the same
 *   session gate as every other mutation here (#1156 mechanism:
 *   no verified login → 401 before any state is read or written);
 * - GET /data-providers/:id/feed — the status + the local-copy read
 *   (the persisted snapshot served with provenance; missing is a
 *   typed state in a 200 body, never fabricated data).
 *
 * #3578 adaptation (disclosed): the feed-run route no longer runs
 * the #3530 service directly from the route's residency — it
 * dispatches the provider's feed job through the ScheduledAgent
 * pipeline door (the same control-plane dispatch as the feed-job
 * action route and the copilot tools), and the response's run view
 * is rebuilt from the run's own dataset artifact (the feed step
 * runs the #3530 service under the pipeline run id). The suite
 * therefore injects the DOOR through the route context — a fake
 * over a real JobPipelineControl + the real feed step registry
 * (the feed_pipeline_routes_3535 idiom), sharing the in-memory
 * dataset/universe stores — and the provider double is wired into
 * the STEP (the host's composition point), not the route. The
 * route-contract assertions (shapes, codes, audit) are unchanged;
 * the new pins assert the converged behavior: the response's run
 * id IS the pipeline run id, the run lands in the job's pipeline
 * history, its completion publication (the queue consumer's
 * chaining trigger) fires, and the door-side refusals map onto
 * this route's existing shapes.
 *
 * No live network: the provider, universe store, and dataset store
 * are injected (the buildVerifier idiom, moved to the door).
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
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobDispatchResult,
} from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
} from "../src/services/feedPipelineJobs";
// The grown door interface (#3536) requires the enrich surface
// reads; this suite's door implements them over an (empty)
// enriched store — the enrich routes have their own suite.
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import {
  ENRICH_PIPELINE_CATALOG,
  buildEnrichJobSurfaceView,
} from "../src/services/enrichPipelineJobs";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const YAHOO_JOB_ID = "yahoo-nasdaq100-quotes";

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

function yahooProvider(): DataProvider {
  return {
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
}

/**
 * The pipeline host, faked at the door seam over the REAL control
 * plane + feed step registry (the ScheduledAgent door's own
 * composition, transposed): a run dispatched here is a real
 * pipeline run — instance, stage ledger, run record, status
 * publications — over the same in-memory stores the route reads.
 * The door's run settles exactly as ScheduledAgent.runPipelineJob
 * settles (await the dispatch's completion when the plane returns
 * one; the dispatch state otherwise).
 */
async function makeHarness(
  providerFor: (def: FeedJobDefinition) => DataProvider | undefined,
) {
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  await universeStore.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
  });
  const registry = buildFeedJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const published: MessageEnvelope[] = [];
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: {
      publish: async (envelope: MessageEnvelope) => {
        published.push(envelope);
        return { deliveredTo: ["test-harness"], failedTo: [] };
      },
    },
    steps: createFeedStepRegistry({
      registry,
      providerFor,
      universeStore,
      datasetStore,
    }),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  const settle = async (
    jobId: string,
    dispatch: JobDispatchResult,
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> => {
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  };
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
    runPipelineJob: async (jobId: string) =>
      settle(jobId, await control.runJob(jobId, { trigger: "manual" })),
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) =>
      settle(jobId, await control.resumeJob(jobId)),
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) =>
      settle(jobId, await control.retryJob(jobId)),
    listEnrichJobSurfaceStatuses: async () =>
      Promise.all(
        ENRICH_PIPELINE_CATALOG.map(async (entry) =>
          buildEnrichJobSurfaceView({
            entry,
            enrichedStore: new InMemoryEnrichedDatasetStore(),
            registry: buildEnrichJobRegistry({}),
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: T0,
          }),
        ),
      ),
    getEnrichJobSurfaceStatus: async (jobId: string) => {
      const entry = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildEnrichJobSurfaceView({
        entry,
        enrichedStore: new InMemoryEnrichedDatasetStore(),
        registry: buildEnrichJobRegistry({}),
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: T0,
      });
    },
  };
  return { door, control, datasetStore, published };
}

async function makeCtx(
  overrides?: Partial<DataProviderRoutesContext>,
  harnessProviderFor?: (def: FeedJobDefinition) => DataProvider | undefined,
) {
  const provider = yahooProvider();
  const { door, control, datasetStore, published } = await makeHarness(
    harnessProviderFor ??
      ((def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined)),
  );
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
    feedDatasetStore: datasetStore,
    feedPipelineDoor: door,
    ...overrides,
  };
  return { ctx, datasetStore, auditRows, control, published };
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
  // Production passes url.pathname (routeRequest.ts) — the query
  // string rides on the URL, never inside `path`.
  return handleDataProviderRoutes(request, url, url.pathname, "session-1", ctx) as Promise<Response>;
}

describe("feed routes (#3530 S1)", () => {
  it("GET /data-providers carries a feed block for Yahoo (never-run) and null for providers without a job", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.feed).toMatchObject({
      jobId: "yahoo-nasdaq100-quotes",
      state: "never-run",
      lastRun: null,
      snapshot: null,
    });
    // S2 adaptation (#3530 S2, disclosed): the null exemplar was
    // etrade in S1; S2 registers an E*TRADE feed job, so etrade now
    // carries its own never-run block, and the "no job ⇒ null"
    // invariant is asserted on nasdaq, which remains jobless.
    const etrade = body.providers.find((p: any) => p.id === "etrade");
    // #3535 registered an E*TRADE feed job too, so its feed block
    // is a never-run view now, not null.
    expect(etrade.feed).toMatchObject({
      jobId: "etrade-nasdaq100-quotes",
      state: "never-run",
      lastRun: null,
      snapshot: null,
    });
    // Nasdaq registers no quotes/fundamentals job (screenUniverse
    // only) — its feed block stays null.
    const nasdaq = body.providers.find((p: any) => p.id === "nasdaq");
    expect(nasdaq.feed).toBeNull();
  });

  it("POST feed-run without a verified login is refused 401 before anything runs", async () => {
    const { ctx, datasetStore, control } = await makeCtx({ userLogin: "" });
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(401);
    expect(await datasetStore.latest("yahoo", "quotes")).toBeUndefined();
    // #3578: nothing was dispatched through the door either.
    expect((await control.getJob(YAHOO_JOB_ID)).latestRun).toBeUndefined();
  });

  it("POST feed-run runs the job, audits it, and the GET surfaces then show the run + snapshot", async () => {
    const { ctx, auditRows, control, published } = await makeCtx();
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({ status: "completed", requested: 2, received: 2, failed: 0 });
    expect(body.feed.state).toBe("ready");
    expect(body.feed.snapshot).toMatchObject({ rowsPersisted: 2 });
    expect(auditRows.some((r) => r.type === "data_provider.feed_run")).toBe(true);

    // #3578: the response's run IS the pipeline run — the same id
    // the control plane recorded, the audit row carries, and the
    // completion publication (the queue consumer's chaining
    // trigger into the enrich hand-off) names.
    const view = await control.getJob(YAHOO_JOB_ID);
    expect(view.latestRun).toMatchObject({ outcome: "success" });
    expect(view.instance?.currentRunId).toBe(body.run.runId);
    const audit = auditRows.find((r) => r.type === "data_provider.feed_run");
    expect(audit?.payload.runId).toBe(body.run.runId);
    const completion = published.find(
      (e) => e.type === "job.completed" && e.subject === YAHOO_JOB_ID,
    );
    expect(completion).toBeDefined();
    expect((completion?.data as { runId?: string }).runId).toBe(body.run.runId);

    const list = await callRoute(ctx, "GET", "/data-providers");
    const listBody = (await list.json()) as any;
    const yahoo = listBody.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.feed.state).toBe("ready");
    expect(yahoo.feed.lastRun).toMatchObject({ status: "completed", received: 2 });
    expect(yahoo.feed.snapshot.rowsPersisted).toBe(2);
    // …and the pipeline surface shows the same run as the job's last.
    expect(yahoo.feedJobs[0].pipeline.lastRunStatus).toBe("success");
  });

  it("POST feed-run for a provider with no registered job is a typed 404", async () => {
    // S2 adaptation (#3530 S2, disclosed): the no-job exemplar was
    // etrade in S1; etrade has a job since S2, so the invariant
    // (jobless provider ⇒ typed FEED_JOB_NOT_FOUND 404) is asserted
    // on nasdaq, which remains jobless.
    const { ctx } = await makeCtx();
    // #3535: nasdaq is the provider with no quotes job (its job
    // maintains the index list, not a quotes dataset).
    const res = await callRoute(ctx, "POST", "/data-providers/nasdaq/feed-run", {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_FOUND");
  });

  it("POST feed-run with the pipeline door unbound is a typed 500 FEED_JOB_NOT_CONFIGURED and runs nothing", async () => {
    const { ctx, datasetStore, auditRows } = await makeCtx({ feedPipelineDoor: null });
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_CONFIGURED");
    expect(await datasetStore.latest("yahoo", "quotes")).toBeUndefined();
    expect(auditRows.some((r) => r.type === "data_provider.feed_run")).toBe(false);
  });

  it("POST feed-run whose host cannot pull (no provider wired for the source) maps the door's FEED_JOB_NOT_CONFIGURED onto the same typed 500", async () => {
    const { ctx, datasetStore, control } = await makeCtx(undefined, () => undefined);
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_CONFIGURED");
    // The refusal came THROUGH the plane: the run exists in the
    // job's pipeline history as a failure; no artifact was stored.
    expect((await control.getJob(YAHOO_JOB_ID)).latestRun).toMatchObject({
      outcome: "failure",
    });
    expect(await datasetStore.latest("yahoo", "quotes")).toBeUndefined();
  });

  it("POST feed-run records a provider failure as a 200 failed run under the pipeline run id", async () => {
    const failing: DataProvider = {
      id: "yahoo",
      name: "Yahoo Finance",
      capabilities: ["quotes", "historicalBars", "fundamentals"],
      isConfigured: () => true,
      getQuotesBatch: async () => {
        throw new Error("provider exploded");
      },
    };
    const { ctx, auditRows, published } = await makeCtx(
      undefined,
      (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? failing : undefined),
    );
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({
      status: "failed",
      codedError: FEED_JOB_CODES.fetchFailed,
      requested: 2,
      received: 0,
    });
    const failure = published.find(
      (e) => e.type === "job.failed" && e.subject === YAHOO_JOB_ID,
    );
    expect(failure).toBeDefined();
    expect((failure?.data as { runId?: string }).runId).toBe(body.run.runId);
    const audit = auditRows.find((r) => r.type === "data_provider.feed_run");
    expect(audit?.payload).toMatchObject({ runId: body.run.runId, status: "failed" });
  });

  it("GET /data-providers/:id/feed serves the persisted copy with provenance; before any run it reports missing", async () => {
    const { ctx } = await makeCtx();
    const before = await callRoute(ctx, "GET", "/data-providers/yahoo/feed?symbols=AAPL");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as any;
    expect(beforeBody.feed.state).toBe("never-run");
    expect(beforeBody.quotes.status).toBe("missing");

    await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    const after = await callRoute(ctx, "GET", "/data-providers/yahoo/feed?symbols=AAPL,TSLA");
    const afterBody = (await after.json()) as any;
    expect(afterBody.quotes.status).toBe("hit");
    expect(afterBody.quotes.quotes).toHaveLength(1);
    expect(afterBody.quotes.quotes[0].symbol).toBe("AAPL");
    expect(afterBody.quotes.missingSymbols).toEqual(["TSLA"]);
    expect(afterBody.quotes.provenance).toMatchObject({ providerId: "yahoo", universeIndex: "nasdaq100" });
  });

  it("GET /data-providers/:id/feed for a provider without a job is a typed 404", async () => {
    // S2 adaptation (#3530 S2, disclosed): exemplar swapped from
    // etrade (jobless in S1, registered in S2) to nasdaq (still
    // jobless); the invariant asserted is unchanged.
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/nasdaq/feed");
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_FOUND");
  });
});
