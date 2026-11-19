/**
 * Issue #63: Portfolio Risk panel view-model helpers.
 * The panel is a display layer; the pieces that carry meaning — turning a
 * hedge DRAFT into the order ticket's hand-off context, and formatting the
 * backends' honesty states — are pinned here.
 */
import { describe, it, expect } from "vitest";
import { fmtSignedUsd, fmtUsd, hedgeProposalToTradeContext, repairProposalToTradeContext } from "../src/client/portfolioRiskApi";
import type { HedgeProposal } from "../src/services/hedgeProposals";
import type { RepairProposal } from "../src/services/repairProposals";

const sharesProposal: HedgeProposal = {
  instrument: "SPY_SHARES", status: "DRAFT", side: "SELL", symbol: "SPY", quantity: 100,
  estimatedCost: -50000, preHedgeBetaWeightedDeltaDollars: 50000, postHedgeBetaWeightedDeltaDollars: 0,
  withinToleranceAfterHedge: true, rationale: "test",
};
const putsProposal: HedgeProposal = {
  instrument: "SPY_PUTS", status: "DRAFT", side: "BUY", symbol: "SPY", quantity: 2,
  strike: 500, expirationDate: "2026-11-14", estimatedCost: 1300,
  preHedgeBetaWeightedDeltaDollars: 50000, postHedgeBetaWeightedDeltaDollars: 5000,
  withinToleranceAfterHedge: false, rationale: "test",
};

const repairProposal: RepairProposal = {
  status: "DRAFT",
  symbol: "XYZ",
  units: 3,
  legLong: { strike: 80, expirationDate: "2026-11-20", premium: 5.0 },
  legShort: { strike: 90, expirationDate: "2026-11-20", premium: 2.4, quantity: 2 },
  netDebitPerUnit: 0.20,
  breakevenAtExpiry: 90,
  maxRecoveryPerUnit: 980,
  upsideCappedAbove: 90,
  noDownsideProtection: true,
  maxAdditionalCapitalAtRisk: 60,
  postRepairBetaWeightedDeltaDollars: 12000,
  rationale: "Underwater XYZ repair",
};

describe("hedgeProposalToTradeContext (HITL hand-off)", () => {
  it("maps the share hedge onto the order ticket fields", () => {
    const ctx = hedgeProposalToTradeContext(sharesProposal, 500);
    expect(ctx.symbol).toBe("SPY");
    expect(ctx.action).toBe("SELL");
    expect(ctx.quantity).toBe(100);
    expect(ctx.underlyingPrice).toBe(500);
    expect(ctx.label).toContain("Hedge draft");
    expect(ctx.label).toContain("100 SPY shares");
    expect(ctx.legs[0]).toContain("SELL 100 SPY shares");
  });

  it("maps the put hedge with strike, expiry and cost in the legs text", () => {
    const ctx = hedgeProposalToTradeContext(putsProposal, 500);
    expect(ctx.action).toBe("BUY");
    expect(ctx.quantity).toBe(2);
    expect(ctx.legs[0]).toContain("500 PUT");
    expect(ctx.legs[0]).toContain("2026-11-14");
    expect(ctx.label).toContain("→");
  });
});

describe("repairProposalToTradeContext (HITL hand-off)", () => {
  it("maps the 1x2 ratio repair with unit-ratio legs and non-zero strategyNetDebit", () => {
    const ctx = repairProposalToTradeContext(repairProposal);
    expect(ctx.assetClass).toBe("options");
    expect(ctx.symbol).toBe("XYZ");
    expect(ctx.action).toBe("BUY");
    expect(ctx.quantity).toBe(3);
    expect(ctx.optionLegs).toHaveLength(2);
    // Crucial: base leg quantities are 1 and 2 (ratio), because TradeHub multiplies leg.quantity * orderQuantity!
    expect(ctx.optionLegs![0].quantity).toBe(1);
    expect(ctx.optionLegs![0].side).toBe("BUY");
    expect(ctx.optionLegs![0].strike).toBe(80);
    expect(ctx.optionLegs![1].quantity).toBe(2);
    expect(ctx.optionLegs![1].side).toBe("SELL");
    expect(ctx.optionLegs![1].strike).toBe(90);
    // Non-zero strategyNetDebit matching 100x per share limit price (0.20 * 100 = 20)
    expect(ctx.strategyNetDebit).toBe(20);
    expect(ctx.label).toContain("Repair draft");
    expect(ctx.label).toContain("1×2 call ratio on XYZ");
  });
});

describe("formatting", () => {
  it("renders signed dollars and em-dashes for unavailable values", () => {
    expect(fmtSignedUsd(1234)).toBe("+$1,234");
    expect(fmtSignedUsd(-50)).toBe("−$50");
    expect(fmtSignedUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(500, 2)).toBe("$500.00");
  });
});

