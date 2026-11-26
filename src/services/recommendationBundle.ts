/**
 * Recommendation Bundle — "Best Trade v2" (issue #1135, Phase 4 of epic
 * #1096, PLAN.md §3.4 / gap G4).
 *
 * A recommendation is a BUNDLE, never a bare trade. This service extends
 * the RecommendationAgent's Best Trade pick (and its #534 no-view sibling)
 * with everything the pick alone did not carry:
 *
 *   1. The trade — legs priced from first principles by researchEconomics
 *      (composedStructureEconomics) and evaluated on the Phase 1 scenario
 *      grid (evaluateScenarioGrid). Caller-asserted P/L is never used.
 *   2. A falsification record (researchFalsification, PLAN §1.1) plus a
 *      pre-mortem. A bundle without one CANNOT be Qualified, and its
 *      confidence is capped at LOW. The picker's honesty caps survive:
 *      a no-view pick's bundle is never "recommended", never HIGH.
 *   3. Post-trade portfolio state — beta-weighted Greeks and delta/theta/
 *      vega deltas composed through the #34 evaluate path
 *      (evaluatePostTradeTotals). No new risk silo.
 *   4. The optimizer — sizing through #36 (sizeCandidateAgainstPortfolio,
 *      whose budgets are the stated risk limits), then a scenario
 *      mean/CVaR objective over the grid, concentration/correlation
 *      impact from #35, and an explicit improves/worsens/neutral verdict
 *      with evidence. It can recommend NO TRADE.
 *   5. A hedging plan when a stated budget is breached — built by #54
 *      (buildHedgeProposals) on the post-trade totals, ranked by cost
 *      per dollar of beta-weighted delta removed.
 *   6. A repair plan — #355 ratio repairs and/or Phase 2 composition
 *      repair/roll candidates, ranked by risk removed minus cost where
 *      risk removed is known; where it is not (the #355 repair states
 *      breakeven/max-recovery instead), ranking is cost-first and the
 *      limitation is stated, never filled with an invented number.
 *   7. Alternatives — the other candidates, optimizer-ranked, plus an
 *      explicit no-trade alternative with its scenario outcome.
 *
 * Draft-only: humanApprovalRequired is always true; nothing here places,
 * previews, or submits an order (docs/COMPLIANCE.md). Deterministic given
 * resolved inputs; missing inputs become named limitations, never
 * zero-filled numbers. Stock-leg candidates are Unverified (the Phase 2
 * limitation): researchEconomics prices option legs only.
 */

import type { BestNoViewTradePick, BestTradePick, StrategyCandidate, StrategyLeg } from "../trading";
import {
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
  type PortfolioRiskReport,
  type PortfolioRiskTotals,
} from "./portfolioRisk";
import { sizeCandidateAgainstPortfolio, SIZING_POLICY, type SizingResult } from "./positionSizing";
import type { ConcentrationReport } from "./portfolioConcentration";
import { SPY_DELTA_HEDGE_POLICY, type HedgeAnalysis, type SpyPutContract } from "./hedgeProposals";
import { buildRepairOptions } from "./repairPolicies";
import type { CompositionRepairInput, RepairLevelsMarker, RepairOption } from "./repairPolicies";
import type { RepairAnalysis } from "./repairProposals";

/** Re-exported: the repair proposal contract lives in repairPolicies. */
export type { CompositionRepairInput, RepairOption } from "./repairPolicies";
import {
  composedStructureEconomics,
  type ResearchLeg,
  type StructureEconomics,
} from "./researchEconomics";
import { evaluateScenarioGrid, type ScenarioDefinition, type ScenarioGridResult } from "./goalScenarioEngine";
import {
  buildFalsification,
  buildPremortem,
  type Falsification,
  type FalsificationInput,
  type Premortem,
} from "./researchFalsification";
import { recordOutcome, type OutcomeRecord } from "./goalScenarioStore";
import { storeReportStage } from "./unifiedReportPipeline";
import {
  buildOptimizerAlternatives,
  computeScenarioStats,
  decideOptimizerVerdict,
  rankOptimizerCandidates,
  round2,
  shouldTrade,
  type OptimizerCandidate,
  type OptimizerCandidateStats,
} from "./cvarOptimizer";

