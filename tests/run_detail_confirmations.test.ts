/**
 * Issue #1326: the run-detail view's delivery section needs the
 * confirmation state for ONE run, joined exactly — the run's canonical
 * mas_reports row (run_id = `screener:<timestamp>`) → its id →
 * mas_report_confirmations rows for that report. Summaries only; the
 * payload bytes stay server-side until decided, as in the pending list.
 *
 * Pins:
 *  - a run with a canonical row returns its confirmations with kind,
 *    status (verbatim — the UI maps pending to "Held for review"),
 *    created/decided times and detail
 *  - a run with no canonical row returns an empty list, not an error
 *  - a missing runId is a 400
 *
 * Harness follows tests/reports_routes_extraction.test.ts: the
 * extracted handler with a mock context whose sql.exec matches rows
 * by the table name in the query.
 */
import { describe, it, expect, vi } from "vitest";

import { handleReportsRoutes, type ReportsRouteContext } from "../src/agents/routes/reports";
import { MockD1Database } from "./mock-d1";
import { storeReportAtGeneration } from "../src/services/scheduledReports";

const makeSql = (tables: Record<string, any[]>) =>
  ({
    exec: (query: string, ..._params: unknown[]) => {
      for (const [table, rows] of Object.entries(tables)) {
        if (query.includes(table)) return rows;
      }
      return [];
    },
  }) as any;

const baseCtx = (overrides: Partial<ReportsRouteContext> = {}): ReportsRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    getScreenerAgent: () => ({ getHistory: async () => [] }) as any,
    getScreenerExecutionContext: async () => undefined,
    getReportDispatchHitl: () => false,
    setReportDispatchHitl: vi.fn(),
    getReportConfirmation: vi.fn(() => null),
    decideReportConfirmation: vi.fn(),
    createReportConfirmation: vi.fn(() => "conf-1"),
    confirmationDeliveryMeta: vi.fn(() => ({})),
    deliverStoredReportEmail: vi.fn(async () => "sent" as const),
    deliverStoredReportWebhook: vi.fn(async () => ({ outcome: "sent" as const, result: { success: true, status: 200 } })),
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true, status: 200 })),
    storeResearchReportCanonicalAsync: vi.fn(async () => ({ reportId: "r1", generationId: "g1" })),
    audit: vi.fn(),
    reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
    ...overrides,
  }) as ReportsRouteContext;

const req = (method: string, path: string) =>
  new Request(`https://agent.internal${path}`, { method });

// routeRequest passes the bare path separately from the URL (which
// carries the query string); endsWith matching depends on that split.
const call = (ctx: ReportsRouteContext, path: string, query = "") =>
  handleReportsRoutes(
    req("GET", path + query),
    new URL(`https://agent.internal${path}${query}`),
    path,
    "sess",
    ctx
  );

describe("Issue #1326 — GET /trading/reports/confirmations", () => {
  it("returns the run's confirmations joined via its canonical row", async () => {
    // #6101: the canonical half reads D1 now (getScheduledReportByRunId);
    // seed the canonical row there. The confirmations half stays DO.
    // The D1 reportId is a random UUID — the join still works because
    // the fake matches rows by table name, ignoring the report_id param.
    const d1 = new MockD1Database();
    await storeReportAtGeneration(
      {
        runId: "screener:2026-10-25T10:00:00.000Z",
        generationId: "screener:2026-10-25T10:00:00.000Z",
        title: "Market screen — ALL",
        source: "screener",
        summary: "Scanned 10 symbols.",
        body: {},
        userLogin: "tester",
      } as never,
      { AGENT_DB: d1 },
    );
    const ctx = baseCtx({
      env: { AGENT_DB: d1 },
      ensureTables: () =>
        makeSql({
          mas_report_confirmations: [
            {
              id: "conf-1",
              kind: "screener",
              status: "pending",
              created_at: "2026-10-25T10:00:00.000Z",
              decided_at: null,
              decided_by: null,
              payload_json: JSON.stringify({ title: "Screener follow-up" }),
            },
            {
              id: "conf-2",
              kind: "email",
              status: "approved",
              created_at: "2026-10-25T09:00:00.000Z",
              decided_at: "2026-10-25T09:30:00.000Z",
              decided_by: "ceos",
              payload_json: JSON.stringify({ recipient: "dhmprstw@gmail.com", fileName: "report.pdf" }),
            },
          ],
        }),
    });
    const res = await call(ctx, "/trading/reports/confirmations", "?runId=screener%3A2026-10-25T10%3A00%3A00.000Z");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(data.confirmations).toHaveLength(2);
    expect(data.confirmations[0]).toMatchObject({ confirmationId: "conf-1", kind: "screener", status: "pending" });
    expect(data.confirmations[1]).toMatchObject({ confirmationId: "conf-2", kind: "email", status: "approved", decidedBy: "ceos" });
    expect(data.confirmations[1].detail).toContain("dhmprstw@gmail.com");
  });

  it("a run with no canonical row returns an empty list, not an error", async () => {
    const ctx = baseCtx({ ensureTables: () => makeSql({}) });
    const res = await call(ctx, "/trading/reports/confirmations", "?runId=screener%3A2026-10-25T10%3A00%3A00.000Z");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(data.confirmations).toEqual([]);
  });

  it("a missing runId is a 400", async () => {
    const ctx = baseCtx();
    const res = await call(ctx, "/trading/reports/confirmations");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
