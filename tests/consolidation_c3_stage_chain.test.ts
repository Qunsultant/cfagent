/**
 * Consolidation C3 (issue #1277, epic #1151) — stage-layered
 * scheduling, the C3 portion of #1236.
 *
 * What is pinned here:
 *  - `stageChain` schedule-payload config: validated by the one shared
 *    builder (buildSchedulePayload) for autonomousMarketScreen;
 *    rejected for callbacks whose runs do not ride the follow-up
 *    bridge in C3 — SUPERSEDED in C4 (#1329), which accepts it on
 *    options/discovery/goal (see the C4 acceptance test in this file
 *    and tests/consolidation_c4_pipeline_chain.test.ts); absent ⇒
 *    payload unchanged (the degenerate case).
 *  - The async-job substrate gains per-stage timing: a job submitted
 *    with `runAt` is armed at the remaining delay, never executes
 *    before its not-before time (executor guard), and recovery
 *    re-arms honor the remaining delay.
 *  - Chain planning: with a stage chain on the run outcome, the
 *    bridge stamps the main job as stage `generate` and the report /
 *    delivery sub-jobs as stages `serve` / `deliver` under one
 *    chain_id, each with its own runAt. Completing serve schedules
 *    deliver exactly once; a hard failure at serve stops the chain
 *    (no deliveries) and the stop point is visible.
 *  - Per-stage retry: a failed stage job is resubmitted from its
 *    recorded payload (no upstream re-execution), the chain resumes,
 *    and a duplicate active retry is refused.
 *  - Stage status: job records expose stage / chainId / notBefore;
 *    buildStageChainView projects ordered per-stage statuses with
 *    reasons; stage transitions land in the screening activity log.
 *  - Honesty: a missing upstream artifact completes serve as
 *    `skipped` with the reason and the deliveries carry the skip
 *    reason — never a silent success.
 *
 * Feed and store as independently schedulable stage jobs are the C4
 * remainder of #1236 (recorded on #1277) and are NOT pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  buildSchedulePayload,
  type StageChainConfig,
} from "../src/trading/screeningSchemas";
import {
  planDeliveryFollowups,
  planInitialFollowups,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  listAsyncJobs,
  recordScreenerRunMainJob,
  recoverQueuedAsyncJobs,
  retryAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { buildStageChainView } from "../src/services/stageChain";
import { listScreeningActivity } from "../src/services/screeningActivity";
import { MockD1Database } from "./mock-d1";

/* ------------------------------------------------------------------ */
/* Stateful fake SQL: mas_async_jobs with status-guard honoring, plus  */
/* the screening-activity table (generic INSERT/SELECT).               */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

class C3FakeSql {
  tables: Record<string, Row[]> = { mas_async_jobs: [], mas_screening_activity: [] };

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Row> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Row[], rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    const tableMatch = q.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    const table = tableMatch?.[1] ?? "";
    if (/^DELETE FROM/i.test(q)) return wrap([]);
    if (/^INSERT INTO/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Row = {};
      let ai = 0;
      cols.forEach((col, i) => {
        row[col] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      });
      (this.tables[table] ??= []).push(row);
      return wrap([], 1);
    }
    if (/^UPDATE/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assigns = setPart.split(",").map((s) => s.trim());
      let ai = 0;
      const updates: Array<[string, unknown]> = assigns.map((a) => {
        const eq = a.indexOf("=");
        const col = a.slice(0, eq).trim();
        const expr = a.slice(eq + 1).trim();
        return [col, expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "")] as [string, unknown];
      });
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      const conds: Array<[string, unknown]> = [];
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) conds.push([m[1], m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "")]);
      }
      let written = 0;
      for (const row of this.tables[table] ?? []) {
        if (conds.every(([c, v]) => row[c] === v)) {
          for (const [col, val] of updates) row[col] = val;
          written++;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM (\w+)/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...(this.tables[listMatch[2]] ?? [])];
      const wherePart = (q.split(/ WHERE /i)[1] ?? "").split(/ ORDER BY /i)[0];
      let ai = 0;
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) {
          const val = m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[m[1]] === val);
        }
      }
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/ORDER BY created_at ASC/i.test(q)) rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const limitMatch = q.match(/LIMIT (\?|\d+)/i);
      if (limitMatch) {
        const n = limitMatch[1] === "?" ? Number(args[ai++]) : Number(limitMatch[1]);
        if (Number.isFinite(n)) rows = rows.slice(0, n);
      }
      return wrap(rows.map((row) => {
        const out: Row = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      }));
    }
    throw new Error(`C3FakeSql: unsupported: ${q.slice(0, 90)}`);
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }
}