export const BUNDLE_DISCLAIMER =
  "Research output only; not personalized advice or an order. Verify live quotes and event risk, and approve any order manually.";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface BundleCandidateInput {
  candidate: StrategyCandidate;
  /** The candidate symbol's beta (live-computed upstream), or null when
   *  unknown — beta-weighted figures are then null, never assumed 1.0. */
  beta: number | null;
  riskScore?: number;
  requestedContracts?: number;
  /** Max measured correlation to held positions (#35), when known. */
  maxMeasuredCorrelation?: number | null;
}

export interface RecommendationBundleInput {
  candidates: BundleCandidateInput[];
  /** Current book from the #34 aggregation. */
  report: PortfolioRiskReport;
  /** Phase 1 scenario the bundle is evaluated inside. */
  scenario: ScenarioDefinition;
  /** The picker's verdict on these candidates, when one exists. Its
   *  status/confidence are CAPS on the bundle, never floors. */
  pickStatus?: BestTradePick["status"] | BestNoViewTradePick["status"];
  pickConfidence?: BestTradePick["confidence"];
  pickBlockers?: string[];
  /** Required for Qualified (PLAN §1.1). Absent → Unqualified, LOW cap. */
  falsification?: FalsificationInput;
  /** #35 assessment for the PRIMARY candidate, when computed. */
  concentration?: ConcentrationReport | null;
  /** Live SPY put for the options form of the hedge plan (#54). */
  spyPut?: SpyPutContract | null;
  /** #355 analysis for the book's underwater positions, when computed. */
  repairAnalysis?: RepairAnalysis | null;
  /** Phase 2 composition repair/roll candidates, when generated. */
  compositionRepairs?: CompositionRepairInput[];
  asOf?: string;
}

/* ------------------------------------------------------------------ */
/* Bundle shape                                                        */
/* ------------------------------------------------------------------ */

export interface BundleTrade {
  candidateId: string;
  label: string;
  symbol: string;
  economics: StructureEconomics;
  economicsStatus: "Verified" | "Unverified";
  maxLossDollarsPerContract: number;
  scenarioGrid: ScenarioGridResult;
  tradePlan: BestTradePick["tradePlan"];
}

export interface OptimizerResult {
  /** Scenario objective at the sized contract count. */
  expectedPnl: number;
  /** Mean of the worst quartile of grid cells (CVaR-25). */
  cvarPnl: number;
  worstPnl: number;
  probabilityOfProfit: number;
  cellCount: number;
  /** Optimizer score: expected P/L penalized by tail loss. Higher wins;
   *  no-trade scores exactly 0, so a trade must BEAT doing nothing. */
  score: number;
  verdict: "improves" | "worsens" | "neutral";
  /** Stated budget breaches post-trade (delta / max-loss / single-name). */
  breaches: string[];
  evidence: string[];
}

export interface HedgeOption {
  instrument: string;
  label: string;
  estimatedCost: number;
  riskRemovedDollars: number;
  costPerDollarRiskRemoved: number | null;
  postHedgeBetaWeightedDeltaDollars: number;
  rationale: string;
}

export interface BundleAlternative {
  kind: "candidate" | "no_trade";
  candidateId?: string;
  label: string;
  expectedPnl: number;
  cvarPnl: number;
  score: number;
  note: string;
}

export interface RecommendationBundle {
  id: string;
  asOf: string;
  status: "recommended" | "research_only" | "no_trade";
  decision: "trade" | "no_trade";
  qualification: "Qualified" | "Watchlist" | "Unqualified";
  qualificationReasons: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  trade: BundleTrade | null;
  falsification: Falsification | null;
  falsificationWarnings: string[];
  premortem: Premortem | null;
  sizing: SizingResult;
  postTradeTotals: PortfolioRiskTotals | null;
  optimizer: OptimizerResult;
  concentration: ConcentrationReport | null;
  hedging: { status: HedgeAnalysis["status"] | "none_needed"; options: HedgeOption[]; reason?: string };
  /** #1732 (PR-2 visible marker): per-level supplied + count, so a
   *  structurally-empty composition leg is visible in the output. */
  repairs: { status: "proposals" | "none_supplied"; options: RepairOption[]; levels: RepairLevelsMarker };
  alternatives: BundleAlternative[];
  rationale: string[];
  blockers: string[];
  limitations: string[];
  humanApprovalRequired: true;
  disclaimer: string;
}

/* ------------------------------------------------------------------ */
/* Leg conversion                                                      */
/* ------------------------------------------------------------------ */

