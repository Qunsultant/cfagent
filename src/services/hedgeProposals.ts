/**
 * Hedge proposals (issue #54, child of epic #32).
 *
 * Generates DRAFT hedging proposals from the G1 portfolio aggregates
 * (#34): given the book's SPY beta-weighted Delta, size an offsetting
 * hedge that brings the residual within a stated tolerance of NAV.
 *
 * Hard rules from the issue:
 *  - DRAFTS ONLY. A proposal is data for the existing HITL order-preview
 *    flow; nothing here places, previews, or submits an order.
 *  - Deterministic given the snapshot: same report + same chain contract
 *    in, same proposals out.
 *  - Symbols missing beta/chain data are NAMED (from the report's
 *    partial list), never silently zeroed — if beta-weighted Delta is
 *    unavailable, no proposal is produced and the reason says why.
 *  - Pre- and post-hedge beta-weighted Delta are always stated.
 */

import type { ETradeOptionChain } from "../types";
import type { ETradeService } from "./etrade";
import {
  computePortfolioRisk,
  evaluatePostTradeTotals,
  type PortfolioRiskReport,
  type PortfolioRiskTotals,
  etradePortfolioRiskSource,
} from "./portfolioRisk";

export const HEDGE_POLICY = {
  /** Residual |beta-weighted delta| tolerated after hedging, % of NAV. */
  residualTolerancePctOfNav: 1,
  /** Target DTE for the index-put hedge leg. */
  targetDteDays: 30,
} as const;

export type HedgeInstrument = "SPY_SHARES" | "SPY_PUTS";

export interface ExecutableOrderLegSpec {
  underlyingSymbol: string;
  securityType: "EQ" | "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface ExecutableOrderSpec {
  assetClass: "equity" | "options";
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderType: "MARKET" | "LIMIT";
  quantity: number;
  limitPrice: number;
  strategyNetDebit?: number;
  legs: ExecutableOrderLegSpec[];
  estimatedTotal: number;
  isExecutable: boolean;
}

export interface HedgeProposal {
  instrument: HedgeInstrument;
  status: "DRAFT";
  side: "BUY" | "SELL";
  symbol: "SPY";
  quantity: number;
  /** Strike/expiry for the options form. */
  strike?: number;
  expirationDate?: string;
  /** Estimated cash cost of the hedge (positive = cash out). */
  estimatedCost: number;
  preHedgeBetaWeightedDeltaDollars: number;
  postHedgeBetaWeightedDeltaDollars: number;
  withinToleranceAfterHedge: boolean;
  rationale: string;
  executableOrder?: ExecutableOrderSpec;
}

export interface HedgeAnalysis {
  asOf: string;
  /** "hedged" proposals produced; "within-tolerance" none needed;
   *  "unavailable" the inputs do not support a trustworthy proposal. */
  status: "proposals" | "within-tolerance" | "unavailable";
  reason?: string;
  /** Symbols whose beta is missing — the hedge is sized on the covered
   *  portion only, and these names are stated, never zeroed. */
  symbolsMissingBeta: string[];
  preHedge: PortfolioRiskTotals;
  proposals: HedgeProposal[];
  toleranceDollars: number;
}

