// @vitest-environment node
/**
 * Issue #4420 ([Stage visibility] inner per-symbol engine checkpoint read).
 *
 * The shard's inner scan is durable but was never read: #4359 projects a
 * checkpoint only when its run id IS the record's engine run, and the page
 * never asked for a `strategy-screen:shard-scan:<chainId>:<symbol>` job.
 *
 * Pins:
 *  - 4420-P01 the inner identity is derived from the shard's own payload
 *    (chain id + shard key) and only for an options feed shard; anything
 *    else answers null instead of a guessed job id.
 *  - 4420-P02 the store-direct read is the SAME projection the job-status
 *    surface serves (getJobStages), and a store with no definition for the
 *    job answers null — never an invented stage list.
 *  - 4420-P03 the read model attaches inner stages to the shard row they
 *    belong to, leaves other rows alone, and keeps an empty inner list as an
 *    honest empty.
 *  - 4420-P04 /workflow-runs asks for the derived inner job once per shard
 *    and projects each shard's own run (two shards never share stages).
 *  - 4420-P05 a shard with no inner checkpoint renders an honest empty, and
 *    a row that is not a shard claims nothing about an inner run.
 *  - 4420-P06 a failing inner read is named in storeErrors and never hides
 *    the runs.
 *  - 4420-P07 no regression: #4359's engine-run stage read still governs a
 *    run whose job is an engine run.
 *
 * Issue #6103 — the jobs feeding the P04/P05/P06 route tests now come
 * from D1, not the DO: each shard row is written to the DO async-job
 * port and projected at write time via postRunLedgerBestEffort (the
 * ORM-carrier path, using the sweep's own input mapping) — never via
 * the sweep, which copies existing DO rows. The inner-shard stage
 * readers are untouched by #6103 (still store-direct via
 * ctx.ensureTables() + D1); only the jobs changed. What P04/P05/P06
 * pin about inner stages is unchanged.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";
import {
  createD1JobRunRecordDb,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { postRunLedgerBestEffort } from "../src/services/runLedgerProjectionPosting";
import { MockSqlStorage } from "./mock-sql";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  readStagesFromPipelineStores,
  type JobStagesRead,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import {
  buildWorkflowRunsPage,
  innerShardScanJobId,
  runFromJobs,
  type WorkflowRun,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { shardScanJobId, shardScanRunId } from "../src/workflows/optionsScreenEngine";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const CHAIN_ID = "chain-4420";

function noopRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  return registry;
}

/** A shard-shaped async-job row (capability + payload the executor reads). */
function shardRow(over: Partial<WorkflowRunJobRow> = {}): WorkflowRunJobRow {
  return {
    job_id: "shard-aapl",
    capability: "shard.execute",
    display_name: "Shard: feed/AAPL",
    status: "failed",
    created_at: new Date(T0).toISOString(),
    started_at: new Date(T0).toISOString(),
    completed_at: new Date(T0 + 5_000).toISOString(),
    chain_id: CHAIN_ID,
    stage: "feed",
    job_kind: "main",
    payload_json: JSON.stringify({
      shard: { stage: "feed", key: "AAPL" },
      chain: { chainId: CHAIN_ID, screenType: "options", trigger: "scheduled", userLogin: "analyst" },
    }),
    ...over,
  };
}

/** The job rows a page reads; every other table read answers empty. */
function sqlWithJobs(rows: Array<Record<string, unknown>>) {
  return {
    exec: (query: string) => (String(query).includes("FROM mas_async_jobs") ? rows : []),
  } as never;
}

/** Minimal D1Database stand-in over node:sqlite (the #4116 parity fixture's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

/** The session the route reads jobs for — the DO rows and the D1 projection both carry it. */
const D1_SESSION = "session-1";

/**
 * Issue #6103 — seed shard jobs in D1 through the write-time
 * projection path: each shard row is written to the DO async-job
 * port, then projected via postRunLedgerBestEffort using the
 * sweep's own input mapping (runLedgerReconcile.ts) — the sweep
 * itself is never run (it copies existing DO rows, which the
 * replacement ruling forbids). The carrier row is set so
 * storeErrors.runs stays unset. Returns the env + DO store the
 * route context needs.
 */