/**
 * StrategyEngine legs → researchEconomics legs. STOCK legs cannot be
 * priced by the options economics core (Phase 2 limitation): they are
 * excluded from the priced set and flagged via hasStockLeg so the bundle
 * can mark the candidate Unverified instead of silently mispricing it.
 */
export function researchLegsFromStrategyLegs(legs: StrategyLeg[]): { legs: ResearchLeg[]; hasStockLeg: boolean } {
  const out: ResearchLeg[] = [];
  let hasStockLeg = false;
  for (const leg of legs) {
    if (leg.optionType === "STOCK") {
      hasStockLeg = true;
      continue;
    }
    out.push({
      optionType: leg.optionType === "CALL" ? "call" : "put",
      strike: leg.strike,
      expiry: leg.expirationDate,
      dte: leg.daysToExpiration ?? 0,
      bid: leg.bid,
      ask: leg.ask,
      iv: leg.impliedVolatility,
      volume: leg.volume,
      openInterest: leg.openInterest,
      quantity: (leg.side === "BUY" ? 1 : -1) * leg.quantity,
    });
  }
  return { legs: out, hasStockLeg };
}

/* ------------------------------------------------------------------ */
/* Optimizer internals                                                 */
/* ------------------------------------------------------------------ */

function greeksPerContract(candidate: StrategyCandidate, beta: number | null): CandidateGreekContribution & { deltaDollars: number } {
  const spot = candidate.underlyingPrice;
  const deltaShares = candidate.netGreeks.delta * 100;
  const deltaDollars = deltaShares * spot;
  return {
    deltaShares: round2(deltaShares),
    deltaDollars: round2(deltaDollars),
    betaWeightedDeltaDollars: beta !== null ? round2(deltaDollars * beta) : null,
    gammaSharesPerDollar: round2(candidate.netGreeks.gamma * 100),
    thetaDollarsPerDay: round2(candidate.netGreeks.theta * 100),
    vegaDollarsPerVolPoint: round2(candidate.netGreeks.vega * 100 * 0.01),
    rhoDollarsPerRatePoint: 0,
    definedMaxLoss: 0, // replaced by economics-derived value by the caller
  };
}

interface EvaluatedCandidate {
  input: BundleCandidateInput;
  economics: StructureEconomics;
  economicsStatus: "Verified" | "Unverified";
  sizing: SizingResult;
  grid: ScenarioGridResult;
  stats: OptimizerCandidateStats;
}

/** Optimizer view of an evaluated candidate (id/label/stats/sizing). */
function toOptimizerCandidate(e: EvaluatedCandidate): OptimizerCandidate {
  return {
    id: e.input.candidate.id,
    label: e.input.candidate.label,
    stats: e.stats,
    sizing: e.sizing,
  };
}

function evaluateCandidate(
  input: BundleCandidateInput,
  report: PortfolioRiskReport,
  scenario: ScenarioDefinition,
): EvaluatedCandidate {
  const { candidate } = input;
  const { legs, hasStockLeg } = researchLegsFromStrategyLegs(candidate.legs);
  // Stock-only candidates have no priceable option legs: carry an
  // explicit Unverified economics stub instead of throwing or pricing
  // the stock leg as an option.
  const economics: StructureEconomics = legs.length > 0
    ? composedStructureEconomics(candidate.label, legs, candidate.underlyingPrice)
    : {
        structure: candidate.label, legs: [], netDebit: 0, netCredit: 0,
        maxLoss: 0, maxGain: null, breakevens: [],
        derivationNotes: ["Unverified — no option legs to price; stock legs are outside the options economics core."],
      };
  const per = greeksPerContract(candidate, input.beta);
  const sizing = sizeCandidateAgainstPortfolio(report, {
    symbol: candidate.symbol,
    perContract: {
      deltaDollars: per.deltaDollars,
      betaWeightedDeltaDollars: per.betaWeightedDeltaDollars,
      // researchEconomics max loss is per share unit; ×100 per contract.
      definedMaxLoss: economics.maxLoss > 0 ? round2(economics.maxLoss * 100) : null,
      gammaSharesPerDollar: per.gammaSharesPerDollar,
      thetaDollarsPerDay: per.thetaDollarsPerDay,
      vegaDollarsPerVolPoint: per.vegaDollarsPerVolPoint,
      rhoDollarsPerRatePoint: 0,
    },
    riskScore: input.riskScore,
    requestedContracts: input.requestedContracts,
    maxMeasuredCorrelation: input.maxMeasuredCorrelation ?? null,
  });
  const contracts = Math.max(1, sizing.recommendedContracts);
  const grid = evaluateScenarioGrid({
    economics,
    spot: candidate.underlyingPrice,
    sigma: candidate.legs.find((l) => l.optionType !== "STOCK")?.impliedVolatility ?? 0,
    shocks: scenario.shocks,
    constraints: { ...scenario.constraints, contracts },
  });
  return {
    input,
    economics,
    economicsStatus: hasStockLeg ? "Unverified" : "Verified",
    sizing,
    grid,
    stats: computeScenarioStats(grid.cells),
  };
}

