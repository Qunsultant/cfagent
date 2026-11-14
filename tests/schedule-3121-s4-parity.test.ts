/**
 * Issue #3121 Slice S4 — follow-up chains onto the shared scheduling
 * primitives (inventory §3 Q(c), §4).
 *
 * Parity for the S4 slice of the scheduling consolidation program:
 * `scheduleScreenerFollowups` stays the chain minter; every
 * follow-up row and every run record the chain produces carries the
 * §4 linkage — `trigger`, `scheduleId`, `asyncJobId` (the row's OWN
 * `job_id`), `workflowId` — stamped into the job payload/result
 * (`mas_async_jobs` gains NO columns, per B-L-02). Same chain graph,
 * same delivery channels, same retry/refusal rules, same recovery
 * behavior as pre-S4 — S4 adds stamping, it changes no behavior.
 *
 * S1 already stamped the planners: `followupLedgerLinkage` carries
 * `async-chain` + the run's ids + the chain-parent main job id, and
 * the three planners (`planInitialFollowups`, `planDeliveryFollowups`,
 * `planLifecycleNotifications`) put it on their payloads (S1-P13).
 * S4 closes the rest of the chain:
 * - S4-P01 the restamp helpers are pure and fail closed (own id,
 *   never re-derived linkage, malformed stamps left alone).
 * - S4-P02 the minter (`submitAsyncJob`) restamps `asyncJobId` to
 *   the minted row's own id; the chain graph columns and a
 *   non-chain payload are untouched.
 * - S4-P03 the bridge stamps the main job's payload linkage (own id,
 *   the run's trigger) and every minted follow-up row carries its
 *   own id; the S1 result stamping is the pinned base.
 * - S4-P04 end-to-end chain parity: same graph, same channels, same
 *   delivery behavior, plus linkage on every row.
 * - S4-P05 retry preserves the original's linkage (`retryOf` plus
 *   original stage/chain identity), restamping only the id; a
 *   second retry is still refused.
 * - S4-P06 recovery re-arms at the remaining delay and leaves the
 *   stored payload (linkage included) byte-identical.
 * - S4-P07 an executed follow-up step's run record (its completed
 *   row's `result_json`) carries the four fields flat, matching the
 *   bridged main job's result shape; a non-chain job's result is
 *   untouched.
 * - S4-P08 the `recordJobOutcome` sink check: the bridged-run path
 *   stamps `trigger`; the sink contract carries `trigger` only, and
 *   no chain path in `executeAsyncJob` calls it — the chain's
 *   linkage rides the async-job rows, not the outcome sink.
 * - S4-P09 explicit nulls: a chain minted without an originating
 *   schedule/workflow records nulls, never a missing field.
 * - S4-P10 `mas_async_jobs` gains no columns in S4.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  executeAsyncJob,
  getAsyncJob,
  recordScreenerRunMainJob,
  recoverQueuedAsyncJobs,
  retryAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  restampLedgerLinkageAsyncJobId,
  stampLedgerLinkageIntoResult,
} from "../src/services/consolidatedScheduling";
import {
  planDeliveryFollowups,
  planInitialFollowups,
  planLifecycleNotifications,
  resolveScreenerFollowupConfig,
  type ScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import { remainderAlterSql } from "../src/data/schemaComponent/remainderCatalogue";

/**
 * Stateful fake (same harness shape as the S2–S4 follow-up suites,
 * with a generic WHERE evaluator so the read port's session/status/
 * chain filters behave: `listQueued` returns only queued rows of
 * the session, `chainRows` only the chain's rows).
 */
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
      const whereMatch = q.match(/ WHERE (.+?)(?: ORDER BY | LIMIT |$)/i);
      if (whereMatch) {
        let ai = 0;
        for (const cond of whereMatch[1].split(/ AND /i)) {
          const c = cond.trim();
          const placeholder = c.match(/^(\w+)\s*=\s*\?$/);
          if (placeholder) {
            const val = args[ai++];
            rows = rows.filter((r) => r[placeholder[1]] === val);
            continue;
          }
          const literal = c.match(/^(\w+)\s*=\s*'([^']*)'$/);
          if (literal) {
            rows = rows.filter((r) => r[literal[1]] === literal[2]);
            continue;
          }
          if (c.includes("?")) ai++;
        }
      }
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/ORDER BY created_at ASC/i.test(q)) rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
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
  scheduleCalls: Array<{ delaySeconds: number; payload: unknown }> = [],
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async (when: unknown, _callback: string, payload?: unknown) => {
      scheduleCalls.push({ delaySeconds: typeof when === "number" ? when : 0, payload });
      return {};
    },
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
      notify: async () => ({ ok: true }),
    }),
  } as unknown as AsyncJobsContext;
}

