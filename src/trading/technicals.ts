/**
 * Technicals from daily bars — pure functions + bar shapes.
 *
 * Issue #1331: moved verbatim from yahooHistory.ts (whose fetch
 * runtime is deleted — its consumers now fetch through the platform
 * historicalBars route; see platformHistory.ts). Nothing here
 * fetches: these functions compute from bars supplied by the caller.
 *
 * Yahoo Finance history complement (issue #269):
 *   - Daily price history → REAL RSI(14), MACD(12,26,9)
 *   - Previous close + open → overnight gap %
 *
 * Every value carries its source. Yahoo never overrides an E*TRADE
 * quote — it only fills the history-shaped hole.
 */

import { computeRsi14, computeMacd } from "../services/marketDataResearch";
import type { MarketDataResearchHistoricalBar, PriceRegime } from "../types";
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";

export interface YahooDailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooTechnicals {
  symbol: string;
  /** Real RSI(14) from daily closes, or null when history insufficient. */
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  /** Overnight gap % = (open − prevClose) / prevClose * 100. */
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  /** Number of daily bars used. */
  barsUsed: number;
  source: "Yahoo Finance";
}

/**
 * Issue #1331: map platform market-data bars to daily bars — but ONLY when
 * every bar is live. The market-data provider falls back to a generated
 * (synthetic) series when the live fetch fails; the old path
 * returned null on failure ("indicator unavailable, never zero"),
 * so a generated bar anywhere rejects the whole series. A partial
 * live series would corrupt RSI/MACD just as surely as a synthetic
 * one, so there is no partial path: live-all or null.
 */
