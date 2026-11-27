/**
 * Issue #783 — screener reports have exactly ONE home (regression pins).
 *
 * The #732 fix made ScreenerAgent.persistRun write every scheduled/manual
 * screen into the ScreenerAgent DO's OWN mas_reports (via
 * persistScheduledReportSql). Nothing ever read that copy: the Reports
 * tab, the report routes and AI Search all read the ORCHESTRATOR
 * instance's mas_reports, where the canonical copy is stored at
 * generation time through the #308 seam —
 *   - scheduled runs: OrchestratorAgent's scheduled callback stores
 *     runId/generationId `screener:<res.timestamp>` after
 *     ScheduledTasksService.autonomousMarketScreen returns;
 *   - manual runs: the /etrade/screen route stores via
 *     persistScreenerReportCanonical (generationId `screener:<timestamp>`).
 * The screener-side write was a wasted second write into a store with no
 * reader — and, since #835 made persistRun throw on its failure, a dead
 * write that could fail an otherwise-good run (the 2026-10-21 03:30Z
 * production alert, RCA'd in #876).
 *
 * Pins:
 *  - Structural (Red while the duplicate write exists): ScreenerAgent
 *    carries no mas_reports footprint at all — no persistScheduledReportSql
 *    call, no mas_reports reference — while persistRun keeps the delivery
 *    cache it owns (latest/history in DO storage, per-run PDFs).
 *  - Behavioural (characterization of the surviving home — passes before
 *    and after, by design): a screener report stored through the
 *    orchestrator seam (DatabaseORM.storeCanonicalReport, the exact call
 *    both orchestrator paths make) lands as EXACTLY ONE D1 agent_reports
 *    report id (#6101 step 8 — the DO mas_reports table is frozen at
 *    cutover and receives no new writes), dedupes on the generation id,
 *    and reads back through the exact functions the Reports routes use
 *    (listScheduledReports / getScheduledReportById) — the test-level
 *    proof that #732's regression (Reports tab empty) stays fixed with
 *    the screener-side write gone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import {
  listScheduledReports,
  getScheduledReportById,
} from "../src/services/scheduledReports";

type D1Database = any;

function d1Env() {
  const mock = new MockD1Database();
  const env = { AGENT_DB: mock as unknown as D1Database, IAAA_TENANT_ID: "tenant-783" };
  return { mock, env };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenerSrc = readFileSync(
  path.join(repoRoot, "src/agents/screener-agent.ts"),
  "utf-8"
);

describe("ScreenerAgent has no mas_reports write (#783 removal)", () => {
  it("never calls persistScheduledReportSql", () => {
    expect(screenerSrc).not.toContain("persistScheduledReportSql");
  });

  it("carries no mas_reports reference at all (no second home)", () => {
    expect(screenerSrc).not.toContain("mas_reports");
  });

  it("persistRun still persists the delivery cache it owns (latest/history)", () => {
    const start = screenerSrc.indexOf("private async persistRun");
    expect(start).toBeGreaterThan(-1);
    const persistRun = screenerSrc.slice(start, start + 4000);
    expect(persistRun).toContain("LATEST_KEY");
    expect(persistRun).toContain("HISTORY_KEY");
    expect(persistRun).toContain("ctx.storage.put");
  });
});

/** The input shape OrchestratorAgent builds for a scheduled screener run. */
function scheduledScreenerInput(timestamp: string) {
  return {
    runId: `screener:${timestamp}`,
    generationId: `screener:${timestamp}`,
    title: "Autonomous market screen — NASDAQ100",
    source: "screener",
    summary: "Scanned 100 symbols, 12 matched, 5 opportunities.",
    body: {
      timestamp,
      universe: "NASDAQ100",
      sector: "ALL",
      trigger: "scheduled",
      success: true,
      totalScanned: 100,
      matchedCount: 12,
      opportunities: [{ symbol: "NVDA" }],
      allStocks: [{ symbol: "NVDA" }, { symbol: "AAPL" }],
      pdfKey: `screener-reports/screen-${timestamp}.pdf`,
    },
    createdAt: timestamp,
    userLogin: "tenant@example.com",
  } as const;
}

/** Distinct D1 report ids visible through the Reports-route list. */
async function rowCount(env: { AGENT_DB: D1Database }): Promise<number> {
  const hits = await listScheduledReports(env, { limit: 100 });
  return new Set(hits.map((h) => h.id)).size;
}

describe("the orchestrator store is the single home for screener reports", () => {
  it("a scheduled screen's report lands as exactly one row and reads back through the Reports-route functions", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    const { env } = d1Env();
    const ts = "2026-10-21T03:30:00.000Z";

    const stored = await orm.storeCanonicalReport(scheduledScreenerInput(ts) as any, env);
    expect(stored).not.toBeNull();
    expect(stored!.created).toBe(true);
    expect(await rowCount(env)).toBe(1);

    // The list the Reports tab renders (routes/reports.ts calls
    // listScheduledReports with a source filter).
    const listed = await listScheduledReports(env, {
      sourceFilter: "screener",
      limit: 10,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(stored!.reportId);
    expect(listed[0].title).toBe("Autonomous market screen — NASDAQ100");
    expect(listed[0].summary).toContain("12 matched");

    // The detail route's lookup (routes/reports.ts calls
    // getScheduledReportById).
    const hit = await getScheduledReportById(env, stored!.reportId, {});
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("screener");
    const body = JSON.parse(hit!.body);
    expect(body.universe).toBe("NASDAQ100");
    expect(body.opportunities).toEqual([{ symbol: "NVDA" }]);
  });

  it("re-storing the same run (re-delivery / second writer) dedupes to the same single row", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    const { env } = d1Env();
    const ts = "2026-10-21T03:30:00.000Z";

    const first = await orm.storeCanonicalReport(scheduledScreenerInput(ts) as any, env);
    const second = await orm.storeCanonicalReport(scheduledScreenerInput(ts) as any, env);
    expect(first!.created).toBe(true);
    expect(second!.created).toBe(false);
    expect(second!.reportId).toBe(first!.reportId);
    expect(await rowCount(env)).toBe(1);
  });

  it("two distinct runs produce exactly two rows — one per run, no duplicates", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    const { env } = d1Env();

    await orm.storeCanonicalReport(
      scheduledScreenerInput("2026-10-21T03:30:00.000Z") as any,
      env,
    );
    await orm.storeCanonicalReport(
      scheduledScreenerInput("2026-10-21T04:30:00.000Z") as any,
      env,
    );
    expect(await rowCount(env)).toBe(2);
    expect(
      await listScheduledReports(env, { sourceFilter: "screener", limit: 10 }),
    ).toHaveLength(2);
  });
});
