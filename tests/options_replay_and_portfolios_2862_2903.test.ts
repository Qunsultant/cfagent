import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { replayOptionsReport } from "../src/services/optionsReportReplay";
import { MockD1Database } from "./mock-d1";
import {
  constructPortfolioFromSnapshots,
  createRecommendationSnapshot,
  getRecommendationSnapshot,
  listRecommendationSnapshots,
  type RecommendationSnapshot,
} from "../src/services/recommendationPortfolios";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const createInMemorySqlStorage = () => new SqliteTestStorage();

describe("2862 options report replay from stored data", () => {
  it("reproduces a new run linked via replayedFrom without overwriting the original or fetching live", async () => {
    const sql = createInMemorySqlStorage();
    const storedCalls: Array<Record<string, unknown>> = [];
    const hit = {
      id: "rep-orig",
      runId: "run-orig",
      title: "Options Run",
      source: "options_scanner",
      summary: "2 candidates",
      body: JSON.stringify({
        strategyMode: "all",
        scanRunId: "scan-orig",
        captureIds: ["cap-1"],
        result: { withTrades: 2 },
      }),
      bodyR2Key: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      generationId: "gen-orig",
      fanoutOutcome: null,
      userLogin: "owner",
    };

    const res = await replayOptionsReport(
      {
        sql: sql as any,
        orm: {
          storeCanonicalReport: (input) => {
            storedCalls.push(input);
            return { reportId: "rep-replay-1", created: true };
          },
        },
        findSourceReport: () => hit,
        listCaptures: () => [],
      },
      {
        sourceRunId: "run-orig",
        replayRunId: "run-replay-1",
        tenantId: "t1",
        userLogin: "owner",
      },
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.replayRunId).toBe("run-replay-1");
      expect(res.replayedFrom).toEqual({
        runId: "run-orig",
        reportId: "rep-orig",
        captureIds: ["cap-1"],
        bodyR2Key: null,
      });
    }
    expect(storedCalls).toHaveLength(1);
    expect((storedCalls[0].body as any).replayedFrom.runId).toBe("run-orig");
  });

  it("refuses loudly when captures are absent or R2 body is unresolved", async () => {
    const sql = createInMemorySqlStorage();
    const noCaptures = await replayOptionsReport(
      {
        sql: sql as any,
        orm: { storeCanonicalReport: () => null },
        findSourceReport: () => ({
          id: "rep-empty",
          runId: "run-empty",
          title: "Empty",
          source: "options_scanner",
          summary: "",
          body: JSON.stringify({ result: {} }),
          bodyR2Key: null,
          createdAt: "2026-11-19T10:00:00.000Z",
          generationId: null,
          fanoutOutcome: null,
          userLogin: "owner",
        }),
        listCaptures: () => [],
      },
      { sourceRunId: "run-empty", tenantId: "t1", userLogin: "owner" },
    );
    expect(noCaptures.ok).toBe(false);
    if (!noCaptures.ok) expect(noCaptures.code).toBe("FAILURE_REPLAY_CAPTURES_ABSENT");

    const missingR2 = await replayOptionsReport(
      {
        sql: sql as any,
        orm: { storeCanonicalReport: () => null },
        findSourceReport: () => ({
          id: "rep-r2",
          runId: "run-r2",
          title: "R2 Missing",
          source: "options_scanner",
          summary: "",
          body: "",
          bodyR2Key: "reports/rep-r2/body.json",
          createdAt: "2026-11-19T10:00:00.000Z",
          generationId: null,
          fanoutOutcome: null,
          userLogin: "owner",
        }),
        resolveBody: async () => null,
      },
      { sourceRunId: "run-r2", tenantId: "t1", userLogin: "owner" },
    );
    expect(missingR2.ok).toBe(false);
    if (!missingR2.ok) expect(missingR2.code).toBe("FAILURE_REPLAY_BODY_UNRESOLVED");
  });
});

describe("2903 timestamped recommendation portfolios with full lineage", () => {
  it("stores immutable snapshots and constructs a new portfolio without mutating sources", async () => {
    // #6101 step 8: snapshots persist in D1 agent_reports via env
    // (the first arg is env now, not sql).
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as never };
    const s1: RecommendationSnapshot = {
      snapshotId: "snap-1",
      runId: "run-1",
      userLogin: "owner",
      tenantId: "t1",
      recommendationId: "rec-1",
      kind: "individual",
      symbols: ["AAPL"],
      thesis: "Bullish post-earnings drift",
      capturedAtUtc: "2026-11-19T12:00:00.000Z",
      dataAsOf: "2026-11-19",
      legs: [{ instrument: "AAPL 200C", direction: "buy", strike: 200, expiry: "2026-12-18", quantity: 1, premium: 4.5 }],
      netPremium: -4.5,
      netGreeks: { delta: 0.45, gamma: 0.03, theta: -0.05, vega: 0.12 },
      maxProfit: null,
      maxLoss: 450,
      breakevens: [204.5],
      capitalAtRisk: 450,
      payoffCurve: [],
      lineage: { sourceRunId: "run-1", captureIds: ["cap-a"], stage: "analysis" },
    };
    const s2: RecommendationSnapshot = {
      ...s1,
      snapshotId: "snap-2",
      recommendationId: "rec-2",
      symbols: ["MSFT"],
      thesis: "Cloud momentum",
      capturedAtUtc: "2026-11-19T12:05:00.000Z",
      legs: [{ instrument: "MSFT 450P", direction: "sell", strike: 450, expiry: "2026-12-18", quantity: 1, premium: 6.0 }],
      netPremium: 6.0,
      netGreeks: { delta: 0.3, gamma: -0.02, theta: 0.04, vega: -0.1 },
      breakevens: [444],
      capitalAtRisk: 1000,
      lineage: { sourceRunId: "run-2", captureIds: ["cap-b"], stage: "analysis" },
    };

    // #6101 step 8: the snapshot/portfolios seam is async now.
    expect((await createRecommendationSnapshot(env, s1)).created).toBe(true);
    expect((await createRecommendationSnapshot(env, s1)).created).toBe(false); // immutable
    expect((await createRecommendationSnapshot(env, s2)).created).toBe(true);

    const constructed = await constructPortfolioFromSnapshots(env, {
      snapshotId: "portfolio-1",
      runId: "run-port-1",
      userLogin: "owner",
      tenantId: "t1",
      sourceSnapshotIds: ["snap-1", "snap-2"],
    });
    expect(constructed.ok).toBe(true);
    if (constructed.ok) {
      expect(constructed.snapshot.kind).toBe("portfolio-combination");
      expect(constructed.snapshot.symbols).toEqual(["AAPL", "MSFT"]);
      expect(constructed.snapshot.legs).toHaveLength(2);
      expect(constructed.snapshot.netPremium).toBe(1.5);
      expect(constructed.snapshot.lineage.derivedFromSnapshotIds).toEqual(["snap-1", "snap-2"]);
      expect(constructed.snapshot.lineage.captureIds).toEqual(["cap-a", "cap-b"]);
    }

    expect(await listRecommendationSnapshots(env, "t1", "owner")).toHaveLength(3);
    expect((await getRecommendationSnapshot(env, "t1", "owner", "snap-1"))?.legs).toHaveLength(1);
  });
});