const linkedOutcome = {
  kind: "stock",
  trigger: "scheduled",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
  scheduleId: "sched-1",
  workflowId: "wf-1",
} as unknown as ScreenerRunOutcome;

const unlinkedOutcome = {
  kind: "stock",
  trigger: "manual",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
} as unknown as ScreenerRunOutcome;

function followupConfig(): ScreenerFollowupConfig {
  return resolveScreenerFollowupConfig({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    SCREENER_EMAIL_TO: "ops@example.com",
  });
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(row.payload_json)) as Record<string, unknown>;
}

function resultOf(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(row.result_json)) as Record<string, unknown>;
}

function linkageOf(row: Record<string, unknown>): Record<string, unknown> {
  return payloadOf(row).ledgerLinkage as Record<string, unknown>;
}

describe("S4-P01 restamp helpers — pure, fail closed (#3121)", () => {
  const plannerLinkage = {
    trigger: "async-chain",
    scheduleId: "sched-1",
    asyncJobId: "main-job-1",
    workflowId: "wf-1",
  };

  it("restampLedgerLinkageAsyncJobId swaps only asyncJobId, to the minted id", () => {
    const payload = { outcome: { kind: "stock" }, userLogin: "alice", ledgerLinkage: plannerLinkage };
    const stamped = restampLedgerLinkageAsyncJobId(payload, "own-9") as Record<string, unknown>;
    expect(stamped).not.toBe(payload);
    expect(stamped.ledgerLinkage).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: "own-9",
      workflowId: "wf-1",
    });
    // The input is unmutated: the planner's parent id survives.
    expect(payload.ledgerLinkage).toEqual(plannerLinkage);
    expect(stamped.outcome).toBe(payload.outcome);
  });

  it("a payload without ledgerLinkage is returned unchanged — never coerced", () => {
    const payload = { pathAndQuery: "/api/etrade/screen", method: "POST" };
    expect(restampLedgerLinkageAsyncJobId(payload, "own-9")).toBe(payload);
    expect(restampLedgerLinkageAsyncJobId(null, "own-9")).toBeNull();
    expect(restampLedgerLinkageAsyncJobId("junk", "own-9")).toBe("junk");
    expect(restampLedgerLinkageAsyncJobId({ ledgerLinkage: "junk" }, "own-9")).toEqual({ ledgerLinkage: "junk" });
  });

  it("stampLedgerLinkageIntoResult carries the four fields flat on the run record", () => {
    const payload = { outcome: {}, ledgerLinkage: plannerLinkage };
    const result = { status: "ready", artifacts: [{ key: "k1", fileName: "screen.pdf" }] };
    expect(stampLedgerLinkageIntoResult(payload, result, "own-9")).toEqual({
      status: "ready",
      artifacts: [{ key: "k1", fileName: "screen.pdf" }],
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: "own-9",
      workflowId: "wf-1",
    });
    // asyncJobId is forced to the executing row's own id even when the
    // payload still stamps a pre-S4 parent id (S1-era rows).
    expect(
      (stampLedgerLinkageIntoResult(payload, { status: "sent" }, "own-9") as Record<string, unknown>).asyncJobId,
    ).toBe("own-9");
  });

  it("the result stamp leaves non-object results, unlinked payloads, and malformed linkage alone", () => {
    const linked = { ledgerLinkage: plannerLinkage };
    expect(stampLedgerLinkageIntoResult(linked, "plain-text", "own-9")).toBe("plain-text");
    expect(stampLedgerLinkageIntoResult(linked, null, "own-9")).toBeNull();
    expect(stampLedgerLinkageIntoResult({}, { status: "sent" }, "own-9")).toEqual({ status: "sent" });
    expect(
      stampLedgerLinkageIntoResult(
        { ledgerLinkage: { trigger: "bogus", scheduleId: null, asyncJobId: "x", workflowId: null } },
        { status: "sent" },
        "own-9",
      ),
    ).toEqual({ status: "sent" });
    // "unknown" is legacy-rows-only: it is never stamped onto a new run record.
    expect(
      stampLedgerLinkageIntoResult(
        { ledgerLinkage: { trigger: "unknown", scheduleId: null, asyncJobId: "x", workflowId: null } },
        { status: "sent" },
        "own-9",
      ),
    ).toEqual({ status: "sent" });
  });
});

