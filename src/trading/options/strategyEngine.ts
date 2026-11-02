import type { ScreenedOptionContractItem } from "../../types";
import { defaultRegistry, buildNameLedger } from "./strategies/catalog";
import { contractKey, MULTIPLIER } from "./strategies/legs";
import { EvaluationLedger, runAcceptanceRules, runNoViewAcceptanceRules } from "./strategies/ledger";
import { filterDefinitionsByMode, resolveStrategyMode } from "./strategyChoice";
import type { RiskProfile } from "./recommendationAgent";
import type { ChainView, NameLedgerEntry, StrategyContext, StrategyDefinition, StrategyEvaluation } from "./strategies/types";

export { contractKey };

export type OptionThesis = "bullish" | "bearish" | "range_bound" | "large_move";
export type ExpectedIvDirection = "rise" | "unchanged" | "fall";

/**
 * Earnings/dividend calendar facts for the request's symbol (issue #16),
 * supplied by the caller from a live calendar source (see
 * src/services/eventCalendar.ts). `covered` is the honesty flag: it is
 * true only when a live source answered for the name — the dates may
 * still be null when no event is scheduled. When coverage is absent the
 * engine keeps its pre-#16 behavior exactly: "exclude" withholds
 * everything as unverifiable and "warn" carries the unverified warning.
 * The engine never guesses a date.
 */
export interface EventCalendarInfo {
  covered: boolean;
  /** Provenance label of the calendar source (e.g. "yahoo-calendarEvents"). */
  source?: string;
  /** Next earnings date (YYYY-MM-DD), or null when none is scheduled. */
  earningsDate?: string | null;
  /** Whole days until the next earnings date; null when none is scheduled. */
  daysToEarnings?: number | null;
  /** Next ex-dividend date (YYYY-MM-DD), or null when none is scheduled. */
  exDividendDate?: string | null;
  /** Whole days until the next ex-dividend date; null when none is scheduled. */
  daysToExDiv?: number | null;
}

export type OptionStrategyType = string;

export interface StrategyRequest {
  symbol: string;
  thesis: OptionThesis;
  targetPrice: number;
  targetDate: string;
  expectedIvDirection: ExpectedIvDirection;
  maxPlannedLoss: number;
  minRewardRisk: number;
  /** Optimization bias slider ported from the retired client ranker (issue #29):
   *  0 = max return, 50 = balanced, 100 = max chance. Converted to score
   *  weights by resolveScoreWeights; absent = balanced defaults. */
  optimizationBias?: number;
  /** Data provenance for the run (issue #65): "live" (default) serves broker
   *  chains only; "calibrated-demo" explicitly requests generated chains and
   *  is honored only when the dev/demo gate is enabled. */
  dataMode?: "live" | "calibrated-demo";
  minDte?: number;
  maxDte?: number;
    minVolume?: number; // User-visible option-screen thresholds
    minOpenInterest?: number; // User-visible option-screen thresholds
    maxSpreadPct?: number; // User-visible option-screen thresholds
    maxQuoteAgeSeconds?: number; // User-visible option-screen thresholds
    contractLimit?: number; // User-visible option-screen thresholds
    candidateLimit?: number; // User-visible option-screen thresholds
      maxStrikesPerSide?: number; // User-visible option-screen thresholds
      maxIronCondors?: number; // User-visible option-screen thresholds
  allowedStrategies: OptionStrategyType[];
  /**
   * Issue #2091: evaluate every wanted strategy against the chain instead
   * of only the thesis-matching ones. Default false (existing callers
   * unchanged). When true, the request thesis still orients the
   * thesisAlignment score component — it no longer excludes strategies.
   * Strategies whose required expiries are absent from the chain are
   * ledger-skipped ("no contracts inside the DTE window"), never silently
   * dropped. Fetch bands are unaffected: this flag judges the chain that
   * was fetched, it does not widen what is fetched.
   *
   * Issue #2600: deprecated alias, superseded by strategyMode
   * (src/trading/options/strategyChoice.ts). true === "all",
   * false/absent === "thesis"; a conflicting pair is rejected at the
   * schema boundary, never resolved silently here.
   */
  evaluateAllStrategies?: boolean;
  /**
   * Issue #2600: canonical per-run strategy scope — "thesis" (default:
   * only thesis-matching wanted strategies), "all" (every wanted
   * strategy, thesis kept as a score bias), "no-view" (never on this
   * viewed request type; no-view uses NoViewStrategyRequest).
   */
  strategyMode?: "thesis" | "all" | "no-view";
  /**
   * Issue #2600: far-dated fetch toggle for this run. true widens the
   * fetch bands to the selected templates' horizons (see
   * deriveFetchBands); false keeps the near band only and reports
   * far-horizon selections as horizon-limited. Absent on engine-only
   * callers = the engine judges the chain it was given.
   */
  farDated?: boolean;
  /**
   * Issue #2600: fetch bands derived from the mode-resolved selected
   * templates (deriveFetchBands), carried so the snapshot loader and
   * the run record use the same band list. Absent = the loader's own
   * default window.
   */
  expirationDteBands?: Array<{ minDte: number; maxDte: number; maxExpirations?: number }>;
  eventPolicy?: "warn" | "exclude";
  eventCalendar?: EventCalendarInfo;
  riskFreeRate?: number;
  dividendYield?: number;
  feesPerContract?: number;
}

/** Score model stamped on every no-view candidate and result (issue #534):
 *  scores under this model are NOT comparable to viewed scores under
 *  "options-risk-v2" — the components and gates differ by design. */
export const NO_VIEW_SCORE_MODEL = "no-view-v1" as const;

/** The no-view mode's volatility expectation (issue #534, decision 4): a
 *  declared constant, fixed to "unchanged" — never a request input, so a
 *  caller cannot smuggle a partial view in through it. */
export const NO_VIEW_EXPECTED_IV_DIRECTION = "unchanged" as const satisfies ExpectedIvDirection;

/** Default probability-of-profit floor for no-view constraint sets
 *  (the scanner fit-gate precedent, issue #24). */
export const NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT = 0.35;

/**
 * A view-less strategy request (issue #534): constraints only. There is
 * deliberately NO thesis, targetPrice, targetDate or expectedIvDirection
 * field — the engine must never rank structures FOR a view the user did
 * not supply, and must never fabricate one (validateNoViewRequest rejects
 * view fields instead of silently ignoring them).
 */
export interface NoViewStrategyRequest {
  symbol: string;
  maxPlannedLoss: number;
  minRewardRisk: number;
  /** Model-implied POP floor, 0-1; absent = NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT. */
  minProbabilityOfProfit?: number;
  /** Optimization bias slider, as on StrategyRequest; converted to score
   *  weights by resolveNoViewScoreWeights. */
  optimizationBias?: number;
  /** Ranking profile for the recommender's no-view pick; absent = "balanced". */
  riskProfile?: RiskProfile;
  /** Data provenance for the run (issue #65), as on StrategyRequest. */
  dataMode?: "live" | "calibrated-demo";
  minDte?: number;
  maxDte?: number;
  minVolume?: number; // User-visible option-screen thresholds
  minOpenInterest?: number; // User-visible option-screen thresholds
  maxSpreadPct?: number; // User-visible option-screen thresholds
  maxQuoteAgeSeconds?: number; // User-visible option-screen thresholds
  contractLimit?: number; // User-visible option-screen thresholds
  candidateLimit?: number; // User-visible option-screen thresholds
  maxStrikesPerSide?: number; // User-visible option-screen thresholds
  maxIronCondors?: number; // User-visible option-screen thresholds
  /** Absent = the full registry. Unlike the viewed request there is no
   *  view filter behind this list: every selected definition is
   *  eligible for generation. */
  allowedStrategies?: OptionStrategyType[];
  eventPolicy?: "warn" | "exclude";
  eventCalendar?: EventCalendarInfo;
  riskFreeRate?: number;
  dividendYield?: number;
  feesPerContract?: number;
}

export interface StrategyLeg {
  symbol: string;
  optionType: "CALL" | "PUT" | "STOCK";
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expirationDate: string;
  daysToExpiration?: number;
  entryPrice: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  openInterest: number;
  volume: number;
  spreadPct: number;
  quoteTimestamp: string;
  quoteAgeSeconds?: number;
  quoteFreshness: "FRESH" | "STALE" | "UNKNOWN";
  multiplier: number;
}

export interface StrategyScenario {
  underlyingPrice: number;
  daysToExpiry: number;
  ivChangePct: number;
  pnl: number;
}

