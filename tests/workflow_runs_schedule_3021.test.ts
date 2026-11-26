/**
 * Issue #3021 deliverable (b) — agent-scheduler schedules on the
 * Workflow Runs route, through the real route handler over
 * MockSqlStorage with an injected scheduleReader.
 *
 * Pins:
 *  - an own schedule (payload.userLogin === session user) surfaces
 *    as a scheduled row with agent-scheduler provenance;
 *  - another user's schedule and an unattributed row never surface
 *    (fail-closed scoping);
 *  - a paused item surfaces with "(paused)" in the title;
 *  - a failing schedule read is named in storeErrors and never
 *    hides the other runs;
 *  - ?lifecycle=scheduled and ?schedule=agent-scheduler filter
 *    server-side;
 *  - a queued job with a future not_before surfaces as a scheduled
 *    queue run (delayed-queue work, deliverable (c) half).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";

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

/**
 * Issue #6101 (D1-first) — the "other runs" in the two tests below
 * used to be DO-seeded jobs the route read directly. The route now
 * reads the FROZEN D1 agent_async_jobs table alone (the #6099
 * projector is deleted), so each job is written DIRECTLY into D1
 * by insertJob below — no DO row, no projection, no carrier row.
 * The route is called with env { AGENT_DB, IAAA_TENANT_ID:
 * "primary" }; storeErrors.jobs names the freeze. The schedule
 * machinery itself is untouched by #6101: the schedule assertions
 * stay exactly as they were.
 */
async function setupD1() {
  const mock = new MockD1Database();
  const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
  await ensureRunLedgerTables(adapter);
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  return { mock, env };
}

/** The frozen-jobs entry every seeded read names (#6101). */
const FROZEN_JOBS = "frozen at the #6101 cutover";

const D1_JOB_COLUMNS =
  "job_id, tenant_id, session_id, capability, display_name, status, payload_json, result_json, response_status, error, error_code, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at, trigger, triggered_by, schedule_id, last_activity_at, projected_at_ms";
const D1_JOB_PLACEHOLDERS = Array.from({ length: 27 }, () => "?").join(", ");

/**
 * Issue #6101 — write one job DIRECTLY into the frozen D1
 * agent_async_jobs table (the pre-cutover projected row shape).
 */
function insertJob(
  mock: MockD1Database,
  input: { jobId: string; displayName: string; payload: unknown; createdAt: string; status?: string; notBefore?: string | null },
): void {
  mock.sqlite.prepare(
    `INSERT INTO agent_async_jobs (${D1_JOB_COLUMNS}) VALUES (${D1_JOB_PLACEHOLDERS})`,
  ).run(
    input.jobId,
    "primary",
    "session-1",
    "http.request",
    input.displayName,
    input.status ?? "completed",
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
    input.notBefore ?? null,
    "",
    null,
    null,
    null,
    null,
    null,
    null,
    Date.now(),
  );
}

function ctxFor(
  sql: MockSqlStorage,
  scheduleReader?: () => Promise<unknown[]>,
  env: { AGENT_DB: unknown; IAAA_TENANT_ID: string } | Record<string, never> = {},
) {
  return { ensureTables: () => sql, userLogin: "analyst", env, scheduleReader };
}

async function get(
  sql: MockSqlStorage,
  path: string,
  scheduleReader?: () => Promise<unknown[]>,
  env: { AGENT_DB: unknown; IAAA_TENANT_ID: string } | Record<string, never> = {},
) {
  const response = await handleWorkflowRunsRoutes(
    new Request(`https://agent.internal${path}`, { method: "GET" }),
    new URL(`https://agent.internal${path}`),
    "/workflow-runs",
    "session-1",
    ctxFor(sql, scheduleReader, env),
  );
  expect(response).not.toBeNull();
  return (await response!.json()) as any;
}

const ownCron = {
  id: "sched-own",
  callback: "autonomousMarketScreen",
  payload: { userLogin: "analyst", description: "Nightly market scan" },
  type: "cron",
  time: 1893456000,
  cron: "0 3 * * *",
};