describe("S4-P02 submitAsyncJob restamps the follow-up row's own id (#3121)", () => {
  it("a planned follow-up row carries its OWN job id as asyncJobId; the graph is untouched", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const config = followupConfig();
    const [spec] = planInitialFollowups(linkedOutcome, config, "main-job-1", "alice");
    // The planner stamps the parent id (S1-P13 — still true at plan time).
    expect((spec.payload as { ledgerLinkage: { asyncJobId: string } }).ledgerLinkage.asyncJobId).toBe("main-job-1");
    const submitted = await submitAsyncJob(ctx, spec);
    const row = sql.rows.find((r) => r.job_id === submitted.jobId)!;
    expect(linkageOf(row)).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: submitted.jobId,
      workflowId: "wf-1",
    });
    // Chain graph parity: same parent / kind / display name as pre-S4.
    expect(row.parent_job_id).toBe("main-job-1");
    expect(row.job_kind).toBe("report");
    expect(row.display_name).toBe("Generate report — Stock screen (NASDAQ100)");
  });

  it("a chained follow-up keeps its stage/chain/not_before and restamps only the id", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const config = followupConfig();
    const chainedOutcome = { ...linkedOutcome, stageChain: { serveDelaySeconds: 120, deliverDelaySeconds: 300 } } as unknown as ScreenerRunOutcome;
    const [spec] = planInitialFollowups(chainedOutcome, config, "main-job-1", "alice", {
      chainId: "chain-1",
      nowIso: "2026-11-06T12:00:00.000Z",
    });
    const submitted = await submitAsyncJob(ctx, spec);
    const row = sql.rows.find((r) => r.job_id === submitted.jobId)!;
    expect(row.stage).toBe("serve");
    expect(row.chain_id).toBe("chain-1");
    expect(row.not_before).toBe("2026-11-06T12:02:00.000Z");
    expect(linkageOf(row).asyncJobId).toBe(submitted.jobId);
    expect(linkageOf(row).scheduleId).toBe("sched-1");
  });

  it("a non-chain submission gains no ledgerLinkage key", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const submitted = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    const row = sql.rows.find((r) => r.job_id === submitted.jobId)!;
    expect("ledgerLinkage" in payloadOf(row)).toBe(false);
  });
});

describe("S4-P03 the bridge stamps the main job and every minted follow-up row (#3121)", () => {
  it("the main job row carries its own id in the payload linkage and flat in the result", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, linkedOutcome, "alice");
    const mainRow = sql.rows.find((r) => r.job_id === mainJobId)!;
    // S4: the payload linkage — the run's trigger (not async-chain:
    // the main job is the chain root, not a chain step), the run's
    // schedule/workflow ids, this row's own id.
    expect(linkageOf(mainRow)).toEqual({
      trigger: "scheduled",
      scheduleId: "sched-1",
      asyncJobId: mainJobId,
      workflowId: "wf-1",
    });
    // S1 base, pinned here as the shape the follow-up results match.
    expect(resultOf(mainRow)).toMatchObject({
      trigger: "scheduled",
      scheduleId: "sched-1",
      asyncJobId: mainJobId,
      workflowId: "wf-1",
    });
    // The minted report row links to the parent AND carries its own id.
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    expect(reportRow.parent_job_id).toBe(mainJobId);
    expect(linkageOf(reportRow)).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: String(reportRow.job_id),
      workflowId: "wf-1",
    });
  });

  it("a failed bridged run's notification rows each carry their own id", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(
      ctx,
      { kind: "options", trigger: "scheduled", success: false, pdfKeys: [], error: "chain fetch failed", thesis: "vol", scheduleId: "sched-9", workflowId: "wf-9" },
      "bob",
    );
    const notes = sql.rows.filter((r) => r.capability === "followup.notify");
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.parent_job_id).toBe(mainJobId);
      expect(linkageOf(note)).toEqual({
        trigger: "async-chain",
        scheduleId: "sched-9",
        asyncJobId: String(note.job_id),
        workflowId: "wf-9",
      });
    }
  });

  it("an outcome with no schedule/workflow records explicit nulls everywhere", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, unlinkedOutcome, "alice");
    const mainRow = sql.rows.find((r) => r.job_id === mainJobId)!;
    expect(linkageOf(mainRow)).toEqual({
      trigger: "manual",
      scheduleId: null,
      asyncJobId: mainJobId,
      workflowId: null,
    });
    expect(resultOf(mainRow)).toMatchObject({ scheduleId: null, workflowId: null });
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    expect(linkageOf(reportRow)).toEqual({
      trigger: "async-chain",
      scheduleId: null,
      asyncJobId: String(reportRow.job_id),
      workflowId: null,
    });
  });
});

