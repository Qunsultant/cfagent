/**
 * Issue #1123 S3: delivery sub-jobs. When the report sub-job completes,
 * the executor plans one delivery sub-job per configured channel
 * (slack, email, webhook), parented to the MAIN job. Email obeys the
 * Assessment allowlist. A skipped report yields skipped deliveries —
 * visible in the tree, never sent. Inline route publishers are
 * suppressed for job-run screens (x-async-job-id) so nothing sends twice.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatFollowupDeliveryText,
  planDeliveryFollowups,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromHttpJob,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

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
  opportunities: [
    { symbol: "AAA", companyName: "Acme", signal: "momentum", lastPrice: 10, changePercent: 1.5 },
    { symbol: "BBB", companyName: "Beta", signal: "value", lastPrice: 20, changePercent: -0.5 },
  ],
};
const artifacts = [{ key: "k1", fileName: "screen.pdf" }];

describe("planDeliveryFollowups", () => {
  it("plans one delivery per configured channel, parented to the main job, in slack/email/webhook order", () => {
    const config = resolveScreenerFollowupConfig({
      SCREENER_EMAIL_TO: "ops@example.com",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
      SCREENER_WEBHOOK_URL: "https://example.com/hook",
    });
    const specs = planDeliveryFollowups(outcome, config, { status: "ready", artifacts }, "main-1", "alice");
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email", "webhook"]);
    for (const spec of specs) {
      expect(spec.parentJobId).toBe("main-1");
      expect(spec.jobKind).toBe("delivery");
      expect(spec.capability).toBe("followup.deliver");
      expect(spec.payload.artifacts).toEqual(artifacts);
      expect(spec.payload.userLogin).toBe("alice");
    }
    expect(specs[0].displayName).toBe("Deliver by Slack — Stock screen");
    expect(specs[1].displayName).toBe("Deliver by email — Stock screen");
  });

  it("plans only configured channels; a skipped report marks every delivery skipped with the reason", () => {
    const config = resolveScreenerFollowupConfig({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
    const ready = planDeliveryFollowups(outcome, config, { status: "ready", artifacts }, "m", "u");
    expect(ready.map((s) => s.channel)).toEqual(["slack"]);
    const skipped = planDeliveryFollowups(outcome, config, { status: "skipped", reason: "render blew up" }, "m", "u");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.skipReason).toBe("render blew up");
    const off = resolveScreenerFollowupConfig({ SCREENER_FOLLOWUPS: "off", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
    expect(planDeliveryFollowups(outcome, off, { status: "ready", artifacts }, "m", "u")).toEqual([]);
  });
});

describe("formatFollowupDeliveryText + adapter opportunities", () => {
  it("renders counts, the report link and opportunity lines", () => {
    const text = formatFollowupDeliveryText(outcome);
    expect(text).toContain("NASDAQ100");
    expect(text).toContain("2 matched");
    expect(text).toContain("50 scanned");
    expect(text).toContain("/api/screener/report.pdf?key=k1");
    expect(text).toContain("AAA");
    expect(text).toContain("BBB");
  });

  it("the stock adapter now carries opportunities for delivery content", () => {
    const body = JSON.stringify({
      universe: "SP500",
      totalScanned: 10,
      matchedCount: 1,
      pdfKey: "k9",
      pdfStatus: "generated",
      opportunities: [{ symbol: "ZZZ", companyName: "Zed", signal: "breakout", momentumScore: 88, lastPrice: 5, changePercent: 3 }],
    });
    const parsed = screenerOutcomeFromHttpJob("/api/etrade/screen", 200, body);
    expect(parsed?.opportunities).toEqual([
      { symbol: "ZZZ", companyName: "Zed", signal: "breakout", momentumScore: 88, lastPrice: 5, changePercent: 3 },
    ]);
  });
});

/** Stateful fake (same harness as the S2 suite). */
class StatefulAsyncSql {
  columns = [
    "job_id", "session_id", "capability", "display_name", "status",
    "payload_json", "result_json", "response_status", "error",
    "created_at", "updated_at", "started_at", "completed_at",
    "parent_job_id", "job_kind", "channel",
  ];
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
  opportunities: [{ symbol: "AAA", companyName: "Acme", signal: "momentum", lastPrice: 10, changePercent: 1.5 }],
  stocks: [],
  scannedAt: "2026-10-23T05:00:00Z",
  pdfKey: "k1",
  pdfStatus: "generated",
  reportUrl: "/api/screener/report.pdf?key=k1",
});