interface ScheduleCall {
  when: unknown;
  callback: string;
  payload: unknown;
  options: unknown;
}

function makeCtx(sql: C3FakeSql, overrides?: Partial<AsyncJobsContext>): {
  ctx: AsyncJobsContext;
  scheduleCalls: ScheduleCall[];
} {
  const scheduleCalls: ScheduleCall[] = [];
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const ctx = {
    // #6102: a successful followup.deliver audits followup.delivered
    // through the blocking helper, resolved from env.AGENT_DB — a
    // fresh mock per ctx (the port is memoized per env object).
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com", AGENT_DB: new MockD1Database() },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async (when: unknown, callback: string, payload: unknown, options: unknown) => {
      scheduleCalls.push({ when, callback, payload, options });
      return {};
    },
    audit: () => {},
    // Issue #2178 (Q7 S2): followup.deliver jobs now audit their
    // claim through the ORM events repo — no-op here, as before.
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
      deliver: async () => ({ ok: true, detail: "sent-1" }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
    ...overrides,
  } as unknown as AsyncJobsContext;
  return { ctx, scheduleCalls };
}

const followupConfig = resolveScreenerFollowupConfig({
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
  SCREENER_EMAIL_TO: "ops@example.com",
});

const plainOutcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "scheduled",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

const chainConfig: StageChainConfig = { serveDelaySeconds: 120, deliverDelaySeconds: 3600 };
const chainedOutcome: ScreenerRunOutcome = { ...plainOutcome, stageChain: chainConfig };

/* ------------------------------------------------------------------ */
/* Schedule-payload validation                                         */
/* ------------------------------------------------------------------ */

