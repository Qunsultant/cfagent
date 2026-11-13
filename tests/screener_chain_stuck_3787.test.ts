// @vitest-environment node
/**
 * Issue #3787 (sub-issue of incident #3781) — the stock screener
 * workflow repair: the live screen path bypasses J1–J7, WorkflowPort
 * and pipeline-chain runs have no stuck detection, feed data is
 * never produced on a schedule, and remediatePlatformGaps reports
 * false success.
 *
 * Bite-proof pins (each reproduces a named failure mode, then
 * proves the fix):
 * (a) a stalled ScreenerScreenWorkflow run is bridged into
 *     mas_async_jobs, stays `running` past the door's await, and
 *     is then flagged stuck + alerted by the #3784 sweep (30 min)
 *     and reaped at the 2h backstop — no second sweep;
 * (b) a stalled J1–J7 pipeline-chain run is bridged the same way
 *     (a door call that never settles leaves a `running` bridge
 *     row the sweep alerts/reaps), and a settled chain run settles
 *     its bridge row;
 * (c) a screening chain run with missing feed data fails visibly
 *     with a named coded error (FEED_NO_QUOTES_RETURNED at the
 *     feed frontier; ENRICH_INPUT_MISSING at the enrich stage)
 *     in the run outcome, the chain surface view, and the bridge
 *     row — never completed-with-no-output;
 * (d) the feed-refresh goal exists in DEFAULT_SCHEDULES and its
 *     operation is in the operation catalog (the feed-goal tick
 *     itself is pinned in tests/feed_refresh_goal_3787.test.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
  type StuckRunAlertInfo,
} from "../src/agents/orchestrator/asyncJobs";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import {
  bridgeRunComplete,
  bridgeRunFail,
  bridgeRunStart,
} from "../src/agents/orchestrator/runBridge";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import type { WorkflowPort } from "../src/workflows/workflowPorts";
import type { Env } from "../src/types";
import { DEFAULT_SCHEDULES } from "../src/schedule";
import { OPERATION_CATALOG } from "../src/orchestrate";

const MIN = 60 * 1000;
const REAP_MESSAGE =
  "Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.";
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** SqlStorage-shaped executor over node:sqlite (the #3784 shim). */
function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

const BASE_DDL = `CREATE TABLE IF NOT EXISTS mas_async_jobs (
  job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
  display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
  result_json TEXT, response_status INTEGER, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT
)`;

function makeBridgeStore(sessionId = "owner-login-1") {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  sql.exec(BASE_DDL);
  ensureAsyncJobGraphColumns(sql as never);
  return { db, sql, sessionId };
}

function bridgeRow(db: DatabaseSync, jobId: string) {
  return db
    .prepare("SELECT * FROM mas_async_jobs WHERE job_id = ?")
    .get(jobId) as Record<string, unknown> | undefined;
}

function runningRows(db: DatabaseSync) {
  return db
    .prepare("SELECT * FROM mas_async_jobs WHERE status = 'running'")
    .all() as Array<Record<string, unknown>>;
}

function makeSweepCtx(
  sql: ReturnType<typeof makeSql>,
  sessionId: string,
  alerts: StuckRunAlertInfo[],
): AsyncJobsContext {
  return {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => sql,
    sessionKey: () => sessionId,
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm in 3787 sweep harness");
    },
    notifyStuckRun: async (info: StuckRunAlertInfo) => {
      alerts.push(info);
    },
  } as unknown as AsyncJobsContext;
}

/* ------------------------------------------------------------------ */
/* The bridge itself (unit)                                            */
/* ------------------------------------------------------------------ */