function makeCtx(
  sql: StatefulAsyncSql,
  env: Record<string, unknown>,
  delivered: Array<{ channel: string; artifacts: unknown }>,
  notified: Array<{ channel: string; text: string }> = [],
  // Issue #2178 (Q7 S2): the delivery claim audits through the ORM
  // events repo — injectable so pins can record or throw.
  eventsRepo: { create: (record: unknown) => unknown } = { create: () => ({}) },
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env,
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => ({ events: eventsRepo }),
    routeRequest: async () => new Response(STOCK_BODY, { status: 200 }),
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
      deliver: async (input: { channel: string; artifacts: unknown }) => {
        delivered.push({ channel: input.channel, artifacts: input.artifacts });
        return { ok: true, detail: "sent-1" };
      },
      notify: async (input: { channel: string; text: string }) => {
        notified.push({ channel: input.channel, text: input.text });
        return { ok: true };
      },
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  } as unknown as AsyncJobsContext;
}

async function runChain(ctx: AsyncJobsContext, sql: StatefulAsyncSql): Promise<void> {
  const main = await submitAsyncJob(ctx, {
    capability: "http.request",
    payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
  });
  await executeAsyncJob(ctx, { jobId: main.jobId });
  const reportRow = sql.rows.find((r) => r.capability === "followup.report");
  expect(reportRow).toBeTruthy();
  await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
}

