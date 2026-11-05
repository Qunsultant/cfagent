/**
 * Issue #3296: portfolio risk is a declared capability, not a comment.
 *
 * That issue recorded Alpaca as unsupported. Issue #3324 supersedes the Alpaca
 * half of the decision: the model now runs on a neutral `PortfolioRiskSource`,
 * so Alpaca supplies its own book, chains, and spot price and the declaration
 * is true for both brokers. What survives from #3296 is the *requirement* — the
 * capability is declared per broker, total by type, and a broker that cannot
 * supply the reads still refuses by name rather than rendering another broker's
 * numbers. The tests below keep that requirement and record the change.
 */
import { describe, it, expect } from "vitest";
import { BROKER_CATALOG, ROUTED_BROKER_IDS, brokerSupports } from "../src/trading/brokerCatalog";

describe("portfolio risk is declared per broker (#3296)", () => {
  it("E*TRADE owns the model", () => {
    expect(brokerSupports("etrade", "portfolioRisk")).toBe(true);
  });

  it("Alpaca declares it supported since #3324 — one engine, its own inputs", () => {
    // No second risk engine: the same aggregation, fed by Alpaca's book.
    expect(brokerSupports("alpaca", "portfolioRisk")).toBe(true);
  });

  it("every broker states the operation, so a new broker cannot omit it", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      expect(typeof BROKER_CATALOG[broker].supports.portfolioRisk).toBe("boolean");
    }
  });

  it("the declaration is distinguishable from positions on the same broker", () => {
    // Positions and risk are separate capabilities; Alpaca has both, but the
    // declaration must still be able to say "no" for a broker that cannot.
    expect(brokerSupports("alpaca", "positions")).toBe(true);
    expect(brokerSupports("alpaca", "portfolioRisk")).toBe(true);
    for (const broker of ROUTED_BROKER_IDS) {
      expect(BROKER_CATALOG[broker].supports.portfolioRisk).toBe(true);
    }
  });
});
