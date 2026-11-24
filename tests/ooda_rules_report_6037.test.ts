/**
 * Issue #6037 (d) — the report records the resolved rules, not only the version.
 *
 * Slice (a) put the rules in one versioned block, (b) and (c) made the pipeline
 * read it. This is the last half of the parent's acceptance criterion: a report
 * must be reproducible from its own evidence — `rulesVersion` says which
 * revision, the recorded values say what it decided under.
 *
 * What this file pins:
 *
 *  D1  a default run records exactly the declared defaults (behaviour-neutral);
 *  D2  a stored override appears in the report's rules, and the version is the
 *      config's (never silently bumped);
 *  D3  the report's data rows carry the values as one canonical (sorted-key)
 *      row, so two reports with the same values compare equal.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalResearchRulesJson,
  RESEARCH_RULES_DEFAULTS,
  type ResearchRules,
} from "../src/config/researchRules";
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
import { researchSummaryRows } from "../src/trading/researchReportData";

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

async function run(runId: string, config: ResearchConfig) {
  return runResearchPipeline({ provider: fixtureProvider() }, config, {
    trigger: "manual",
    userLogin: "tester",
    runId,
    now: NOW,
  });
}

describe("#6037 (d) — the report records the resolved rules", () => {
  it("D1: a default run records exactly the declared defaults", async () => {
    const report = await run("rsr_d1", testConfig());
    expect(report.rulesVersion).toBe(RESEARCH_CONFIG_DEFAULTS.rulesVersion);
    expect(report.rules).toEqual(RESEARCH_RULES_DEFAULTS);
  });

  it("D2: a stored override is what the report records (version unchanged)", async () => {
    const override: Partial<ResearchRules> = {
      scoreWeightThesis: 1,
      scoreWeightLiquidity: 0,
      scoreWeightRewardRisk: 0,
    };
    const report = await run(
      "rsr_d2",
      testConfig({ rules: override, rulesVersion: "1.0.1" }),
    );
    expect(report.rules.scoreWeightThesis).toBe(1);
    expect(report.rules.scoreWeightLiquidity).toBe(0);
    // Everything not overridden stays the declared default.
    expect(report.rules.pmccLongLegMinDte).toBe(
      RESEARCH_RULES_DEFAULTS.pmccLongLegMinDte,
    );
    expect(report.rulesVersion).toBe("1.0.1");
  });

  it("D3: the data rows carry the values, canonically and stably", async () => {
    const report = await run(
      "rsr_d3",
      testConfig({
        rules: { scoreWeightThesis: 0.5, scoreWeightLiquidity: 0.3, scoreWeightRewardRisk: 0.2 },
      }),
    );
    const row = researchSummaryRows(report).find(([key]) => key === "rules");
    expect(row).toBeTruthy();
    const parsed = JSON.parse(String(row![1])) as ResearchRules;
    expect(parsed.scoreWeightThesis).toBe(0.5);

    // Canonical: sorted keys, every rule present, and stable across calls.
    const text = canonicalResearchRulesJson(report.rules);
    const keys = Object.keys(JSON.parse(text) as Record<string, number>);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(Object.keys(RESEARCH_RULES_DEFAULTS).length);
    expect(canonicalResearchRulesJson(report.rules)).toBe(text);
    expect(canonicalResearchRulesJson(undefined)).toBe("");
  });
});