describe("delivery chaining (executor)", () => {
  it("report completion spawns slack+email deliveries parented to the MAIN job; both send", async () => {
    const sql = new StatefulAsyncSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const ctx = makeCtx(sql, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" }, delivered);
    await runChain(ctx, sql);
    const deliveries = sql.rows.filter((r) => r.capability === "followup.deliver");
    expect(deliveries.map((d) => d.channel)).toEqual(["slack", "email"]);
    const mainRow = sql.rows.find((r) => r.capability === "http.request");
    for (const d of deliveries) {
      expect(d.parent_job_id).toBe(mainRow?.job_id);
      expect(d.job_kind).toBe("delivery");
      await executeAsyncJob(ctx, { jobId: String(d.job_id) });
      const rec = getAsyncJob(ctx, String(d.job_id));
      expect(rec?.status).toBe("completed");
      expect(rec?.result).toMatchObject({ status: "sent", channel: d.channel });
    }
    expect(delivered.map((d) => d.channel)).toEqual(["slack", "email"]);
    // #1191: artifacts carry their kind (pdf/xlsx) since R3.
    expect(delivered[0].artifacts).toEqual([{ key: "k1", fileName: "screen.pdf", kind: "pdf" }]);
  });

  it("email to a non-allowlisted recipient fails the delivery job and never reaches the port", async () => {
    const sql = new StatefulAsyncSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const ctx = makeCtx(sql, {
      SCREENER_EMAIL_TO: "ops@example.com",
      SCREENER_EMAIL_ALLOWLIST: "someone-else@example.com",
    }, delivered);
    await runChain(ctx, sql);
    const emailRow = sql.rows.find((r) => r.capability === "followup.deliver" && r.channel === "email");
    expect(emailRow).toBeTruthy();
    await executeAsyncJob(ctx, { jobId: String(emailRow?.job_id) });
    const rec = getAsyncJob(ctx, String(emailRow?.job_id));
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toContain("allowlist");
    expect(delivered.filter((d) => d.channel === "email")).toHaveLength(0);
  });

  it("a skipped report yields deliveries that complete as skipped — and SPEAK the outcome (#1228)", async () => {
    const sql = new StatefulAsyncSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" }, delivered, notified);
    (ctx as { routeRequest: unknown }).routeRequest = async () =>
      new Response(JSON.stringify({ universe: "SP500", totalScanned: 5, matchedCount: 0, pdfStatus: "failed", pdfError: "render blew up" }), { status: 200 });
    await runChain(ctx, sql);
    const deliveryRow = sql.rows.find((r) => r.capability === "followup.deliver");
    expect(deliveryRow).toBeTruthy();
    await executeAsyncJob(ctx, { jobId: String(deliveryRow?.job_id) });
    const rec = getAsyncJob(ctx, String(deliveryRow?.job_id));
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toMatchObject({ status: "skipped", noticeSent: true });
    expect((rec?.result as { reason?: string }).reason).toContain("[FAILURE_REPORT_PDF_GENERATION]");
    expect((rec?.result as { reason?: string }).reason).toContain("render blew up");
    expect(delivered).toHaveLength(0);
    // #1228: the delivery was the completion message on this channel,
    // so the skipped delivery announces the outcome + reason itself.
    expect(notified).toHaveLength(1);
    expect(notified[0].channel).toBe("slack");
    // #1252: the skip reason now carries its catalog code (FAILURE_REPORT_PDF_GENERATION).
    expect(notified[0].text).toContain("No report is attached: [FAILURE_REPORT_PDF_GENERATION]");
    expect(notified[0].text).toContain("render blew up");
  });
});

describe("inline-suppression wiring pins", () => {
  it("orchestrator passes the async job id into both screener route contexts", () => {
    // #2942: both screener route contexts are built in orchestrator/routeRequest.ts.
    const src = readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8");
    const occurrences = src.split('asyncJobId: request.headers.get("x-async-job-id")').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
  it("the stock screen route defers publishing when running as a job", () => {
    const src = readFileSync("src/agents/routes/etradeBrokerScreen.ts", "utf8");
    expect(src).toContain("ctx.asyncJobId");
    expect(src).toContain("publishManualScreenerRun");
  });
  it("the options screen defers its Slack delivery when running as a job", () => {
    const src = readFileSync("src/agents/routes/etradeOptionsScreen.ts", "utf8");
    expect(src).toContain("deferDelivery");
  });
});

describe("delivery blocking audit (#2178 S2)", () => {
  it("a sent delivery audits the claim before the job completes as sent", async () => {
    const sql = new StatefulAsyncSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const created: any[] = [];
    const ctx = makeCtx(
      sql,
      { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
      delivered,
      [],
      { create: (record: any) => { created.push(record); return record; } },
    );
    await runChain(ctx, sql);
    const deliveries = sql.rows.filter((r) => r.capability === "followup.deliver");
    expect(deliveries).toHaveLength(2);
    for (const d of deliveries) {
      await executeAsyncJob(ctx, { jobId: String(d.job_id) });
      expect(getAsyncJob(ctx, String(d.job_id))?.status).toBe("completed");
    }
    const claims = created.filter((r) => r.type === "followup.delivered");
    expect(claims).toHaveLength(2);
    expect(claims.map((r) => r.payload.channel).sort()).toEqual(["email", "slack"]);
    expect(claims[0].payload.jobId).toBeTruthy();
    expect(claims[0].sessionId).toBeTruthy();
  });

  it("a throwing audit store fails the delivery job instead of reporting an unrecorded sent", async () => {
    const sql = new StatefulAsyncSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const ctx = makeCtx(
      sql,
      { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
      delivered,
    );
    await runChain(ctx, sql);
    const delivery = sql.rows.find((r) => r.capability === "followup.deliver");
    expect(delivery).toBeTruthy();
    // Swap in the throwing repo only for the delivery execution: the
    // chain itself (main + report) never needed the ORM.
    (ctx as any).getOrm = () => ({
      events: { create: () => { throw new Error("audit store unavailable"); } },
    });
    await executeAsyncJob(ctx, { jobId: String(delivery!.job_id) });
    // The port still ran (the recipient may already have the
    // artifact) — but the job must NOT read as a successful sent.
    expect(delivered).toHaveLength(1);
    expect(getAsyncJob(ctx, String(delivery!.job_id))?.status).toBe("failed");
  });
});
