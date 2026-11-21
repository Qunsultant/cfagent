// @vitest-environment node
/**
 * Issue #4782 S3 — wire the pipeline settings map at the live call
 * sites + make jitterRatio overridable + externalize the poll
 * interval (re-scoped to the live intervals).
 *
 * Pins, in the S2 style:
 * - asyncJobs: a `pipeline.*` settings change flips the
 *   followup.deliver / followup.notify gates (the two named sites),
 *   read through the per-login `ctx.readSettingRaw`.
 * - engine: a control built with env resolves its stage retry
 *   budget from env (the "no env at all" gap), settings beat env,
 *   and an explicit policy still wins.
 * - report paths: the goal-screen artifact retries follow the
 *   settings map passed in (the seam the per-login callers use).
 *
 * The asyncJobs harness is the stateful fake from
 * tests/screener_followup_notifications.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { generateAndStoreGoalScreenArtifacts } from "../src/services/goalScreenReports";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";

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

function makeCtx(
  sql: StatefulAsyncSql,
  env: Record<string, unknown>,
  notified: Array<{ channel: string; text: string }>,
  settings: Record<string, string> = {},
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env,
    agentCtx: { storage: { sql: storage } },
    readSettingRaw: (key: string) => settings[key] ?? null,
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => ({ events: { create: () => ({}) } }),
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

async function runMainJob(ctx: AsyncJobsContext): Promise<void> {
  const main = await submitAsyncJob(ctx, {
    capability: "http.request",
    payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
  });
  await executeAsyncJob(ctx, { jobId: main.jobId });
}

describe("asyncJobs settings map (#4782 S3 — the two named sites)", () => {
  it("a settings change flips the notify gate: slack off in settings skips the slack notice", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified, { "pipeline.notify.slack": "0" });
    await runMainJob(ctx);
    const started = notifyRows(sql, "started");
    expect(started.map((r) => r.channel)).toEqual(["slack", "email"]);
    await executeAsyncJob(ctx, { jobId: String(started[0].job_id) });
    expect(getAsyncJob(ctx, String(started[0].job_id))?.result).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("Pipeline policy disables started notifications on slack"),
    });
    expect(notified).toEqual([]);
    // The email notice on the same event is unaffected.
    await executeAsyncJob(ctx, { jobId: String(started[1].job_id) });
    expect(getAsyncJob(ctx, String(started[1].job_id))?.result).toMatchObject({ status: "notified" });
    expect(notified).toHaveLength(1);
    expect(notified[0].channel).toBe("email");
  });

  it("settings beat env at the notify gate", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(
      sql,
      { ...ENV, PIPELINE_NOTIFY_SLACK: "1" },
      notified,
      { "pipeline.notify.slack": "0" },
    );
    await runMainJob(ctx);
    const started = notifyRows(sql, "started");
    await executeAsyncJob(ctx, { jobId: String(started[0].job_id) });
    expect(getAsyncJob(ctx, String(started[0].job_id))?.result).toMatchObject({ status: "skipped" });
    expect(notified).toEqual([]);
  });

  it("without settings the notify gate stays env-only (unchanged behavior)", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified, {});
    await runMainJob(ctx);
    const started = notifyRows(sql, "started");
    await executeAsyncJob(ctx, { jobId: String(started[0].job_id) });
    expect(getAsyncJob(ctx, String(started[0].job_id))?.result).toMatchObject({
      status: "notified",
      event: "started",
    });
    expect(notified[0].channel).toBe("slack");
  });

  it("a settings change flips the deliver gate: master off skips the delivery", async () => {
    const sql = new StatefulAsyncSql();
    const notified: Array<{ channel: string; text: string }> = [];
    const ctx = makeCtx(sql, ENV, notified, { "pipeline.notifications.enabled": "0" });
    await runMainJob(ctx);
    const reportRow = sql.rows.find((r) => r.capability === "followup.report");
    await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
    const deliveryRow = sql.rows.find((r) => r.capability === "followup.deliver" && r.channel === "slack");
    await executeAsyncJob(ctx, { jobId: String(deliveryRow?.job_id) });
    expect(getAsyncJob(ctx, String(deliveryRow?.job_id))?.result).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("Pipeline policy disables completed-run deliveries on slack"),
    });
  });
});

describe("engine env/settings policy (#4782 S3 — the load-bearing wiring)", () => {
  async function runFlaky(env?: Record<string, unknown>, settings?: Record<string, string | undefined>) {
    let calls = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("flaky", async () => {
      calls += 1;
      throw new Error("transient boom");
    });
    const control = createJobPipelineControl({
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      ...(env ? { env } : {}),
      ...(settings ? { settings } : {}),
      newRunId: () => "run-flaky",
    });
    await control.defineJob({
      jobId: "flaky-job",
      root: { kind: "dummy", steps: [{ step: "flaky" }], executionMode: { delivery: "sync" } },
    });
    const outcome = await control.runJob("flaky-job");
    return { outcome, calls };
  }

  const FAST = {
    PIPELINE_RETRY_BASE_DELAY_MS: "1",
    PIPELINE_RETRY_MAX_DELAY_MS: "1",
    PIPELINE_RETRY_JITTER_RATIO: "0",
  };

  it("no env, no settings: the report bucket default (2 attempts) applies", async () => {
    const { outcome, calls } = await runFlaky({ ...FAST });
    expect(outcome.state).toBe("failed");
    expect(calls).toBe(2);
  });

  it("env resolves the stage retry budget (the engine no longer ignores env)", async () => {
    const { outcome, calls } = await runFlaky({
      ...FAST,
      PIPELINE_REPORT_RETRY_ATTEMPTS: "1",
    });
    expect(outcome.state).toBe("failed");
    expect(calls).toBe(1);
    const { calls: calls3 } = await runFlaky({
      ...FAST,
      PIPELINE_REPORT_RETRY_ATTEMPTS: "3",
    });
    expect(calls3).toBe(3);
  });

  it("settings beat env at the engine", async () => {
    const { calls } = await runFlaky(
      { ...FAST, PIPELINE_REPORT_RETRY_ATTEMPTS: "3" },
      { "pipeline.retry.report.attempts": "1" },
    );
    expect(calls).toBe(1);
  });

  it("an explicit policy still wins over env", async () => {
    let calls = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("flaky", async () => {
      calls += 1;
      throw new Error("transient boom");
    });
    const { resolvePipelinePolicy } = await import("../src/services/pipelinePolicy");
    const policy = resolvePipelinePolicy();
    policy.retry.report = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
    const control = createJobPipelineControl({
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      env: { ...FAST, PIPELINE_REPORT_RETRY_ATTEMPTS: "3" },
      policy,
      newRunId: () => "run-flaky",
    });
    await control.defineJob({
      jobId: "flaky-job",
      root: { kind: "dummy", steps: [{ step: "flaky" }], executionMode: { delivery: "sync" } },
    });
    const outcome = await control.runJob("flaky-job");
    expect(outcome.state).toBe("failed");
    expect(calls).toBe(1);
  });
});

function emptyGoalResult(): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: [],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [],
    counts: {
      stocksScanned: 6604,
      stocksMatched: 0,
      optionsUnderlyingsScanned: 1,
      optionsContractsMatched: 0,
      hits: 0,
    },
  } as unknown as GoalDrivenScreenResult;
}

describe("report-path settings seam (#4782 S3)", () => {
  it("goal-screen artifact retries follow the settings map passed in", async () => {
    let puts = 0;
    const storage = {
      get: async () => undefined,
      put: async () => {
        puts += 1;
        throw new Error("store down");
      },
    };
    const env = {
      PIPELINE_RETRY_BASE_DELAY_MS: "1",
      PIPELINE_RETRY_MAX_DELAY_MS: "1",
      PIPELINE_RETRY_JITTER_RATIO: "0",
    };
    const out1 = await generateAndStoreGoalScreenArtifacts(env, storage as never, emptyGoalResult(), {
      "pipeline.retry.report.attempts": "1",
    });
    expect(out1.pdfStatus).toBe("failed");
    expect(puts).toBe(3); // 3 formats x 1 attempt, no retries
    puts = 0;
    const out2 = await generateAndStoreGoalScreenArtifacts(env, storage as never, emptyGoalResult(), {
      "pipeline.retry.report.attempts": "2",
    });
    expect(out2.pdfStatus).toBe("failed");
    expect(puts).toBe(6); // 3 formats x 2 attempts
  });

  it("without settings the goal-screen retries stay env-only", async () => {
    let puts = 0;
    const storage = {
      get: async () => undefined,
      put: async () => {
        puts += 1;
        throw new Error("store down");
      },
    };
    const out = await generateAndStoreGoalScreenArtifacts(
      {
        PIPELINE_RETRY_BASE_DELAY_MS: "1",
        PIPELINE_RETRY_MAX_DELAY_MS: "1",
        PIPELINE_RETRY_JITTER_RATIO: "0",
        PIPELINE_REPORT_RETRY_ATTEMPTS: "1",
      },
      storage as never,
      emptyGoalResult(),
    );
    expect(out.pdfStatus).toBe("failed");
    expect(puts).toBe(3);
  });
});
