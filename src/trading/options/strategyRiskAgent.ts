/**
 * Capability 2 — Multi-leg Strategy / Risk Engine Agent and Strategy Screener
 *
 * Builds multi-leg structures (verticals, straddles, strangles, condors) from
 * screened contracts, computes max loss / breakevens / Greeks / scenarios, and
 * screens the resulting strategies against user-set risk limits. It does not
 * choose a winner; ranking belongs to the recommendation agent.
 */

import type { ScreenedOptionContractItem } from "../../types";
import {
  recommendNoViewStrategies,
  recommendOptionStrategies,
  type NoViewRecommendationResult,
  type NoViewStrategyRequest,
  type OptionStrategyType,
  type StrategyCandidate,
  type StrategyRecommendationResult,
  type StrategyRequest,
} from "./strategyEngine";
import {
  checkNoViewRequestFields,
  checkStrategyRequestFields,
  NO_VIEW_REQUEST_INVALID_MESSAGE,
  STRATEGY_REQUEST_INVALID_MESSAGE,
} from "../screeningSchemas";

export interface StrategyScreenFilter {
  strategyTypes?: OptionStrategyType[];
  minProbabilityOfProfit?: number; // 0-1
  maxNetDebit?: number;
  minNetCredit?: number;
  minTargetPnl?: number;
  minMaxProfit?: number;
  minRewardRisk?: number;
  maxProfitGreaterThanMaxLoss?: boolean;
  maxBreakevenDistancePct?: number;
  maxLegs?: number;
  requireFresh?: boolean;
}

export interface StrategyRiskReport {
  id: string;
  maxLoss: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  breakevens: number[];
  probabilityOfProfit: number;
  netGreeks: StrategyCandidate["netGreeks"];
  budgetUsedPct: number;
  withinBudget: boolean;
  worstScenario: { underlyingPrice: number; daysToExpiry: number; ivChangePct: number; pnl: number };
  bestScenario: { underlyingPrice: number; daysToExpiry: number; ivChangePct: number; pnl: number };
  isCredit: boolean;
}

/** Issue #959 (screening consolidation S1): the request-shape rules live
 *  in ONE definition site — src/trading/screeningSchemas.ts. These
 *  validators keep their historical contract (a single generic message,
 *  pinned by the discovery suites; non-request keys on the body are the
 *  caller's own envelope concern and are not this check's business) and
 *  delegate the field rules to the shared schemas. Raw entry-point
 *  bodies are validated strictly (unknown keys rejected, field named)
 *  by the schemas' parse functions at the routes themselves. */
export function validateStrategyRequest(body: Partial<StrategyRequest> | null | undefined): string | null {
  return checkStrategyRequestFields(body) === null ? null : STRATEGY_REQUEST_INVALID_MESSAGE;
}

export function validateNoViewRequest(body: (Partial<NoViewStrategyRequest> & Record<string, unknown>) | null | undefined): string | null {
  return checkNoViewRequestFields(body) === null ? null : NO_VIEW_REQUEST_INVALID_MESSAGE;
}

export class StrategyRiskAgent {
  readonly id = "strategy-risk-agent";
  readonly capability = "Multi-leg strategy builder, risk engine & strategy screener";

  /** Build every valid, risk-capped multi-leg candidate (unlimited, engine-scored). */
  buildStrategies(contracts: ScreenedOptionContractItem[], request: StrategyRequest): StrategyRecommendationResult {
    return recommendOptionStrategies(contracts, request);
  }

  /** Build every valid, risk-capped view-less candidate (issue #534):
   *  the no-view counterpart of buildStrategies — the same engine core
   *  under the target-free score model, with no view supplied, derived,
   *  or fabricated. */
  buildNoViewStrategies(contracts: ScreenedOptionContractItem[], request: NoViewStrategyRequest): NoViewRecommendationResult {
    return recommendNoViewStrategies(contracts, request);
  }

