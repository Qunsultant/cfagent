/**
 * Portfolio repair proposals (issue #355, sibling of the hedge proposals #54).
 *
 * For an underwater long-stock position, propose a zero-cost 1×2 call ratio
 * that lowers the effective breakeven without committing new capital:
 *   BUY 1 call at K1 (nearest listed strike to spot)
 *   SELL 2 calls at K2 (lowest listed strike satisfying the half-gap rule)
 *
 * Hard rules from the issue:
 *  - DRAFTS ONLY. A proposal is data for the existing HITL order-preview
 *    flow; nothing here places, previews, or submits an order.
 *  - Deterministic given the inputs: same position + same chain in, same
 *    proposals out.
 *  - Skipped symbols are NAMED, never silently dropped.
 *  - Honest reporting: every proposal states the capped upside, the absence
 *    of downside protection, and the max additional capital at risk.
 *  - No fabricated strikes: every leg comes from a listed chain contract.
 */

import type {
  ETradeOptionChain,
  ETradeOptionChainContract,
  ETradePosition,
} from "../types";
import type { ETradeService } from "./etrade";
import type { ExecutableOrderSpec } from "./hedgeProposals";
import {
  computePortfolioRisk,
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
  type PortfolioRiskReport,
  type PortfolioRiskTotals,
  etradePortfolioRiskSource,
} from "./portfolioRisk";

export const REPAIR_POLICY = {
  /** |netDebit| tolerated per unit, % of spot. Slight credit preferred. */
  repairCostTolerancePctOfSpot: 0.5,
  /** Minimum DTE for the repair expiry. */
  minDteDays: 21,
} as const;

export type RepairStatus = "proposals" | "not-underwater" | "unavailable";

export interface RepairLeg {
  strike: number;
  expirationDate: string;
  premium: number;
}

export interface RepairProposal {
  status: "DRAFT";
  symbol: string;
  /** 100-share units covered. */
  units: number;
  legLong: RepairLeg;
  legShort: RepairLeg & { quantity: number };
  /** Per unit; negative = credit. */
  netDebitPerUnit: number;
  /** The position recovers its loss here instead of at pricePaid. */
  breakevenAtExpiry: number;
  maxRecoveryPerUnit: number;
  /** K2 — upside is flat above this strike. */
  upsideCappedAbove: number;
  /** Explicit, not implied: repair adds no downside protection. */
  noDownsideProtection: true;
  /** Max additional capital at risk = net debit × 100 × units (0 on credit). */
  maxAdditionalCapitalAtRisk: number;
  postRepairBetaWeightedDeltaDollars: number | null;
  rationale: string;
  executableOrder?: ExecutableOrderSpec;
}