async function seedShardJobsInD1(rows: WorkflowRunJobRow[]) {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const jobDb = createD1JobRunRecordDb(mock as never);
  await ensureJobRunRecordsSchema(jobDb);
  const ports = createAsyncJobPorts(sql as never);
  ports.queue.ensureSchema();
  for (const row of rows) {
    ports.queue.insertQueued({
      jobId: row.job_id,
      sessionId: D1_SESSION,
      capability: row.capability,
      displayName: row.display_name,
      payloadJson: row.payload_json ?? "{}",
      nowIso: row.created_at,
      parentJobId: row.parent_job_id ?? null,
      jobKind: row.job_kind ?? null,
      channel: row.channel ?? null,
      notBefore: row.not_before ?? null,
      stage: row.stage ?? null,
      chainId: row.chain_id ?? null,
      trigger: null,
      triggeredBy: null,
      scheduleId: null,
    });
  }
  const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
  await ensureRunLedgerTables(adapter);
  await adapter.setTenantProjectionCarriers(
    "primary",
    { queues: true, orm: true, sweep: true },
    "merged",
    Date.now(),
  );
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  const nowMs = Date.now();
  let projectedCount = 0;
  for (const row of ports.read.workflowRunRows(D1_SESSION, 100)) {
    const posted = await postRunLedgerBestEffort(
      env,
      "primary",
      {
        ledger: "async_jobs",
        row: {
          jobId: row.job_id,
          // The workflow projection does not select session_id;
          // the list is session-scoped, so this call's session is
          // the row's session by construction.
          sessionId: D1_SESSION,
          tenantId: "primary",
          status: row.status,
          capability: row.capability,
          displayName: row.display_name,
          payloadJson: row.payload_json ?? "{}",
          resultJson: row.result_json,
          responseStatus: null,
          error: row.error,
          errorCode: row.error_code,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          parentJobId: row.parent_job_id,
          jobKind: row.job_kind,
          channel: row.channel,
          notBefore: row.not_before,
          stage: row.stage,
          chainId: row.chain_id,
          stuckAlertedAt: row.stuck_alerted_at,
          trigger: row.trigger,
          triggeredBy: row.triggered_by,
          scheduleId: row.schedule_id,
          lastActivityAt: row.last_activity_at,
        },
      },
      nowMs,
    );
    expect(posted.projected).toBe(true);
    projectedCount += 1;
  }
  expect(projectedCount).toBe(rows.length);
  return { mock, sql, env };
}

/** A two-stage engine job with a durable, completed checkpoint. */
async function runInnerJob(jobId: string) {
  const stores = createInMemoryJobPipelineStores();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: noopRegistry(),
    now: () => new Date(T0),
  });
  await control.defineJob({
    jobId,
    name: `Inner ${jobId}`,
    root: {
      kind: "scan",
      steps: [{ step: "noop" }],
      children: [{ kind: "risk", steps: [{ step: "noop" }] }],
    },
  });
  const dispatch = await control.runJob(jobId, { trigger: "scheduled" });
  if (dispatch.completion) await dispatch.completion;
  return { stores, control };
}

describe("4420-P01 the inner shard identity is derived, never guessed", () => {
  it("names the engine job an options feed shard dispatched", () => {
    expect(innerShardScanJobId(shardRow())).toBe(
      shardScanJobId(CHAIN_ID, "AAPL"),
    );
    expect(innerShardScanJobId(shardRow())).toBe(
      `strategy-screen:shard-scan:${CHAIN_ID}:AAPL`,
    );
  });

  it("keeps one home for the inner run id", () => {
    expect(shardScanRunId(CHAIN_ID, "AAPL")).toBe(`shard-scan:${CHAIN_ID}:AAPL`);
    expect(shardScanJobId(CHAIN_ID, "AAPL")).toBe(`strategy-screen:shard-scan:${CHAIN_ID}:AAPL`);
  });

  it("answers null for a row that is not an options feed shard", () => {
    expect(innerShardScanJobId(shardRow({ capability: "feed.snapshot" }))).toBeNull();
    expect(
      innerShardScanJobId(
        shardRow({
          payload_json: JSON.stringify({
            shard: { stage: "generate", key: "pdf" },
            chain: { chainId: CHAIN_ID, screenType: "options" },
          }),
        }),
      ),
    ).toBeNull();
    expect(
      innerShardScanJobId(
        shardRow({
          payload_json: JSON.stringify({
            shard: { stage: "feed", key: "AAPL" },
            chain: { chainId: CHAIN_ID, screenType: "stocks" },
          }),
        }),
      ),
    ).toBeNull();
    expect(innerShardScanJobId(shardRow({ payload_json: null }))).toBeNull();
    expect(
      innerShardScanJobId(
        shardRow({ payload_json: JSON.stringify({ shard: { stage: "feed", key: "AAPL" } }) }),
      ),
    ).toBeNull();
  });
});

