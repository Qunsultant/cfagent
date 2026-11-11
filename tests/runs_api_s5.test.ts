/**
 * Issue #1057 (consolidation S5): GET /api/runs — the one Runs read
 * surface over the four DO run stores. The fifth store — the engine's
 * D1 job run records (#3946 Option B) — merges here too; its pins live
 * in tests/run_recorder_two_ledgers_3946.test.ts, and this file pins
 * the four DO stores' merge contract unchanged.
 *
 * Pinned through the real route module the server dispatches to
 * (handleReportsRoutes, the §17.3 route-test idiom):
 *  1. kind=all merges all four stores newest-first, de-duplicated on
 *     the exact canonical joins (canonical row wins over both its
 *     scan-store twin and its ScreenerAgent-feed twin).
 *  2. kind filters server-side: a discovery-only read never touches
 *     the scan store or the canonical list.
 *  3. An invalid kind is a 400 with the S1 field-named error.
 *  4. Scoping: the scan store is queried with the caller's login
 *     (x-user-login header), exactly as its own route scopes it.
 *  5. Round-trip: a run persisted through the canonical write path
 *     (persistScheduledReportSql) is returned by /api/runs with the
 *     same id — write path and read surface agree on the row.
 *  6. The panel reads the Runs surface: ReportsPanel fetches
 *     /api/runs (not the old /api/reports list) and offers the
 *     discovery kind.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { handleReportsRoutes, type ReportsRouteContext } from "../src/agents/routes/reports";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
} from "../src/services/scheduledReports";

const TS = {
  discovery: "2026-10-22T11:00:00.000Z",
  options: "2026-10-22T10:00:00.000Z",
  scan2: "2026-10-22T09:30:00.000Z",
  screener: "2026-10-22T08:00:00.000Z",
};

const REPORT_ROWS = [
  {
    id: "rep-options-1",
    run_id: `options_scanner:${TS.options}:balanced`,
    title: "Options scanner — balanced",
    source: "options_scanner",
    summary: "Options scan summary.",
    body: JSON.stringify({ report: { result: { scanRunId: "scan-1", withTrades: 7 } } }),
    created_at: TS.options,
  },
  {
    id: "rep-screener-1",
    run_id: `screener:${TS.screener}`,
    title: "Market screen — NASDAQ100 (scheduled)",
    source: "screener",
    summary: "Scanned 100 symbols, 5 matched.",
    body: JSON.stringify({ trigger: "scheduled", success: true, matchedCount: 5, timestamp: TS.screener }),
    created_at: TS.screener,
  },
];

const SCAN_FIXTURE = {
  id: "scan-1",
  generatedAt: TS.options,
  mode: "best_trade",
  modelVersion: "1.1.2",
  gate: { fit: 3, borderline: 2, noFit: 5 },
  coverage: {
    considered: 10, scanned: 10, truncated: 0, evaluated: 10, errors: 0, withTrades: 4,
    eventCalendar: { covered: 0, total: 0, coveragePct: 0 },
  },
  profileRef: { id: "p1", name: "Growth", version: 2 },
  userLogin: "alice",
};

const SCAN2_FIXTURE = { ...SCAN_FIXTURE, id: "scan-2", generatedAt: TS.scan2 };

const DISCOVERY_FIXTURE = {
  id: "disc-1",
  createdAt: TS.discovery,
  userLogin: "alice",
  trigger: "scheduled",
  inputModel: "saved-request",
  status: "completed",
  requestCount: 2,
  completedCount: 2,
  failedCount: 0,
  abstainedCount: 0,
  symbols: ["AAPL"],
};

const FEED_RUN = {
  timestamp: TS.screener,
  trigger: "scheduled",
  provider: "etrade",
  universe: "NASDAQ100",
  sector: "ALL",
  success: true,
  totalScanned: 100,
  matchedCount: 5,
  opportunities: [],
  allStocks: [],
  discoveryMessage: "",
};

/** Per-table stub SQL over the four stores' list queries. The stores'
 *  ensure() DDL is answered benignly (PRAGMA claims user_login exists,
 *  so no ALTER is attempted); SELECTs are served per table. */
function makeSql() {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql = {
    calls,
    exec(query: string, ...params: unknown[]) {
      calls.push({ query, params });
      if (query.includes("PRAGMA")) return [{ name: "user_login" }];
      if (query.includes("mas_opportunity_scans")) {
        if (query.includes("SELECT summary_json")) {
          return [SCAN_FIXTURE, SCAN2_FIXTURE].map((s) => ({ summary_json: JSON.stringify(s) }));
        }
        return [];
      }
      if (query.includes("mas_discovery_runs")) {
        if (query.includes("SELECT summary_json")) {
          return [{ summary_json: JSON.stringify(DISCOVERY_FIXTURE) }];
        }
        return [];
      }
      if (query.includes("mas_reports") && query.includes("SELECT")) return REPORT_ROWS;
      return [];
    },
  };
  return sql as any;
}

