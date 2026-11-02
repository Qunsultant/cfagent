/**
 * Issue #1769 (parent #1717) — volatility framework completion, group B.
 * TDD red→green: Historical Volatility (HV 20/60), 25-delta skew, and
 * the volatility decision matrix (screener-rules.md §1.5).
 *
 * HV = sqrt(252) × sigma(ln(P_t / P_{t-1})) over the window's log
 * returns (population sigma, matching the discovery-signals helper
 * that previously computed this privately and unexported). Decision
 * matrix: IVR > 50 AND IV > HV → SELL_PREMIUM; IVR < 25 → STAND_DOWN;
 * otherwise NO_READ. Boundaries are strict: IVR = 50, IVR = 25, and
 * IV = HV all yield NO_READ. Skew25 = IV_put,25Δ − IV_call,25Δ.
 * Invalid inputs return null (gate cannot be evaluated), never zero.
 */
import { describe, it, expect } from "vitest";
import { computeHistoricalVolatility } from "../src/trading/technicals";
import {
  computeSkew25,
  evaluateVolDecisionMatrix,
} from "../src/trading/options/discoveryInference";

function flatCloses(n: number, price = 100): number[] {
  return Array.from({ length: n }, () => price);
}

describe("computeHistoricalVolatility (#1769)", () => {
  it("returns 0 for a flat series", () => {
    expect(computeHistoricalVolatility(flatCloses(21))).toBe(0);
  });

  it("annualizes log-return sigma by sqrt(252) over the window", () => {
    // Two alternating returns: ln(101/100) and ln(100/101) repeat.
    // Population sigma of the return series is |ln(1.01)|, so HV is
    // |ln(1.01)| × sqrt(252) for any window with equal counts.
    const closes: number[] = [100];
    for (let i = 0; i < 20; i++) closes.push(i % 2 === 0 ? 101 : 100);
    const hv = computeHistoricalVolatility(closes, 20);
    expect(hv).not.toBeNull();
    expect(hv!).toBeCloseTo(Math.abs(Math.log(1.01)) * Math.sqrt(252), 10);
  });

  it("uses only the trailing window + 1 closes", () => {
    const prefix = flatCloses(50, 1000);
    const closes = [...prefix, ...flatCloses(21, 100)];
    // Trailing 21 closes are flat → HV 0, despite the 1000 prefix.
    expect(computeHistoricalVolatility(closes, 20)).toBe(0);
  });

  it("returns null on short, non-positive, or non-finite history", () => {
    expect(computeHistoricalVolatility(flatCloses(20), 20)).toBeNull();
    expect(computeHistoricalVolatility([...flatCloses(20), 0], 20)).toBeNull();
    expect(computeHistoricalVolatility([...flatCloses(20), Number.NaN], 20)).toBeNull();
    expect(computeHistoricalVolatility(flatCloses(21), 0)).toBeNull();
    expect(computeHistoricalVolatility(flatCloses(21), 2.5)).toBeNull();
  });

  it("supports the 60-day window", () => {
    expect(computeHistoricalVolatility(flatCloses(61), 60)).toBe(0);
  });
});

describe("computeSkew25 (#1769)", () => {
  it("is put IV minus call IV at 25 delta", () => {
    expect(computeSkew25(0.30, 0.22)).toBeCloseTo(0.08, 10);
    expect(computeSkew25(0.20, 0.25)).toBeCloseTo(-0.05, 10);
  });

  it("returns null on non-finite inputs", () => {
    expect(computeSkew25(Number.NaN, 0.22)).toBeNull();
    expect(computeSkew25(0.30, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("evaluateVolDecisionMatrix (#1769)", () => {
  it("sells premium when IVR > 50 and IV > HV", () => {
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 60, hv: 0.25 })).toBe("SELL_PREMIUM");
  });

  it("stands down when IVR < 25 even when IV > HV", () => {
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 20, hv: 0.25 })).toBe("STAND_DOWN");
  });

  it("stands down when IVR < 25 and IV <= HV", () => {
    expect(evaluateVolDecisionMatrix({ iv: 0.20, ivr: 10, hv: 0.25 })).toBe("STAND_DOWN");
  });

  it("reads NO_READ in the middle band", () => {
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 40, hv: 0.25 })).toBe("NO_READ");
    expect(evaluateVolDecisionMatrix({ iv: 0.20, ivr: 60, hv: 0.25 })).toBe("NO_READ");
  });

  it("treats boundaries strictly: IVR = 50, IVR = 25, IV = HV are NO_READ", () => {
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 50, hv: 0.25 })).toBe("NO_READ");
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 25, hv: 0.25 })).toBe("NO_READ");
    expect(evaluateVolDecisionMatrix({ iv: 0.25, ivr: 60, hv: 0.25 })).toBe("NO_READ");
  });

  it("returns null on invalid inputs", () => {
    expect(evaluateVolDecisionMatrix({ iv: -0.1, ivr: 60, hv: 0.25 })).toBeNull();
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: Number.NaN, hv: 0.25 })).toBeNull();
    expect(evaluateVolDecisionMatrix({ iv: 0.35, ivr: 60, hv: -0.25 })).toBeNull();
  });
});
