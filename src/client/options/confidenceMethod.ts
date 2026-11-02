/**
 * Confidence method breakdown (Qunsultant/cfagent#1773, item 5;
 * Microsoft HAX #9 uncertainty).
 *
 * A best-trade HIGH/MEDIUM/LOW rating must travel with the method
 * that produced it, not as a single unexplained number. This module
 * restates the RecommendationAgent rule verbatim
 * (src/trading/options/recommendationAgent.ts):
 *
 * - LOW when quote data is not FRESH or any blocker exists;
 * - otherwise HIGH when the composite margin over the runner-up is
 *   >= 5, liquidity >= 60, and model-implied POP >= 35%;
 * - otherwise MEDIUM.
 *
 * The no-view picker (pickBestNoViewTrade) caps at MEDIUM by
 * construction: HIGH is unreachable without a user view, however
 * clean the data. When there is no runner-up, the margin is the best
 * composite itself (the server's rule); when there is no best
 * candidate at all, the rating is LOW by construction and no input
 * is invented — the rows say "No candidate".
 *
 * The module recomputes the rating from the same inputs and reports
 * it beside the displayed rating, so a UI that passes the wrong
 * rating for its inputs fails its own test instead of silently
 * displaying a contradiction.
 */

export interface ConfidenceMethodCandidate {
  dataFreshness: string;
  liquidityScore: number;
  modelImpliedProbabilityOfProfit: number;
}

export interface ConfidenceMethodInput {
  confidence: "HIGH" | "MEDIUM" | "LOW";
  best?: {
    candidate: ConfidenceMethodCandidate;
    compositeScore: number;
  } | null;
  alternatives?: Array<{ compositeScore: number }>;
  blockers: string[];
  /** True for no-view picks, whose HIGH tier is unreachable by construction. */
  capHigh?: boolean;
}

export interface ConfidenceMethodRow {
  label: string;
  value: string;
  verdict: "pass" | "fail" | "info";
}

export function recomputeConfidence(input: ConfidenceMethodInput): "HIGH" | "MEDIUM" | "LOW" {
  const candidate = input.best?.candidate;
  if (!candidate) return "LOW";
  if (candidate.dataFreshness !== "FRESH" || input.blockers.length > 0) return "LOW";
  if (input.capHigh) return "MEDIUM";
  const runnerUp = (input.alternatives ?? []).find(
    (alt) => alt && Number.isFinite(alt.compositeScore),
  );
  const margin = runnerUp
    ? input.best!.compositeScore - runnerUp.compositeScore
    : input.best!.compositeScore;
  if (
    margin >= 5 &&
    candidate.liquidityScore >= 60 &&
    candidate.modelImpliedProbabilityOfProfit >= 0.35
  ) {
    return "HIGH";
  }
  return "MEDIUM";
}

export function confidenceMethodRows(input: ConfidenceMethodInput): ConfidenceMethodRow[] {
  const candidate = input.best?.candidate;
  const recomputed = recomputeConfidence(input);
  const runnerUp = (input.alternatives ?? []).find(
    (alt) => alt && Number.isFinite(alt.compositeScore),
  );
  const margin = candidate
    ? runnerUp
      ? input.best!.compositeScore - runnerUp.compositeScore
      : input.best!.compositeScore
    : null;

  const rows: ConfidenceMethodRow[] = [
    {
      label: "Rating",
      value: `${input.confidence} (method recomputation: ${recomputed})`,
      verdict: recomputed === input.confidence ? "pass" : "fail",
    },
    {
      label: "Quote freshness",
      value: candidate ? candidate.dataFreshness : "No candidate",
      verdict: candidate ? (candidate.dataFreshness === "FRESH" ? "pass" : "fail") : "info",
    },
    {
      label: "Blockers",
      value: input.blockers.length > 0 ? input.blockers.join("; ") : "None",
      verdict: input.blockers.length > 0 ? "fail" : "pass",
    },
    {
      label: "Margin over runner-up",
      value:
        margin === null
          ? "No candidate"
          : runnerUp
            ? `${margin.toFixed(1)} points (best ${input.best!.compositeScore.toFixed(1)} vs runner-up ${runnerUp.compositeScore.toFixed(1)}; HIGH needs ≥ 5)`
            : `${margin.toFixed(1)} points (no runner-up — margin is the best composite itself; HIGH needs ≥ 5)`,
      verdict: margin === null ? "info" : margin >= 5 ? "pass" : "fail",
    },
    {
      label: "Liquidity",
      value: candidate
        ? `${candidate.liquidityScore}/100 (HIGH needs ≥ 60)`
        : "No candidate",
      verdict: candidate ? (candidate.liquidityScore >= 60 ? "pass" : "fail") : "info",
    },
    {
      label: "Model-implied probability of profit",
      value: candidate
        ? `${(candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% (HIGH needs ≥ 35%)`
        : "No candidate",
      verdict: candidate
        ? candidate.modelImpliedProbabilityOfProfit >= 0.35
          ? "pass"
          : "fail"
        : "info",
    },
  ];

  if (input.capHigh) {
    rows.push({
      label: "HIGH tier",
      value: "HIGH unreachable without a user view — this no-view pick caps at MEDIUM by construction.",
      verdict: "info",
    });
  }

  rows.push({
    label: "Method",
    value:
      "LOW when quote data is not FRESH or any blocker exists; otherwise HIGH when margin ≥ 5, liquidity ≥ 60, and POP ≥ 35%; otherwise MEDIUM.",
    verdict: "info",
  });

  return rows;
}