describe("S4-P04 end-to-end chain parity — same graph, same channels, plus linkage (#3121)", () => {
  it("bridge → report → deliveries → delivered notice, with own-id linkage on every row", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, linkedOutcome, "alice");
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    await executeAsyncJob(ctx, { jobId: String(reportRow.job_id) });
    // Same delivery channels as pre-S4, parented to the MAIN job.
    const deliveries = sql.rows.filter((r) => r.capability === "followup.deliver");
    expect(deliveries.map((d) => d.channel)).toEqual(["slack", "email"]);
    for (const d of deliveries) {
      expect(d.parent_job_id).toBe(mainJobId);
      expect(d.job_kind).toBe("delivery");
      expect(linkageOf(d).asyncJobId).toBe(String(d.job_id));
      expect(linkageOf(d).scheduleId).toBe("sched-1");
    }
    // Executing a delivery sends it and plans the 'delivered' notice.
    await executeAsyncJob(ctx, { jobId: String(deliveries[0].job_id) });
    const deliveredRow = sql.rows.find((r) => r.job_id === deliveries[0].job_id)!;
    expect(deliveredRow.status).toBe("completed");
    const notices = sql.rows.filter(
      (r) => r.capability === "followup.notify" && payloadOf(r).event === "delivered",
    );
    // One 'delivered' notice per notification channel, both parented to the main job.
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.parent_job_id).toBe(mainJobId);
      expect(linkageOf(notice).asyncJobId).toBe(String(notice.job_id));
    }
  });
});

describe("S4-P05 retry preserves the original's linkage, restamping only the id (#3121)", () => {
  it("a retried follow-up keeps trigger/schedule/workflow + stage/chain, gains retryOf and its own id", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const config = followupConfig();
    const [spec] = planInitialFollowups(linkedOutcome, config, "main-job-1", "alice");
    const first = await submitAsyncJob(ctx, spec);
    const row = sql.rows.find((r) => r.job_id === first.jobId)!;
    row.status = "failed";
    row.error = "render blew up";
    const retried = await retryAsyncJob(ctx, first.jobId);
    expect(retried.jobId).not.toBe(first.jobId);
    const retryRow = sql.rows.find((r) => r.job_id === retried.jobId)!;
    const retryPayload = payloadOf(retryRow);
    expect(retryPayload.retryOf).toBe(first.jobId);
    expect(retryPayload.ledgerLinkage).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: retried.jobId,
      workflowId: "wf-1",
    });
    // Original stage/chain identity rides the resubmission.
    expect(retryRow.parent_job_id).toBe("main-job-1");
    expect(retryRow.job_kind).toBe("report");
    // The failed row stays failed: the failure record is kept.
    expect(row.status).toBe("failed");
    // A second retry while the first retry is queued is refused.
    await expect(retryAsyncJob(ctx, first.jobId)).rejects.toThrow("already retried");
  });

  it("a retried job without linkage resubmits without inventing any", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const first = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    sql.rows.find((r) => r.job_id === first.jobId)!.status = "failed";
    const retried = await retryAsyncJob(ctx, first.jobId);
    const retryRow = sql.rows.find((r) => r.job_id === retried.jobId)!;
    expect("ledgerLinkage" in payloadOf(retryRow)).toBe(false);
    expect(payloadOf(retryRow).retryOf).toBe(first.jobId);
  });
});

describe("S4-P06 recovery re-arms at the remaining delay and leaves the payload untouched (#3121)", () => {
  it("a deferred follow-up re-arms with its job id and its stored payload byte-identical", async () => {
    const sql = new StatefulAsyncSql();
    const scheduleCalls: Array<{ delaySeconds: number; payload: unknown }> = [];
    const ctx = makeCtx(sql, scheduleCalls);
    const config = followupConfig();
    const chainedOutcome = { ...linkedOutcome, stageChain: { serveDelaySeconds: 3600 } } as unknown as ScreenerRunOutcome;
    const [spec] = planInitialFollowups(chainedOutcome, config, "main-job-1", "alice", {
      chainId: "chain-1",
      nowIso: new Date().toISOString(),
    });
    const submitted = await submitAsyncJob(ctx, spec);
    const row = sql.rows.find((r) => r.job_id === submitted.jobId)!;
    const payloadBefore = String(row.payload_json);
    scheduleCalls.length = 0;
    await recoverQueuedAsyncJobs(ctx);
    // One re-arm, at (approximately) the remaining delay — the
    // deferred stage must not fire early because the DO restarted.
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0].delaySeconds).toBeGreaterThan(3500);
    expect(scheduleCalls[0].delaySeconds).toBeLessThanOrEqual(3600);
    const rearm = scheduleCalls[0].payload as { jobId: string; provenance: { origin: string; reason: string } };
    expect(rearm.jobId).toBe(submitted.jobId);
    expect(rearm.provenance.origin).toBe("system");
    expect(rearm.provenance.reason).toBe("recovery");
    // The row itself is untouched: linkage included, byte-identical.
    expect(String(row.payload_json)).toBe(payloadBefore);
    expect(linkageOf(row).asyncJobId).toBe(submitted.jobId);
  });
});

