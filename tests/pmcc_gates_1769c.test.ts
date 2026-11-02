/**
 * Issue #1769 (parent #1717) — PMCC gate completion, group C.
 * TDD red→green: friction gate, breach-distance gate, and 30-day
 * premium yield gate (screener-rules.md §1.3).
 *
 * Friction: (Spread_long + Spread_short) / Bid_short <= 3.0.
 * Breach: short strike >= 8% above spot OR >= LEAPS breakeven
 *   (K_LEAPS + net debit per share, i.e. long entry − short entry).
 * Yield30d: (Credit_short / Debit_LEAPS) × (30 / DTE_short) >= 4.0%.
 * The gates run as acceptance rules in DEFAULT_ACCEPTANCE_RULES, so
 * the engine enforces them on every generated PMCC candidate; they
 * pass through (null) for every other strategy type. A PMCC
 * candidate whose legs cannot be evaluated fail-closes (rejected),
 * never passes on missing data.
 */
import { describe, it, expect } from "vitest";
import {
  evaluatePmccBreach,
  evaluatePmccFriction,
  computePmcc30DayYield,
  PMCC_ACCEPTANCE_RULES,
} from "../src/trading/options/strategies/pmccGates";
import { runAcceptanceRules } from "../src/trading/options/strategies/ledger";
import type { StrategyCandidate, StrategyRequest } from "../src/trading/options/strategyEngine";

function leg(overrides: Record<string, unknown>) {
  return {
    symbol: "TEST",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 90,
    expirationDate: "2027-01-01",
    daysToExpiration: 220,
    entryPrice: 11.9,
    bid: 11.8,
    ask: 12.0,
    impliedVolatility: 0.3,
    delta: 0.85,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.12,
    openInterest: 2000,
    volume: 1000,
    spreadPct: 1.7,
    quoteTimestamp: "2026-11-01T00:00:00.000Z",
    quoteFreshness: "FRESH",
    multiplier: 100,
    ...overrides,
  };
}

function pmccCandidate(overrides: Record<string, unknown> = {}): StrategyCandidate {
  const longLeg = leg({});
  const shortLeg = leg({
    side: "SELL",
    strike: 110,
    daysToExpiration: 30,
    entryPrice: 1.7,
    bid: 1.7,
    ask: 1.9,
    delta: 0.25,
  });
  return {
    id: "poor_mans_covered_call:TEST",
    rank: 0,
    type: "poor_mans_covered_call",
    label: "Poor Man's Covered Call",
    symbol: "TEST",
    underlyingPrice: 100,
    expirationDate: "2026-12-01",
    dataFreshness: "FRESH",
    legs: [longLeg, shortLeg],
    netDebit: 1020,
    estimatedFees: 0,
    maxProfit: null,
    maxProfitUnbounded: true,
    maxLoss: 1020,
    breakevens: [100.2],
    targetPnl: 100,
    targetRewardRisk: 1,
    modelImpliedProbabilityOfProfit: 0.7,
    netGreeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    liquidityScore: 90,
    score: 80,
    scoreBreakdown: {},
    payoffCurve: [],
    scenarios: [],
    explanations: [],
    warnings: [],
    assumptions: [],
    ...overrides,
  } as unknown as StrategyCandidate;
}

function request(): StrategyRequest {
  return { maxPlannedLoss: 5000, minRewardRisk: 0 } as unknown as StrategyRequest;
}

describe("evaluatePmccFriction (#1769)", () => {
  it("passes friction <= 3.0 and rejects above it", () => {
    const pass = evaluatePmccFriction(pmccCandidate());
    expect(pass).not.toBeNull();
    expect(pass!.friction).toBeCloseTo(0.4 / 1.7, 10);
    expect(pass!.passes).toBe(true);
    const fail = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 0.1, bid: 0.1, ask: 0.3, delta: 0.25 })],
    });
    const result = evaluatePmccFriction(fail);
    expect(result).not.toBeNull();
    expect(result!.friction).toBeCloseTo(0.4 / 0.1, 10);
    expect(result!.passes).toBe(false);
  });

  it("returns null when the short bid is not positive", () => {
    const bad = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 0, bid: 0, ask: 0.2, delta: 0.25 })],
    });
    expect(evaluatePmccFriction(bad)).toBeNull();
  });
});

