/**
 * #1731 (parent #1717, slice (k)): report generator remainders —
 * NEVER EITHER/OR, ALWAYS CONFIGURABLE, with a deliberate
 * zero-switch outcome (the #1730 precedent): every divergent pair
 * in scan appendix (k) is divergent-by-design, so this slice pins
 * each pair's resolution instead of forcing a phantom switch.
 *
 * Pins (10 appendix-(k) findings):
 * - R-1 three PDF renderers: PINNED, routing unified, renderers NOT
 *   merged (different content models; a merged renderer would be a
 *   redesign, not a dedup).
 * - R-2 goal-screen artifacts: PINNED, generate leg direct, store
 *   leg unified (shared blob seam + storeReportStage in the
 *   scheduled path).
 * - R-3 tabular orchestration: PINNED, two sites over shared
 *   generators (per-run + latest keys vs single per-run key with
 *   read-back verification — caller contracts, not accidents).
 * - R-7 report-confirm delivery: PINNED, legacy pre-#308 shim
 *   retained; retirement gated on pre-#308 rows draining, never
 *   on a date.
 * - S1 two research-report engines: PINNED as two capabilities
 *   sharing a word (single-symbol equity report vs governed
 *   options-research OODA loop); the shared seam is the
 *   PDF/history surfaces (R-4/R-5/R-6).
 * - R-4 canonical store, R-5 blob store, R-6 semantic index:
 *   IDENTICAL, pin only.
 * - R07 routes-scan carry-over: RESOLVED into R-1..R-7, not a
 *   separate pair.
 * - S2 goal/scenario screen orchestration: IDENTICAL (appendix-(k)
 *   finding #10; not enumerated in the #1731 issue body — recorded
 *   here so the slice covers all 10 appendix-(k) pairs).
 *
 * Plus one minimal executable hardening on the R-1/R-2 boundary:
 * the ONE dispatch refuses unknown types loudly instead of
 * silently rendering them as options (the #1641-class silent
 * misrender the old screener-else-options mapping had for
 * research input). A goal-screen type through the dispatch is
 * therefore impossible by accident: it must use its pinned
 * direct path, or gain an explicit pipeline type in a future
 * slice.
 *
 * TDD Red: (1) module-missing before the registry exists;
 * (2) unknown-type dispatch tests fail before the hardening
 * (the dispatch silently falls through to the options branch).
 */
import { describe, it, expect } from "vitest";
import {
  REPORT_GENERATOR_1731_PINS,
  REPORT_GENERATOR_1731_SWITCHES,
  reportGeneratorPin,
} from "../src/config/reportGeneratorModes";
import {
  generateReportPdf,
  getReportFileName,
} from "../src/services/unifiedReportPipeline";
import { generateGoalScreenPdf } from "../src/services/goalScreenReports";
import {
  goalScreenArtifactKey,
  isGoalScreenArtifactKey,
} from "../src/services/goalScreenReports";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import type { ScreenerRunResult, OptionScreenResult } from "../src/types";
import type { ResearchReport } from "../src/services/researchPipeline";

function screenerFixture(): ScreenerRunResult {
  return {
    timestamp: "2026-10-21T06:00:00.000Z",
    universe: "NASDAQ100",
    sector: "TECH",
    success: true,
    totalScanned: 100,
    expectedCount: 100,
    matchedCount: 1,
    opportunities: [
      {
        symbol: "NVDA",
        companyName: "NVIDIA Corp",
        lastPrice: 217.23,
        changePercent: 3.5,
        signal: "BULLISH_MOMENTUM",
        momentumScore: 82,
        indicators: {
          sentiment: "bullish",
          directional: true,
          rangeZone: "breakout",
          valueZone: "neutral",
          screenScore: 88,
          summary: "Strong breakout",
        },
      },
    ],
    allStocks: [],
    discoveryMessage: "Found 1 opportunity",
  } as unknown as ScreenerRunResult;
}

function optionsFixture(): OptionScreenResult {
  return {
    totalUnderlyingsScanned: 2,
    totalContractsEvaluated: 10,
    matchedCount: 1,
    filterApplied: { underlyingSymbols: ["NVDA", "AAPL"] },
    filterSummary: "delta >= 0.30",
    contracts: [
      {
        symbol: "NVDA_261023C200",
        underlyingSymbol: "NVDA",
        expirationDate: "2026-10-23",
        strikePrice: 200,
        optionType: "CALL",
        delta: 0.45,
        impliedVolatility: 0.35,
        bid: 12.5,
        ask: 13.0,
      },
    ],
    scannedAt: "2026-10-21T06:00:00.000Z",
    status: "matches_found",
  } as unknown as OptionScreenResult;
}

function researchFixture(): ResearchReport {
  return {
    runId: "run-1731-test",
    generationId: "gen-1731",
    trigger: "scheduled",
    userLogin: "tester",
    createdAt: "2026-10-20T12:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: {},
    regime: { regime: "chop", notes: [], asOf: 0 },
    summary: "Test run summary.",
    ideas: [],
    watchlist: [],
    rejected: [],
    stats: {
      universeSize: 101,
      quotesRetrieved: 100,
      candidatesEvaluated: 50,
      chainsFetched: 10,
      chainsCalibrated: 10,
      qualified: 0,
      watchlist: 0,
      rejected: 0,
      unverified: 0,
      oodaIterations: 2,
      durationMs: 1000,
    },
    oodaTrace: [],
  } as unknown as ResearchReport;
}