describe("S4-P07 an executed follow-up step's run record carries the four fields flat (#3121)", () => {
  it("a completed report step's result carries trigger/schedule/own-id/workflow", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const mainJobId = await recordScreenerRunMainJob(ctx, linkedOutcome, "alice");
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    await executeAsyncJob(ctx, { jobId: String(reportRow.job_id) });
    const completed = sql.rows.find((r) => r.job_id === reportRow.job_id)!;
    expect(completed.status).toBe("completed");
    expect(resultOf(completed)).toMatchObject({
      status: "ready",
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: String(reportRow.job_id),
      workflowId: "wf-1",
    });
    expect(getAsyncJob(ctx, String(reportRow.job_id))?.result).toMatchObject({
      trigger: "async-chain",
      asyncJobId: String(reportRow.job_id),
    });
    expect(mainJobId).toBeTruthy();
  });

  it("a sent delivery and a lifecycle notification carry the same flat linkage", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const config = followupConfig();
    // Delivery: planned by the report completion, then executed.
    const mainJobId = await recordScreenerRunMainJob(ctx, linkedOutcome, "alice");
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    await executeAsyncJob(ctx, { jobId: String(reportRow.job_id) });
    const deliveryRow = sql.rows.find((r) => r.capability === "followup.deliver" && r.channel === "slack")!;
    await executeAsyncJob(ctx, { jobId: String(deliveryRow.job_id) });
    expect(resultOf(deliveryRow)).toMatchObject({
      status: "sent",
      channel: "slack",
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: String(deliveryRow.job_id),
      workflowId: "wf-1",
    });
    // Notification: planned directly, then executed.
    const [notifySpec] = planLifecycleNotifications("failed", linkedOutcome, config, mainJobId, "alice");
    const notify = await submitAsyncJob(ctx, notifySpec);
    const notifyRow = sql.rows.find((r) => r.job_id === notify.jobId)!;
    await executeAsyncJob(ctx, { jobId: notify.jobId });
    expect(resultOf(notifyRow)).toMatchObject({
      status: "notified",
      event: "failed",
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: notify.jobId,
      workflowId: "wf-1",
    });
  });

  it("a non-chain job's result is untouched (no linkage invented)", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });
    const row = sql.rows.find((r) => r.job_id === main.jobId)!;
    expect(row.status).toBe("completed");
    const result = resultOf(row);
    expect("trigger" in result).toBe(false);
    expect("scheduleId" in result).toBe(false);
    expect("asyncJobId" in result).toBe(false);
    expect("workflowId" in result).toBe(false);
  });
});

describe("S4-P08 the recordJobOutcome sink check — trigger only, no chain path (#3121)", () => {
  it("the bridged-run path stamps trigger and the sink contract carries no linkage fields", () => {
    const asyncJobsSrc = readFileSync("src/agents/orchestrator/asyncJobs.ts", "utf8");
    // The bridge is the only recordJobOutcome call in the chain module
    // (import + the one call) and it stamps the run's trigger.
    expect(asyncJobsSrc.split("recordJobOutcome").length - 1).toBe(2);
    expect(asyncJobsSrc).toContain("trigger: outcome.trigger,");
    // The sink contract is trigger-only by design: no scheduleId /
    // workflowId / asyncJobId fields exist to stamp into. The chain's
    // linkage rides the async-job rows (payload/result), not this sink.
    const portsSrc = readFileSync("src/data/jobOutcomePorts.ts", "utf8");
    expect(portsSrc).toContain("trigger: JobOutcomeTrigger;");
    expect(portsSrc).not.toContain("scheduleId");
    expect(portsSrc).not.toContain("workflowId");
    expect(portsSrc).not.toContain("asyncJobId");
    // The other outcome-sink callers stamp trigger only, too.
    const serveSrc = readFileSync("src/services/optionsServeRecord.ts", "utf8");
    expect(serveSrc).toContain("trigger: run.trigger,");
    expect(serveSrc).not.toContain("scheduleId: run.");
  });
});

