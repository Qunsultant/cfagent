// @vitest-environment node
/**
 * Issue #5892 — Workflow details view & consolidated run ledger optimization.
 *
 * Pins:
 *  - 5892-P01: `isInnerShardScanJobId` matches `strategy-screen:shard-scan:<chainId>:<symbol>`
 *    inner child jobs and rejects top-level job ids (`strategy-screen:<runId>`,
 *    `options-chain:<chainId>`, `options-screen:<runId>`, `pipeline-feed-quotes`).
 *  - 5892-P02: Inner shard-scan D1 records never leak as standalone top-level rows in
 *    `GET /workflow-runs`, `GET /api/runs?kind=all`, or `listD1JobRunRecordSummaries`, while
 *    `readInnerShardScanStages` falls back to D1 (`AGENT_DB`) when the shard checkpoint
 *    lives in D1 rather than DO SQLite.
 *  - 5892-P03: `runOptionsChainFeedUnit` buffers `runRecorder.recordRun` across `withRetry`
 *    attempts so a symbol that skips across all attempts records at most ONE `"skipped"`
 *    record (never 3 false `"success"` records), and a symbol that skips once then succeeds
 *    on retry records exactly ONE `"success"` record.
 *  - 5892-P04: `runFromJobRunRecord` and `attachWorkflowRuns` preserve recorded D1 linkage
 *    (`scheduleId`, `asyncJobId`, `workflowId`) and provenance (`brokerId`, `mode`,
 *    `modeSource`) without stuffing synthetic `d1:...` ids into `asyncJobId`.
 */
import { describe, expect, it, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import { MockSqlStorage } from "./mock-sql";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createD1JobPipelineDb,
  ensureJobPipelineSchema,
} from "../src/data/d1JobPipelineAdapter";
import { createJobPipelineStoresFromD1 } from "../src/data/createJobPipelinePorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";
import { d1JobRunRecordId } from "../src/services/jobRunRecordReads";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import {
  isInnerShardScanJobId,
  shardScanJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  listD1JobRunRecordSummaries,
} from "../src/services/runSummaries";
import {
  handleWorkflowRunsRoutes,
  readInnerShardScanStages,
} from "../src/agents/routes/workflowRuns";
import {
  handleReportsRoutes,
  type ReportsRouteContext,
} from "../src/agents/routes/reports";
import { runFromJobRunRecord } from "../src/services/workflowRuns";
import { attachWorkflowRuns } from "../src/services/runLedgerWorkflowRuns";
import {
  createOptionsChainStepRegistry,
  type OptionsChainStepDeps,
} from "../src/services/optionsChainPipelineJobs";
import { optionsChainJobId } from "../src/services/optionsChainJobDefinition";
import type { OptionChainSource } from "../src/trading";
import type { BrokerOptionChain, BrokerOptionExpireDate, ShardChainContext } from "../src/types";

const CHAIN_ID = "f1c9cff3-c17e-43cb-8d21-021cb7a48345";
const INNER_JOB_ID = shardScanJobId(CHAIN_ID, "GOOG");
const TOP_LEVEL_JOB_ID = "pipeline-feed-quotes";

function makeRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "job-pipeline",
    jobId: TOP_LEVEL_JOB_ID,
    operation: "job",
    started: "2026-11-20T13:28:00.000Z",
    finished: "2026-11-20T13:28:05.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    workflowId: "wf-run-1",
    descriptor: "Completed top-level job",
    ...overrides,
  });
}

function reportsCtx(
  sql: MockSqlStorage,
  records: JobRunRecord[],
): ReportsRouteContext {
  return {
    ensureTables: () => sql as any,
    env: {},
    jobRunRecordReader: async () => records,
    getScreenerAgent: () => ({ getHistory: async () => [] }) as any,
    getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
    getReportDispatchHitl: () => ({}) as any,
    hitlPreviewReady: () => true,
    executeApprovedSend: async () => {},
    buildResearchEmailBody: (hit: any) => hit.body,
    buildResearchWebhookBody: (hit: any) => ({ body: hit.body }),
    reportHitlActions: new Map(),
    hitlApprovedDispatches: new Map(),
    hitlDispatchHistory: new Map(),
    recordHitlDispatchHistory: () => {},
    watchdogTimerCount: () => 0,
    lastReportWatchdogSweepCount: () => 0,
    lastReportWatchdogSweepAt: () => null,
    startReportWatchdog: () => {},
    stopReportWatchdog: () => {},
    persistApproval: () => {},
    persistDispatchStatus: () => {},
  } as ReportsRouteContext;
}