export interface StrategyScoreBreakdown {
  thesisAlignment: number;
  targetRewardRisk: number;
  liquidity: number;
  volatilityAlignment: number;
  thetaBurden: number;
  freshness: number;
  /** Model-implied probability of profit, 0-100 (the client's "chance" lens). */
  popAlignment: number;
  /** Margin of safety: nearest breakeven distance from spot (client "cushion" lens). */
  cushion: number;
  /** Target profit per unit of capital at risk (client "capital efficiency" lens). */
  capitalEfficiency: number;
  weights: Record<"thesisAlignment" | "targetRewardRisk" | "liquidity" | "volatilityAlignment" | "thetaBurden" | "freshness" | "popAlignment" | "cushion" | "capitalEfficiency", number>;
}

export type NoViewScoreWeights = Record<"popAlignment" | "cushion" | "liquidity" | "thetaBurden" | "freshness", number>;

/**
 * Score breakdown for the no-view model (issue #534): only the five
 * target-free components of the viewed model survive. The target-derived
 * components (thesisAlignment, targetRewardRisk, capitalEfficiency) and
 * the IV-direction component (volatilityAlignment — a constant under the
 * mode's fixed "unchanged" assumption, so it carries no signal) are
 * ABSENT, not zeroed.
 */
export interface NoViewScoreBreakdown {
  /** Model-implied probability of profit, 0-100. */
  popAlignment: number;
  /** Margin of safety: nearest breakeven distance from spot. */
  cushion: number;
  liquidity: number;
  thetaBurden: number;
  freshness: number;
  weights: NoViewScoreWeights;
}

export interface StrategyCandidate {
  id: string;
  rank: number;
  type: OptionStrategyType;
  label: string;
  symbol: string;
  underlyingPrice: number;
  expirationDate: string;
  dataFreshness: "FRESH" | "STALE" | "UNKNOWN";
  legs: StrategyLeg[];
  netDebit: number;
  estimatedFees: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  maxLoss: number;
  breakevens: number[];
  targetPnl: number;
  targetRewardRisk: number;
  modelImpliedProbabilityOfProfit: number;
  netGreeks: { delta: number; gamma: number; theta: number; vega: number };
  liquidityScore: number;
  score: number;
  scoreBreakdown: StrategyScoreBreakdown;
  payoffCurve: Array<{ underlyingPrice: number; pnl: number }>;
  scenarios: StrategyScenario[];
  explanations: string[];
  warnings: string[];
  assumptions: string[];
}

/**
 * A candidate produced by the no-view path (issue #534): the viewed
 * candidate's target fields (targetPnl, targetRewardRisk) are absent —
 * no target exists — replaced by the structure-defined reward/risk and
 * the score-model stamp.
 */
export interface NoViewStrategyCandidate extends Omit<StrategyCandidate, "targetPnl" | "targetRewardRisk" | "scoreBreakdown"> {
  scoreBreakdown: NoViewScoreBreakdown;
  /** maxProfit / maxLoss, both structure-defined and expiry-native;
   *  null (never Infinity) when maxProfit is unbounded — such structures
   *  are carried by the POP and max-loss gates instead. */
  structureRewardRisk: number | null;
  scoreModel: typeof NO_VIEW_SCORE_MODEL;
}

export interface StrategyRecommendationResult {
  status: "ranked_candidates" | "no_candidates";
  request: StrategyRequest;
  generatedAt: string;
  modelVersion: string;
  dataSource: string;
  assumptions: string[];
  scoreWeights: StrategyScoreBreakdown["weights"];
  candidates: StrategyCandidate[];
  excluded: Array<{ reason: string; count: number }>;
  evaluations: StrategyEvaluation[];
  nameLedger: NameLedgerEntry[];
}

export interface NoViewRecommendationResult {
  status: "ranked_candidates" | "no_candidates";
  request: NoViewStrategyRequest;
  generatedAt: string;
  modelVersion: typeof NO_VIEW_SCORE_MODEL;
  scoreModel: typeof NO_VIEW_SCORE_MODEL;
  /** The mode's declared IV constant, stamped on every result. */
  expectedIvDirection: typeof NO_VIEW_EXPECTED_IV_DIRECTION;
  dataSource: string;
  assumptions: string[];
  scoreWeights: NoViewScoreWeights;
  candidates: NoViewStrategyCandidate[];
  excluded: Array<{ reason: string; count: number }>;
  evaluations: StrategyEvaluation[];
  nameLedger: NameLedgerEntry[];
}

import { getStrategyEngineConfig, type EtapiStrategyEngineConfig } from "../../config/etapiConfig";
import { blackScholesGreeks, probabilityOfProfit } from "../../shared/riskMath";

const baseEngineConfig = getStrategyEngineConfig();
const DEFAULT_RATE = baseEngineConfig.riskFreeRate;
const DEFAULT_FEE_PER_CONTRACT = baseEngineConfig.feePerContract;
const DEFAULT_MAX_COMBINATIONS = baseEngineConfig.maxCombinations;
const DETAIL_LIMIT = baseEngineConfig.detailLimit;
const MAX_LEGS = baseEngineConfig.maxLegs;
const SCORE_WEIGHTS: StrategyScoreBreakdown["weights"] = baseEngineConfig.scoreWeights;

const NATIVE_WEIGHT_KEYS = ["thesisAlignment", "liquidity", "volatilityAlignment", "thetaBurden", "freshness"] as const;
const NATIVE_BLOCK_SHARE = 0.55;
const BIAS_BLOCK_SHARE = 0.45;

/**
 * The client ranker's bias interpolation, ported verbatim in shape
 * (getOptimizationFactors in the retired client discovery engine):
 * return weight falls and chance weight rises as bias goes 0 -> 100,
 * safety rises mildly with bias, capital efficiency with return-seeking.
 */
export function optimizationBiasFactors(bias: number) {
  const biasPct = Math.max(0, Math.min(100, bias));
  const chanceRatio = biasPct / 100;
  const returnRatio = 1 - chanceRatio;
  return {
    returnWeight: Math.round(10 + returnRatio * 50),
    chanceWeight: Math.round(10 + chanceRatio * 50),
    safetyWeight: Math.round(10 + chanceRatio * 15),
    capitalWeight: Math.round(10 + returnRatio * 10),
  };
}

/**
 * Effective score weights for a request (issue #29). Without a bias, the
 * configured weights apply unchanged. With a bias, the server-native
 * factors keep 55% of the total (in their configured proportions) and the
 * absorbed client lenses take 45%, split by optimizationBiasFactors:
 * return -> targetRewardRisk, chance -> popAlignment, safety -> cushion,
 * capital -> capitalEfficiency. Weights always sum to the configured total.
 */
export function resolveScoreWeights(bias?: number): StrategyScoreBreakdown["weights"] {
  if (bias === undefined || !Number.isFinite(bias)) return SCORE_WEIGHTS;
  const factors = optimizationBiasFactors(bias);
  const factorTotal = factors.returnWeight + factors.chanceWeight + factors.safetyWeight + factors.capitalWeight;
  const configuredTotal = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
  const nativeConfigured = NATIVE_WEIGHT_KEYS.reduce((sum, key) => sum + SCORE_WEIGHTS[key], 0);
  const nativeScale = nativeConfigured > 0 ? (NATIVE_BLOCK_SHARE * configuredTotal) / nativeConfigured : 0;
  const weights = { ...SCORE_WEIGHTS };
  for (const key of NATIVE_WEIGHT_KEYS) weights[key] = SCORE_WEIGHTS[key] * nativeScale;
  weights.targetRewardRisk = (BIAS_BLOCK_SHARE * configuredTotal * factors.returnWeight) / factorTotal;
  weights.popAlignment = (BIAS_BLOCK_SHARE * configuredTotal * factors.chanceWeight) / factorTotal;
  weights.cushion = (BIAS_BLOCK_SHARE * configuredTotal * factors.safetyWeight) / factorTotal;
  weights.capitalEfficiency = (BIAS_BLOCK_SHARE * configuredTotal * factors.capitalWeight) / factorTotal;
  return weights;
}

/** The no-view model's score components, in breakdown order (issue #534). */
export const NO_VIEW_SCORE_COMPONENTS = ["popAlignment", "cushion", "liquidity", "thetaBurden", "freshness"] as const;

/**
 * Effective no-view score weights (issue #534): the viewed machinery's
 * weights (resolveScoreWeights, so the bias slider keeps its meaning)
 * with the dropped keys removed and the five kept weights renormalized
 * proportionally, so they sum to the same configured total as the viewed
 * weights. Scores stay on the viewed 0-100 scale but are stamped
 * no-view-v1 and are not comparable to viewed scores.
 */
export function resolveNoViewScoreWeights(bias?: number): NoViewScoreWeights {
  const viewed = resolveScoreWeights(bias);
  const configuredTotal = Object.values(viewed).reduce((sum, w) => sum + w, 0);
  const keptTotal = NO_VIEW_SCORE_COMPONENTS.reduce((sum, key) => sum + viewed[key], 0);
  const scale = keptTotal > 0 ? configuredTotal / keptTotal : 0;
  return {
    popAlignment: viewed.popAlignment * scale,
    cushion: viewed.cushion * scale,
    liquidity: viewed.liquidity * scale,
    thetaBurden: viewed.thetaBurden * scale,
    freshness: viewed.freshness * scale,
  };
}

