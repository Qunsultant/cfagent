/**
 * Issue #1191 (#1173 R3): notification completeness.
 *
 * Pins: outcomes carry the XLSX artifact from every adapter (event,
 * run result, http job); the report sub-job adopts it; the delivery
 * port attaches text + PDF + XLSX (email MIME carries both files
 * with their content types); the pipeline policy gates deliveries
 * and lifecycle notifications per channel+event (explicit 'skipped',
 * never silent); run deliveries send immediately even with the #277
 * gate on (#1347); lifecycle notifications plan per-task override
 * channels too.
 */
import { describe, expect, it } from "vitest";
import {
  formatHeldNotification,
  planLifecycleNotifications,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromEvent,
  screenerOutcomeFromHttpJob,
  screenerOutcomeFromRunResult,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import { MockD1Database } from "./mock-d1";
import { parseStockScreenRequest } from "../src/trading/screeningSchemas";
import type { ScreenerEvent } from "../src/events/screenerEvents";

const outcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "manual",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  xlsxKey: "x1",
  xlsxStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

describe("outcome adapters carry the XLSX artifact", () => {
  it("from a bus event", () => {
    const event = {
      type: "screener.completed",
      timestamp: "2026-10-23T09:00:00Z",
      universe: "NASDAQ100",
      pdfKey: "k1",
      pdfStatus: "generated",
      xlsxKey: "x1",
      xlsxStatus: "generated",
      csvKey: "c1",
      csvStatus: "generated",
      csvError: undefined,
      sector: "ALL",
      totalScanned: 50,
      matchedCount: 2,
      opportunities: [],
    } as unknown as ScreenerEvent;
    const o = screenerOutcomeFromEvent(event);
    expect(o.xlsxKey).toBe("x1");
    expect(o.xlsxStatus).toBe("generated");
    expect(o.csvKey).toBe("c1");
    expect(o.csvStatus).toBe("generated");
  });

  it("from a run result and from an http job body", () => {
    const o = screenerOutcomeFromRunResult("stock", {
      success: true, pdfKey: "k1", pdfStatus: "generated",
      xlsxKey: "x1", xlsxStatus: "generated", xlsxError: undefined,
    });
    expect(o.xlsxKey).toBe("x1");
    const h = screenerOutcomeFromHttpJob(
      "/api/etrade/screen",
      200,
      JSON.stringify({ universe: "NASDAQ100", pdfKey: "k1", pdfStatus: "generated", xlsxKey: "x1", xlsxStatus: "generated", matchedCount: 2, totalScanned: 50 }),
    );
    expect(h?.xlsxKey).toBe("x1");
    expect(h?.xlsxStatus).toBe("generated");
  });
});

describe("lifecycle planner honors per-task override channels", () => {
  it("plans notifications for override-only destinations", () => {
    const config = resolveScreenerFollowupConfig({});
    expect(config.channels.slack.configured).toBe(false);
    expect(config.channels.email.configured).toBe(false);
    const withOverrides: ScreenerRunOutcome = {
      ...outcome, emailTo: "owner@example.com", slackChannel: "C123",
    };
    const specs = planLifecycleNotifications("failed", withOverrides, config, "m", "u");
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email"]);
    const bare = planLifecycleNotifications("failed", outcome, config, "m", "u");
    expect(bare).toEqual([]);
  });
});

describe("formatHeldNotification", () => {
  it("announces the hold with the report summary and the remedy", () => {
    const text = formatHeldNotification(outcome);
    expect(text).toContain("held for approval");
    expect(text).toContain("NASDAQ100");
    expect(text).toContain("2 matched");
    expect(text).toContain("Reports panel");
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

interface Harness {
  ctx: AsyncJobsContext;
  notified: Array<{ channel: string; text: string }>;
  delivered: Array<{ channel: string }>;
  confirmations: string[];
}

function makeCtx(sql: StatefulAsyncSql, env: Record<string, unknown>, opts?: { hitl?: boolean }): Harness {
  const notified: Harness["notified"] = [];
  const delivered: Harness["delivered"] = [];
  const confirmations: string[] = [];
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const ctx = {
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
      deliver: async (input: { channel: string }) => {
        delivered.push({ channel: input.channel });
        return { ok: true, detail: "sent-1" };
      },
      notify: async (input: { channel: string; text: string }) => {
        notified.push({ channel: input.channel, text: input.text });
        return { ok: true };
      },
    }),
    reportDispatchHitlEnabled: () => opts?.hitl === true,
    createScreenerConfirmation: (payloadJson: string) => {
      confirmations.push(payloadJson);
      return "rc_held_1";
    },
  } as unknown as AsyncJobsContext;
  return { ctx, notified, delivered, confirmations };
}

const ENV = { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" };

describe("executor: policy gates + xlsx adoption + immediate delivery", () => {
  it("the report sub-job adopts the XLSX artifact next to the PDF", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx } = makeCtx(sql, ENV);
    const job = await submitAsyncJob(ctx, {
      capability: "followup.report",
      payload: { outcome, userLogin: "alice" },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    const result = getAsyncJob(ctx, job.jobId)?.result as { status: string; artifacts: Array<{ key: string; kind?: string }> };
    expect(result.status).toBe("ready");
    expect(result.artifacts).toEqual([
      { key: "k1", fileName: "screen.pdf", kind: "pdf" },
      { key: "x1", fileName: "screener-report.xlsx", kind: "xlsx" },
    ]);
  });

  it("a policy-off lifecycle event completes the notify job as 'skipped' without sending", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx, notified } = makeCtx(sql, { ...ENV, PIPELINE_NOTIFY_EVENTS: "failed" });
    const job = await submitAsyncJob(ctx, {
      capability: "followup.notify",
      payload: { event: "completed", outcome, userLogin: "alice", channel: "slack" },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    expect(getAsyncJob(ctx, job.jobId)?.result).toMatchObject({ status: "skipped" });
    expect(notified).toHaveLength(0);
  });

  it("a delivery sends immediately even with HITL on (#1347: no hold for runs)", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx, notified, delivered, confirmations } = makeCtx(sql, ENV, { hitl: true });
    const job = await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: { outcome, userLogin: "alice", channel: "slack", artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }] },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    expect(getAsyncJob(ctx, job.jobId)?.result).toMatchObject({ status: "sent", channel: "slack" });
    expect(confirmations).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(notified).toHaveLength(0);
  });
});