describe("5892-P01 isInnerShardScanJobId", () => {
  it("matches inner shard-scan job ids and rejects top-level job ids", () => {
    expect(isInnerShardScanJobId(INNER_JOB_ID)).toBe(true);
    expect(isInnerShardScanJobId(`strategy-screen:shard-scan:${CHAIN_ID}:NVDA`)).toBe(true);

    expect(isInnerShardScanJobId("strategy-screen:run-123")).toBe(false);
    expect(isInnerShardScanJobId(`options-chain:${CHAIN_ID}`)).toBe(false);
    expect(isInnerShardScanJobId("options-screen:run-123")).toBe(false);
    expect(isInnerShardScanJobId("pipeline-feed-quotes")).toBe(false);
    expect(isInnerShardScanJobId("")).toBe(false);
    expect(isInnerShardScanJobId(null)).toBe(false);
    expect(isInnerShardScanJobId(undefined)).toBe(false);
  });
});

describe("5892-P02 top-level surfaces filter inner shard scans & D1 stage fallback", () => {
  it("excludes inner shard-scan D1 records from GET /workflow-runs", async () => {
    const sql = new MockSqlStorage();
    const inner = makeRecord({ jobId: INNER_JOB_ID, workflowId: "inner-wf-1" });
    const top = makeRecord({ jobId: TOP_LEVEL_JOB_ID, workflowId: "top-wf-1" });

    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-5892",
      {
        ensureTables: () => sql as any,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [inner, top],
      } as any,
    );

    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { runs: Array<{ id: string }> };
    const ids = data.runs.map((r) => r.id);
    expect(ids).not.toContain(d1JobRunRecordId(inner));
    expect(ids).toContain(d1JobRunRecordId(top));
  });

  it("excludes inner shard-scan D1 records from GET /api/runs?kind=all and listD1JobRunRecordSummaries", async () => {
    const sql = new MockSqlStorage();
    const inner = makeRecord({ jobId: INNER_JOB_ID, workflowId: "inner-wf-1" });
    const top = makeRecord({ jobId: TOP_LEVEL_JOB_ID, workflowId: "top-wf-1" });

    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=all", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=all"),
      "/api/runs",
      null,
      reportsCtx(sql, [inner, top]),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { runs: Array<{ id: string }> };
    const routeIds = data.runs.map((r) => r.id);
    expect(routeIds).not.toContain(d1JobRunRecordId(inner));
    expect(routeIds).toContain(d1JobRunRecordId(top));

    const d1 = new MockD1Database();
    await ensureJobRunRecordsSchema(createD1JobRunRecordDb(d1 as unknown as D1Database));
    const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
    await store.record(inner);
    await store.record(top);

    const summaries = await listD1JobRunRecordSummaries({ AGENT_DB: d1 }, 20);
    const summaryIds = summaries.map((s) => s.id);
    expect(summaryIds).not.toContain(d1JobRunRecordId(inner));
    expect(summaryIds).toContain(d1JobRunRecordId(top));
  });

  it("readInnerShardScanStages falls back to D1 (AGENT_DB) when DO SQLite has no checkpoint", async () => {
    const sql = new MockSqlStorage();
    const d1 = new MockD1Database();
    const d1Db = d1 as unknown as D1Database;
    await ensureJobPipelineSchema(createD1JobPipelineDb(d1Db));
    const d1Stores = createJobPipelineStoresFromD1(d1Db);

    const registry = new JobStepRegistry();
    registry.register("noop", async (ctx) => ({ output: ctx.input }));
    const control = new JobPipelineControl({
      stores: d1Stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: registry,
    });
    await control.defineJob({
      jobId: INNER_JOB_ID,
      name: "Inner GOOG scan",
      root: {
        kind: "scan",
        steps: [{ step: "noop" }],
        children: [{ kind: "risk", steps: [{ step: "noop" }] }],
      },
    });
    const dispatch = await control.runJob(INNER_JOB_ID, { trigger: "scheduled" });
    if (dispatch.completion) await dispatch.completion;

    const stagesMap = await readInnerShardScanStages(
      sql as any,
      [{ shardJobId: "shard-goog", engineJobId: INNER_JOB_ID }],
      d1Db,
    );
    const read = stagesMap.get("shard-goog");
    expect(read).toBeDefined();
    expect(read!.stages.map((s) => s.kind)).toEqual(["scan", "risk"]);
  });
});