describe("run bridge (#3787): mas_async_jobs rows for non-async-job runs", () => {
  it("start inserts + claims a running row; complete settles it completed", () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const ports = createAsyncJobPorts(sql as never);
    const started = bridgeRunStart(ports, {
      jobId: "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234",
      sessionId,
      capability: "screener.run",
      displayName: "Stock screen — NASDAQ100",
      userLogin: "owner",
      trigger: "manual",
      nowIso: new Date().toISOString(),
    });
    expect(started).toBe(true);
    const row = bridgeRow(db, "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234");
    expect(row?.status).toBe("running");
    expect(typeof row?.started_at).toBe("string");

    const written = bridgeRunComplete(
      ports,
      "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234",
      JSON.stringify({ status: "completed", matchedCount: 2 }),
    );
    expect(written).toBe(1);
    expect(bridgeRow(db, "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234")?.status).toBe(
      "completed",
    );
  });

  it("fail settles a running row failed with the named error", () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const ports = createAsyncJobPorts(sql as never);
    bridgeRunStart(ports, {
      jobId: "chain:yahoo-nasdaq100-quotes-pipeline:run-1",
      sessionId,
      capability: "pipeline.chain",
      displayName: "Pipeline chain — Yahoo quotes — Nasdaq-100",
      userLogin: "owner",
      trigger: "manual",
      nowIso: new Date().toISOString(),
    });
    const written = bridgeRunFail(
      ports,
      "chain:yahoo-nasdaq100-quotes-pipeline:run-1",
      "ENRICH_INPUT_MISSING: enrich job \"yahoo-nasdaq100-quotes-enrich\" run x failed (No usable persisted dataset)",
    );
    expect(written).toBe(1);
    const row = bridgeRow(db, "chain:yahoo-nasdaq100-quotes-pipeline:run-1");
    expect(row?.status).toBe("failed");
    expect(String(row?.error ?? "")).toContain("ENRICH_INPUT_MISSING");
  });

  it("a second start for the same job id is a no-op (never two rows, never re-claimed)", () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const ports = createAsyncJobPorts(sql as never);
    const input = {
      jobId: "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234",
      sessionId,
      capability: "screener.run",
      displayName: "Stock screen — NASDAQ100",
      userLogin: "owner",
      trigger: "manual",
      nowIso: new Date().toISOString(),
    };
    expect(bridgeRunStart(ports, input)).toBe(true);
    expect(bridgeRunStart(ports, input)).toBe(false);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM mas_async_jobs").get() as { n: number },
    ).toEqual({ n: 1 });
    expect(bridgeRow(db, input.jobId)?.status).toBe("running");
  });

  it("complete/fail on an unknown id write nothing (guarded transitions)", () => {
    const { sql } = makeBridgeStore();
    const ports = createAsyncJobPorts(sql as never);
    expect(bridgeRunComplete(ports, "no-such-job", "{}")).toBe(0);
    expect(bridgeRunFail(ports, "no-such-job", "boom")).toBe(0);
  });

  it("the bridge payload carries no `chain` key (the already-running gate must not match it)", () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const ports = createAsyncJobPorts(sql as never);
    bridgeRunStart(ports, {
      jobId: "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234",
      sessionId,
      capability: "screener.run",
      displayName: "Stock screen — NASDAQ100",
      userLogin: "owner",
      trigger: "manual",
      nowIso: new Date().toISOString(),
    });
    const payload = JSON.parse(
      String(bridgeRow(db, "screener:chat:NASDAQ100:2026-11-08T00:00:00.000Z:abcd1234")?.payload_json),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("chain");
    expect(payload.bridge).toBe("screener-run");
  });
});

/* ------------------------------------------------------------------ */
/* (a) Stalled ScreenerScreenWorkflow run                              */
/* ------------------------------------------------------------------ */