describe("GET /workflow-runs agent schedules (#3021)", () => {
  it("surfaces an own schedule with agent-scheduler provenance", async () => {
    const sql = new MockSqlStorage();
    const body = await get(sql, "/workflow-runs", async () => [ownCron]);
    const row = body.runs.find((r: any) => r.id === "sched-own");
    expect(row).toMatchObject({
      source: "schedule",
      lifecycle: "scheduled",
      workflow: "Scheduled task",
      title: "Scheduled market screen",
      trigger: "scheduled",
    });
    expect(row.schedule.mechanism).toBe("agent-scheduler");
    expect(row.schedule.identity).toBe("0 3 * * *");
    expect(row.schedule.reason).toBe("Nightly market scan");
    expect(row.schedule.nextFiringAt).toBe(new Date(1893456000 * 1000).toISOString());
  });

  it("drops another user's schedule and unattributed rows", async () => {
    const sql = new MockSqlStorage();
    const body = await get(sql, "/workflow-runs", async () => [
      { ...ownCron, id: "sched-other", payload: { userLogin: "someone-else" } },
      { ...ownCron, id: "sched-unattributed", payload: null },
      { id: "sched-malformed", type: "cron", time: 1893456000 },
    ]);
    expect(body.runs.map((r: any) => r.id)).not.toContain("sched-other");
    expect(body.runs.map((r: any) => r.id)).not.toContain("sched-unattributed");
    expect(body.runs.map((r: any) => r.id)).not.toContain("sched-malformed");
  });

  it("surfaces a paused schedule with (paused) in the title", async () => {
    const sql = new MockSqlStorage();
    const body = await get(sql, "/workflow-runs", async () => [{ ...ownCron, id: "sched-paused", paused: true, time: undefined }]);
    const row = body.runs.find((r: any) => r.id === "sched-paused");
    expect(row.title).toBe("Scheduled market screen (paused)");
    expect(row.schedule.nextFiringAt).toBeNull();
  });

  it("names a failing schedule read without hiding other runs", async () => {
    const { mock, env } = await setupD1();
    const sql = new MockSqlStorage();
    insertJob(mock, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols: ["NVDA"] }) }, createdAt: "2026-11-03T10:00:00.000Z" });
    // Issue #6101 — the "other run" is a frozen D1 job now, written
    // directly into agent_async_jobs (no DO row, no projection).
    const body = await get(sql, "/workflow-runs", async () => {
      throw new Error("orchestrator stub unreachable");
    }, env);
    expect(body.storeErrors.schedules).toContain("orchestrator stub unreachable");
    expect(body.storeErrors.jobs).toMatch(FROZEN_JOBS);
    expect(body.runs.map((r: any) => r.title)).toContain("Market data comparison — NVDA");
  });

  it("filters by lifecycle and schedule mechanism server-side", async () => {
    const sql = new MockSqlStorage();
    // Issue #6101 — the row lands in D1 but the handler is called
    // with no env, so it stays unread (as the DO row did before:
    // seeded, never projected, never served).
    const { mock } = await setupD1();
    insertJob(mock, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols: ["NVDA"] }) }, createdAt: "2026-11-03T10:00:00.000Z" });
    const scheduled = await get(sql, "/workflow-runs?lifecycle=scheduled", async () => [ownCron]);
    expect(scheduled.runs.map((r: any) => r.id)).toContain("sched-own");
    expect(scheduled.runs.every((r: any) => r.lifecycle === "scheduled")).toBe(true);
    const agentOnly = await get(sql, "/workflow-runs?schedule=agent-scheduler", async () => [ownCron]);
    expect(agentOnly.runs.map((r: any) => r.id)).toContain("sched-own");
    expect(agentOnly.runs.every((r: any) => r.schedule?.mechanism === "agent-scheduler")).toBe(true);
  });

  it("surfaces a delayed queue job as a scheduled run", async () => {
    const { mock, env } = await setupD1();
    const sql = new MockSqlStorage();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    insertJob(mock, {
      jobId: "delayed-1",
      displayName: "POST /trading/options/regenerate",
      payload: { method: "POST", pathAndQuery: "/trading/options/regenerate", body: "{}" },
      createdAt: new Date().toISOString(),
      status: "queued",
      notBefore: future,
    });
    // Issue #6101 — the delayed job is a frozen D1 job now, written
    // directly into agent_async_jobs (no DO row, no projection).
    const body = await get(sql, "/workflow-runs", undefined, env);
    expect(body.storeErrors.jobs).toMatch(FROZEN_JOBS);
    const row = body.runs.find((r: any) => r.id === "delayed-1");
    expect(row.lifecycle).toBe("scheduled");
    expect(row.schedule.mechanism).toBe("queue");
    expect(row.schedule.nextFiringAt).toBe(future);
  });
});
