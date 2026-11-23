/**
 * Issue #5083 (S4, observability program #5080) — the three
 * first consumers route through the one alerting port.
 *
 * TDD: these tests assert the CONSUMER wiring, not the port
 * itself (the port is covered in otel_alerting_5083.test.ts,
 * the CI route in otel_alerting_routes_5083.test.ts).
 *
 * - Cap alert (#1819): runResourceCapAlert receives a fake
 *   alertPort and the fake port must receive a cap-alert
 *   report (source "cap-alert", code OBS-1018). The alert
 *   still dedups per (budget, day) and the delivery outcome
 *   still drives the alert state.
 * - Sweep (#3784): the orchestrator's notifyStuckRun hook
 *   routes through the port (Slack + email). The hook is a
 *   closure on the orchestrator's async-jobs context; the test
 *   builds the context from a real OrchestratorAgent with a
 *   stubbed fetch, so the Slack leg is observed, not assumed.
 * - CI failure: covered by the route test
 *   (otel_alerting_routes_5083.test.ts) — the fake port there
 *   receives the ci-failure report. Not repeated here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runResourceCapAlert } from "../src/agents/resourceGoals";
import { createD1ResourceDb } from "../src/data/d1ResourceUsageAdapter";
// The orchestrator graph is a static import, not a dynamic import
// inside the sweep test: evaluating it there costs ~19s against the
// 25s test budget (RCA #6100 — the import, not the assertions, is
// what times out). The graph evaluates at file collection instead;
// the test bodies themselves run in milliseconds.
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type {
  AlertReport,
  AlertResult,
  AlertingPort,
} from "../src/observability/otelAlerting";

/** A fake alerting port that records reports and succeeds. */
function makeFakePort(): { port: AlertingPort; reports: AlertReport[] } {
  const reports: AlertReport[] = [];
  const port: AlertingPort = {
    reportAlert: async (report: AlertReport): Promise<AlertResult> => {
      reports.push(report);
      return {
        delivered: true,
        slack: { ok: true, method: "webhook" },
        email: { ok: true, sentTo: ["owner@example.com"] },
        code: report.code,
        placeholderRules: true,
      };
    },
  };
  return { port, reports };
}

/**
 * Minimal fake D1 db for the cap alert (adapted from
 * tests/sessions_runs_quota_2840.test.ts): the totals read
 * returns the projection rows (rows_read drives the breach),
 * the alert-state read/write round-trips through a Map.
 */
function makeCapAlertDb(projectionRows: Array<Record<string, unknown>>) {
  const alertState = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              if (/insert into "resource_alert_state"/i.test(sql)) {
                const [budget, day, alerted_at, delivered, note] = params as [
                  string,
                  string,
                  number,
                  number,
                  string | null,
                ];
                alertState.set([budget, day].join("\0"), {
                  budget,
                  day,
                  alerted_at,
                  delivered,
                  note,
                });
              }
              return { success: true };
            },
            all: async () => {
              if (/from "resource_alert_state"/i.test(sql)) {
                const [budget, day] = params as [string, string];
                const row = alertState.get([budget, day].join("\0"));
                return { results: row ? [row] : [] };
              }
              if (/from "resource_sql_ops"/i.test(sql)) {
                return { results: projectionRows };
              }
              return { results: [] };
            },
            raw: async () => {
              if (/from "resource_alert_state"/i.test(sql)) {
                const [budget, day] = params as [string, string];
                const row = alertState.get([budget, day].join("\0"));
                return row
                  ? [[row.budget, row.day, row.alerted_at, row.delivered, row.note]]
                  : [];
              }
              if (/from "resource_sql_ops"/i.test(sql)) {
                return projectionRows.map((r) => [
                  r.bucket,
                  r.ns,
                  r.op,
                  r.caller,
                  r.trigger,
                  r.ops,
                  r.rows_read,
                  r.rows_written,
                ]);
              }
              return [];
            },
          };
        },
      };
    },
  };
  return db;
}

