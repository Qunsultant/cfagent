/**
 * Issue #3296: portfolio risk is a declared capability, not a comment.
 *
 * Decision recorded by this test: Alpaca has **no** portfolio-risk model in
 * this build. The eight `/api/etrade/portfolio-risk*` routes stay E*TRADE's,
 * and a non-E*TRADE tenant sees a stated refusal. The declaration lives in the
 * catalogue so the surface can be driven by the contract instead of a
 * hardcoded `broker === "etrade"` and a bespoke string.
 */
import { describe, it, expect } from "vitest";
import { BROKER_CATALOG, ROUTED_BROKER_IDS, brokerSupports } from "../src/trading/brokerCatalog";

describe("portfolio risk is declared per broker (#3296)", () => {
  it("E*TRADE owns the model", () => {
    expect(brokerSupports("etrade", "portfolioRisk")).toBe(true);
  });

  it("Alpaca declares it unsupported — no second risk engine was invented", () => {
    expect(brokerSupports("alpaca", "portfolioRisk")).toBe(false);
  });

  it("every broker states the operation, so a new broker cannot omit it", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      expect(typeof BROKER_CATALOG[broker].supports.portfolioRisk).toBe("boolean");
    }
  });

  it("the declaration is distinguishable from positions on the same broker", () => {
    // Alpaca has positions but no risk model: the two must not be conflated.
    expect(brokerSupports("alpaca", "positions")).toBe(true);
    expect(brokerSupports("alpaca", "portfolioRisk")).toBe(false);
  });
});
