/**
 * Portfolio-aware position sizing (issue #36, gap G3).
 *
 * Replaces the isolated per-trade heuristic (the client risk anatomy's
 * NAV-band rule) with sizing against the CURRENT portfolio risk budget
 * from the G1 aggregation (#34): a candidate is sized by whichever of
 * four constraints binds first, and the output always names it.
 *
 * Constraints (all policy constants live in SIZING_POLICY, nowhere else):
 *  1. nav-band        — the legacy outer cap, kept: per-trade capital at
 *                       risk (defined max loss) ≤ 2% / 3.5% / 5% of NAV by
 *                       risk score (>75 / >50 / otherwise), mirroring the
 *                       client anatomy's bands exactly.
 *  2. delta-budget    — post-trade |beta-weighted delta $| ≤ 25% of NAV.
 *                       When the candidate's beta-weighted delta is
 *                       unavailable, unweighted delta is used and the
 *                       constraint is labeled as such. When the candidate
 *                       is highly correlated with the book (max measured
 *                       correlation ≥ 0.70, from #35), its delta counts
 *                       at a 1.5× surcharge — correlated exposure is not
 *                       independent exposure.
 *  3. max-loss-budget — post-trade total defined max loss ≤ 10% of NAV.
 *  4. concentration   — post-trade single-name |delta $| ≤ 15% of NAV
 *                       (the same 15% single-asset cap the thinkHarness
 *                       guardrail enforces, #37).
 *
 * A candidate whose per-contract max loss is undefined (naked/undefined
 * risk) is never sized by these budgets: recommended size is 0 with
 * binding constraint "undefined-risk".
 */

import { evaluatePostTradeTotals, type PortfolioRiskReport, type PortfolioRiskTotals } from "./portfolioRisk";
import { CONCENTRATION_POLICY } from "./portfolioConcentration";

export const SIZING_POLICY = {
  /** Legacy NAV bands by risk score — outer cap only (mirrors the client anatomy). */
  navBandPct: { highRisk: 2.0, mediumRisk: 3.5, standard: 5.0, highRiskScoreAbove: 75, mediumRiskScoreAbove: 50 },
  aggregateDeltaBudgetPctOfNav: 25,
  totalMaxLossBudgetPctOfNav: 10,
  singleNameDeltaCapPctOfNav: 15,
  correlationSurchargeFactor: 1.5,
  /** Issue #1769: doc heat cap — total open max loss <= 35% of account equity (screener-rules.md §1.6). */
  heatCapPctOfNav: 35,
  /** Issue #1769: fractional Kelly unlocks only after this many historical verified trades. */
  kellyMinVerifiedTrades: 30,
} as const;

export type BindingConstraint = "nav-band" | "delta-budget" | "max-loss-budget" | "concentration" | "heat-cap" | "requested-quantity" | "undefined-risk";

/**
 * Total-open-heat check (issue #1769, parent #1717; screener-rules.md
 * §1.6: total open max loss across all positions <= 35% of account
 * equity). Inclusive: exactly the cap passes. Returns null on
 * non-positive equity, negative open loss, or non-finite inputs —
 * heat over an impossible equity is not a number.
 */
export interface PortfolioHeatCheck {
  totalOpenMaxLoss: number;
  accountEquity: number;
  heatPct: number;
  capPct: number;
  /** Cap dollars minus open loss; negative when over the cap. */
  headroom: number;
  passes: boolean;
}

export function checkPortfolioHeatCap(args: {
  totalOpenMaxLoss: number;
  accountEquity: number;
  capPct?: number;
}): PortfolioHeatCheck | null {
  const { totalOpenMaxLoss, accountEquity } = args;
  const capPct = args.capPct ?? SIZING_POLICY.heatCapPctOfNav;
  if (!Number.isFinite(totalOpenMaxLoss) || totalOpenMaxLoss < 0) return null;
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return null;
  if (!Number.isFinite(capPct) || capPct < 0) return null;
  const heatPct = (totalOpenMaxLoss / accountEquity) * 100;
  return {
    totalOpenMaxLoss,
    accountEquity,
    heatPct,
    capPct,
    headroom: (capPct / 100) * accountEquity - totalOpenMaxLoss,
    passes: heatPct <= capPct,
  };
}

