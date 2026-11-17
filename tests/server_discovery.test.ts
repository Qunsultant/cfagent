import { describe, expect, it } from "vitest";
import { defaultRegistry, REQUESTED_STRATEGY_NAMES } from "../src/trading/options/strategies/catalog";
import { buildStrategyRequest, mapCandidateToDiscovered, sentimentToThesis, type ServerCandidate } from "../src/client/options/serverDiscovery";
import type { ExpirationOption } from "../src/client/options/strategyDiscoveryEngine";

/** Issue #29: the Discovery view is a thin client of the server pipeline. */
const EXPIRATION: ExpirationOption = { date: "2026-11-13", label: "Nov 13", dayLabel: "13", dte: 30 };

const CANDIDATE: ServerCandidate = {
  id: "cand-1",
  type: "call_debit_spread",
  label: "Call Debit Spread",
  expirationDate: "2026-11-13",
  legs: [
    { symbol: "XYZ100C", optionType: "CALL", side: "BUY", quantity: 1, strike: 100, expirationDate: "2026-11-13", daysToExpiration: 30, entryPrice: 3.1, bid: 3.0, ask: 3.2, impliedVolatility: 0.3, delta: 0.52, gamma: 0.03, theta: -0.04, vega: 0.11 },
    { symbol: "XYZ105C", optionType: "CALL", side: "SELL", quantity: 1, strike: 105, expirationDate: "2026-11-13", daysToExpiration: 30, entryPrice: 1.2, bid: 1.1, ask: 1.3, impliedVolatility: 0.3, delta: 0.31, gamma: 0.03, theta: -0.03, vega: 0.08 },
  ],
  netDebit: 190,
  maxProfit: 310,
  maxLoss: 190,
  breakevens: [101.9],
  targetPnl: 120,
  targetRewardRisk: 1.63,
  modelImpliedProbabilityOfProfit: 0.58,
  payoffCurve: [
    { underlyingPrice: 90, pnl: -190 },
    { underlyingPrice: 100, pnl: -190 },
    { underlyingPrice: 105, pnl: 310 },
    { underlyingPrice: 110, pnl: 310 },
  ],
  explanations: ["Call Debit Spread matches the bullish thesis."],
};