function budgetBreaches(report: PortfolioRiskReport, post: PortfolioRiskTotals): string[] {
  const nav = report.nav;
  if (!(nav > 0)) return ["NAV unavailable — portfolio budgets cannot be judged."];
  const breaches: string[] = [];
  const bw = post.betaWeightedDeltaDollars;
  if (bw !== null && Math.abs(bw) > (SIZING_POLICY.aggregateDeltaBudgetPctOfNav / 100) * nav) {
    breaches.push(`Post-trade beta-weighted delta $${bw.toFixed(0)} exceeds the ${SIZING_POLICY.aggregateDeltaBudgetPctOfNav}% of NAV delta budget ($${(((SIZING_POLICY.aggregateDeltaBudgetPctOfNav / 100) * nav)).toFixed(0)}).`);
  }
  if (post.definedMaxLoss > (SIZING_POLICY.totalMaxLossBudgetPctOfNav / 100) * nav) {
    breaches.push(`Post-trade total defined max loss $${post.definedMaxLoss.toFixed(0)} exceeds the ${SIZING_POLICY.totalMaxLossBudgetPctOfNav}% of NAV max-loss budget.`);
  }
  return breaches;
}

/* ------------------------------------------------------------------ */
/* Bundle builder                                                      */
/* ------------------------------------------------------------------ */

let bundleSeq = 0;