  /**
   * Issue #3000: the parameter is the shared candidate core, not the
   * viewed shape — the report reads only shared fields (id, maxLoss,
   * maxProfit, breakevens, POP, Greeks, scenarios, netDebit), so a
   * no-view candidate (which omits targetPnl/targetRewardRisk by
   * design) reports identically. Widening the type instead of
   * fabricating view fields on a view-less candidate.
   */
  riskReport(
    candidate: Omit<
      StrategyCandidate,
      "targetPnl" | "targetRewardRisk" | "scoreBreakdown"
    >,
    request: Pick<StrategyRequest, "maxPlannedLoss">,
  ): StrategyRiskReport {
    const byPnl = [...candidate.scenarios].sort((a, b) => a.pnl - b.pnl);
    const pick = (s?: StrategyCandidate["scenarios"][number]) =>
      s ?? { underlyingPrice: 0, daysToExpiry: 0, ivChangePct: 0, pnl: 0 };
    return {
      id: candidate.id,
      maxLoss: candidate.maxLoss,
      maxProfit: candidate.maxProfit,
      maxProfitUnbounded: candidate.maxProfitUnbounded,
      breakevens: candidate.breakevens,
      probabilityOfProfit: candidate.modelImpliedProbabilityOfProfit,
      netGreeks: candidate.netGreeks,
      budgetUsedPct: Number(((candidate.maxLoss / request.maxPlannedLoss) * 100).toFixed(1)),
      withinBudget: candidate.maxLoss <= request.maxPlannedLoss,
      worstScenario: pick(byPnl[0]),
      bestScenario: pick(byPnl[byPnl.length - 1]),
      isCredit: candidate.netDebit < 0,
    };
  }

  /** Strategy screener: filter built strategies by user-visible risk/return limits. */
  screenStrategies(candidates: StrategyCandidate[], filter: StrategyScreenFilter = {}): {
    matched: StrategyCandidate[];
    rejected: Array<{ id: string; reason: string }>;
  } {
    const matched: StrategyCandidate[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    const types = filter.strategyTypes?.length ? new Set(filter.strategyTypes) : undefined;
    for (const c of candidates) {
      const reason = this.rejectionReason(c, filter, types);
      if (reason) rejected.push({ id: c.id, reason });
      else matched.push(c);
    }
    return { matched, rejected };
  }

  private rejectionReason(c: StrategyCandidate, f: StrategyScreenFilter, types?: Set<OptionStrategyType>): string | null {
    if (types && !types.has(c.type)) return `${c.label} not in selected strategy types`;
    if (f.maxLegs !== undefined && c.legs.length > f.maxLegs) return `${c.legs.length} legs exceeds max ${f.maxLegs}`;
    if (f.requireFresh && c.dataFreshness !== "FRESH") return `Quote data is ${c.dataFreshness}`;
    if (f.minProbabilityOfProfit !== undefined && c.modelImpliedProbabilityOfProfit < f.minProbabilityOfProfit) {
      return `Probability of profit ${(c.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% below ${(f.minProbabilityOfProfit * 100).toFixed(1)}%`;
    }
    if (f.maxNetDebit !== undefined && c.netDebit > f.maxNetDebit) return `Net debit $${c.netDebit.toFixed(2)} exceeds $${f.maxNetDebit}`;
    if (f.minNetCredit !== undefined && -c.netDebit < f.minNetCredit) return `Net credit $${(-c.netDebit).toFixed(2)} below $${f.minNetCredit}`;
    if (f.minTargetPnl !== undefined && c.targetPnl < f.minTargetPnl) return `Target P/L $${c.targetPnl.toFixed(2)} below $${f.minTargetPnl}`;
    if (f.minMaxProfit !== undefined && !c.maxProfitUnbounded && (c.maxProfit ?? 0) < f.minMaxProfit) {
      return `Max profit $${(c.maxProfit ?? 0).toFixed(2)} below $${f.minMaxProfit}`;
    }
    if (f.maxBreakevenDistancePct !== undefined) {
      const spot = c.underlyingPrice;
      const far = c.breakevens.some((b) => spot > 0 && (Math.abs(b - spot) / spot) * 100 > f.maxBreakevenDistancePct!);
      if (far) return `Breakeven farther than ${f.maxBreakevenDistancePct}% from spot`;
    }
    if (f.minRewardRisk !== undefined) {
      const maxProfitRatio = c.maxLoss > 0 && c.maxProfit !== null ? c.maxProfit / c.maxLoss : c.maxProfitUnbounded ? Infinity : 0;
      const effectiveRatio = Math.max(c.targetRewardRisk, maxProfitRatio);
      if (effectiveRatio < f.minRewardRisk) {
        return `Target reward/risk ${c.targetRewardRisk.toFixed(2)}x (max profit ratio ${maxProfitRatio.toFixed(2)}x) below required minimum ${f.minRewardRisk.toFixed(2)}x`;
      }
    }
    if (f.maxProfitGreaterThanMaxLoss && !c.maxProfitUnbounded && (c.maxProfit ?? 0) <= c.maxLoss) {
      return `Max profit $${(c.maxProfit ?? 0).toFixed(2)} is not greater than max loss $${c.maxLoss.toFixed(2)}`;
    }
    return null;
  }
}
