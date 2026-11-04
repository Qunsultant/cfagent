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
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";

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

function ctxFor(sql: MockSqlStorage, userLogin = "analyst") {
  return { ensureTables: () => sql, userLogin, env: {} };
}

async function get(sql: MockSqlStorage, path: string) {
  const response = await handleWorkflowRunsRoutes(
    new Request(`https://agent.internal${path}`, { method: "GET" }),
    new URL(`https://agent.internal${path}`),
    "/workflow-runs",
    "session-1",
    ctxFor(sql),
  );
  expect(response).not.toBeNull();
  return (await response!.json()) as {
    count: number;
    runs: Array<{ title: string; workflow: string; family: string }>;
    hiddenTraceCount: number;
    totalMatched: number;
    offset: number;
    limit: number;
  };
}

function comparePayload(symbols: string[]) {
  return { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols }) };
}

describe("GET /workflow-runs Part 2 params", () => {
  it("surfaces compare and beacon rows with purpose titles", async () => {
    const sql = new MockSqlStorage();
    insertJob(sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA", "AAPL"]), createdAt: "2026-11-03T10:00:00.000Z" });
    insertJob(sql, { jobId: "imp-1", displayName: "POST /external-ads/impression", payload: { method: "POST", pathAndQuery: "/external-ads/impression", body: JSON.stringify({ id: "e1" }) }, createdAt: "2026-11-03T10:01:00.000Z" });
    const body = await get(sql, "/workflow-runs");
    // Issue #3021: the registered binding schedule joins the page as
    // a scheduled row (sorted last — a configured schedule has no
    // start time), after the execution rows.
    expect(body.runs.map((r) => r.title)).toEqual(["Ad impression — e1", "Market data comparison — NVDA, AAPL", "Scheduled — screener-screen-workflow (*/30 * * * *)"]);
    expect(body.runs.map((r) => r.workflow)).toEqual(["Advertising", "Market data research", "Scheduled task"]);
  });

  it("hides GET traces by default with a count, and reveals them with traces=all", async () => {
    const sql = new MockSqlStorage();
    insertJob(sql, { jobId: "trace-1", displayName: "GET /api/workflow-runs", payload: { method: "GET", pathAndQuery: "/api/workflow-runs?limit=50" }, createdAt: "2026-11-03T09:00:00.000Z" });
    insertJob(sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: comparePayload(["NVDA"]), createdAt: "2026-11-03T10:00:00.000Z" });
    const hidden = await get(sql, "/workflow-runs");
    // The trace hides (count 1); the compare row and the #3021
    // binding schedule row remain.
    expect(hidden.runs).toHaveLength(2);
    expect(hidden.hiddenTraceCount).toBe(1);
    const shown = await get(sql, "/workflow-runs?traces=all");
    expect(shown.runs).toHaveLength(3);
    expect(shown.hiddenTraceCount).toBe(0);
  });

  it("filters before slicing and pages with offset", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 5; i++) {
      insertJob(sql, { jobId: `cmp-${i}`, displayName: "POST /market-data/compare", payload: comparePayload([`SYM${i}`]), createdAt: `2026-11-03T10:0${i}:00.000Z` });
    }
    const searched = await get(sql, "/workflow-runs?limit=2&search=SYM4");
    expect(searched.totalMatched).toBe(1);
    expect(searched.runs.map((r) => r.title)).toEqual(["Market data comparison — SYM4"]);
    const paged = await get(sql, "/workflow-runs?limit=2&offset=2");
    // Five executions plus the #3021 binding schedule row (last).
    expect(paged.totalMatched).toBe(6);
    expect(paged.offset).toBe(2);
    expect(paged.limit).toBe(2);
    expect(paged.runs.map((r) => r.title)).toEqual(["Market data comparison — SYM2", "Market data comparison — SYM1"]);
  });
});
