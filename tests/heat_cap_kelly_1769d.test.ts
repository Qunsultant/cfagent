/**
 * Issue #1769 (parent #1717) — portfolio sizing / heat caps, group D.
 * TDD red→green: the 35% total-open-heat cap and the fractional Kelly
 * formula (screener-rules.md §1.6), which previously existed only as
 * UI/documented text while sizing enforced a different, tighter
 * 10% total-max-loss budget.
 *
 * Heat: total open max loss across all positions <= 35% of account
 * equity (inclusive — exactly 35% passes). The cap is enforced as an
 * additional constraint in sizeCandidateAgainstPortfolio alongside
 * (never instead of) the existing 10% budget, so the tighter budget
 * still binds first and no existing sizing changes; the doc cap is
 * nevertheless enforced in code and visible in the constraint list.
 * Kelly: f* = ((p × b − (1 − p)) / b) × Fraction, with
 * p = win probability, b = Credit / MaxLoss, and the formula UNLOCKED
 * only after >= 30 historical verified trades (fewer → null, never
 * an unlocked-looking zero). A negative Kelly edge sizes 0.
 */
import { describe, it, expect } from "vitest";
import {
  checkPortfolioHeatCap,
  fractionalKellySize,
  sizeCandidateAgainstPortfolio,
  type SizingCandidate,
} from "../src/services/positionSizing";
import type { PortfolioRiskReport, PortfolioRiskTotals } from "../src/services/portfolioRisk";

function totals(partial: Partial<PortfolioRiskTotals>): PortfolioRiskTotals {
  return {
    deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: 0, betaWeightedSpyShares: 0,
    gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0, rhoDollarsPerRatePoint: 0,
    definedMaxLoss: 0, definedMaxLossPctOfNav: 0,
    betaCoverage: { covered: 0, total: 0, computedLive: 0, unavailable: 0 },
    ...partial,
  };
}

function report(t: PortfolioRiskTotals): PortfolioRiskReport {
  return { asOf: "2026-10-15T00:00:00.000Z", nav: 100000, spyPrice: 500, accountId: "acct-1", totals: t, rows: [], partial: [], excluded: [], undefinedRiskPositions: [] } as PortfolioRiskReport;
}

describe("checkPortfolioHeatCap (#1769)", () => {
  it("passes at exactly 35% and fails above it", () => {
    const atCap = checkPortfolioHeatCap({ totalOpenMaxLoss: 35000, accountEquity: 100000 });
    expect(atCap).not.toBeNull();
    expect(atCap!.heatPct).toBeCloseTo(35, 10);
    expect(atCap!.passes).toBe(true);
    expect(atCap!.headroom).toBe(0);
    const over = checkPortfolioHeatCap({ totalOpenMaxLoss: 35001, accountEquity: 100000 });
    expect(over!.passes).toBe(false);
    expect(over!.headroom).toBeCloseTo(-1, 10);
  });

  it("uses the doc 35% default and honours an explicit cap", () => {
    expect(checkPortfolioHeatCap({ totalOpenMaxLoss: 20000, accountEquity: 100000 })!.capPct).toBe(35);
    expect(checkPortfolioHeatCap({ totalOpenMaxLoss: 20000, accountEquity: 100000, capPct: 10 })!.passes).toBe(false);
  });

  it("returns null on non-positive equity or negative open loss", () => {
    expect(checkPortfolioHeatCap({ totalOpenMaxLoss: 1000, accountEquity: 0 })).toBeNull();
    expect(checkPortfolioHeatCap({ totalOpenMaxLoss: -1000, accountEquity: 100000 })).toBeNull();
    expect(checkPortfolioHeatCap({ totalOpenMaxLoss: Number.NaN, accountEquity: 100000 })).toBeNull();
  });
});

describe("fractionalKellySize (#1769)", () => {
  it("computes ((p × b − (1 − p)) / b) × Fraction", () => {
    expect(fractionalKellySize({ winProb: 0.6, payoffRatio: 1, fraction: 0.5, verifiedTrades: 30 })).toBeCloseTo(0.1, 10);
    expect(fractionalKellySize({ winProb: 0.5, payoffRatio: 2, fraction: 1, verifiedTrades: 100 })).toBeCloseTo(0.25, 10);
  });

  it("stays locked below 30 verified trades", () => {
    expect(fractionalKellySize({ winProb: 0.6, payoffRatio: 1, fraction: 0.5, verifiedTrades: 29 })).toBeNull();
  });

  it("sizes zero on a negative edge instead of a negative fraction", () => {
    expect(fractionalKellySize({ winProb: 0.3, payoffRatio: 1, fraction: 0.5, verifiedTrades: 30 })).toBe(0);
  });

  it("returns null on invalid probabilities, ratios, or fractions", () => {
    const base = { winProb: 0.6, payoffRatio: 1, fraction: 0.5, verifiedTrades: 30 };
    expect(fractionalKellySize({ ...base, winProb: 1.2 })).toBeNull();
    expect(fractionalKellySize({ ...base, payoffRatio: 0 })).toBeNull();
    expect(fractionalKellySize({ ...base, fraction: 0 })).toBeNull();
    expect(fractionalKellySize({ ...base, fraction: 1.5 })).toBeNull();
  });
});

describe("heat-cap constraint in sizeCandidateAgainstPortfolio (#1769)", () => {
  it("adds a 35% heat-cap constraint without changing existing bindings", () => {
    const candidate: SizingCandidate = {
      symbol: "ACME",
      perContract: { deltaDollars: 500, betaWeightedDeltaDollars: 600, definedMaxLoss: 200 },
      riskScore: 40,
    };
    const result = sizeCandidateAgainstPortfolio(report(totals({})), candidate);
    const heat = result.constraints.find((c) => c.name === "heat-cap");
    expect(heat).toBeDefined();
    expect(heat!.maxContracts).toBe(175); // 35% × $100k / $200
    expect(result.recommendedContracts).toBe(25); // NAV band still binds
    expect(result.bindingConstraint).toBe("nav-band");
  });

  it("counts post-trade heat against the book's existing max loss", () => {
    const candidate: SizingCandidate = {
      symbol: "ACME",
      perContract: { deltaDollars: 100, betaWeightedDeltaDollars: 100, definedMaxLoss: 200 },
      riskScore: 10,
    };
    const result = sizeCandidateAgainstPortfolio(report(totals({ definedMaxLoss: 34000 })), candidate);
    const heat = result.constraints.find((c) => c.name === "heat-cap");
    expect(heat!.maxContracts).toBe(5); // ($35,000 − $34,000) / $200
  });
});
