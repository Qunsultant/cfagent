/**
 * Screening indicators (issue #261) — E*TRADE-honest technical screening.
 *
 * Every indicator here is computed SOLELY from a single E*TRADE snapshot
 * quote (lastPrice, day OHLC, change%, volume, 52-week range, P/E).
 * Methodology is labeled on each result — range-based proxies are NEVER
 * presented as RSI/MACD.
 *
 * What E*TRADE CANNOT provide (no history endpoint):
 *   - RSI(14), MACD(12,26,9), any multi-day indicator — these need 26+
 *     daily closes. They are reported as unavailable, not faked.
 */

import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";
import {
  computeSma,
  classifyPriceRegime,
  computeTechnicals,
  type YahooDailyBar,
} from "./technicals";
import type { CompositeBias, PriceRegime } from "../types";

export type Sentiment =
  | "very_bullish"
  | "bullish"
  | "neutral"
  | "bearish"
  | "very_bearish";

export type RangeZone = "overbought" | "neutral" | "oversold";
export type ValueZone = "undervalued" | "fair" | "overvalued";

export interface ScreeningIndicators {
  /** Day momentum: the session's percent change. */
  momentum: number;
  /** Intraday trend position: 0 = at day low, 1 = at day high. */
  intradayPosition: number | null;
  /**
   * #3932 — the 6-level day-action label from the day's
   * changePercent: the price-derived heuristic, renamed so it
   * is never presented as sentiment data. `sentiment` below is
   * the deprecated alias of this same value, kept so existing
   * readers keep working while they migrate — new code reads
   * `dayAction`, and anything presenting a value AS sentiment
   * must read the sourced news sentiment instead.
   */
  dayAction: Sentiment;
  /** @deprecated Superseded by `dayAction` in this file — the same price-derived label
   *  under its honest name. Never present this as sentiment. */
  sentiment: Sentiment;
  /** Strong directional move (|change%| >= 2%), either direction. */
  directional: boolean;
  /** Position in 52-week range: 0 = at 52w low, 1 = at 52w high. */
  rangePosition: number | null;
  /** Range-based overbought/oversold (NOT RSI — labeled as range-based). */
  rangeZone: RangeZone;
  /** Heuristic value zone from P/E + 52-week position. */
  valueZone: ValueZone;
  /** Composite 0-100 screening score (higher = stronger bullish setup). */
  screenScore: number;
  /** Human-readable one-line summary. */
  summary: string;
}

