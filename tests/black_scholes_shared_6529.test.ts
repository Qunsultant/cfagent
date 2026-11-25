// @vitest-environment node
/**
 * Issue #6529 — one Black-Scholes price.
 *
 * Research economics used to carry the d1/d2/price formula locally. The
 * price-only function now lives in shared/riskMath with the research
 * contract (NaN on degenerate input, no vol clamp, no expiry shortcut);
 * the Greeks keeps its own clamp/short-expiry behaviour and delegates its
 * price value to the same function.
 */
import { describe, it, expect } from "vitest";
import { blackScholesPrice as researchPrice } from "../src/services/researchEconomics";
import {
  blackScholesGreeks,
  blackScholesPrice as sharedPrice,
} from "../src/shared/riskMath";

const input = (
  spot: number,
  strike: number,
  years: number,
  sigma: number,
  rate: number,
  dividendYield: number,
  optionType: "call" | "put",
) => ({ spot, strike, years, sigma, rate, dividendYield, optionType });

describe("one Black-Scholes price (issue 6529)", () => {
  it("P01: research and shared agree across moneyness, expiry, vol, rates, and dividends", () => {
    for (const spot of [80, 100, 120]) {
      for (const strike of [90, 100, 110]) {
        for (const years of [0.01, 0.25, 1]) {
          for (const sigma of [0.1, 0.3, 0.8]) {
            for (const rate of [0, 0.05]) {
              for (const dividendYield of [0, 0.02]) {
                for (const optionType of ["call", "put"] as const) {
                  const local = researchPrice(
                    input(spot, strike, years, sigma, rate, dividendYield, optionType),
                  );
                  const shared = sharedPrice(
                    spot,
                    strike,
                    years,
                    sigma,
                    rate,
                    dividendYield,
                    optionType === "call" ? "CALL" : "PUT",
                  );
                  expect(local, `${spot}/${strike}/${years}/${sigma}/${rate}/${dividendYield}/${optionType}`)
                    .toBe(shared);
                }
              }
            }
          }
        }
      }
    }
  });

  it("P02: both functions keep the NaN contract on degenerate input", () => {
    const cases = [
      input(0, 100, 1, 0.2, 0.05, 0, "call"),
      input(100, 0, 1, 0.2, 0.05, 0, "call"),
      input(100, 100, 0, 0.2, 0.05, 0, "call"),
      input(100, 100, 1, 0, 0.05, 0, "call"),
      input(100, 100, Number.NaN, 0.2, 0.05, 0, "call"),
    ];
    for (const item of cases) {
      expect(researchPrice(item)).toBeNaN();
      expect(
        sharedPrice(
          item.spot,
          item.strike,
          item.years,
          item.sigma,
          item.rate,
          item.dividendYield,
          "CALL",
        ),
      ).toBeNaN();
    }
  });

  it("P03: the Greeks price is unchanged (textbook ATM call)", () => {
    const greeks = blackScholesGreeks(100, 100, 1, 0.2, 0.05, 0, "CALL");
    expect(greeks.price).toBeCloseTo(10.4506, 3);
    expect(greeks.delta).toBeGreaterThan(0.5);
  });
});
