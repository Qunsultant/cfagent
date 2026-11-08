import defaultConfig from "../../environment.config.json";
import { RISK_MATH } from "../shared/riskMath";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/etapiConfig",
});

/** Issue #1545: leave headroom under the Workers Free 50 external-subrequest cap. */
export const DEFAULT_SUBREQUEST_BUDGET = 35;

export interface EtapiScreenerConfig {
  maxScanSymbols: number;
  maxExpirationsPerSymbol: number;
  /**
   * Issue #1545: per-scan budget for actual options chain acquisition
   * fetch attempts (including .json fallback fetches) inside one Worker
   * invocation. The event calendar is independently capped at five live
   * symbol lookups, and the scheduled path also fetches listings. The
   * default leaves headroom under the Workers Free external-subrequest
   * limit; higher values must match the deployed Worker limit. Symbols that do not fit
   * are deferred with a named reason — never fetched past the budget.
   */
  subrequestBudget: number;
  defaultMaxDte: number;
  defaultMinDte: number;
  defaultQuoteAgeSeconds: number;
  maxReturnedContracts: number;
  maxRejectionsReturned: number;
  symbolFetchConcurrency: number;
  expiryFetchConcurrency: number;
  unusualVolumeOiRatio: number;
  highDeltaThreshold: number;
  highIvThreshold: number;
  lowIvThreshold: number;
  atmBandPct: number;
}

export interface EtapiStrategyScoreWeights {
  thesisAlignment: number;
  targetRewardRisk: number;
  liquidity: number;
  volatilityAlignment: number;
  thetaBurden: number;
  freshness: number;
  // Issue #29: the client engine's lenses, absorbed server-side (see
  // strategyEngine.resolveScoreWeights for the bias mapping).
  popAlignment: number;
  cushion: number;
  capitalEfficiency: number;
}

export interface EtapiStrategyEngineConfig {
  riskFreeRate: number;
  feePerContract: number;
  maxCombinations: number;
  detailLimit: number;
  maxLegs: number;
  scoreWeights: EtapiStrategyScoreWeights;
}

/** Fit-gate parameters for opportunity scans (issue #24): the bar a
 *  symbol's best pick must clear for the symbol to count as a "fit".
 *  Defaults are set from the fixture pick distribution (probe, #24):
 *  standard FRESH recommended picks score 62+ composite with POP 0.36+,
 *  so these defaults pass them while stale / research-only picks fail
 *  on freshness and confidence regardless of their composite. */
export interface EtapiFitGateConfig {
  minCompositeScore: number;
  minProbabilityOfProfit: number;
  requireFresh: boolean;
  minConfidence: "LOW" | "MEDIUM" | "HIGH";
}

export interface EtapiOpportunityScannerConfig {
  maxScanSymbols: number;
  concurrency: number;
  fitGate: EtapiFitGateConfig;
  /** Legacy thesis target factors (spot multipliers). Used only as the
   *  fallback when a symbol's chain yields no expected-move estimate
   *  (issue #25); the primary derivation is targetEmMultiples. */
  targetFactors: {
    bullish: number;
    bearish: number;
    large_move: number;
    range_bound: number;
  };
  /** Thesis targets expressed in expected-move units (issue #25):
   *  signed multiples of the 1-sigma move to expiry implied by each
   *  name's own chain, so a "bullish" target is the same statistical
   *  distance for a high-IV name as for a low-IV name. Calibration
   *  anchor: at IV 30% over 30 days (EM ≈ 8.6% of spot) these multiples
   *  reproduce the legacy targetFactors ≈1.05 / 0.95 / 1.10 / 1.00. */
  targetEmMultiples: {
    bullish: number;
    bearish: number;
    large_move: number;
    range_bound: number;
  };
}

/** Discovery (issue #14) signal thresholds. Every rule in the v1
 *  signal catalog reads its bar from here, never from a literal, so
 *  calibration is a config change rather than a deploy. The defaults
 *  are v1 judgment calls pinned by tests/discovery_signals.test.ts:
 *  IV rank bands match the common 20/80 convention; the range-pin
 *  width (6% over 20 sessions) separates genuinely pinned names from
 *  ordinary consolidation at typical large-cap volatility. */