describe("S4-P09 explicit nulls on a chain with no originating schedule/workflow (#3121)", () => {
  it("an http-request main job's follow-ups record null schedule/workflow, own ids", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    // The http completion hook stamps from what the outcome carries —
    // the screen response names no schedule or workflow (#3313 owns
    // threading those ids into the outcome; S4 stamps the nulls).
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });
    const reportRow = sql.rows.find((r) => r.capability === "followup.report")!;
    expect(linkageOf(reportRow)).toEqual({
      trigger: "async-chain",
      scheduleId: null,
      asyncJobId: String(reportRow.job_id),
      workflowId: null,
    });
    await executeAsyncJob(ctx, { jobId: String(reportRow.job_id) });
    const deliveryRow = sql.rows.find((r) => r.capability === "followup.deliver")!;
    expect(linkageOf(deliveryRow).scheduleId).toBeNull();
    expect(linkageOf(deliveryRow).workflowId).toBeNull();
    await executeAsyncJob(ctx, { jobId: String(deliveryRow.job_id) });
    expect(deliveryRow.status).toBe("completed");
    expect(resultOf(deliveryRow)).toMatchObject({ scheduleId: null, workflowId: null });
  });

  it("an unchained run's notifications still carry explicit nulls (chainReport:false)", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql);
    await recordScreenerRunMainJob(ctx, unlinkedOutcome, "alice", { chainReport: false });
    const notes = sql.rows.filter((r) => r.capability === "followup.notify");
    // chainReport:false records + notifies without the report chain,
    // so there is no delivery to be the completion message and no
    // suppression: the 'completed' notify IS planned (both channels).
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(linkageOf(note)).toEqual({
        trigger: "async-chain",
        scheduleId: null,
        asyncJobId: String(note.job_id),
        workflowId: null,
      });
    }
  });
});

describe("S4-P10 mas_async_jobs gains no columns in S4 (#3121, B-L-02)", () => {
  it("the queue adapter's probed migration adds the graph/stage columns plus #3810's provenance columns", () => {
    // #4282 P3: the 12 reconciliation ALTERs moved from the adapter
    // into the remainder catalogue (src/data/schemaComponent/
    // remainderCatalogue.ts) — asserted at their new home. The adapter
    // still executes them, through remainderAlterSql.
    const src = readFileSync("src/data/doSqliteAsyncJobAdapter.ts", "utf8");
    const alters = [
      "parent_job_id",
      "job_kind",
      "channel",
      "not_before",
      "stage",
      "chain_id",
      "trigger",
      "triggered_by",
      "schedule_id",
    ]
      .map((column) => remainderAlterSql("mas_async_jobs", column))
      .join("\n");
    for (const column of ["parent_job_id", "job_kind", "channel", "not_before", "stage", "chain_id"]) {
      expect(src).toContain(`remainderAlterSql("mas_async_jobs", "${column}")`);
      expect(alters).toContain(`ADD COLUMN ${column}`);
    }
    // #3810: the adapter additionally gains the three provenance columns
    // (trigger, triggered_by, schedule_id) — the row shape changes by
    // design; workflow_id is still never added.
    for (const column of ["trigger", "triggered_by", "schedule_id"]) {
      expect(src).toContain(`remainderAlterSql("mas_async_jobs", "${column}")`);
      expect(alters).toContain(`ADD COLUMN ${column}`);
    }
    expect(alters).not.toMatch(/ADD COLUMN workflow_id/);
    // The S1 planners already stamp the payload (not a column); S4
    // restamps at submit.
    expect(readFileSync("src/services/screenerFollowups.ts", "utf8")).toContain("followupLedgerLinkage");
  });

  it("planDeliveryFollowups still stamps the same linkage (S1-P13 preserved)", () => {
    const config = followupConfig();
    const specs = planDeliveryFollowups(
      linkedOutcome,
      config,
      { status: "ready", artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }] },
      "main-job-1",
      "alice",
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.payload.ledgerLinkage).toEqual({
        trigger: "async-chain",
        scheduleId: "sched-1",
        asyncJobId: "main-job-1",
        workflowId: "wf-1",
      });
    }
  });
});