export interface QuoteSnapshot {
  lastPrice: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  week52High: number;
  week52Low: number;
  peRatio?: number;
  volume: number;
  averageVolume?: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * #3932 — the 6-level day-action label from the day's
 * changePercent. This is a price-derived heuristic, NOT news
 * sentiment: the name says so. (The old name, classifySentiment,
 * is kept as a deprecated alias below.)
 */
export function classifyDayAction(
  changePercent: number,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): Sentiment {
  const c = config.indicators;
  if (changePercent >= c.sentimentStrongPct) return "very_bullish";
  if (changePercent >= c.sentimentMildPct) return "bullish";
  if (changePercent <= -c.sentimentStrongPct) return "very_bearish";
  if (changePercent <= -c.sentimentMildPct) return "bearish";
  return "neutral";
}

/** @deprecated Superseded by `classifyDayAction` in this file — same value, honest name. */
export function classifySentiment(
  changePercent: number,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): Sentiment {
  return classifyDayAction(changePercent, config);
}

export function classifyRangeZone(
  rangePosition: number | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): RangeZone {
  const c = config.indicators;
  if (rangePosition == null) return "neutral";
  if (rangePosition >= c.rangeOverbought) return "overbought";
  if (rangePosition <= c.rangeOversold) return "oversold";
  return "neutral";
}

export function classifyValueZone(
  peRatio: number | undefined,
  rangePosition: number | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): ValueZone {
  const c = config.indicators;
  // P/E-led when available; 52-week position as the secondary read.
  if (peRatio !== undefined && Number.isFinite(peRatio) && peRatio > 0) {
    if (peRatio < c.valueUndervaluedPe) return "undervalued";
    if (peRatio > c.valueOvervaluedPe) return "overvalued";
  }
  if (rangePosition != null) {
    if (rangePosition <= 0.15) return "undervalued";
    if (rangePosition >= 0.85) return "overvalued";
  }
  return "fair";
}

export function computeScreeningIndicators(
  q: QuoteSnapshot,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): ScreeningIndicators {
  const intradayPosition =
    q.high > q.low
      ? clamp01((q.lastPrice - q.low) / (q.high - q.low))
      : null;
  const rangePosition =
    q.week52High > q.week52Low
      ? clamp01((q.lastPrice - q.week52Low) / (q.week52High - q.week52Low))
      : null;

  const sentiment = classifyDayAction(q.changePercent, config);
  const directional = Math.abs(q.changePercent) >= config.indicators.directionalPct;
  const rangeZone = classifyRangeZone(rangePosition, config);
  const valueZone = classifyValueZone(q.peRatio, rangePosition, config);

  // Composite 0-100: day momentum (40) + intraday strength (20) +
  // 52w position (20) + value (20). Heuristic, labeled as such.
  let score = 50 + q.changePercent * 5;
  if (intradayPosition != null) score += (intradayPosition - 0.5) * 40;
  if (rangePosition != null) score += (rangePosition - 0.5) * 40;
  if (valueZone === "undervalued") score += 10;
  if (valueZone === "overvalued") score -= 10;
  const screenScore = Math.round(Math.min(100, Math.max(0, score)));

  const sentimentLabel = sentiment.replace("_", " ");
  const parts = [sentimentLabel];
  if (directional) parts.push("directional");
  if (rangeZone !== "neutral") parts.push(`range-${rangeZone}`);
  if (valueZone !== "fair") parts.push(valueZone);

  return {
    momentum: Number(q.changePercent.toFixed(2)),
    intradayPosition:
      intradayPosition != null ? Number(intradayPosition.toFixed(2)) : null,
    // #3932: dayAction is the canonical name; sentiment stays
    // as the deprecated alias of the same value.
    dayAction: sentiment,
    sentiment,
    directional,
    rangePosition:
      rangePosition != null ? Number(rangePosition.toFixed(2)) : null,
    rangeZone,
    valueZone,
    screenScore,
    summary: parts.join(" · "),
  };
}

export type CompositeBiasVote = "bullish" | "bearish" | "abstain";

/**
 * Inputs to the 6-vote composite bias. Every field is nullable: a
 * vote whose input is missing or non-finite ABSTAINS — it is never
 * counted as bullish, bearish, or neutral-by-default. Callers must
 * supply REAL bar-derived values (or item-attached values computed
 * upstream from real bars): the screening path's feed `q.rsi` is not
 * a bar RSI₁₄, and the `macdSignal` STRING is not a MACD line value
 * and must never be coerced into a vote. Where a vote input is
 * unavailable, leave it null and let it abstain; slice 8's
 * enrichment supplies real bars.
 */
export interface CompositeBiasInputs {
  /** Spot price (last close). Null/non-finite abstains every vote. */
  price: number | null | undefined;
  sma50: number | null | undefined;
  sma200: number | null | undefined;
  /** MACD line value (12,26,9), NOT the macdSignal string. */
  macdLine: number | null | undefined;
  /** Bar-computed RSI₁₄, NOT feed q.rsi. */
  rsi14: number | null | undefined;
  /** Price-action regime from classifyPriceRegime, or null. */
  regime: PriceRegime | null | undefined;
}

export interface CompositeBiasVotes {
  priceVsSma50: CompositeBiasVote;
  priceVsSma200: CompositeBiasVote;
  smaCross: CompositeBiasVote;
  macd: CompositeBiasVote;
  rsi: CompositeBiasVote;
  regime: CompositeBiasVote;
}

export interface CompositeBiasResult {
  /** Bullish-vote count (0–6). This is the doc's "score". */
  score: number;
  /** Bearish-vote count (0–6). */
  bearish: number;
  /** Abstained-vote count (0–6). */
  abstentions: number;
  bias: CompositeBias;
  votes: CompositeBiasVotes;
}

function voteGt(
  a: number | null | undefined,
  b: number | null | undefined
): CompositeBiasVote {
  if (a == null || b == null) return "abstain";
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "abstain";
  return a > b ? "bullish" : "bearish";
}

/**
 * 6-Vote Composite Bias (issue #1654 slice 6; screener-rules.md).
 * One point each: P > SMA₅₀, P > SMA₂₀₀, SMA₅₀ > SMA₂₀₀, MACD line
 * > 0, RSI₁₄ > 50, pivot structure UP (regime === "UP").
 *
 * Counting rule, documented because the doc states thresholds only
 * for the all-vote case: every vote is bullish, bearish, or
 * abstain. Numeric votes use STRICT > — equality is determinately
 * false, hence bearish, never neutral. The regime vote earns its
 * point only on "UP"; "DN" and "RNG" are determined non-UP
 * structures, hence bearish; only a null regime abstains.
 *
 * Bias label: Bullish iff score ≥ 4; Bearish iff bearish ≥ 4;
 * otherwise Neutral. When all six vote this coincides exactly with
 * the doc (≥4 Bullish, ≤2 Bearish, 3 Neutral — the two thresholds
 * are the same condition). With abstentions the symmetric ≥4 rule
 * keeps both labels evidence-backed: a score ≤ 2 with abstentions
 * is Neutral, NOT Bearish — bearishness is never invented from
 * missing data. The abstention count is always reported.
 */
export function compute6VoteCompositeBias(
  inputs: CompositeBiasInputs
): CompositeBiasResult {
  const votes: CompositeBiasVotes = {
    priceVsSma50: voteGt(inputs.price, inputs.sma50),
    priceVsSma200: voteGt(inputs.price, inputs.sma200),
    smaCross: voteGt(inputs.sma50, inputs.sma200),
    macd: voteGt(inputs.macdLine, 0),
    rsi: voteGt(inputs.rsi14, 50),
    regime:
      inputs.regime == null
        ? "abstain"
        : inputs.regime === "UP"
          ? "bullish"
          : "bearish",
  };
  const all = Object.values(votes);
  const score = all.filter((v) => v === "bullish").length;
  const bearish = all.filter((v) => v === "bearish").length;
  const abstentions = all.filter((v) => v === "abstain").length;
  const bias: CompositeBias =
    score >= 4 ? "Bullish" : bearish >= 4 ? "Bearish" : "Neutral";
  return { score, bearish, abstentions, bias, votes };
}

/**
 * Bar-derived 6-vote bias. Computes every vote input from real daily
 * bars — SMA₅₀/SMA₂₀₀ via computeSma, RSI₁₄/MACD via computeTechnicals
 * (whose 15/27-bar minimums gate honestly: below them the field is
 * null and the vote abstains — the marketDataResearch 50.0/0-line defaults
 * for short series are never allowed to vote), regime via
 * classifyPriceRegime — and counts via compute6VoteCompositeBias.
 * Returns null only when no price exists (empty bars or a
 * non-finite last close). Short series degrade honestly: e.g. 10
 * bars abstain on all six votes (Neutral, never estimated); 30 bars
 * cast only RSI/MACD/regime. Nothing here fetches bars.
 */
export function compute6VoteCompositeBiasFromBars(
  bars: readonly YahooDailyBar[]
): CompositeBiasResult | null {
  if (!bars || bars.length === 0) return null;
  const price = bars[bars.length - 1].close;
  if (!Number.isFinite(price)) return null;
  const closes = bars.map((b) => b.close);
  const tech = computeTechnicals("", [...bars]);
  // Finiteness gate: marketDataResearch's RSI treats a NaN diff as a flat
  // day (both gain and loss add 0) instead of propagating NaN, so a
  // corrupt close series would still yield a confident RSI vote.
  // The bias contract requires non-finite inputs to abstain, so RSI
  // and MACD vote only when every close is finite. (SMA needs no
  // extra gate: computeSma already nulls on a non-finite window.
  // Regime needs none either: classifyPriceRegime nulls on
  // non-finite highs/lows.)
  const closesFinite = closes.every((c) => Number.isFinite(c));
  return compute6VoteCompositeBias({
    price,
    sma50: computeSma(closes, 50),
    sma200: computeSma(closes, 200),
    macdLine: closesFinite ? tech.macdLine : null,
    rsi14: closesFinite ? tech.rsi14 : null,
    regime: classifyPriceRegime(bars),
  });
}
