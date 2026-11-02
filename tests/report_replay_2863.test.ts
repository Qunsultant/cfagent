import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { buildReplayFromRecord } from "../src/workflows/reportReplay";
import { getScheduledReportByRunId } from "../src/services/scheduledReports";

const FULL_BODY = {
  timestamp: "2026-10-30T09:30:00.000Z",
  universe: "TECH",
  sector: "ALL",
  provider: "etrade",
  trigger: "manual",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  criteria: { sector: "ALL", minPrice: 5 },
  patternRef: "pattern:breakout:v1",
  presetRef: "preset:momentum:v2",
  opportunities: [{ symbol: "AAPL" }],
  allStocks: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
  pdfKey: "reports/a.pdf",
  xlsxKey: "reports/a.xlsx",
};

describe("report replay #2863", () => {
  it("replays a full persisted body with provenance, no charge, no live fetch", () => {
    const env = buildReplayFromRecord({
      id: "rep-1",
      runId: "screener:2026-10-30T09:30:00.000Z",
      source: "screener",
      body: FULL_BODY,
    });
    expect(env.kind).toBe("replay");
    expect(env.reportKind).toBe("stock-screen");
    expect(env.charged).toBe(false);
    expect(env.liveFetch).toBe(false);
    expect(env.originalRunId).toBe("screener:2026-10-30T09:30:00.000Z");
    expect(env.generationId).toBe("screener:2026-10-30T09:30:00.000Z");
    if (env.reportKind === "stock-screen") {
      expect(env.rows).toEqual(FULL_BODY.allStocks);
      expect(env.standouts).toEqual(FULL_BODY.opportunities);
      expect(env.criteria).toEqual({ sector: "ALL", minPrice: 5 });
      expect(env.patternRef).toBe("pattern:breakout:v1");
      expect(env.presetRef).toBe("preset:momentum:v2");
      expect(env.partial).toBe(false);
      expect(env.partialReasons).toEqual([]);
    }
  });

  it("marks missing criteria partial instead of inventing them", () => {
    const { criteria: _omit, ...body } = FULL_BODY;
    const env = buildReplayFromRecord({ id: "rep-1", runId: "screener:x", source: "screener", body });
    expect(env.reportKind).toBe("stock-screen");
    if (env.reportKind === "stock-screen") {
      expect(env.criteria).toBeNull();
      expect(env.partial).toBe(true);
      expect(env.partialReasons.join(" ")).toMatch(/criteria/);
      expect(env.rows).toEqual(FULL_BODY.allStocks);
    }
  });

  it("marks missing standouts and artifacts partial, never silently complete", () => {
    const { opportunities: _o, pdfKey: _p, xlsxKey: _x, ...body } = FULL_BODY;
    const env = buildReplayFromRecord({ id: "rep-1", runId: "screener:x", source: "screener", body });
    expect(env.reportKind).toBe("stock-screen");
    if (env.reportKind === "stock-screen") {
      expect(env.standouts).toEqual([]);
      expect(env.partial).toBe(true);
      expect(env.partialReasons.join(" ")).toMatch(/standouts/);
      expect(env.partialReasons.join(" ")).toMatch(/artifacts/);
    }
  });

  it("fails loudly when the full set is missing — never regenerates it", () => {
    const { allStocks: _a, ...body } = FULL_BODY;
    expect(() =>
      buildReplayFromRecord({ id: "rep-1", runId: "screener:x", source: "screener", body }),
    ).toThrow(/not replayable/);
  });

  it("fails loudly on a missing or non-object body", () => {
    expect(() =>
      buildReplayFromRecord({ id: "rep-1", runId: "screener:x", source: "screener", body: null }),
    ).toThrow(/not replayable/);
    expect(() =>
      buildReplayFromRecord({ id: "rep-1", runId: "screener:x", source: "screener", body: "nope" }),
    ).toThrow(/not replayable/);
  });

  it("replays a stored research report verbatim, never regenerated", () => {
    const body = { symbol: "AAPL", rating: "BUY", narrative: "stored" };
    const env = buildReplayFromRecord({
      id: "rep-2",
      runId: "research:2026-10-30",
      source: "research_report",
      body,
    });
    expect(env.reportKind).toBe("research");
    expect(env.charged).toBe(false);
    expect(env.liveFetch).toBe(false);
    if (env.reportKind === "research") {
      expect(env.body).toEqual(body);
      expect(env.partial).toBe(false);
    }
  });

  it("zero-live-fetch pin: the replay module imports nothing it could call live through", () => {
    const src = fs.readFileSync("src/workflows/reportReplay.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/getQuote|liveScreener|providerRegistry/);
  });

  it("no-re-charge pin: the envelope never carries a charge or a new run", () => {
    const env = buildReplayFromRecord({
      id: "rep-1",
      runId: "screener:x",
      source: "screener",
      body: FULL_BODY,
    });
    expect(env).not.toHaveProperty("charge");
    expect(env).not.toHaveProperty("jobId");
    expect(env.charged).toBe(false);
  });

  it("getScheduledReportByRunId resolves by stored run_id, owner-scoped", () => {
    const row = {
      id: "rep-1",
      run_id: "screener:2026-10-30T09:30:00.000Z",
      title: "Market screen — TECH",
      source: "screener",
      summary: "",
      body: JSON.stringify(FULL_BODY),
      created_at: "2026-10-30T09:30:00.000Z",
      body_r2_key: "",
      fanout_outcome: "",
    };
    const sql = {
      exec: (query: string, ...params: unknown[]) => {
        if (String(query).includes("FROM mas_reports WHERE run_id")) {
          // Simulate the owner filter: only the owning login sees the row.
          if (params[1] && params[1] !== "alice") return [];
          return [row];
        }
        return [];
      },
    };
    const hit = getScheduledReportByRunId(sql as never, "screener:2026-10-30T09:30:00.000Z", {
      userLogin: "alice",
    });
    expect(hit?.id).toBe("rep-1");
    expect(hit?.runId).toBe("screener:2026-10-30T09:30:00.000Z");
    expect(
      getScheduledReportByRunId(sql as never, "screener:2026-10-30T09:30:00.000Z", {
        userLogin: "mallory",
      }),
    ).toBeNull();
    expect(getScheduledReportByRunId(sql as never, "", { userLogin: "alice" })).toBeNull();
  });
});
