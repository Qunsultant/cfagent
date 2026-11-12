/**
 * Issue #2913 (G6): one delivery bridge + durable cross-instance
 * (runId, destination) suppression.
 *
 * The bridge: scheduleScreenerFollowups → main job → report job →
 * one followup.deliver job per channel → the followup delivery port,
 * with pipeline-policy gates and suppression in the executor. Pins:
 *  - one run through the bridge delivers to Slack, email, and webhook
 *    through that one path, each channel's outcome recorded on its
 *    job (sent + channel), never through a second bridge;
 *  - a second claim for the same (runId, destination) is suppressed
 *    after a restart / instance change: two executor contexts (two
 *    suppressor objects) sharing one SQL store — the second deliver
 *    job completes as skipped with the duplicate reason and sends
 *    nothing;
 *  - the SQL store itself: claim / already-claimed / release /
 *    delete semantics, backed by a table that survives the instance;
 *  - the REST bridge stamps the stable deliveryId the legacy
 *    fallback already uses (`manual:<timestamp>:<universe>`), so a
 *    bridge delivery and a legacy-fallback delivery for one run
 *    share one suppression key instead of two.
 */
import { describe, it, expect } from "vitest";
import { createSqlDeliverySuppressionStore } from "../src/data/deliveryClaimsStore";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
} from "../src/workflows/screenDeliverySuppression";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { executeEtradeScreen } from "../src/agents/routes/etradeBrokerScreen";
import { MockSqlStorage } from "./mock-sql";
import type { SqlStorage } from "../src/data/repositoryPorts";

/** Stateful fake: the deliveries-test harness, plus the claims table. */
class FakeSql {
  columns = [
    "job_id", "session_id", "capability", "display_name", "status",
    "payload_json", "result_json", "response_status", "error",
    "created_at", "updated_at", "started_at", "completed_at",
    "parent_job_id", "job_kind", "channel",
  ];
  rows: Array<Record<string, unknown>> = [];
  claims: Array<{ key: string; claimed_at: unknown }> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Array<Record<string, unknown>>, rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    if (/^CREATE TABLE IF NOT EXISTS mas_delivery_claims/i.test(q)) return wrap([]);
    if (/^SELECT/i.test(q) && /FROM mas_delivery_claims/i.test(q)) {
      const found = this.claims.find((c) => c.key === args[0]);
      return wrap(found ? [{ key: found.key }] : []);
    }
    if (/^INSERT OR IGNORE INTO mas_delivery_claims/i.test(q)) {
      const key = args[0] as string;
      if (!this.claims.some((c) => c.key === key)) this.claims.push({ key, claimed_at: args[1] });
      return wrap([]);
    }
    if (/^DELETE FROM mas_delivery_claims/i.test(q)) {
      this.claims = this.claims.filter((c) => c.key !== args[0]);
      return wrap([]);
    }
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
    throw new Error(`FakeSql: unsupported: ${q.slice(0, 80)}`);
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
  sql: FakeSql,
  env: Record<string, unknown>,
  delivered: Array<{ channel: string; artifacts: unknown }>,
  notified: Array<{ channel: string; text: string }> = [],
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env,
    agentCtx: { storage: { sql: storage } },
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
    // Issue #2913 (G6): the executor context carries the SQL-backed
    // suppressor, so claims survive the instance (same table).
    deliverySuppressor: createDeliverySuppressor(
      createSqlDeliverySuppressionStore(() => sql as unknown as SqlStorage),
    ),
  } as unknown as AsyncJobsContext;
}

async function runChain(ctx: AsyncJobsContext, sql: FakeSql): Promise<void> {
  const main = await submitAsyncJob(ctx, {
    capability: "http.request",
    payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
  });
  await executeAsyncJob(ctx, { jobId: (main as { jobId: string }).jobId });
  const reportRow = sql.rows.find((r) => r.capability === "followup.report");
  expect(reportRow).toBeTruthy();
  await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
}

