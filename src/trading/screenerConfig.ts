/**
 * Screener configuration (issue #273).
 *
 * Every tunable default that was hardcoded across the screener pipeline
 * lives here — acquisition, indicators, factor grades, universes, Yahoo
 * history, retries, and agent defaults. One file to tune the whole system.
 *
 * Override via env.SCREENER_CONFIG (JSON) for deployment-specific values;
 * code defaults below are the fallback.
 */

export interface ScreenerAcquisitionConfig {
  /** Default cap on symbols quoted via E*TRADE per run. */
  defaultMaxSymbols: number;
  /** Concurrent E*TRADE quote fetches. */
  quoteConcurrency: number;
  /**
   * Issue #495: symbols per E*TRADE batch quote request. The broker's quote
   * endpoint accepts a symbol list; 50 is the documented per-call cap.
   */
  quoteBatchSize: number;
  /**
   * Issue #495: cap on per-symbol retries after a batch quote pass, so a
   * broker-wide outage cannot turn one screen into hundreds of requests.
   */
  maxIndividualQuoteRetries: number;
  /**
   * Issue #1770: per-run subrequest budget for stock quote acquisition
   * (batch calls + per-symbol fetches, retries included — every actual
   * upstream invocation charges one unit). The options side already
   * enforces its own ledger (#1204/#1545); this is the stock-side
   * twin. Default 35 leaves headroom under the Workers Free 50
   * external-subrequest cap for the rest of the invocation, exactly
   * like the options default; the default E*TRADE path costs at most
   * 33 attempts (1 batch chunk x 3 retries + 10 per-symbol x 3), so
   * ordinary runs are untouched and only fan-out past the budget
   * defers. Run-scoped override: pass `config` to acquireUniverse;
   * built-in default here.
   */
  maxSubrequestsPerRun: number;
  /** ms pause between quote batches (rate-limit pacing). */
  batchPauseMs: number;
  /** Default max standout opportunities per run. */
  defaultMaxItems: number;
  /** Retained run history cap. */
  historyLimit: number;
  /** Default sector label. */
  defaultSector: string;
}

export interface ScreenerRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface ScreenerIndicatorConfig {
  /** Sentiment: |change%| thresholds for very_bullish/bullish/bearish/very_bearish. */
  sentimentStrongPct: number;
  sentimentMildPct: number;
  /** Directional flag: |change%| at or above this. */
  directionalPct: number;
  /** Range zone: 52-week position at/above = overbought, at/below = oversold. */
  rangeOverbought: number;
  rangeOversold: number;
  /** Value zone: P/E below = undervalued, above = overvalued. */
  valueUndervaluedPe: number;
  valueOvervaluedPe: number;
}

export interface ScreenerGradeConfig {
  /** Percentile → grade boundaries, descending. */
  gradeBoundaries: Array<{ min: number; grade: string }>;
  /** Composite percentile → quant rating boundaries, descending. */
  quantBoundaries: Array<{ min: number; rating: string }>;
  /** Value signal weights: P/E vs 52-week-low distance. */
  valuePeWeight: number;
  valueRangeWeight: number;
  /** P/E cap for normalization (outlier bound). */
  valuePeCap: number;
  /** Minimum peers for a percentile grade. */
  minPeers: number;
}

export interface ScreenerYahooConfig {
  /** Daily history range for RSI/MACD/gaps. */
  historyRange: string;
  /** Concurrent history fetches. */
  fetchConcurrency: number;
  /** Per-request timeout ms. */
  requestTimeoutMs: number;
  /** Minimum bars for RSI(14). */
  rsiMinBars: number;
  /** Minimum bars for MACD(12,26,9). */
  macdMinBars: number;
  /** Gap classification thresholds (%). */
  gapUpPct: number;
  gapDownPct: number;
}

export interface ScreenerUniverseConfig {
  defaultMaxSymbols: Record<string, number>;
  /** Market-cap rank slices [start, end) for rank-based universes. */
  nasdaq100Size: number;
  sp100Size: number;
  sp500Size: number;
  russell2000Start: number;
  russell2000End: number;
}