import { buildEvaluateCandidate } from "../src/client/portfolioRiskApi";
import { parseSymbolList } from "../src/client/accountApi";

describe("buildEvaluateCandidate (issue #67)", () => {
  const full = {
    deltaShares: "100", deltaDollars: "5000", betaWeightedDeltaDollars: "6000",
    gammaSharesPerDollar: "2.5", thetaDollarsPerDay: "-40", vegaDollarsPerVolPoint: "120",
    rhoDollarsPerRatePoint: "30", definedMaxLoss: "2000",
  };
  it("parses a complete form", () => {
    const c = buildEvaluateCandidate(full);
    expect(c?.deltaDollars).toBe(5000);
    expect(c?.betaWeightedDeltaDollars).toBe(6000);
    expect(c?.definedMaxLoss).toBe(2000);
  });
  it("treats a blank beta-weighted delta as unknown (null), not zero", () => {
    const c = buildEvaluateCandidate({ ...full, betaWeightedDeltaDollars: "" });
    expect(c?.betaWeightedDeltaDollars).toBeNull();
  });
  it("rejects missing or non-numeric required fields", () => {
    expect(buildEvaluateCandidate({ ...full, deltaDollars: "" })).toBeNull();
    expect(buildEvaluateCandidate({ ...full, thetaDollarsPerDay: "abc" })).toBeNull();
  });
});

describe("parseSymbolList (issue #67)", () => {
  it("splits, uppercases and dedupes", () => {
    expect(parseSymbolList("aapl, msft  AAPL;spy")).toEqual(["AAPL", "MSFT", "SPY"]);
    expect(parseSymbolList("")).toEqual([]);
  });
});

import { positionRowToEvalForm, sizingToEvalForm } from "../src/client/portfolioRiskApi";
import type { PositionRiskRow } from "../src/services/portfolioRisk";
import type { SizingCandidate, SizingResult } from "../src/services/positionSizing";

