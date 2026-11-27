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
 * Issue #6101 (D1-first) — the route reads D1 alone now, and the
 * #6099 projector is deleted, so each test seeds its job rows
 * DIRECTLY into the frozen D1 agent_async_jobs table (no DO row,
 * no projection, no carrier row). The rows below are pre-cutover
 * projected rows, exactly what the frozen jobs list serves.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";

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
 * Issue #6101 — the D1 fixture: a MockD1Database env over the
 * frozen agent_async_jobs table (no carriers anymore). Jobs are
 * seeded straight into D1 by insertJob below.
 */
async function d1Fixture() {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  const adapter = createRunLedgerAdapter(env)!;
  await ensureRunLedgerTables(adapter);
  return { mock, sql, env };
}

type D1Fixture = Awaited<ReturnType<typeof d1Fixture>>;

/** How many pre-cutover rows the frozen D1 jobs table holds for the session. */
function countD1Jobs(fx: D1Fixture, sessionId = SESSION): number {
  const row = fx.mock.sqlite
    .prepare("SELECT COUNT(*) AS n FROM agent_async_jobs WHERE session_id = ?")
    .get(sessionId) as { n: number };
  return row.n;
}

const D1_JOB_COLUMNS =
  "job_id, tenant_id, session_id, capability, display_name, status, payload_json, result_json, response_status, error, error_code, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at, trigger, triggered_by, schedule_id, last_activity_at, projected_at_ms";
const D1_JOB_PLACEHOLDERS = Array.from({ length: 27 }, () => "?").join(", ");

/**
 * Issue #6101 — write one job DIRECTLY into the frozen D1
 * agent_async_jobs table (the pre-cutover projected row shape;
 * no DO row, no projection).
 */
function insertJob(
  fx: D1Fixture,
  input: { jobId: string; displayName: string; payload: unknown; createdAt: string; stage?: string },
): void {
  fx.mock.sqlite.prepare(
    `INSERT INTO agent_async_jobs (${D1_JOB_COLUMNS}) VALUES (${D1_JOB_PLACEHOLDERS})`,
  ).run(
    input.jobId,
    "primary",
    "session-1",
    "http.request",
    input.displayName,
    "completed",
    JSON.stringify(input.payload),
    null,
    null,
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
    null,
    null,
    null,
    null,
    null,
    Date.now(),
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
    insertJob(fx, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA", "AAPL"]), createdAt: "2026-11-03T10:00:00.000Z" });
    insertJob(fx, { jobId: "imp-1", displayName: "POST /external-ads/impression", payload: { method: "POST", pathAndQuery: "/external-ads/impression", body: JSON.stringify({ id: "e1" }) }, createdAt: "2026-11-03T10:01:00.000Z" });
    expect(countD1Jobs(fx)).toBe(2);
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
    insertJob(fx, { jobId: "trace-1", displayName: "GET /api/workflow-runs", payload: { method: "GET", pathAndQuery: "/api/workflow-runs?limit=50" }, createdAt: "2026-11-03T09:00:00.000Z" });
    insertJob(fx, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA"]), createdAt: "2026-11-03T10:00:00.000Z" });
    expect(countD1Jobs(fx)).toBe(2);
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
      insertJob(fx, { jobId: `cmp-${i}`, displayName: "POST /market-data/compare", payload: comparePayload([`SYM${i}`]), createdAt: `2026-11-03T10:0${i}:00.000Z` });
    }
    expect(countD1Jobs(fx)).toBe(5);
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