describe("stageChain in buildSchedulePayload", () => {
  const identity = { userLogin: "alice", environment: "PROD", trigger: "scheduled" as const };

  it("passes a valid stageChain through for autonomousMarketScreen", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", stageChain: { serveDelaySeconds: 60, deliverDelaySeconds: 3600 } },
      identity,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.stageChain).toEqual({ serveDelaySeconds: 60, deliverDelaySeconds: 3600 });
      expect(built.value.trigger).toBe("scheduled");
    }
  });

  it("rejects out-of-range and non-integer stage delays", () => {
    for (const bad of [
      { serveDelaySeconds: -1 },
      { deliverDelaySeconds: 604_801 },
      { serveDelaySeconds: 1.5 },
      { serveDelaySeconds: "60" },
    ]) {
      const built = buildSchedulePayload(
        "autonomousMarketScreen",
        { universe: "NASDAQ100", stageChain: bad },
        identity,
      );
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error).toContain("stageChain");
    }
  });

  it("accepts stageChain for callbacks the chain carries in C4 (supersedes the C3 rejection)", () => {
    // Consolidation C4 (#1329) extends stage-chaining beyond
    // market screens: options chains fully in chain mode, discovery
    // and goal chains carry identity + the serve stage. The C3
    // rejection above is superseded — these payloads now build.
    for (const callback of ["autonomousOptionsAnalysis", "autonomousStrategyDiscovery", "autonomousGoalScreen"]) {
      const criteria =
        callback === "autonomousOptionsAnalysis"
          ? { symbols: ["AAA"], stageChain: { serveDelaySeconds: 0 } }
          : callback === "autonomousGoalScreen"
            ? { goalKind: "income", stageChain: { serveDelaySeconds: 0 } }
            : { inputModel: "no-view", constraintSets: [{ symbol: "AAA" }], stageChain: { serveDelaySeconds: 0 } };
      const built = buildSchedulePayload(callback, criteria, identity);
      // Discovery no-view sets still validate on their own fields;
      // the assertion is that stageChain is not the rejection.
      if (!built.ok) expect(built.error).not.toContain("stageChain");
      else expect(built.value.stageChain).toEqual({ serveDelaySeconds: 0 });
    }
  });

  it("leaves the payload byte-identical when no stageChain is given (degenerate case)", () => {
    const withOut = buildSchedulePayload("autonomousMarketScreen", { universe: "NASDAQ100" }, identity);
    expect(withOut.ok).toBe(true);
    if (withOut.ok) expect("stageChain" in withOut.value).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Planner stamping                                                    */
/* ------------------------------------------------------------------ */

describe("stage-chain planner stamping", () => {
  const nowIso = "2026-10-24T00:00:00.000Z";

  it("stamps the report spec as stage serve with chain id and runAt", () => {
    const specs = planInitialFollowups(chainedOutcome, followupConfig, "main-1", "alice", {
      chainId: "chain-1",
      nowIso,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].stage).toBe("serve");
    expect(specs[0].chainId).toBe("chain-1");
    expect(specs[0].runAt).toBe("2026-10-24T00:02:00.000Z");
    // The chain config rides the serve payload so the deliver hop can
    // read its own delay from the completed stage's record.
    expect((specs[0].payload as { stageChain?: unknown }).stageChain).toEqual(chainConfig);
  });

  it("stamps delivery specs as stage deliver with their own runAt", () => {
    const specs = planDeliveryFollowups(
      chainedOutcome,
      followupConfig,
      { status: "ready", artifacts: [{ key: "k1", fileName: "screen.pdf" }] },
      "main-1",
      "alice",
      { chainId: "chain-1", nowIso },
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.stage).toBe("deliver");
      expect(spec.chainId).toBe("chain-1");
      expect(spec.runAt).toBe("2026-10-24T01:00:00.000Z");
      expect(spec.parentJobId).toBe("main-1");
    }
  });

  it("plans byte-identical legacy specs when no chain is configured", () => {
    const reportSpecs = planInitialFollowups(plainOutcome, followupConfig, "main-1", "alice");
    expect(reportSpecs).toHaveLength(1);
    expect(reportSpecs[0]).not.toHaveProperty("stage");
    expect(reportSpecs[0]).not.toHaveProperty("chainId");
    expect(reportSpecs[0]).not.toHaveProperty("runAt");
    const deliverySpecs = planDeliveryFollowups(
      plainOutcome,
      followupConfig,
      { status: "ready", artifacts: [{ key: "k1", fileName: "screen.pdf" }] },
      "main-1",
      "alice",
    );
    expect(deliverySpecs.length).toBeGreaterThan(0);
    for (const spec of deliverySpecs) {
      expect(spec).not.toHaveProperty("stage");
      expect(spec).not.toHaveProperty("runAt");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Substrate: not-before timing                                        */
/* ------------------------------------------------------------------ */

describe("async-job not-before substrate", () => {
  it("arms a runAt job at the remaining delay and records not_before / stage / chain", async () => {
    const sql = new C3FakeSql();
    const { ctx, scheduleCalls } = makeCtx(sql);
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const { jobId } = await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: { outcome: plainOutcome, userLogin: "alice", channel: "slack", artifacts: [] },
      parentJobId: "main-1",
      jobKind: "delivery",
      channel: "slack",
      stage: "deliver",
      chainId: "chain-1",
      runAt,
    });
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0].callback).toBe("executeAsyncJob");
    expect(typeof scheduleCalls[0].when).toBe("number");
    expect(scheduleCalls[0].when as number).toBeGreaterThan(3500);
    expect(scheduleCalls[0].when as number).toBeLessThanOrEqual(3600);
    const record = getAsyncJob(ctx, jobId);
    expect(record?.stage).toBe("deliver");
    expect(record?.chainId).toBe("chain-1");
    expect(record?.notBefore).toBe(runAt);
    expect(record?.status).toBe("queued");
  });

  it("refuses to claim a job before its not-before time and re-arms the remainder", async () => {
    const sql = new C3FakeSql();
    const { ctx, scheduleCalls } = makeCtx(sql);
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const { jobId } = await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: { outcome: plainOutcome, userLogin: "alice", channel: "slack", artifacts: [{ key: "k1", fileName: "screen.pdf" }] },
      stage: "deliver",
      chainId: "chain-1",
      runAt,
    });
    scheduleCalls.length = 0;
    await executeAsyncJob(ctx, { jobId });
    expect(getAsyncJob(ctx, jobId)?.status).toBe("queued");
    // Re-armed for the remainder — not dropped, not run early.
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0].when as number).toBeGreaterThan(3500);

    // Time passes: the same job now executes.
    const row = sql.rows("mas_async_jobs").find((r) => r.job_id === jobId)!;
    row.not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId });
    expect(getAsyncJob(ctx, jobId)?.status).toBe("completed");
  });

  it("recovery re-arms a deferred queued job at its remaining delay, not immediately", async () => {
    const sql = new C3FakeSql();
    const { ctx, scheduleCalls } = makeCtx(sql);
    const runAt = new Date(Date.now() + 1800_000).toISOString();
    await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: { outcome: plainOutcome, userLogin: "alice", channel: "slack", artifacts: [] },
      stage: "deliver",
      chainId: "chain-1",
      runAt,
    });
    scheduleCalls.length = 0;
    await recoverQueuedAsyncJobs(ctx);
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0].when as number).toBeGreaterThan(1700);
    expect(scheduleCalls[0].when as number).toBeLessThanOrEqual(1800);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end chain over the executor                                  */