describe("one delivery bridge (#2913)", () => {
  it("one run through the bridge delivers to slack, email, and webhook, each outcome recorded", async () => {
    const sql = new FakeSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const ctx = makeCtx(sql, {
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
      SCREENER_EMAIL_TO: "ops@example.com",
      SCREENER_WEBHOOK_URL: "https://example.com/hook",
    }, delivered);
    await runChain(ctx, sql);
    const deliveries = sql.rows.filter((r) => r.capability === "followup.deliver");
    expect(deliveries.map((d) => d.channel)).toEqual(["slack", "email", "webhook"]);
    const mainRow = sql.rows.find((r) => r.capability === "http.request");
    for (const d of deliveries) {
      expect(d.parent_job_id).toBe(mainRow?.job_id);
      expect(d.job_kind).toBe("delivery");
      await executeAsyncJob(ctx, { jobId: String(d.job_id) });
      const rec = getAsyncJob(ctx, String(d.job_id));
      expect(rec?.status).toBe("completed");
      expect(rec?.result).toMatchObject({ status: "sent", channel: d.channel });
    }
    expect(delivered.map((d) => d.channel)).toEqual(["slack", "email", "webhook"]);
  });

  it("a second claim for the same (runId, destination) after a restart is suppressed and sends nothing", async () => {
    const sql = new FakeSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const outcome = {
      kind: "stock",
      trigger: "manual",
      success: true,
      deliveryId: "manual:2026-11-03T12:00:00.000Z:TECH",
      matchedCount: 1,
      totalScanned: 10,
      universe: "TECH",
      pdfKeys: [],
    };
    const ctx1 = makeCtx(sql, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" }, delivered);
    const first = await submitAsyncJob(ctx1, {
      capability: "followup.deliver",
      payload: { outcome, userLogin: "alice", channel: "slack", artifacts: [] },
      parentJobId: "main-1",
      jobKind: "delivery",
      channel: "slack",
      displayName: "Deliver by Slack",
    });
    await executeAsyncJob(ctx1, { jobId: String((first as { jobId: string }).jobId) });
    expect(delivered.map((d) => d.channel)).toEqual(["slack"]);

    // Restart: a brand-new context + suppressor object, same SQL store.
    const ctx2 = makeCtx(sql, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" }, delivered);
    const second = await submitAsyncJob(ctx2, {
      capability: "followup.deliver",
      payload: { outcome, userLogin: "alice", channel: "slack", artifacts: [] },
      parentJobId: "main-1",
      jobKind: "delivery",
      channel: "slack",
      displayName: "Deliver by Slack",
    });
    await executeAsyncJob(ctx2, { jobId: String((second as { jobId: string }).jobId) });
    const rec = getAsyncJob(ctx2, String((second as { jobId: string }).jobId));
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toMatchObject({ status: "skipped" });
    expect(String((rec?.result as { reason?: string }).reason)).toContain("Duplicate delivery suppressed");
    expect(delivered.map((d) => d.channel)).toEqual(["slack"]);
  });

  it("the same run to a different destination is not suppressed", async () => {
    const sql = new FakeSql();
    const delivered: Array<{ channel: string; artifacts: unknown }> = [];
    const outcome = {
      kind: "stock",
      trigger: "manual",
      success: true,
      deliveryId: "manual:2026-11-03T12:00:00.000Z:TECH",
      matchedCount: 1,
      totalScanned: 10,
      universe: "TECH",
      pdfKeys: [],
    };
    const ctx = makeCtx(sql, {
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
      SCREENER_WEBHOOK_URL: "https://example.com/hook",
    }, delivered);
    for (const channel of ["slack", "webhook"]) {
      const job = await submitAsyncJob(ctx, {
        capability: "followup.deliver",
        payload: { outcome, userLogin: "alice", channel, artifacts: [] },
        parentJobId: "main-1",
        jobKind: "delivery",
        channel,
        displayName: `Deliver by ${channel}`,
      });
      await executeAsyncJob(ctx, { jobId: String((job as { jobId: string }).jobId) });
    }
    expect(delivered.map((d) => d.channel)).toEqual(["slack", "webhook"]);
  });
});

describe("SQL delivery suppression store (#2913)", () => {
  it("claim / already-claimed / release / delete through the table", () => {
    const sql = new MockSqlStorage() as unknown as SqlStorage;
    const store = createSqlDeliverySuppressionStore(() => sql);
    const suppressor = createDeliverySuppressor(store);
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(suppressor.tryClaim("run-1", "slack")).toBe(false);
    expect(suppressor.wasClaimed("run-1", "slack")).toBe(true);
    expect(suppressor.wasClaimed("run-1", "email:ops@example.com")).toBe(false);
    // A failed send releases the claim so a retry may proceed.
    suppressor.release("run-1", "slack");
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
    // Email destinations distinguish recipients.
    expect(deliveryDestinationFor("email", "OPS@Example.com")).toBe("email:ops@example.com");
    expect(suppressor.tryClaim("run-1", deliveryDestinationFor("email", "ops@example.com"))).toBe(true);
    expect(suppressor.tryClaim("run-1", deliveryDestinationFor("email", "other@example.com"))).toBe(true);
  });
});

describe("REST bridge deliveryId stamp (#2913)", () => {
  // Issue #4278: the screen runs through the one engine seam, not the
  // agent's runScreen. The seam fake delegates to the stub agent's
  // runScreen: it flattens the seam input back into the runScreen
  // request and returns the stub's result as the engine run's one
  // shard. The seam itself is pinned in
  // tests/stock_entry_routing_4278.test.ts.
  const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
    const flat = {
      trigger: input.spec.trigger,
      sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
      universe: input.spec.universe,
      maxSymbols: input.commandOverrides?.maxSymbols,
      filters: input.spec.filters,
      userLogin: input.userLogin,
      environment: input.environment,
      portfolioContext: input.portfolioContext,
      provider: input.commandOverrides?.provider ?? input.spec.provider,
      broker: input.commandOverrides?.broker,
      ...(input.commandOverrides?.mode
        ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
        : {}),
    };
    const result = await runScreen(flat);
    return {
      results: [result],
      collation: null,
      jobId: input.spec?.jobId ?? "test-job",
      workflowId: "wf-1",
    };
  };

  it("the outcome scheduled from the REST route carries manual:<timestamp>:<universe>", async () => {
    // Issue #4278: a SUCCESS result is stored + delivered by the
    // workflow's own store/deliver steps, so the route no longer
    // schedules followups for it (pinned in
    // tests/stock_entry_routing_4278.test.ts: no re-persist/deliver
    // on success). The bridge scheduling below is the FAILED-result
    // path, which keeps the #2861 persist-then-deliver finalizer.
    const scheduled: unknown[] = [];
    const ctx = {
      env: {},
      readSettingRaw: () => null,
      audit: () => {},
      persistScreenerReportCanonical: async () => {},
      scheduleScreenerFollowups: async (o: unknown) => {
        scheduled.push(o);
      },
    } as never;
    const agent = {
      runScreen: async () => ({
        success: false,
        timestamp: "2026-11-03T12:00:00.000Z",
        universe: "TECH",
        provider: "etrade",
        totalScanned: 0,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "test",
        error: "E*TRADE unavailable",
      }),
    } as never;
    (ctx as any).runStockScreenViaEngine = delegateSeamFake(agent.runScreen);
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(502);
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0] as { deliveryId?: string }).deliveryId).toBe("manual:2026-11-03T12:00:00.000Z:TECH");
  });
});
