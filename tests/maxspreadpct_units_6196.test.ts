/**
 * Issue #6196 — maxSpreadPct units: the research config default is a percent,
 * as the options screener reads it. The default 0.15 (fraction of mid) was
 * read as 0.15% by evaluateContract, so a constraint-less goal run's options
 * leg matched zero contracts. Owner decision A: default 0.15 → 15 (percent),
 * keeping the screener comparison as-is. The research pipeline's
 * fraction-family consumers (gates, pipeline score, discovery liquidity,
 * scenario floor) are aligned to percent in the same change, so the new
 * default does not silently disable their spread gating.
 */
import { describe, it, expect } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import {
  DynamicOptionsScreener,
  evaluateContracts,
} from "../src/trading/optionsScreener";
import {
  RESEARCH_CONFIG_DEFAULTS,
  ResearchConfigService,
  validateResearchConfig,
  type ResearchSettingsStore,
} from "../src/services/researchConfig";
import {
  buildScenario,
  evaluateScenarioGrid,
} from "../src/services/goalScenarioEngine";
import {
  ironCondorEconomics,
  type ResearchLeg,
} from "../src/services/researchEconomics";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function makeChain(symbol: string, bid: number, ask: number): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid,
          ask,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid,
          ask,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function memStore(): ResearchSettingsStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (k: string) => (raw.has(k) ? raw.get(k)! : null),
    set: (k: string, v: string) => void raw.set(k, v),
  };
}

function leg(
  optionType: "call" | "put",
  strike: number,
  bid: number,
  ask: number,
  quantity: number,
  dte = 35,
  openInterest: number | null = 500,
): ResearchLeg {
  return {
    optionType,
    strike,
    expiry: "2026-12-18",
    dte,
    bid,
    ask,
    iv: 0.4,
    volume: 100,
    openInterest,
    quantity,
    quoteTimestamp: Date.now(),
  };
}

describe("maxSpreadPct units (#6196, decision A: percent)", () => {
  it("default is 15 (percent of mid)", () => {
    expect(RESEARCH_CONFIG_DEFAULTS.maxSpreadPct).toBe(15);
  });

  it("validation accepts the percent default and rejects out-of-range percents", () => {
    expect(validateResearchConfig(RESEARCH_CONFIG_DEFAULTS)).toEqual([]);
    const svc = new ResearchConfigService(memStore());
    expect(svc.save({ maxSpreadPct: 15 }).errors).toEqual([]);
    expect(svc.save({ maxSpreadPct: 250 }).errors.length).toBeGreaterThan(0);
    expect(svc.save({ maxSpreadPct: 0 }).errors.length).toBeGreaterThan(0);
  });

  it("constraint-less buildScenario fills the floor from the percent default", () => {
    const scenario = buildScenario({
      goalKind: "directional",
      portfolioRef: { kind: "hypothetical" },
    });
    expect(scenario.constraints.liquidityFloor?.maxSpreadPct).toBe(15);
  });

  it("a realistic 4.88% spread passes evaluateContracts under the default filter", () => {
    const screener = new DynamicOptionsScreener();
    // The 4192 fake chain: bid 1.0 / ask 1.05 → (0.05 / 1.025) * 100 = 4.88%.
    const chain = makeChain("AAPL", 1.0, 1.05);
    const out = evaluateContracts(
      [{ symbol: "AAPL", chain }],
      {
        underlyingSymbols: ["AAPL"],
        maxSpreadPct: RESEARCH_CONFIG_DEFAULTS.maxSpreadPct,
      },
      screener.config,
    );
    expect(out.totalContractsEvaluated).toBeGreaterThan(0);
    expect(out.passedContracts.length).toBeGreaterThan(0);
    expect(out.rejections.filter((r) => r.code === "SPREAD_TOO_WIDE")).toHaveLength(0);
  });

  it("the old 0.15 default reads as 0.15% and rejects the same contract (the bug)", () => {
    // Pins the screener's percent reading: 0.15 means 0.15%, not 15%.
    const screener = new DynamicOptionsScreener();
    const chain = makeChain("AAPL", 1.0, 1.05);
    const out = evaluateContracts(
      [{ symbol: "AAPL", chain }],
      { underlyingSymbols: ["AAPL"], maxSpreadPct: 0.15 },
      screener.config,
    );
    expect(out.rejections.some((r) => r.code === "SPREAD_TOO_WIDE")).toBe(true);
  });

  it("a wide 22% spread is still rejected under the default filter (the gate still binds)", () => {
    const screener = new DynamicOptionsScreener();
    // bid 1.0 / ask 1.25 → (0.25 / 1.125) * 100 = 22.2%.
    const chain = makeChain("AAPL", 1.0, 1.25);
    const out = evaluateContracts(
      [{ symbol: "AAPL", chain }],
      {
        underlyingSymbols: ["AAPL"],
        maxSpreadPct: RESEARCH_CONFIG_DEFAULTS.maxSpreadPct,
      },
      screener.config,
    );
    expect(out.passedContracts).toHaveLength(0);
    expect(out.rejections.some((r) => r.code === "SPREAD_TOO_WIDE")).toBe(true);
  });

  it("goal scenario floor (default) passes a realistic spread and breaches a wide one", () => {
    const scenario = buildScenario({
      goalKind: "directional",
      portfolioRef: { kind: "hypothetical" },
    });
    const shocks = { pricePct: [0], ivShift: [0], daysForward: [0] };
    // All four legs at 4.88% (bid 1.0/ask 1.05 and bid 2.4/ask 2.52).
    const realistic = ironCondorEconomics(
      [
        leg("put", 90, 1.0, 1.05, 1),
        leg("put", 95, 2.4, 2.52, -1),
        leg("call", 105, 2.4, 2.52, -1),
        leg("call", 110, 1.0, 1.05, 1),
      ],
      100,
    );
    const ok = evaluateScenarioGrid({
      economics: realistic,
      spot: 100,
      sigma: 0.4,
      shocks,
      constraints: scenario.constraints,
    });
    const okByName = Object.fromEntries(
      ok.verdicts.map((v) => [v.constraint, v.status]),
    );
    expect(okByName.liquidity_floor).toBe("pass");
    // All four legs at 22.2% (bid 1.0/ask 1.25 and bid 2.4/ask 3.0).
    const wide = ironCondorEconomics(
      [
        leg("put", 90, 1.0, 1.25, 1),
        leg("put", 95, 2.4, 3.0, -1),
        leg("call", 105, 2.4, 3.0, -1),
        leg("call", 110, 1.0, 1.25, 1),
      ],
      100,
    );
    const bad = evaluateScenarioGrid({
      economics: wide,
      spot: 100,
      sigma: 0.4,
      shocks,
      constraints: scenario.constraints,
    });
    const badByName = Object.fromEntries(
      bad.verdicts.map((v) => [v.constraint, v.status]),
    );
    expect(badByName.liquidity_floor).toBe("breach");
  });
});
