/**
 * Issue #1123 S5b: scheduled screens join the pipeline. The scheduled
 * tasks service's publish funnel prefers the follow-up bridge over
 * its private event bus when the host wires one: stock runs chain
 * fully (report + deliveries + notifications); options runs record
 * the main job + notifications only (their PDF delivery stays on the
 * #223 direct path — no double-send). Per-task channel overrides on
 * the bus events ride the outcome into the delivery planner/port.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  planDeliveryFollowups,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromEvent,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import { recordScreenerRunMainJob, type AsyncJobsContext } from "../src/agents/orchestrator/asyncJobs";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import type { ScreenerEvent } from "../src/events/screenerEvents";

describe("screenerOutcomeFromEvent", () => {
  it("maps a scheduled stock completion, carrying per-task overrides + deliveryId", () => {
    const outcome = screenerOutcomeFromEvent({
      type: "screener.completed",
      timestamp: "2026-10-23T09:00:00Z",
      universe: "SP500",
      trigger: "scheduled",
      pdfKey: "sk1",
      pdfStatus: "generated",
      deliveryId: "scheduled:SP500:2026-10-23T09:00",
      sector: "ALL",
      totalScanned: 400,
      matchedCount: 9,
      opportunities: [{ symbol: "AAA" } as never],
      emailTo: "desk@example.com",
      slackChannel: "#screens",
      webhookUrl: "https://example.com/hook",
    } as ScreenerEvent);
    expect(outcome).toMatchObject({
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["sk1"],
      matchedCount: 9,
      totalScanned: 400,
      universe: "SP500",
      deliveryId: "scheduled:SP500:2026-10-23T09:00",
      emailTo: "desk@example.com",
      slackChannel: "#screens",
      webhookUrl: "https://example.com/hook",
    });
  });

  it("maps failures and options events", () => {
    const failed = screenerOutcomeFromEvent({
      type: "screener.failed",
      timestamp: "2026-10-23T09:00:00Z",
      universe: "TECH",
      trigger: "scheduled",
      sector: "ALL",
      error: "boom",
    } as ScreenerEvent);
    expect(failed).toMatchObject({ kind: "stock", success: false, error: "boom" });

    const options = screenerOutcomeFromEvent({
      type: "options.completed",
      timestamp: "2026-10-23T09:00:00Z",
      trigger: "scheduled",
      thesis: "volatility",
      totalScanned: 30,
      withTrades: 4,
      symbols: ["AAA"],
      summary: "4 setups",
      reportUrl: "/api/options/report.pdf?key=ok1",
      opportunities: [],
    } as ScreenerEvent);
    expect(options).toMatchObject({
      kind: "options",
      success: true,
      thesis: "volatility",
      totalScanned: 30,
      summary: "4 setups",
      // Issue #1943: a relative carried reportUrl is absolutized by the bridge.
      reportUrl: "https://agent.openaimp.com/api/options/report.pdf?key=ok1",
    });
  });
});

describe("per-task overrides in the delivery planner", () => {
  const base: ScreenerRunOutcome = {
    kind: "stock",
    trigger: "scheduled",
    success: true,
    pdfKeys: ["sk1"],
    matchedCount: 1,
    totalScanned: 10,
  };
  const ready = { status: "ready", artifacts: [{ key: "sk1", fileName: "s.pdf" }] };

  it("an outcome-level recipient/channel/url makes that channel deliverable without env config", () => {
    const bare = resolveScreenerFollowupConfig({});
    expect(planDeliveryFollowups(base, bare, ready, "m", "u")).toEqual([]);
    const withOverrides: ScreenerRunOutcome = {
      ...base,
      emailTo: "desk@example.com",
      slackChannel: "#screens",
      webhookUrl: "https://example.com/hook",
    };
    const specs = planDeliveryFollowups(withOverrides, bare, ready, "m", "u");
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email", "webhook"]);
  });
});

describe("ScheduledTasksService publish funnel", () => {
  it("prefers the follow-up bridge: stock chains fully, options record-only", async () => {
    const calls: Array<{ outcome: ScreenerRunOutcome; chainReport: boolean }> = [];
    const service = new ScheduledTasksService(
      {} as never,
      undefined,
      "alice",
      undefined,
      undefined,
      undefined,
      undefined,
      async (outcome: ScreenerRunOutcome, _userLogin: string, chainReport: boolean) => {
        calls.push({ outcome, chainReport });
      },
    );
    const publish = (service as unknown as { publishScreenerEvent: (e: ScreenerEvent) => Promise<void> }).publishScreenerEvent.bind(service);
    await publish({
      type: "screener.completed",
      timestamp: "2026-10-23T09:00:00Z",
      universe: "SP500",
      trigger: "scheduled",
      pdfKey: "sk1",
      pdfStatus: "generated",
      sector: "ALL",
      totalScanned: 10,
      matchedCount: 1,
      opportunities: [],
    } as ScreenerEvent);
    await publish({
      type: "options.completed",
      timestamp: "2026-10-23T09:05:00Z",
      trigger: "scheduled",
      thesis: "vol",
      totalScanned: 5,
      withTrades: 1,
      symbols: [],
      summary: "s",
      opportunities: [],
    } as ScreenerEvent);
    expect(calls).toHaveLength(2);
    expect(calls[0].chainReport).toBe(true);
    expect(calls[0].outcome.kind).toBe("stock");
    expect(calls[1].chainReport).toBe(false);
    expect(calls[1].outcome.kind).toBe("options");
  });
});

/** Stateful fake (same harness as the S2–S5a suites). */
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

describe("bridge with chainReport off (scheduled options)", () => {
  it("records the main job + notifications, no report sub-job", async () => {
    const sql = new StatefulAsyncSql();
    const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
    const ctx = {
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" },
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
        getStockPdf: async () => null,
        getOptionsPdf: async () => null,
      }),
      followupDeliveryPort: () => ({
        deliver: async () => ({ ok: true }),
        notify: async () => ({ ok: true }),
      }),
    } as unknown as AsyncJobsContext;
    const outcome: ScreenerRunOutcome = {
      kind: "options",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      thesis: "vol",
      totalScanned: 5,
      summary: "1 setup",
    };
    const mainJobId = await recordScreenerRunMainJob(ctx, outcome, "alice", { chainReport: false });
    expect(sql.rows.find((r) => r.job_id === mainJobId)?.capability).toBe("screener.run");
    expect(sql.rows.filter((r) => r.capability === "followup.report")).toHaveLength(0);
    expect(sql.rows.filter((r) => r.capability === "followup.notify")).toHaveLength(1);
  });
});

describe("scheduled wiring pins", () => {
  it("orchestrator wires the bridge into the scheduled callbacks + schedules contexts", () => {
    // #2942: the wiring split across the class (1) and the moved dispatcher (3);
    // the total is unchanged at 4.
    const occurrences =
      readFileSync("src/agents/orchestrator.ts", "utf8").split("scheduleScreenerFollowups:").length - 1 +
      readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8").split("scheduleScreenerFollowups:").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });
  it("scheduled callbacks and schedule routes pass a follow-up scheduler to the service", () => {
    expect(readFileSync("src/agents/orchestrator/scheduledCallbacks.ts", "utf8")).toContain("scheduleScreenerFollowups");
    expect(readFileSync("src/agents/routes/schedules.ts", "utf8")).toContain("scheduleScreenerFollowups");
  });
});
