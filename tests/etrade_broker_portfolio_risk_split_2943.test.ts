/**
 * Issue #2943: portfolio-risk / positions tails moved from
 * src/agents/routes/etradeBroker.ts to
 * src/agents/routes/etradeBrokerPortfolioRisk.ts (the #995 pattern).
 * Pins: the dispatcher is back under the #359 50,000 B target, the
 * new module is under it too, every route condition stays in the
 * dispatcher, the dispatcher still constructs ETradeService (21
 * sites, per tests/etrade_routes_resplit_995.test.ts) and the new
 * module constructs none.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";

const LIMIT = 50_000;
const BROKER_FILE = "src/agents/routes/etradeBroker.ts";
const NEW_MODULE = "src/agents/routes/etradeBrokerPortfolioRisk.ts";

describe("etradeBroker portfolio-risk split (#2943)", () => {
  it("dispatcher and new module are both under the 50,000 B target", () => {
    expect(existsSync(BROKER_FILE)).toBe(true);
    expect(existsSync(NEW_MODULE)).toBe(true);
    expect(statSync(BROKER_FILE).size).toBeLessThan(LIMIT);
    expect(statSync(NEW_MODULE).size).toBeLessThan(LIMIT);
  });

  it("route conditions stay in the dispatcher", () => {
    const broker = readFileSync(BROKER_FILE, "utf8");
    for (const path of [
      '"/etrade/positions"',
      '"/etrade/portfolio-risk"',
      '"/etrade/portfolio-risk/evaluate"',
      '"/etrade/portfolio-risk/correlation"',
      '"/etrade/portfolio-risk/size"',
      '"/etrade/portfolio-risk/bundle"',
    ]) {
      expect(broker).toContain(path);
    }
    expect(broker).toContain("export async function handleEtradeBrokerRoutes");
  });

  it("dispatcher delegates to the new module; new module constructs no ETradeService", () => {
    const broker = readFileSync(BROKER_FILE, "utf8");
    for (const call of [
      "getPortfolioRiskReport(",
      "evaluatePostTradeTotalsForCandidate(",
      "assessPortfolioConcentrationForCandidate(",
      "sizeCandidateForPortfolio(",
      "getPositionsWithCodedError(",
    ]) {
      expect(broker).toContain(call);
    }
    const module = readFileSync(NEW_MODULE, "utf8");
    expect(module.split("new ETradeService(").length - 1).toBe(0);
    expect(broker.split("new ETradeService(").length - 1).toBe(21);
  });
});
