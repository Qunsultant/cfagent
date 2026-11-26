/**
 * Multi-tenant owner enforcement for canonical reports.
 *
 * D1 `agent_reports` is tenant-scoped: every row belongs to exactly one
 * `user_login`, and every owner-scoped read filters on it. The old store
 * fell back to a literal `"default"` owner, which in a multi-tenant SaaS
 * files a real run under a fake tenant — visible to nobody (scoped reads)
 * or, worse, to anyone reading unscoped.
 *
 * Issue #6101 (step 8): the seam writes/reads D1 agent_reports now —
 * the DO mas_reports table is frozen at cutover and receives no new
 * writes, and the outcome ledger folds onto D1 job run records
 * (listD1JobRunRecords / D1JobRunRecordStore.listByJob) instead of the
 * DO mas_job_outcomes table.
 *
 * Pinned here:
 *  1. storeReportAtGeneration refuses a write without an owner and writes
 *     no row (no `"default"` bucket).
 *  2. A write with an owner is visible only to that owner.
 *  3. The goal-screen workflow store carries the run owner onto the
 *     canonical row (the reported "goal screen missing from Reports" bug).
 */
import { describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import {
  listScheduledReports,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import { persistWorkflowGoalScreenReport } from "../src/agents/orchestrator/goalScreenDispatch";
import { recordStrategyScreenRun } from "../src/services/optionsServeRecord";

type D1Database = any;

const OWNER = "tenant-a@example.com";

function d1Env() {
  const mock = new MockD1Database();
  const env = { AGENT_DB: mock as unknown as D1Database, IAAA_TENANT_ID: "tenant-2664" };
  return { mock, env };
}

/** Distinct D1 report ids visible through the Reports-route list. */
async function rowCount(env: { AGENT_DB: D1Database }): Promise<number> {
  const hits = await listScheduledReports(env, { limit: 100 });
  return new Set(hits.map((h) => h.id)).size;
}

/** Folded outcome rows for one run id, from the D1 run ledger. */
async function foldedOutcomes(mock: MockD1Database, jobId: string) {
  // recordStrategyScreenRun fires its outcome fold fire-and-forget
  // (recordOptionsRunOutcome is not awaited there), so the fold's own
  // schema ensure may still be in flight: wait for its row to land
  // via a raw read (no ensure, no migration runner) and only then
  // read through the store, whose ensure is safe once the fold's
  // migrations have landed. A second concurrent ensure races the
  // migration runner (duplicate ADD COLUMN kind).
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const row = mock.sqlite
        .prepare("SELECT COUNT(*) AS c FROM job_run_records WHERE job_id = ?")
        .get(jobId) as { c: number } | undefined;
      if (row && Number(row.c) > 0) break;
    } catch {
      // Table not created yet — the in-flight fold owns the schema.
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for folded outcome ${jobId}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const db = createD1JobRunRecordDb(mock as unknown as D1Database);
  await ensureJobRunRecordsSchema(db);
  return new D1JobRunRecordStore(db).listByJob(jobId);
}

const report = {
  runId: "goal-screen:task-1",
  generationId: "goal-screen:task-1",
  title: "Goal screen — growth (bullish)",
  source: "goal_screen",
  summary: "3 hits.",
  body: { hits: 3 },
  createdAt: "2026-10-28T12:00:00.000Z",
};

describe("canonical report owner is mandatory", () => {
  it("refuses a write with no userLogin and stores no row", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(report as any, env);
    expect(stored).toBeNull();
    expect(await rowCount(env)).toBe(0);
  });

  it("stores a row under its owner and hides it from other tenants", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration({ ...report, userLogin: OWNER } as any, env);
    expect(stored).toMatchObject({ created: true });
    expect(await rowCount(env)).toBe(1);

    const mine = await listScheduledReports(env, { userLogin: OWNER });
    expect(mine).toHaveLength(1);
    expect(mine[0].runId).toBe(report.runId);

    const other = await listScheduledReports(env, { userLogin: "tenant-b@example.com" });
    expect(other).toHaveLength(0);
  });

  it("dedupes a generation per owner, never across tenants", async () => {
    const { env } = d1Env();
    const a1 = await storeReportAtGeneration({ ...report, userLogin: "tenant-a@example.com" } as any, env);
    const a2 = await storeReportAtGeneration({ ...report, userLogin: "tenant-a@example.com" } as any, env);
    const b1 = await storeReportAtGeneration({ ...report, userLogin: "tenant-b@example.com" } as any, env);
    expect(a2!.reportId).toBe(a1!.reportId);
    expect(b1!.reportId).not.toBe(a1!.reportId);
    expect(await rowCount(env)).toBe(2);
  });
});

