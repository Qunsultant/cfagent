/**
 * Issue #2943: portfolio-risk handler tails moved out of
 * src/agents/routes/etradeBroker.ts (the #995 re-split pattern).
 *
 * etradeBroker.ts is the dispatcher: every route condition, prologue
 * (validation, auth, ETradeService construction) and error message
 * stays there, so the route-condition inventory and the
 * ETradeService construction ledger in
 * tests/etrade_routes_resplit_995.test.ts are unchanged. Only the
 * computation tails moved here, and they construct no ETradeService
 * — they receive the already-constructed instance from the dispatcher.
 *
 * Owns the four portfolio-risk routes (issue #34/#35/#36):
 * - GET  /etrade/portfolio-risk             aggregate risk report
 * - POST /etrade/portfolio-risk/evaluate    post-trade totals
 * - POST /etrade/portfolio-risk/correlation concentration assessment
 * - POST /etrade/portfolio-risk/size        position sizing
 * The bundle leg (/etrade/portfolio-risk/bundle) is NOT here; it
 * already lives in ./etradeBrokerBundle.
 * Also here: the positions envelope tail (GET /etrade/positions),
 * the portfolio snapshot the risk tails read — moved so the
 * dispatcher falls back under the #359 50 KB target.
 */

import {
  computePortfolioRisk,
  aggregatePortfolioRisk,
  resolvePositionsSnapshot,
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
} from "../../services/portfolioRisk";
import { assessPortfolioConcentration } from "../../services/portfolioConcentration";
import { sharedCorrelationService } from "../../services/correlationService";
import {
  sizeCandidateAgainstPortfolio,
  type SizingCandidate,
} from "../../services/positionSizing";
import type { ETradeService } from "../../services/etrade";
import { codedBrokerMessage } from "./brokerCodedError";

/** Aggregate risk report for the live book (issue #34, gap G1). */
export async function getPortfolioRiskReport(etrade: ETradeService) {
  return computePortfolioRisk(etrade);
}

/** Post-trade evaluation (issue #34): current totals plus a candidate's Greek contribution. */
export async function evaluatePostTradeTotalsForCandidate(
  etrade: ETradeService,
  candidate: CandidateGreekContribution,
) {
  const { account, positions } = await etrade.fetchPortfolioRemote(undefined, true);
  const resolved = await resolvePositionsSnapshot(etrade, positions);
  const spyChain = await etrade.getOptionChains({ symbol: "SPY" }).catch(() => null);
  const report = aggregatePortfolioRisk(resolved, {
    nav: account.netAccountValue || account.totalAccountValue || 0,
    spyPrice: spyChain?.underlyingPrice ?? null,
    asOf: new Date().toISOString(),
  });
  return { current: report, postTradeTotals: evaluatePostTradeTotals(report, candidate) };
}

/** Correlation & concentration assessment (issue #35, gap G2). */
export async function assessPortfolioConcentrationForCandidate(
  etrade: ETradeService,
  candidateSymbol: string | undefined,
) {
  const report = await computePortfolioRisk(etrade);
  return assessPortfolioConcentration(
    report,
    (a, b) => sharedCorrelationService.estimate(a, b),
    candidateSymbol,
  );
}

/** Portfolio-aware position sizing (issue #36, gap G3). */
export async function sizeCandidateForPortfolio(
  etrade: ETradeService,
  candidate: SizingCandidate,
) {
  const report = await computePortfolioRisk(etrade);
  return sizeCandidateAgainstPortfolio(report, candidate);
}

/**
 * Positions envelope (issue #2573): the portfolio error field is
 * user-facing (ETradeTradingHub renders it as the OAuth message), so
 * it carries the coded message, never the raw lastError string.
 * The 200 envelope shape is unchanged.
 */
export async function getPositionsWithCodedError(etrade: ETradeService) {
  const holdings = await etrade.fetchPortfolioRemote(undefined, true);
  const codedError =
    holdings.account.accountId === "unconnected"
      ? codedBrokerMessage(etrade, "positions")
      : null;
  return {
    ...holdings,
    error: codedError ?? undefined,
  };
}