export const ALL_STRATEGY_TYPES: OptionStrategyType[] = defaultRegistry.ids();

export function strategyLabel(type: OptionStrategyType): string {
  return defaultRegistry.get(type)?.label ?? type;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function netDebit(legs: StrategyLeg[], fees: number): number {
  const signedEntry = legs.reduce((sum, leg) => {
    const sign = leg.side === "BUY" ? 1 : -1;
    return sum + sign * leg.entryPrice * leg.quantity * leg.multiplier;
  }, 0);
  return signedEntry + fees;
}

function sideSign(leg: StrategyLeg): number {
  return leg.side === "BUY" ? 1 : -1;
}

/** Days until the earliest option leg expires; the payoff horizon for single- and multi-expiry structures. */
function horizonDays(legs: StrategyLeg[]): number {
  const days = legs.filter((leg) => leg.optionType !== "STOCK").map((leg) => leg.daysToExpiration ?? 0);
  return days.length ? Math.min(...days) : 0;
}

function legValue(leg: StrategyLeg, spot: number, elapsedDays: number, rate: number, dividend: number, ivMultiplier: number): number {
  if (leg.optionType === "STOCK") return spot;
  const remaining = Math.max(0, (leg.daysToExpiration ?? 0) - elapsedDays);
  return blackScholes(leg, spot, remaining, rate, dividend, leg.impliedVolatility * ivMultiplier);
}

/** P/L at the nearest expiry; later-dated legs are valued with Black-Scholes. */
function expiryPnl(legs: StrategyLeg[], spot: number, fees: number, rate = DEFAULT_RATE, dividend = 0): number {
  const elapsed = horizonDays(legs);
  const value = legs.reduce((sum, leg) =>
    sum + sideSign(leg) * leg.quantity * leg.multiplier * legValue(leg, spot, elapsed, rate, dividend, 1), 0);
  return value - netDebit(legs, fees);
}

function riskProfile(legs: StrategyLeg[], fees: number, underlyingPrice: number, rate: number, dividend: number) {
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  const strikes = Array.from(new Set(optionLegs.map((leg) => leg.strike))).sort((a, b) => a - b);
  const upper = Math.max(underlyingPrice * 2, (strikes[strikes.length - 1] || underlyingPrice) * 2, 1);
  const horizon = horizonDays(legs);
  const curved = optionLegs.some((leg) => (leg.daysToExpiration ?? 0) > horizon);
  const grid = curved ? Array.from({ length: 119 }, (_, index) => (upper * (index + 1)) / 120) : [];
  const points = Array.from(new Set([0, ...strikes, ...grid, upper])).sort((a, b) => a - b);
  const values = points.map((spot) => ({ spot, pnl: expiryPnl(legs, spot, fees, rate, dividend) }));
  const callSlope = legs.reduce((sum, leg) => {
    if (leg.optionType === "PUT") return sum;
    return sum + sideSign(leg) * leg.quantity * leg.multiplier;
  }, 0);
  const pnls = values.map((point) => point.pnl);
  const flat = Math.max(...pnls) - Math.min(...pnls) < 0.01;
  const maxLoss = callSlope < 0 ? Infinity : Math.max(0, -Math.min(...pnls));
  const maxProfitUnbounded = callSlope > 0;
  const maxProfit = maxProfitUnbounded ? null : Math.max(0, ...pnls);
  const breakevens: number[] = [];

  for (let index = 0; index < values.length - 1; index++) {
    const left = values[index];
    const right = values[index + 1];
    if (left.pnl === 0) breakevens.push(left.spot);
    if ((left.pnl < 0 && right.pnl > 0) || (left.pnl > 0 && right.pnl < 0)) {
      breakevens.push(left.spot + ((-left.pnl) * (right.spot - left.spot)) / (right.pnl - left.pnl));
    }
  }
  const last = values[values.length - 1];
  if (last.pnl === 0) breakevens.push(last.spot);
  else if (callSlope !== 0) {
    const tailRoot = last.spot - last.pnl / callSlope;
    if (tailRoot > last.spot) breakevens.push(tailRoot);
  }

  return {
    maxLoss,
    maxProfit,
    maxProfitUnbounded,
    flat,
    breakevens: Array.from(new Set(breakevens.map((point) => Number(point.toFixed(2))))).sort((a, b) => a - b),
  };
}

/**
 * Probability of profit — delegates to the shared segment-integration
 * method in src/shared/riskMath.ts (issue #38): the client computes the
 * identical quantity from the identical code, so surfaces cannot diverge.
 * Exported for the cross-surface consistency test.
 */
export function impliedProbabilityOfProfit(
  legs: StrategyLeg[],
  breakEvenPoints: number[],
  underlying: number,
  fees: number,
  rate: number,
  dividend: number
): number {
  const dte = horizonDays(legs);
  if (dte <= 0) return expiryPnl(legs, underlying, fees, rate, dividend) > 0 ? 1 : 0;
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  const volatility = optionLegs.reduce((sum, leg) => sum + leg.impliedVolatility, 0) / Math.max(1, optionLegs.length);
  return probabilityOfProfit({
    spot: underlying,
    dteDays: dte,
    volatility,
    rate,
    dividend,
    breakevens: breakEvenPoints,
    isProfitAt: (testSpot) => expiryPnl(legs, testSpot, fees, rate, dividend) > 0,
  });
}

function blackScholes(leg: StrategyLeg, spot: number, daysToExpiry: number, rate: number, dividend: number, iv: number): number {
  if (daysToExpiry <= 0 || iv <= 0 || spot <= 0) {
    return leg.optionType === "CALL" ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
  }
  return blackScholesGreeks(spot, leg.strike, daysToExpiry / 365, iv, rate, dividend, leg.optionType as "CALL" | "PUT").price;
}

function modeledPnl(
  legs: StrategyLeg[],
  spot: number,
  elapsedDays: number,
  fees: number,
  rate: number,
  dividend: number,
  ivMultiplier: number
): number {
  const value = legs.reduce((sum, leg) =>
    sum + sideSign(leg) * leg.quantity * leg.multiplier * legValue(leg, spot, elapsedDays, rate, dividend, ivMultiplier), 0);
  return value - netDebit(legs, fees);
}

function daysUntil(date: string): number {
  const target = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(target.getTime())) throw new Error("targetDate must be an ISO date");
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86_400_000));
}

function makeScenarioGrid(
  legs: StrategyLeg[],
  underlying: number,
  dte: number,
  targetDays: number,
  fees: number,
  rate: number,
  dividend: number
): StrategyScenario[] {
  const priceShocks = [-0.2, -0.1, 0, 0.1, 0.2];
  const ivShocks = [-0.3, -0.15, 0, 0.15, 0.3];
  const dates = Array.from(new Set([0, 7, 14, Math.min(targetDays, dte), dte])).sort((a, b) => a - b);
  return dates.flatMap((elapsedDays) => priceShocks.flatMap((priceShock) => ivShocks.map((ivShock) => {
    const remaining = Math.max(0, dte - elapsedDays);
    return {
      underlyingPrice: Number((underlying * (1 + priceShock)).toFixed(2)),
      daysToExpiry: remaining,
      ivChangePct: ivShock * 100,
      pnl: Number(modeledPnl(
        legs,
        underlying * (1 + priceShock),
        Math.min(elapsedDays, dte),
        fees,
        rate,
        dividend,
        1 + ivShock
      ).toFixed(2)),
    };
  })));
}

type BuildOutcome = { candidate: StrategyCandidate } | { reason: string };

/** The request fields candidate construction reads that both request
 *  shapes carry identically (issue #534). */
interface CandidateCoreInputs {
  feesPerContract?: number;
  riskFreeRate?: number;
  dividendYield?: number;
  eventPolicy?: "warn" | "exclude";
  eventCalendar?: EventCalendarInfo;
}

/**
 * Everything about a built candidate that does not depend on a user
 * view: the leg/data guards, the risk profile, and the target-free
 * score components. Shared by the viewed builder and the no-view
 * builder (issue #534) so the two modes can never drift on risk or
 * data rules — they differ only in how a view (or its absence) scores.
 */
interface CandidateCore {
  dataFreshness: "FRESH" | "STALE" | "UNKNOWN";
  underlying: number;
  dte: number;
  feePerContract: number;
  fees: number;
  debit: number;
  rate: number;
  dividend: number;
  risk: ReturnType<typeof riskProfile>;
  modelImpliedProbabilityOfProfit: number;
  liquidityScore: number;
  netVega: number;
  netTheta: number;
  thetaBurden: number;
  freshnessScore: number;
  popAlignment: number;
  cushion: number;
  warnings: string[];
  nearest: StrategyLeg;
}