describe("4420-P02 one projection, read store-direct", () => {
  it("serves exactly the stages the job-status surface serves", async () => {
    const jobId = shardScanJobId(CHAIN_ID, "AAPL");
    const { stores, control } = await runInnerJob(jobId);
    const direct = await readStagesFromPipelineStores(stores, jobId);
    const surface = await control.getJobStages(jobId);
    expect(direct).toEqual(surface);
    expect(direct?.stages.map((s) => s.kind)).toEqual(["scan", "risk"]);
    expect(direct?.checkpointRunId).toBe(surface.checkpointRunId);
  });

  it("answers null when the store holds no such job", async () => {
    const stores = createInMemoryJobPipelineStores();
    expect(await readStagesFromPipelineStores(stores, "strategy-screen:shard-scan:none:x")).toBeNull();
  });
});

describe("4420-P03 the read model attaches it to the shard row only", () => {
  it("carries the inner job id and its stages on the shard row", async () => {
    const jobId = shardScanJobId(CHAIN_ID, "AAPL");
    const { stores } = await runInnerJob(jobId);
    const read = (await readStagesFromPipelineStores(stores, jobId))!;
    const inner = new Map([
      [
        "shard-aapl",
        {
          jobId,
          stages: read.stages.map((view, index) => ({
            key: view.stageId,
            order: index + 1,
            stage: view.kind ?? view.stageId,
            label: view.kind ?? view.stageId,
            status: "completed",
            recordedBy: "engine-checkpoint" as const,
            startedAt: view.startedAt,
            finishedAt: view.endedAt,
            durationMs: view.durationMs,
            detail: null,
            reason: null,
            error: null,
            capability: null,
            jobKind: null,
            channel: null,
            input: null,
            output: null,
          })),
        },
      ],
    ]);
    const run = runFromJobs(
      [shardRow(), shardRow({ job_id: "shard-msft" })],
      [],
      undefined,
      T0,
      null,
      null,
      inner,
    );
    const shard = run.stages.find((stage) => stage.key === "shard-aapl")!;
    const sibling = run.stages.find((stage) => stage.key === "shard-msft")!;
    expect(shard.innerJobId).toBe(jobId);
    expect(shard.innerStages?.map((stage) => stage.stage)).toEqual(["scan", "risk"]);
    expect(sibling.innerStages).toBeUndefined();
  });

  it("keeps an empty inner list as an honest empty", () => {
    const inner = new Map([
      ["shard-aapl", { jobId: shardScanJobId(CHAIN_ID, "AAPL"), stages: [] }],
    ]);
    const page = buildWorkflowRunsPage({
      jobs: [shardRow()],
      outcomes: [],
      transitions: [],
      nowMs: T0,
      innerShardStages: inner,
    });
    const run = page.runs[0] as WorkflowRun;
    expect(run.stages[0].innerStages).toEqual([]);
    expect(run.stages[0].innerJobId).toBe(shardScanJobId(CHAIN_ID, "AAPL"));
  });
});