describe("5892-P03 runOptionsChainFeedUnit buffers recordRun across retries", () => {
  function futureExpiry(): { date: string; expire: BrokerOptionExpireDate } {
    const dt = new Date(Date.now() + 30 * 86_400_000);
    return {
      date: dt.toISOString().split("T")[0],
      expire: { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() },
    };
  }

  function validChain(symbol: string, expire: BrokerOptionExpireDate): BrokerOptionChain {
    return {
      symbol,
      underlyingPrice: 100,
      selectedExpiry: { year: expire.year, month: expire.month, day: expire.day },
      pairs: [
        {
          call: {
            symbol,
            optionType: "CALL",
            strikePrice: 100,
            bid: 1.0,
            ask: 1.2,
            openInterest: 500,
            volume: 100,
          },
          put: {
            symbol,
            optionType: "PUT",
            strikePrice: 100,
            bid: 1.0,
            ask: 1.2,
            openInterest: 500,
            volume: 100,
          },
        },
      ],
    } as unknown as BrokerOptionChain;
  }

  function chainCtx(targetDate: string): ShardChainContext {
    return {
      chainId: CHAIN_ID,
      universe: "symbols",
      userLogin: "tester",
      brokerId: "alpaca",
      mode: "paper",
      modeSource: "selection",
      trigger: "scheduled",
      timestamp: new Date().toISOString(),
      channels: [],
      options: {
        symbols: ["GOOG"],
        thesis: "bullish",
        targetDate,
        riskProfile: "balanced",
        eventCalendarBySymbol: { GOOG: {} },
      },
    };
  }

  it("writes a single skipped record (never 3 false success rows) when all retry attempts skip", async () => {
    const { date } = futureExpiry();
    const recorded: JobRunRecord[] = [];
    const runRecorder: JobRunRecorder = {
      recordRun: async (rec) => {
        recorded.push(rec);
      },
      listRuns: async () => recorded,
      latestRun: async () => recorded[recorded.length - 1],
    };
    const failingChainSource: OptionChainSource = {
      getOptionExpireDates: async () => {
        throw new Error("simulated chain outage");
      },
      getOptionChains: async () => {
        throw new Error("simulated chain outage");
      },
    };
    const deps: OptionsChainStepDeps = {
      env: {
        PIPELINE_ACQUISITION_RETRY_ATTEMPTS: "3",
        PIPELINE_ACQUISITION_RETRY_BASE_DELAY_MS: "0",
        PIPELINE_ACQUISITION_RETRY_MAX_DELAY_MS: "0",
      } as never,
      engineStores: {
        stores: createInMemoryJobPipelineStores(),
        runRecorder,
      },
      queue: null,
      chainSourceFor: () => failingChainSource,
      blobPut: vi.fn(async () => undefined),
      blobGet: vi.fn(async () => undefined),
      storeReport: vi.fn(async () => ({ reportId: "rep-1", created: true, fanout: "pending" })),
      deliverOutcome: vi.fn(async () => undefined),
      optionsRunStorage: undefined,
    };

    const handler = createOptionsChainStepRegistry(deps).resolve("options-chain.feed");
    const stepRes = await handler({
      jobId: optionsChainJobId(CHAIN_ID),
      runId: CHAIN_ID,
      nodePath: "",
      kind: "options-chain.feed",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: "GOOG",
      params: { chain: chainCtx(date) },
      input: undefined,
      now: new Date().toISOString(),
    });

    expect((stepRes.output as { status: string }).status).toBe("failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe("skipped");
    expect(recorded[0].detail).toBeTruthy();
  });

  it("writes a single success record when attempt 1 skips and attempt 2 succeeds", async () => {
    const { date, expire } = futureExpiry();
    const recorded: JobRunRecord[] = [];
    const runRecorder: JobRunRecorder = {
      recordRun: async (rec) => {
        recorded.push(rec);
      },
      listRuns: async () => recorded,
      latestRun: async () => recorded[recorded.length - 1],
    };
    let fetchAttempt = 0;
    const retryingChainSource: OptionChainSource = {
      getOptionExpireDates: async () => {
        fetchAttempt += 1;
        if (fetchAttempt === 1) throw new Error("transient skip on attempt 1");
        return [expire];
      },
      getOptionChains: async ({ symbol }) => {
        if (fetchAttempt === 1) throw new Error("transient chain outage on attempt 1");
        return validChain(symbol, expire);
      },
    };
    const deps: OptionsChainStepDeps = {
      env: {
        PIPELINE_ACQUISITION_RETRY_ATTEMPTS: "3",
        PIPELINE_ACQUISITION_RETRY_BASE_DELAY_MS: "0",
        PIPELINE_ACQUISITION_RETRY_MAX_DELAY_MS: "0",
      } as never,
      engineStores: {
        stores: createInMemoryJobPipelineStores(),
        runRecorder,
      },
      queue: null,
      chainSourceFor: () => retryingChainSource,
      blobPut: vi.fn(async () => undefined),
      blobGet: vi.fn(async () => undefined),
      storeReport: vi.fn(async () => ({ reportId: "rep-1", created: true, fanout: "pending" })),
      deliverOutcome: vi.fn(async () => undefined),
      optionsRunStorage: undefined,
    };

    const handler = createOptionsChainStepRegistry(deps).resolve("options-chain.feed");
    const stepRes = await handler({
      jobId: optionsChainJobId(CHAIN_ID),
      runId: CHAIN_ID,
      nodePath: "",
      kind: "options-chain.feed",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: "GOOG",
      params: { chain: chainCtx(date) },
      input: undefined,
      now: new Date().toISOString(),
    });

    expect(fetchAttempt).toBeGreaterThanOrEqual(2);
    expect((stepRes.output as { status: string }).status).toBe("completed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe("success");
  });
});

describe("5892-P04 honest D1 linkage and provenance without synthetic asyncJobId", () => {
  it("forwards D1 linkage and provenance and never stuffs d1:... into asyncJobId", () => {
    const record = makeRecord({
      scheduleId: "sched-opt-1",
      asyncJobId: null,
      workflowId: "wf-chain-1",
      brokerId: "alpaca",
      mode: "paper",
      modeSource: "selection",
    });

    const wfRun = runFromJobRunRecord(record);
    expect(wfRun.id).toBe(d1JobRunRecordId(record));
    expect(wfRun.scheduleId).toBe("sched-opt-1");
    expect(wfRun.workflowId).toBe("wf-chain-1");
    expect(wfRun.asyncJobId).toBeUndefined();
    expect(wfRun.brokerId).toBe("alpaca");
    expect(wfRun.mode).toBe("paper");
    expect(wfRun.modeSource).toBe("selection");

    const entries = attachWorkflowRuns([], [wfRun]);
    expect(entries).toHaveLength(1);
    const { row } = entries[0];
    expect(row.scheduleId).toBe("sched-opt-1");
    expect(row.workflowId).toBe("wf-chain-1");
    expect(row.asyncJobId).toBeNull();
    expect(row.brokerId).toBe("alpaca");
    expect(row.mode).toBe("paper");
    expect(row.modeSource).toBe("selection");

    // Dedupes against a ledger row carrying matching workflowId
    const deduped = attachWorkflowRuns([makeRecord({ workflowId: "wf-chain-1" })], [wfRun]);
    expect(deduped).toHaveLength(0);
  });
});