export interface EtapiDiscoveryConfig {
  /** IV rank at or above which IV_EXPENSIVE fires. */
  ivExpensiveRank: number;
  /** IV rank at or below which IV_CHEAP fires. */
  ivCheapRank: number;
  /** Fast SMA window (sessions) for trend alignment. */
  trendFastWindow: number;
  /** Slow SMA window (sessions) for trend alignment. */
  trendSlowWindow: number;
  /** Minimum absolute fast-window return (%) for a trend to count. */
  trendMinReturnPct: number;
  /** Sessions over which the range width / drift are measured. */
  rangeWindowDays: number;
  /** Max (high − low) / spot (%) over the range window for RANGE_PINNED. */
  rangePinMaxWidthPct: number;
  /** Max absolute return (%) over the range window for RANGE_PINNED. */
  rangePinMaxDriftPct: number;
  /** Sessions of prior highs/lows for BREAKOUT_WATCH. */
  breakoutLookbackDays: number;
  /** Close within this % below the prior high counts as a watch. */
  breakoutProximityPct: number;
  /** Liquidity gate: minimum aggregate open interest across the chain. */
  minOpenInterest: number;
  /** Liquidity gate: minimum aggregate volume across the chain. */
  minVolume: number;
  /** Liquidity gate: maximum median spread (% of mid) across the chain. */
  maxMedianSpreadPct: number;
  /** Optionability pre-screen: minimum contracts in the chain snapshot. */
  minContractsForOptionable: number;
  /** DTE window the inference assigns per thesis (slice 2): trend
   *  expressions get a standard swing window, range expressions a
   *  longer premium window, large-move the shortest (the move either
   *  happens soon or the thesis is wrong). */
  dteWindows: {
    bullish: DiscoveryDteWindow;
    bearish: DiscoveryDteWindow;
    range_bound: DiscoveryDteWindow;
    large_move: DiscoveryDteWindow;
  };
  /** Composite-score floor for the discovery fit gate (spec §7 /
   *  issue #14): the scanner's own gate defaults to 55 from its
   *  fixture distribution (#24); discovery's settled floor is 50,
   *  applied over the scanner gate's other criteria (slice 3). */
  compositeFloor: number;
  /** Score movement (composite points) at or beyond which a
   *  continuing setup counts as STRENGTHENED / WEAKENED between
   *  comparable runs (slice 4); inside the band, a confidence change
   *  decides, and no change at all is UNCHANGED. */
  deltaScoreThreshold: number;
  /** Phase 2 (issue #18): earnings within this many days makes a
   *  name earnings-adjacent — EVENT_NEAR fires, range_bound
   *  inference is suppressed unless an IV signal dominates, and the
   *  setup is labeled on its card. */
  eventNearDays: number;
  /** Phase 2 (issue #18): MOVE_UNDERPRICED fires when the implied
   *  move (ATM IV) is at most this fraction of the name's realized
   *  volatility into a near event — the market is pricing less
   *  movement than the name habitually delivers. */
  moveUnderpricedMaxRatio: number;
  /** Phase 2 (issue #18): a FLOW_* signal fires when one side's
   *  share of chain-derived directional premium reaches this
   *  fraction (0.65 = roughly 2:1 dominance). */
  flowDominanceShare: number;
  /** Phase 2 (issue #18): minimum chain-derived flow records
   *  before either FLOW_* signal may fire — a pair of prints is
   *  anecdote, not flow. */
  flowMinRecords: number;
  /** Phase 2 (issue #18, Decision 2): a NEW setup alerts only at
   *  or above this discoveryScore. */
  alertMinScore: number;
  /** Phase 2 (issue #18, Decision 2): maximum discovery alerts
   *  per day per scope — the anti-spam budget. */
  alertDailyCap: number;
  /** Phase 2 (issue #18): Strategy Profile biasing — composite
   *  points added, for PICK SELECTION ONLY, to candidates whose
   *  strategy type the caller's profile allows. Recorded scores
   *  always stay the raw composite; the boost exists only in the
   *  comparison. */
  profileBiasPoints: number;
}

export interface DiscoveryDteWindow {
  minDte: number;
  maxDte: number;
}

export interface EtapiExpirationGroup {
  id: "near-term" | "mid-term" | "long-term";
  label: string;
  minDays: number;
  maxDays: number;
}

export interface EtapiLlmIdeasConfig {
  inputTokenBudget: number;
  defaultModel: string;
  expirationGroups: EtapiExpirationGroup[];
}

export interface EtapiClientConfig {
  defaultTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  detailFlag: "ALL" | "MF" | "INTRADAY";
  includeWeekly: boolean;
}

export interface EtapiCacheConfig {
  quoteTtlSeconds: number;
  chainTtlSeconds: number;
  expirationsTtlSeconds: number;
}

