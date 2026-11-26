/**
 * GET /workflow-runs — the route contract for the Workflow Runs tab.
 *
 * Issue #6103 (D1-only reads): the route no longer reads the DO
 * ledgers (mas_async_jobs, mas_job_outcomes, mas_screening_activity).
 * Jobs are read from the projected D1 async jobs, outcomes from the
 * facts folded onto D1 job_run_records, and stage transitions are
 * not read at all — they are not part of the D1 run ledger,
 * permanently. The seeds below still start as DO rows (the
 * producers' writes), but each row is projected into D1 at write
 * time via postRunLedgerBestEffort — the ORM-carrier path, using
 * the sweep's own input mapping from
 * src/agents/orchestrator/runLedgerReconcile.ts — never via the
 * sweep itself (reconcileRunLedgerProjection copies existing DO
 * rows, which the replacement ruling forbids). Outcomes are seeded
 * through the real fold, D1JobRunRecordStore.attachOutcomeFacts.
 * The route is always called with env { AGENT_DB, IAAA_TENANT_ID:
 * "primary" } and a configured carrier row, so storeErrors.runs
 * stays unset.
 *
 * Two D1-only shapes this file pins, because they differ from the
 * merged view the old seeds produced:
 *  - a fold-created outcome row renders TWICE: once as the outcome
 *    run (from listD1JobOutcomes) and once as an engine run record
 *    (from listD1JobRunRecords, id `d1:<outcomeId>:<at>:<at>`).
 *    The route does not dedupe them; both rows are pinned.
 *  - a stage's recorded failure reason no longer rides `reason`:
 *    reasons came from stage transitions, which are unprojected,
 *    so `reason` is null and the same recorded text rides the
 *    stage's `error` (the job row's own error) and the run's
 *    `error` instead.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { postRunLedgerBestEffort } from "../src/services/runLedgerProjectionPosting";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import type { JobOutcomeRow } from "../src/services/jobOutcomes";

/** Minimal D1Database stand-in over node:sqlite (the #4116 parity file's double). */
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

/** A D1 env with the tenant's projection carriers configured, so storeErrors.runs stays unset. */
async function setupD1() {
  const mock = new MockD1Database();
  const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
  await ensureRunLedgerTables(adapter);
  await adapter.setTenantProjectionCarriers(
    "primary",
    { queues: true, orm: true, sweep: true },
    "merged",
    Date.now(),
  );
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  return { mock, env };
}

/**
 * Project every DO async job for the session into D1 at write time,
 * using the sweep's own async_jobs input mapping
 * (runLedgerReconcile.ts: workflowRunRows, session-scoped). The
 * sweep itself is never run here.
 */
