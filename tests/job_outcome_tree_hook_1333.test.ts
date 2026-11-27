/**
 * Issue #1333: the job-tree hook — recordScreenerRunMainJob lands
 * the run in the D1 run ledger (job_run_records) alongside the
 * main job row, so bridged runs (scheduled/manual stock/options,
 * goal-screen, discovery) appear in Autopilot Control's job feed.
 * The hook never throws: a sink failure must not fail the run.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { recordScreenerRunMainJob } from "../src/agents/orchestrator/asyncJobs";
import { MockD1Database } from "./mock-d1";
import { createJobRunRecordAdapter } from "../src/data/createJobRunRecordPorts";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";

function makeCtx(sql: MockSqlStorage): any {
  // #6101: the hook folds onto D1; the ctx carries its d1 so the
  // test reads back from the same store the hook wrote to.
  const d1 = new MockD1Database();
  return {
    env: { AGENT_DB: d1 },
    d1,
    agentCtx: { storage: { sql } },
    ensureTables: () => sql,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm");
    },
    routeRequest: async () => new Response("{}", { status: 200 }),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
    followupReportPort: () => ({
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  };
}

describe("job-tree outcome hook (#1333)", () => {
  it("records a completed bridged run with its artifacts", async () => {
    const sql = new MockSqlStorage();
    const outcome: ScreenerRunOutcome = {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["stocks/abc.pdf"],
      pdfStatus: "generated",
      matchedCount: 12,
      totalScanned: 98,
      universe: "SP100",
      reportUrl: "/api/screener/report.pdf?key=stocks/abc.pdf",
      deliveryId: "sched:sp100:2026-10-24",
    };
    const ctx = makeCtx(sql);
    await recordScreenerRunMainJob(ctx, outcome, "alice");
    const rows = await createJobRunRecordAdapter({ AGENT_DB: ctx.d1 })!.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].jobId).toBe("sched:sp100:2026-10-24");
    expect(rows[0].operation).toBe("stock");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].matched).toBe(12);
    expect(rows[0].scanned).toBe(98);
    expect(rows[0].pdfKey).toBe("stocks/abc.pdf");
    expect(rows[0].origin).toBe("job-tree");
  });

  it("records a failed bridged run with its coded error", async () => {
    const sql = new MockSqlStorage();
    const outcome: ScreenerRunOutcome = {
      kind: "options",
      trigger: "scheduled",
      success: false,
      pdfKeys: [],
      error: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing",
      thesis: "NASDAQ100",
    };
    const ctx = makeCtx(sql);
    await recordScreenerRunMainJob(ctx, outcome, "alice");
    const rows = await createJobRunRecordAdapter({ AGENT_DB: ctx.d1 })!.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failure");
    expect(rows[0].codedError).toContain("[FAILURE_AUTH_NO_SESSION]");
  });
});
