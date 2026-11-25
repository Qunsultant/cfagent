/**
 * Issue #319 — Autonomous Options Research and Trade-Idea Validation.
 *
 * SDK-free economics core. Every payoff / max-loss / breakeven figure the
 * agent publishes is recomputed here from first principles (spec §1 Proof:
 * "Payoff calculations have been independently recomputed by code").
 *
 * Pricing model: Black-Scholes (European exercise) with continuous dividend
 * yield. American-exercise nuances (early assignment on short legs) are NOT
 * priced — they are surfaced as risk-review limitations on the trade card.
 *
 * READ-ONLY: nothing in this module can place, modify, or cancel orders.
 */

export type ResearchOptionType = "call" | "put";

import { normalCdf } from "../shared/riskMath";
import {
  expectedMove as sharedExpectedMove,
  expiryPayoff,
  findBreakevensFromPayoff,
  gridExtreme,
  midPrice,
  netOpenCost as sharedNetOpenCost,
  type EconomicsLeg,
} from "../shared/optionsEconomics";

export interface ResearchLeg {
  optionType: ResearchOptionType;
  strike: number;
  /** ISO expiry date. */
  expiry: string;
  /** Days to expiry at quote time. */
  dte: number;
  bid: number;
  ask: number;
  /** Implied volatility as a decimal (e.g. 0.42), when the feed provides it. */
  iv?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  /** +1 = long one contract, -1 = short one contract (per spread unit). */
  quantity: number;
  /** Quote timestamp (ms epoch). */
  quoteTimestamp?: number | null;
}

export interface PricedLeg extends ResearchLeg {
  mid: number;
}

export interface StructureEconomics {
  structure: string;
  legs: PricedLeg[];
  /** Net cash paid to open (>0 = debit, 0 = none). Per spread unit. */
  netDebit: number;
  /** Net cash received to open (>0 = credit, 0 = none). Per spread unit. */
  netCredit: number;
  /** Contractual maximum loss per spread unit (excludes fees). */
  maxLoss: number;
  /** Maximum gain per spread unit, or null when theoretically unbounded. */
  maxGain: number | null;
  /** Breakeven underlying prices at expiry. */
  breakevens: number[];
  /** Human notes on how the figures were derived. */
  derivationNotes: string[];
}

export interface CostAssumptions {
  feePerContract: number;
  slippagePerContract: number;
  contracts: number;
}

export interface ScenarioRow {
  label: string;
  /** Underlying price in this scenario. */
  underlying: number;
  /** Relative IV shift applied (e.g. -0.3 = IV crush). */
  ivShift: number;
  /** Years from now to the scenario horizon. */
  horizonYears: number;
  /** Structure P&L per unit at the horizon, after costs. */
  pnlPerUnit: number;
  /** Total P&L for the assumed contract count, after costs. */
  pnlTotal: number;
}

/**
 * Standard normal CDF — the one implementation in `shared/riskMath.ts`.
 * Issue #6526: the local A&S copy was removed; callers keep this name.
 */
export const normCdf = normalCdf;

export interface BsInputs {
  spot: number;
  strike: number;
  /** Years to expiry. */
  years: number;
  /** Risk-free rate as a decimal. */
  rate: number;
  /** Continuous dividend yield as a decimal. */
  dividendYield: number;
  /** Volatility as a decimal. */
  sigma: number;
  optionType: ResearchOptionType;
}