describe("server discovery mapping (issue #29)", () => {
  it("maps panel sentiment to server thesis", () => {
    expect(sentimentToThesis("bullish", 110, 100)).toBe("bullish");
    expect(sentimentToThesis("very_bearish", 90, 100)).toBe("bearish");
    expect(sentimentToThesis("neutral", 100, 100)).toBe("range_bound");
    expect(sentimentToThesis("directional", 100, 100)).toBe("large_move");
    expect(sentimentToThesis("all", 105, 100)).toBe("bullish");
    expect(sentimentToThesis("all", 95, 100)).toBe("bearish");
    expect(sentimentToThesis("all", 100, 100)).toBe("range_bound");
  });

  it("builds a pipeline request from panel inputs", () => {
    const req = buildStrategyRequest({ symbol: "xyz", currentPrice: 100, sentiment: "bullish", targetPrice: 110, budget: 1000, minRewardRisk: 1.5, expiration: EXPIRATION });
    expect(req.symbol).toBe("XYZ");
    expect(req.thesis).toBe("bullish");
    expect(req.maxPlannedLoss).toBe(1000);
    expect(req.minRewardRisk).toBe(1.5);
    expect(req.maxDte).toBe(30);
    expect(req.allowedStrategies).toEqual(["all"]);
    expect((req as any).optimizationBias).toBeUndefined();

    const biasedReq = buildStrategyRequest({ symbol: "xyz", currentPrice: 100, sentiment: "bullish", targetPrice: 110, budget: 1000, minRewardRisk: 1.5, expiration: EXPIRATION, bias: 75 });
    expect(biasedReq.optimizationBias).toBe(75);
  });

  it("maps a server candidate into the panel view model with real-chain values", () => {
    const mapped = mapCandidateToDiscovered({ candidate: CANDIDATE, rank: 1, compositeScore: 87.5 }, "bullish");
    expect(mapped.name).toBe("Call Debit Spread");
    expect(mapped.legs).toHaveLength(2);
    expect(mapped.legs[0].strike).toBe(100);
    expect(mapped.netDebit).toBe(190);
    expect(mapped.maxLoss).toBe(190);
    expect(mapped.maxProfit).toBe(310);
    expect(mapped.chanceOfProfit).toBe(58);
    expect(mapped.rewardRiskRatio).toBe(1.63);
    expect(mapped.returnOnRiskPct).toBe(63); // whole-% rounding contract, as the client engine produces
    expect(mapped.tag).toBe("#1 Server Ranked");
    expect(mapped.miniPayoffPoints.length).toBeGreaterThan(0);
  });

  it("ensures StrategyDiscoveryPanel is a pure display layer synchronizing server discovery with builder legs", () => {
    const fs = require("fs");
    const path = require("path");
    const panelCode = fs.readFileSync(path.resolve("src/client/options/StrategyDiscoveryPanel.tsx"), "utf8");

    // UI must NOT perform client-side fallback discovery processing
    expect(panelCode).not.toContain("function fallbackDiscoverStrategies");
    expect(panelCode).not.toContain("fallbackDiscoverStrategies(");

    // Must fetch canonical catalog from backend
    expect(panelCode).toContain("fetchServerCatalog");
    expect(panelCode).toContain("catalogCount");

    // Must fetch candidate strategies from server pipeline
    expect(panelCode).toContain("fetchServerDiscovery");

    // Must synchronize builderLegs with top candidate on discovery refresh
    expect(panelCode).toContain("setBuilderLegs([...top.legs])");

    // Must reset customStrategyName on sentiment change
    expect(panelCode).toContain("setCustomStrategyName(null)");

    // Must expose sentiment selector in Discovery controls row
    expect(panelCode).toContain("strat-discovery-controls-row");

    // Must make discovery cards selectable
    expect(panelCode).toContain("strat-card strat-discovery-card");
    expect(panelCode).toContain("selectedStrategy?.id === strat.id");

    // Missing/failed server results must be visible; modeled/local candidates
    // must never be substituted into the live discovery or trade flow.
    expect(panelCode).toContain("Server options discovery failed.");
    expect(panelCode).toContain("No strategies matched this sentiment");
    expect(panelCode).toContain("canTradeBuilderCandidate");
    expect(panelCode).toContain('discoveryDataSource === "live"');
    expect(panelCode).toContain('dataTab === "live"');

    // Payoff sentiment controls must show the same server-ranked result set,
    // and a live selected strategy must remain tradeable after leg edits.
    expect(panelCode).toContain('aria-label="Market sentiment for payoff strategies"');
    expect(panelCode).toContain("Backend-ranked strategies");
    expect(panelCode).toContain("Loading backend-ranked strategies for");
    expect(panelCode).not.toContain("discoveredStrategies.some((candidate) => candidate.id === selectedStrategy.id)");
    expect(panelCode).not.toContain("JSON.stringify(builderLegs) === JSON.stringify(selectedStrategy.legs)");

    // Full-size charts derive dimensions from their container and use the UX
    // token height cap; the heatmap stays inside a token-sized scroll viewport.
    const chartCode = fs.readFileSync(path.resolve("src/client/components/UniversalChart.tsx"), "utf8");
    const strategyCss = fs.readFileSync(path.resolve("src/client/options/strategyDiscovery.deprecated.css"), "utf8");
    const tokenCss = fs.readFileSync(path.resolve("src/client/tokens.css"), "utf8");
    expect(chartCode).toContain("new ResizeObserver");
    expect(chartCode).toContain("var(--chart-max-height, 52vh)");
    expect(strategyCss).toContain("max-height: var(--chart-scroll-max-height)");
    expect(tokenCss).toContain("--chart-max-height: min(52vh, 32rem)");
    expect(tokenCss).toContain("--chart-scroll-max-height: min(50vh, 26rem)");

    // The order-preview endpoint must pass complete option strategies through
    // to E*TRADE instead of silently degrading them to equity orders.
    // (Slice #359-09 moved the order-preview route into
    // src/agents/routes/etradeBroker.ts; the pins follow the ownership.
    // Slice #359-11 moved the options strategy block (with the
    // demoCalibratedChainsEnabled line) into
    // src/agents/routes/etradeOptions.ts; the pin follows the ownership.)
    const brokerCode = fs.readFileSync(path.resolve("src/agents/routes/etradeBroker.ts"), "utf8");
    const optionsCode = fs.readFileSync(path.resolve("src/agents/routes/etradeOptions.ts"), "utf8");
    expect(brokerCode).toContain("assetClass,");
    expect(brokerCode).toContain("optionLegs,");
    expect(brokerCode).toContain("strategyNetDebit: body.strategyNetDebit !== undefined ? Number(body.strategyNetDebit) : undefined");
    expect(optionsCode).toContain("demoCalibratedChainsEnabled: isDemoCalibratedChainsEnabled()");
  });

  it("verifies backend defaultRegistry has 74 canonical strategies in sync with catalog endpoint", async () => {
    // statically imported above (was dynamic import — caused Vitest SSR temp file race)
    const strategies = defaultRegistry.list();
    expect(strategies.length).toBe(74);
    expect(REQUESTED_STRATEGY_NAMES.length).toBeGreaterThanOrEqual(114);

    // Every strategy has valid id, label, category, theses, and generate function
    for (const strat of strategies) {
      expect(strat.id).toBeTruthy();
      expect(strat.label).toBeTruthy();
      expect(strat.category).toBeTruthy();
      expect(strat.theses.length).toBeGreaterThan(0);
      expect(typeof strat.generate).toBe("function");
    }
  });
});