describe("stalled ScreenerScreenWorkflow run (#3787a)", () => {
  function makeDoorCtx(
    sql: ReturnType<typeof makeSql>,
    port: WorkflowPort,
    opts: { deadlineMs?: number } = {},
  ): MeshScreenDoorContext {
    return {
      env: {} as Env,
      ensureTables: () => sql as never,
      asyncJobSessionId: "owner-login-1",
      workflowPort: port,
      readWorkflowJobHistory: async () => [],
      workflowPollIntervalMs: 1,
      workflowAwaitDeadlineMs: opts.deadlineMs ?? 50,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      nowMs: () => Date.now(),
      traceStore: null,
    };
  }

  it("a run that never settles leaves a running bridge row — the #3784 sweep then alerts (30 min) and reaps (2h)", async () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const neverSettling: WorkflowPort = {
      start: async (command) => ({
        workflowId: `wf-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        statusUrl: `/workflows/${command.jobId}`,
      }),
      status: async (workflowId) => ({
        workflowId,
        jobId: "screener",
        status: "running",
      }),
    };
    const result = await runStockScreenViaDoor(
      makeDoorCtx(sql, neverSettling),
      "owner",
      { universe: "NASDAQ100" },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("did not complete within the chat await window");

    // The run is NOT failed by the door: it is still running
    // somewhere, so its bridge row stays `running` — the
    // sweep owns the stuck verdict, not the chat await.
    const rows = runningRows(db);
    expect(rows).toHaveLength(1);
    const bridgeId = String(rows[0].job_id);
    expect(bridgeId.startsWith("screener:chat:NASDAQ100:")).toBe(true);
    expect(rows[0].capability).toBe("screener.run");

    const alerts: StuckRunAlertInfo[] = [];
    const sweepCtx = makeSweepCtx(sql, sessionId, alerts);
    const at45 = sweepStaleAsyncJobs(sweepCtx, Date.now() + 45 * MIN);
    expect(at45).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0].jobId).toBe(bridgeId);
    expect(bridgeRow(db, bridgeId)?.status).toBe("running");

    const at2h05 = sweepStaleAsyncJobs(sweepCtx, Date.now() + (2 * 60 + 5) * MIN);
    expect(at2h05).toEqual({ examined: 1, alerted: 0, reaped: 1 });
    const reaped = bridgeRow(db, bridgeId);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.error).toBe(REAP_MESSAGE);
  });

  it("a workflow that errors settles its bridge row failed with the terminal status named", async () => {
    const { db, sql } = makeBridgeStore();
    const erroring: WorkflowPort = {
      start: async (command) => ({
        workflowId: `wf-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        statusUrl: `/workflows/${command.jobId}`,
      }),
      status: async (workflowId) => ({
        workflowId,
        jobId: "screener",
        status: "errored",
      }),
    };
    const result = await runStockScreenViaDoor(
      makeDoorCtx(sql, erroring, { deadlineMs: 60_000 }),
      "owner",
      { universe: "NASDAQ100" },
    );
    expect(result.success).toBe(false);
    const rows = db
      .prepare("SELECT * FROM mas_async_jobs")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(String(rows[0].error ?? "")).toContain("errored");
  });
});

/* ------------------------------------------------------------------ */
/* (a) continued: a completed screen run settles completed             */
/* ------------------------------------------------------------------ */