export interface AiModelDefinition {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  category: "flagship" | "reasoning" | "fast" | "analytical" | "general";
  description?: string;
}

export interface AiConfig {
  defaultModel: string;
  // #930: failover-model key removed — no LLM call path consumed it, so the
  // advertised failover was a fabricated surface. Its removal is subject
  // to the owner waiver recorded on #913 before this PR is marked ready.
  fastModel: string;
  reasoningModel: string;
  availableModels: AiModelDefinition[];
  taskModels: {
    nlqPlanning?: string;
    nlqValidation?: string;
    optionsIdeas?: string;
    optionsComparison?: string;
    newsSentiment?: string;
    orchestrator?: string;
    marketResearch?: string;
    searchAgent?: string;
    // Issue #3773: the chat voice channel's model backend — the
    // speech-to-text and text-to-speech models, resolved through
    // resolveAiModelName(env, "voiceStt" | "voiceTts"). These are
    // code defaults only; #3772 externalizes the values.
    voiceStt?: string;
    voiceTts?: string;
    [task: string]: string | undefined;
  };
  temperatureDefaults: {
    deterministic: number;
    analytical: number;
    creative: number;
  };
  maxTokens: {
    nlq: number;
    ideas: number;
    comparison: number;
    orchestrator: number;
    search: number;
  };
}

export interface VoiceAgentConfig {
  companyToTicker: Record<string, string>;
  wordToNumber: Record<string, string>;
  phoneticCorrections: Record<string, string>;
  maxPromptLength: number;
  defaultOrderType: string;
}

export interface TradingConstraintsConfig {
  maxOrderQuantity: number;
  maxOrderTotalUsd: number;
  defaultOrderQuantity: number;
  maxDiscountPercent: number;
  maxPremiumPercent: number;
  requireHitlVoiceConfirmation: boolean;
}

export interface ExternalApisConfig {
  nasdaqListings: {
    url: string;
    pageSize: number;
    timeoutMs: number;
    exchanges: string[];
  };
  yahooFinance: {
    timeoutMs: number;
    maxRetries: number;
  };
}

export interface EtapiConfig {
  screener: EtapiScreenerConfig;
  strategyEngine: EtapiStrategyEngineConfig;
  opportunityScanner: EtapiOpportunityScannerConfig;
  discovery: EtapiDiscoveryConfig;
  llmIdeas: EtapiLlmIdeasConfig;
  client: EtapiClientConfig;
  cache: EtapiCacheConfig;
  ai: AiConfig;
  voice: VoiceAgentConfig;
  tradingConstraints: TradingConstraintsConfig;
  externalApis: ExternalApisConfig;
}

// Defaults equal resolveScoreWeights(undefined) — i.e. the balanced
// (bias 50) blend of the server-native factors (55% of the total) and the
// absorbed client lenses (45%: return / chance / safety / capital).
const DEFAULT_SCORE_WEIGHTS: EtapiStrategyScoreWeights = {
  thesisAlignment: 0.205,
  targetRewardRisk: 0.154,
  liquidity: 0.138,
  volatilityAlignment: 0.069,
  thetaBurden: 0.034,
  freshness: 0.103,
  popAlignment: 0.154,
  cushion: 0.077,
  capitalEfficiency: 0.066,
};