describe("strategy screener run record", () => {
  it("records the run under its owner and in the outcome ledger", async () => {
    const sql = new MockSqlStorage();
    const { mock, env } = d1Env();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-1", created: true })),
      getSql: () => sql,
    };

    const stored = await recordStrategyScreenRun(
      orm as any,
      {
        userLogin: OWNER,
        symbol: "NVDA",
        trigger: "manual",
        mode: "strategies",
        ranked: [{ candidate: { type: "iron_condor" } }, { candidate: { type: "credit_spread" } }],
        contracts: [{}, {}, {}],
        createdAt: "2026-10-28T14:00:00.000Z",
      },
      { env, userLogin: OWNER },
    );

    expect(stored).toMatchObject({ reportId: "strategy-1" });
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      source: "options_strategy",
      userLogin: OWNER,
    });

    const outcomes = await foldedOutcomes(
      mock,
      "options_strategy:strategies:NVDA:2026-10-28T14:00:00.000Z",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      operation: "options",
      outcome: "success",
      scanned: 3,
      matched: 2,
      origin: "options-strategy-screener",
    });
  });

  it("twins an async job's id instead of inventing a second run", async () => {
    const sql = new MockSqlStorage();
    const { mock, env } = d1Env();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-2", created: true })),
      getSql: () => sql,
    };

    await recordStrategyScreenRun(
      orm as any,
      {
        userLogin: OWNER,
        symbol: "AAPL",
        trigger: "manual",
        mode: "best-trade",
        ranked: [{ candidate: { type: "long_call" } }],
        bestTrade: { candidate: { type: "long_call" } },
        asyncJobId: "job-123",
        createdAt: "2026-10-28T14:05:00.000Z",
      },
      { env, userLogin: OWNER },
    );

    const outcomes = await foldedOutcomes(mock, "job-123");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].jobId).toBe("job-123");
  });

  it("carries the strategy report artifact keys on the record (#2162)", async () => {
    const sql = new MockSqlStorage();
    const { mock, env } = d1Env();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-3", created: true })),
      getSql: () => sql,
    };

    await recordStrategyScreenRun(
      orm as any,
      {
        userLogin: OWNER,
        symbol: "NVDA",
        trigger: "manual",
        mode: "strategies",
        ranked: [{ candidate: { type: "long_call" } }],
        pdfKey: "options:pdf:strategy:1",
        pdfStatus: "generated",
        xlsxKey: "options:xlsx:strategy:1",
        xlsxStatus: "generated",
        csvKey: "options:csv:strategy:1",
        csvStatus: "failed",
        csvError: "blob store down",
        createdAt: "2026-10-28T14:10:00.000Z",
      },
      { env, userLogin: OWNER },
    );

    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      source: "options_strategy",
      body: {
        pdfKey: "options:pdf:strategy:1",
        pdfStatus: "generated",
        xlsxKey: "options:xlsx:strategy:1",
        csvStatus: "failed",
        csvError: "blob store down",
      },
    });

    const outcomes = await foldedOutcomes(
      mock,
      "options_strategy:strategies:NVDA:2026-10-28T14:10:00.000Z",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      pdfKey: "options:pdf:strategy:1",
      xlsxKey: "options:xlsx:strategy:1",
      csvKey: "options:csv:strategy:1",
    });
  });
});

describe("goal screen canonical owner", () => {
  it("writes the run owner onto the goal-screen report row", async () => {
    const sql = new MockSqlStorage();
    const { mock, env } = d1Env();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "goal-1", created: true })),
      exec: () => [],
      // recordScreeningActivity takes the SQL exec surface; the outcome
      // sink takes the same DO database.
      ensureTables: () => sql,
      getSql: () => sql,
    };

    const reportId = await persistWorkflowGoalScreenReport(
      { env, getOrm: () => orm as any },
      {
        taskId: "task-1",
        scenarioSource: "built",
        trigger: "scheduled",
        result: {
          goalKind: "growth",
          outlook: "bullish",
          status: "complete",
          counts: { hits: 3, stocksScanned: 10, optionsUnderlyingsScanned: 4 },
          completedAt: "2026-10-28T12:00:00.000Z",
        },
      } as any,
      OWNER,
    );

    expect(reportId).toBe("goal-1");
    expect(orm.storeCanonicalReport).toHaveBeenCalledTimes(1);
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      source: "goal_screen",
      userLogin: OWNER,
    });

    // The run is also in the D1 run ledger, so Workflow Runs can
    // list it (goal runs have no async-job tree).
    const outcomes = await foldedOutcomes(mock, "goal-screen:task-1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      jobId: "goal-screen:task-1",
      operation: "goal",
      outcome: "success",
      scanned: 14,
      matched: 3,
    });
  });
});
