import type { NoViewStrategyCandidate, NoViewStrategyRequest, StrategyCandidate, StrategyRequest } from "../strategyEngine";
import type { RankedStrategy } from "../recommendationAgent";
import type { ScanMatrixCellBest } from "../opportunityScanner";
import type { AcceptanceRule, EvaluationObserver, EvaluationStatus, StrategyDefinition, StrategyEvaluation } from "./types";
import { PMCC_ACCEPTANCE_RULES } from "./pmccGates";

/** Chain of responsibility: the first rule that returns a reason rejects the candidate. */
export const DEFAULT_ACCEPTANCE_RULES: AcceptanceRule[] = [
  {
    id: "max-planned-loss",
    evaluate: (candidate, request) => candidate.maxLoss > request.maxPlannedLoss ? `${candidate.label} exceeds the max planned loss` : null,
  },
  {
    id: "profitable-at-target",
    evaluate: (candidate) => candidate.targetPnl <= 0 ? `${candidate.label} is not profitable at the stated target under the selected assumptions` : null,
  },
  {
    id: "min-reward-risk",
    evaluate: (candidate, request) => candidate.targetRewardRisk < request.minRewardRisk ? `${candidate.label} is below the minimum target reward/risk` : null,
  },
  // Issue #1769: PMCC gates (screener-rules.md §1.3) — friction <= 3.0,
  // breach distance (>= 8% above spot or >= LEAPS breakeven), and
  // 30-day premium yield >= 4.0%. PMCC-only: every rule passes other
  // strategy types through with null, so non-PMCC acceptance is
  // unchanged. Enforced here because the engine already runs
  // DEFAULT_ACCEPTANCE_RULES on every generated candidate.
  ...PMCC_ACCEPTANCE_RULES,
];

export function runAcceptanceRules(candidate: StrategyCandidate, request: StrategyRequest, rules: AcceptanceRule[] = DEFAULT_ACCEPTANCE_RULES): string | null {
  for (const rule of rules) {
    const reason = rule.evaluate(candidate, request);
    if (reason) return reason;
  }
  return null;
}

/** Chain-of-responsibility link for the no-view mode (issue #534). */
export interface NoViewAcceptanceRule {
  id: string;
  evaluate(candidate: NoViewStrategyCandidate, request: NoViewStrategyRequest): string | null;
}

/**
 * The no-view acceptance rules (issue #534): two of the viewed rules are
 * defined by a target and cannot run when no target exists, so they are
 * REPLACED openly — never approximated with a fabricated target:
 * profitable-at-target becomes a structure-payoff test, min-reward-risk
 * is measured on structure-defined quantities, and a POP floor keeps a
 * top rank from being best-of-garbage. Max planned loss is a pure
 * constraint and carries over unchanged.
 */
export const NO_VIEW_ACCEPTANCE_RULES: NoViewAcceptanceRule[] = [
  {
    id: "max-planned-loss",
    evaluate: (candidate, request) => candidate.maxLoss > request.maxPlannedLoss ? `${candidate.label} exceeds the max planned loss` : null,
  },
  {
    id: "positive-structure-payoff",
    evaluate: (candidate) => !candidate.maxProfitUnbounded && (candidate.maxProfit ?? 0) <= 0 ? `${candidate.label} has no positive modeled payoff after fees` : null,
  },
  {
    id: "min-structure-reward-risk",
    evaluate: (candidate, request) => candidate.structureRewardRisk !== null && candidate.structureRewardRisk < request.minRewardRisk ? `${candidate.label} is below the minimum structure reward/risk` : null,
  },
  {
    id: "min-pop",
    // The 0.35 backstop mirrors NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT
    // in strategyEngine.ts — a literal here, because the engine imports
    // this module (a value import back would close a runtime cycle).
    // The engine resolves the default before rules run, so the backstop
    // only fires for direct rule calls.
    evaluate: (candidate, request) => candidate.modelImpliedProbabilityOfProfit < (request.minProbabilityOfProfit ?? 0.35) ? `${candidate.label} is below the minimum probability of profit` : null,
  },
];

export function runNoViewAcceptanceRules(candidate: NoViewStrategyCandidate, request: NoViewStrategyRequest, rules: NoViewAcceptanceRule[] = NO_VIEW_ACCEPTANCE_RULES): string | null {
  for (const rule of rules) {
    const reason = rule.evaluate(candidate, request);
    if (reason) return reason;
  }
  return null;
}

interface Tally {
  def: StrategyDefinition;
  skipped?: string;
  generated: number;
  accepted: number;
  bestScore: number;
  truncated: number;
  noGeneration?: string;
  reasons: Map<string, number>;
}

/** Observer that turns engine events into the per-strategy evaluation ledger. */
export class EvaluationLedger implements EvaluationObserver {
  private readonly tallies = new Map<string, Tally>();

  constructor(registryDefs: StrategyDefinition[]) {
    for (const def of registryDefs) this.tallies.set(def.id, { def, generated: 0, accepted: 0, bestScore: 0, truncated: 0, reasons: new Map() });
  }

  onSkipped(def: StrategyDefinition, reason: string): void {
    this.tallies.get(def.id)!.skipped = reason;
  }

  onGenerated(def: StrategyDefinition, count: number, truncated: number, skipReason?: string): void {
    const tally = this.tallies.get(def.id)!;
    tally.generated += count;
    tally.truncated += truncated;
    if (count === 0 && skipReason) tally.noGeneration = skipReason;
  }

  onRejected(def: StrategyDefinition, reason: string): void {
    const tally = this.tallies.get(def.id)!;
    tally.reasons.set(reason, (tally.reasons.get(reason) || 0) + 1);
  }

