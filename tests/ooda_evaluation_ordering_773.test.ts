/**
 * Issue #773 (b) — the ordering input exists and the run states what it did.
 *
 * (a) read the evaluation history and stated the truth: the reorder block read
 * `directionAccuracy` from a slice that never carried it, so history never
 * changed an order. (b) records the per-family direction accuracy on the slice
 * and moves the rule into `orderStructuresByTrackRecord`, so:
 *
 *  O1  the slice carries the accuracy from the RECORDED direction scores only
 *      (an unscored family is null, never a guessed 0);
 *  O2  a family below the weak threshold sorts last, one above the strong
 *      threshold sorts first, and families under the evaluation bar are neutral;
 *  O3  the pipeline applies that order and says so on the report — the
 *      adjustment is visible, not implied.
 */
import { describe, it, expect } from "vitest";
import { RESEARCH_RULES_DEFAULTS } from "../src/config/researchRules";
import {
  buildTrackRecord,
  type TrackRecordSlice,
} from "../src/services/researchTrackRecord";
import { orderStructuresByTrackRecord } from "../src/services/researchStructureOrdering";
import {
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
} from "../src/services/researchConfig";
import {
  runResearchPipeline,
  type ChainSnapshot,
  type QuoteSnapshot,
  type RegimeAssessment,
  type ResearchDataProvider,
  type Technicals,
} from "../src/services/researchPipeline";

const NOW = Date.now();

function slice(key: string, evaluated: number, directionAccuracy: number | null): TrackRecordSlice {
  return {
    key,
    published: evaluated,
    evaluated,
    winRate: 0.5,
    avgRMultiple: 0.2,
    directionAccuracy,
  };
}

function chainLegs() {
  const mk = (optionType: "call" | "put", strike: number, bid: number, ask: number) => ({
    optionType,
    strike,
    expiry: "2026-12-18",
    dte: 35,
    bid,
    ask,
    iv: 0.4,
    volume: 100,
    openInterest: 500,
  });
  return [
    mk("call", 95, 10.0, 10.4),
    mk("call", 100, 4.8, 5.0),
    mk("call", 105, 2.4, 2.6),
    mk("call", 110, 1.0, 1.1),
    mk("put", 90, 1.1, 1.2),
    mk("put", 95, 2.5, 2.7),
    mk("put", 100, 4.9, 5.1),
    mk("put", 105, 9.0, 9.4),
  ] as ChainSnapshot["expiries"][number]["legs"];
}

function fixtureProvider(): ResearchDataProvider {
  const quote = (symbol: string): QuoteSnapshot => ({
    symbol,
    price: 100,
    timestamp: NOW - 60_000,
    marketCap: 10e9,
    isEtf: false,
    quoteStatus: "live",
    source: "etrade",
  });
  return {
    getUniverseSymbols: async () => ["AAA"],
    getQuote: async (symbol) => quote(symbol),
    getChain: async (symbol) => ({
      symbol,
      underlyingPrice: 100,
      asOf: NOW - 60_000,
      provenance: "live",
      expiries: [{ expiry: "2026-12-18", dte: 35, legs: chainLegs() }],
    }),
    getTechnicals: async (): Promise<Technicals> => ({
      trend: "up",
      momentum: 0.3,
      rsi: 58,
      notes: [],
    }),
    getCatalysts: async () => null,
    getRegime: async (): Promise<RegimeAssessment> => ({
      regime: "bull",
      notes: ["Fixture regime."],
      asOf: NOW,
    }),
  };
}

function testConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    ...RESEARCH_CONFIG_DEFAULTS,
    maxCandidates: 4,
    maxChainsPerRun: 4,
    oodaMaxIterations: 10,
    ...overrides,
  };
}

describe("#773 (b) — history is an ordering input", () => {
  it("O1: the slice carries the accuracy from recorded direction scores only", () => {
    const report = {
      runId: "run-1",
      createdAt: "2026-11-01T00:00:00.000Z",
      regime: "bull",
      ideas: [
        { symbol: "AAA", structure: "bear_call_spread", outlook: "bearish", legs: [] },
        { symbol: "BBB", structure: "bear_call_spread", outlook: "bearish", legs: [] },
        { symbol: "CCC", structure: "bull_call_debit_spread", outlook: "bullish", legs: [] },
      ],
    };
    const evaluation = {
      runId: "run-1",
      evaluatedAt: "2026-11-02T00:00:00.000Z",
      ideas: [
        { symbol: "AAA", structure: "bear_call_spread", directionCorrect: false },
        { symbol: "BBB", structure: "bear_call_spread", directionCorrect: true },
        // CCC unscored: its family must read null, never 0.
        { symbol: "CCC", structure: "bull_call_debit_spread", directionCorrect: null },
      ],
    };
    const record = buildTrackRecord([report], [evaluation]);
    const family = (key: string) => record.byStrategy.find((s) => s.key === key)!;
    expect(family("bear_call_spread").directionAccuracy).toBe(0.5);
    expect(family("bull_call_debit_spread").directionAccuracy).toBeNull();
  });

  it("O2: weak sorts last, strong first, thin history is neutral", () => {
    const names = ["weak_family", "mid_family", "strong_family", "unknown_family"];
    const ordering = orderStructuresByTrackRecord(
      names,
      [
        slice("weak_family", 12, 0.25),
        slice("mid_family", 12, 0.5),
        slice("strong_family", 12, 0.8),
        slice("unknown_family", 3, 0.1), // under the 10-evaluation bar
      ],
      RESEARCH_RULES_DEFAULTS,
      10,
    );
    expect(ordering.names[0]).toBe("strong_family");
    expect(ordering.names[ordering.names.length - 1]).toBe("weak_family");
    expect(ordering.applied).toBe(true);
    expect(ordering.considered.map((c) => c.key)).toEqual([
      "mid_family",
      "strong_family",
      "weak_family",
    ]);
  });

  it("O3: the pipeline applies the order and states it on the report", async () => {
    const byStrategy = [
      slice("bull_call_debit_spread", 12, 0.2),
      slice("bear_call_spread", 12, 0.9),
      slice("long_straddle", 12, 0.5),
    ];
    const report = await runResearchPipeline(
      { provider: fixtureProvider(), trackRecord: { ...emptyRecord(), byStrategy } },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_773b", now: NOW },
    );
    const feedback = report.evaluationFeedback!;
    expect(feedback.families.map((f) => f.key)).toEqual(byStrategy.map((s) => s.key));
    expect(feedback.families[0].directionAccuracy).toBe(0.2);
    expect(feedback.families[0].directionAccuracyRecorded).toBe(true);
    // The adjustment is visible: either the order moved, or the report says it
    // found no change to make — never silence.
    expect(feedback.statement).toMatch(/History (reordered the structures|was read but changed no order)/);
    expect(report.oodaTrace.some((step) => step.detail.startsWith("Structure order by historical accuracy"))).toBe(true);
  });
});

function emptyRecord() {
  return {
    published: 0,
    evaluated: 36,
    invalidated: 0,
    winRate: null,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: [],
    byPeriod: [],
    ideas: [],
  };
}
