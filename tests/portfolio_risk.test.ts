/**
 * Issue #34 (G1): portfolio-level risk aggregation.
 * Pins the acceptance criteria: given a fixed positions/chain snapshot the
 * aggregates are reproducible; unresolved positions are excluded and named,
 * never silently zeroed; post-trade totals compose current + candidate.
 */
import { describe, it, expect } from "vitest";
import {
  aggregatePortfolioRisk,
  evaluatePostTradeTotals,
  resolvePositionsSnapshot,
  signedQuantityOf,
  type ResolvedPosition,
} from "../src/services/portfolioRisk";
import type { ETradePosition } from "../src/types";

function equityPosition(partial: Partial<ETradePosition>): ETradePosition {
  return {
    symbol: "AAPL",
    description: "Common Stock",
    quantity: 100,
    pricePaid: 180,
    costBasis: 18000,
    currentPrice: 200,
    marketPrice: 200,
    marketValue: 20000,
    totalGain: 2000,
    unrealizedGainLoss: 2000,
    totalGainPercent: 11,
    unrealizedGainLossPercent: 11,
    daysGain: 0,
    daysGainPercent: 0,
    securityType: "EQ",
    positionType: "LONG",
    ...partial,
  };
}

function resolved(partial: Partial<ResolvedPosition>): ResolvedPosition {
  return {
    position: equityPosition({}),
    kind: "equity",
    signedQuantity: 100,
    referencePrice: 200,
    greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
    beta: 1.2,
    betaSource: "computed-live" as const,
    betaObservations: 252,
    ...partial,
  };
}

const OPTS = { nav: 100000, spyPrice: 500, asOf: "2026-10-15T00:00:00.000Z" };

describe("signedQuantityOf", () => {
  it("signs by positionType when present, else uses the raw quantity", () => {
    expect(signedQuantityOf(equityPosition({ quantity: 5, positionType: "SHORT" }))).toBe(-5);
    expect(signedQuantityOf(equityPosition({ quantity: 5, positionType: "LONG" }))).toBe(5);
    expect(signedQuantityOf(equityPosition({ quantity: -5, positionType: undefined }))).toBe(-5);
  });
});

describe("aggregatePortfolioRisk", () => {
  const book: ResolvedPosition[] = [
    // Long 100 AAPL @ $200, beta 1.2 → delta 100 sh / $20,000; BW $24,000
    resolved({}),
    // Long 2 NVDA calls, spot 800, delta .5 gamma .02 theta -.05 vega .12, beta 1.68
    resolved({
      position: equityPosition({
        symbol: "NVDA", quantity: 2, costBasis: 1000, marketValue: 1100,
        securityType: "OPTN", optionType: "CALL", strikePrice: 850, expirationDate: "2026-11-20",
      }),
      kind: "option", signedQuantity: 2, referencePrice: 800,
      greeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.12, rho: 0.03 }, beta: 1.68,
      betaSource: "computed-live" as const, betaObservations: 252,
    }),
    // Short 1 SPY put, delta -.3, spot 500, beta 1.0 → delta +30 sh; undefined standalone risk
    resolved({
      position: equityPosition({
        symbol: "SPY", quantity: 1, costBasis: -300, marketValue: -280,
        securityType: "OPTN", optionType: "PUT", strikePrice: 490, expirationDate: "2026-11-20",
        positionType: "SHORT",
      }),
      kind: "option", signedQuantity: -1, referencePrice: 500,
      greeks: { delta: -0.3, gamma: 0.01, theta: -0.04, vega: 0.09, rho: -0.02 }, beta: 1.0,
    }),
    // Long 50 XYZ equity, beta unknown → raw delta counts, beta-weighted does not
    resolved({
      position: equityPosition({ symbol: "XYZ", quantity: 50, marketPrice: 40, marketValue: 2000 }),
      signedQuantity: 50, referencePrice: 40, beta: null,
      betaSource: "unavailable" as const, betaObservations: 0,
    }),
    // Option whose chain Greeks could not be resolved → excluded, named
    resolved({
      position: equityPosition({
        symbol: "TSLA", quantity: 1, securityType: "OPTN", optionType: "CALL",
        strikePrice: 300, expirationDate: "2026-11-20",
      }),
      kind: "option", signedQuantity: 1, referencePrice: 0,
      greeks: null, greeksMissingReason: "No live chain Greeks for TSLA", beta: 2.0,
    }),
  ];

  it("aggregates delta/theta/vega and defined max loss across the book", () => {
    const report = aggregatePortfolioRisk(book, OPTS);
    // delta shares: 100 + 100 + 30 + 50 = 280
    expect(report.totals.deltaShares).toBe(280);
    // delta dollars: 20,000 + 80,000 + 15,000 + 2,000 = 117,000
    expect(report.totals.deltaDollars).toBe(117000);
    // theta: 0 + (2*100*-0.05) + (-1*100*-0.04) = -10 + 4 = -6
    expect(report.totals.thetaDollarsPerDay).toBe(-6);
    // vega per vol point: (2*100*0.12*0.01) + (-1*100*0.09*0.01) = 0.24 - 0.09 = 0.15
    expect(report.totals.vegaDollarsPerVolPoint).toBe(0.15);
    // defined max loss: AAPL 20,000 (to zero) + long calls 1,000 (premium) + XYZ 2,000 = 23,000
    expect(report.totals.definedMaxLoss).toBe(23000);
    expect(report.totals.definedMaxLossPctOfNav).toBe(23);
    expect(report.undefinedRiskPositions).toEqual(["SPY"]);
  });

  it("beta-weights only covered positions and reports coverage honestly", () => {
    const report = aggregatePortfolioRisk(book, OPTS);
    // BW dollars: 20,000*1.2 + 80,000*1.68 + 15,000*1.0 = 24,000 + 134,400 + 15,000
    expect(report.totals.betaWeightedDeltaDollars).toBe(173400);
    expect(report.totals.betaWeightedSpyShares).toBe(346.8);
    expect(report.totals.betaCoverage).toEqual({ covered: 3, total: 4, computedLive: 3, unavailable: 1 });
    // rho per +1% rates: (2*100*0.03*0.01) + (-1*100*-0.02*0.01) = 0.06 + 0.02
    expect(report.totals.rhoDollarsPerRatePoint).toBe(0.08);
    expect(report.partial.map((p) => p.symbol)).toEqual(["XYZ"]);
    expect(report.excluded.map((e) => e.symbol)).toEqual(["TSLA"]);
    expect(report.excluded[0].reason).toContain("No live chain Greeks");
  });

  it("is deterministic: identical snapshot → identical report", () => {
    expect(aggregatePortfolioRisk(book, OPTS)).toEqual(aggregatePortfolioRisk(book, OPTS));
  });

  it("returns null beta-weighted totals when nothing has a known beta", () => {
    const report = aggregatePortfolioRisk([resolved({ beta: null })], OPTS);
    expect(report.totals.betaWeightedDeltaDollars).toBeNull();
    expect(report.totals.betaWeightedSpyShares).toBeNull();
    expect(report.totals.deltaDollars).toBe(20000);
  });
});

