/**
 * Issue #1123 S5a: the follow-up bridge for screens that did NOT run
 * as async jobs (synchronous route executions). The bridge records a
 * completed main-job row (capability 'screener.run') and submits the
 * same chain — report + lifecycle notifications, then deliveries —
 * so every screen produces the same visible tree in the jobs panel.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  screenerOutcomeFromRunResult,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  recordScreenerRunMainJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

describe("screenerOutcomeFromRunResult", () => {
  it("maps a ScreenerRunResult into the canonical outcome", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      totalScanned: 50,
      matchedCount: 2,
      pdfKey: "k1",
      pdfStatus: "generated",
      opportunities: [{ symbol: "AAA", companyName: "Acme", signal: "momentum", lastPrice: 10, changePercent: 1.5 }],
    });
    expect(outcome).toMatchObject({
      kind: "stock",
      trigger: "manual",
      success: true,
      pdfKeys: ["k1"],
      pdfStatus: "generated",
      matchedCount: 2,
      totalScanned: 50,
      universe: "NASDAQ100",
    });
    expect(outcome.opportunities).toHaveLength(1);
    // Issue #1943: the bridge now builds absolute report URLs.
    expect(outcome.reportUrl).toBe("https://agent.openaimp.com/api/screener/report.pdf?key=k1");
  });

  it("maps failures and options results", () => {
    const failed = screenerOutcomeFromRunResult("stock", { success: false, error: "E*TRADE unavailable" });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("E*TRADE unavailable");
    const options = screenerOutcomeFromRunResult("options", {
      success: true,
      thesis: "volatility",
      totalScanned: 12,
      matchedCount: 3,
      pdfKey: "ok1",
    });
    expect(options.kind).toBe("options");
    // Issue #1943: the bridge now builds absolute report URLs.
    expect(options.reportUrl).toBe("https://agent.openaimp.com/api/options/report.pdf?key=ok1");
  });
});

/** Stateful fake (same harness as the S2–S4 suites). */
class StatefulAsyncSql {
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Array<Record<string, unknown>>, rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    if (/^DELETE FROM mas_async_jobs/i.test(q)) return wrap([]);
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let ai = 0;
      cols.forEach((col, i) => {
        row[col] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return wrap([], 1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assigns = setPart.split(",").map((s) => s.trim());
      let ai = 0;
      const updates: Array<[string, unknown]> = assigns.map((a) => {
        const [col, expr] = a.split("=").map((s) => s.trim());
        return [col, expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "")] as [string, unknown];
      });
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      let jobId: unknown;
      let wi = ai;
      for (const cond of wherePart.split(/ AND /i)) {
        if (cond.includes("?")) {
          if (/job_id\s*=\s*\?/.test(cond)) jobId = args[wi];
          wi++;
        }
      }
      let written = 0;
      for (const row of this.rows) {
        if (row.job_id === jobId) {
          for (const [col, val] of updates) row[col] = val;
          written = 1;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM mas_async_jobs/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...this.rows];
      if (/WHERE job_id = \?/i.test(q)) rows = rows.filter((r) => r.job_id === args[0]);
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/LIMIT \?/i.test(q)) rows = rows.slice(0, Number(args[args.length - 1]));
      return wrap(rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      }));
    }
    throw new Error(`StatefulAsyncSql: unsupported: ${q.slice(0, 80)}`);
  }
}

function makeCtx(sql: StatefulAsyncSql): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
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
      getStockPdf: async (_u: string, key: string) => (key === "k1" ? { fileName: "screen.pdf" } : null),
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true, detail: "sent-1" }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  } as unknown as AsyncJobsContext;
}

const bridgedOutcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "manual",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

describe("recordScreenerRunMainJob (the bridge)", () => {
  it("records a completed main job and chains report + deliveries (delivery IS the completion message, #1228)", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, bridgedOutcome, "alice");
    const mainRow = sql.rows.find((r) => r.job_id === mainJobId);
    expect(mainRow?.capability).toBe("screener.run");
    expect(mainRow?.status).toBe("completed");
    expect(mainRow?.job_kind).toBe("main");
    expect(mainRow?.display_name).toBe("Stock screen — NASDAQ100");

    const reportRow = sql.rows.find((r) => r.capability === "followup.report");
    expect(reportRow?.parent_job_id).toBe(mainJobId);
    // Issue #1228 (#1209 F2): both channels carry deliver jobs, so no
    // separate text-only 'completed' notify jobs are planned.
    const notes = sql.rows.filter((r) => r.capability === "followup.notify");
    expect(notes).toEqual([]);

    // The chain continues identically to a job-run screen.
    await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
    const deliveries = sql.rows.filter((r) => r.capability === "followup.deliver");
    expect(deliveries.map((d) => d.channel)).toEqual(["slack", "email"]);
    expect(deliveries[0].parent_job_id).toBe(mainJobId);
  });

  it("a failed bridged run records a failed main job, no report, failed notifications", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(
      ctx,
      { kind: "options", trigger: "scheduled", success: false, pdfKeys: [], error: "chain fetch failed", thesis: "vol" },
      "bob",
    );
    const mainRow = sql.rows.find((r) => r.job_id === mainJobId);
    expect(mainRow?.status).toBe("failed");
    expect(sql.rows.filter((r) => r.capability === "followup.report")).toHaveLength(0);
    const notes = sql.rows.filter((r) => r.capability === "followup.notify");
    expect(notes).toHaveLength(2);
    const payload = JSON.parse(String(notes[0].payload_json)) as { event?: string };
    expect(payload.event).toBe("failed");
  });
});

describe("route bridge wiring pins", () => {
  it("orchestrator wires the bridge into both screener route contexts", () => {
    // #2942: both screener route contexts are built in orchestrator/routeRequest.ts.
    const src = readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8");
    const occurrences = src.split("scheduleScreenerFollowups:").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
  it("the stock route prefers the bridge over the inline publishers", () => {
    const src = readFileSync("src/agents/routes/etradeBrokerScreen.ts", "utf8");
    expect(src).toContain("scheduleScreenerFollowups");
    expect(src).toContain("screenerOutcomeFromRunResult");
  });
  it("the options screen bridges instead of delivering inline when the port is present", () => {
    // Old pin asserted the bridge call lived in etradeOptionsScreen.ts;
    // #3186 step 3d moved delivery into the pipeline's deliver stage in
    // manualOptionsScreen.ts, with the route forwarding its ctx (which
    // carries scheduleScreenerFollowups) into the delivery builder. This
    // pin proves the bridge lives in the deliver stage and the route
    // forwards the ctx that carries it.
    const deliver = readFileSync("src/workflows/manualOptionsScreen.ts", "utf8");
    expect(deliver).toContain("scheduleScreenerFollowups");
    expect(deliver).toContain("screenerOutcomeFromRunResult");
    const route = readFileSync("src/agents/routes/etradeOptionsScreen.ts", "utf8");
    expect(route).toContain("createManualOptionsScreenDelivery");
    expect(route).toMatch(/createManualOptionsScreenDelivery\(\{\s*\n?\s*ctx: ctx/);
  });
});