describe("completed ScreenerScreenWorkflow run (#3787a)", () => {
  it("a run whose collation lands settles its bridge row completed", async () => {
    const { db, sql } = makeBridgeStore();
    // The #2488 real-adapter harness, over the node:sqlite
    // store: the workflow executes synchronously in start and
    // persists the canonical report, so the door's read-back
    // finds it on the first poll.
    const { InMemoryWorkflowAdapter } = await import(
      "../src/workflows/inMemoryWorkflowAdapter"
    );
    const { InMemoryShardJobAdapter } = await import(
      "../src/data/inMemoryShardJobAdapter"
    );
    const { InMemoryMeshTraceStore } = await import(
      "../src/data/inMemoryMeshTraceAdapter"
    );
    const { persistScreenerReportCanonical } = await import(
      "../src/agents/orchestrator/reportDispatch"
    );
    const { recordWorkflowTraceHop } = await import(
      "../src/observability/meshTrace"
    );
    const { newTraceContext, formatTraceparent } = await import(
      "../src/observability/observabilityPorts"
    );
    const shardStore = new InMemoryShardJobAdapter();
    const traceStore = new InMemoryMeshTraceStore();
    const trace = newTraceContext();
    const reportCtx = {
      env: {},
      ensureTables: () => sql,
    } as never;
    const full = {
      timestamp: new Date().toISOString(),
      trigger: "manual",
      provider: "etrade",
      universe: "NASDAQ100",
      sector: "Technology",
      success: true,
      totalScanned: 100,
      matchedCount: 2,
      opportunities: [
        { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      ],
      allStocks: [
        { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      ],
      discoveryMessage: "Discovered listings for NASDAQ100",
      filterSummary: "minPrice >= 10",
      rejections: [],
      pdfKey: "screener/NASDAQ100/report.pdf",
      userLogin: "owner",
    };
    // NOTE (#3787): the timestamp must be generated HERE, at
    // run time — after buildScreenCommand stamped startedAtIso.
    // The door's read-back drops stored bodies whose createdAt
    // predates startedAtIso, so a timestamp baked into the
    // fixture before the door call races the 1ms boundary and
    // flakes (passed once when both landed in the same
    // millisecond, then failed).
    const adapter = new InMemoryWorkflowAdapter({
      screenRunner: {
        runScreen: async (req: { universe?: string }) => ({
          success: true,
          timestamp: new Date().toISOString(),
          universe: req.universe ?? "TECH",
          totalScanned: 100,
          expectedCount: 100,
          matchedCount: 2,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full: { ...full, timestamp: new Date().toISOString() },
        }),
      },
      shardStore,
      storeReport: async (payload: unknown) => {
        await persistScreenerReportCanonical(
          reportCtx,
          payload as Parameters<typeof persistScreenerReportCanonical>[1],
        );
      },
      deliverOutcome: async () => {},
      nowMs: () => Date.now(),
      traceHop: (command: unknown, event: unknown) =>
        recordWorkflowTraceHop(
          traceStore,
          command as Parameters<typeof recordWorkflowTraceHop>[1],
          event as Parameters<typeof recordWorkflowTraceHop>[2],
        ),
    } as never);
    const startedCommands: Array<{ jobId: string }> = [];
    const port: WorkflowPort = {
      start: async (command) => {
        startedCommands.push(command);
        return adapter.start(command);
      },
      status: (workflowId) => adapter.status(workflowId),
    };
    const ctx: MeshScreenDoorContext = {
      env: {} as Env,
      ensureTables: () => sql as never,
      asyncJobSessionId: "owner-login-1",
      workflowPort: port,
      readWorkflowJobHistory: (tenantId, chainId) =>
        shardStore.listJobsForChain(tenantId, chainId),
      workflowPollIntervalMs: 1,
      workflowAwaitDeadlineMs: 60_000,
      sleep: async () => {},
      nowMs: () => Date.now(),
      traceStore,
      traceparent: () => formatTraceparent(trace),
    };
    const result = await runStockScreenViaDoor(ctx, "owner", { universe: "NASDAQ100" });
    expect(result.success).toBe(true);
    expect(result.matchedCount).toBe(2);
    const rows = db
      .prepare("SELECT * FROM mas_async_jobs")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(String(rows[0].job_id)).toBe(startedCommands[0].jobId);
  });
});

/* ------------------------------------------------------------------ */
/* (b) + (c) Pipeline-chain runs                                       */
/* ------------------------------------------------------------------ */

import {
  RunPipelineChainCommand,
  GetPipelineChainStatusCommand,
} from "../src/mcps/openaimp/chainJobCommands";
import type { McpToolContext } from "../src/patterns/interfaces";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { buildFeedJobRegistry, type FeedJobDefinition } from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import {
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
} from "../src/services/enrichPipelineJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { ensureAnalyzePipelineJobs } from "../src/services/analyzePipelineJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { ensureGeneratePipelineJobs } from "../src/services/generatePipelineJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import { ensureDeliverPipelineJobs } from "../src/services/deliverPipelineJobs";
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
} from "../src/services/chainPipelineJobs";
import type { DataProvider, DataResult, NewsResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchCompanyFundamentals, MarketDataResearchHistoricalBar, MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const FEED_ID = "yahoo-nasdaq100-quotes";
const CHAIN_ID = `${FEED_ID}-pipeline`;
const ENRICH_ID = `${FEED_ID}-enrich`;

function chainQuote(symbol: string): MarketDataResearchQuote {
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

/** The #3540 in-memory ScheduledAgent stub, with a feed provider
 *  that returns quotes — or nothing (emptyFeed), so the chain
 *  runs with missing feed data. */
async function makeChainHarness(opts: {
  emptyFeed?: boolean;
  hangChainRun?: boolean;
} = {}) {
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore = new InMemoryDeliveryDatasetStore();
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
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: opts.emptyFeed ? [] : symbols.map((s) => chainQuote(s)),
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
  const stores = createInMemoryJobPipelineStores();
  const feedDeps: FeedStepDeps = {
    registry: feedRegistry,
    providerFor: (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined),
    universeStore,
    datasetStore,
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    steps: createPipelineStepRegistry(
      feedDeps,
      { registry: buildEnrichJobRegistry({}), datasetStore, enrichedStore },
      { registry: buildAnalyzeJobRegistry({}), enrichedStore, analyzedStore },
      {
        registry: buildGenerateJobRegistry({}),
        analyzedStore,
        generatedStore,
        canonicalReportStore: null,
      },
      {
        registry: buildDeliverJobRegistry({}),
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
  const refresh = async (jobId: string) => {
    const chain = chainRegistry.forId(jobId);
    if (!chain) throw new Error(`PIPELINE_CHAIN_NOT_FOUND: no pipeline chain with id "${jobId}".`);
    await refreshChainDefinitionFromStoredStages(control, stores, chain);
  };
  const surface = async (jobId: string) => {
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
  const runOutcome = async (
    dispatch: { runId: string; state: string; completion?: Promise<{ state: string; error?: string }> },
    jobId: string,
  ) => {
    if (!dispatch.completion) return { jobId, runId: dispatch.runId, state: dispatch.state };
    const outcome = await dispatch.completion;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  const stub = {
    runPipelineChain: async (jobId: string) => {
      if (opts.hangChainRun) return new Promise<never>(() => {});
      await refresh(jobId);
      return runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId);
    },
    getPipelineChainSurfaceStatus: surface,
    listPipelineChainSurfaceStatuses: async () =>
      Promise.all(CHAIN_PIPELINE_CATALOG.map((e) => surface(e.jobId))),
  };
  return { stub, control };
}

async function makeChainContext(
  sql: ReturnType<typeof makeSql>,
  harness: Awaited<ReturnType<typeof makeChainHarness>>,
) {
  const env = {
    SCHEDULED_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => harness.stub,
    },
  } as unknown as Env;
  const audits: Array<{ type: string }> = [];
  const context = {
    env,
    orm: undefined,
    sessionId: "owner-login-1",
    actingLogin: () => "owner",
    audit: (type: string) => {
      audits.push({ type });
    },
    storage: { sql },
  } as unknown as McpToolContext;
  return { context, audits };
}

describe("stalled J1–J7 pipeline-chain run (#3787b)", () => {
  it("a chain run that never settles leaves a running bridge row the #3784 sweep alerts", async () => {
    const { db, sql, sessionId } = makeBridgeStore();
    const harness = await makeChainHarness({ hangChainRun: true });
    const { context } = await makeChainContext(sql, harness);
    const cmd = new RunPipelineChainCommand();
    const raced = await Promise.race([
      cmd.execute({ source: "yahoo nasdaq100 pipeline" }, context).then(() => "settled" as const),
      new Promise((r) => setTimeout(() => r("timeout" as const), 100)),
    ]);
    expect(raced).toBe("timeout");
    const rows = runningRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].capability).toBe("pipeline.chain");
    expect(String(rows[0].job_id)).toContain(CHAIN_ID);

    const alerts: StuckRunAlertInfo[] = [];
    const sweepCtx = makeSweepCtx(sql, sessionId, alerts);
    const at45 = sweepStaleAsyncJobs(sweepCtx, Date.now() + 45 * MIN);
    expect(at45).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0].jobId).toBe(String(rows[0].job_id));
  });

  it("a settled chain run settles its bridge row (completed on success)", async () => {
    const { db, sql } = makeBridgeStore();
    const harness = await makeChainHarness({});
    const { context } = await makeChainContext(sql, harness);
    const result = await new RunPipelineChainCommand().execute(
      { source: "yahoo nasdaq100 pipeline" },
      context,
    );
    expect(result.state).toBe("completed");
    const rows = db
      .prepare("SELECT * FROM mas_async_jobs")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(String(rows[0].result_json ?? "")).toContain(result.runId);
  });
});

describe("screening chain run with missing feed data (#3787c)", () => {
  it("fails visibly with the named feed code: door failed, surface frontier feed, bridge row failed", async () => {
    const { db, sql } = makeBridgeStore();
    const harness = await makeChainHarness({ emptyFeed: true });
    const { context } = await makeChainContext(sql, harness);
    const result = await new RunPipelineChainCommand().execute(
      { source: "yahoo nasdaq100 pipeline" },
      context,
    );
    expect(result.state).toBe("failed");
    expect(result.error ?? "").toContain("FEED_NO_QUOTES_RETURNED");

    const status = await new GetPipelineChainStatusCommand().execute(
      { source: "yahoo nasdaq100 pipeline" },
      context,
    );
    expect(status.frontier).toBe("feed");
    expect(status.pipeline?.lastRunStatus).toBe("failure");
    expect(status.pipeline?.lastError ?? "").toContain("FEED_NO_QUOTES_RETURNED");
    expect(status.stages.find((s) => s.stage === "feed")?.error ?? "").toContain(
      "FEED_NO_QUOTES_RETURNED",
    );

    const rows = db
      .prepare("SELECT * FROM mas_async_jobs")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(String(rows[0].error ?? "")).toContain("FEED_NO_QUOTES_RETURNED");
  });

  it("the enrich stage refuses by name when no usable feed dataset exists (ENRICH_INPUT_MISSING)", async () => {
    const harness = await makeChainHarness({ emptyFeed: true });
    // No feed run has persisted anything: the enrich job's own
    // run refuses at its input read, never an empty success.
    const dispatch = await harness.control.runJob(ENRICH_ID, { trigger: "manual" });
    expect(dispatch.completion).toBeDefined();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(outcome.error ?? "").toContain("ENRICH_INPUT_MISSING");
    const view = await harness.control.getJob(ENRICH_ID);
    expect(view.latestRun?.outcome).toBe("failure");
    expect(view.latestRun?.error ?? "").toContain("ENRICH_INPUT_MISSING");
  });
});

/* ------------------------------------------------------------------ */
/* (d) Feed on a schedule — removed (#4306 S2)                         */
/* ------------------------------------------------------------------ */

describe("feed datasets on a schedule — goal removed (#4306 S2)", () => {
  it("DEFAULT_SCHEDULES carries no feed-refresh goal", () => {
    const goal = DEFAULT_SCHEDULES.find((g) => g.id === "feed-refresh");
    expect(goal).toBeUndefined();
  });

  it("the operation catalog carries no feed.refresh_all entry, so addGoal cannot add the goal", () => {
    const entry = OPERATION_CATALOG.find((e) => e.operations.includes("feed.refresh_all"));
    expect(entry).toBeUndefined();
  });
});