export function marketDataResearchBarsToDailyBars(
  bars: readonly MarketDataResearchHistoricalBar[] | null | undefined
): YahooDailyBar[] | null {
  if (!bars || bars.length === 0) return null;
  if (bars.some((b) => b.provenance !== "live")) return null;
  return bars.map((b) => ({
    date: b.timestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/**
 * Simple moving average (issue #1654 slice 6; supports the 6-vote
 * composite bias SMA₅₀/SMA₂₀₀ votes). Mean of the LAST `period`
 * closes. Returns null when the average cannot be built honestly:
 * fewer than `period` closes, a non-positive period, or a
 * non-finite close in the window. Never estimates from a short
 * window, never fabricates closes.
 */
export function computeSma(
  closes: readonly number[],
  period: number
): number | null {
  if (!closes || !Number.isInteger(period) || period < 1) return null;
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  if (window.some((c) => !Number.isFinite(c))) return null;
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Bollinger Bands (issue #1654 slice 1/7; docs/architecture/business/
 * screener-rules.md §1.1). Pure function over closes supplied by the
 * caller — nothing here fetches.
 *
 * Convention, documented because the repo has no prior sigma helper:
 * sigma is the POPULATION standard deviation (divide by N), the
 * canonical Bollinger construction — Middle is the SMA over the same
 * window, so the band is symmetric around the mean of exactly the
 * closes it summarizes. Sample sigma (divide by N−1) would deviate
 * from every reference Bollinger implementation and from the doc
 * formula (sigma_20).
 *
 * Returns null when the window cannot be built honestly: fewer than
 * `period` closes, a non-positive period, a negative stdDev, or a
 * non-finite close in the window. P is the last close in the window.
 * Flat series (sigma = 0): upper == lower == middle, percentB is 0.5
 * (price at the middle by construction) and bandwidth is 0 — never
 * NaN from a 0/0 division.
 */
export interface BollingerBands {
  middle: number;
  upper: number;
  lower: number;
  /** %B = (P − Lower) / (Upper − Lower); 0.5 on a flat series. */
  percentB: number;
  /** Bandwidth = (Upper − Lower) / Middle; 0 when Middle is 0. */
  bandwidth: number;
}

export function computeBollingerBands(
  closes: readonly number[],
  period = 20,
  stdDev = 2.0
): BollingerBands | null {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(stdDev) || stdDev < 0) return null;
  if (!closes || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  if (window.some((c) => !Number.isFinite(c))) return null;
  const middle = window.reduce((sum, c) => sum + c, 0) / period;
  const variance = window.reduce((sum, c) => sum + (c - middle) * (c - middle), 0) / period;
  const sigma = Math.sqrt(variance);
  const upper = middle + stdDev * sigma;
  const lower = middle - stdDev * sigma;
  const price = window[window.length - 1];
  const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  const bandwidth = middle === 0 ? 0 : (upper - lower) / middle;
  return { middle, upper, lower, percentB, bandwidth };
}

/**
 * Squeeze gate (issue #1654 slice 1/7): bandwidth at its lookback
 * minimum. `bandwidthMin` is the minimum bandwidth over the trailing
 * `lookback` bandwidth values (each from a `period`-close window).
 * `isSqueeze` is true only when the current bandwidth IS that minimum
 * (within float epsilon) — the doc's literal "at N-day minimum".
 *
 * History floor, stated not silent: a true 125-day minimum needs
 * lookback + period − 1 closes (144 at the defaults). With fewer
 * closes the minimum is over the available bandwidth values and
 * `barsUsed` reports it — but below `period + 1` closes there is only
 * ONE bandwidth value, and a "minimum" over one point would be
 * trivially true, so the gate returns null instead of silently
 * weakening to "current bandwidth is low". Callers must treat null
 * as "gate cannot be evaluated", never as a pass.
 */
export interface BollingerSqueezeGate {
  bandwidth: number;
  bandwidthMin: number;
  /** Closes supplied; the minimum covers at most `lookback` values. */
  barsUsed: number;
  isSqueeze: boolean;
}

export function computeBollingerSqueezeGate(
  closes: readonly number[],
  period = 20,
  stdDev = 2.0,
  lookback = 125
): BollingerSqueezeGate | null {
  if (!closes || closes.length < period + 1) return null;
  if (!Number.isInteger(lookback) || lookback < 1) return null;
  const bandwidths: number[] = [];
  for (let end = period; end <= closes.length; end++) {
    const bands = computeBollingerBands(closes.slice(0, end), period, stdDev);
    if (bands === null) return null;
    bandwidths.push(bands.bandwidth);
  }
  const window = bandwidths.slice(Math.max(0, bandwidths.length - lookback));
  const bandwidth = window[window.length - 1];
  const bandwidthMin = Math.min(...window);
  return {
    bandwidth,
    bandwidthMin,
    barsUsed: closes.length,
    isSqueeze: bandwidth <= bandwidthMin + 1e-12,
  };
}

/**
 * Anchored VWAP from the 52-week low (issue #1654 slice 2/8;
 * docs/architecture/business/screener-rules.md: AVWAP =
 * Σ(Pᵢ·Vᵢ)/ΣVᵢ anchored from the 52-week low bar). Pure function
 * over bars supplied by the caller — nothing here fetches.
 *
 * Price Pᵢ is the daily CLOSE, matching this module's other
 * bar-derived indicators (RSI, MACD, Bollinger all run on closes),
 * and the gate compares spot (lastPrice, ~ last close) against it.
 * The doc formula writes Pᵢ generically; close is the documented
 * choice, not a second convention.
 *
 * Anchor semantics, stated not silent:
 * - The anchor is the bar with the MINIMUM LOW over the supplied
 *   bars, and the accumulation runs from that bar INCLUSIVE through
 *   the latest bar. Bars before the anchor are excluded.
 * - On a tie for the lowest low, the EARLIEST such bar anchors —
 *   the low event's first occurrence, which also maximizes the
 *   accumulation window. A latest-tie anchor would silently shorten
 *   it; the choice is pinned by test, not assumed.
 * - The "52-week" qualifier is the CALLER's window responsibility:
 *   the function anchors at the lowest low of the bars it is given.
 *   A window shorter than 52 weeks still computes from its own low
 *   (a mathematically valid AVWAP, just not a 52-week one) — the
 *   function refuses to pretend otherwise by returning null, but it
 *   also refuses to refuse honest math. Slice 8's enrichment passes
 *   the 52-week window; until then callers must know what they pass.
 *
 * Returns null when the value cannot be built honestly: empty input,
 * a non-finite close/low/volume, a negative volume, or zero total
 * volume from the anchor forward (never divides by zero). Zero-volume
 * bars after the anchor contribute weight 0 but are not an error.
 */
export function computeAnchoredVwapFrom52wLow(
  bars: readonly YahooDailyBar[]
): number | null {
  if (!bars || bars.length === 0) return null;
  if (bars.some((b) => !Number.isFinite(b.close) || !Number.isFinite(b.low) || !Number.isFinite(b.volume) || b.volume < 0)) {
    return null;
  }
  let anchorIndex = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].low < bars[anchorIndex].low) anchorIndex = i;
  }
  let priceVolumeSum = 0;
  let volumeSum = 0;
  for (let i = anchorIndex; i < bars.length; i++) {
    priceVolumeSum += bars[i].close * bars[i].volume;
    volumeSum += bars[i].volume;
  }
  if (volumeSum <= 0) return null;
  return priceVolumeSum / volumeSum;
}
/**
 * Wilder's Average True Range (issue #1654 slice 3/8;
 * docs/architecture/business/screener-rules.md §1.4 + fit-gap Gap 7).
 * Pure function over bars supplied by the caller — nothing here
 * fetches. Volume is intentionally NOT read: ATR uses price ranges
 * only, so a zero-volume bar is valid input here (unlike VWAP).
 *
 * True range, stated exactly:
 * - First bar: TR = high − low (no previous close exists).
 * - Later bars: TR = max(high − low, |high − prevClose|,
 *   |low − prevClose|), so overnight gaps dominate the range when
 *   they exceed the intraday range.
 * Wilder smoothing: the first ATR is the simple mean of the first
 * `period` true ranges; each later ATR = (prevATR × (period − 1) +
 * TR) / period. This is Wilder's original construction, not a simple
 * moving average over the whole window — the two agree only on the
 * first ATR and diverge as new bars arrive (pinned by test).
 *
 * The doc's ATR% = ATR₁₄ / P × 100 uses P = the latest bar's close:
 * the price the range is measured against. Callers attaching atrPct
 * to a ScreenedStockItem divide this function's result by that
 * close and multiply by 100; the gate itself reads only atrPct.
 *
 * Returns null when the value cannot be built honestly: empty input,
 * fewer than `period` bars (fewer true ranges than the period needs),
 * a non-finite high/low/close, a malformed bar (high below low), or
 * an invalid period (non-integer or < 1). Never divides by zero:
 * period ≥ 1 is enforced before any division.
 */
export function computeAtr(
  bars: readonly YahooDailyBar[],
  period = 14
): number | null {
  if (!Number.isInteger(period) || period < 1) return null;
  if (!bars || bars.length < period) return null;
  if (bars.some((b) => !Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close) || b.high < b.low)) {
    return null;
  }
  const trueRanges: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      trueRanges.push(bars[i].high - bars[i].low);
    } else {
      const prevClose = bars[i - 1].close;
      trueRanges.push(Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose)
      ));
    }
  }
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