interface UpcomingEvent {
  /** Display label: "Earnings" / "Ex-dividend date". */
  label: string;
  days: number;
  date: string | null;
}

/** Upcoming calendar events for a covered name, soonest first. Past or
 *  absent dates never appear — the engine does not guess (issue #16). */
function upcomingEvents(info: EventCalendarInfo | undefined): UpcomingEvent[] {
  if (!info?.covered) return [];
  const events: UpcomingEvent[] = [];
  if (info.daysToEarnings != null && info.daysToEarnings >= 0) {
    events.push({ label: "Earnings", days: info.daysToEarnings, date: info.earningsDate ?? null });
  }
  if (info.daysToExDiv != null && info.daysToExDiv >= 0) {
    events.push({ label: "Ex-dividend date", days: info.daysToExDiv, date: info.exDividendDate ?? null });
  }
  return events.sort((a, b) => a.days - b.days);
}

function dayCount(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

function eventPhrase(event: UpcomingEvent): string {
  return `${event.label.toLowerCase()} in ${dayCount(event.days)}${event.date ? ` (${event.date})` : ""}`;
}

/** Candidate warnings replacing the pre-#16 "not connected" line: with
 *  coverage, each known event is annotated with its distance to the
 *  candidate's final expiry; without coverage the unverified warning
 *  stands verbatim. */
function eventWarnings(info: EventCalendarInfo | undefined, finalExpiryDte: number): string[] {
  if (!info?.covered) {
    return ["Earnings and dividend dates are not connected; event risk is unverified."];
  }
  const events = upcomingEvents(info);
  if (events.length === 0) {
    return ["Event calendar checked: no earnings or ex-dividend date is scheduled before this candidate's final expiry."];
  }
  return events.map((event) =>
    `${event.label} in ${dayCount(event.days)}${event.date ? ` (${event.date})` : ""} — ${event.days <= finalExpiryDte ? "before" : "after"} this candidate's final expiry.`
  );
}

/** The eventPolicy "exclude" gate (issue #16): with coverage, only a
 *  candidate whose horizon spans an event is withheld, and the reason
 *  names the event; without coverage the pre-#16 unverified withholding
 *  stands (the recommend paths also short-circuit that case before any
 *  candidate is built, preserving the historical result shape). */
function eventExclusionReason(info: EventCalendarInfo | undefined, label: string, finalExpiryDte: number): string | null {
  if (!info?.covered) {
    return `${label} withheld because event risk cannot be verified`;
  }
  const spanning = upcomingEvents(info).find((event) => event.days <= finalExpiryDte);
  if (!spanning) return null;
  return `${label} withheld: ${eventPhrase(spanning)} falls before this candidate's ${finalExpiryDte}-day horizon (eventPolicy "exclude")`;
}

/** Result-level honesty lines for the calendar: a covered run states
 *  the connection instead of claiming event risk is unverified. */
function eventAssumptionLines(info: EventCalendarInfo | undefined): string[] {
  if (!info?.covered) {
    return [
      "No point-in-time earnings/dividend calendar or portfolio positions are connected.",
      "Event risk is unverified and should be checked before acting.",
    ];
  }
  return [
    `Earnings/dividend calendar connected (${info.source ?? "live calendar source"}); event dates are point-in-time as of this run, and candidates are annotated with days-to-event.`,
  ];
}

type CoreOutcome = { core: CandidateCore } | { reason: string };

function buildCandidateCore(
  def: StrategyDefinition,
  legs: StrategyLeg[],
  contractMap: Map<string, ScreenedOptionContractItem>,
  inputs: CandidateCoreInputs
): CoreOutcome {
  const label = def.label;
  if (legs.length < 1 || legs.length > MAX_LEGS) return { reason: `${label} has an unsupported number of legs (${legs.length})` };
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  if (optionLegs.some((leg) => !leg.entryPrice || leg.entryPrice <= 0)) {
    return { reason: `${label} has incomplete or unsupported contract data (a leg has no usable bid/ask)` };
  }
  if (optionLegs.some((leg) => leg.impliedVolatility <= 0)) {
    return { reason: `${label} has incomplete or unsupported contract data (a leg has no implied volatility)` };
  }

  const contracts = optionLegs.map((leg) => contractMap.get(leg.symbol)).filter((item): item is ScreenedOptionContractItem => Boolean(item));
  if (contracts.length !== optionLegs.length || contracts.length === 0) {
    return { reason: `${label} has incomplete or unsupported contract data (leg not found in the chain)` };
  }
  const freshnessStates = contracts.map((contract) => contract.quoteFreshness || "UNKNOWN");
  const dataFreshness = freshnessStates.includes("STALE")
    ? "STALE" as const
    : freshnessStates.includes("UNKNOWN") ? "UNKNOWN" as const : "FRESH" as const;
  const underlying = contracts[0].underlyingPrice;
  const dte = horizonDays(legs);
  const finalExpiryDte = Math.max(0, ...optionLegs.map((leg) => leg.daysToExpiration ?? 0));
  const feePerContract = inputs.feesPerContract ?? DEFAULT_FEE_PER_CONTRACT;
  const fees = optionLegs.reduce((sum, leg) => sum + leg.quantity * feePerContract, 0);
  const debit = netDebit(legs, fees);
  const rate = inputs.riskFreeRate ?? DEFAULT_RATE;
  const dividend = inputs.dividendYield ?? 0;
  const risk = riskProfile(legs, fees, underlying, rate, dividend);
  if (risk.flat) {
    const locked = expiryPnl(legs, underlying, fees, rate, dividend);
    return {
      reason: locked > 0
        ? `${label} shows an apparent riskless profit of $${locked.toFixed(2)}; this almost always means stale/crossed quotes or ignored carry, dividends, borrow and assignment risk`
        : `${label} has a locked payoff (constant $${locked.toFixed(2)} at every price): it only expresses a financing/carry rate, not a trade thesis`,
    };
  }
  if (!Number.isFinite(risk.maxLoss)) {
    return { reason: `${label} has unlimited loss potential (net short upside exposure) and is excluded from defined-risk ranking` };
  }
  if (risk.maxLoss <= 0) return { reason: `${label} shows no modeled downside, which indicates stale or crossed quotes` };
  if (inputs.eventPolicy === "exclude") {
    const exclusion = eventExclusionReason(inputs.eventCalendar, label, finalExpiryDte);
    if (exclusion) return { reason: exclusion };
  }

  const modelImpliedProbabilityOfProfit = impliedProbabilityOfProfit(legs, risk.breakevens, underlying, fees, rate, dividend);
  const liquidityScore = contracts.reduce((sum, contract) => {
    const spread = clamp(100 - contract.spreadPct * 5);
    const activity = clamp(40 + 12 * Math.log10(Math.max(1, contract.volume ?? 0)) + 8 * Math.log10(Math.max(1, contract.openInterest ?? 0)));
    return sum + (spread * 0.7 + activity * 0.3) / contracts.length;
  }, 0);
  const netVega = legs.reduce((sum, leg) => sum + sideSign(leg) * leg.vega * leg.multiplier * leg.quantity, 0);
  const netTheta = legs.reduce((sum, leg) => sum + sideSign(leg) * leg.theta * leg.multiplier * leg.quantity, 0);
  const thetaBurden = clamp(100 - Math.max(0, -netTheta) / Math.max(1, risk.maxLoss) * 10_000);
  const freshnessScore = dataFreshness === "FRESH" ? 100 : dataFreshness === "STALE" ? 25 : 0;
  // Absorbed client lenses (issue #29), formulas ported from the client
  // engine's analyzeStrategy so both surfaces meant the same thing:
  // cushion = nearest-breakeven distance from spot. (The third lens,
  // capital efficiency, is target-derived and lives in the viewed
  // builder only.)
  const popAlignment = clamp(modelImpliedProbabilityOfProfit * 100);
  const cushionPct = risk.breakevens.length > 0
    ? Math.min(...risk.breakevens.map((b) => Math.abs(b - underlying))) / underlying * 100
    : 0;
  const cushion = clamp(Math.max(5, Math.min(100, Math.round(cushionPct * 4))));
  const warnings = [
    "Pre-expiry P/L is a Black-Scholes estimate, not a forecast or executable quote.",
    ...eventWarnings(inputs.eventCalendar, finalExpiryDte),
    "Early exercise, assignment, margin, and execution slippage are not modeled.",
  ];
  if (def.usesStock) {
    const shares = legs.find((leg) => leg.optionType === "STOCK")?.quantity ?? 0;
    warnings.unshift(`Includes ${shares} hypothetical shares at $${underlying.toFixed(2)}; verify actual holdings, margin and borrow availability.`);
  }
  if (def.multiExpiry) {
    warnings.unshift("Multi-expiry structure: payoff is shown at the nearest expiry with later legs valued by Black-Scholes; results are sensitive to the IV assumption.");
  }
  if (dataFreshness === "STALE") {
    const age = Math.max(...contracts.map((contract) => contract.quoteAgeSeconds ?? 0));
    warnings.unshift(`Stale quote data: oldest leg is ${Math.round(age).toLocaleString()}s old. Candidate is indicative research only.`);
  } else if (dataFreshness === "UNKNOWN") {
    warnings.unshift("Quote timestamp is unavailable for at least one leg. Freshness cannot be verified; research only.");
  }
  const nearest = optionLegs.reduce((best, leg) => ((leg.daysToExpiration ?? 0) < (best.daysToExpiration ?? 0) ? leg : best), optionLegs[0]);

  return {
    core: {
      dataFreshness,
      underlying,
      dte,
      feePerContract,
      fees,
      debit,
      rate,
      dividend,
      risk,
      modelImpliedProbabilityOfProfit,
      liquidityScore,
      netVega,
      netTheta,
      thetaBurden,
      freshnessScore,
      popAlignment,
      cushion,
      warnings,
      nearest,
    },
  };
}

function buildCandidate(
  def: StrategyDefinition,
  legs: StrategyLeg[],
  contractMap: Map<string, ScreenedOptionContractItem>,
  request: StrategyRequest,
  targetDays: number
): BuildOutcome {
  const built = buildCandidateCore(def, legs, contractMap, request);
  if ("reason" in built) return built;
  const { core } = built;
  const label = def.label;
  const { risk } = core;
  const underlying = core.underlying;
  const dte = core.dte;
  const fees = core.fees;
  const rate = core.rate;
  const dividend = core.dividend;

  const targetElapsed = Math.min(targetDays, dte);
  const ivMultiplier = request.expectedIvDirection === "rise" ? 1.15 : request.expectedIvDirection === "fall" ? 0.85 : 1;
  const targetPnl = modeledPnl(legs, request.targetPrice, targetElapsed, fees, rate, dividend, ivMultiplier);
  const targetRewardRisk = targetPnl / risk.maxLoss;
  const aligned = def.theses.includes(request.thesis);
  const thesisAlignment = targetPnl > 0 && aligned
    ? clamp(50 + 25 * Math.log2(1 + Math.max(0, targetRewardRisk)))
    : aligned ? clamp(25 + targetRewardRisk * 10) : 10;
  const volatilityAlignment = request.expectedIvDirection === "unchanged"
    ? 70
    : (request.expectedIvDirection === "rise" ? core.netVega : -core.netVega) >= 0 ? 100 : 20;
  const rewardRiskScore = clamp(targetRewardRisk / Math.max(request.minRewardRisk, 0.25) * 70);
  // The maxLoss floor is 1% of per-contract notional (underlying × 100
  // multiplier × 1% = underlying dollars), NOT a flat $100 (issue #25):
  // a fixed-dollar floor is an absolute-dollar term in an otherwise
  // scale-free score — it silently penalizes cheap names whose maxLoss
  // sits under the constant while leaving expensive names untouched, so
  // cross-name comparisons mixed units. A notional-relative floor keeps
  // the guard against tiny-maxLoss blowups at every price scale.
  const capitalEfficiency = risk.maxLoss > 0
    ? clamp(Math.max(10, Math.min(100, Math.round(targetPnl / Math.max(underlying, risk.maxLoss) * 100))))
    : 50;
  const effectiveWeights = resolveScoreWeights(request.optimizationBias);
  const scoreBreakdown: StrategyScoreBreakdown = {
    thesisAlignment,
    targetRewardRisk: rewardRiskScore,
    liquidity: core.liquidityScore,
    volatilityAlignment,
    thetaBurden: core.thetaBurden,
    freshness: core.freshnessScore,
    popAlignment: core.popAlignment,
    cushion: core.cushion,
    capitalEfficiency,
    weights: effectiveWeights,
  };
  const score = Object.entries(effectiveWeights).reduce((sum, [key, weight]) =>
    sum + scoreBreakdown[key as keyof typeof effectiveWeights] * weight, 0);

  const explanations = [
    `${label} matches the ${request.thesis.replaceAll("_", " ")} thesis. ${def.description}`,
    `Conservative entry uses asks for buys and bids for sells; estimated fees are $${fees.toFixed(2)}.`,
    `Target-date modeled P/L is $${targetPnl.toFixed(2)} (${targetRewardRisk.toFixed(2)}x max loss).`,
  ];

  return {
    candidate: {
      id: `${def.id}:${legs.map((leg) => leg.symbol).join("+")}`,
      rank: 0,
      type: def.id,
      label,
      symbol: request.symbol.toUpperCase(),
      underlyingPrice: underlying,
      expirationDate: core.nearest.expirationDate,
      dataFreshness: core.dataFreshness,
      legs,
      netDebit: Number(core.debit.toFixed(2)),
      estimatedFees: Number(fees.toFixed(2)),
      maxProfit: risk.maxProfit === null ? null : Number(risk.maxProfit.toFixed(2)),
      maxProfitUnbounded: risk.maxProfitUnbounded,
      maxLoss: Number(risk.maxLoss.toFixed(2)),
      breakevens: risk.breakevens,
      targetPnl: Number(targetPnl.toFixed(2)),
      targetRewardRisk: Number(targetRewardRisk.toFixed(2)),
      modelImpliedProbabilityOfProfit: Number(core.modelImpliedProbabilityOfProfit.toFixed(4)),
      netGreeks: {
        delta: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.delta * leg.multiplier * leg.quantity, 0),
        gamma: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.gamma * leg.multiplier * leg.quantity, 0),
        theta: core.netTheta,
        vega: core.netVega,
      },
      liquidityScore: Number(core.liquidityScore.toFixed(1)),
      score: Number(score.toFixed(1)),
      scoreBreakdown,
      payoffCurve: [],
      scenarios: [],
      explanations,
      warnings: core.warnings,
      assumptions: [
        `Risk-free rate ${(rate * 100).toFixed(2)}%; dividend yield ${(dividend * 100).toFixed(2)}%.`,
        `Multiplier ${MULTIPLIER}; ${core.feePerContract} estimated fees per option contract.`,
        `Option marks use conservative bid/ask-side entry; scenario marks use Black-Scholes.`,
      ],
    },
  };
}