function makeCtx(sql: any, feed: unknown[] = [FEED_RUN]): ReportsRouteContext {
  return {
    ensureTables: () => sql,
    getScreenerAgent: () => ({ getHistory: async () => feed }) as any,
    getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
    getReportDispatchHitl: () => ({}) as any,
    hitlPreviewReady: () => true,
    executeApprovedSend: async () => {},
    buildResearchEmailBody: (hit: any) => hit.body,
    buildResearchWebhookBody: (hit: any) => ({ body: hit.body }),
    reportHitlActions: new Map(),
    hitlApprovedDispatches: new Map(),
    hitlDispatchHistory: new Map(),
    recordHitlDispatchHistory: () => {},
    watchdogTimerCount: () => 0,
    lastReportWatchdogSweepCount: () => 0,
    lastReportWatchdogSweepAt: () => null,
    startReportWatchdog: () => {},
    stopReportWatchdog: () => {},
    persistApproval: () => {},
    persistDispatchStatus: () => {},
  } as ReportsRouteContext;
}

function runsRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://x${path}`, init);
}

async function call(path: string, ctx: ReportsRouteContext, init: RequestInit = {}) {
  const url = new URL(`https://x${path}`);
  return handleReportsRoutes(new Request(url, init), url, url.pathname, null, ctx);
}

describe("GET /api/runs (S5)", () => {
  it("merges all four DO stores newest-first with canonical de-duplication", async () => {
    const res = await call("/api/runs?kind=all", makeCtx(makeSql()), {
      headers: { "x-user-login": "alice" },
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.kind).toBe("all");
    // scan-1 (canonical twin) and the feed twin of the canonical
    // screener row are gone; everything else survives, newest first.
    expect(data.runs.map((r: any) => r.id)).toEqual([
      "disc-1",
      "rep-options-1",
      "scan-2",
      "rep-screener-1",
    ]);
    expect(data.count).toBe(4);
    const canonical = data.runs.find((r: any) => r.id === "rep-options-1");
    expect(canonical.reportId).toBe("rep-options-1");
    expect(canonical.scanRunId).toBe("scan-1");
    const detailOnly = data.runs.find((r: any) => r.id === "scan-2");
    expect(detailOnly.reportId).toBeNull();
    expect(detailOnly.status).toBeNull();
  });

  it("kind=discovery reads only the discovery store", async () => {
    const sql = makeSql();
    const res = await call("/api/runs?kind=discovery", makeCtx(sql), {
      headers: { "x-user-login": "alice" },
    });
    const data = (await res!.json()) as any;
    expect(data.runs.map((r: any) => r.kind)).toEqual(["discovery"]);
    const queried = sql.calls.map((c: any) => c.query).join("\n");
    expect(queried).not.toContain("mas_opportunity_scans");
    expect(queried).not.toContain("FROM mas_reports");
  });

  it("kind=screener returns canonical + feed screener runs only", async () => {
    const res = await call("/api/runs?kind=screener", makeCtx(makeSql()));
    const data = (await res!.json()) as any;
    expect(data.runs.map((r: any) => r.id)).toEqual(["rep-screener-1"]);
    expect(data.runs[0].kind).toBe("screener");
  });

  it("an invalid kind is a 400 with the S1 field-named error", async () => {
    const res = await call("/api/runs?kind=bogus", makeCtx(makeSql()));
    expect(res!.status).toBe(400);
    const data = (await res!.json()) as any;
    expect(data.error).toContain("kind:");
    expect(data.runs).toEqual([]);
  });

  it("scopes the scan store by the caller's x-user-login header", async () => {
    const sql = makeSql();
    await call("/api/runs?kind=options_scanner", makeCtx(sql), {
      headers: { "x-user-login": "alice" },
    });
    const scanSelect = sql.calls.find(
      (c: any) => c.query.includes("mas_opportunity_scans") && c.query.includes("SELECT summary_json"),
    );
    expect(scanSelect).toBeDefined();
    expect(scanSelect!.params[0]).toBe("alice");
  });

  it("does not claim POST /api/runs (falls through to the next family)", async () => {
    const res = await call("/api/runs", makeCtx(makeSql()), { method: "POST" });
    expect(res).toBeNull();
  });

  it("round-trip: a run persisted via the canonical write path is returned with its id", async () => {
    const mock = new MockSqlStorage() as any;
    ensureScheduledReportsTable(mock);
    const persistedId = persistScheduledReportSql(mock, {
      runId: `screener:${TS.screener}`,
      generationId: `screener:${TS.screener}`,
      userLogin: "alice",
      title: "Market screen — NASDAQ100 (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols, 5 matched.",
      body: { trigger: "scheduled", success: true, matchedCount: 5, timestamp: TS.screener },
      createdAt: TS.screener,
    });
    const res = await call("/api/runs?kind=all", makeCtx(mock, []));
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const row = data.runs.find((r: any) => r.id === persistedId);
    expect(row).toBeDefined();
    expect(row.kind).toBe("screener");
    expect(row.reportId).toBe(persistedId);
    expect(row.resultCount).toBe(5);
    expect(row.status).toBe("completed");
  });
});

describe("ReportsPanel runs surface (S5)", () => {
  const panel = readFileSync(join(process.cwd(), "src/client/ReportsPanel.tsx"), "utf8");

  it("lists from /api/runs and no longer fetches the /api/reports list", () => {
    expect(panel).toContain("/api/runs?kind=");
    expect(panel).not.toContain("`/api/reports?${params}`");
  });

  it("offers the discovery kind with a badge label", () => {
    expect(panel).toContain('"discovery"');
    expect(panel).toContain("Discovery");
  });

  it("keeps the semantic-search + detail hydration endpoints untouched", () => {
    expect(panel).toContain("/api/reports/semantic-search");
    expect(panel).toContain("/api/reports/");
  });
});
