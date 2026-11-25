// @vitest-environment node
/**
 * Issue #6506 — one pure options-economics layer for OODA and the screen
 * strategy engine.
 *
 * Pins:
 * - 6506-P01 expected move comes from the shared module (research delegates);
 * - 6506-P02 a fee-free vertical spread produces identical max loss, max gain
 *   and breakevens through researchEconomics and the strategy engine;
 * - 6506-P03 a put debit spread does too (sign/quantity parity);
 * - 6506-P04 an iron condor does too (four-leg credit structure);
 * - 6506-P05 the screen engine keeps its own fee convention: a fee raises the
 *   engine's max loss by exactly the fee, while research economics stays
 *   pre-cost — a recorded divergence, not a second formula.
 */
import { describe, it, expect } from "vitest";
import {
  expectedMove,
  ironCondorEconomics,
  verticalSpreadEconomics,
  type ResearchLeg,
} from "../src/services/researchEconomics";
import {
  optionStrategyRiskProfile,
  type StrategyLeg,
} from "../src/trading/options/strategyEngine";

function researchLeg(
  optionType: "call" | "put",
  strike: number,
  price: number,
  quantity: number,
  dte = 30,
): ResearchLeg {
  return {
    optionType,
    strike,
    expiry: "2026-12-18",
    dte,
    bid: price,
    ask: price,
    iv: 0.4,
    volume: 100,
    openInterest: 500,
    quantity,
    quoteTimestamp: Date.now(),
  };
}

function strategyLeg(
  optionType: "CALL" | "PUT",
  side: "BUY" | "SELL",
  strike: number,
  entryPrice: number,
  dte = 30,
): StrategyLeg {
  return {
    symbol: "AAPL",
    optionType,
    side,
    quantity: 1,
    strike,
    expirationDate: "2026-12-18",
    daysToExpiration: dte,
    entryPrice,
    bid: entryPrice,
    ask: entryPrice,
    impliedVolatility: 0.4,
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    openInterest: 500,
    volume: 100,
    spreadPct: 0,
    quoteTimestamp: new Date().toISOString(),
    quoteFreshness: "FRESH",
    multiplier: 1,
  };
}

describe("shared options economics (issue 6506)", () => {
  it("P01: expected move is the shared implementation", () => {
    const years = 30 / 365;
    expect(expectedMove(100, 0.4, years)).toBeCloseTo(100 * 0.4 * Math.sqrt(years), 10);
    expect(Number.isNaN(expectedMove(0, 0.4, years))).toBe(true);
  });

  it("P02: a call debit spread has identical economics in both engines", () => {
    const research = verticalSpreadEconomics(
      [
        researchLeg("call", 100, 3.0, 1),
        researchLeg("call", 105, 1.5, -1),
      ],
      100,
    );
    const engine = optionStrategyRiskProfile(
      [
        strategyLeg("CALL", "BUY", 100, 3.0),
        strategyLeg("CALL", "SELL", 105, 1.5),
      ],
      0,
      100,
      0,
      0,
    );

    expect(research.netDebit).toBe(1.5);
    expect(research.maxLoss).toBeCloseTo(engine.maxLoss, 2);
    expect(research.maxGain).toBeCloseTo(engine.maxProfit as number, 2);
    expect(research.breakevens).toEqual(engine.breakevens);
    expect(research.maxLoss).toBe(1.5);
    expect(research.maxGain).toBe(3.5);
    expect(engine.breakevens).toEqual([101.5]);
  });

  it("P03: a put debit spread has identical economics in both engines", () => {
    const research = verticalSpreadEconomics(
      [
        researchLeg("put", 105, 4.0, 1),
        researchLeg("put", 100, 2.0, -1),
      ],
      100,
    );
    const engine = optionStrategyRiskProfile(
      [
        strategyLeg("PUT", "BUY", 105, 4.0),
        strategyLeg("PUT", "SELL", 100, 2.0),
      ],
      0,
      100,
      0,
      0,
    );

    expect(research.maxLoss).toBeCloseTo(engine.maxLoss, 2);
    expect(research.maxGain).toBeCloseTo(engine.maxProfit as number, 2);
    expect(research.breakevens).toEqual(engine.breakevens);
    expect(engine.breakevens).toEqual([103]);
  });

  it("P04: an iron condor has identical economics in both engines", () => {
    const research = ironCondorEconomics(
      [
        researchLeg("call", 105, 1.0, -1),
        researchLeg("call", 110, 0.4, 1),
        researchLeg("put", 95, 1.0, -1),
        researchLeg("put", 90, 0.4, 1),
      ],
      100,
    );
    const engine = optionStrategyRiskProfile(
      [
        strategyLeg("CALL", "SELL", 105, 1.0),
        strategyLeg("CALL", "BUY", 110, 0.4),
        strategyLeg("PUT", "SELL", 95, 1.0),
        strategyLeg("PUT", "BUY", 90, 0.4),
      ],
      0,
      100,
      0,
      0,
    );

    expect(research.maxLoss).toBeCloseTo(engine.maxLoss, 2);
    expect(research.maxGain).toBeCloseTo(engine.maxProfit as number, 2);
    expect(research.breakevens).toEqual(engine.breakevens);
    expect(research.maxLoss).toBe(3.8);
  });

  it("P05: the engine's fee convention is explicit and additive", () => {
    const legs = [
      strategyLeg("CALL", "BUY", 100, 3.0),
      strategyLeg("CALL", "SELL", 105, 1.5),
    ];
    const noFees = optionStrategyRiskProfile(legs, 0, 100, 0, 0);
    const withFees = optionStrategyRiskProfile(legs, 1, 100, 0, 0);

    expect(withFees.maxLoss).toBeCloseTo(noFees.maxLoss + 1, 10);
    expect(withFees.breakevens[0]).toBeCloseTo(noFees.breakevens[0] + 1, 10);
  });
});