const BASELINE_FALLBACK_CONFIG: EtapiConfig = {
  screener: {
    maxScanSymbols: 20,
    maxExpirationsPerSymbol: 100,
    subrequestBudget: DEFAULT_SUBREQUEST_BUDGET,
    defaultMaxDte: 90,
    defaultMinDte: 0,
    defaultQuoteAgeSeconds: 60,
    maxReturnedContracts: 10000,
    maxRejectionsReturned: 1000,
    symbolFetchConcurrency: 4,
    expiryFetchConcurrency: 3,
    unusualVolumeOiRatio: 1.5,
    highDeltaThreshold: 0.65,
    highIvThreshold: 0.70,
    lowIvThreshold: 0.30,
    atmBandPct: 0.02,
  },
  strategyEngine: {
    riskFreeRate: RISK_MATH.riskFreeRate,
    feePerContract: 0.65,
    maxCombinations: 5000,
    detailLimit: 5000,
    maxLegs: 6,
    scoreWeights: DEFAULT_SCORE_WEIGHTS,
  },
  opportunityScanner: {
    maxScanSymbols: 20,
    concurrency: 3,
    fitGate: {
      minCompositeScore: 55,
      minProbabilityOfProfit: 0.35,
      requireFresh: true,
      minConfidence: "MEDIUM",
    },
    targetFactors: {
      bullish: 1.05,
      bearish: 0.95,
      large_move: 1.10,
      range_bound: 1.00,
    },
    targetEmMultiples: {
      bullish: 0.6,
      bearish: -0.6,
      large_move: 1.2,
      range_bound: 0,
    },
  },
  discovery: {
    ivExpensiveRank: 80,
    ivCheapRank: 20,
    trendFastWindow: 20,
    trendSlowWindow: 50,
    trendMinReturnPct: 2,
    rangeWindowDays: 20,
    rangePinMaxWidthPct: 6,
    rangePinMaxDriftPct: 2,
    breakoutLookbackDays: 20,
    breakoutProximityPct: 1.5,
    minOpenInterest: 5000,
    minVolume: 500,
    maxMedianSpreadPct: 8,
    minContractsForOptionable: 5,
    dteWindows: {
      bullish: { minDte: 21, maxDte: 60 },
      bearish: { minDte: 21, maxDte: 60 },
      range_bound: { minDte: 30, maxDte: 60 },
      large_move: { minDte: 14, maxDte: 45 },
    },
    compositeFloor: 50,
    deltaScoreThreshold: 5,
    eventNearDays: 21,
    moveUnderpricedMaxRatio: 0.8,
    flowDominanceShare: 0.65,
    flowMinRecords: 3,
    alertMinScore: 70,
    alertDailyCap: 5,
    profileBiasPoints: 5,
  },
  llmIdeas: {
    inputTokenBudget: 90000,
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    expirationGroups: [
      { id: "near-term", label: "Near-term (0–30 days)", minDays: 0, maxDays: 30 },
      { id: "mid-term", label: "Mid-term (31–90 days)", minDays: 31, maxDays: 90 },
      { id: "long-term", label: "Long-term (91+ days)", minDays: 91, maxDays: 9999 },
    ],
  },
  client: {
    defaultTimeoutMs: 15000,
    maxRetries: 2,
    retryDelayMs: 500,
    detailFlag: "ALL",
    includeWeekly: true,
  },
  cache: {
    quoteTtlSeconds: 30,
    chainTtlSeconds: 60,
    expirationsTtlSeconds: 300,
  },
  ai: {
    defaultModel: "@cf/zai-org/glm-4.7-flash",
    fastModel: "@cf/zai-org/glm-4.7-flash",
    reasoningModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    availableModels: [
      {
        id: "@cf/zai-org/glm-4.7-flash",
        name: "GLM 4.7 Flash (Flagship, 24k context)",
        provider: "workers-ai",
        contextWindow: 24000,
        supportsTools: true,
        supportsStreaming: true,
        category: "flagship",
        description: "High-speed reasoning, 24k context, native tool use, optimal for NLQ and trading execution",
      },
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        name: "Llama 3.3 70B Instruct FP8 Fast",
        provider: "workers-ai",
        contextWindow: 131072,
        supportsTools: true,
        supportsStreaming: true,
        category: "reasoning",
        description: "Deep multi-leg quantitative options reasoning and contract payoff evaluation",
      },
      {
        id: "@cf/meta/llama-3.1-70b-instruct",
        name: "Llama 3.1 70B Instruct",
        provider: "workers-ai",
        contextWindow: 131072,
        supportsTools: true,
        supportsStreaming: true,
        category: "general",
        description: "General financial Q&A, comprehensive explanations, and macro analysis",
      },
      {
        id: "@cf/qwen/qwen2.5-72b-instruct",
        name: "Qwen 2.5 72B Instruct",
        provider: "workers-ai",
        contextWindow: 32768,
        supportsTools: true,
        supportsStreaming: true,
        category: "analytical",
        description: "High precision mathematical reasoning, risk factor decomposition, and code synthesis",
      },
      {
        id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        name: "DeepSeek R1 Distill Qwen 32B",
        provider: "workers-ai",
        contextWindow: 65536,
        supportsTools: false,
        supportsStreaming: true,
        category: "reasoning",
        description: "Chain-of-thought deep analytical reasoning and scenario risk assessment",
      },
    ],
    taskModels: {
      nlqPlanning: "@cf/zai-org/glm-4.7-flash",
      nlqValidation: "@cf/zai-org/glm-4.7-flash",
      optionsIdeas: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      optionsComparison: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      newsSentiment: "@cf/zai-org/glm-4.7-flash",
      orchestrator: "@cf/zai-org/glm-4.7-flash",
      marketResearch: "@cf/zai-org/glm-4.7-flash",
      searchAgent: "@cf/zai-org/glm-4.7-flash",
      // Issue #3773: Workers AI speech models for the chat voice
      // channel's model backend (Whisper STT, MeloTTS TTS).
      voiceStt: "@cf/openai/whisper-large-v3-turbo",
      voiceTts: "@cf/myshell-ai/melotts",
    },
    temperatureDefaults: {
      deterministic: 0.0,
      analytical: 0.2,
      creative: 0.7,
    },
    maxTokens: {
      nlq: 2048,
      ideas: 4096,
      comparison: 4096,
      orchestrator: 2048,
      search: 2048,
    },
  },
  voice: {
    companyToTicker: {
      nvidia: "NVDA",
      nvda: "NVDA",
      apple: "AAPL",
      aapl: "AAPL",
      microsoft: "MSFT",
      msft: "MSFT",
      tesla: "TSLA",
      tsla: "TSLA",
      amazon: "AMZN",
      amzn: "AMZN",
      google: "GOOGL",
      googl: "GOOGL",
      alphabet: "GOOGL",
      broadcom: "AVGO",
      avgo: "AVGO",
      amd: "AMD",
      meta: "META",
      palantir: "PLTR",
      pltr: "PLTR",
      coinbase: "COIN",
      coin: "COIN",
      jpmorgan: "JPM",
      jpm: "JPM",
      goldman: "GS",
      gs: "GS",
      schwab: "SCHW",
      schw: "SCHW",
      robinhood: "HOOD",
      hood: "HOOD",
      spy: "SPY",
      qqq: "QQQ",
    },
    wordToNumber: {
      one: "1",
      two: "2",
      three: "3",
      four: "4",
      five: "5",
      six: "6",
      seven: "7",
      eight: "8",
      nine: "9",
      ten: "10",
      fifteen: "15",
      twenty: "20",
      twentyfive: "25",
      fifty: "50",
      hundred: "100",
    },
    phoneticCorrections: {
      "text talks": "tech stocks",
      "text talk": "tech stock",
      "tech talks": "tech stocks",
      "text stocks": "tech stocks",
      "talks": "stocks",
    },
    maxPromptLength: 500,
    defaultOrderType: "MARKET",
  },
  tradingConstraints: {
    maxOrderQuantity: 10000,
    maxOrderTotalUsd: 500000,
    defaultOrderQuantity: 1,
    maxDiscountPercent: 90,
    maxPremiumPercent: 500,
    requireHitlVoiceConfirmation: true,
  },
  externalApis: {
    nasdaqListings: {
      url: "https://api.nasdaq.com/api/screener/stocks",
      pageSize: 5000,
      // Measured API latency is 3.7–4.8s+ per request; 2500ms aborted every
      // attempt (issue #246). 20s gives comfortable headroom for the full
      // table dump (1–2MB per exchange).
      timeoutMs: 20000,
      exchanges: ["nasdaq", "nyse", "amex"],
    },
    yahooFinance: {
      timeoutMs: 5000,
      maxRetries: 2,
    },
  },
};