function opportunityHuntFixture(): import("../src/services/opportunityHunt").OpportunityHuntResult {
  return {
    scanned: 2,
    skipped: 0,
    setups: [
      {
        symbol: "AAA",
        strategy: "sma_crossover",
        direction: "entry",
        lastClose: 100,
        detail: "(Fast SMA 101.00 > Slow 99.00)",
        levels: { entryLow: 99.5, entryHigh: 100.5, stopLoss: 95, takeProfit: 110 },
      },
      {
        symbol: "AAA",
        strategy: "mean_reversion",
        direction: "exit",
        lastClose: 100,
        detail: "(close 3.0% above entry)",
        entryPrice: 97,
      },
    ],
    summary: "Opportunity hunt: 2 setup(s) across 2 symbol(s), 1 entry, 1 exit — AAA:sma_crossover, AAA:mean_reversion",
    asOf: "2026-11-24T14:14:00.000Z",
    holdingsStatus: { available: true, broker: "alpaca" },
    seriesBySymbol: { AAA: [95, 96, 97, 98, 99, 100] },
  };
}

function goalScreenFixture(): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: [],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [],
    counts: {
      stocksScanned: 100,
      stocksMatched: 0,
      optionsUnderlyingsScanned: 1,
      optionsContractsMatched: 0,
      hits: 0,
    },
  } as unknown as GoalDrivenScreenResult;
}

describe("report generator remainders registry (#1731, appendix (k))", () => {
  it("adds NO runtime switch: the switch list is deliberately empty", () => {
    expect(REPORT_GENERATOR_1731_SWITCHES).toEqual([]);
  });

  it("pins all 10 appendix-(k) findings, each with a reason and a default behavior", () => {
    expect(REPORT_GENERATOR_1731_PINS.map((p) => p.id)).toEqual([
      "R-1",
      "R-2",
      "R-3",
      "R-7",
      "S1",
      "R-4",
      "R-5",
      "R-6",
      "R07",
      "S2",
    ]);
    for (const pin of REPORT_GENERATOR_1731_PINS) {
      expect(pin.reason.length).toBeGreaterThan(40);
      expect(pin.defaultBehavior.length).toBeGreaterThan(40);
    }
  });

  it("resolutions: divergent pairs pinned, identical paths identical, R07 resolved", () => {
    const byId = new Map(REPORT_GENERATOR_1731_PINS.map((p) => [p.id, p.resolution]));
    expect(byId.get("R-1")).toBe("pinned");
    expect(byId.get("R-2")).toBe("pinned");
    expect(byId.get("R-3")).toBe("pinned");
    expect(byId.get("R-7")).toBe("pinned");
    expect(byId.get("S1")).toBe("pinned");
    expect(byId.get("R-4")).toBe("identical");
    expect(byId.get("R-5")).toBe("identical");
    expect(byId.get("R-6")).toBe("identical");
    expect(byId.get("R07")).toBe("resolved");
    expect(byId.get("S2")).toBe("identical");
  });

  it("every pinned pair names the flip that must NOT happen", () => {
    for (const pin of REPORT_GENERATOR_1731_PINS.filter((p) => p.resolution === "pinned")) {
      expect(pin.reason).toMatch(/must NOT/);
    }
  });

  it("lookup returns the pin by id and undefined for unknown ids", () => {
    expect(reportGeneratorPin("R-1")?.id).toBe("R-1");
    expect(reportGeneratorPin("S1")?.resolution).toBe("pinned");
    expect(reportGeneratorPin("nope" as never)).toBeUndefined();
  });

  it("R-1 records the three rendering deltas (margins, wrap, glyphs)", () => {
    const pin = reportGeneratorPin("R-1")!;
    expect(pin.defaultBehavior).toMatch(/36pt/);
    expect(pin.defaultBehavior).toMatch(/48pt/);
    expect(pin.defaultBehavior).toMatch(/120 chars/);
  });

  it("R-7 records the drain retirement condition, not a date", () => {
    const pin = reportGeneratorPin("R-7")!;
    expect(pin.defaultBehavior).toMatch(/drain/);
    expect(pin.defaultBehavior).not.toMatch(/202\d-\d\d-\d\d/);
  });

  it("R-4 names the three generation-id schemes (caller-level caveat, not store divergence)", () => {
    const pin = reportGeneratorPin("R-4")!;
    expect(pin.defaultBehavior).toMatch(/type:trigger:timestamp/);
    expect(pin.defaultBehavior).toMatch(/sha256/);
    expect(pin.defaultBehavior).toMatch(/generationIdOf/);
  });
});

describe("the ONE dispatch (#1731 R-1/R-2 boundary)", () => {
  it("routes each pipeline type to a valid PDF", async () => {
    for (const [type, result] of [
      ["screener", screenerFixture()],
      ["options", optionsFixture()],
      ["research", researchFixture()],
      ["opportunity-hunt", opportunityHuntFixture()],
    ] as const) {
      const bytes = await generateReportPdf(type, result);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    }
  });

  it("refuses an unknown type loudly instead of silently rendering it as options", async () => {
    await expect(
      generateReportPdf("goal_screen" as never, goalScreenFixture())
    ).rejects.toThrow(/unknown report type/i);
    await expect(
      getReportFileName("goal_screen" as never, goalScreenFixture())
    ).rejects.toThrow(/unknown report type/i);
  });

  it("the goal-screen direct path still produces its own PDF (not deleted, not rerouted)", async () => {
    const bytes = await generateGoalScreenPdf(goalScreenFixture());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("goal-screen keys keep their own family (R-2 key pin)", () => {
    const key = goalScreenArtifactKey("pdf", "abcd1234");
    expect(key).toBe("goal_screen:pdf:abcd1234");
    expect(isGoalScreenArtifactKey(key)).toBe(true);
    expect(isGoalScreenArtifactKey("screener:pdf:abcd1234")).toBe(false);
  });
});