export function buildRecommendationBundle(input: RecommendationBundleInput): RecommendationBundle {
  const asOf = input.asOf ?? new Date().toISOString();
  const report = input.report;
  const limitations: string[] = [];
  const blockers: string[] = [...(input.pickBlockers ?? [])];

  const evaluatedUnsorted = input.candidates.map((c) => evaluateCandidate(c, report, input.scenario));
  // Ranking lives in CvarOptimizer; the builder only maps ranked
  // optimizer views back to the evaluated candidates (assembly plumbing).
  const rankedView = rankOptimizerCandidates(evaluatedUnsorted.map(toOptimizerCandidate));
  const byId = new Map(evaluatedUnsorted.map((e) => [e.input.candidate.id, e]));
  const evaluated = rankedView.map((r) => byId.get(r.id)!);
  const primary = evaluated[0] ?? null;
  const primaryView = rankedView[0] ?? null;

  /* Falsification + qualification (PLAN §1.1: required evidence). */
  let falsification: Falsification | null = null;
  let falsificationWarnings: string[] = [];
  if (input.falsification) {
    const built = buildFalsification(input.falsification);
    falsification = built.falsification;
    falsificationWarnings = built.warnings;
  }
  const qualificationReasons: string[] = [];
  let qualification: RecommendationBundle["qualification"] = "Qualified";
  if (!falsification) {
    qualification = "Unqualified";
    qualificationReasons.push("No falsification record supplied — a bundle without one cannot be Qualified (PLAN §1.1).");
  } else if (falsificationWarnings.length > 0) {
    qualification = "Watchlist";
    qualificationReasons.push(...falsificationWarnings);
  }
  if (primary && primary.economicsStatus === "Unverified") {
    qualification = "Unqualified";
    qualificationReasons.push("Primary candidate has stock legs; its economics are Unverified (options-only pricing core).");
  }
  if (qualification === "Qualified") qualificationReasons.push("Falsification record present with contradicting evidence and no warnings.");

  /* Decision: the optimizer must BEAT no-trade (score 0) at a sized count. */
  let decision: RecommendationBundle["decision"] = "no_trade";
  if (shouldTrade(primaryView)) {
    decision = "trade";
  } else if (primary) {
    blockers.push(
      primary.sizing.recommendedContracts <= 0
        ? `Optimizer sized the primary candidate to 0 contracts (binding constraint: ${primary.sizing.bindingConstraint}).`
        : `Primary candidate's scenario score ${primary.stats.score} does not beat no-trade (0).`,
    );
  } else {
    blockers.push("No qualifying candidates");
  }

  /* Post-trade state + optimizer verdict for the primary. Breaches are
   * judged at the DESIRED size (the requested quantity, or the book's
   * own totals when nothing is requested): sizing caps a trade before
   * it can breach, so judging only the sized count would make the
   * hedging trigger unreachable — the breach the user asked for is the
   * one the hedge plan must answer. */
  let postTradeTotals: PortfolioRiskTotals | null = null;
  let desiredPostTotals: PortfolioRiskTotals | null = null;
  let breaches: string[] = [];
  const evidence: string[] = [];
  let verdict: OptimizerResult["verdict"] = "neutral";
  if (primary) {
    const per = greeksPerContract(primary.input.candidate, primary.input.beta);
    const totalsAt = (n: number): PortfolioRiskTotals => evaluatePostTradeTotals(report, {
      ...per,
      deltaShares: round2(per.deltaShares * n),
      deltaDollars: round2(per.deltaDollars * n),
      betaWeightedDeltaDollars: per.betaWeightedDeltaDollars !== null ? round2(per.betaWeightedDeltaDollars * n) : null,
      gammaSharesPerDollar: round2(per.gammaSharesPerDollar * n),
      thetaDollarsPerDay: round2(per.thetaDollarsPerDay * n),
      vegaDollarsPerVolPoint: round2(per.vegaDollarsPerVolPoint * n),
      definedMaxLoss: round2(primary.economics.maxLoss * 100 * n),
    });
    const desiredContracts = primary.input.requestedContracts ?? primary.sizing.recommendedContracts;
    desiredPostTotals = totalsAt(Math.max(1, desiredContracts));
    breaches = budgetBreaches(report, desiredPostTotals);
    if (decision === "trade") {
      postTradeTotals = totalsAt(primary.sizing.recommendedContracts);
    }
  }
  if (primary && decision === "trade" && postTradeTotals) {
    const n = primary.sizing.recommendedContracts;
    evidence.push(
      `Scenario grid (${primary.grid.cells.length} cells at ${n} contract(s)): expected P/L $${primary.stats.expectedPnl}, CVaR-25 $${primary.stats.cvarPnl}, worst $${primary.stats.worstPnl}, P(profit) ${(primary.stats.probabilityOfProfit * 100).toFixed(0)}%.`,
      `Post-trade delta $ ${postTradeTotals.deltaDollars} (was $${report.totals.deltaDollars}); theta $/day ${postTradeTotals.thetaDollarsPerDay} (was $${report.totals.thetaDollarsPerDay}); vega $/vol-pt ${postTradeTotals.vegaDollarsPerVolPoint} (was $${report.totals.vegaDollarsPerVolPoint}).`,
      `Sizing: ${primary.sizing.rationale}`,
    );
    if (input.concentration?.candidateAssessment) {
      const a = input.concentration.candidateAssessment;
      evidence.push(`Concentration (#35): status ${a.status}; ${a.flags.length} flag(s)${a.flags.length ? `: ${a.flags.map((f) => f.message).join(" ")}` : "."}`);
    } else {
      limitations.push("No concentration/correlation assessment supplied for the primary candidate; correlation impact is unassessed, not assumed zero.");
    }
    verdict = decideOptimizerVerdict({
      primary: primaryView,
      decision,
      postTradeTotals,
      reportTotals: report.totals,
      breaches,
    });
  } else if (primary) {
    evidence.push(`Primary candidate scenario score ${primary.stats.score} at sized count ${primary.sizing.recommendedContracts}; no-trade scores 0 and wins.`);
  }

  /* Hedging plan: only on a stated breach (at the desired size, or the
   * book's own pre-trade totals, which desiredPostTotals embeds). */
  let hedging: RecommendationBundle["hedging"] = { status: "none_needed", options: [] };
  const hedgeNeeded = primary !== null && breaches.length > 0;
  if (hedgeNeeded && desiredPostTotals) {
    const postReport: PortfolioRiskReport = { ...report, totals: desiredPostTotals };
    const analysis = SPY_DELTA_HEDGE_POLICY.build(postReport, input.spyPut ?? null);
    if (analysis.status === "proposals") {
      const pre = Math.abs(analysis.preHedge.betaWeightedDeltaDollars ?? 0);
      const options: HedgeOption[] = analysis.proposals.map((p) => {
        const removed = round2(Math.max(0, pre - Math.abs(p.postHedgeBetaWeightedDeltaDollars)));
        return {
          instrument: p.instrument,
          label: `${p.side} ${p.quantity} ${p.symbol}${p.strike ? ` ${p.strike}P ${p.expirationDate}` : " shares"}`,
          estimatedCost: p.estimatedCost,
          riskRemovedDollars: removed,
          costPerDollarRiskRemoved: removed > 0 ? Number((Math.max(0, p.estimatedCost) / removed).toFixed(4)) : null,
          postHedgeBetaWeightedDeltaDollars: p.postHedgeBetaWeightedDeltaDollars,
          rationale: p.rationale,
        };
      }).sort((a, b) => (a.costPerDollarRiskRemoved ?? Infinity) - (b.costPerDollarRiskRemoved ?? Infinity));
      hedging = { status: "proposals", options };
    } else {
      hedging = { status: analysis.status, options: [], reason: analysis.reason };
      limitations.push(`Hedging plan ${analysis.status}: ${analysis.reason ?? "no trustworthy proposal from the available inputs."}`);
    }
  }

  /* Repair plan: RepairPolicy implementations over one proposal
   * contract (#1257) — the bundle consumes policies, not modules. */
  const repairs: RecommendationBundle["repairs"] = buildRepairOptions({
    repairAnalysis: input.repairAnalysis,
    compositionRepairs: input.compositionRepairs,
  });
  if (repairs.status === "none_supplied") {
    limitations.push("No repair analysis or composition repair candidates supplied; no repair plan is fabricated.");
  }

  /* Alternatives: other candidates, optimizer-ranked, + no-trade.
   * Copied out of the optimizer's shared constant so a caller mutating
   * a returned bundle can never mutate shared module state. */
  const alternatives: BundleAlternative[] = buildOptimizerAlternatives(rankedView, primaryView).map((a) => ({ ...a }));

  /* Status + confidence: the pick's caps are ceilings, never floors. */
  let status: RecommendationBundle["status"] =
    decision === "no_trade" ? "no_trade" : input.pickStatus === "recommended" ? "recommended" : "research_only";
  if (input.pickStatus === "no_trade") status = "no_trade";
  const capOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  let confidence: RecommendationBundle["confidence"] = input.pickConfidence ?? "MEDIUM";
  if (input.pickStatus !== "recommended" && capOrder[confidence] > capOrder.MEDIUM) confidence = "MEDIUM";
  if (qualification !== "Qualified" && capOrder[confidence] > capOrder.LOW) confidence = "LOW";
  if (decision === "no_trade") confidence = "LOW";

  const rationale: string[] = [];
  if (input.pickStatus === "research_only") {
    rationale.push("No user view was supplied; this bundle is the best-supported structure under the stated constraints, not a recommendation.");
  }
  if (primary && decision === "trade") {
    rationale.push(`${primary.input.candidate.label} is the primary: scenario score ${primary.stats.score}, sized to ${primary.sizing.recommendedContracts} contract(s) (${primary.sizing.bindingConstraint}).`);
    rationale.push(`Optimizer verdict: ${verdict}. ${evidence[0]}`);
  } else {
    rationale.push("The optimizer recommends no trade: no candidate beat doing nothing under the portfolio budgets and scenario grid.");
  }
  if (falsification) rationale.push(`Falsification: ${falsification.invalidation}`);

  const premortem = primary
    ? buildPremortem({
        symbol: primary.input.candidate.symbol,
        structure: primary.input.candidate.label,
        hasShortLeg: primary.input.candidate.legs.some((l) => l.side === "SELL"),
        eventRisk: null,
        maxLoss: round2(primary.economics.maxLoss * 100),
      })
    : null;

  return {
    id: `bundle_${Date.now().toString(36)}_${(++bundleSeq).toString(36)}`,
    asOf,
    status,
    decision,
    qualification,
    qualificationReasons,
    confidence,
    trade: primary && decision === "trade"
      ? {
          candidateId: primary.input.candidate.id,
          label: primary.input.candidate.label,
          symbol: primary.input.candidate.symbol,
          economics: primary.economics,
          economicsStatus: primary.economicsStatus,
          maxLossDollarsPerContract: round2(primary.economics.maxLoss * 100),
          scenarioGrid: primary.grid,
          tradePlan: primary.input.candidate.legs.map((leg) => ({
            action: leg.side,
            quantity: leg.quantity,
            contract: leg.symbol,
            optionType: leg.optionType,
            strike: leg.strike,
            expiration: leg.expirationDate,
            limitPrice: leg.entryPrice,
          })),
        }
      : null,
    falsification,
    falsificationWarnings,
    premortem,
    sizing: primary ? primary.sizing : (evaluated[0]?.sizing ?? (null as unknown as SizingResult)),
    postTradeTotals,
    optimizer: {
      expectedPnl: primary?.stats.expectedPnl ?? 0,
      cvarPnl: primary?.stats.cvarPnl ?? 0,
      worstPnl: primary?.stats.worstPnl ?? 0,
      probabilityOfProfit: primary?.stats.probabilityOfProfit ?? 0,
      cellCount: primary?.grid.cells.length ?? 0,
      score: primary?.stats.score ?? 0,
      verdict,
      breaches,
      evidence,
    },
    concentration: input.concentration ?? null,
    hedging,
    repairs,
    alternatives,
    rationale,
    blockers,
    limitations,
    humanApprovalRequired: true,
    disclaimer: BUNDLE_DISCLAIMER,
  };
}