/** Payoff curve and scenario grid are costly, so they are computed only for the candidates that are returned.
 *  Generic over the candidate shape so the no-view path (issue #534) attaches
 *  detail with expiry-anchored scenarios instead of a target date. */
function attachDetail<T extends Pick<StrategyCandidate, "breakevens" | "legs" | "underlyingPrice" | "estimatedFees" | "payoffCurve" | "scenarios">>(
  candidate: T,
  request: Pick<StrategyRequest, "riskFreeRate" | "dividendYield">,
  targetDays: number
): T {
  const rate = request.riskFreeRate ?? DEFAULT_RATE;
  const dividend = request.dividendYield ?? 0;
  const underlying = candidate.underlyingPrice;
  const fees = candidate.estimatedFees;
  // Strikes and breakevens are included so the kinks of the payoff line are exact.
  const keyPoints = [...candidate.breakevens, ...candidate.legs.filter((leg) => leg.optionType !== "STOCK").map((leg) => leg.strike)]
    .filter((price) => price >= underlying * 0.5 && price <= underlying * 1.5);
  const priceRange = Array.from(new Set([
    ...Array.from({ length: 41 }, (_, index) => Number((underlying * (0.5 + index * 0.025)).toFixed(2))),
    ...keyPoints.map((price) => Number(price.toFixed(2))),
  ])).sort((a, b) => a - b);
  return {
    ...candidate,
    payoffCurve: priceRange.map((spot) => ({
      underlyingPrice: Number(spot.toFixed(2)),
      pnl: Number(expiryPnl(candidate.legs, spot, fees, rate, dividend).toFixed(2)),
    })),
    scenarios: makeScenarioGrid(candidate.legs, underlying, horizonDays(candidate.legs), targetDays, fees, rate, dividend),
  };
}

export interface CandidateRevisionOptions {
  underlyingPrice?: number;
  targetPrice?: number;
  targetDate?: string;
  expectedIvDirection?: ExpectedIvDirection;
  feesPerContract?: number;
  riskFreeRate?: number;
  dividendYield?: number;
}

