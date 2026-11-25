/**
 * Issue #1123 S4: lifecycle notification sub-jobs. Every screener main
 * job emits tracked notifications on Slack + email when it starts,
 * completes, fails, and when a delivery is sent — job_kind
 * 'notification', parented to the main job, deduped by construction
 * (each transition is planned exactly once by the claiming executor).
 */
import { describe, expect, it } from "vitest";
import {
  formatLifecycleNotification,
  planLifecycleNotifications,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { MockD1Database } from "./mock-d1";

const outcome: ScreenerRunOutcome = {
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

describe("planLifecycleNotifications", () => {
  const config = resolveScreenerFollowupConfig({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    SCREENER_EMAIL_TO: "ops@example.com",
    SCREENER_WEBHOOK_URL: "https://example.com/hook",
  });

  it("plans slack+email only (webhook is a delivery channel, not a notification channel)", () => {
    const specs = planLifecycleNotifications("completed", outcome, config, "main-1", "alice");
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email"]);
    for (const spec of specs) {
      expect(spec.capability).toBe("followup.notify");
      expect(spec.jobKind).toBe("notification");
      expect(spec.parentJobId).toBe("main-1");
      expect(spec.payload.event).toBe("completed");
    }
    expect(specs[0].displayName).toBe("Notify: screen completed via Slack");
  });

  it("carries the delivered detail and stays silent when follow-ups are off", () => {
    const specs = planLifecycleNotifications("delivered", outcome, config, "m", "u", "via Slack");
    expect(specs[0].payload.detail).toBe("via Slack");
    const off = resolveScreenerFollowupConfig({ SCREENER_FOLLOWUPS: "off", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
    expect(planLifecycleNotifications("started", outcome, off, "m", "u")).toEqual([]);
  });
});

describe("formatLifecycleNotification", () => {
  it("renders each lifecycle event", () => {
    expect(formatLifecycleNotification("started", outcome)).toContain("started");
    expect(formatLifecycleNotification("completed", outcome)).toContain("completed");
    expect(formatLifecycleNotification("completed", outcome)).toContain("2 matched");
    expect(formatLifecycleNotification("delivered", outcome, "via Slack")).toContain("delivered via Slack");
    const failed = formatLifecycleNotification("failed", { ...outcome, success: false, error: "E*TRADE unavailable" });
    expect(failed).toContain("failed");
    expect(failed).toContain("E*TRADE unavailable");
  });
});

/** Stateful fake (same harness as the S2/S3 suites). */
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

const STOCK_BODY = JSON.stringify({
  universe: "NASDAQ100",
  totalScanned: 50,
  matchedCount: 2,
  opportunities: [],
  stocks: [],
  scannedAt: "2026-10-23T05:00:00Z",
  pdfKey: "k1",
  pdfStatus: "generated",
  reportUrl: "/api/screener/report.pdf?key=k1",
});

function makeCtx(
  sql: StatefulAsyncSql,
  env: Record<string, unknown>,
  notified: Array<{ channel: string; text: string }>,
  routeImpl?: () => Promise<Response>,
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    // #6102: the followup.deliver blocking audit writes to D1 now —
    // bind a fresh mock per ctx (a null port fails the job).
    env: { ...env, AGENT_DB: new MockD1Database() },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    // Issue #2178 (Q7 S2): followup.deliver jobs now audit
    // their claim through the ORM events repo — no-op here.
    getOrm: () => ({ events: { create: () => ({}) } }),
    routeRequest: routeImpl ?? (async () => new Response(STOCK_BODY, { status: 200 })),
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
      notify: async (input: { channel: string; text: string }) => {
        notified.push({ channel: input.channel, text: input.text });
        return { ok: true };
      },
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  } as unknown as AsyncJobsContext;
}

const ENV = { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" };

function notifyRows(sql: StatefulAsyncSql, event: string): Array<Record<string, unknown>> {
  return sql.rows.filter((r) => {
    if (r.capability !== "followup.notify") return false;
    const payload = JSON.parse(String(r.payload_json)) as { event?: string };
    return payload.event === event;
  });
}

describe("lifecycle notification chaining (executor)", () => {
  it("started + delivered notifications spawn around the main job; completed rides the delivery (#1228)", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified);
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });

    const started = notifyRows(sql, "started");
    expect(started.map((r) => r.channel)).toEqual(["slack", "email"]);
    expect(started[0].parent_job_id).toBe(main.jobId);
    expect(started[0].job_kind).toBe("notification");

    // Issue #1228 (#1209 F2): the report chain is planned for this
    // run and both channels carry deliver jobs — no text-only
    // 'completed' notify jobs (the delivery is the completion
    // message). 'started' above and 'delivered' below still notify.
    const completed = notifyRows(sql, "completed");
    expect(completed).toEqual([]);

    // Executing a notification sends text through the port.
    await executeAsyncJob(ctx, { jobId: String(started[0].job_id) });
    expect(getAsyncJob(ctx, String(started[0].job_id))?.result).toMatchObject({ status: "notified", event: "started" });
    expect(notified[0].channel).toBe("slack");
    expect(notified[0].text).toContain("started");

    // The report + a delivery run; the delivery's completion spawns
    // 'delivered' notifications parented to the MAIN job.
    const reportRow = sql.rows.find((r) => r.capability === "followup.report");
    await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
    const deliveryRow = sql.rows.find((r) => r.capability === "followup.deliver" && r.channel === "slack");
    await executeAsyncJob(ctx, { jobId: String(deliveryRow?.job_id) });
    const deliveredNotes = notifyRows(sql, "delivered");
    expect(deliveredNotes.map((r) => r.channel)).toEqual(["slack", "email"]);
    expect(deliveredNotes[0].parent_job_id).toBe(main.jobId);
    const deliveredPayload = JSON.parse(String(deliveredNotes[0].payload_json)) as { detail?: string };
    expect(deliveredPayload.detail).toBe("via Slack");
  });

  it("a hard-failed main job still emits failed notifications", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified, async () => {
      throw new Error("route exploded");
    });
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });
    expect(getAsyncJob(ctx, main.jobId)?.status).toBe("failed");
    const failed = notifyRows(sql, "failed");
    expect(failed.map((r) => r.channel)).toEqual(["slack", "email"]);
    await executeAsyncJob(ctx, { jobId: String(failed[0].job_id) });
    expect(notified[0].text).toContain("route exploded");
  });

  it("non-screener jobs emit no lifecycle notifications", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified);
    const job = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/quote?symbol=AAPL", method: "GET", headers: {}, body: undefined },
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    expect(sql.rows.filter((r) => r.capability === "followup.notify")).toHaveLength(0);
  });
});