/* ------------------------------------------------------------------ */
/* Route body normalization (Phase 6)                                  */
/* ------------------------------------------------------------------ */

/** One candidate entry as accepted by POST /api/etrade/portfolio-risk/bundle. */
export interface BundleRouteCandidateBody {
  candidate: StrategyCandidate;
  beta?: number | null;
  riskScore?: number;
  requestedContracts?: number;
}

/**
 * Normalize a bundle-route body to the candidate list the builder
 * consumes (issue #1162: the route originally accepted a single
 * `candidate`; `candidates[]` is the multi-candidate form, with the
 * first entry as the primary the concentration assessment describes).
 * Validation is total and happens before any broker call: a body with
 * no candidate carrying a symbol and at least one leg is an explicit
 * error, never a silently empty bundle.
 */
export function normalizeBundleCandidates(body: {
  candidate?: StrategyCandidate;
  candidates?: BundleRouteCandidateBody[];
  beta?: number | null;
  riskScore?: number;
  requestedContracts?: number;
}): { ok: true; candidates: BundleCandidateInput[] } | { ok: false; error: string } {
  const raw: BundleRouteCandidateBody[] = Array.isArray(body.candidates)
    ? body.candidates
    : body.candidate
      ? [
          {
            candidate: body.candidate,
            beta: body.beta,
            riskScore: body.riskScore,
            requestedContracts: body.requestedContracts,
          },
        ]
      : [];
  if (raw.length === 0) {
    return {
      ok: false,
      error: "candidate with symbol and legs is required (or a non-empty candidates array)",
    };
  }
  const candidates: BundleCandidateInput[] = [];
  for (const [i, entry] of raw.entries()) {
    const candidate = entry?.candidate;
    if (
      !candidate?.symbol ||
      !Array.isArray(candidate.legs) ||
      candidate.legs.length === 0
    ) {
      return {
        ok: false,
        error: `candidates[${i}] must carry a candidate with symbol and legs`,
      };
    }
    candidates.push({
      candidate,
      beta: entry.beta ?? null,
      riskScore: entry.riskScore,
      requestedContracts: entry.requestedContracts,
    });
  }
  return { ok: true, candidates };
}