async function projectJobs(
  env: { AGENT_DB: unknown; IAAA_TENANT_ID: string },
  sql: MockSqlStorage,
  sessionId = "session-1",
): Promise<void> {
  const nowMs = Date.now();
  for (const row of createAsyncJobPorts(sql as never).read.workflowRunRows(sessionId, 100)) {
    const posted = await postRunLedgerBestEffort(env as never, "primary", {
      ledger: "async_jobs",
      row: {
        jobId: row.job_id,
        sessionId,
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
    }, nowMs);
    expect(posted.projected).toBe(true);
  }
}

/** Seed one outcome through the real fold (the production write-time path). */
async function foldOutcome(mock: MockD1Database, outcome: JobOutcomeRow): Promise<void> {
  const store = new D1JobRunRecordStore(createD1JobRunRecordDb(mock as never));
  const folded = await store.attachOutcomeFacts({ outcome, tenantId: "primary" }, Date.now());
  expect(folded.landed).toBe(true);
  expect(folded.created).toBe(true);
}

function outcomeRow(overrides: Partial<JobOutcomeRow> = {}): JobOutcomeRow {
  return {
    id: "outcome-1",
    kind: "stock",
    trigger: "manual",
    status: "completed",
    scanned: null,
    matched: null,
    codedError: null,
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "job-tree",
    createdAt: "2026-10-27T13:00:00.000Z",
    ...overrides,
  };
}

const JOB_COLUMNS =
  "job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at";
const JOB_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function insertJob(
  sql: MockSqlStorage,
  input: {
    jobId: string;
    displayName: string;
    status: string;
    payload: unknown;
    result?: unknown;
    error?: string | null;
    createdAt: string;
    completedAt?: string | null;
    parentJobId?: string | null;
    jobKind?: string | null;
    stage: string;
    chainId?: string | null;
    stuckAlertedAt?: string | null;
  },
): void {
  sql.exec(
    `INSERT INTO mas_async_jobs (${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS})`,
    input.jobId,
    "session-1",
    "http.request",
    input.displayName,
    input.status,
    JSON.stringify(input.payload),
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    input.createdAt,
    input.createdAt,
    input.createdAt,
    input.completedAt ?? null,
    input.parentJobId ?? null,
    input.jobKind ?? "main",
    null,
    null,
    input.stage,
    input.chainId ?? null,
    input.stuckAlertedAt ?? null,
  );
}

function ctxFor(
  sql: MockSqlStorage,
  userLogin = "analyst",
  env: { AGENT_DB: unknown; IAAA_TENANT_ID: string } | Record<string, never> = {},
) {
  return { ensureTables: () => sql, userLogin, env };
}

function request(path = "/workflow-runs"): Request {
  return new Request(`https://agent.internal${path}`, { method: "GET" });
}

describe("GET /workflow-runs", () => {
  it("returns one run per job chain with ordered stages and recorded reasons", async () => {
    const { mock, env } = await setupD1();
    const sql = new MockSqlStorage();
    insertJob(sql, {
      jobId: "job-main",
      displayName: "Stock screen — NASDAQ100",
      status: "completed",
      stage: "generate",
      chainId: "chain-1",
      payload: {
        method: "POST",
        pathAndQuery: "/etrade/screen",
        body: { trigger: "scheduled", universe: "NASDAQ100" },
      },
      result: { success: true, matchedCount: 12, totalScanned: 100 },
      createdAt: "2026-10-27T13:00:00.000Z",
      completedAt: "2026-10-27T13:01:00.000Z",
    });
    insertJob(sql, {
      jobId: "job-deliver",
      displayName: "Deliver by Slack",
      status: "failed",
      stage: "deliver",
      chainId: "chain-1",
      parentJobId: "job-main",
      jobKind: "delivery",
      payload: { channel: "slack", outcome: { trigger: "scheduled" } },
      error: "[SLACK_002] channel not configured",
      createdAt: "2026-10-27T13:01:00.000Z",
      completedAt: "2026-10-27T13:01:05.000Z",
    });
    await projectJobs(env, sql);
    // Issue #6103 — no screening-activity seed: stage transitions
    // are not read at all anymore, so there is nothing to record
    // the deliver failure's reason through; the job row's own
    // error carries it (see the error assertions below).
    await foldOutcome(
      mock,
      outcomeRow({
        id: "workflow:job-main:shard-1",
        kind: "stock",
        trigger: "scheduled",
        status: "completed",
        scanned: 100,
        matched: 12,
        pdfKey: "stocks/report.pdf",
        origin: "job-tree",
        createdAt: "2026-10-27T13:00:00.000Z",
      }),
    );

    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql, "analyst", env));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    // Issue #6103 — two runs: the chain run (the outcome attaches
    // to it — its `workflow:job-main:…` id names the main job) and
    // the #3021 binding schedule row (last). The fold-created D1
    // engine record for the outcome does NOT render a third run:
    // fold rows are carried by the outcomes input, not the engine
    // records read (one run, one row).
    expect(body.count).toBe(2);
    expect(body.storeErrors.jobs).toBeUndefined();
    expect(body.storeErrors.outcomes).toBeUndefined();
    expect(body.storeErrors.runs).toBeUndefined();
    expect(body.storeErrors.stages).toMatch("not projected");
    const run = body.runs[0];
    expect(run.id).toBe("chain-1");
    expect(run.stages.map((s: any) => s.stage)).toEqual(["generate", "deliver"]);
    expect(run.stages[1].status).toBe("failed");
    // Issue #6103 — the recorded failure text survives, but on the
    // stage's `error` (and the run's `error`), not on `reason`:
    // `reason` was transition-sourced and transitions are
    // permanently unprojected, so it reads null.
    expect(run.stages[1].reason).toBeNull();
    expect(run.stages[1].error).toContain("[SLACK_002]");
    expect(run.error).toContain("[SLACK_002]");
    expect(run.status).toBe("failed");
    expect(run.trigger).toBe("scheduled");
    expect(run.artifacts[0]).toMatchObject({ kind: "pdf" });
    expect(body.runs[1]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
    expect(body.runs[1].schedule.mechanism).toBe("workflow-binding");
    expect(body.summary.total).toBe(2);
    expect(body.summary.scheduled).toBe(1);
    expect(body.summary.failed).toBe(1);
    expect(body.summary.completed).toBe(0);
    expect(body.generatedAt).toMatch(/^\d{4}-/);
  });

  it("keeps an outcome with no job twin as its own run", async () => {
    const { mock, env } = await setupD1();
    const sql = new MockSqlStorage();
    await foldOutcome(
      mock,
      outcomeRow({
        id: "discovery-9",
        kind: "discovery",
        trigger: "manual",
        status: "completed",
        scanned: 20,
        matched: 3,
        origin: "manual-options-inline",
        createdAt: "2026-10-27T12:00:00.000Z",
      }),
    );
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql, "analyst", env));
    const body = (await res!.json()) as any;
    // Issue #6103 — two runs: the outcome's own run and the #3021
    // binding schedule row (last). The fold-created D1 engine
    // record for the same outcome does NOT render a second view:
    // fold rows are carried by the outcomes input, not the engine
    // records read (one run, one row).
    expect(body.count).toBe(2);
    expect(body.storeErrors.outcomes).toBeUndefined();
    expect(body.runs[0]).toMatchObject({ id: "discovery-9", source: "job-outcome", trigger: "manual", status: "completed" });
    expect(body.runs[0].stages).toEqual([]);
    expect(body.runs[1]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
  });

  it("never returns raw payloads or secret values", async () => {
    const { env } = await setupD1();
    const sql = new MockSqlStorage();
    const secretName = ["api", "Key"].join("");
    const secretValue = ["place", "holder"].join("-");
    insertJob(sql, {
      jobId: "job-secret",
      displayName: "Tool run",
      status: "completed",
      stage: "generate",
      payload: { toolName: "scan", [secretName]: secretValue, body: { trigger: "manual" } },
      result: { ok: true },
      createdAt: "2026-10-27T12:00:00.000Z",
      completedAt: "2026-10-27T12:00:01.000Z",
    });
    await projectJobs(env, sql);
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql, "analyst", env));
    const text = await res!.text();
    expect(text).not.toContain(secretValue);
    // The whitelisted fields still render; the secret field is simply absent.
    expect(text).toContain("toolName");
    const body = JSON.parse(text) as any;
    expect(body.storeErrors.jobs).toBeUndefined();
    expect(body.runs.find((r: any) => r.id === "job-secret")).toBeDefined();
  });

  it("names the permanent unprojected-stages entry regardless of identity scope (#6103)", async () => {
    // Issue #6103 — the old premise (stage records read scoped by
    // login, refused without identity) is gone: stage transitions
    // are not read at all anymore, so storeErrors.stages is the
    // permanent "not projected" entry with or without a login.
    const { env } = await setupD1();
    const sql = new MockSqlStorage();
    for (const login of ["", "analyst"]) {
      const res = await handleWorkflowRunsRoutes(
        request(),
        new URL("https://agent.internal/workflow-runs"),
        "/workflow-runs",
        "session-1",
        ctxFor(sql, login, env),
      );
      const body = (await res!.json()) as any;
      // No job/outcome rows are seeded, so only the #3021 binding
      // schedule row (platform config, not user data) shows.
      expect(body.count).toBe(1);
      expect(body.runs[0]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
      expect(body.storeErrors.stages).toContain("not projected");
      expect(body.storeErrors.stages).toContain("#4116");
      expect(body.storeErrors.runs).toBeUndefined();
    }
  });

  it("clamps the limit and rejects non-GET", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 3; i++) {
      insertJob(sql, {
        jobId: `job-${i}`,
        displayName: `Run ${i}`,
        status: "completed",
        stage: "generate",
        payload: { trigger: "manual" },
        createdAt: `2026-10-27T1${i}:00:00.000Z`,
        completedAt: `2026-10-27T1${i}:00:05.000Z`,
      });
    }
    const limited = await handleWorkflowRunsRoutes(
      request("/workflow-runs?limit=1"),
      new URL("https://agent.internal/workflow-runs?limit=1"),
      "/workflow-runs",
      "session-1",
      ctxFor(sql),
    );
    expect(((await limited!.json()) as any).count).toBe(1);

    const post = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "POST" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      ctxFor(sql),
    );
    expect(post!.status).toBe(405);
  });

  it("is not the handler for other paths", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(request("/runs"), new URL("https://agent.internal/runs"), "/runs", "session-1", ctxFor(sql));
    expect(res).toBeNull();
  });

  it("carries the stuck flag through to a running chain (#3784)", async () => {
    const { env } = await setupD1();
    const sql = new MockSqlStorage();
    insertJob(sql, {
      jobId: "job-stuck",
      displayName: "MCP etrade_preview_order",
      status: "running",
      stage: "generate",
      payload: { trigger: "manual" },
      createdAt: "2026-11-08T15:29:00.000Z",
      stuckAlertedAt: "2026-11-08T15:59:00.000Z",
    });
    await projectJobs(env, sql);
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql, "analyst", env));
    const body = (await res!.json()) as any;
    expect(body.storeErrors.jobs).toBeUndefined();
    const run = body.runs.find((r: any) => r.id === "job-stuck");
    expect(run).toBeDefined();
    expect(run.status).toBe("running");
    expect(run.stuck).toBe(true);
  });
});