/**
 * Historical Volatility (issue #1769, parent #1717; screener-rules.md
 * §1.5: HV = sqrt(252) × sigma(ln(P_t / P_{t-1}))). Pure function over
 * closes supplied by the caller — nothing here fetches. Returns the
 * ANNUALIZED decimal (0.25 = 25%): log returns over the trailing
 * `window` returns (so `window + 1` closes), population sigma
 * (divide by N, matching the discovery-signals realizedVolatility
 * helper this function exports for reuse — that helper was private
 * and unexported, which is why HV read as "partially implemented").
 * Only the trailing window + 1 closes are read; earlier history is
 * ignored, never averaged in.
 *
 * Returns null when the value cannot be built honestly: fewer than
 * `window + 1` closes, fewer than 10 returns in the window (a sigma
 * over a handful of returns is noise dressed as a number), a
 * non-positive or non-finite close in the window, or an invalid
 * window (non-integer or < 1). Never fabricates closes.
 */
export function computeHistoricalVolatility(
  closes: readonly number[],
  window = 20
): number | null {
  if (!Number.isInteger(window) || window < 1) return null;
  if (!closes || closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - (window + 1));
  if (slice.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) returns.push(Math.log(slice[i] / slice[i - 1]));
  if (returns.length < 10) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Fractal pivots (issue #1654 slice 4/8; docs/architecture/business/
 * screener-rules.md: "Identified High/Low pivots require P_t to be
 * extreme compared to n preceding and trailing bars"). Pure function
 * over bars supplied by the caller — nothing here fetches.
 *
 * Semantics, stated not silent:
 * - A HIGH pivot at index i requires high[i] STRICTLY greater than
 *   the high of every one of the n preceding and n trailing bars; a
 *   LOW pivot requires low[i] STRICTLY less than every neighboring
 *   low. A tie with any neighbor kills the pivot — the classic
 *   fractal definition, and the only reading under which "extreme
 *   compared to" is unambiguous. Equal neighboring highs/lows are
 *   common in flat sessions; treating them as pivots would invent
 *   turning points the data does not show.
 * - Only indices with n bars on BOTH sides can confirm, so the first
 *   and last n bars never yield pivots however extreme they look.
 * - Returns null when the value cannot be evaluated honestly: null/
 *   empty input, a non-finite high/low, or a non-integer or
 *   non-positive n. Valid bars too short to confirm any pivot
 *   (length < 2n + 1) return EMPTY lists — "evaluated, none
 *   confirmed" — which callers must not confuse with "no pivots
 *   exist". Slice 5's regime classification consumes these pivots.
 */
export interface FractalPivot {
  index: number;
  date: string;
  price: number;
}

export interface FractalPivots {
  highs: FractalPivot[];
  lows: FractalPivot[];
}

export function computeFractalPivots(
  bars: readonly YahooDailyBar[],
  n = 5
): FractalPivots | null {
  if (!bars || bars.length === 0) return null;
  if (!Number.isInteger(n) || n < 1) return null;
  if (bars.some((b) => !Number.isFinite(b.high) || !Number.isFinite(b.low))) return null;
  const highs: FractalPivot[] = [];
  const lows: FractalPivot[] = [];
  for (let i = n; i + n < bars.length; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, date: bars[i].date, price: bars[i].high });
    if (isLow) lows.push({ index: i, date: bars[i].date, price: bars[i].low });
  }
  return { highs, lows };
}

