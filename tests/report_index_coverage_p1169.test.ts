/**
 * #1169 S4-1: Vectorize index coverage for screener/goal/options reports.
 *
 * Pins (stubbed AI + VECTOR_MEMORY capturing upserts):
 * 1. screener upsert via the WithR2 seam (kind "report", source screener, title).
 * 2. research_report upsert via storeResearchReportCanonicalAsync.
 * 3. ORM-seam goal_screen + options_scanner upserts.
 * 4. retention rows are NOT indexed.
 * 5. Bindings absent → store still succeeds, no vector.
 * 6. Upsert throws → store still succeeds (best-effort).
 * 7. Redelivery (same generationId) re-upserts the SAME vector id.
 * 8. Migration pin: seam-builder output for an options_research fixture
 *    EQUALS researchPublish's current ideas text (verbatim formula).
 * 9. Backfill route: paginated, exact covered set, skips retention,
 *    re-runnable without duplicates; 401 without a login.
 *
 * The seam hook is fire-and-forget (mirroring researchPublish's `void`
 * call), so tests flush microtasks before asserting upserts.
 */
import { describe, it, expect } from "vitest";
import { MockD1Database } from "./mock-d1";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import {
  indexCanonicalReport,
  buildCanonicalIndexText,
} from "../src/services/reportSemanticIndex";
import {
  persistScreenerReportCanonical,
  storeResearchReportCanonicalAsync,
} from "../src/agents/orchestrator/reportDispatch";
import { handleReportsRoutes } from "../src/agents/routes/reports";

type Upserted = {
  id: string;
  values: number[];
  metadata: { kind: string; reportId: string; title: string; source: string };
};