/** Re-derives a candidate's cost, risk, payoff and Greeks after its legs were swapped for other strikes/expiries or re-quoted. */
export function reviseCandidate(candidate: StrategyCandidate, legs: StrategyLeg[], options: CandidateRevisionOptions = {}): StrategyCandidate {
  const rate = options.riskFreeRate ?? DEFAULT_RATE;
  const dividend = options.dividendYield ?? 0;
  const underlying = options.underlyingPrice ?? candidate.underlyingPrice;
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  const fees = optionLegs.reduce((sum, leg) => sum + leg.quantity * (options.feesPerContract ?? DEFAULT_FEE_PER_CONTRACT), 0);
  const risk = riskProfile(legs, fees, underlying, rate, dividend);
  const horizon = horizonDays(legs);
  const parsedTarget = options.targetDate ? new Date(`${options.targetDate}T00:00:00Z`).getTime() : NaN;
  const targetDays = Number.isFinite(parsedTarget) ? daysUntil(options.targetDate!) : horizon;
  const ivMultiplier = options.expectedIvDirection === "rise" ? 1.15 : options.expectedIvDirection === "fall" ? 0.85 : 1;
  const targetPnl = options.targetPrice && options.targetPrice > 0
    ? modeledPnl(legs, options.targetPrice, Math.min(targetDays, horizon), fees, rate, dividend, ivMultiplier)
    : candidate.targetPnl;
  const maxLossFinite = Number.isFinite(risk.maxLoss) && risk.maxLoss > 0;
  const states = optionLegs.map((leg) => leg.quoteFreshness);
  const nearest = optionLegs.length
    ? optionLegs.reduce((best, leg) => ((leg.daysToExpiration ?? 0) < (best.daysToExpiration ?? 0) ? leg : best), optionLegs[0])
    : undefined;
  const sum = (pick: (leg: StrategyLeg) => number) => legs.reduce((total, leg) => total + sideSign(leg) * pick(leg) * leg.multiplier * leg.quantity, 0);
  const liquidity = optionLegs.length
    ? optionLegs.reduce((total, leg) => {
      const spread = clamp(100 - leg.spreadPct * 5);
      const activity = clamp(40 + 12 * Math.log10(Math.max(1, leg.volume)) + 8 * Math.log10(Math.max(1, leg.openInterest)));
      return total + (spread * 0.7 + activity * 0.3) / optionLegs.length;
    }, 0)
    : candidate.liquidityScore;

  return attachDetail({
    ...candidate,
    underlyingPrice: underlying,
    expirationDate: nearest?.expirationDate ?? candidate.expirationDate,
    dataFreshness: states.includes("STALE") ? "STALE" : states.includes("UNKNOWN") ? "UNKNOWN" : "FRESH",
    legs,
    netDebit: Number(netDebit(legs, fees).toFixed(2)),
    estimatedFees: Number(fees.toFixed(2)),
    maxProfit: risk.maxProfit === null ? null : Number(risk.maxProfit.toFixed(2)),
    maxProfitUnbounded: risk.maxProfitUnbounded,
    maxLoss: Number.isFinite(risk.maxLoss) ? Number(risk.maxLoss.toFixed(2)) : risk.maxLoss,
    breakevens: risk.breakevens,
    targetPnl: Number(targetPnl.toFixed(2)),
    targetRewardRisk: maxLossFinite ? Number((targetPnl / risk.maxLoss).toFixed(2)) : 0,
    modelImpliedProbabilityOfProfit: Number(impliedProbabilityOfProfit(legs, risk.breakevens, underlying, fees, rate, dividend).toFixed(4)),
    netGreeks: { delta: sum((leg) => leg.delta), gamma: sum((leg) => leg.gamma), theta: sum((leg) => leg.theta), vega: sum((leg) => leg.vega) },
    liquidityScore: Number(liquidity.toFixed(1)),
  }, { riskFreeRate: rate, dividendYield: dividend } as StrategyRequest, Math.min(targetDays, horizon));
}

function addRejected(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, (reasons.get(reason) || 0) + 1);
}