/**
 * Fibonacci retracements (issue #1654 slice 4/8; screener-rules.md:
 * "Key Fib levels computed at 38.2%, 50.0%, 61.8% over the 6-month
 * swing range"). Pure function over bars supplied by the caller —
 * nothing here fetches.
 *
 * Swing-endpoint semantics, stated not silent:
 * - The window is the TRAILING `lookbackBars` bars (125 ≈ six months
 *   of trading days, the fit-gap target). A shorter supplied series
 *   uses all of it and reports `barsUsed`; the "6-month" qualifier
 *   is the caller's window responsibility, as with the AVWAP anchor.
 * - Swing high = maximum high over the window (first occurrence on
 *   a tie, matching the AVWAP earliest-tie convention); swing low =
 *   minimum low over the window (first occurrence on a tie).
 * - Direction is the direction of the move being retraced: "up"
 *   when the swing low precedes the swing high (retracement measured
 *   DOWN from the high: high − ratio × range), "down" when the high
 *   precedes the low (measured UP from the low: low + ratio ×
 *   range). The levels are support/resistance candidates for the
 *   pullback against that move, not price predictions.
 * - Returns null when the swing cannot be built honestly: empty
 *   input, a non-finite high/low in the window, a non-integer or
 *   non-positive lookbackBars, or a zero range (a flat window has
 *   no swing to retrace; returning degenerate equal levels would
 *   dress up "no move" as three support levels).
 */
export interface FibonacciLevel {
  ratio: number;
  price: number;
}

export interface FibonacciRetracements {
  high: number;
  low: number;
  range: number;
  highIndex: number;
  lowIndex: number;
  direction: "up" | "down";
  levels: FibonacciLevel[];
  barsUsed: number;
}

const FIB_RATIOS = [0.382, 0.5, 0.618];