function makeEnv(upserts: Upserted[]) {
  return {
    // #6101: the canonical store lands in D1 — every env carries
    // a fresh binding, so each test's rows are its own.
    AGENT_DB: new MockD1Database(),
    AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
    VECTOR_MEMORY: {
      upsert: async (vectors: Upserted[]) => {
        upserts.push(...vectors);
      },
      query: async () => ({ matches: [] }),
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function screenerInput(generationId: string) {
  return {
    runId: generationId,
    generationId,
    title: `Market screen — ALL (${generationId})`,
    source: "screener",
    // Tenant rule (main's #183/#584 programme): the store refuses a row
    // without an owner, so fixtures carry one.
    userLogin: "tester",
    summary: "Scanned 10 symbols, 2 matched, 2 opportunities.",
    body: {
      timestamp: generationId,
      universe: "ALL",
      opportunities: [
        { symbol: "AAPL", structure: "call spread" },
        { symbol: "NVDA", structure: "put spread" },
      ],
    },
  };
}

describe("#1169 S4-1 report index coverage", () => {
  it("1. screener upsert via the WithR2 seam (kind report, source screener, title)", async () => {
    const sql = new MockSqlStorage();
    const upserts: Upserted[] = [];
    const env = makeEnv(upserts);
    await persistScreenerReportCanonical(
      { ensureTables: () => sql, env } as any,
      {
        timestamp: "2026-10-28T00:00:00Z",
        success: true,
        totalScanned: 10,
        matchedCount: 2,
        opportunities: [{ symbol: "AAPL", structure: "call spread" }],
        allStocks: [],
        userLogin: "tester",
      }
    );
    await flush();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].id).toMatch(/^report:/);
    expect(upserts[0].metadata.kind).toBe("report");
    expect(upserts[0].metadata.source).toBe("screener");
    expect(upserts[0].metadata.title).toContain("Market screen");
    expect(upserts[0].metadata.reportId).toBe(upserts[0].id.replace(/^report:/, ""));
  });

  it("2. research_report upsert via storeResearchReportCanonicalAsync", async () => {
    const sql = new MockSqlStorage();
    const upserts: Upserted[] = [];
    const env = makeEnv(upserts);
    const stored = await storeResearchReportCanonicalAsync(
      { ensureTables: () => sql, env } as any,
      JSON.stringify({ symbol: "AAPL", sections: [{ heading: "Thesis", text: "Strong demand." }] }),
      { title: "Market research — AAPL", summary: "Equity research report for AAPL.", userLogin: "tester" }
    );
    expect(stored).not.toBeNull();
    await flush();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].metadata.source).toBe("research_report");
    expect(upserts[0].metadata.title).toBe("Market research — AAPL");
  });

  it("3. ORM-seam goal_screen + options_scanner upserts", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const upserts: Upserted[] = [];
    const env = makeEnv(upserts);
    const goal = await orm.storeCanonicalReport(
      {
        runId: "goal-screen:task-1",
        generationId: "goal-screen:task-1",
        title: "Goal screen — growth (bullish)",
        source: "goal_screen",
        userLogin: "tester",
        summary: "Goal screen (growth/bullish) done: 3 hit(s) from 10 stocks + 2 option underlyings.",
        body: {
          taskId: "task-1",
          trigger: "manual",
          scenarioSource: "built",
          result: {
            goalKind: "growth",
            outlook: "bullish",
            status: "done",
            counts: { hits: 3, stocksScanned: 10, optionsUnderlyingsScanned: 2 },
          },
        },
      } as any,
      env as any
    );
    expect(goal).not.toBeNull();
    const scan = await orm.storeCanonicalReport(
      {
        runId: "options_scanner:2026-10-28T00:00:00Z",
        generationId: "options_scanner:2026-10-28T00:00:00Z",
        title: "Options scan — AAPL,NVDA (BOTH)",
        source: "options_scanner",
        userLogin: "tester",
        summary: "Options scan completed for AAPL,NVDA (thesis: BOTH).",
        body: { symbols: ["AAPL", "NVDA"], thesis: "BOTH", matchedCount: 4 },
      } as any,
      env as any
    );
    expect(scan).not.toBeNull();
    await flush();
    expect(upserts.map((u) => u.metadata.source).sort()).toEqual([
      "goal_screen",
      "options_scanner",
    ]);
  });

  it("4. retention rows are NOT indexed", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const upserts: Upserted[] = [];
    const env = makeEnv(upserts);
    const stored = await orm.storeCanonicalReport(
      {
        runId: "retention:2026-10-28",
        generationId: "retention:2026-10-28",
        title: "Storage pruning — 2026-10-28",
        source: "retention",
        userLogin: "tester",
        summary: "Pruned 5 stale rows.",
        body: { pruned: 5 },
      } as any,
      env as any
    );
    expect(stored).not.toBeNull();
    await flush();
    expect(upserts).toHaveLength(0);
  });

  it("5. bindings absent → store still succeeds, no vector", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const stored = await orm.storeCanonicalReport(screenerInput("screener:noenv") as any, { AGENT_DB: new MockD1Database() } as any);
    expect(stored).not.toBeNull();
    expect(stored!.reportId.length).toBeGreaterThan(0);
  });

  it("6. upsert throws → store still succeeds", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const env = {
      AGENT_DB: new MockD1Database(),
      AI: { run: async () => ({ data: [[0.1]] }) },
      VECTOR_MEMORY: {
        upsert: async () => {
          throw new Error("vector boom");
        },
        query: async () => ({ matches: [] }),
      },
    };
    const stored = await orm.storeCanonicalReport(screenerInput("screener:boom") as any, env as any);
    expect(stored).not.toBeNull();
    await flush();
    // No unhandled rejection: the test completing is the assertion.
    expect(stored!.reportId.length).toBeGreaterThan(0);
  });

  it("7. redelivery re-upserts the SAME vector id", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const upserts: Upserted[] = [];
    const env = makeEnv(upserts);
    const first = await orm.storeCanonicalReport(screenerInput("screener:redeliver") as any, env as any);
    expect(first).not.toBeNull();
    expect(first!.created).toBe(true);
    await flush();
    expect(upserts).toHaveLength(1);
    const firstId = upserts[0].id;
    const second = await orm.storeCanonicalReport(screenerInput("screener:redeliver") as any, env as any);
    expect(second).not.toBeNull();
    expect(second!.created).toBe(false);
    expect(second!.reportId).toBe(first!.reportId);
    await flush();
    expect(upserts).toHaveLength(2);
    expect(upserts[1].id).toBe(firstId);
  });

  it("8. migration pin: seam builder output EQUALS researchPublish ideas text", () => {
    const ideas = [
      { symbol: "NVDA", outlook: "bullish", structure: "call spread", thesis: "AI demand" },
      { symbol: "AAPL", outlook: "neutral", structure: "iron condor", thesis: "Range-bound" },
      { symbol: "TSLA", outlook: "bearish", structure: "put spread", thesis: "Delivery miss" },
      { symbol: "MSFT", outlook: "bullish", structure: "call", thesis: "Cloud growth" },
      { symbol: "AMD", outlook: "bullish", structure: "call spread", thesis: "Datacenter share" },
      { symbol: "META", outlook: "neutral", structure: "straddle", thesis: "Earnings vol" },
    ];
    const summary = "Weekly options research summary.";
    // researchPublish's formula, replicated literally (slice 0,5 + symbol/outlook/structure: thesis).
    const expected =
      `${summary}\n` +
      ideas
        .slice(0, 5)
        .map((i) => `${i.symbol} ${i.outlook} ${i.structure}: ${i.thesis}`)
        .join("\n");
    const built = buildCanonicalIndexText({
      source: "options_research",
      summary,
      title: "Options research — 2026-10-28 (weekly)",
      body: JSON.stringify({ ideas }),
    });
    expect(built).toBe(expected);
    // The 6th idea must NOT leak in (first-5 cap).
    expect(built).not.toContain("META");
  });

  it("9. backfill route: exact covered set, skips retention, re-runnable, 401 without login", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const d1 = new MockD1Database();
    const seeds: Array<{ generationId: string; source: string; title: string }> = [
      { generationId: "screener:bf-1", source: "screener", title: "Market screen — ALL (bf-1)" },
      { generationId: "goal-screen:bf-1", source: "goal_screen", title: "Goal screen — growth (bullish)" },
      { generationId: "options_scanner:bf-1", source: "options_scanner", title: "Options scan — AAPL (BOTH)" },
      { generationId: "research_report:bf-1", source: "research_report", title: "Market research — AAPL" },
      { generationId: "options_research:bf-1", source: "options_research", title: "Options research — 2026-10-28 (weekly)" },
      { generationId: "retention:bf-1", source: "retention", title: "Storage pruning — bf-1" },
      { generationId: "bundle:bf-1", source: "bundle", title: "Bundle — AAPL" },
    ];
    for (const s of seeds) {
      // No env at seed time: no vectors yet (pre-hook rows).
      const stored = await orm.storeCanonicalReport(
        {
          runId: s.generationId,
          generationId: s.generationId,
          title: s.title,
          source: s.source,
          summary: `Summary for ${s.title}.`,
          body: { seed: s.generationId },
          userLogin: "tester",
        } as any,
        { AGENT_DB: d1 } as any
      );
      expect(stored).not.toBeNull();
    }
    const upserts: Upserted[] = [];
    const env = { ...makeEnv(upserts), AGENT_DB: d1 };
    const ctx = { ensureTables: () => sql, env } as any;
    const callBackfill = (login: string | null) =>
      handleReportsRoutes(
        new Request("https://agent.internal/trading/reports/index-backfill", {
          method: "POST",
          headers: login ? { "x-user-login": login, "Content-Type": "application/json" } : {},
          body: JSON.stringify({ limit: 100, offset: 0 }),
        }),
        new URL("https://agent.internal/trading/reports/index-backfill"),
        "/trading/reports/index-backfill",
        "sess",
        ctx
      );
    // 401 without a login.
    const denied = await callBackfill(null);
    expect(denied).not.toBeNull();
    expect((denied as Response).status).toBe(401);
    // First run: exactly the covered set (all but retention).
    const first = await callBackfill("tester");
    expect(first).not.toBeNull();
    const firstBody = await (first as Response).json();
    expect(firstBody.upserted).toBe(6);
    expect(firstBody.skippedRetention).toBe(1);
    expect(firstBody.nextOffset).toBeNull();
    expect(upserts).toHaveLength(6);
    const firstIds = new Set(upserts.map((u) => u.id));
    expect(firstIds.size).toBe(6);
    // Re-run: same ids again, no duplicates.
    const second = await callBackfill("tester");
    expect(second).not.toBeNull();
    const secondBody = await (second as Response).json();
    expect(secondBody.upserted).toBe(6);
    expect(upserts).toHaveLength(12);
    expect(new Set(upserts.map((u) => u.id))).toEqual(firstIds);
    // The hook helper itself is also directly usable (smoke).
    expect(
      await indexCanonicalReport(env as any, {
        reportId: "direct-1",
        title: "Direct",
        source: "screener",
        summary: "Direct summary.",
        body: JSON.stringify({ opportunities: [{ symbol: "AAPL", structure: "call" }] }),
        bodyR2Key: null,
      })
    ).toBe(true);
  });
});