export interface ScreenerConfig {
  acquisition: ScreenerAcquisitionConfig;
  retry: ScreenerRetryConfig;
  indicators: ScreenerIndicatorConfig;
  grades: ScreenerGradeConfig;
  yahoo: ScreenerYahooConfig;
  universes: ScreenerUniverseConfig;
}

export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = {
  acquisition: {
    defaultMaxSymbols: 50,
    quoteConcurrency: 10,
    quoteBatchSize: 50,
    maxIndividualQuoteRetries: 10,
    maxSubrequestsPerRun: 35,
    batchPauseMs: 0,
    defaultMaxItems: 5,
    historyLimit: 20,
    defaultSector: "Technology",
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
  },
  indicators: {
    sentimentStrongPct: 3,
    sentimentMildPct: 0.5,
    directionalPct: 2,
    rangeOverbought: 0.9,
    rangeOversold: 0.1,
    valueUndervaluedPe: 15,
    valueOvervaluedPe: 30,
  },
  grades: {
    gradeBoundaries: [
      { min: 95, grade: "A+" }, { min: 87, grade: "A" }, { min: 80, grade: "A-" },
      { min: 70, grade: "B+" }, { min: 60, grade: "B" }, { min: 50, grade: "B-" },
      { min: 40, grade: "C+" }, { min: 30, grade: "C" }, { min: 20, grade: "C-" },
      { min: 12, grade: "D+" }, { min: 5, grade: "D" }, { min: 0, grade: "F" },
    ],
    quantBoundaries: [
      { min: 80, rating: "Strong Buy" }, { min: 60, rating: "Buy" },
      { min: 40, rating: "Hold" }, { min: 20, rating: "Sell" },
      { min: 0, rating: "Strong Sell" },
    ],
    valuePeWeight: 0.6,
    valueRangeWeight: 0.4,
    valuePeCap: 60,
    minPeers: 3,
  },
  yahoo: {
    historyRange: "3mo",
    fetchConcurrency: 8,
    requestTimeoutMs: 10000,
    rsiMinBars: 15,
    macdMinBars: 27,
    gapUpPct: 1,
    gapDownPct: -1,
  },
  universes: {
    defaultMaxSymbols: {
      TECH: 50,
      NASDAQ100: 100,
      SP100: 100,
      SP500: 500,
      RUSSELL2000: 200,
      ETF: 100,
      // Zero means use every listing selected by the live universe selector.
      LEV_ETF: 0,
      ALL: 0,
    },
    nasdaq100Size: 100,
    sp100Size: 100,
    sp500Size: 500,
    russell2000Start: 1000,
    russell2000End: 3000,
  },
};

/**
 * Resolve the effective config: defaults deep-merged with
 * env.SCREENER_CONFIG (JSON) when present.
 */
export function getScreenerConfig(env?: { SCREENER_CONFIG?: string }): ScreenerConfig {
  const raw = env?.SCREENER_CONFIG;
  if (!raw) return DEFAULT_SCREENER_CONFIG;
  try {
    const override = JSON.parse(raw) as Partial<ScreenerConfig>;
    return {
      acquisition: { ...DEFAULT_SCREENER_CONFIG.acquisition, ...override.acquisition },
      retry: { ...DEFAULT_SCREENER_CONFIG.retry, ...override.retry },
      indicators: { ...DEFAULT_SCREENER_CONFIG.indicators, ...override.indicators },
      grades: { ...DEFAULT_SCREENER_CONFIG.grades, ...override.grades },
      yahoo: { ...DEFAULT_SCREENER_CONFIG.yahoo, ...override.yahoo },
      universes: {
        ...DEFAULT_SCREENER_CONFIG.universes,
        ...override.universes,
        defaultMaxSymbols: {
          ...DEFAULT_SCREENER_CONFIG.universes.defaultMaxSymbols,
          ...override.universes?.defaultMaxSymbols,
        },
      },
    };
  } catch {
    return DEFAULT_SCREENER_CONFIG;
  }
}