export function computeFibonacciRetracements(
  bars: readonly YahooDailyBar[],
  lookbackBars = 125
): FibonacciRetracements | null {
  if (!bars || bars.length === 0) return null;
  if (!Number.isInteger(lookbackBars) || lookbackBars < 1) return null;
  const window = bars.slice(Math.max(0, bars.length - lookbackBars));
  if (window.some((b) => !Number.isFinite(b.high) || !Number.isFinite(b.low))) return null;
  let highIndex = 0;
  let lowIndex = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[highIndex].high) highIndex = i;
    if (window[i].low < window[lowIndex].low) lowIndex = i;
  }
  const high = window[highIndex].high;
  const low = window[lowIndex].low;
  const range = high - low;
  if (range <= 0) return null;
  const direction: "up" | "down" = lowIndex < highIndex ? "up" : "down";
  const levels = FIB_RATIOS.map((ratio) => ({
    ratio,
    price: direction === "up" ? high - ratio * range : low + ratio * range,
  }));
  return { high, low, range, highIndex, lowIndex, direction, levels, barsUsed: window.length };
}

/**
 * HH/HL Price-Action Regime Classification (issue #1654 slice 5;
 * screener-rules.md; fit-gap Gap 4).
 *
 * CONTRACT (slice 6 builds against this signature — do not change it
 * without coordinating with the bias slice):
 *   classifyPriceRegime(bars: readonly YahooDailyBar[]): PriceRegime | null
 *   where PriceRegime = "UP" | "DN" | "RNG".
 *
 * Semantics — a 20-bar window, operationalized as two consecutive
 * 10-bar halves of the LAST 20 bars supplied (longer inputs are
 * truncated to their last 20; the doc's "20-bar pivot sequence" names
 * the window, not a fractal-pivot extraction — slice 4 owns fractal
 * pivots, and this function deliberately does not depend on them):
 *   - higherHighs = max high of the second half STRICTLY above max
 *     high of the first half; higherLows likewise on min lows.
 *   - lowerHighs / lowerLows are the strict mirror.
 *   - "UP" iff higherHighs AND higherLows; "DN" iff lowerHighs AND
 *     lowerLows; "RNG" otherwise (mixed structure, flat series, or
 *     equal extremes — equality is not "higher" or "lower").
 *
 * Returns null when the regime cannot be built honestly: fewer than
 * 20 bars, empty input, or a non-finite high/low in the window.
 * Never fabricates bars, never estimates from a short window.
 */
export function classifyPriceRegime(
  bars: readonly YahooDailyBar[]
): PriceRegime | null {
  if (!bars || bars.length < 20) return null;
  const window = bars.slice(-20);
  if (window.some((b) => !Number.isFinite(b.high) || !Number.isFinite(b.low))) {
    return null;
  }
  const first = window.slice(0, 10);
  const second = window.slice(10);
  const maxHigh = (xs: YahooDailyBar[]) => Math.max(...xs.map((b) => b.high));
  const minLow = (xs: YahooDailyBar[]) => Math.min(...xs.map((b) => b.low));
  const higherHighs = maxHigh(second) > maxHigh(first);
  const higherLows = minLow(second) > minLow(first);
  const lowerHighs = maxHigh(second) < maxHigh(first);
  const lowerLows = minLow(second) < minLow(first);
  if (higherHighs && higherLows) return "UP";
  if (lowerHighs && lowerLows) return "DN";
  return "RNG";
}