  onAccepted(def: StrategyDefinition, candidate: Pick<StrategyCandidate, "score">): void {
    const tally = this.tallies.get(def.id)!;
    tally.accepted++;
    tally.bestScore = Math.max(tally.bestScore, candidate.score);
  }

  report(): StrategyEvaluation[] {
    return Array.from(this.tallies.values()).map((tally) => {
      const reasons = Array.from(tally.reasons, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
      let status: EvaluationStatus;
      let summary: string;
      if (tally.skipped) {
        status = "skipped";
        summary = tally.skipped;
      } else if (tally.accepted > 0) {
        status = "accepted";
        summary = `Accepted: ${tally.accepted} of ${tally.generated} candidate(s) passed every rule (best score ${tally.bestScore.toFixed(1)})${tally.truncated ? `; ${tally.truncated} further combinations not evaluated (per-strategy cap)` : ""}.`;
      } else {
        status = "rejected";
        if (tally.generated === 0) {
          summary = `Rejected: ${tally.noGeneration ?? "no candidate could be generated from the loaded chain"}.`;
        } else {
          const top = reasons[0];
          summary = `Rejected: all ${tally.generated} candidate(s) failed. Main reason (${top.count}x): ${top.reason}.`;
        }
      }
      return {
        id: tally.def.id,
        label: tally.def.label,
        category: tally.def.category,
        status,
        generated: tally.generated,
        accepted: tally.accepted,
        summary,
        reasons,
      };
    });
  }
}

/** One strategy type's roll-up for a single-name run (issue #26): the
 *  per-type winner plus the type's evaluation-ledger stats, so "best
 *  iron condor on AAPL" is answerable next to the overall best trade.
 *  `strategyType` is the strategy definition id — in this codebase a
 *  candidate's `type` IS its definition id (buildStrategyLedgerRows
 *  keys best scores the same way); `category` is the coarser family.
 *  "passed" here counts candidates that passed the ACCEPTANCE RULES
 *  (the evaluation ledger's accepted counts). The scan roll-up
 *  (ScanTypeRollup in opportunityScanner.ts) counts risk-screen passes
 *  instead — each surface keeps its own pipeline's meaning. */
export interface StrategyTypeRollup {
  strategyType: string;
  label: string;
  category: StrategyEvaluation["category"];
  /** Candidates the engine generated for this type (ledger). */
  evaluatedCount: number;
  /** Generated candidates that passed the acceptance rules (ledger). */
  passedCount: number;
  rejectedCount: number;
  /** The ledger's rejection reasons for this type as a histogram —
   *  build failures and acceptance-rule rejections, as recorded. */
  rejectionReasons: Record<string, number>;
  /** The highest-composite RANKED candidate of this type, flattened to
   *  the ScanMatrixCellBest shape; null when no candidate of the type
   *  reached the ranking — including types that passed acceptance but
   *  were all screened out before ranking (passedCount > 0, best null
   *  is honest: acceptance and ranking are different gates). */
  best: ScanMatrixCellBest | null;
  bestComposite: number | null;
}

/** Flatten a ranked candidate to the ScanMatrixCellBest shape — the
 *  same projection buildMatrixCells applies on the scan side, so a
 *  per-type best reads identically on both surfaces. */
function flattenRankedBest(entry: RankedStrategy): ScanMatrixCellBest {
  const c = entry.candidate;
  return {
    candidateId: c.id,
    label: c.label,
    compositeScore: entry.compositeScore,
    score: c.score,
    expirationDate: c.expirationDate,
    legs: c.legs,
    netDebit: c.netDebit,
    maxLoss: c.maxLoss,
    maxProfit: c.maxProfit,
    maxProfitUnbounded: c.maxProfitUnbounded,
    targetRewardRisk: c.targetRewardRisk,
    probabilityOfProfit: c.modelImpliedProbabilityOfProfit,
  };
}

/**
 * Build the per-strategy-type roll-up for a single-name run (issue
 * #26) from the evaluation ledger and the ranked candidates. Pure and
 * exported for direct unit testing. Counts come from the ledger alone,
 * so they reconcile with it exactly: Σ evaluatedCount = Σ generated
 * and Σ passedCount = Σ accepted over the input evaluations. Ordering
 * follows the matrix-cell discipline: best composite descending,
 * best-less types last, strategy type ascending on ties.
 */
export function buildTypeRollup(
  evaluations: StrategyEvaluation[],
  ranked: RankedStrategy[],
): StrategyTypeRollup[] {
  const bestByType = new Map<string, RankedStrategy>();
  for (const entry of ranked) {
    const current = bestByType.get(entry.candidate.type);
    if (!current || entry.compositeScore > current.compositeScore) {
      bestByType.set(entry.candidate.type, entry);
    }
  }
  const entries = evaluations.map((e): StrategyTypeRollup => {
    const rejectionReasons: Record<string, number> = {};
    for (const r of e.reasons) rejectionReasons[r.reason] = (rejectionReasons[r.reason] ?? 0) + r.count;
    const top = bestByType.get(e.id);
    return {
      strategyType: e.id,
      label: e.label,
      category: e.category,
      evaluatedCount: e.generated,
      passedCount: e.accepted,
      rejectedCount: e.generated - e.accepted,
      rejectionReasons,
      best: top ? flattenRankedBest(top) : null,
      bestComposite: top ? top.compositeScore : null,
    };
  });
  return entries.sort((a, b) => {
    if (a.bestComposite !== null && b.bestComposite !== null && a.bestComposite !== b.bestComposite) {
      return b.bestComposite - a.bestComposite;
    }
    if (a.bestComposite !== null && b.bestComposite === null) return -1;
    if (a.bestComposite === null && b.bestComposite !== null) return 1;
    return a.strategyType.localeCompare(b.strategyType);
  });
}