describe("4420-P04 /workflow-runs reads each shard's own inner checkpoint", () => {
  it("asks once with the derived job ids and projects each shard's own run", async () => {
    const aapl = shardScanJobId(CHAIN_ID, "AAPL");
    const msft = shardScanJobId(CHAIN_ID, "MSFT");
    const a = await runInnerJob(aapl);
    const b = await runInnerJob(msft);
    // Issue #6103 — the shard jobs feeding the inner read now come
    // from D1 (projected at write time); the inner-shard stage
    // assertions below are unchanged.
    const fx = await seedShardJobsInD1([
      shardRow(),
      shardRow({
        job_id: "shard-msft",
        payload_json: JSON.stringify({
          shard: { stage: "feed", key: "MSFT" },
          chain: { chainId: CHAIN_ID, screenType: "options" },
        }),
      }),
    ]);
    const asked: Array<Array<{ shardJobId: string; engineJobId: string }>> = [];
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => fx.sql as never,
        userLogin: "analyst",
        env: fx.env as never,
        jobRunRecordReader: async () => [],
        scheduleReader: async () => [],
        innerShardStageReader: async (refs) => {
          asked.push(refs);
          return new Map<string, JobStagesRead>([
            ["shard-aapl", (await readStagesFromPipelineStores(a.stores, aapl))!],
            ["shard-msft", (await readStagesFromPipelineStores(b.stores, msft))!],
          ]);
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((ref) => ref.engineJobId).sort()).toEqual([aapl, msft].sort());
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.id === CHAIN_ID || r.runId === CHAIN_ID) ?? data.runs[0];
    const aaplRow = run.stages.find((stage: any) => stage.key === "shard-aapl");
    const msftRow = run.stages.find((stage: any) => stage.key === "shard-msft");
    expect(aaplRow.innerJobId).toBe(aapl);
    expect(msftRow.innerJobId).toBe(msft);
    expect(aaplRow.innerStages.map((s: any) => s.stage)).toEqual(["scan", "risk"]);
    expect(msftRow.innerStages.map((s: any) => s.stage)).toEqual(["scan", "risk"]);
  });
});

describe("4420-P05 honest empty and no claim on a non-shard row", () => {
  it("renders an empty inner list when the shard checkpoint is absent", async () => {
    // Issue #6103 — the shard job feeding the inner read now comes
    // from D1 (projected at write time); the honest-empty
    // assertion below is unchanged.
    const fx = await seedShardJobsInD1([shardRow()]);
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => fx.sql as never,
        userLogin: "analyst",
        env: fx.env as never,
        jobRunRecordReader: async () => [],
        scheduleReader: async () => [],
        innerShardStageReader: async () => new Map(),
        jobStageReader: async () => new Map(),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.id === CHAIN_ID) ?? data.runs[0];
    // The row claims no inner run when the reader did not answer for it.
    expect(run.stages[0].innerStages).toBeUndefined();
  });

  it("does not ask for an inner job when no row is an options feed shard", async () => {
    let called = false;
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlWithJobs([shardRow({ capability: "feed.snapshot", payload_json: null })]),
        userLogin: "analyst",
        env: {},
        innerShardStageReader: async () => {
          called = true;
          return new Map();
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    expect(called).toBe(false);
  });
});

describe("4420-P06 a failing inner read is named, never fatal", () => {
  it("records storeErrors.innerShardStages and still renders the runs", async () => {
    // Issue #6103 — the shard job feeding the inner read now comes
    // from D1 (projected at write time); the named-failure
    // assertions below are unchanged.
    const fx = await seedShardJobsInD1([shardRow()]);
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => fx.sql as never,
        userLogin: "analyst",
        env: fx.env as never,
        jobRunRecordReader: async () => [],
        scheduleReader: async () => [],
        innerShardStageReader: async () => {
          throw new Error("inner stage store unavailable");
        },
        jobStageReader: async () => new Map(),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.innerShardStages).toContain("inner stage store unavailable");
    expect(data.runs.length).toBeGreaterThan(0);
  });
});

describe("4420-P07 no regression to #4359's engine-run read", () => {
  it("leaves an engine run's stages as the run's truth", async () => {
    const page = buildWorkflowRunsPage({
      jobs: [shardRow()],
      outcomes: [],
      transitions: [],
      nowMs: T0,
      engineStages: new Map([
        [
          "shard-aapl",
          [
            {
              stageId: "job:root",
              nodePath: "",
              kind: "feed",
              executionMode: null,
              startedAt: new Date(T0).toISOString(),
              endedAt: new Date(T0 + 1_000).toISOString(),
              durationMs: 1_000,
              units: [
                {
                  unitId: "u1",
                  status: "completed" as const,
                  attempt: 1,
                  startedAt: new Date(T0).toISOString(),
                  endedAt: new Date(T0 + 1_000).toISOString(),
                },
              ],
            },
          ],
        ],
      ]),
    });
    const run = page.runs[0];
    expect(run.stages).toHaveLength(1);
    expect(run.stages[0].recordedBy).toBe("engine-checkpoint");
    expect(run.stages[0].innerStages).toBeUndefined();
  });
});