/**
 * 15-min Opening Range Breakout (ORB) — issue #1654 slice 7/8;
 * docs/architecture/business/screener-rules.md §1.4, fit-gap Gap 6.
 * Pure functions over intraday bars supplied by the caller — nothing
 * here fetches, and NOTHING here is wired to a production bars feed,
 * because the repo has no minute-bar source to wire to (read this
 * before adding one):
 *
 * - The Yahoo historical-bars provider (marketDataResearch.ts yfinance
 *   getHistoricalBars) maps timeframes to 1wk/1mo/1h/1d ONLY. A
 *   "1Min"/"15Min" timeframe silently collapses to interval=1d
 *   (daily bars). Wiring ORB to it would compute OR_H/OR_L from
 *   daily bars — fabrication by mislabeling.
 * - The Alpaca provider maps the same way (1Week/1Month/1Hour/1Day)
 *   and requires configuration on top.
 * - BOTH providers truncate bar timestamps to DATE-ONLY
 *   (toISOString().split("T")[0] / String(b.t).split("T")[0]), so
 *   even a minute interval could not identify a 09:30–09:45 ET
 *   window from their output.
 * - The hybrid provider just delegates to the same two. The
 *   data-provider adapter passes timeframes through unchanged. The
 *   snapshot `minuteBar` is a single latest-minute bar, not a
 *   session series. liveScreener.ts (73 lines) holds no intraday
 *   processing at all. No caller anywhere passes a minute
 *   timeframe to getHistoricalBars.
 *
 * The missing capability, precisely: a historical intraday-bar
 * provider that (a) accepts a 1-minute (or 15-minute) timeframe and
 * returns bars at that granularity, and (b) preserves full
 * timestamps (time-of-day, not date-only). The seam is
 * MarketDataResearchHistoricalBar-producing getHistoricalBars in
 * src/services/marketDataResearch.ts (yfinance + alpaca implementations)
 * plus the adapter in src/trading/dataProviders/adapters.ts — slice 8
 * owns that provider work. Until it lands, these functions compute
 * only on bars a caller supplies, and every no-data case returns
 * null (gate cannot be evaluated), never an estimate.
 *
 * ET/session semantics, stated not silent:
 * - Regular session is 09:30–16:00 America/New_York; the opening
 *   range window is [09:30, 09:45). A bar belongs to the window by
 *   its ET START time, so the rule works at either granularity: a
 *   15-min bar stamped 09:30 covers the window, and fifteen 1-min
 *   bars stamped 09:30–09:44 cover it. A bar stamped 09:45 starts
 *   the next window and is excluded; pre-market and other-date
 *   bars are excluded. ET conversion uses Intl with
 *   timeZone "America/New_York", so DST is handled by the tz
 *   database (09:30 ET is 13:30Z in EDT, 14:30Z in EST — pinned).
 * - Bars with unparseable timestamps are skipped (they cannot be
 *   placed in any window). Bars with non-finite OHLCV or negative
 *   volume that DO fall in the evaluated window/session make the
 *   function return null — corrupt in-window data fail-closes;
 *   corrupt bars outside the evaluated window are ignored.
 * - Session VWAP uses the standard typical price (H+L+C)/3,
 *   volume-weighted over completed 15-min bars. "Completed" means
 *   the bar's 15-min window has fully elapsed by `asOf`
 *   (window end <= asOf). Hold % is a RETROSPECTIVE session
 *   measure (VWAP over all completed bars, then the share of those
 *   bars closing above it), not a real-time signal — the doc's
 *   "Session VWAP" is the full-session value.
 * - The trigger's RVOL is time-prorated: expected volume at this
 *   point in the session = avgDailyVolume × (elapsed / 390), and
 *   RVOL = sessionVolume / expected. elapsedMinutes must be > 0
 *   (at 09:30 exactly, expected volume is 0 and RVOL is undefined
 *   — the trigger returns null rather than dividing by zero).
 */
export interface IntradayBar {
  /** ISO 8601 timestamp WITH time-of-day; the ET window derives from it. */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Regular session open 09:30 ET, in minutes since ET midnight. */
const ORB_SESSION_OPEN_MIN = 570;
/** Opening-range window end 09:45 ET, exclusive. */
const ORB_WINDOW_END_MIN = 585;
/** Regular session close 16:00 ET, exclusive. */
const ORB_SESSION_CLOSE_MIN = 960;
/** Regular session length in minutes (09:30–16:00 ET). */
const ORB_SESSION_MINUTES = 390;
/** 15-min bar length in milliseconds. */
const ORB_BAR_MS = 15 * 60 * 1000;

function orbEtParts(epochMs: number): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(epochMs));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function orbIsValidSessionDate(sessionDate: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(sessionDate);
}

function orbBarIsClean(b: IntradayBar): boolean {
  return (
    Number.isFinite(b.open) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low) &&
    Number.isFinite(b.close) &&
    Number.isFinite(b.volume) &&
    b.volume >= 0
  );
}