describe("prefill wiring (issue #69)", () => {
  it("maps a position row into a complete evaluator form", () => {
    const row = {
      symbol: "ACME", kind: "option", signedQuantity: 2, deltaShares: 50, deltaDollars: 5000,
      betaWeightedDeltaDollars: 6000, betaWeightedSpyShares: 12, gammaSharesPerDollar: 1.5,
      thetaDollarsPerDay: -25, vegaDollarsPerVolPoint: 80, rhoDollarsPerRatePoint: 10,
      beta: 1.2, betaSource: "computed-live", betaObservations: 252, definedMaxLoss: 1500, quoteAsOf: null,
    } as unknown as PositionRiskRow;
    const form = positionRowToEvalForm(row);
    expect(form.deltaDollars).toBe("5000");
    expect(form.rhoDollarsPerRatePoint).toBe("10");
    expect(form.definedMaxLoss).toBe("1500");
  });

  it("scales a sizing result per-contract × recommended, leaving unknown Greeks blank", () => {
    const candidate: SizingCandidate = { symbol: "ACME", perContract: { deltaDollars: 500, betaWeightedDeltaDollars: null, definedMaxLoss: 200 } };
    const sizing = { recommendedContracts: 4 } as SizingResult;
    const form = sizingToEvalForm(candidate, sizing);
    expect(form.deltaDollars).toBe("2000");
    expect(form.definedMaxLoss).toBe("800");
    expect(form.betaWeightedDeltaDollars).toBe("");
    expect(form.gammaSharesPerDollar).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* Bundle candidate honesty (issue #1205)                              */
/*                                                                     */
/* The Best Trade v2 panel shipped (#1135) with a candidate textarea   */
/* whose placeholder is a JSON skeleton full of literal "…" — it       */
/* looks like input, is not, and the Build button was silently         */
/* disabled with no explanation. These tests pin the interim fix: a    */
/* real example candidate, and a state helper that always says why     */
/* Build is unavailable.                                               */
/* ------------------------------------------------------------------ */

import { bundleCandidateTextState, exampleBundleCandidateJson, parseBundleCandidate } from "../src/client/portfolioRiskApi";
import { buildRecommendationBundle, normalizeBundleCandidates } from "../src/services/recommendationBundle";
import { aggregatePortfolioRisk, type ResolvedPosition } from "../src/services/portfolioRisk";
import { buildScenario } from "../src/services/goalScenarioEngine";
import type { FalsificationInput } from "../src/services/researchFalsification";

describe("example bundle candidate (issue #1205)", () => {
  it("inserts as JSON that parses through parseBundleCandidate with engine-shaped legs", () => {
    const candidate = parseBundleCandidate(exampleBundleCandidateJson());
    expect(candidate.symbol).toBe("XYZ");
    expect(candidate.legs.length).toBeGreaterThan(0);
    const leg = candidate.legs[0];
    // The leg fields the bundle engine consumes (researchLegsFromStrategyLegs
    // + greeksPerContract): identity, strike/expiry, prices and Greeks.
    expect(leg).toMatchObject({
      symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1,
      strike: 200, expirationDate: "2026-11-22", entryPrice: 2, bid: 1.8, ask: 2.2,
      impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
      openInterest: 5_000, volume: 1_000, multiplier: 100,
    });
    expect(candidate.netGreeks).toEqual({ delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 });
    expect(candidate.maxLoss).toBeGreaterThan(0);
  });

  it("is accepted by the bundle route's candidate normalization", () => {
    const candidate = parseBundleCandidate(exampleBundleCandidateJson());
    const normalized = normalizeBundleCandidates({ candidate, beta: 1.1 });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.candidates).toHaveLength(1);
      expect(normalized.candidates[0].candidate.id).toBe(candidate.id);
    }
  });

  it("builds end-to-end in the bundle engine (no missing-field failure)", () => {
    const candidate = parseBundleCandidate(exampleBundleCandidateJson());
    const resolved: ResolvedPosition[] = [{
      position: {
        symbol: "AAPL", description: "Common Stock", quantity: 50, pricePaid: 180,
        costBasis: 9_000, currentPrice: 200, marketPrice: 200, marketValue: 10_000,
        totalGain: 2_000, unrealizedGainLoss: 2_000, totalGainPercent: 11,
        unrealizedGainLossPercent: 11, daysGain: 0, daysGainPercent: 0,
        securityType: "EQ", positionType: "LONG",
      } as any,
      kind: "equity", signedQuantity: 50, referencePrice: 200,
      greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
      beta: 1.2, betaSource: "computed-live", betaObservations: 252,
    }];
    const falsification: FalsificationInput = {
      symbol: "XYZ", outlook: "bullish", thesis: "XYZ breaks out on volume expansion.",
      supportingEvidence: ["rising relative strength vs sector"],
      contradictingEvidence: ["IV is elevated into the event"],
      resolutionTrigger: "product event on 2026-11-01", horizon: "30 DTE",
      invalidation: "Close below 190 on volume", whyThisStructure: "Defined-risk structure caps event gap loss vs shares.",
    };
    const bundle = buildRecommendationBundle({
      candidates: [{ candidate, beta: 1.0 }],
      report: aggregatePortfolioRisk(resolved, { nav: 200_000, spyPrice: 500, asOf: "2026-10-23T00:00:00.000Z" }),
      scenario: buildScenario({
        goalKind: "directional", portfolioRef: { kind: "real" },
        shocks: { pricePct: [-10, 0, 10], ivShift: [0], daysForward: [30] },
        constraints: { budget: 50_000, maxLoss: 50_000 },
      }),
      falsification,
      pickStatus: "recommended",
      pickConfidence: "HIGH",
    } as any);
    expect(bundle.decision).toBe("trade");
    expect(bundle.trade?.candidateId).toBe(candidate.id);
    expect(bundle.falsification).not.toBeNull();
  });
});

describe("bundleCandidateTextState (issue #1205)", () => {
  it("empty text → disabled reason that names the skeleton as a placeholder, not input", () => {
    for (const text of ["", "   \n  "]) {
      const state = bundleCandidateTextState(text);
      expect(state.status).toBe("empty");
      expect(state.message).toMatch(/placeholder/i);
      expect(state.message).toMatch(/disabled/i);
      expect(state.message).toMatch(/example/i);
    }
  });

  it("malformed JSON → invalid with a plain not-valid-JSON reason", () => {
    const state = bundleCandidateTextState("{ not json");
    expect(state.status).toBe("invalid");
    expect(state.message).toMatch(/not valid JSON/i);
  });

  it("the shipped placeholder skeleton itself, pasted as if it were input, → invalid", () => {
    const skeleton = '{"id": "…", "symbol": "XYZ", "underlyingPrice": 200, "legs": [ … ], "netGreeks": {"delta": 0.5, "gamma": 0.02, "theta": -0.02, "vega": 0.05}, …}';
    const state = bundleCandidateTextState(skeleton);
    expect(state.status).toBe("invalid");
    expect(state.message).toMatch(/not valid JSON/i);
  });

  it("structurally invalid candidate → invalid with the parser's structural reason", () => {
    const state = bundleCandidateTextState('{"symbol":"XYZ","legs":[]}');
    expect(state.status).toBe("invalid");
    expect(state.message).toMatch(/at least one leg/i);
  });

  it("the example candidate → valid, no complaint", () => {
    const state = bundleCandidateTextState(exampleBundleCandidateJson());
    expect(state.status).toBe("valid");
    expect(state.message).toBeNull();
  });
});