export interface RepairAnalysis {
  asOf: string;
  status: RepairStatus;
  reason?: string;
  /** Symbols evaluated but producing no proposal, with their named reason. */
  symbolsUnavailable: string[];
  unavailableReasons: Record<string, string>;
  proposals: RepairProposal[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function mid(c: ETradeOptionChainContract): number {
  if (c.bid > 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  return c.lastPrice > 0 ? c.lastPrice : 0;
}

function dteDays(expirationDate: string, asOf: string): number {
  const ms = new Date(expirationDate + "T00:00:00Z").getTime() - new Date(asOf).getTime();
  return Math.floor(ms / 86_400_000);
}

export interface RepairChainInput {
  chain: ETradeOptionChain;
  /** YYYY-MM-DD expiry the chain was fetched for. */
  expirationDate: string;
}

/**
 * Pure proposal builder. `chainsBySymbol` maps symbol → the chain fetched at
 * the repair expiry (or missing when no chain was available — the symbol is
 * named, never fabricated). `report` is optional; when provided, post-repair
 * beta-weighted Delta is computed via evaluatePostTradeTotals.
 */
export function buildRepairProposals(
  positions: ETradePosition[],
  chainsBySymbol: Record<string, RepairChainInput | null | undefined>,
  report: PortfolioRiskReport | null,
  asOf: string = new Date().toISOString()
): RepairAnalysis {
  const unavailableReasons: Record<string, string> = {};
  const proposals: RepairProposal[] = [];
  const underwater: ETradePosition[] = [];
  const markUnavailable = (symbol: string, reason: string): void => {
    if (!unavailableReasons[symbol]) unavailableReasons[symbol] = reason;
  };
  const symbolsUnavailable = (): string[] => Object.keys(unavailableReasons);

  for (const p of positions) {
    const isOption =
      p.securityType === "OPTN" || !!p.optionType || p.strikePrice != null;
    if (isOption) {
      markUnavailable(p.symbol, "option position — v1 repairs long equity only");
      continue;
    }
    if (!p.quantity || p.quantity < 100) {
      markUnavailable(p.symbol, "fewer than 100 shares — one repair unit needs 100 shares");
      continue;
    }
    if (!(p.pricePaid > 0)) {
      markUnavailable(p.symbol, "cost basis missing — cannot determine underwater status");
      continue;
    }
    const spot = p.currentPrice > 0 ? p.currentPrice : p.marketPrice;
    if (!(spot > 0)) {
      markUnavailable(p.symbol, "no live price — cannot size the repair");
      continue;
    }
    if (spot >= p.pricePaid) continue; // not underwater — nothing to repair
    underwater.push(p);
  }

  if (underwater.length === 0) {
    const names = symbolsUnavailable();
    const reason =
      names.length > 0
        ? `No underwater positions to repair. Unavailable: ${names.map((s) => `${s} (${unavailableReasons[s]})`).join(", ")}.`
        : "No underwater positions to repair.";
    return {
      asOf,
      status: names.length > 0 ? "unavailable" : "not-underwater",
      reason,
      symbolsUnavailable: names,
      unavailableReasons,
      proposals: [],
    };
  }

  for (const p of underwater) {
    const spot = p.currentPrice > 0 ? p.currentPrice : p.marketPrice;
    const input = chainsBySymbol[p.symbol];
    if (!input?.chain) {
      markUnavailable(p.symbol, "no option chain available — strikes are never fabricated");
      continue;
    }
    const result = buildOne(p, spot, input.chain, input.expirationDate, report);
    if (typeof result === "string") {
      markUnavailable(p.symbol, result);
      continue;
    }
    proposals.push(result);
  }

  if (proposals.length === 0) {
    const names = symbolsUnavailable();
    return {
      asOf,
      status: "unavailable",
      reason: `No repair structure met the rules. ${names.map((s) => `${s}: ${unavailableReasons[s]}`).join("; ")}.`,
      symbolsUnavailable: names,
      unavailableReasons,
      proposals: [],
    };
  }

  return { asOf, status: "proposals", symbolsUnavailable: symbolsUnavailable(), unavailableReasons, proposals };
}

function buildOne(
  p: ETradePosition,
  spot: number,
  chain: ETradeOptionChain,
  expirationDate: string,
  report: PortfolioRiskReport | null
): RepairProposal | string {
  const contracts = (chain.pairs ?? [])
    .map((pair) => pair.call)
    .filter(
      (c): c is ETradeOptionChainContract =>
        !!c && c.strikePrice > 0 && mid(c) > 0
    );
  if (contracts.length === 0) return "chain has no priced call contracts";

  const expiry = expirationDate;

  const legContracts = contracts;
  const strikes = [...new Set(legContracts.map((c) => c.strikePrice))].sort((a, b) => a - b);

  // K1 = nearest listed strike to spot.
  let k1 = strikes[0];
  for (const s of strikes) {
    if (Math.abs(s - spot) < Math.abs(k1 - spot)) k1 = s;
  }

  // K2 = lowest listed strike satisfying the half-gap rule:
  // a rally to K2 recovers the loss on the units covered.
  const halfGapFloor = spot + (p.pricePaid - spot) / 2;
  const k2 = strikes.find((s) => s > k1 && s >= halfGapFloor);
  if (k2 === undefined)
    return `no listed strike satisfies the half-gap rule (need K2 >= ${halfGapFloor.toFixed(2)})`;

  const longC = legContracts.find((c) => c.strikePrice === k1)!;
  const shortC = legContracts.find((c) => c.strikePrice === k2)!;
  const longMid = mid(longC);
  const shortMid = mid(shortC);

  // Zero-cost target: |netDebit| <= tolerance % of spot. A debit beyond
  // tolerance is a rejection, not a rounding exercise.
  const netDebit = round2(longMid - 2 * shortMid);
  const tolerance = (REPAIR_POLICY.repairCostTolerancePctOfSpot / 100) * spot;
  if (Math.abs(netDebit) > tolerance)
    return `net debit $${netDebit.toFixed(2)}/unit exceeds tolerance $${tolerance.toFixed(2)}/unit`;

  const units = Math.floor(p.quantity / 100);
  const maxAdditionalCapitalAtRisk = netDebit > 0 ? round2(netDebit * 100 * units) : 0;

  // Post-repair beta-weighted Delta via the shared totals evaluator.
  let postRepairBetaWeightedDeltaDollars: number | null = null;
  if (report) {
    const dLong = (longC.delta ?? 0.5) * 100 * units;
    const dShort = -2 * (shortC.delta ?? 0.3) * 100 * units;
    const candidate: CandidateGreekContribution = {
      deltaShares: round2(dLong + dShort),
      deltaDollars: round2((dLong + dShort) * spot),
      betaWeightedDeltaDollars: null, // no per-contract beta; stays honest
      gammaSharesPerDollar: 0,
      thetaDollarsPerDay: 0,
      vegaDollarsPerVolPoint: 0,
      rhoDollarsPerRatePoint: 0,
      definedMaxLoss: maxAdditionalCapitalAtRisk,
    };
    const post: PortfolioRiskTotals = evaluatePostTradeTotals(report, candidate);
    postRepairBetaWeightedDeltaDollars = post.betaWeightedDeltaDollars;
  }

  const maxRecoveryPerUnit = round2((k2 - spot) * 100 - Math.max(netDebit, 0) * 100);
  const limitPrice = Math.max(0.01, round2(Math.abs(netDebit)));
  const contractNetDebit = Math.sign(netDebit || -1) * Math.round(limitPrice * 100);

  return {
    status: "DRAFT",
    symbol: p.symbol,
    units,
    legLong: { strike: k1, expirationDate: expiry, premium: round2(longMid) },
    legShort: { strike: k2, expirationDate: expiry, premium: round2(shortMid), quantity: 2 },
    netDebitPerUnit: netDebit,
    breakevenAtExpiry: k2,
    maxRecoveryPerUnit,
    upsideCappedAbove: k2,
    noDownsideProtection: true,
    maxAdditionalCapitalAtRisk,
    postRepairBetaWeightedDeltaDollars,
    rationale:
      `Underwater ${p.symbol}: paid $${p.pricePaid.toFixed(2)}, spot $${spot.toFixed(2)}. ` +
      `1×2 call ratio (buy ${k1}C, sell 2× ${k2}C, ${expiry}) for ` +
      `${netDebit <= 0 ? `a $${Math.abs(netDebit).toFixed(2)} credit` : `a $${netDebit.toFixed(2)} debit`} per unit. ` +
      `A rally to $${k2.toFixed(2)} recovers the loss instead of waiting for $${p.pricePaid.toFixed(2)}. ` +
      `Upside is capped above $${k2.toFixed(2)}; there is NO downside protection below $${k1.toFixed(2)}.`,
    executableOrder: {
      assetClass: "options",
      symbol: p.symbol,
      action: "BUY",
      orderType: "LIMIT",
      quantity: units,
      limitPrice,
      strategyNetDebit: contractNetDebit,
      legs: [
        {
          underlyingSymbol: p.symbol,
          securityType: "OPTN",
          side: "BUY",
          quantity: 1,
          optionType: "CALL",
          strike: k1,
          expirationDate: expiry,
        },
        {
          underlyingSymbol: p.symbol,
          securityType: "OPTN",
          side: "SELL",
          quantity: 2,
          optionType: "CALL",
          strike: k2,
          expirationDate: expiry,
        },
      ],
      estimatedTotal: round2(netDebit * 100 * units),
      isExecutable: true,
    },
  };
}

/**
 * Full pipeline for the endpoint: live positions + per-symbol chains at the
 * repair expiry → drafts. Mirrors generateHedgeProposals (#54).
 * Drafts only — no order path is reachable from here.
 */
export async function generateRepairProposals(
  etrade: ETradeService
): Promise<RepairAnalysis> {
  const { positions } = etrade.getPositions();
  const chainsBySymbol: Record<string, RepairChainInput | null> = {};
  const equity = positions.filter(
    (p) => p.securityType !== "OPTN" && !p.optionType && p.quantity >= 100
  );

  for (const p of equity) {
    let candidateChain: RepairChainInput | null = null;
    const spot = p.currentPrice > 0 ? p.currentPrice : p.marketPrice;

    try {
      const expireDates = await etrade.getOptionExpireDates(p.symbol);
      if (expireDates && expireDates.length > 0) {
        const now = new Date();
        const candidateExpiries = expireDates
          .map((exp) => {
            const expDate = new Date(Date.UTC(exp.year, exp.month - 1, exp.day, 20, 0, 0));
            const dte = Math.round((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            return { exp, dte, diff: Math.abs(dte - 35) };
          })
          .filter((item) => item.dte >= REPAIR_POLICY.minDteDays && item.dte <= 90)
          .sort((a, b) => a.diff - b.diff);

        for (const candidate of candidateExpiries) {
          const exp = candidate.exp;
          const expDateStr = `${exp.year}-${String(exp.month).padStart(2, "0")}-${String(exp.day).padStart(2, "0")}`;
          const chain = await etrade.getOptionChains({
            symbol: p.symbol,
            expiryYear: exp.year,
            expiryMonth: exp.month,
            expiryDay: exp.day,
            chainType: "CALL",
          }).catch(() => null);

          if (chain && chain.pairs && chain.pairs.length > 0) {
            candidateChain = { chain, expirationDate: expDateStr };
            if (spot > 0 && spot < p.pricePaid) {
              const test = buildOne(p, spot, chain, expDateStr, null);
              if (typeof test !== "string") {
                break;
              }
            }
          }
        }
      }
    } catch {
      // Ignore and fallback
    }

    if (!candidateChain) {
      const target = new Date(Date.now() + REPAIR_POLICY.minDteDays * 24 * 3600 * 1000);
      const dayOfWeek = target.getUTCDay();
      const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
      target.setUTCDate(target.getUTCDate() + (daysUntilFriday === 0 ? 0 : daysUntilFriday));
      const yyyy = target.getUTCFullYear();
      const mm = target.getUTCMonth() + 1;
      const dd = target.getUTCDate();
      const expirationDate = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      try {
        const chain = await etrade.getOptionChains({
          symbol: p.symbol,
          expiryYear: yyyy,
          expiryMonth: mm,
          expiryDay: dd,
          chainType: "CALL",
        }).catch(() => null);
        candidateChain = chain ? { chain, expirationDate } : null;
      } catch {
        candidateChain = null;
      }
    }

    chainsBySymbol[p.symbol] = candidateChain;
  }

  let report: PortfolioRiskReport | null = null;
  try {
    report = await computePortfolioRisk(etradePortfolioRiskSource(etrade));
  } catch {
    // Post-repair Delta stays null; proposals still carry their own terms.
  }
  return buildRepairProposals(positions, chainsBySymbol, report);
}