export interface OpeningRange {
  orHigh: number;
  orLow: number;
  barsUsed: number;
}

export function computeOpeningRange(
  bars: readonly IntradayBar[],
  sessionDate: string
): OpeningRange | null {
  if (!bars || !orbIsValidSessionDate(sessionDate)) return null;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let barsUsed = 0;
  for (const b of bars) {
    const epoch = Date.parse(b.timestamp);
    if (Number.isNaN(epoch)) continue;
    const et = orbEtParts(epoch);
    if (et === null || et.date !== sessionDate) continue;
    if (et.minutes < ORB_SESSION_OPEN_MIN || et.minutes >= ORB_WINDOW_END_MIN) continue;
    if (!orbBarIsClean(b)) return null;
    if (b.high > orHigh) orHigh = b.high;
    if (b.low < orLow) orLow = b.low;
    barsUsed++;
  }
  if (barsUsed === 0) return null;
  return { orHigh, orLow, barsUsed };
}

export interface OrbTrigger {
  triggered: boolean;
  /** OR_H × 1.001 — price must STRICTLY clear this to trigger. */
  triggerPrice: number;
  rvol: number;
}

export function evaluateOrbTrigger(args: {
  orHigh: number;
  price: number;
  sessionVolume: number;
  avgDailyVolume: number;
  elapsedMinutes: number;
}): OrbTrigger | null {
  const { orHigh, price, sessionVolume, avgDailyVolume, elapsedMinutes } = args;
  if (
    !Number.isFinite(orHigh) ||
    !Number.isFinite(price) ||
    !Number.isFinite(sessionVolume) ||
    !Number.isFinite(avgDailyVolume) ||
    !Number.isFinite(elapsedMinutes) ||
    orHigh <= 0 ||
    price <= 0 ||
    sessionVolume < 0 ||
    avgDailyVolume <= 0 ||
    elapsedMinutes <= 0
  ) {
    return null;
  }
  const expectedVolume = avgDailyVolume * (elapsedMinutes / ORB_SESSION_MINUTES);
  const rvol = sessionVolume / expectedVolume;
  const triggerPrice = orHigh * 1.001;
  return { triggered: price > triggerPrice && rvol >= 1.5, triggerPrice, rvol };
}

export interface VwapHold {
  sessionVwap: number;
  barsAbove: number;
  barsTotal: number;
  holdPct: number;
  /** True when holdPct >= 0.70 (the doc's ≥70% rule). */
  confirmed: boolean;
}

export function computeVwapHold(
  bars: readonly IntradayBar[],
  sessionDate: string,
  asOf: string
): VwapHold | null {
  if (!bars || !orbIsValidSessionDate(sessionDate)) return null;
  const asOfEpoch = Date.parse(asOf);
  if (Number.isNaN(asOfEpoch)) return null;
  let priceVolumeSum = 0;
  let volumeSum = 0;
  const completed: IntradayBar[] = [];
  for (const b of bars) {
    const epoch = Date.parse(b.timestamp);
    if (Number.isNaN(epoch)) continue;
    const et = orbEtParts(epoch);
    if (et === null || et.date !== sessionDate) continue;
    if (et.minutes < ORB_SESSION_OPEN_MIN || et.minutes >= ORB_SESSION_CLOSE_MIN) continue;
    if (epoch + ORB_BAR_MS > asOfEpoch) continue;
    if (!orbBarIsClean(b)) return null;
    completed.push(b);
    priceVolumeSum += ((b.high + b.low + b.close) / 3) * b.volume;
    volumeSum += b.volume;
  }
  if (completed.length === 0 || volumeSum <= 0) return null;
  const sessionVwap = priceVolumeSum / volumeSum;
  const barsAbove = completed.filter((b) => b.close > sessionVwap).length;
  const holdPct = barsAbove / completed.length;
  return { sessionVwap, barsAbove, barsTotal: completed.length, holdPct, confirmed: holdPct >= 0.7 };
}