/* ------------------------------------------------------------------ */

describe("stage chain end-to-end (bridge → serve → deliver)", () => {
  it("chains with per-stage delays, exactly-once successors, and visible stage rows", async () => {
    const sql = new C3FakeSql();
    const { ctx } = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, chainedOutcome, "alice");

    const main = getAsyncJob(ctx, mainJobId);
    expect(main?.stage).toBe("generate");
    expect(main?.chainId).toBeTruthy();
    const chainId = main!.chainId!;

    const serveRow = sql.rows("mas_async_jobs").find((r) => r.capability === "followup.report");
    expect(serveRow).toBeTruthy();
    expect(serveRow?.stage).toBe("serve");
    expect(serveRow?.chain_id).toBe(chainId);
    expect(typeof serveRow?.not_before).toBe("string");
    expect(Date.parse(String(serveRow!.not_before))).toBeGreaterThan(Date.now() + 60_000);

    // Serve executes once its time arrives; a duplicate completion
    // event cannot plan the deliveries twice.
    (serveRow as Row).not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId: String(serveRow!.job_id) });
    await executeAsyncJob(ctx, { jobId: String(serveRow!.job_id) });
    const deliveries = sql.rows("mas_async_jobs").filter((r) => r.capability === "followup.deliver");
    expect(deliveries.map((d) => d.channel).sort()).toEqual(["email", "slack"]);
    for (const d of deliveries) {
      expect(d.stage).toBe("deliver");
      expect(d.chain_id).toBe(chainId);
      expect(d.parent_job_id).toBe(mainJobId);
      expect(Date.parse(String(d.not_before))).toBeGreaterThan(Date.now() + 3_000_000);
    }

    // The projected chain view: ordered stages with statuses.
    const view = buildStageChainView(listAsyncJobs(ctx, 100));
    expect(view).toHaveLength(1);
    expect(view[0].chainId).toBe(chainId);
    expect(view[0].stages.map((s) => s.stage)).toEqual(["generate", "serve", "deliver", "deliver"]);
    expect(view[0].stages.map((s) => s.status)).toEqual(["completed", "completed", "queued", "queued"]);
    expect(view[0].stoppedAt).toBeNull();

    // Stage transitions are in the screening activity log.
    const activity = listScreeningActivity(sql as never, "alice", 50);
    const stageEntries = activity.filter((e) => e.kind === "stage");
    expect(stageEntries.length).toBeGreaterThanOrEqual(2);
    expect(stageEntries.some((e) => e.summary.includes("serve"))).toBe(true);
  });

  it("a hard failure at serve stops the chain: no deliveries, stop point recorded", async () => {
    const sql = new C3FakeSql();
    // The artifact the outcome references is missing from storage:
    // the serve stage must fail explicitly (existing honesty rule).
    const { ctx } = makeCtx(sql, {
      followupReportPort: () => ({
        getStockPdf: async () => null,
        getOptionsPdf: async () => null,
      }),
    } as Partial<AsyncJobsContext>);
    const mainJobId = await recordScreenerRunMainJob(ctx, chainedOutcome, "alice");
    const serveRow = sql.rows("mas_async_jobs").find((r) => r.capability === "followup.report")!;
    (serveRow as Row).not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId: String(serveRow.job_id) });
    expect(getAsyncJob(ctx, String(serveRow.job_id))?.status).toBe("failed");
    expect(sql.rows("mas_async_jobs").filter((r) => r.capability === "followup.deliver")).toHaveLength(0);

    const view = buildStageChainView(listAsyncJobs(ctx, 100));
    expect(view).toHaveLength(1);
    expect(view[0].stoppedAt).toBe("serve");
    const serveStage = view[0].stages.find((s) => s.stage === "serve");
    expect(serveStage?.status).toBe("failed");
    expect(serveStage?.reason).toContain("missing from storage");
    expect(mainJobId).toBeTruthy();
  });

  it("missing-artifact honesty: serve completes skipped with reason; deliveries carry it", async () => {
    const sql = new C3FakeSql();
    const { ctx } = makeCtx(sql);
    const failedPdfOutcome: ScreenerRunOutcome = {
      ...chainedOutcome,
      pdfKeys: [],
      pdfStatus: "failed",
      pdfError: "PDF generation exploded",
    };
    await recordScreenerRunMainJob(ctx, failedPdfOutcome, "alice");
    const serveRow = sql.rows("mas_async_jobs").find((r) => r.capability === "followup.report")!;
    (serveRow as Row).not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId: String(serveRow.job_id) });
    const serve = getAsyncJob(ctx, String(serveRow.job_id));
    expect(serve?.status).toBe("completed");
    expect((serve?.result as { status?: string })?.status).toBe("skipped");
    const deliveries = sql.rows("mas_async_jobs").filter((r) => r.capability === "followup.deliver");
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      const payload = JSON.parse(String(d.payload_json)) as { skipReason?: string };
      expect(payload.skipReason).toContain("PDF generation exploded");
    }
    const view = buildStageChainView(listAsyncJobs(ctx, 100));
    const serveStage = view[0].stages.find((s) => s.stage === "serve");
    expect(serveStage?.status).toBe("skipped");
    expect(serveStage?.reason).toContain("PDF generation exploded");
  });

  it("the degenerate bridged run (no stageChain) records no stage metadata and plans no runAt", async () => {
    const sql = new C3FakeSql();
    const { ctx } = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, plainOutcome, "alice");
    const main = getAsyncJob(ctx, mainJobId);
    expect(main?.stage).toBeUndefined();
    expect(main?.chainId).toBeUndefined();
    const serveRow = sql.rows("mas_async_jobs").find((r) => r.capability === "followup.report");
    expect(serveRow?.stage ?? null).toBeNull();
    expect(serveRow?.not_before ?? null).toBeNull();
    expect(buildStageChainView(listAsyncJobs(ctx, 100))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Per-stage retry                                                     */
/* ------------------------------------------------------------------ */

describe("per-stage retry", () => {
  async function failedDeliverChain() {
    const sql = new C3FakeSql();
    let deliverAttempts = 0;
    const { ctx } = makeCtx(sql, {
      followupDeliveryPort: () => ({
        deliver: async () => {
          deliverAttempts++;
          return deliverAttempts === 1 ? { ok: false, error: "Slack webhook 500" } : { ok: true, detail: "sent-2" };
        },
        notify: async () => ({ ok: true }),
      }),
    } as Partial<AsyncJobsContext>);
    const mainJobId = await recordScreenerRunMainJob(ctx, chainedOutcome, "alice");
    const serveRow = sql.rows("mas_async_jobs").find((r) => r.capability === "followup.report")!;
    (serveRow as Row).not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId: String(serveRow.job_id) });
    const slackDeliver = sql
      .rows("mas_async_jobs")
      .find((r) => r.capability === "followup.deliver" && r.channel === "slack")!;
    (slackDeliver as Row).not_before = new Date(Date.now() - 1000).toISOString();
    await executeAsyncJob(ctx, { jobId: String(slackDeliver.job_id) });
    expect(getAsyncJob(ctx, String(slackDeliver.job_id))?.status).toBe("failed");
    return { sql, ctx, mainJobId, failedId: String(slackDeliver.job_id) };
  }

  it("resubmits the failed stage from its recorded payload and resumes the chain", async () => {
    const { sql, ctx, mainJobId, failedId } = await failedDeliverChain();
    const jobCountBefore = sql.rows("mas_async_jobs").length;
    const serveCountBefore = sql.rows("mas_async_jobs").filter((r) => r.capability === "followup.report").length;

    const { jobId: retryId } = await retryAsyncJob(ctx, failedId);
    expect(retryId).not.toBe(failedId);
    // No upstream re-execution: exactly one new job, and it is the
    // retried deliver stage itself.
    const rows = sql.rows("mas_async_jobs");
    expect(rows.length).toBe(jobCountBefore + 1);
    expect(rows.filter((r) => r.capability === "followup.report")).toHaveLength(serveCountBefore);
    const retryRow = rows.find((r) => r.job_id === retryId)!;
    expect(retryRow.capability).toBe("followup.deliver");
    expect(retryRow.stage).toBe("deliver");
    expect(retryRow.parent_job_id).toBe(mainJobId);
    const retryPayload = JSON.parse(String(retryRow.payload_json)) as Record<string, unknown>;
    expect(retryPayload.retryOf).toBe(failedId);
    expect(retryPayload.channel).toBe("slack");
    // The failed row stays failed (the record of the failure is kept).
    expect(getAsyncJob(ctx, failedId)?.status).toBe("failed");

    await executeAsyncJob(ctx, { jobId: retryId });
    expect(getAsyncJob(ctx, retryId)?.status).toBe("completed");
    // The chain resumed: a 'delivered' notification was planned.
    const notes = sql
      .rows("mas_async_jobs")
      .filter((r) => r.capability === "followup.notify")
      .map((r) => JSON.parse(String(r.payload_json)) as { event?: string });
    expect(notes.some((n) => n.event === "delivered")).toBe(true);
  });

  it("refuses a duplicate retry while one is active, and refuses non-failed jobs", async () => {
    const { ctx, failedId, mainJobId } = await failedDeliverChain();
    await retryAsyncJob(ctx, failedId);
    await expect(retryAsyncJob(ctx, failedId)).rejects.toThrow(/already/i);
    await expect(retryAsyncJob(ctx, mainJobId)).rejects.toThrow(/failed/i);
    await expect(retryAsyncJob(ctx, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/i);
  });
});

/* ------------------------------------------------------------------ */
/* Chain view projection                                               */
/* ------------------------------------------------------------------ */

describe("buildStageChainView", () => {
  it("projects held deliveries as held with their reason (never invisible)", () => {
    const view = buildStageChainView([
      {
        jobId: "m1",
        sessionId: "s",
        capability: "screener.run",
        label: "Stock screen",
        status: "completed",
        jobKind: "main",
        stage: "generate",
        chainId: "c1",
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
      {
        jobId: "d1",
        sessionId: "s",
        capability: "followup.deliver",
        label: "Deliver by Slack",
        status: "completed",
        jobKind: "delivery",
        channel: "slack",
        stage: "deliver",
        chainId: "c1",
        parentJobId: "m1",
        createdAt: "2026-10-24T00:01:00.000Z",
        updatedAt: "2026-10-24T00:01:00.000Z",
        result: { status: "held", reason: "Report-dispatch confirmation (#277) is enabled; delivery held for approval." },
      },
    ]);
    expect(view).toHaveLength(1);
    const deliver = view[0].stages.find((s) => s.stage === "deliver");
    expect(deliver?.status).toBe("held");
    expect(deliver?.reason).toContain("held for approval");
  });
});