/**
 * Fractional Kelly sizing (issue #1769; screener-rules.md §1.6):
 * f* = ((p × b − (1 − p)) / b) × Fraction, where p = win
 * probability, b = Credit / MaxLoss, and Fraction is the Kelly
 * fraction (0 < Fraction <= 1; half-Kelly = 0.5). Returns the
 * fraction of bankroll to risk (a decimal, e.g. 0.10 = 10%).
 * LOCKED: verifiedTrades < 30 returns null — the doc unlocks Kelly
 * only after >= 30 historical verified trades, and a locked formula
 * must not masquerade as a zero edge. A negative Kelly edge returns
 * 0 (no bet), never a negative size. Invalid probabilities, ratios,
 * or fractions return null.
 */
export function fractionalKellySize(args: {
  winProb: number;
  payoffRatio: number;
  fraction: number;
  verifiedTrades: number;
}): number | null {
  const { winProb, payoffRatio, fraction, verifiedTrades } = args;
  if (!Number.isInteger(verifiedTrades) || verifiedTrades < SIZING_POLICY.kellyMinVerifiedTrades) return null;
  if (!Number.isFinite(winProb) || winProb < 0 || winProb > 1) return null;
  if (!Number.isFinite(payoffRatio) || payoffRatio <= 0) return null;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null;
  const kelly = (winProb * payoffRatio - (1 - winProb)) / payoffRatio;
  return Math.max(0, kelly * fraction);
}

export interface SizingCandidate {
  symbol: string;
  /** Per-contract Greek dollar contributions (same units as #34 totals). */
  perContract: {
    deltaDollars: number;
    betaWeightedDeltaDollars: number | null;
    definedMaxLoss: number | null;
    gammaSharesPerDollar?: number;
    thetaDollarsPerDay?: number;
    vegaDollarsPerVolPoint?: number;
    rhoDollarsPerRatePoint?: number;
  };
  /** 0–100 risk score for the NAV band; absent → most conservative band. */
  riskScore?: number;
  requestedContracts?: number;
  /** Max MEASURED correlation to held positions (#35), when known. */
  maxMeasuredCorrelation?: number | null;
}

export interface SizingConstraintResult {
  name: BindingConstraint;
  maxContracts: number;
  detail: string;
}

export interface SizingResult {
  symbol: string;
  recommendedContracts: number;
  bindingConstraint: BindingConstraint;
  rationale: string;
  navBandPctApplied: number;
  deltaBudgetBasis: "beta-weighted" | "unweighted (beta unavailable)";
  correlationSurchargeApplied: boolean;
  constraints: SizingConstraintResult[];
  postTradeTotals: PortfolioRiskTotals;
}

export function navBandPctForRiskScore(riskScore?: number): number {
  if (riskScore === undefined) return SIZING_POLICY.navBandPct.highRisk;
  if (riskScore > SIZING_POLICY.navBandPct.highRiskScoreAbove) return SIZING_POLICY.navBandPct.highRisk;
  if (riskScore > SIZING_POLICY.navBandPct.mediumRiskScoreAbove) return SIZING_POLICY.navBandPct.mediumRisk;
  return SIZING_POLICY.navBandPct.standard;
}

const clampContracts = (budget: number, perUnit: number): number => {
  if (perUnit <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(budget / perUnit));
};