/**
 * Buckets 1-min (or finer) bars into 15-min regular-session bars.
 * Buckets start at 09:30, 09:45, … ET; a bar joins the bucket its ET
 * start falls in. Output bucket timestamps are the bucket starts,
 * reconstructed from the first bar's epoch minus its within-bucket
 * offset — exact because DST transitions occur at 02:00 ET, never
 * inside the 09:30–16:00 session. Bars are sorted chronologically
 * first (open = first bar's open, close = last bar's close).
 * Bars outside the session, on other dates, or with unparseable
 * timestamps or corrupt OHLCV are skipped, never invented.
 */
export function aggregateIntradayBarsTo15Min(
  bars: readonly IntradayBar[],
  sessionDate: string
): IntradayBar[] {
  if (!bars || !orbIsValidSessionDate(sessionDate)) return [];
  const placed: { epoch: number; etMinutes: number; bar: IntradayBar }[] = [];
  for (const b of bars) {
    const epoch = Date.parse(b.timestamp);
    if (Number.isNaN(epoch) || !orbBarIsClean(b)) continue;
    const et = orbEtParts(epoch);
    if (et === null || et.date !== sessionDate) continue;
    if (et.minutes < ORB_SESSION_OPEN_MIN || et.minutes >= ORB_SESSION_CLOSE_MIN) continue;
    placed.push({ epoch, etMinutes: et.minutes, bar: b });
  }
  placed.sort((a, b) => a.epoch - b.epoch);
  const buckets = new Map<number, IntradayBar & { firstEpoch: number; firstEtMinutes: number }>();
  for (const p of placed) {
    const bucketStart = ORB_SESSION_OPEN_MIN + Math.floor((p.etMinutes - ORB_SESSION_OPEN_MIN) / 15) * 15;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, {
        timestamp: "",
        open: p.bar.open,
        high: p.bar.high,
        low: p.bar.low,
        close: p.bar.close,
        volume: p.bar.volume,
        firstEpoch: p.epoch,
        firstEtMinutes: p.etMinutes,
      });
    } else {
      existing.high = Math.max(existing.high, p.bar.high);
      existing.low = Math.min(existing.low, p.bar.low);
      existing.close = p.bar.close;
      existing.volume += p.bar.volume;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, b]) => ({
      timestamp: new Date(b.firstEpoch - (b.firstEtMinutes - bucketStart) * 60 * 1000).toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
}

export function classifyGap(
  gapPercent: number | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): "up" | "down" | "flat" | null {
  if (gapPercent == null || !Number.isFinite(gapPercent)) return null;
  if (gapPercent >= config.yahoo.gapUpPct) return "up";
  if (gapPercent <= config.yahoo.gapDownPct) return "down";
  return "flat";
}

/**
 * Compute technicals from daily bars. RSI needs 14+ bars, MACD 26+;
 * below that the respective field is null (honest, not estimated).
 */
export function computeTechnicals(
  symbol: string,
  bars: YahooDailyBar[] | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): YahooTechnicals {
  const base: YahooTechnicals = {
    symbol,
    rsi14: null,
    macdLine: null,
    macdSignalLine: null,
    macdHistogram: null,
    macdSignal: null,
    gapPercent: null,
    gapDirection: null,
    barsUsed: bars?.length ?? 0,
    source: "Yahoo Finance",
  };
  if (!bars || bars.length < 2) return base;

  const closes = bars.map((b) => b.close);

  // Gap: most recent open vs previous close.
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (prev.close > 0) {
    const gap = ((last.open - prev.close) / prev.close) * 100;
    base.gapPercent = Number(gap.toFixed(2));
    base.gapDirection = classifyGap(base.gapPercent, config);
  }

  if (closes.length >= config.yahoo.rsiMinBars) {
    base.rsi14 = computeRsi14(closes);
  }
  if (closes.length >= config.yahoo.macdMinBars) {
    const macd = computeMacd(closes);
    base.macdLine = Number(macd.macdLine.toFixed(3));
    base.macdSignalLine = Number(macd.signalLine.toFixed(3));
    base.macdHistogram = Number(macd.histogram.toFixed(3));
    base.macdSignal = macd.macdSignal;
  }
  return base;
}
