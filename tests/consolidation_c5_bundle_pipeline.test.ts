/**
 * Issue #1361 (epic #1151 slice C5) — bundles through the pipeline.
 *
 * - The bundle route's opt-in canonical persistence builds its
 *   mas_reports row through the shared storeReportStage seam
 *   (source "bundle"), so bundles are served in Reports alongside
 *   every other run kind.
 * - Multi-candidate alternatives are route-exposed: `candidates[]`
 *   normalizes primary-first with all entries preserved.
 * - The bundle decision card contract: human approval required,
 *   draft-only, disclaimer carried — the card's approve action can
 *   only ever approve-as-draft because no order path exists.
 */
import { describe, it, expect } from "vitest";
import { aggregatePortfolioRisk, type ResolvedPosition } from "../src/services/portfolioRisk";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  buildBundleCanonicalReportInput,
  buildRecommendationBundle,
  formatRecommendationBundleReport,
  normalizeBundleCandidates,
  type BundleCandidateInput,
} from "../src/services/recommendationBundle";
import { storeReportStage } from "../src/services/unifiedReportPipeline";
import { completeBundleRoute } from "../src/agents/routes/etradeBrokerBundle";
import type { StrategyCandidate, StrategyLeg } from "../src/trading/options/strategyEngine";
import type { FalsificationInput } from "../src/services/researchFalsification";

const AS_OF = "2026-10-24T00:00:00.000Z";

function bookReport(nav = 200_000) {
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
  return aggregatePortfolioRisk(resolved, { nav, spyPrice: 500, asOf: AS_OF });
}

function leg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1, strike: 200,
    expirationDate: "2026-11-22", daysToExpiration: 30, entryPrice: 5, bid: 4.8, ask: 5.2,
    impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
    openInterest: 5_000, volume: 1_000, spreadPct: 0.08,
    quoteTimestamp: AS_OF, quoteFreshness: "FRESH", multiplier: 100,
    ...partial,
  };
}

function candidate(partial: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: "cand-spread", rank: 1, type: "bull_call_spread" as any, label: "XYZ 200/210 bull call spread",
    symbol: "XYZ", underlyingPrice: 200, expirationDate: "2026-11-22", dataFreshness: "FRESH",
    legs: [leg({ entryPrice: 2, bid: 1.8, ask: 2.2 })],
    netDebit: 2, estimatedFees: 2, maxProfit: null, maxProfitUnbounded: true, maxLoss: 200,
    breakevens: [203], targetPnl: 300, targetRewardRisk: 1, modelImpliedProbabilityOfProfit: 0.45,
    netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
    liquidityScore: 80, score: 70, scoreBreakdown: {} as any, payoffCurve: [], scenarios: [],
    explanations: [], warnings: [], assumptions: [],
    ...partial,
  };
}

const FALSIFICATION: FalsificationInput = {
  symbol: "XYZ", outlook: "bullish", thesis: "XYZ breaks out on volume expansion.",
  supportingEvidence: ["rising relative strength vs sector"],
  contradictingEvidence: ["IV is elevated into the event"],
  resolutionTrigger: "product event on 2026-11-01", horizon: "30 DTE",
  invalidation: "Close below 190 on volume", whyThisStructure: "Defined-risk spread caps event gap loss vs shares.",
};

function buildBundle() {
  return buildRecommendationBundle({
    candidates: [{ candidate: candidate(), beta: 1.0 } as BundleCandidateInput],
    report: bookReport(),
    scenario: buildScenario({
      goalKind: "directional", portfolioRef: { kind: "real" },
      shocks: { pricePct: [-10, 0, 10], ivShift: [0], daysForward: [30] },
      constraints: { budget: 50_000, maxLoss: 50_000 },
    }),
    falsification: FALSIFICATION,
    pickStatus: "recommended",
    pickConfidence: "HIGH",
  });
}

describe("bundle canonical persistence (store seam)", () => {
  it("builds a bundle-source canonical row through the shared seam", async () => {
    const bundle = buildBundle();
    const input = buildBundleCanonicalReportInput(bundle, "XYZ");
    expect(input.runId).toBe(bundle.id);
    expect(input.generationId).toBe(bundle.id);
    expect(input.source).toBe("bundle");
    expect(input.title).toContain("XYZ");
    expect(input.title).toContain(bundle.decision);
    expect(input.summary).toBe(formatRecommendationBundleReport(bundle));
    expect(input.summary).toContain("Human approval required");
    expect(input.body).toEqual(bundle);
    expect(input.createdAt).toBe(bundle.asOf);

    const seen: unknown[] = [];
    const stored = await storeReportStage(
      { storeCanonicalReport: (i) => { seen.push(i); return { reportId: "rep-bundle-1", created: true }; } },
      input,
    );
    expect(stored).toEqual({ reportId: "rep-bundle-1", created: true });
    expect((seen[0] as any).source).toBe("bundle");
  });

  it("decision card contract: approval required, draft-only, disclaimer carried", () => {
    const bundle = buildBundle();
    expect(bundle.humanApprovalRequired).toBe(true);
    expect(bundle.disclaimer.length).toBeGreaterThan(0);
    expect(bundle.trade === null || bundle.status !== "recommended" || bundle.decision !== "trade").toBe(false);
    // No order path exists on the bundle contract: no order, preview,
    // or execution field is present anywhere on the bundle.
    expect(JSON.stringify(bundle)).not.toMatch(/"orderId"|"orderPreview"|"execution"/);
  });
});

describe("bundle route completion delegate (etradeBrokerBundle)", () => {
  const fakeCtx = (orm: unknown) => ({ env: {}, getOrm: () => orm }) as any;

  it("persistReport stores the canonical row and reports it; no options means a bare bundle", async () => {
    const bundle = buildBundle();
    const seen: unknown[] = [];
    const res = await completeBundleRoute(fakeCtx({ storeCanonicalReport: (i: unknown) => { seen.push(i); return { reportId: "rep-1", created: true }; } }), {
      bundle, primarySymbol: "XYZ", body: { persistReport: true }, userLogin: "tester",
    });
    const json = await res.json() as any;
    expect(json.reportPersistence).toEqual({ reportId: "rep-1", created: true });
    expect((seen[0] as any).source).toBe("bundle");
    expect(json.persistence).toBeUndefined();
    expect(json.delivery).toBeUndefined();

    const bare = await completeBundleRoute(fakeCtx({}), {
      bundle, primarySymbol: "XYZ", body: {}, userLogin: "tester",
    });
    const bareJson = await bare.json() as any;
    expect(bareJson.reportPersistence).toBeUndefined();
    expect(bareJson.id).toBe(bundle.id);
  });

  it("persistReport with no usable ORM reports null verbatim, never throws", async () => {
    const res = await completeBundleRoute(fakeCtx({}), {
      bundle: buildBundle(), primarySymbol: "XYZ", body: { persistReport: true }, userLogin: "tester",
    });
    const json = await res.json() as any;
    expect(json.reportPersistence).toBeNull();
  });
});

describe("multi-candidate alternatives route-exposed", () => {
  it("candidates[] normalizes primary-first with all entries preserved", () => {
    const res = normalizeBundleCandidates({
      candidates: [
        { candidate: candidate({ id: "cand-a" }), beta: 1.0 },
        { candidate: candidate({ id: "cand-b", label: "XYZ 190/200 bull put spread" }), beta: 0.8 },
      ],
    } as any);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.candidate.id)).toEqual(["cand-a", "cand-b"]);
  });
});