let runtimeEtapiOverrides: Partial<EtapiConfig> | null = null;

export function setRuntimeEtapiConfigOverrides(overrides: Partial<EtapiConfig> | null): void {
  runtimeEtapiOverrides = overrides;
}

function deepMerge<T extends Record<string, any>>(target: T, source?: Record<string, any>): T {
  if (!source) return target;
  const output = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    if (typeof srcVal === "object" && !Array.isArray(srcVal) && typeof (target as any)[key] === "object") {
      (output as any)[key] = deepMerge((target as any)[key], srcVal);
    } else {
      (output as any)[key] = srcVal;
    }
  }
  return output;
}

export function getEtapiConfig(env?: Partial<Env>, overrideEnv?: string): EtapiConfig {
  const activeEnv = (
    overrideEnv ||
    (env?.ETRADE_ENVIRONMENT === "sandbox" ? "TEST" : env?.ETRADE_ENVIRONMENT === "live" ? "PROD" : undefined) ||
    env?.APP_ENV ||
    defaultConfig.environment ||
    "PROD"
  ).toUpperCase();

  // 1. Start with baseline
  let config = deepMerge(BASELINE_FALLBACK_CONFIG, (defaultConfig as any).defaults?.etapi);

  // 2. Merge environment-specific overrides from environment.config.json
  const envBlock = (defaultConfig as any).environments?.[activeEnv]?.etapi;
  if (envBlock) {
    config = deepMerge(config, envBlock);
  }

  // 3. Merge env.ETAPI_CONFIG if provided as JSON string or object
  if (env && (env as any).ETAPI_CONFIG) {
    try {
      const raw = (env as any).ETAPI_CONFIG;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      config = deepMerge(config, parsed);
    } catch (e) {
      structuredLog.warn("etapi.config_parse_failed", {
        message: "[etapiConfig] Failed to parse env.ETAPI_CONFIG",
        source: "env.ETAPI_CONFIG",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. Check process.env if available in Node / test environment
  if (typeof process !== "undefined" && process?.env) {
    const proc = process.env;
    if (proc.ETAPI_CONFIG) {
      try {
        const parsed = JSON.parse(proc.ETAPI_CONFIG);
        config = deepMerge(config, parsed);
      } catch (e) {
        structuredLog.warn("etapi.config_parse_failed", {
          message: "[etapiConfig] Failed to parse process.env.ETAPI_CONFIG",
          source: "process.env.ETAPI_CONFIG",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (proc.ETAPI_MAX_SCAN_SYMBOLS) config.screener.maxScanSymbols = Number(proc.ETAPI_MAX_SCAN_SYMBOLS);
    if (proc.ETAPI_MAX_RETURNED_CONTRACTS) config.screener.maxReturnedContracts = Number(proc.ETAPI_MAX_RETURNED_CONTRACTS);
    if (proc.ETAPI_DEFAULT_MAX_DTE) config.screener.defaultMaxDte = Number(proc.ETAPI_DEFAULT_MAX_DTE);
    if (proc.ETAPI_SUBREQUEST_BUDGET) config.screener.subrequestBudget = Number(proc.ETAPI_SUBREQUEST_BUDGET);
    if (proc.ETAPI_RISK_FREE_RATE) config.strategyEngine.riskFreeRate = Number(proc.ETAPI_RISK_FREE_RATE);
    if (proc.ETAPI_FEE_PER_CONTRACT) config.strategyEngine.feePerContract = Number(proc.ETAPI_FEE_PER_CONTRACT);
    if (proc.ETAPI_LLM_TOKEN_BUDGET) config.llmIdeas.inputTokenBudget = Number(proc.ETAPI_LLM_TOKEN_BUDGET);
  }

  // 5. Apply runtime in-memory overrides (e.g. for testing)
  if (runtimeEtapiOverrides) {
    config = deepMerge(config, runtimeEtapiOverrides);
  }

  return config;
}

export function getScreenerConfig(env?: Partial<Env>, overrideEnv?: string): EtapiScreenerConfig {
  return getEtapiConfig(env, overrideEnv).screener;
}

export function getStrategyEngineConfig(env?: Partial<Env>, overrideEnv?: string): EtapiStrategyEngineConfig {
  return getEtapiConfig(env, overrideEnv).strategyEngine;
}

export function getOpportunityScannerConfig(env?: Partial<Env>, overrideEnv?: string): EtapiOpportunityScannerConfig {
  return getEtapiConfig(env, overrideEnv).opportunityScanner;
}

export function getDiscoveryConfig(env?: Partial<Env>, overrideEnv?: string): EtapiDiscoveryConfig {
  return getEtapiConfig(env, overrideEnv).discovery;
}

export function getLlmIdeasConfig(env?: Partial<Env>, overrideEnv?: string): EtapiLlmIdeasConfig {
  return getEtapiConfig(env, overrideEnv).llmIdeas;
}

export function getClientConfig(env?: Partial<Env>, overrideEnv?: string): EtapiClientConfig {
  return getEtapiConfig(env, overrideEnv).client;
}

export function getCacheConfig(env?: Partial<Env>, overrideEnv?: string): EtapiCacheConfig {
  return getEtapiConfig(env, overrideEnv).cache;
}

export function getAiConfig(env?: Partial<Env>, overrideEnv?: string): AiConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.ai;
}

export function getVoiceConfig(env?: Partial<Env>, overrideEnv?: string): VoiceAgentConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.voice;
}

export function getTradingConstraints(env?: Partial<Env>, overrideEnv?: string): TradingConstraintsConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.tradingConstraints;
}

export function getExternalApisConfig(env?: Partial<Env>, overrideEnv?: string): ExternalApisConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.externalApis;
}

export function getAvailableAiModels(env?: Partial<Env>, overrideEnv?: string): AiModelDefinition[] {
  return getAiConfig(env, overrideEnv).availableModels;
}
