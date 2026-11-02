/**
 * Poor Man's Covered Call gates (issue #1769, parent #1717;
 * screener-rules.md §1.3). Pure functions over a StrategyCandidate —
 * nothing here fetches, and no engine behavior is changed by this
 * module alone: the rules are enforced only because ledger.ts adds
 * PMCC_ACCEPTANCE_RULES to DEFAULT_ACCEPTANCE_RULES, which the
 * engine already runs on every generated candidate.
 *
 * Leg identification, stated not silent: the LONG leg is the BUY
 * CALL with the greatest daysToExpiration (the LEAPS leg) and the
 * SHORT leg is the SELL CALL with the smallest daysToExpiration
 * (the near leg). A PMCC candidate that is not exactly those two
 * CALL legs cannot be evaluated honestly and fail-closes (rejected),
 * never passes on a guessed leg. Every other strategy type passes
 * through every rule with null — these gates are PMCC-only.
 *
 * Friction: (Spread_long + Spread_short) / Bid_short <= 3.0, where
 * Spread = Ask − Bid per leg and Bid_short is the short leg's bid.
 * A non-positive short bid makes the ratio undefined → null.
 *
 * Breach distance: short strike >= 8% above spot OR >= LEAPS
 * breakeven. Breakeven = K_LEAPS + net debit per share, and net
 * debit per share = long entry − short entry (per-share entries;
 * the multiplier cancels, fees are excluded — the doc's Debit is
 * the pair's debit, not a fee-loaded total). The OR is the doc's
 * literal reading: clearing either threshold clears the gate.
 *
 * 30-day premium yield: (Credit_short / Debit_LEAPS) ×
 * (30 / DTE_short) >= 4.0%, where Credit_short is the short leg's
 * entry (the credit received per share) and Debit_LEAPS is the long
 * leg's entry (the debit paid per share). A non-positive LEAPS
 * debit, negative short credit, or non-positive short DTE → null.
 */

import type { StrategyCandidate, StrategyLeg } from "../strategyEngine";
import type { AcceptanceRule } from "./types";

export interface PmccLegs {
  longLeg: StrategyLeg;
  shortLeg: StrategyLeg;
}

export function findPmccLegs(candidate: StrategyCandidate): PmccLegs | null {
  if (candidate.type !== "poor_mans_covered_call") return null;
  const legs = candidate.legs ?? [];
  if (legs.length !== 2) return null;
  const buys = legs.filter((l) => l.side === "BUY" && l.optionType === "CALL");
  const sells = legs.filter((l) => l.side === "SELL" && l.optionType === "CALL");
  if (buys.length !== 1 || sells.length !== 1) return null;
  return { longLeg: buys[0], shortLeg: sells[0] };
}

function dte(leg: StrategyLeg): number | undefined {
  return leg.daysToExpiration;
}

export interface PmccFriction {
  friction: number;
  passes: boolean;
}

export function evaluatePmccFriction(candidate: StrategyCandidate): PmccFriction | null {
  const legs = findPmccLegs(candidate);
  if (legs === null) return null;
  const { longLeg, shortLeg } = legs;
  if (!Number.isFinite(shortLeg.bid) || shortLeg.bid <= 0) return null;
  const spreadLong = longLeg.ask - longLeg.bid;
  const spreadShort = shortLeg.ask - shortLeg.bid;
  if (!Number.isFinite(spreadLong) || !Number.isFinite(spreadShort) || spreadLong < 0 || spreadShort < 0) return null;
  const friction = (spreadLong + spreadShort) / shortLeg.bid;
  return { friction, passes: friction <= 3.0 };
}

export interface PmccBreach {
  shortStrike: number;
  spotThreshold: number;
  leapsBreakeven: number;
  passes: boolean;
}

export function evaluatePmccBreach(candidate: StrategyCandidate): PmccBreach | null {
  const legs = findPmccLegs(candidate);
  if (legs === null) return null;
  const { longLeg, shortLeg } = legs;
  const spot = candidate.underlyingPrice;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(longLeg.entryPrice) || !Number.isFinite(shortLeg.entryPrice)) return null;
  const spotThreshold = spot * 1.08;
  const leapsBreakeven = longLeg.strike + (longLeg.entryPrice - shortLeg.entryPrice);
  return {
    shortStrike: shortLeg.strike,
    spotThreshold,
    leapsBreakeven,
    passes: shortLeg.strike >= spotThreshold || shortLeg.strike >= leapsBreakeven,
  };
}

export interface PmccYield {
  yield: number;
  passes: boolean;
}

export function computePmcc30DayYield(candidate: StrategyCandidate): PmccYield | null {
  const legs = findPmccLegs(candidate);
  if (legs === null) return null;
  const { longLeg, shortLeg } = legs;
  const shortDte = dte(shortLeg);
  if (!Number.isFinite(longLeg.entryPrice) || longLeg.entryPrice <= 0) return null;
  if (!Number.isFinite(shortLeg.entryPrice) || shortLeg.entryPrice < 0) return null;
  if (shortDte === undefined || !Number.isFinite(shortDte) || shortDte <= 0) return null;
  const yieldValue = (shortLeg.entryPrice / longLeg.entryPrice) * (30 / shortDte);
  return { yield: yieldValue, passes: yieldValue >= 0.04 };
}

/** PMCC acceptance rules — appended to DEFAULT_ACCEPTANCE_RULES in ledger.ts. */
export const PMCC_ACCEPTANCE_RULES: AcceptanceRule[] = [
  {
    id: "pmcc-friction",
    evaluate: (candidate) => {
      if (candidate.type !== "poor_mans_covered_call") return null;
      const result = evaluatePmccFriction(candidate);
      if (result === null) return `${candidate.label} PMCC friction cannot be evaluated from its legs`;
      return result.passes ? null : `${candidate.label} PMCC friction (${result.friction.toFixed(2)}) exceeds 3.0`;
    },
  },
  {
    id: "pmcc-breach-distance",
    evaluate: (candidate) => {
      if (candidate.type !== "poor_mans_covered_call") return null;
      const result = evaluatePmccBreach(candidate);
      if (result === null) return `${candidate.label} PMCC breach distance cannot be evaluated from its legs`;
      return result.passes
        ? null
        : `${candidate.label} PMCC breach distance failed: short strike ($${result.shortStrike.toFixed(2)}) is below both 8% above spot ($${result.spotThreshold.toFixed(2)}) and LEAPS breakeven ($${result.leapsBreakeven.toFixed(2)})`;
    },
  },
  {
    id: "pmcc-30day-yield",
    evaluate: (candidate) => {
      if (candidate.type !== "poor_mans_covered_call") return null;
      const result = computePmcc30DayYield(candidate);
      if (result === null) return `${candidate.label} PMCC 30-day premium yield cannot be evaluated from its legs`;
      return result.passes ? null : `${candidate.label} PMCC 30-day premium yield (${(result.yield * 100).toFixed(2)}%) is below 4.0%`;
    },
  },
];