export interface SpyPutContract {
  strike: number;
  expirationDate: string;
  delta: number;
  price: number;
  bid?: number;
  ask?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * HedgePolicy — the kernel's sole hedge policy (issue #1361, epic
 * #1151 slice C5; #1257 family rationalization). hedgeProposals was
 * already the family's one clean engine; re-homing it as a policy
 * changes no behavior and no HEDGE_POLICY constant — it gives the
 * bundle (and the kernel) a policy to consume instead of a module
 * to call. The builder below stays the single implementation.
 */
export interface HedgePolicy {
  build(report: PortfolioRiskReport, spyPut: SpyPutContract | null): HedgeAnalysis;
}

/** SpyDeltaHedge: beta-weighted-Δ SPY hedge sizing (#54). */
export const SPY_DELTA_HEDGE_POLICY: HedgePolicy = {
  build(report: PortfolioRiskReport, spyPut: SpyPutContract | null): HedgeAnalysis {
    return buildHedgeProposals(report, spyPut);
  },
};

/**
 * Pure proposal builder. `spyPut` is the selected live SPY put contract
 * (nearest strike to spot at the target expiry) or null when no live
 * chain contract is available — in which case only the share hedge is
 * proposed and the options form is omitted, never fabricated.
 */
export function buildHedgeProposals(
  report: PortfolioRiskReport,
  spyPut: SpyPutContract | null,
): HedgeAnalysis {
  const totals = report.totals;
  const symbolsMissingBeta = [...new Set(report.partial.map((p) => p.symbol))];
  const toleranceDollars = (HEDGE_POLICY.residualTolerancePctOfNav / 100) * report.nav;
  const base: Omit<HedgeAnalysis, "status" | "proposals"> = {
    asOf: report.asOf,
    symbolsMissingBeta,
    preHedge: totals,
    toleranceDollars: round2(toleranceDollars),
  };

  const betaDelta = totals.betaWeightedDeltaDollars;
  if (betaDelta === null || report.spyPrice === null || report.spyPrice <= 0) {
    return {
      ...base,
      status: "unavailable",
      reason:
        betaDelta === null
          ? `Beta-weighted Delta is unavailable (no covered positions${symbolsMissingBeta.length ? `; missing beta for: ${symbolsMissingBeta.join(", ")}` : ""}). No hedge can be sized on an unknown exposure.`
          : "SPY price is unavailable from the live chain; the hedge cannot be sized.",
      proposals: [],
    };
  }

  if (Math.abs(betaDelta) <= toleranceDollars) {
    return {
      ...base,
      status: "within-tolerance",
      reason: `|Beta-weighted Delta| $${Math.abs(betaDelta).toFixed(0)} is already within the ${HEDGE_POLICY.residualTolerancePctOfNav}% of NAV tolerance ($${toleranceDollars.toFixed(0)}).`,
      proposals: [],
    };
  }

  const proposals: HedgeProposal[] = [];
  const spyPrice = report.spyPrice;

  // --- Form 1: SPY shares (exact neutralization up to whole-share rounding)
  const sharesNeeded = betaDelta / spyPrice; // SPY-share equivalents (beta 1)
  const shareQty = Math.round(Math.abs(sharesNeeded));
  if (shareQty > 0) {
    const side: "BUY" | "SELL" = sharesNeeded > 0 ? "SELL" : "BUY";
    const signedShares = side === "SELL" ? -shareQty : shareQty;
    const post = evaluatePostTradeTotals(report, {
      deltaShares: signedShares,
      deltaDollars: signedShares * spyPrice,
      betaWeightedDeltaDollars: signedShares * spyPrice,
      gammaSharesPerDollar: 0,
      thetaDollarsPerDay: 0,
      vegaDollarsPerVolPoint: 0,
      rhoDollarsPerRatePoint: 0,
      definedMaxLoss: side === "BUY" ? shareQty * spyPrice : 0,
    });
    const shareLimitPrice = round2(spyPrice);
    proposals.push({
      instrument: "SPY_SHARES",
      status: "DRAFT",
      side,
      symbol: "SPY",
      quantity: shareQty,
      estimatedCost: side === "BUY" ? round2(shareQty * spyPrice) : -round2(shareQty * spyPrice),
      preHedgeBetaWeightedDeltaDollars: betaDelta,
      postHedgeBetaWeightedDeltaDollars: post.betaWeightedDeltaDollars ?? betaDelta,
      withinToleranceAfterHedge: Math.abs(post.betaWeightedDeltaDollars ?? betaDelta) <= toleranceDollars,
      rationale: `${side} ${shareQty} SPY @ ~$${spyPrice.toFixed(2)} neutralizes the book's beta-weighted Delta of $${betaDelta.toFixed(0)} (SPY beta = 1 by construction). Residual is whole-share rounding only.`,
      executableOrder: {
        assetClass: "equity",
        symbol: "SPY",
        action: side,
        orderType: "LIMIT",
        quantity: shareQty,
        limitPrice: shareLimitPrice,
        legs: [
          {
            underlyingSymbol: "SPY",
            securityType: "EQ",
            side,
            quantity: shareQty,
          },
        ],
        estimatedTotal: side === "BUY" ? round2(shareQty * shareLimitPrice) : -round2(shareQty * shareLimitPrice),
        isExecutable: true,
      },
    });
  }

  // --- Form 2: SPY puts (defined-risk alternative, when a live contract exists)
  if (spyPut && spyPut.delta < 0 && spyPrice > 0) {
    const hedgeDirection = betaDelta > 0 ? "BUY" : "SELL";
    const perContractBetaDelta = Math.abs(spyPut.delta) * 100 * spyPrice; // $ of beta-weighted delta per contract
    const contracts = Math.max(1, Math.round(Math.abs(betaDelta) / perContractBetaDelta));
    const signedContracts = hedgeDirection === "BUY" ? contracts : -contracts;
    const contribution = signedContracts * spyPut.delta * 100 * spyPrice;
    const post = evaluatePostTradeTotals(report, {
      deltaShares: 0,
      deltaDollars: contribution,
      betaWeightedDeltaDollars: contribution,
      gammaSharesPerDollar: 0,
      thetaDollarsPerDay: 0,
      vegaDollarsPerVolPoint: 0,
      rhoDollarsPerRatePoint: 0,
      definedMaxLoss: hedgeDirection === "BUY" ? contracts * spyPut.price * 100 : 0,
    });
    const putLimitPrice = round2(spyPut.price);
    proposals.push({
      instrument: "SPY_PUTS",
      status: "DRAFT",
      side: hedgeDirection,
      symbol: "SPY",
      quantity: contracts,
      strike: spyPut.strike,
      expirationDate: spyPut.expirationDate,
      estimatedCost: hedgeDirection === "BUY" ? round2(contracts * spyPut.price * 100) : -round2(contracts * spyPut.price * 100),
      preHedgeBetaWeightedDeltaDollars: betaDelta,
      postHedgeBetaWeightedDeltaDollars: post.betaWeightedDeltaDollars ?? betaDelta,
      withinToleranceAfterHedge: Math.abs(post.betaWeightedDeltaDollars ?? betaDelta) <= toleranceDollars,
      rationale: `${hedgeDirection} ${contracts} SPY ${spyPut.strike} puts exp ${spyPut.expirationDate} (live chain delta ${spyPut.delta}) offsets ~$${Math.abs(contribution).toFixed(0)} of beta-weighted Delta with defined risk${hedgeDirection === "BUY" ? ` (max loss = premium $${(contracts * spyPut.price * 100).toFixed(0)})` : ""}. Coarser than shares: contract rounding leaves a larger residual.`,
      executableOrder: {
        assetClass: "options",
        symbol: "SPY",
        action: hedgeDirection,
        orderType: "LIMIT",
        quantity: contracts,
        limitPrice: putLimitPrice,
        strategyNetDebit: hedgeDirection === "BUY" ? round2(putLimitPrice * 100) : -round2(putLimitPrice * 100),
        legs: [
          {
            underlyingSymbol: "SPY",
            securityType: "OPTN",
            side: hedgeDirection,
            quantity: 1,
            optionType: "PUT",
            strike: spyPut.strike,
            expirationDate: spyPut.expirationDate,
          },
        ],
        estimatedTotal: hedgeDirection === "BUY" ? round2(contracts * putLimitPrice * 100) : -round2(contracts * putLimitPrice * 100),
        isExecutable: true,
      },
    });
  }

  return { ...base, status: "proposals", proposals };
}

/** Picks the SPY put nearest the money from a live chain snapshot. */
export function selectSpyPut(chain: ETradeOptionChain, expirationDate: string): SpyPutContract | null {
  let best: SpyPutContract | null = null;
  for (const pair of chain.pairs) {
    const put = pair.put;
    if (!put || put.delta === undefined || !(put.delta < 0)) continue;
    const price = put.bid > 0 && put.ask > 0 ? (put.bid + put.ask) / 2 : (put.lastPrice > 0 ? put.lastPrice : 0);
    if (!(price > 0)) continue;
    if (!best || Math.abs(put.strikePrice - chain.underlyingPrice) < Math.abs(best.strike - chain.underlyingPrice)) {
      best = {
        strike: put.strikePrice,
        expirationDate,
        delta: put.delta,
        price,
        bid: put.bid > 0 ? put.bid : undefined,
        ask: put.ask > 0 ? put.ask : undefined,
      };
    }
  }
  return best;
}

/**
 * Full pipeline for the endpoint: aggregate the book (#34), fetch the
 * live SPY chain at the target expiry for the puts form, build drafts.
 */
export async function generateHedgeProposals(etrade: ETradeService): Promise<HedgeAnalysis> {
  const report = await computePortfolioRisk(etradePortfolioRiskSource(etrade));
  const spyPut = await resolveSpyPutContract(etrade);
  return buildHedgeProposals(report, spyPut);
}

/**
 * Resolve the live SPY put contract for the options form of a hedge
 * (extracted from generateHedgeProposals so the Phase 4 recommendation
 * bundle route reuses the same expiry/chain resolution — one owner).
 * Null when no live chain contract is available; callers must omit the
 * options form rather than fabricate one.
 */
export async function resolveSpyPutContract(etrade: ETradeService): Promise<SpyPutContract | null> {
  let spyPut: SpyPutContract | null = null;

  // Real market expiration date resolution:
  let selectedExpiry: { year: number; month: number; day: number; dateStr: string } | null = null;
  try {
    const expireDates = await etrade.getOptionExpireDates("SPY");
    if (expireDates && expireDates.length > 0) {
      const targetDays = HEDGE_POLICY.targetDteDays;
      const now = new Date();
      // Find valid expiry >= 7 days out closest to targetDteDays
      const scored = expireDates
        .map((exp) => {
          const expDate = new Date(Date.UTC(exp.year, exp.month - 1, exp.day, 20, 0, 0));
          const dte = Math.round((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          return { exp, dte, diff: Math.abs(dte - targetDays) };
        })
        .filter((item) => item.dte >= 7)
        .sort((a, b) => a.diff - b.diff);

      if (scored.length > 0) {
        const best = scored[0].exp;
        selectedExpiry = {
          year: best.year,
          month: best.month,
          day: best.day,
          dateStr: `${best.year}-${String(best.month).padStart(2, "0")}-${String(best.day).padStart(2, "0")}`,
        };
      }
    }
  } catch {
    // Graceful fallback if getOptionExpireDates fails
  }

  // Fallback to Friday-aligned target date if no expire dates returned
  if (!selectedExpiry) {
    const target = new Date(Date.now() + HEDGE_POLICY.targetDteDays * 24 * 3600 * 1000);
    const dayOfWeek = target.getUTCDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    target.setUTCDate(target.getUTCDate() + (daysUntilFriday === 0 ? 0 : daysUntilFriday));
    const yyyy = target.getUTCFullYear();
    const mm = target.getUTCMonth() + 1;
    const dd = target.getUTCDate();
    selectedExpiry = {
      year: yyyy,
      month: mm,
      day: dd,
      dateStr: `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    };
  }

  const chain = await etrade.getOptionChains({
    symbol: "SPY",
    expiryYear: selectedExpiry.year,
    expiryMonth: selectedExpiry.month,
    expiryDay: selectedExpiry.day,
    chainType: "PUT",
  }).catch(() => null);

  if (chain) spyPut = selectSpyPut(chain, selectedExpiry.dateStr);
  return spyPut;
}