describe("delivery port: email carries text + PDF + XLSX", () => {
  it("attaches both artifacts with their content types in one MIME message", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => ({ bytes: new TextEncoder().encode("XLSXBYTES"), fileName: "screen.xlsx" }),
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [
        { key: "k1", fileName: "screen.pdf", kind: "pdf" },
        { key: "x1", fileName: "screen.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(mime).toContain("screen.pdf");
    expect(mime).toContain("screen.xlsx");
    expect(mime).toContain("application/pdf");
    expect(mime).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("options deliveries attach PDF + XLSX too (#1195 R3b)", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => null,
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => ({ bytes: new TextEncoder().encode("OPDF"), fileName: "options.pdf" }),
      getOptionsXlsxByKey: async () => ({ bytes: new TextEncoder().encode("OXLSX"), fileName: "options.xlsx" }),
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const optionsOutcome: ScreenerRunOutcome = {
      kind: "options",
      trigger: "manual",
      success: true,
      pdfKeys: ["ok1"],
      pdfStatus: "generated",
      xlsxKey: "ox1",
      xlsxStatus: "generated",
      matchedCount: 4,
      totalScanned: 12,
      thesis: "bullish",
    };
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome: optionsOutcome,
      artifacts: [
        { key: "ok1", fileName: "options.pdf", kind: "pdf" },
        { key: "ox1", fileName: "options.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(mime).toContain("options.pdf");
    expect(mime).toContain("options.xlsx");
  });

  it("a missing XLSX is reported in the detail, the PDF still sends", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [
        { key: "k1", fileName: "screen.pdf", kind: "pdf" },
        { key: "x1", fileName: "screen.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("x1");
    expect(mime).toContain("screen.pdf");
    expect(mime).not.toContain("screen.xlsx");
  });

  it("issue #1941: returns ok:false (and spawns no delivered receipt) when neither cfpay nor env.EMAIL binding is present", async () => {
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();

    const notifyRes = await port.notify({
      channel: "email",
      userLogin: "alice",
      text: "Screen completed",
    });
    expect(notifyRes.ok).toBe(false);
    expect(notifyRes.error).toBeTruthy();

    // End-to-end executor proof: a failed email deliver job records status 'failed'
    // and never schedules a 'delivered' lifecycle notification receipt.
    const sql = new StatefulAsyncSql();
    const { ctx } = makeCtx(sql, env);
    (ctx as unknown as { followupDeliveryPort: () => ReturnType<typeof createFollowupDeliveryPort> }).followupDeliveryPort = () => port;
    const job = await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: {
        outcome,
        userLogin: "alice",
        channel: "email",
        artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }],
      },
      parentJobId: "main-1941",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    const failedJob = getAsyncJob(ctx, job.jobId);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.error).toContain("[FAILURE_DELIVERY_CHANNEL_FAILED]");
    const deliveredReceipts = sql.rows.filter((r) => {
      if (r.capability !== "followup.notify") return false;
      const p = JSON.parse(String(r.payload_json)) as { event?: string };
      return p.event === "delivered";
    });
    expect(deliveredReceipts).toHaveLength(0);
  });

  it("issue #1941: returns ok:false when env.EMAIL.send throws (provider failure)", async () => {
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async () => {
          throw new Error("SMTP upstream rejected message");
        },
      },
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("issue #1941: delivers email + attachments via cfpay A2A when CFPAY_A2A_TOKEN is configured (even without env.EMAIL)", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          result: {
            artifacts: [{ parts: [{ kind: "data", data: { ok: true, messageId: "a2a-msg-1" } }] }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const env = {
        SCREENER_EMAIL_TO: "ops@example.com",
        CFPAY_A2A_TOKEN: "test-a2a-token",
        CFPAY_URL: "https://pay.openaimp.com",
      };
      const agent = {
        getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
        getXlsxByKey: async () => ({ bytes: new TextEncoder().encode("XLSXBYTES"), fileName: "screen.xlsx" }),
        getOptionsPdfByKey: async () => null,
      };
      const port = createFollowupDeliveryPort({
        env: env as never,
        getOrm: () => ({}) as never,
        getScreenerAgent: () => agent as never,
      });
      const res = await port.deliver({
        channel: "email",
        userLogin: "alice",
        outcome,
        artifacts: [
          { key: "k1", fileName: "screen.pdf", kind: "pdf" },
          { key: "x1", fileName: "screen.xlsx", kind: "xlsx" },
        ],
      });
      expect(res.ok).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe("https://pay.openaimp.com/a2a/email");
      const dataPart = ((fetchCalls[0].body.params as any).message.parts[0].data) as {
        operation: string;
        to: string;
        attachments: Array<{ filename: string; contentType: string }>;
      };
      expect(dataPart.operation).toBe("email.sendWithAttachments");
      expect(dataPart.to).toBe("ops@example.com");
      expect(dataPart.attachments.map((a) => a.filename)).toEqual(["screen.pdf", "screen.xlsx"]);

      const notifyRes = await port.notify({
        channel: "email",
        userLogin: "alice",
        text: "Screen completed",
      });
      expect(notifyRes.ok).toBe(true);
      expect(fetchCalls).toHaveLength(2);
      const notifyData = ((fetchCalls[1].body.params as any).message.parts[0].data) as {
        operation: string;
        to: string;
      };
      expect(notifyData.operation).toBe("email.send");
      expect(notifyData.to).toBe("ops@example.com");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("issue #1941: falls back to env.EMAIL when cfpay A2A returns ok:false, and resolves OPTIONS_EMAIL_TO fallback", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            artifacts: [{ parts: [{ kind: "data", data: { ok: false, error: "cfpay unavailable" } }] }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      let mime = "";
      const env = {
        OPTIONS_EMAIL_TO: "fallback@example.com",
        CFPAY_A2A_TOKEN: "test-a2a-token",
        EMAIL: {
          send: async (body: ReadableStream) => {
            mime = await new Response(body).text();
          },
        },
      };
      const cfg = resolveScreenerFollowupConfig(env);
      expect(cfg.channels.email.configured).toBe(true);
      expect(cfg.channels.email.to).toBe("fallback@example.com");

      const agent = {
        getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
        getXlsxByKey: async () => null,
        getOptionsPdfByKey: async () => null,
      };
      const port = createFollowupDeliveryPort({
        env: env as never,
        getOrm: () => ({}) as never,
        getScreenerAgent: () => agent as never,
      });
      const res = await port.deliver({
        channel: "email",
        userLogin: "alice",
        outcome,
        artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }],
      });
      expect(res.ok).toBe(true);
      expect(mime).toContain("To: <fallback@example.com>");
      expect(mime).toContain("screen.pdf");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("issue #1941: parseStockScreenRequest separates emailTo from filters and screenerOutcomeFromRunResult preserves emailTo", () => {
    const parsed = parseStockScreenRequest({
      universe: "NASDAQ100",
      minPrice: 20,
      emailTo: "override@example.com",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.emailTo).toBe("override@example.com");
    expect("emailTo" in parsed.value.filters).toBe(false);

    const runOutcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      totalScanned: 5,
      matchedCount: 0,
      emailTo: parsed.value.emailTo,
    });
    expect(runOutcome.emailTo).toBe("override@example.com");
  });
});