/** European Black-Scholes price. Returns NaN on degenerate input. */
export function blackScholesPrice(input: BsInputs): number {
  const { spot, strike, years, rate, dividendYield, sigma, optionType } = input;
  if (
    !(spot > 0) ||
    !(strike > 0) ||
    !(years > 0) ||
    !(sigma > 0) ||
    !Number.isFinite(spot + strike + years + rate + dividendYield + sigma)
  ) {
    return NaN;
  }
  const sqrtT = Math.sqrt(years);
  const d1 =
    (Math.log(spot / strike) +
      (rate - dividendYield + 0.5 * sigma * sigma) * years) /
    (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discQ = Math.exp(-dividendYield * years);
  const discR = Math.exp(-rate * years);
  if (optionType === "call") {
    return spot * discQ * normCdf(d1) - strike * discR * normCdf(d2);
  }
  return strike * discR * normCdf(-d2) - spot * discQ * normCdf(-d1);
}

/** One-standard-deviation expected move over `years` at volatility `sigma`. */
export function expectedMove(spot: number, sigma: number, years: number): number {
  return sharedExpectedMove(spot, sigma, years);
}

export function legMid(leg: ResearchLeg): number {
  return midPrice(leg.bid, leg.ask);
}

function asEconomicsLegs(legs: PricedLeg[]): EconomicsLeg[] {
  return legs.map((leg) => ({
    optionType: leg.optionType,
    strike: leg.strike,
    quantity: leg.quantity,
    price: leg.mid,
  }));
}

function withMids(legs: ResearchLeg[]): PricedLeg[] {
  return legs.map((leg) => ({ ...leg, mid: legMid(leg) }));
}

/** Net cash flow to open: positive = debit paid, negative = credit received. */
function netOpenCost(legs: PricedLeg[]): number {
  return sharedNetOpenCost(asEconomicsLegs(legs));
}

/** Structure P&L at expiry for an underlying price (per unit, pre-costs). */
export function payoffAtExpiry(
  legs: PricedLeg[],
  netDebit: number,
  netCredit: number,
  spot: number
): number {
  return expiryPayoff(asEconomicsLegs(legs), spot) - netDebit + netCredit;
}

/**
 * Breakevens found numerically over a wide underlying grid — the same
 * routine backs every structure, so no hand-derived formula can drift.
 */
function payoffSamples(referenceSpot: number, steps: number): number[] {
  const lo = Math.max(referenceSpot * 0.01, 0.01);
  const hi = referenceSpot * 3;
  return Array.from({ length: steps + 1 }, (_, index) => lo + ((hi - lo) * index) / steps);
}

export function findBreakevens(
  legs: PricedLeg[],
  netDebit: number,
  netCredit: number,
  referenceSpot: number
): number[] {
  const payoff = (spot: number): number => payoffAtExpiry(legs, netDebit, netCredit, spot);
  return findBreakevensFromPayoff(payoff, payoffSamples(referenceSpot, 4000), {
    refine: "bisection",
    dedupeTolerance: referenceSpot * 0.001,
    precision: 2,
  });
}

function maxLossOnGrid(
  legs: PricedLeg[],
  netDebit: number,
  netCredit: number,
  referenceSpot: number
): number {
  const payoff = (spot: number): number => payoffAtExpiry(legs, netDebit, netCredit, spot);
  const { min } = gridExtreme(payoff, payoffSamples(referenceSpot, 2000));
  return Math.max(0, -min);
}

function maxGainOnGrid(
  legs: PricedLeg[],
  netDebit: number,
  netCredit: number,
  referenceSpot: number
): number | null {
  const payoff = (spot: number): number => payoffAtExpiry(legs, netDebit, netCredit, spot);
  const { max } = gridExtreme(payoff, payoffSamples(referenceSpot, 2000));
  // If the payoff is still growing at the grid edge, gain is effectively
  // unbounded over the sampled domain — report null rather than a clipped
  // number. Capped structures (spreads, condors) plateau, so they keep
  // their finite best.
  const hi = referenceSpot * 3;
  const edge = payoff(hi);
  const nearEdge = payoff(hi * 0.99);
  if (edge - nearEdge > 1e-6) return null;
  return Math.max(0, max);
}

function baseEconomics(
  structure: string,
  legs: ResearchLeg[],
  referenceSpot: number,
  derivationNotes: string[]
): StructureEconomics {
  const priced = withMids(legs);
  const net = netOpenCost(priced);
  const netDebit = net > 0 ? net : 0;
  const netCredit = net < 0 ? -net : 0;
  return {
    structure,
    legs: priced,
    netDebit: Number(netDebit.toFixed(2)),
    netCredit: Number(netCredit.toFixed(2)),
    maxLoss: Number(maxLossOnGrid(priced, netDebit, netCredit, referenceSpot).toFixed(2)),
    maxGain: (() => {
      const g = maxGainOnGrid(priced, netDebit, netCredit, referenceSpot);
      return g === null ? null : Number(g.toFixed(2));
    })(),
    breakevens: findBreakevens(priced, netDebit, netCredit, referenceSpot),
    derivationNotes,
  };
}

/**
 * Defined-risk vertical spread. Contractual max loss is derived, never
 * asserted: debit spreads lose the debit; credit spreads lose width minus
 * credit. Both fall out of the grid computation.
 */
export function verticalSpreadEconomics(
  legs: ResearchLeg[],
  referenceSpot: number
): StructureEconomics {
  if (legs.length !== 2) {
    throw new Error("verticalSpreadEconomics requires exactly 2 legs");
  }
  const [a, b] = legs;
  if (a.optionType !== b.optionType) {
    throw new Error("vertical spread legs must share the option type");
  }
  if (a.expiry !== b.expiry) {
    throw new Error("vertical spread legs must share the expiry");
  }
  const width = Math.abs(a.strike - b.strike);
  return baseEconomics("vertical_spread", legs, referenceSpot, [
    `Width ${width.toFixed(2)}; max loss derived numerically over the expiry payoff grid.`,
  ]);
}

/** Defined-risk iron condor: short call spread + short put spread. */
export function ironCondorEconomics(
  legs: ResearchLeg[],
  referenceSpot: number
): StructureEconomics {
  if (legs.length !== 4) {
    throw new Error("ironCondorEconomics requires exactly 4 legs");
  }
  return baseEconomics("iron_condor", legs, referenceSpot, [
    "Max loss derived numerically; equals the wider wing width minus net credit for standard condors.",
  ]);
}

/** Butterfly: long 1×K1, short 2×K2, long 1×K3 (same type/expiry). */
export function butterflyEconomics(
  legs: ResearchLeg[],
  referenceSpot: number
): StructureEconomics {
  if (legs.length !== 3) {
    throw new Error("butterflyEconomics requires exactly 3 legs");
  }
  return baseEconomics("butterfly", legs, referenceSpot, [
    "Max gain concentrates at the body strike; derived numerically.",
  ]);
}

/**
 * Issue #1114 (epic #1096 Phase 2): generic economics for COMPOSED
 * structures (leg graphs produced by the composition algebra). This is
 * the same numerical grid machinery behind every family function
 * above — an export of the one pricing engine, not a second engine.
 * Max loss/gain and breakevens are derived over the expiry payoff
 * grid; undefined-risk structures report the grid-bounded figure and
 * the composition gate separately flags their tail risk.
 */
export function composedStructureEconomics(
  structure: string,
  legs: ResearchLeg[],
  referenceSpot: number,
  derivationNotes: string[] = []
): StructureEconomics {
  if (legs.length === 0) {
    throw new Error("composedStructureEconomics requires at least one leg");
  }
  return baseEconomics(structure, legs, referenceSpot, [
    "Composed structure priced by the generic researchEconomics grid (net debit/credit, max loss/gain, breakevens derived numerically).",
    ...derivationNotes,
  ]);
}

export interface StraddleAssessment {
  premium: number;
  expectedMove: number;
  /** premium / expectedMove — >1 means the market prices a larger move than you pay for. */
  premiumToExpectedMove: number;
  breakevens: number[];
  derivationNotes: string[];
}

/**
 * Long straddle/strangle assessed against the expected move (spec §6:
 * "assessed against premium and expected movement").
 */
export function straddleEconomics(
  legs: ResearchLeg[],
  referenceSpot: number,
  sigma: number,
  dte: number
): StraddleAssessment {
  const priced = withMids(legs);
  const premium = priced.reduce((s, l) => s + l.quantity * l.mid, 0);
  const em = expectedMove(referenceSpot, sigma, dte / 365);
  const netDebit = Math.max(premium, 0);
  return {
    premium: Number(premium.toFixed(2)),
    expectedMove: Number(em.toFixed(2)),
    premiumToExpectedMove: Number((premium / em).toFixed(3)),
    breakevens: findBreakevens(priced, netDebit, 0, referenceSpot),
    derivationNotes: [
      `Expected move ${em.toFixed(2)} from IV ${(sigma * 100).toFixed(1)}% over ${dte} DTE.`,
    ],
  };
}

export interface PmccInputs {
  /** Long LEAPS call. */
  longCall: ResearchLeg;
  /** Short nearer-dated call, higher strike. */
  shortCall: ResearchLeg;
  spot: number;
  rate: number;
  dividendYield: number;
  /** IV for re-pricing the long call at the short expiry. */
  longIv: number;
}

export interface PmccEconomics {
  netDebit: number;
  shortCredit: number;
  /** Correct max profit: modeled with the long call's remaining Black-Scholes value at the short expiry. */
  maxProfit: number;
  /** Max loss (≈ net debit). */
  maxLoss: number;
  /** The WRONG formula (strike width minus debit) — exposed so tests can pin that we never use it. */
  naiveWidthMinusDebit: number;
  /** Underlying price at which max profit occurs (approx). */
  maxProfitSpot: number;
  derivationNotes: string[];
}

/**
 * PMCC modeled CORRECTLY per spec §6: the long call's remaining value at
 * the short expiration is priced with Black-Scholes — "strike width minus
 * debit" is NOT a complete max-profit calculation and is never used here
 * (it is returned as `naiveWidthMinusDebit` only so tests can assert the
 * model differs from it).
 */
export function pmccEconomics(input: PmccInputs): PmccEconomics {
  const { longCall, shortCall, spot, rate, dividendYield, longIv } = input;
  if (longCall.optionType !== "call" || shortCall.optionType !== "call") {
    throw new Error("PMCC requires two calls");
  }
  if (shortCall.strike <= longCall.strike) {
    throw new Error("PMCC short strike must exceed the long strike");
  }
  if (shortCall.dte >= longCall.dte) {
    throw new Error("PMCC short expiry must precede the long expiry");
  }
  const longMid = legMid(longCall);
  const shortMid = legMid(shortCall);
  const netDebit = longMid - shortMid;
  const width = shortCall.strike - longCall.strike;
  const naive = width - netDebit;
  const remainingYears = Math.max((longCall.dte - shortCall.dte) / 365, 1 / 365);

  // P&L at the short expiry as a function of the underlying then (S2):
  // position = BS(long call with remaining life) - short call payoff - net debit.
  const pnlAt = (s2: number): number => {
    const longValue = blackScholesPrice({
      spot: s2,
      strike: longCall.strike,
      years: remainingYears,
      rate,
      dividendYield,
      sigma: longIv,
      optionType: "call",
    });
    const shortPayoff = Math.max(s2 - shortCall.strike, 0);
    return longValue - shortPayoff - netDebit;
  };

  let best = -Infinity;
  let bestS = spot;
  let worst = Infinity;
  const lo = Math.max(spot * 0.05, 0.01);
  const hi = Math.max(spot * 3, shortCall.strike * 2);
  for (let i = 0; i <= 4000; i++) {
    const s2 = lo + ((hi - lo) * i) / 4000;
    const pnl = pnlAt(s2);
    if (!Number.isFinite(pnl)) continue;
    if (pnl > best) {
      best = pnl;
      bestS = s2;
    }
    if (pnl < worst) worst = pnl;
  }
  return {
    netDebit: Number(netDebit.toFixed(2)),
    shortCredit: Number(shortMid.toFixed(2)),
    maxProfit: Number(best.toFixed(2)),
    maxLoss: Number(Math.max(0, -worst).toFixed(2)),
    naiveWidthMinusDebit: Number(naive.toFixed(2)),
    maxProfitSpot: Number(bestS.toFixed(2)),
    derivationNotes: [
      `Long call re-priced at short expiry with ${(remainingYears * 365).toFixed(0)}d remaining via Black-Scholes at ${(longIv * 100).toFixed(1)}% IV.`,
      "Naive width-minus-debit is shown for comparison only and is never used as max profit.",
    ],
  };
}

/**
 * Value every leg at a horizon with shocked spot/IV (European BS) and
 * return P&L per unit vs the opening debit/credit. The five spec §8
 * scenario rows are built on this.
 */
export function valueAtHorizon(
  legs: PricedLeg[],
  netDebit: number,
  netCredit: number,
  spotHorizon: number,
  ivShock: number,
  horizonYears: number,
  rate: number,
  dividendYield: number
): number {
  let value = 0;
  for (const leg of legs) {
    const remaining = Math.max(leg.dte / 365 - horizonYears, 1 / 365);
    // #926: no assumed IV. A leg without chain IV is NOT repriced via
    // Black-Scholes; it contributes its market mid (a real number, not an
    // invented IV). Callers that need a pure IV-dependent total (scenario
    // rows) must pre-check all legs and return unavailable instead.
    if (leg.iv == null || leg.iv <= 0) {
      value += leg.quantity * leg.mid;
      continue;
    }
    const iv = Math.max(leg.iv * (1 + ivShock), 0.01);
    const px = blackScholesPrice({
      spot: spotHorizon,
      strike: leg.strike,
      years: remaining,
      rate,
      dividendYield,
      sigma: iv,
      optionType: leg.optionType,
    });
    value += leg.quantity * (Number.isFinite(px) ? px : leg.mid);
  }
  return value - netDebit + netCredit;
}

export interface ScenarioSpec {
  label: string;
  /** Multiple of the expected move applied to spot (signed). */
  emMultiple: number;
  /** Relative IV shock. */
  ivShock: number;
}

/** The five spec §8 scenario rows. */
export const SCENARIO_SPECS: ScenarioSpec[] = [
  { label: "Downside (-1 expected move)", emMultiple: -1, ivShock: 0.25 },
  { label: "Flat", emMultiple: 0, ivShock: 0 },
  { label: "Moderate upside (+0.5 expected move)", emMultiple: 0.5, ivShock: 0 },
  { label: "Sharp upside (+1.5 expected moves)", emMultiple: 1.5, ivShock: -0.1 },
  { label: "IV crush (-30%, spot flat)", emMultiple: 0, ivShock: -0.3 },
];

export function buildScenarioRows(
  econ: StructureEconomics,
  spot: number,
  sigma: number,
  horizonDte: number,
  rate: number,
  dividendYield: number,
  costs: CostAssumptions
): ScenarioRow[] {
  // #926: scenario rows are IV-dependent math. If the expected-move sigma
  // is unavailable or any leg lacks chain IV, there are no rows — never
  // rows built on an assumed IV.
  if (!Number.isFinite(sigma) || sigma <= 0 || econ.legs.some((l) => l.iv == null || l.iv <= 0)) {
    return [];
  }
  const em = expectedMove(spot, sigma, horizonDte / 365);
  const horizonYears = Math.max(horizonDte / 365, 1 / 365);
  return SCENARIO_SPECS.map((spec) => {
    const underlying = Math.max(spot + spec.emMultiple * em, 0.01);
    const pnlPerUnit = valueAtHorizon(
      econ.legs,
      econ.netDebit,
      econ.netCredit,
      underlying,
      spec.ivShock,
      horizonYears,
      rate,
      dividendYield
    );
    const perContractCost =
      costs.feePerContract + costs.slippagePerContract;
    const pnlTotal =
      pnlPerUnit * 100 * costs.contracts - perContractCost * costs.contracts;
    return {
      label: spec.label,
      underlying: Number(underlying.toFixed(2)),
      ivShift: spec.ivShock,
      horizonYears: Number(horizonYears.toFixed(4)),
      pnlPerUnit: Number(pnlPerUnit.toFixed(2)),
      pnlTotal: Number(pnlTotal.toFixed(2)),
    };
  });
}

/** Contractual max loss vs a stop-based estimated loss, kept distinct per spec §1. */
export function lossDecomposition(
  econ: StructureEconomics,
  costs: CostAssumptions
): { contractualMaxLoss: number; stopBasedEstimatedLoss: number | null; note: string } {
  const perContractCost = costs.feePerContract + costs.slippagePerContract;
  const contractual = econ.maxLoss * 100 * costs.contracts + perContractCost * costs.contracts;
  return {
    contractualMaxLoss: Number(contractual.toFixed(2)),
    stopBasedEstimatedLoss: null,
    note: "Contractual max loss is the structure's defined risk plus fees/slippage. No stop-based estimate is published — stops are not part of the recommended structure.",
  };
}