/* ------------------------------------------------------------------ */
/* Persistence + report seam                                           */
/* ------------------------------------------------------------------ */

/**
 * Persist a bundle summary as a paper outcome in the existing
 * mas_outcomes store (Phase 0) — no new table. Phase 5 owns tracking
 * the outcome to expiry; this records that the bundle was produced,
 * under its goal/scenario when they are known.
 */
export function persistRecommendationBundle(
  sql: any,
  bundle: RecommendationBundle,
  refs: { userLogin?: string; goalId?: string; scenarioId?: string },
): OutcomeRecord | null {
  return recordOutcome(sql, {
    userLogin: refs.userLogin,
    goalId: refs.goalId,
    scenarioId: refs.scenarioId,
    recommendationRef: bundle.id,
    kind: "paper",
    metrics: {
      decision: bundle.decision,
      status: bundle.status,
      qualification: bundle.qualification,
      confidence: bundle.confidence,
      candidateId: bundle.trade?.candidateId ?? null,
      verdict: bundle.optimizer.verdict,
      score: bundle.optimizer.score,
      expectedPnl: bundle.optimizer.expectedPnl,
      cvarPnl: bundle.optimizer.cvarPnl,
      breaches: bundle.optimizer.breaches,
      hedgingStatus: bundle.hedging.status,
      repairOptions: bundle.repairs.options.length,
      asOf: bundle.asOf,
    },
  });
}