export function sizeCandidateAgainstPortfolio(report: PortfolioRiskReport, candidate: SizingCandidate): SizingResult {
  const nav = report.nav;
  const totals = report.totals;
  const bandPct = navBandPctForRiskScore(candidate.riskScore);
  const per = candidate.perContract;

  const zeroTotals = evaluatePostTradeTotals(report, {
    deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: 0,
    gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0,
    rhoDollarsPerRatePoint: 0, definedMaxLoss: 0,
  });

  if (per.definedMaxLoss === null || per.definedMaxLoss <= 0) {
    return {
      symbol: candidate.symbol.toUpperCase(),
      recommendedContracts: 0,
      bindingConstraint: "undefined-risk",
      rationale: `${candidate.symbol.toUpperCase()} has undefined per-contract max loss; undefined-risk trades are not sized against portfolio budgets.`,
      navBandPctApplied: bandPct,
      deltaBudgetBasis: per.betaWeightedDeltaDollars !== null ? "beta-weighted" : "unweighted (beta unavailable)",
      correlationSurchargeApplied: false,
      constraints: [{ name: "undefined-risk", maxContracts: 0, detail: "Per-contract defined max loss is unavailable." }],
      postTradeTotals: zeroTotals,
    };
  }

  // 1. NAV band (outer cap): capital at risk for THIS trade.
  const navBandBudget = (bandPct / 100) * nav;
  const navBandMax = clampContracts(navBandBudget, per.definedMaxLoss);

  // 2. Aggregate delta budget, with correlation surcharge.
  const surcharge = candidate.maxMeasuredCorrelation !== null
    && candidate.maxMeasuredCorrelation !== undefined
    && candidate.maxMeasuredCorrelation >= CONCENTRATION_POLICY.highCorrelation;
  const surchargeFactor = surcharge ? SIZING_POLICY.correlationSurchargeFactor : 1;
  const deltaBasis: SizingResult["deltaBudgetBasis"] = per.betaWeightedDeltaDollars !== null ? "beta-weighted" : "unweighted (beta unavailable)";
  const currentDeltaForBudget = deltaBasis === "beta-weighted" ? (totals.betaWeightedDeltaDollars ?? totals.deltaDollars) : totals.deltaDollars;
  const perContractDeltaForBudget = (deltaBasis === "beta-weighted" ? per.betaWeightedDeltaDollars! : per.deltaDollars) * surchargeFactor;
  const deltaBudget = (SIZING_POLICY.aggregateDeltaBudgetPctOfNav / 100) * nav;
  // Headroom in the candidate's direction: the budget caps |post-trade delta|.
  const deltaHeadroom = perContractDeltaForBudget >= 0
    ? deltaBudget - currentDeltaForBudget
    : deltaBudget + currentDeltaForBudget;
  const deltaMax = clampContracts(deltaHeadroom, Math.abs(perContractDeltaForBudget));

  // 3. Total defined max-loss budget.
  const maxLossBudget = (SIZING_POLICY.totalMaxLossBudgetPctOfNav / 100) * nav;
  const maxLossMax = clampContracts(maxLossBudget - totals.definedMaxLoss, per.definedMaxLoss);

  // 4. Single-name concentration.
  const currentNameDelta = report.rows
    .filter((r) => r.symbol === candidate.symbol.toUpperCase())
    .reduce((sum, r) => sum + (r.deltaDollars ?? 0), 0);
  const nameCap = (SIZING_POLICY.singleNameDeltaCapPctOfNav / 100) * nav;
  const nameHeadroom = per.deltaDollars >= 0 ? nameCap - currentNameDelta : nameCap + currentNameDelta;
  const concentrationMax = clampContracts(nameHeadroom, Math.abs(per.deltaDollars));

  const constraints: SizingConstraintResult[] = [
    { name: "nav-band", maxContracts: navBandMax, detail: `Capital at risk ≤ ${bandPct}% of NAV ($${navBandBudget.toFixed(0)}) at $${per.definedMaxLoss.toFixed(0)}/contract.` },
    { name: "delta-budget", maxContracts: deltaMax, detail: `Post-trade |${deltaBasis} delta| ≤ ${SIZING_POLICY.aggregateDeltaBudgetPctOfNav}% of NAV ($${deltaBudget.toFixed(0)}); current $${currentDeltaForBudget.toFixed(0)}, headroom $${deltaHeadroom.toFixed(0)}${surcharge ? `, correlation surcharge ${surchargeFactor}× applied (max measured correlation ${candidate.maxMeasuredCorrelation})` : ""}.` },
    { name: "max-loss-budget", maxContracts: maxLossMax, detail: `Post-trade total defined max loss ≤ ${SIZING_POLICY.totalMaxLossBudgetPctOfNav}% of NAV ($${maxLossBudget.toFixed(0)}); current $${totals.definedMaxLoss.toFixed(0)}.` },
    { name: "concentration", maxContracts: concentrationMax, detail: `Post-trade ${candidate.symbol.toUpperCase()} |delta| ≤ ${SIZING_POLICY.singleNameDeltaCapPctOfNav}% of NAV ($${nameCap.toFixed(0)}); current $${currentNameDelta.toFixed(0)}.` },
    // Issue #1769: doc heat cap (35% of NAV) enforced ALONGSIDE the
    // existing 10% max-loss budget, never instead of it — the 10%
    // budget is tighter, so it still binds first and no existing
    // sizing changes, while the doc cap is enforced in code (not
    // UI/doc-only) and visible in the constraint list.
    { name: "heat-cap", maxContracts: clampContracts((SIZING_POLICY.heatCapPctOfNav / 100) * nav - totals.definedMaxLoss, per.definedMaxLoss), detail: `Post-trade total defined max loss ≤ ${SIZING_POLICY.heatCapPctOfNav}% of NAV ($${((SIZING_POLICY.heatCapPctOfNav / 100) * nav).toFixed(0)}, doc heat cap); current $${totals.definedMaxLoss.toFixed(0)}.` },
  ];

  let recommended = Math.min(...constraints.map((c) => c.maxContracts));
  let binding: BindingConstraint = constraints.find((c) => c.maxContracts === recommended)!.name;
  if (candidate.requestedContracts !== undefined && candidate.requestedContracts < recommended) {
    recommended = candidate.requestedContracts;
    binding = "requested-quantity";
  }
  if (!Number.isFinite(recommended)) recommended = candidate.requestedContracts ?? 0;

  const postTradeTotals = evaluatePostTradeTotals(report, {
    deltaShares: 0,
    deltaDollars: per.deltaDollars * recommended,
    betaWeightedDeltaDollars: per.betaWeightedDeltaDollars !== null ? per.betaWeightedDeltaDollars * recommended : null,
    gammaSharesPerDollar: (per.gammaSharesPerDollar ?? 0) * recommended,
    thetaDollarsPerDay: (per.thetaDollarsPerDay ?? 0) * recommended,
    vegaDollarsPerVolPoint: (per.vegaDollarsPerVolPoint ?? 0) * recommended,
    rhoDollarsPerRatePoint: (per.rhoDollarsPerRatePoint ?? 0) * recommended,
    definedMaxLoss: per.definedMaxLoss * recommended,
  });

  const bindingDetail = binding === "requested-quantity"
    ? `the requested quantity (${candidate.requestedContracts}) is below every portfolio cap`
    : constraints.find((c) => c.name === binding)!.detail;

  return {
    symbol: candidate.symbol.toUpperCase(),
    recommendedContracts: recommended,
    bindingConstraint: binding,
    rationale: `Recommended ${recommended} contract(s) for ${candidate.symbol.toUpperCase()}; bound by ${binding}: ${bindingDetail}`,
    navBandPctApplied: bandPct,
    deltaBudgetBasis: deltaBasis,
    correlationSurchargeApplied: surcharge,
    constraints,
    postTradeTotals,
  };
}