export function recommendOptionStrategies(
  contracts: ScreenedOptionContractItem[],
  request: StrategyRequest,
  limit?: number
): StrategyRecommendationResult {
  if (!request.symbol.trim()) throw new Error("symbol is required");
  if (!Number.isFinite(request.targetPrice) || request.targetPrice <= 0) throw new Error("targetPrice must be positive");
  if (!Number.isFinite(request.maxPlannedLoss) || request.maxPlannedLoss <= 0) throw new Error("maxPlannedLoss must be positive");
  if (!Number.isFinite(request.minRewardRisk) || request.minRewardRisk < 0) throw new Error("minRewardRisk must be non-negative");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("candidate limit must be a positive whole number");
  if (request.maxStrikesPerSide !== undefined && (!Number.isInteger(request.maxStrikesPerSide) || request.maxStrikesPerSide < 1)) throw new Error("maxStrikesPerSide must be a positive whole number");
  if (request.maxIronCondors !== undefined && (!Number.isInteger(request.maxIronCondors) || request.maxIronCondors < 0)) throw new Error("maxIronCondors must be a non-negative whole number");
  const minDte = request.minDte ?? 0;
  const maxDte = request.maxDte ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(minDte) || minDte < 0 || !Number.isInteger(maxDte) || maxDte < minDte) {
    throw new Error("DTE range must use whole days with a maximum greater than or equal to minimum");
  }
  const registry = defaultRegistry;
  const ledger = new EvaluationLedger(registry.list());
  const wanted = new Set(registry.resolveMany(request.allowedStrategies).ids);
  // Issue #2600: one mode resolution for selection — the alias is
  // resolved once here, not per call site. A conflicting pair throws
  // (schema boundaries reject it first, so engine callers see it only
  // when they built the request by hand).
  const strategyMode = resolveStrategyMode(request);
  const selectedDefs = filterDefinitionsByMode(registry.list(), wanted, strategyMode, request.thesis);
  const finish = (partial: Omit<StrategyRecommendationResult, "evaluations" | "nameLedger">): StrategyRecommendationResult => {
    const evaluations = ledger.report();
    return { ...partial, evaluations, nameLedger: buildNameLedger(evaluations) };
  };

  if (request.eventPolicy === "exclude" && !request.eventCalendar?.covered) {
    registry.list().forEach((def) => ledger.onSkipped(def, "Skipped: event-risk exclusion cannot be verified without an event calendar."));
    return finish({
      status: "no_candidates",
      request,
      generatedAt: new Date().toISOString(),
      modelVersion: "options-risk-v2",
      dataSource: "E*TRADE option-chain snapshot",
      assumptions: ["Candidates were withheld because earnings/dividend calendar verification is unavailable."],
      scoreWeights: resolveScoreWeights(request.optimizationBias),
      candidates: [],
      excluded: [{ reason: "Event-risk exclusion cannot be verified without an event calendar", count: contracts.length }],
    });
  }
  const targetDays = daysUntil(request.targetDate);
  const strategyDataMaxDte = Math.max(maxDte, ...selectedDefs.map((def) => def.dataHorizonDte ?? 0));
  const normalized = contracts.filter((contract) =>
    contract.underlyingSymbol.toUpperCase() === request.symbol.toUpperCase() &&
    contract.daysToExpiration >= minDte &&
    contract.daysToExpiration <= strategyDataMaxDte
  );
  const byExpiry = new Map<string, ScreenedOptionContractItem[]>();
  for (const contract of normalized) {
    byExpiry.set(contract.expirationDate, [...(byExpiry.get(contract.expirationDate) || []), contract]);
  }
  const closest = (items: ScreenedOptionContractItem[]) => items
    .sort((a, b) => Math.abs(a.strikePrice - a.underlyingPrice) - Math.abs(b.strikePrice - b.underlyingPrice))
    .slice(0, request.maxStrikesPerSide ?? items.length);
  const chains: ChainView[] = Array.from(byExpiry.entries()).map(([expiration, items]) => ({
    expiration,
    dte: items[0].daysToExpiration,
    calls: new Map(closest(items.filter((item) => item.optionType === "CALL")).map((item) => [item.strikePrice, item])),
    puts: new Map(closest(items.filter((item) => item.optionType === "PUT")).map((item) => [item.strikePrice, item])),
  })).sort((a, b) => a.dte - b.dte);
  const context: StrategyContext = {
    request,
    symbol: request.symbol.toUpperCase(),
    underlying: normalized[0]?.underlyingPrice ?? 0,
    chains,
    stockShares: 100,
  };

  const rejected = new Map<string, number>();
  const candidates: StrategyCandidate[] = [];

  for (const def of registry.list()) {
    if (!wanted.has(def.id)) {
      ledger.onSkipped(def, "Skipped: not selected in this request.");
      continue;
    }
    if (strategyMode !== "all" && !def.theses.includes(request.thesis)) {
      const reason = `${def.label} conflicts with the selected ${request.thesis.replaceAll("_", " ")} thesis`;
      ledger.onSkipped(def, `Skipped: ${reason}.`);
      addRejected(rejected, reason);
      continue;
    }
    // DTE ceilings apply to the ordinary scan window. A strategy may also
    // need contracts beyond that window (e.g. LEAPS or a PMCC far leg); the
    // catalog declares that floor, and only that strategy receives those
    // extended expirations. For multi-expiry templates maxDte still bounds
    // eligible near legs (see template.expiryPairs).
    const strategyNormalized = normalized.filter((contract) =>
      contract.daysToExpiration <= maxDte ||
      (def.dataHorizonDte !== undefined && contract.daysToExpiration <= def.dataHorizonDte)
    );
    const strategyByExpiry = new Map<string, ScreenedOptionContractItem[]>();
    for (const contract of strategyNormalized) {
      strategyByExpiry.set(contract.expirationDate, [...(strategyByExpiry.get(contract.expirationDate) || []), contract]);
    }
    const strategyChains: ChainView[] = Array.from(strategyByExpiry.entries()).map(([expiration, items]) => ({
      expiration,
      dte: items[0].daysToExpiration,
      calls: new Map(closest(items.filter((item) => item.optionType === "CALL")).map((item) => [item.strikePrice, item])),
      puts: new Map(closest(items.filter((item) => item.optionType === "PUT")).map((item) => [item.strikePrice, item])),
    })).sort((a, b) => a.dte - b.dte);
    const strategyContext = { ...context, chains: strategyChains };
    const strategyContractMap = new Map(strategyNormalized.map((contract) => [contractKey(contract), contract]));
    if (strategyContext.chains.length === 0) {
      ledger.onSkipped(def, `Skipped: no ${context.symbol} option contracts are available inside the DTE window.`);
      continue;
    }
    if (def.id === "iron_condor" && request.maxIronCondors === 0) {
      ledger.onSkipped(def, "Skipped: iron condor generation is disabled (maxIronCondors = 0).");
      continue;
    }
    const cap = def.id === "iron_condor" && request.maxIronCondors !== undefined ? request.maxIronCondors : DEFAULT_MAX_COMBINATIONS;
    const generated = def.generate(strategyContext, cap);
    ledger.onGenerated(def, generated.sets.length, generated.truncated, generated.skipReason);
    for (const legs of generated.sets) {
      const outcome = buildCandidate(def, legs, strategyContractMap, request, targetDays);
      const reason = "candidate" in outcome ? runAcceptanceRules(outcome.candidate, request) : outcome.reason;
      if (reason) {
        ledger.onRejected(def, reason);
        addRejected(rejected, reason);
        continue;
      }
      if ("candidate" in outcome) {
        ledger.onAccepted(def, outcome.candidate);
        candidates.push(outcome.candidate);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.liquidityScore - a.liquidityScore || a.id.localeCompare(b.id));
  const selectedCandidates = limit === undefined ? candidates : candidates.slice(0, limit);
  const ranked = selectedCandidates.map((candidate, index) => {
    const withRank = { ...candidate, rank: index + 1 };
    return index < DETAIL_LIMIT ? attachDetail(withRank, request, targetDays) : withRank;
  });
  const assumptions = [
    "Research ranking only; it is not a prediction, personalized advice, or an order instruction.",
    "Pre-expiry values use Black-Scholes with the supplied IV, risk-free rate, and dividend yield.",
    "Probability of profit is model-implied under a risk-neutral lognormal terminal-price distribution using average leg IV; it is not a forecast.",
    "Stock-based strategies assume 100 hypothetical shares; actual holdings, margin and borrow are not connected.",
    ...eventAssumptionLines(request.eventCalendar),
  ];

  return finish({
    status: ranked.length > 0 ? "ranked_candidates" : "no_candidates",
    request,
    generatedAt: new Date().toISOString(),
    modelVersion: "options-risk-v2",
    dataSource: "E*TRADE option-chain snapshot",
    assumptions,
    scoreWeights: resolveScoreWeights(request.optimizationBias),
    candidates: ranked,
    excluded: Array.from(rejected, ([reason, count]) => ({ reason, count })),
  });
}

type NoViewBuildOutcome = { candidate: NoViewStrategyCandidate } | { reason: string };

function buildNoViewCandidate(
  def: StrategyDefinition,
  legs: StrategyLeg[],
  contractMap: Map<string, ScreenedOptionContractItem>,
  request: NoViewStrategyRequest
): NoViewBuildOutcome {
  const built = buildCandidateCore(def, legs, contractMap, request);
  if ("reason" in built) return built;
  const { core } = built;
  const label = def.label;
  const { risk } = core;
  const underlying = core.underlying;
  const fees = core.fees;
  const rate = core.rate;
  const dividend = core.dividend;

  // Structure-defined reward/risk: both sides of the ratio come from the
  // structure's own payoff — expiry-native, no view anywhere. Unbounded
  // profit records null, never Infinity; the POP and max-loss gates
  // carry those structures instead.
  const structureRewardRisk = risk.maxProfit === null
    ? null
    : Number((risk.maxProfit / risk.maxLoss).toFixed(2));
  const weights = resolveNoViewScoreWeights(request.optimizationBias);
  const scoreBreakdown: NoViewScoreBreakdown = {
    popAlignment: core.popAlignment,
    cushion: core.cushion,
    liquidity: core.liquidityScore,
    thetaBurden: core.thetaBurden,
    freshness: core.freshnessScore,
    weights,
  };
  const score = NO_VIEW_SCORE_COMPONENTS.reduce((sum, key) => sum + scoreBreakdown[key] * weights[key], 0);
  // The strategy type's declared posture is descriptive metadata about
  // the structure (a bull put spread is a bullish-leaning TYPE); it is
  // never an inferred view of the symbol.
  const posture = def.theses.map((thesis) => thesis.replaceAll("_", " ")).join(" / ");
  const explanations = [
    `${label} is a ${posture}-leaning structure type by construction — a property of the strategy, not a view of ${request.symbol.toUpperCase()}. ${def.description}`,
    `Conservative entry uses asks for buys and bids for sells; estimated fees are $${fees.toFixed(2)}.`,
    risk.maxProfit === null
      ? `No view was supplied or derived: profit is unbounded; max loss is $${risk.maxLoss.toFixed(2)} and model-implied POP is ${(core.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%.`
      : `No view was supplied or derived: structure-defined max profit is $${risk.maxProfit.toFixed(2)} (${structureRewardRisk?.toFixed(2)}x max loss of $${risk.maxLoss.toFixed(2)}); model-implied POP is ${(core.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%.`,
  ];

  return {
    candidate: {
      id: `${def.id}:${legs.map((leg) => leg.symbol).join("+")}`,
      rank: 0,
      type: def.id,
      label,
      symbol: request.symbol.toUpperCase(),
      underlyingPrice: underlying,
      expirationDate: core.nearest.expirationDate,
      dataFreshness: core.dataFreshness,
      legs,
      netDebit: Number(core.debit.toFixed(2)),
      estimatedFees: Number(fees.toFixed(2)),
      maxProfit: risk.maxProfit === null ? null : Number(risk.maxProfit.toFixed(2)),
      maxProfitUnbounded: risk.maxProfitUnbounded,
      maxLoss: Number(risk.maxLoss.toFixed(2)),
      breakevens: risk.breakevens,
      modelImpliedProbabilityOfProfit: Number(core.modelImpliedProbabilityOfProfit.toFixed(4)),
      netGreeks: {
        delta: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.delta * leg.multiplier * leg.quantity, 0),
        gamma: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.gamma * leg.multiplier * leg.quantity, 0),
        theta: core.netTheta,
        vega: core.netVega,
      },
      liquidityScore: Number(core.liquidityScore.toFixed(1)),
      score: Number(score.toFixed(1)),
      scoreBreakdown,
      payoffCurve: [],
      scenarios: [],
      explanations,
      warnings: core.warnings,
      assumptions: [
        `Risk-free rate ${(rate * 100).toFixed(2)}%; dividend yield ${(dividend * 100).toFixed(2)}%.`,
        `Multiplier ${MULTIPLIER}; ${core.feePerContract} estimated fees per option contract.`,
        `Option marks use conservative bid/ask-side entry; scenario marks use Black-Scholes.`,
      ],
      structureRewardRisk,
      scoreModel: NO_VIEW_SCORE_MODEL,
    },
  };
}

/**
 * The no-view engine entry (issue #534): rank the structures a symbol's
 * chain supports under constraints only. No view is supplied, derived,
 * or inferred — generation runs over every selected definition (there
 * is no thesis filter), scoring uses the no-view-v1 model, and the
 * acceptance gates are the no-view replacements in the ledger. The
 * viewed entry above is untouched and behaves byte-identically.
 */