/**
 * Deterministic plain-text rendering of a bundle for the report seam
 * (mas_reports #308 stored reports embed this summary; the PDF/XLSX
 * generators consume report summaries, they are not forked here).
 */
/**
 * Consolidation C5 (#1361): the bundle's canonical mas_reports row,
 * built for the shared storeReportStage seam. The row carries the
 * full bundle as its body and the plain-text bundle summary (which
 * the module header already documents as the summary mas_reports rows
 * embed) as its summary; the bundle id is both run id and generation
 * id, so re-storing the same bundle dedupes instead of duplicating.
 * Served in Reports under source "bundle" (kind "report" fallthrough).
 */
export function buildBundleCanonicalReportInput(
  bundle: RecommendationBundle,
  primarySymbol: string,
  userLogin: string,
): import("./unifiedReportPipeline").CanonicalReportInput {
  return {
    runId: bundle.id,
    generationId: bundle.id,
    title: `Recommendation Bundle — ${primarySymbol} (${bundle.decision}, ${bundle.qualification})`,
    source: "bundle",
    summary: formatRecommendationBundleReport(bundle),
    body: bundle,
    createdAt: bundle.asOf,
    userLogin,
  };
}

/**
 * Consolidation C5 (#1361): one-line canonical persistence for the
 * bundle route — the shared store seam over the canonical input
 * above. The store stage never throws; a null result (no ORM, or a
 * storage failure) is the caller's to report verbatim. Kept here
 * (not in the route) so the route file stays under the #359 50 KB
 * target pinned by tests/etrade_routes_resplit_995.test.ts.
 */
export async function persistBundleReport(
  orm: Parameters<typeof storeReportStage>[0],
  bundle: RecommendationBundle,
  primarySymbol: string,
  userLogin: string,
): Promise<{ reportId: string; created: boolean } | null> {
  return storeReportStage(orm, buildBundleCanonicalReportInput(bundle, primarySymbol, userLogin));
}

export function formatRecommendationBundleReport(bundle: RecommendationBundle): string {
  const lines: string[] = [
    `Recommendation Bundle — ${bundle.trade?.label ?? "No trade"} (${bundle.id})`,
    `Decision: ${bundle.decision} · Status: ${bundle.status} · Qualification: ${bundle.qualification} · Confidence: ${bundle.confidence}`,
    `Optimizer verdict: ${bundle.optimizer.verdict} (score ${bundle.optimizer.score}; expected P/L $${bundle.optimizer.expectedPnl}; CVaR-25 $${bundle.optimizer.cvarPnl}; P(profit) ${(bundle.optimizer.probabilityOfProfit * 100).toFixed(0)}% over ${bundle.optimizer.cellCount} scenario cells)`,
    ...bundle.optimizer.evidence.map((e) => `- ${e}`),
    ...bundle.optimizer.breaches.map((b) => `- BREACH: ${b}`),
    `Hedging: ${bundle.hedging.status}${bundle.hedging.options.length ? ` — top: ${bundle.hedging.options[0].label} (cost $${bundle.hedging.options[0].estimatedCost}, removes $${bundle.hedging.options[0].riskRemovedDollars} beta-weighted delta)` : ""}`,
    `Repairs: ${bundle.repairs.status}${bundle.repairs.options.length ? ` — top: ${bundle.repairs.options[0].label}` : ""}`,
    `Alternatives: ${bundle.alternatives.map((a) => `${a.label} (score ${a.score})`).join("; ")}`,
    bundle.falsification ? `Invalidation: ${bundle.falsification.invalidation}` : "Falsification: none supplied — bundle is Unqualified.",
    ...bundle.limitations.map((l) => `Limitation: ${l}`),
    "Human approval required. " + bundle.disclaimer,
  ];
  return lines.join("\n");
}
