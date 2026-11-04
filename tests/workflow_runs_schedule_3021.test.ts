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
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";

const JOB_COLUMNS =
  "job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id";
const JOB_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function insertJob(
  sql: MockSqlStorage,
  input: { jobId: string; displayName: string; payload: unknown; createdAt: string; status?: string; notBefore?: string | null },
): void {
  sql.exec(
    `INSERT INTO mas_async_jobs (${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS})`,
    input.jobId,
    "session-1",
    "http.request",
    input.displayName,
    input.status ?? "completed",
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
    input.notBefore ?? null,
    "",
    null,
  );
}

function ctxFor(sql: MockSqlStorage, scheduleReader?: () => Promise<unknown[]>) {
  return { ensureTables: () => sql, userLogin: "analyst", env: {}, scheduleReader };
}

async function get(sql: MockSqlStorage, path: string, scheduleReader?: () => Promise<unknown[]>) {
  const response = await handleWorkflowRunsRoutes(
    new Request(`https://agent.internal${path}`, { method: "GET" }),
    new URL(`https://agent.internal${path}`),
    "/workflow-runs",
    "session-1",
    ctxFor(sql, scheduleReader),
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
    const sql = new MockSqlStorage();
    insertJob(sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols: ["NVDA"] }) }, createdAt: "2026-11-03T10:00:00.000Z" });
    const body = await get(sql, "/workflow-runs", async () => {
      throw new Error("orchestrator stub unreachable");
    });
    expect(body.storeErrors.schedules).toContain("orchestrator stub unreachable");
    expect(body.runs.map((r: any) => r.title)).toContain("Market data comparison — NVDA");
  });

  it("filters by lifecycle and schedule mechanism server-side", async () => {
    const sql = new MockSqlStorage();
    insertJob(sql, { jobId: "cmp-1", displayName: "POST /market-data/compare", payload: { method: "POST", pathAndQuery: "/market-data/compare", body: JSON.stringify({ symbols: ["NVDA"] }) }, createdAt: "2026-11-03T10:00:00.000Z" });
    const scheduled = await get(sql, "/workflow-runs?lifecycle=scheduled", async () => [ownCron]);
    expect(scheduled.runs.map((r: any) => r.id)).toContain("sched-own");
    expect(scheduled.runs.every((r: any) => r.lifecycle === "scheduled")).toBe(true);
    const agentOnly = await get(sql, "/workflow-runs?schedule=agent-scheduler", async () => [ownCron]);
    expect(agentOnly.runs.map((r: any) => r.id)).toContain("sched-own");
    expect(agentOnly.runs.every((r: any) => r.schedule?.mechanism === "agent-scheduler")).toBe(true);
  });

  it("surfaces a delayed queue job as a scheduled run", async () => {
    const sql = new MockSqlStorage();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    insertJob(sql, {
      jobId: "delayed-1",
      displayName: "POST /trading/options/regenerate",
      payload: { method: "POST", pathAndQuery: "/trading/options/regenerate", body: "{}" },
      createdAt: new Date().toISOString(),
      status: "queued",
      notBefore: future,
    });
    const body = await get(sql, "/workflow-runs");
    const row = body.runs.find((r: any) => r.id === "delayed-1");
    expect(row.lifecycle).toBe("scheduled");
    expect(row.schedule.mechanism).toBe("queue");
    expect(row.schedule.nextFiringAt).toBe(future);
  });
});