export function recommendNoViewStrategies(
  contracts: ScreenedOptionContractItem[],
  request: NoViewStrategyRequest,
  limit?: number
): NoViewRecommendationResult {
  if (!request.symbol.trim()) throw new Error("symbol is required");
  if (!Number.isFinite(request.maxPlannedLoss) || request.maxPlannedLoss <= 0) throw new Error("maxPlannedLoss must be positive");
  if (!Number.isFinite(request.minRewardRisk) || request.minRewardRisk < 0) throw new Error("minRewardRisk must be non-negative");
  const minProbabilityOfProfit = request.minProbabilityOfProfit ?? NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT;
  if (!Number.isFinite(minProbabilityOfProfit) || minProbabilityOfProfit <= 0 || minProbabilityOfProfit > 1) {
    throw new Error("minProbabilityOfProfit must be greater than 0 and at most 1");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("candidate limit must be a positive whole number");
  if (request.maxStrikesPerSide !== undefined && (!Number.isInteger(request.maxStrikesPerSide) || request.maxStrikesPerSide < 1)) throw new Error("maxStrikesPerSide must be a positive whole number");
  if (request.maxIronCondors !== undefined && (!Number.isInteger(request.maxIronCondors) || request.maxIronCondors < 0)) throw new Error("maxIronCondors must be a non-negative whole number");
  const minDte = request.minDte ?? 0;
  const maxDte = request.maxDte ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(minDte) || minDte < 0 || !Number.isInteger(maxDte) || maxDte < minDte) {
    throw new Error("DTE range must use whole days with a maximum greater than or equal to minimum");
  }
  // The constraint set with its defaults resolved, used for gate
  // evaluation and generation. The caller's object is echoed verbatim
  // on the result (as the viewed path echoes its request); defaults
  // never mutate it.
  const effectiveRequest: NoViewStrategyRequest = {
    ...request,
    minProbabilityOfProfit,
    allowedStrategies: request.allowedStrategies ?? ALL_STRATEGY_TYPES,
  };
  const registry = defaultRegistry;
  const ledger = new EvaluationLedger(registry.list());
  const wanted = new Set(registry.resolveMany(effectiveRequest.allowedStrategies ?? []).ids);
  const selectedDefs = registry.list().filter((def) => wanted.has(def.id));
  const finish = (partial: Omit<NoViewRecommendationResult, "evaluations" | "nameLedger">): NoViewRecommendationResult => {
    const evaluations = ledger.report();
    return { ...partial, evaluations, nameLedger: buildNameLedger(evaluations) };
  };

  if (request.eventPolicy === "exclude" && !request.eventCalendar?.covered) {
    registry.list().forEach((def) => ledger.onSkipped(def, "Skipped: event-risk exclusion cannot be verified without an event calendar."));
    return finish({
      status: "no_candidates",
      request,
      generatedAt: new Date().toISOString(),
      modelVersion: NO_VIEW_SCORE_MODEL,
      scoreModel: NO_VIEW_SCORE_MODEL,
      expectedIvDirection: NO_VIEW_EXPECTED_IV_DIRECTION,
      dataSource: "E*TRADE option-chain snapshot",
      assumptions: ["Candidates were withheld because earnings/dividend calendar verification is unavailable."],
      scoreWeights: resolveNoViewScoreWeights(request.optimizationBias),
      candidates: [],
      excluded: [{ reason: "Event-risk exclusion cannot be verified without an event calendar", count: contracts.length }],
    });
  }
  const strategyDataMaxDte = Math.max(maxDte, ...selectedDefs.map((def) => def.dataHorizonDte ?? 0));
  const normalized = contracts.filter((contract) =>
    contract.underlyingSymbol.toUpperCase() === request.symbol.toUpperCase() &&
    contract.daysToExpiration >= minDte &&
    contract.daysToExpiration <= strategyDataMaxDte
  );
  const byExpiry = new Map<string, ScreenedOptionContractItem[]>();
  for (const contract of normalized) {
    byExpiry.set(contract.expirationDate, [...(byExpiry.get(contract.expirationDate) || []), contract]);
  }
  const closest = (items: ScreenedOptionContractItem[]) => items
    .sort((a, b) => Math.abs(a.strikePrice - a.underlyingPrice) - Math.abs(b.strikePrice - b.underlyingPrice))
    .slice(0, request.maxStrikesPerSide ?? items.length);
  const chains: ChainView[] = Array.from(byExpiry.entries()).map(([expiration, items]) => ({
    expiration,
    dte: items[0].daysToExpiration,
    calls: new Map(closest(items.filter((item) => item.optionType === "CALL")).map((item) => [item.strikePrice, item])),
    puts: new Map(closest(items.filter((item) => item.optionType === "PUT")).map((item) => [item.strikePrice, item])),
  })).sort((a, b) => a.dte - b.dte);
  const context: StrategyContext = {
    request: effectiveRequest,
    symbol: request.symbol.toUpperCase(),
    underlying: normalized[0]?.underlyingPrice ?? 0,
    chains,
    stockShares: 100,
  };

  const rejected = new Map<string, number>();
  const candidates: NoViewStrategyCandidate[] = [];

  for (const def of registry.list()) {
    if (!wanted.has(def.id)) {
      ledger.onSkipped(def, "Skipped: not selected in this request.");
      continue;
    }
    // No view filter: every selected definition is eligible. The mode
    // ranks structures under constraints; it does not express a view.
    const strategyNormalized = normalized.filter((contract) =>
      contract.daysToExpiration <= maxDte ||
      (def.dataHorizonDte !== undefined && contract.daysToExpiration <= def.dataHorizonDte)
    );
    const strategyByExpiry = new Map<string, ScreenedOptionContractItem[]>();
    for (const contract of strategyNormalized) {
      strategyByExpiry.set(contract.expirationDate, [...(strategyByExpiry.get(contract.expirationDate) || []), contract]);
    }
    const strategyChains: ChainView[] = Array.from(strategyByExpiry.entries()).map(([expiration, items]) => ({
      expiration,
      dte: items[0].daysToExpiration,
      calls: new Map(closest(items.filter((item) => item.optionType === "CALL")).map((item) => [item.strikePrice, item])),
      puts: new Map(closest(items.filter((item) => item.optionType === "PUT")).map((item) => [item.strikePrice, item])),
    })).sort((a, b) => a.dte - b.dte);
    const strategyContext = { ...context, chains: strategyChains };
    const strategyContractMap = new Map(strategyNormalized.map((contract) => [contractKey(contract), contract]));
    if (strategyContext.chains.length === 0) {
      ledger.onSkipped(def, `Skipped: no ${context.symbol} option contracts are available inside the DTE window.`);
      continue;
    }
    if (def.id === "iron_condor" && request.maxIronCondors === 0) {
      ledger.onSkipped(def, "Skipped: iron condor generation is disabled (maxIronCondors = 0).");
      continue;
    }
    const cap = def.id === "iron_condor" && request.maxIronCondors !== undefined ? request.maxIronCondors : DEFAULT_MAX_COMBINATIONS;
    const generated = def.generate(strategyContext, cap);
    ledger.onGenerated(def, generated.sets.length, generated.truncated, generated.skipReason);
    for (const legs of generated.sets) {
      const outcome = buildNoViewCandidate(def, legs, strategyContractMap, effectiveRequest);
      const reason = "candidate" in outcome ? runNoViewAcceptanceRules(outcome.candidate, effectiveRequest) : outcome.reason;
      if (reason) {
        ledger.onRejected(def, reason);
        addRejected(rejected, reason);
        continue;
      }
      if ("candidate" in outcome) {
        ledger.onAccepted(def, outcome.candidate);
        candidates.push(outcome.candidate);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.liquidityScore - a.liquidityScore || a.id.localeCompare(b.id));
  const selectedCandidates = limit === undefined ? candidates : candidates.slice(0, limit);
  const ranked = selectedCandidates.map((candidate, index) => {
    const withRank = { ...candidate, rank: index + 1 };
    // No view date exists: detail is anchored to the candidate's own
    // expiry — which is also how POP and breakevens are computed.
    return index < DETAIL_LIMIT ? attachDetail(withRank, request, horizonDays(candidate.legs)) : withRank;
  });
  const assumptions = [
    "No user view was supplied, derived, or inferred for this run: ranking uses the no-view-v1 score model (POP, cushion, liquidity, theta burden, freshness) under the stated constraints only.",
    "Volatility expectation is fixed to 'unchanged' for this mode — a declared constant, not an input.",
    "Research ranking only; it is not a prediction, personalized advice, or an order instruction.",
    "Pre-expiry values use Black-Scholes with the supplied IV, risk-free rate, and dividend yield.",
    "Probability of profit is model-implied under a risk-neutral lognormal terminal-price distribution using average leg IV; it is not a forecast.",
    "Stock-based strategies assume 100 hypothetical shares; actual holdings, margin and borrow are not connected.",
    ...eventAssumptionLines(request.eventCalendar),
  ];

  return finish({
    status: ranked.length > 0 ? "ranked_candidates" : "no_candidates",
    request,
    generatedAt: new Date().toISOString(),
    modelVersion: NO_VIEW_SCORE_MODEL,
    scoreModel: NO_VIEW_SCORE_MODEL,
    expectedIvDirection: NO_VIEW_EXPECTED_IV_DIRECTION,
    dataSource: "E*TRADE option-chain snapshot",
    assumptions,
    scoreWeights: resolveNoViewScoreWeights(request.optimizationBias),
    candidates: ranked,
    excluded: Array.from(rejected, ([reason, count]) => ({ reason, count })),
  });
}
