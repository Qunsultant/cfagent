/**
 * Issue #6037 (c) — the scoring, thesis-ladder and evaluation rules are read
 * from the versioned block, not literals.
 *
 * The seam landed in #6310 (`src/config/researchRules.ts`) and slice (b) moved
 * the structure rules. This slice moves the same way for the five remaining
 * decision families: score weights, the non-live and event-risk penalties, the
 * thesis strength ladder, the track-record thresholds, the pre-screen
 * multiplier and the breakeven band.
 *
 * What this file pins:
 *
 *  C1  **behaviour is unchanged at the defaults**: every default equals the
 *      literal `researchPipeline.ts` used, and the resolvable rules a run reads
 *      are the defaults when nothing is stored.
 *  C2  **a stored override changes the decision**: the reported idea score is
 *      exactly the configured weights applied to the thesis strength, so the
 *      ranking is provably driven by the block (not by a literal that shadows
 *      it).
 *  C3  **the literals are gone from the decision path** and the pipeline reads
 *      each key — the grep pin that stops one from creeping back, plus the
 *      one-declaration reuse of `MIN_EVALUATED_FOR_ORDERING`.
 *
 * The wider behaviour at the defaults is covered by the existing suites
 * (`research-pipeline`, `research-pmcc-window`, `ooda_evaluation_feedback_773`,
 * `iv_defaults_removed_926`), which run unchanged in CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RESEARCH_RULES_DEFAULTS } from "../src/config/researchRules";
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

function chainLegs() {
  const mk = (
    optionType: "call" | "put",
    strike: number,
    bid: number,
    ask: number,
  ) => ({
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

function source(): string {
  return readFileSync("src/services/researchPipeline.ts", "utf8");
}

describe("#6037 (c) — scoring, thesis and evaluation rules are data", () => {
  it("C1: every default equals the literal the pipeline used", () => {
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightThesis).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightLiquidity).toBe(0.35);
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightRewardRisk).toBe(0.25);
    expect(RESEARCH_RULES_DEFAULTS.nonLiveProvenancePenalty).toBe(-1);
    expect(RESEARCH_RULES_DEFAULTS.eventRiskPenalty).toBe(0.15);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthBase).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthStrong).toBe(0.55);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthVeryStrong).toBe(0.6);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthPerConfirmation).toBe(0.1);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthCap).toBe(1);
    expect(RESEARCH_RULES_DEFAULTS.trackRecordWeakBelow).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.trackRecordStrongAbove).toBe(0.6);
    expect(RESEARCH_RULES_DEFAULTS.candidatePreScreenMultiplier).toBe(3);
    expect(RESEARCH_RULES_DEFAULTS.breakevenToleranceLower).toBe(0.98);
    expect(RESEARCH_RULES_DEFAULTS.breakevenToleranceUpper).toBe(1.02);
  });

  it("C2: a stored override drives the reported score (weights are the block's)", async () => {
    const defaults = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_c2_defaults", now: NOW },
    );
    expect(defaults.ideas.length).toBeGreaterThan(0);

    // All weight on the thesis strength: the same fixture trend (up) is the
    // block's very-strong rung, so the score is exactly that rung — proof the
    // reported score comes from the weights and the ladder, not a literal.
    const thesisOnly = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig({
        rules: {
          scoreWeightThesis: 1,
          scoreWeightLiquidity: 0,
          scoreWeightRewardRisk: 0,
        },
      }),
      { trigger: "manual", userLogin: "tester", runId: "rsr_c2_thesis", now: NOW },
    );
    expect(thesisOnly.ideas.length).toBeGreaterThan(0);
    expect(thesisOnly.ideas[0].score).toBe(RESEARCH_RULES_DEFAULTS.thesisStrengthVeryStrong);
    // And the default mix is a different number: the override is what moved it.
    expect(thesisOnly.ideas[0].score).not.toBe(defaults.ideas[0].score);
  });

  it("C3: no scoring/thesis/evaluation literal is left in the pipeline", () => {
    const text = source();
    expect(text).not.toMatch(/0\.4 \* thesisStrength/);
    expect(text).not.toMatch(/0\.35 \* liquidity/);
    expect(text).not.toMatch(/0\.25 \* rewardRisk/);
    expect(text).not.toMatch(/if \(chainProvenance !== "live"\) score -= 1;/);
    expect(text).not.toMatch(/score -= 0\.15/);
    expect(text).not.toMatch(/let strength = 0\.4/);
    expect(text).not.toMatch(/strength = 0\.6;/);
    expect(text).not.toMatch(/strength = 0\.55;/);
    expect(text).not.toMatch(/Math\.min\(1, strength \+ 0\.1\)/);
    expect(text).not.toMatch(/rate < 0\.4 \? -1 : rate > 0\.6 \? 1 : 0/);
    expect(text).not.toMatch(/maxCandidates \* 3/);
    expect(text).not.toMatch(/lo \* 0\.98/);
    expect(text).not.toMatch(/hi \* 1\.02/);
  });

  it("C3: the pipeline reads every moved rule by key", () => {
    const text = source();
    for (const key of [
      "scoreWeightThesis",
      "scoreWeightLiquidity",
      "scoreWeightRewardRisk",
      "nonLiveProvenancePenalty",
      "eventRiskPenalty",
      "thesisStrengthBase",
      "thesisStrengthStrong",
      "thesisStrengthVeryStrong",
      "thesisStrengthPerConfirmation",
      "thesisStrengthCap",
      "trackRecordWeakBelow",
      "trackRecordStrongAbove",
      "candidatePreScreenMultiplier",
      "breakevenToleranceLower",
      "breakevenToleranceUpper",
    ]) {
      expect(text, key).toContain(`rules.${key}`);
    }
    // One declaration of the ordering bar: the block's literal 10 is gone.
    expect(text).toContain("evaluated >= MIN_EVALUATED_FOR_ORDERING");
    expect(text).not.toMatch(/evaluated >= 10\b/);
  });
});