describe("S4 consumers route through the one alerting port", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the cap alert (#1819) routes through the port (fake port receives a cap-alert report)", async () => {
    const fake = makeFakePort();
    const posts: string[] = [];
    const post = vi.fn(async (_url: string, _headers: unknown, body: string) => {
      posts.push(body);
      return { status: 200, body: "ok" };
    });
    // 4,600,000 rows read = 92% of the 5,000,000 budget: a 70%
    // watch breach AND a 90% escalation tier.
    const db = makeCapAlertDb([
      {
        bucket: 0,
        ns: "sessions",
        op: "get",
        caller: "requireAuth",
        trigger: "user",
        ops: 1000,
        rows_read: 4_600_000,
        rows_written: 10,
      },
    ]);
    const nowMs = Date.parse("2026-11-03T12:00:00Z");
    const result = await runResourceCapAlert({
      db: createD1ResourceDb(db as never),
      nowMs,
      post: post as never,
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/XXX" } as never,
      alertPort: fake.port,
    });
    // The 70% watch + the 90% escalation both went through the port.
    expect(fake.reports.length).toBeGreaterThanOrEqual(2);
    expect(fake.reports.every((r) => r.source === "cap-alert")).toBe(true);
    expect(fake.reports.every((r) => r.code === "OBS-1018")).toBe(true);
    // S7 (#5086): the cap alert now routes through the real
    // catalog rule (the severity resolves from the catalog).
    expect(fake.reports.every((r) => r.ruleId === "rule:cap-breach")).toBe(true);
    // The delivery outcome still drives the alert state.
    expect(result.alerted).toContain("rowsRead");
    expect(result.tierAlerted).toContain("rowsRead:90");
    // The injected fake port delivered — the raw Slack poster
    // was NOT called (the port is the only delivery path).
    expect(posts.length).toBe(0);
  });

  it("the cap alert dedups per (budget, day) even through the port (second run sends nothing)", async () => {
    const fake = makeFakePort();
    const db = makeCapAlertDb([
      {
        bucket: 0,
        ns: "sessions",
        op: "get",
        caller: "requireAuth",
        trigger: "user",
        ops: 1000,
        rows_read: 4_600_000,
        rows_written: 10,
      },
    ]);
    const nowMs = Date.parse("2026-11-03T12:00:00Z");
    const deps = {
      db: createD1ResourceDb(db as never),
      nowMs,
      post: (async () => ({ status: 200, body: "ok" })) as never,
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/XXX" } as never,
      alertPort: fake.port,
    };
    const first = await runResourceCapAlert(deps);
    expect(first.alerted).toContain("rowsRead");
    const countAfterFirst = fake.reports.length;
    expect(countAfterFirst).toBeGreaterThan(0);
    const second = await runResourceCapAlert(deps);
    expect(second.alerted).toEqual([]);
    expect(second.tierAlerted).toEqual([]);
    expect(fake.reports.length).toBe(countAfterFirst);
  });

  it("the sweep stuck-run alert (#3784) routes through the port (the orchestrator hook posts via the port)", async () => {
    // The orchestrator's notifyStuckRun is a closure on the
    // async-jobs context; build the context from a real
    // OrchestratorAgent and call the hook directly. The port
    // uses the env's Slack webhook (stubbed fetch) — the hook
    // must deliver through it, not bypass it.
    const fetchCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, _init?: unknown) => {
        // The port's Slack leg posts the alert text to the
        // webhook; record the call. (The body is read by
        // fetchSlackPost via res.text().)
        const init = _init as { body?: string } | undefined;
        fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return { status: 200, text: async () => "" };
      },
    );
    const env = {
      SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/XXX",
      OTEL_ALERTING_ENABLED: "true",
    } as never;
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "test-orchestrator" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as never, env);
    const jobsCtx = (agent as unknown as { asyncJobsContext: () => { notifyStuckRun: (info: unknown) => Promise<void> } }).asyncJobsContext();
    await jobsCtx.notifyStuckRun({
      jobId: "job-stuck-1",
      label: "test job",
      ageMs: 45 * 60_000,
      thresholdMs: 30 * 60_000,
      capability: "test.capability",
      ownerLogin: "owner",
      startedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      heartbeatAgeMs: 45 * 60_000,
    });
    // The alert reached Slack through the port (webhook POST).
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0].url).toBe("https://hooks.slack.test/services/XXX");
    expect(fetchCalls[0].body).toContain("job-stuck-1");
  });
});