describe("evaluatePmccBreach (#1769)", () => {
  it("passes a short strike >= 8% above spot", () => {
    const result = evaluatePmccBreach(pmccCandidate());
    expect(result).not.toBeNull();
    expect(result!.passes).toBe(true);
  });

  it("passes via LEAPS breakeven even below the 8% line", () => {
    const candidate = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 105, daysToExpiration: 30, entryPrice: 1.7, bid: 1.7, ask: 1.9, delta: 0.25 })],
    });
    const result = evaluatePmccBreach(candidate);
    expect(result).not.toBeNull();
    // Breakeven = 90 + (11.9 − 1.7) = 100.2; 105 clears it, not 108.
    expect(result!.leapsBreakeven).toBeCloseTo(100.2, 10);
    expect(result!.passes).toBe(true);
  });

  it("rejects a short strike below both thresholds", () => {
    const candidate = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 99, daysToExpiration: 30, entryPrice: 1.7, bid: 1.7, ask: 1.9, delta: 0.25 })],
    });
    expect(evaluatePmccBreach(candidate)!.passes).toBe(false);
  });
});

describe("computePmcc30DayYield (#1769)", () => {
  it("passes yield >= 4.0% and rejects below it", () => {
    const pass = computePmcc30DayYield(pmccCandidate());
    expect(pass).not.toBeNull();
    expect(pass!.yield).toBeCloseTo((1.7 / 11.9) * (30 / 30), 10);
    expect(pass!.passes).toBe(true);
    const fail = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 0.4, bid: 0.4, ask: 0.6, delta: 0.25 })],
    });
    const result = computePmcc30DayYield(fail);
    expect(result).not.toBeNull();
    expect(result!.passes).toBe(false);
  });

  it("scales by 30 / DTE_short", () => {
    const candidate = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 60, entryPrice: 1.7, bid: 1.7, ask: 1.9, delta: 0.25 })],
    });
    expect(computePmcc30DayYield(candidate)!.yield).toBeCloseTo((1.7 / 11.9) * 0.5, 10);
  });

  it("returns null when the LEAPS debit or short DTE is not positive", () => {
    const bad = pmccCandidate({
      legs: [leg({ entryPrice: 0 }), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 1.7, bid: 1.7, ask: 1.9, delta: 0.25 })],
    });
    expect(computePmcc30DayYield(bad)).toBeNull();
  });
});

describe("PMCC acceptance rules in DEFAULT_ACCEPTANCE_RULES (#1769)", () => {
  it("exposes the three rules and passes other strategy types through", () => {
    expect(PMCC_ACCEPTANCE_RULES.map((r) => r.id)).toEqual([
      "pmcc-friction",
      "pmcc-breach-distance",
      "pmcc-30day-yield",
    ]);
    const other = pmccCandidate({ type: "long_call" });
    for (const rule of PMCC_ACCEPTANCE_RULES) {
      expect(rule.evaluate(other, request())).toBeNull();
    }
  });

  it("rejects a PMCC candidate failing any gate through runAcceptanceRules", () => {
    expect(runAcceptanceRules(pmccCandidate(), request())).toBeNull();
    const wide = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 0.1, bid: 0.1, ask: 0.3, delta: 0.25 })],
    });
    expect(runAcceptanceRules(wide, request())).toMatch(/friction/i);
    const near = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 99, daysToExpiration: 30, entryPrice: 1.7, bid: 1.7, ask: 1.9, delta: 0.25 })],
    });
    expect(runAcceptanceRules(near, request())).toMatch(/breach/i);
    const thin = pmccCandidate({
      legs: [leg({}), leg({ side: "SELL", strike: 110, daysToExpiration: 30, entryPrice: 0.4, bid: 0.4, ask: 0.6, delta: 0.25 })],
    });
    expect(runAcceptanceRules(thin, request())).toMatch(/yield/i);
  });
});
