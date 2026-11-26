/**
 * #2786 Part 2 — route params for the Workflow Runs tab.
 *
 * Pins, through the real route handler over MockSqlStorage:
 *  - compare + beacon job rows surface with their purpose titles
 *    (never dropped, never generic);
 *  - GET read traces hide by default WITH a visible count, and
 *    ?traces=all reveals them;
 *  - ?search/?trigger/?status filter before slicing and ?offset
 *    pages over the filtered list (no 50-cap dead end);
 *  - the response carries the paging fields the panel renders.
 *
 * Issue #6103 — the route reads D1 alone now, so each test seeds
 * its DO job rows (MockSqlStorage) and then projects each row at
 * write time via postRunLedgerBestEffort — the ORM-carrier path,
 * using the sweep's own async_jobs-leg input mapping from
 * src/agents/orchestrator/runLedgerReconcile.ts
 * (createAsyncJobPorts(...).read.workflowRunRows). The sweep itself
 * is never run — it copies existing DO rows into D1, which the
 * replacement ruling forbids. The carrier row is set so
 * storeErrors.runs stays unset.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { postRunLedgerBestEffort } from "../src/services/runLedgerProjectionPosting";

/** Minimal D1Database stand-in over node:sqlite (the #4116 suite's double). */
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

const SESSION = "session-1";

/**
 * Issue #6103 — the D1 fixture: a MockD1Database env plus the
 * carrier row, so the route's D1 reads serve and storeErrors.runs
 * stays unset. DO rows are still seeded in MockSqlStorage first
 * (the write-time source), then projected per row below.
 */
async function d1Fixture() {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  const adapter = createRunLedgerAdapter(env)!;
  await ensureRunLedgerTables(adapter);
  await adapter.setTenantProjectionCarriers(
    "primary",
    { queues: true, orm: true, sweep: true },
    "merged",
    Date.now(),
  );
  return { mock, sql, env };
}

type D1Fixture = Awaited<ReturnType<typeof d1Fixture>>;

/**
 * Issue #6103 — project every DO async job at write time, using
 * the sweep's own async_jobs-leg input mapping
 * (runLedgerReconcile.ts). Never the sweep itself.
 */
async function projectJobsAtWriteTime(fx: D1Fixture, sessionId = SESSION): Promise<number> {
  const nowMs = Date.now();
  let projectedCount = 0;
  for (const row of createAsyncJobPorts(fx.sql as never).read.workflowRunRows(sessionId, 100)) {
    const posted = await postRunLedgerBestEffort(
      fx.env,
      "primary",
      {
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
      },
      nowMs,
    );
    expect(posted.projected).toBe(true);
    projectedCount += 1;
  }
  return projectedCount;
}

const JOB_COLUMNS =
  "job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id";
const JOB_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function insertJob(
  sql: MockSqlStorage,
  input: { jobId: string; displayName: string; payload: unknown; createdAt: string; stage?: string },
): void {
  sql.exec(
    `INSERT INTO mas_async_jobs (${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS})`,
    input.jobId,
    "session-1",
    "http.request",
    input.displayName,
    "completed",
    JSON.stringify(input.payload),
    null,
    null,
    input.createdAt,
    input.createdAt,
    input.createdAt,
    null,
    null,
    "main",
    null,
    null,
    input.stage ?? "",
    null,
  );
}

function ctxFor(sql: MockSqlStorage, env: D1Fixture["env"], userLogin = "analyst") {
  // Issue #6103 — the route reads D1 from ctx.env; the schedule
  // reader is stubbed to [] (the parity fixture's seam) so the
  // orchestrator schedule read cannot add rows here.
  return { ensureTables: () => sql, userLogin, env, scheduleReader: async () => [] };
}

async function get(fx: D1Fixture, path: string) {
  const response = await handleWorkflowRunsRoutes(
    new Request(`https://agent.internal${path}`, { method: "GET" }),
    new URL(`https://agent.internal${path}`),
    "/workflow-runs",
    "session-1",
    ctxFor(fx.sql, fx.env),
  );
  expect(response).not.toBeNull();
  return (await response!.json()) as {
    count: number;
    runs: Array<{ title: string; workflow: string; family: string }>;
    hiddenTraceCount: number;
    totalMatched: number;
    offset: number;
    limit: number;
    storeErrors?: Record<string, string>;
  };
}

function comparePayload(symbols: string[]) {
  return { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols }) };
}

describe("GET /workflow-runs Part 2 params (D1-only, #6103)", () => {
  it("surfaces compare and beacon rows with purpose titles (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    insertJob(fx.sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA", "AAPL"]), createdAt: "2026-11-03T10:00:00.000Z" });
    insertJob(fx.sql, { jobId: "imp-1", displayName: "POST /external-ads/impression", payload: { method: "POST", pathAndQuery: "/external-ads/impression", body: JSON.stringify({ id: "e1" }) }, createdAt: "2026-11-03T10:01:00.000Z" });
    expect(await projectJobsAtWriteTime(fx)).toBe(2);
    const body = await get(fx, "/workflow-runs");
    expect(body.storeErrors?.runs).toBeUndefined();
    // Issue #3021: the registered binding schedule joins the page as
    // a scheduled row (sorted last — a configured schedule has no
    // start time), after the execution rows.
    expect(body.runs.map((r) => r.title)).toEqual(["Ad impression — e1", "Market data comparison — NVDA, AAPL", "Scheduled — screener-screen-workflow (*/30 * * * *)"]);
    expect(body.runs.map((r) => r.workflow)).toEqual(["Advertising", "Market data research", "Scheduled task"]);
  });

  it("hides GET traces by default with a count, and reveals them with traces=all (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    insertJob(fx.sql, { jobId: "trace-1", displayName: "GET /api/workflow-runs", payload: { method: "GET", pathAndQuery: "/api/workflow-runs?limit=50" }, createdAt: "2026-11-03T09:00:00.000Z" });
    insertJob(fx.sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA"]), createdAt: "2026-11-03T10:00:00.000Z" });
    expect(await projectJobsAtWriteTime(fx)).toBe(2);
    const hidden = await get(fx, "/workflow-runs");
    // The trace hides (count 1); the compare row and the #3021
    // binding schedule row remain.
    expect(hidden.runs).toHaveLength(2);
    expect(hidden.hiddenTraceCount).toBe(1);
    const shown = await get(fx, "/workflow-runs?traces=all");
    expect(shown.runs).toHaveLength(3);
    expect(shown.hiddenTraceCount).toBe(0);
  });

  it("filters before slicing and pages with offset (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    for (let i = 0; i < 5; i++) {
      insertJob(fx.sql, { jobId: `cmp-${i}`, displayName: "POST /market-data/compare", payload: comparePayload([`SYM${i}`]), createdAt: `2026-11-03T10:0${i}:00.000Z` });
    }
    expect(await projectJobsAtWriteTime(fx)).toBe(5);
    const searched = await get(fx, "/workflow-runs?limit=2&search=SYM4");
    expect(searched.totalMatched).toBe(1);
    expect(searched.runs.map((r) => r.title)).toEqual(["Market data comparison — SYM4"]);
    const paged = await get(fx, "/workflow-runs?limit=2&offset=2");
    // Five executions plus the #3021 binding schedule row (last).
    expect(paged.totalMatched).toBe(6);
    expect(paged.offset).toBe(2);
    expect(paged.limit).toBe(2);
    expect(paged.runs.map((r) => r.title)).toEqual(["Market data comparison — SYM2", "Market data comparison — SYM1"]);
  });
});