describe("evaluatePostTradeTotals", () => {
  it("adds a candidate's contribution and can state post-trade totals", () => {
    const report = aggregatePortfolioRisk([resolved({})], OPTS);
    const post = evaluatePostTradeTotals(report, {
      deltaShares: 50, deltaDollars: 10000, betaWeightedDeltaDollars: 12000,
      gammaSharesPerDollar: 1, thetaDollarsPerDay: -2, vegaDollarsPerVolPoint: 0.1,
      rhoDollarsPerRatePoint: 0.05,
      definedMaxLoss: 3000,
    });
    expect(post.deltaShares).toBe(150);
    expect(post.deltaDollars).toBe(30000);
    expect(post.betaWeightedDeltaDollars).toBe(36000);
    expect(post.rhoDollarsPerRatePoint).toBe(0.05);
    expect(post.definedMaxLoss).toBe(23000);
  });

  it("propagates null beta-weighted totals instead of fabricating them", () => {
    const report = aggregatePortfolioRisk([resolved({})], OPTS);
    const post = evaluatePostTradeTotals(report, {
      deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: null,
      gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0,
      rhoDollarsPerRatePoint: 0, definedMaxLoss: 0,
    });
    expect(post.betaWeightedDeltaDollars).toBeNull();
  });
});

describe("resolvePositionsSnapshot", () => {
  it("resolves held option contracts against the live chain and flags unresolvable ones", async () => {
    const fakeEtrade = {
      async getOptionChains(params: { symbol: string }) {
        if (params.symbol === "NVDA") {
          return {
            symbol: "NVDA",
            underlyingPrice: 800,
            pairs: [
              { call: { optionType: "CALL" as const, strikePrice: 850, symbol: "NVDA", bid: 5, ask: 5.4, lastPrice: 5.2, delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.12, rho: 0.03 } },
            ],
          };
        }
        if (params.symbol === "MSFT") {
          // Contract exists but the chain omits rho -> incomplete, never zero-filled.
          return {
            symbol: "MSFT",
            underlyingPrice: 420,
            pairs: [
              { put: { optionType: "PUT" as const, strikePrice: 400, symbol: "MSFT", bid: 3, ask: 3.3, lastPrice: 3.1, delta: -0.4, gamma: 0.01, theta: -0.03, vega: 0.1 } },
            ],
          };
        }
        return null;
      },
    } as any;
    const stubBeta = async (symbol: string) => ({ beta: 1.5, source: "computed-live" as const, observations: 240, asOf: "2026-10-15T00:00:00.000Z" });
    const positions: ETradePosition[] = [
      equityPosition({
        symbol: "NVDA", quantity: 2, securityType: "OPTN", optionType: "CALL",
        strikePrice: 850, expirationDate: "2026-11-20", costBasis: 1000,
      }),
      equityPosition({ symbol: "MSFT", quantity: 1, securityType: "OPTN", optionType: "PUT", strikePrice: 400, expirationDate: "2026-11-20" }),
      equityPosition({ symbol: "QQQ", quantity: 3, securityType: "OPTN" }), // no contract detail
    ];
    // Issue #3324: the model reads a source, so the fixture supplies the
    // chain reader directly instead of a service-shaped double.
    const source = {
      optionChain: (symbol: string) =>
        fakeEtrade.getOptionChains({ symbol }),
    };
    const resolvedList = await resolvePositionsSnapshot(source, positions, stubBeta);
    expect(resolvedList[0].greeks).toEqual({ delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.12, rho: 0.03 });
    expect(resolvedList[0].referencePrice).toBe(800);
    expect(resolvedList[0].beta).toBe(1.5);
    expect(resolvedList[0].betaSource).toBe("computed-live");
    expect(resolvedList[1].greeks).toBeNull();
    expect(resolvedList[1].greeksMissingReason).toContain("incomplete");
    expect(resolvedList[1].greeksMissingReason).toContain("rho");
    expect(resolvedList[2].greeks).toBeNull();
    expect(resolvedList[2].greeksMissingReason).toContain("without contract detail");
  });
});
