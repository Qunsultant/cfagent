/**
 * Dynamic Options Screener Engine
 *
 * Implements:
 * - Multi-symbol and sector-wide options chain scanning.
 * - Multi-factor filtering: IV, Delta, Gamma, Theta, Volume, Open Interest, DTE, Premium, Moneyness, Vega, Rho.
 * - Unusual option activity detection (Vol/OI divergence, IV skew).
 * - Real-time integration with E*TRADE REST API option chains.
 * - Input sanitization (NaN/enum/bounds), bounded upstream fan-out (symbol, expiration, and
 *   result caps with pooled concurrency), per-symbol fetch diagnostics, and machine-readable
 *   rejection codes.
 */

import type {
  OptionScreenerFilter,
  OptionScreenResult,
  OptionScreenSortKey,
  ScreenedOptionContractItem,
  OptionScreenRejection,
  OptionScreenFetchError,
  ETradeOptionChain,
  ETradeOptionChainContract,
} from "../types";
import type { OptionChainSource } from "./optionChainSource";
import { type NasdaqStockListing } from "../services/nasdaqListings";
import type { NasdaqUniverseDeps } from "./screenerPipeline";
import { getScreenerConfig, type EtapiScreenerConfig } from "../config/etapiConfig";

const baseScreenerConfig = getScreenerConfig();
/** Maximum underlyings (explicit or discovered) any single screen may query. */
export const MAX_SCAN_SYMBOLS = baseScreenerConfig.maxScanSymbols;
/** Maximum expirations fetched per symbol per screen (nearest first). */
export const MAX_EXPIRATIONS_PER_SYMBOL = baseScreenerConfig.maxExpirationsPerSymbol;
/** Default DTE window applied when the caller supplies neither minDte nor maxDte. */
export const DEFAULT_MAX_DTE = baseScreenerConfig.defaultMaxDte;
/** Quote-age reference (seconds) used for FRESH/STALE labels when no filter is supplied. */
export const DEFAULT_QUOTE_AGE_SECONDS = baseScreenerConfig.defaultQuoteAgeSeconds;
/** Hard cap on returned contracts; `limit` is clamped to this value. */
export const MAX_RETURNED_CONTRACTS = baseScreenerConfig.maxReturnedContracts;
/** Rejection samples embedded in each result; the full count is reported via `rejectionCount`. */
export const MAX_REJECTIONS_RETURNED = baseScreenerConfig.maxRejectionsReturned;
/** Concurrent upstream symbol fetches per screen. */
const SYMBOL_FETCH_CONCURRENCY = baseScreenerConfig.symbolFetchConcurrency;
/** Concurrent upstream expiration fetches per symbol. */
const EXPIRY_FETCH_CONCURRENCY = baseScreenerConfig.expiryFetchConcurrency;
/** Unusual-activity signal threshold (volume / open interest). */
const UNUSUAL_VOLUME_OI_RATIO = baseScreenerConfig.unusualVolumeOiRatio;
const HIGH_DELTA_THRESHOLD = baseScreenerConfig.highDeltaThreshold;
const HIGH_IV_THRESHOLD = baseScreenerConfig.highIvThreshold;
const LOW_IV_THRESHOLD = baseScreenerConfig.lowIvThreshold;

/**
 * Builds a standard OCC OSI contract symbol (e.g. AAPL 2026-01-16 C 150 -> AAPL260116C00150000)
 * for contracts where E*TRADE did not supply an osiKey.
 */
function buildOsiSymbol(
  root: string,
  expiry: { year: number; month: number; day: number },
  type: "CALL" | "PUT",
  strike: number
): string {
  const yy = String(expiry.year % 100).padStart(2, "0");
  const mm = String(expiry.month).padStart(2, "0");
  const dd = String(expiry.day).padStart(2, "0");
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${root.toUpperCase()}${yy}${mm}${dd}${type === "CALL" ? "C" : "P"}${strikeCode}`;
}

/**
 * Issue #1204: named reason recorded for a symbol whose chain fetches
 * were never issued because the scan's subrequest budget ran out. A
 * deferral is not an upstream failure: the symbol was not fetched, so
 * it must never be reported as a broker/quote failure — and the
 * scheduled coverage gate's top-skip-reason names the budget, which is
 * the actionable cause.
 */
export const SUBREQUEST_BUDGET_DEFERRED_REASON =
  "Subrequest budget exhausted: chain fetch deferred (Worker per-invocation subrequest limit).";

/**
 * Issue #1204: a per-scan ledger bounding how many upstream fetches
 * chain acquisition may issue inside one Worker invocation. The
 * ledger is shared across every per-symbol call of one scan (the
 * opportunity scanner snapshots symbols one by one over one screener
 * instance), so the bound applies to the scan, not to each symbol.
 * The chain source charges it synchronously at each outbound fetch,
 * including any .json fallback, so concurrent calls cannot overspend.
 */
export interface SubrequestBudget {
  readonly limit: number;
  used: number;
  exhausted: boolean;
  tryConsume(): boolean;
}

export function createSubrequestBudget(limit: number): SubrequestBudget {
  const budget: SubrequestBudget = {
    limit: Math.max(0, Math.floor(limit)),
    used: 0,
    exhausted: false,
    tryConsume() {
      if (budget.used >= budget.limit) {
        budget.exhausted = true;
        return false;
      }
      budget.used += 1;
      return true;
    },
  };
  return budget;
}

/** Runs `fn` over `items` with at most `limit` in-flight executions, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

export interface SanitizedOptionScreenFilter {
  /** The effective filter actually applied (defaults filled in, invalid values removed). */
  filter: OptionScreenerFilter;
  /** Non-fatal notices about dropped, clamped, or defaulted inputs. */
  warnings: string[];
}

const CONTRACT_TYPES = new Set(["CALL", "PUT", "BOTH"]);
const MONEYNESS_VALUES = new Set(["ITM", "OTM", "ATM", "ALL"]);
const SORT_KEYS = new Set<OptionScreenSortKey>(["volume", "spreadPct", "iv", "volumeOiRatio", "dte", "strikeDistance"]);

type NumericFilterKey = Exclude<keyof OptionScreenerFilter, "underlyingSymbols" | "sector" | "contractType" | "moneyness" | "sortBy">;

const NUMERIC_FILTER_KEYS: NumericFilterKey[] = [
  "maxUnderlyings", "minVolume", "minOpenInterest", "maxSpreadPct", "maxQuoteAgeSeconds",
  "minDelta", "maxDelta", "minGamma", "maxGamma", "minTheta", "maxTheta",
  "minPrice", "maxPrice", "minImpliedVolatility", "maxImpliedVolatility",
  "minDte", "maxDte", "maxStrikeDistancePct", "limit",
  "minVega", "maxVega", "minRho", "maxRho",
];

const NON_NEGATIVE_KEYS: NumericFilterKey[] = [
  "maxUnderlyings", "minVolume", "minOpenInterest", "maxSpreadPct", "maxQuoteAgeSeconds",
  "minPrice", "maxPrice", "minImpliedVolatility", "maxStrikeDistancePct", "minDte", "maxDte", "limit",
  "minVega", "maxVega", "minRho", "maxRho",
];

const BOUNDED_PAIRS: Array<[NumericFilterKey, NumericFilterKey]> = [
  ["minDte", "maxDte"],
  ["minDelta", "maxDelta"],
  ["minGamma", "maxGamma"],
  ["minTheta", "maxTheta"],
  ["minImpliedVolatility", "maxImpliedVolatility"],
  ["minPrice", "maxPrice"],
  ["minVega", "maxVega"],
  ["minRho", "maxRho"],
];

/**
 * Normalizes a caller-supplied filter into the filter that is actually executed:
 * drops non-finite numerics (e.g. Number("abc") from query strings), validates enums,
 * clamps negative/oversized bounds, swaps inverted min/max pairs, caps the universe and
 * result sizes, and applies the default DTE window. Never throws; every adjustment is
 * reported in `warnings`.
 */
export function sanitizeOptionScreenerFilter(raw: OptionScreenerFilter = {}, config: EtapiScreenerConfig = getScreenerConfig()): SanitizedOptionScreenFilter {
  const warnings: string[] = [];
  const filter: OptionScreenerFilter = { ...raw };
  if (raw.underlyingSymbols) filter.underlyingSymbols = [...raw.underlyingSymbols];
  const numeric = filter as Record<string, unknown>;

  for (const key of NUMERIC_FILTER_KEYS) {
    const value = filter[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      delete filter[key];
      warnings.push(`Ignored invalid numeric filter '${String(key)}'.`);
    }
  }

  if (filter.contractType !== undefined && !CONTRACT_TYPES.has(filter.contractType)) {
    delete filter.contractType;
    warnings.push("Ignored unrecognized contractType; screening both calls and puts.");
  }
  if (filter.moneyness !== undefined && !MONEYNESS_VALUES.has(filter.moneyness)) {
    delete filter.moneyness;
    warnings.push("Ignored unrecognized moneyness filter.");
  }
  if (filter.sortBy !== undefined && !SORT_KEYS.has(filter.sortBy)) {
    delete filter.sortBy;
    warnings.push("Ignored unrecognized sortBy; defaulting to volume.");
  }

  for (const key of NON_NEGATIVE_KEYS) {
    const value = filter[key];
    if (typeof value === "number" && value < 0) {
      numeric[key] = 0;
      warnings.push(`Clamped '${String(key)}' to 0.`);
    }
  }

  for (const key of ["minDelta", "maxDelta"] as const) {
    const value = filter[key];
    if (typeof value === "number" && (value < 0 || value > 1)) {
      filter[key] = Math.min(1, Math.max(0, value));
      warnings.push(`Clamped '${key}' into the 0..1 absolute-delta range.`);
    }
  }

  for (const [minKey, maxKey] of BOUNDED_PAIRS) {
    const min = filter[minKey];
    const max = filter[maxKey];
    if (typeof min === "number" && typeof max === "number" && min > max) {
      numeric[minKey] = max;
      numeric[maxKey] = min;
      warnings.push(`Swapped inverted '${String(minKey)}'/'${String(maxKey)}' bounds.`);
    }
  }

  if (filter.underlyingSymbols) {
    const normalized = Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    if (normalized.length > config.maxScanSymbols) {
      warnings.push(`Underlying list trimmed from ${normalized.length} to ${config.maxScanSymbols} symbols.`);
      normalized.length = config.maxScanSymbols;
    }
    if (normalized.length === 0) delete filter.underlyingSymbols;
    else filter.underlyingSymbols = normalized;
  }
  if (filter.maxUnderlyings !== undefined) {
    const floored = Math.max(1, Math.floor(filter.maxUnderlyings));
    if (floored > config.maxScanSymbols) {
      warnings.push(`maxUnderlyings capped at ${config.maxScanSymbols}.`);
      filter.maxUnderlyings = config.maxScanSymbols;
    } else {
      filter.maxUnderlyings = floored;
    }
  }
  if (filter.limit !== undefined) {
    const floored = Math.max(1, Math.floor(filter.limit));
    if (floored > config.maxReturnedContracts) {
      warnings.push(`limit capped at ${config.maxReturnedContracts} contracts.`);
      filter.limit = config.maxReturnedContracts;
    } else {
      filter.limit = floored;
    }
  } else {
    filter.limit = config.maxReturnedContracts;
  }

  if (filter.expirationDteBands !== undefined) {
    const bands = Array.isArray(filter.expirationDteBands) ? filter.expirationDteBands : [];
    const normalizedBands = bands.slice(0, 12).flatMap((band) => {
      if (!band || !Number.isFinite(band.minDte) || !Number.isFinite(band.maxDte)) return [];
      const minDte = Math.max(0, Math.floor(band.minDte));
      const maxDte = Math.max(0, Math.floor(band.maxDte));
      if (maxDte < minDte) return [];
      const requested = Number.isFinite(band.maxExpirations) ? Math.floor(band.maxExpirations!) : 4;
      return [{ minDte, maxDte, maxExpirations: Math.max(1, Math.min(8, requested)) }];
    });
    if (normalizedBands.length !== bands.length) warnings.push("Ignored invalid or excess expiration DTE bands.");
    filter.expirationDteBands = normalizedBands;
  }

  // Scanning every listed expiration fans out into dozens of upstream calls per symbol,
  // so an unbounded DTE window is never fetched implicitly.
  if (filter.minDte === undefined && filter.maxDte === undefined) {
    filter.minDte = config.defaultMinDte;
    filter.maxDte = config.defaultMaxDte;
    warnings.push(`No DTE window supplied; defaulting to ${config.defaultMinDte}-${config.defaultMaxDte} days to expiration.`);
  }

  return { filter, warnings };
}

/**
 * Issue #3186 - validation failure from fetchChains: carries the
 * sanitized filter + warnings so screenOptions can build the exact
 * error result it built before the split (same messages, same shape).
 */
export class OptionsValidationError extends Error {
  readonly filter: OptionScreenerFilter;
  readonly warnings: string[];
  constructor(message: string, filter: OptionScreenerFilter, warnings: string[]) {
    super(message);
    this.name = "OptionsValidationError";
    this.filter = filter;
    this.warnings = warnings;
  }
}


/**
 * Issue #3186 - the per-contract filter + enrich pass of
 * evaluateChains, split out so the options pipeline's enrich stage
 * wraps the same function. Maps every candidate contract through
 * evaluateContract (rejection-priority filters + signal enrichment);
 * never mutates its inputs.
 */
export interface EvaluatedContracts {
  passedContracts: ScreenedOptionContractItem[];
  rejections: OptionScreenRejection[];
  rejectionCount: number;
  totalContractsEvaluated: number;
}

export function evaluateContracts(
  chains: Array<{ symbol: string; chain: ETradeOptionChain }>,
  filter: OptionScreenerFilter = {},
  config: EtapiScreenerConfig = getScreenerConfig(),
): EvaluatedContracts {
  const rejections: OptionScreenRejection[] = [];
  const rejectionCounter = { total: 0 };
  const passedContracts: ScreenedOptionContractItem[] = [];
  let totalContractsEvaluated = 0;

  for (const item of chains) {
    const sym = item.symbol;
    const chain = item.chain;
    if (!chain || !chain.pairs || chain.pairs.length === 0) continue;

    const underlyingPrice = chain.underlyingPrice;
    const expiry = chain.selectedExpiry;
    if (!underlyingPrice || underlyingPrice <= 0 || !expiry) continue;

    const expDateStr = `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
    const expiryDateObj = new Date(Date.UTC(expiry.year, expiry.month - 1, expiry.day));
    const nowObj = new Date();
    const diffMs = expiryDateObj.getTime() - nowObj.getTime();
    const daysToExpiration = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (daysToExpiration < 0) continue;
    const context: ContractScreenContext = {
      symbol: sym,
      expiry,
      expirationDate: expDateStr,
      daysToExpiration,
      underlyingPrice,
    };

    for (const pair of chain.pairs) {
      const candidates: ETradeOptionChainContract[] = [];
      if (filter.contractType === "PUT") {
        if (pair.put) candidates.push(pair.put);
      } else if (filter.contractType === "CALL") {
        if (pair.call) candidates.push(pair.call);
      } else {
        if (pair.call) candidates.push(pair.call);
        if (pair.put) candidates.push(pair.put);
      }

      for (const c of candidates) {
        totalContractsEvaluated++;

        const outcome = evaluateContract(c, context, filter, config);
        if (outcome.rejection) {
          rejectionCounter.total++;
          if (rejections.length < config.maxRejectionsReturned) rejections.push(outcome.rejection);
        } else if (outcome.item) {
          passedContracts.push(outcome.item);
        }
      }
    }
  }

  return {
    passedContracts,
    rejections,
    rejectionCount: rejectionCounter.total,
    totalContractsEvaluated,
  };
}

/**
 * Issue #3186 - the aggregation tail of evaluateChains, split out so
 * the options pipeline's screen stage wraps the same function: filter
 * summary, sort, limit, quote quality, status. evaluateChains is the
 * composition of evaluateContracts + this function.
 */
export function aggregateScreenResult(
  evaluated: EvaluatedContracts,
  chains: Array<{ symbol: string; chain: ETradeOptionChain }>,
  filter: OptionScreenerFilter = {},
  totalUnderlyingsScanned = new Set(chains.map((chain) => chain.symbol)).size,
  diagnostics: { fetchErrors?: OptionScreenFetchError[]; warnings?: string[] } = {},
  config: EtapiScreenerConfig = getScreenerConfig(),
): OptionScreenResult {
  const symbols = Array.from(new Set(chains.map((c) => c.symbol)));
  const summaryParts: string[] = [];

  if (symbols.length <= 5) {
    summaryParts.push(`Symbols: [${symbols.join(", ")}]`);
  } else {
    summaryParts.push(`${symbols.length} Symbols`);
  }

  if (filter.maxUnderlyings !== undefined) summaryParts.push(`Max underlyings: ${filter.maxUnderlyings}`);
  if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) summaryParts.push(`Sector: ${filter.sector}`);
  if (filter.contractType && filter.contractType !== "BOTH") summaryParts.push(`Type: ${filter.contractType}`);
  if (filter.minDelta !== undefined) summaryParts.push(`Delta >= ${filter.minDelta}`);
  if (filter.maxDelta !== undefined) summaryParts.push(`Delta <= ${filter.maxDelta}`);
  if (filter.minGamma !== undefined) summaryParts.push(`Gamma >= ${filter.minGamma}`);
  if (filter.maxGamma !== undefined) summaryParts.push(`Gamma <= ${filter.maxGamma}`);
  if (filter.minTheta !== undefined) summaryParts.push(`Theta >= ${filter.minTheta}`);
  if (filter.maxTheta !== undefined) summaryParts.push(`Theta <= ${filter.maxTheta}`);
  if (filter.minVega !== undefined) summaryParts.push(`Vega >= ${filter.minVega}`);
  if (filter.maxVega !== undefined) summaryParts.push(`Vega <= ${filter.maxVega}`);
  if (filter.minRho !== undefined) summaryParts.push(`Rho >= ${filter.minRho}`);
  if (filter.maxRho !== undefined) summaryParts.push(`Rho <= ${filter.maxRho}`);
  if (filter.minImpliedVolatility !== undefined) summaryParts.push(`IV >= ${(filter.minImpliedVolatility * 100).toFixed(0)}%`);
  if (filter.maxImpliedVolatility !== undefined) summaryParts.push(`IV <= ${(filter.maxImpliedVolatility * 100).toFixed(0)}%`);
  if (filter.minVolume !== undefined) summaryParts.push(`Min Vol >= ${filter.minVolume}`);
  if (filter.minOpenInterest !== undefined) summaryParts.push(`Min OI >= ${filter.minOpenInterest}`);
  if (filter.maxSpreadPct !== undefined) summaryParts.push(`Max spread <= ${filter.maxSpreadPct}%`);
  if (filter.maxQuoteAgeSeconds !== undefined) summaryParts.push(`Quote age <= ${filter.maxQuoteAgeSeconds}s`);
  if (filter.minPrice !== undefined) summaryParts.push(`Premium >= $${filter.minPrice}`);
  if (filter.maxPrice !== undefined) summaryParts.push(`Premium <= $${filter.maxPrice}`);
  if (filter.minDte !== undefined || filter.maxDte !== undefined) {
    summaryParts.push(`DTE: ${filter.minDte ?? 0}d - ${filter.maxDte ?? 365}d`);
  }
  if (filter.moneyness && filter.moneyness !== "ALL") summaryParts.push(`Moneyness: ${filter.moneyness}`);
  if (filter.sortBy && filter.sortBy !== "volume") summaryParts.push(`Sort: ${filter.sortBy}`);

  const { passedContracts, rejections, rejectionCount, totalContractsEvaluated } = evaluated;
  sortScreenedContracts(passedContracts, filter.sortBy);

  const totalMatches = passedContracts.length;
  const effectiveLimit = filter.limit && filter.limit > 0 ? filter.limit : config.maxReturnedContracts;
  const finalContracts = passedContracts.slice(0, effectiveLimit);
  const warnings = [...(diagnostics.warnings ?? [])];
  if (totalMatches > finalContracts.length) {
    warnings.push(`Returned ${finalContracts.length} of ${totalMatches} matching contracts (limit ${effectiveLimit}).`);
  }

  const staleReturned = finalContracts.filter((contract) => contract.quoteFreshness === "STALE");
  const unknownFreshness = finalContracts.filter((contract) => contract.quoteFreshness === "UNKNOWN");
  const staleQuoteAges = staleReturned
    .map((contract) => contract.quoteAgeSeconds)
    .filter((age): age is number => age !== undefined && Number.isFinite(age));
  const fetchErrors = diagnostics.fetchErrors ?? [];

  return {
    totalUnderlyingsScanned,
    totalContractsEvaluated,
    matchedCount: finalContracts.length,
    totalMatches,
    rejectionCount,
    filterApplied: { ...filter },
    filterSummary: summaryParts.join(", ") || "Live E*TRADE option chains",
    contracts: finalContracts,
    scannedAt: new Date().toISOString(),
    quoteQuality: {
      maxAgeSeconds: filter.maxQuoteAgeSeconds,
      referenceAgeSeconds: filter.maxQuoteAgeSeconds ?? config.defaultQuoteAgeSeconds,
      staleContractsReturned: staleReturned.length,
      unknownFreshnessContracts: unknownFreshness.length,
      ...(staleQuoteAges.length > 0 ? { freshestStaleQuoteAgeSeconds: Math.min(...staleQuoteAges) } : {}),
    },
    status: finalContracts.length > 0 ? "matches_found" : "no_matches",
    rejections: rejections.slice(0, config.maxRejectionsReturned),
    ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export class DynamicOptionsScreener {
  private source?: OptionChainSource;
  public config: EtapiScreenerConfig;
  /** Issue #1378: threaded universe seam (route-bound by the caller); absent → resolveUnderlyings throws. */
  private universeDeps?: NasdaqUniverseDeps;
  private static testChainsFixture: Record<string, ETradeOptionChain> = {};
  private static testListingsFixture: NasdaqStockListing[] | null = null;

  constructor(
    source?: OptionChainSource,
    config?: Partial<EtapiScreenerConfig>,
    universeDeps?: NasdaqUniverseDeps
  ) {
    this.source = source;
    const base = getScreenerConfig((source as any)?.env, (source as any)?.overrideEnv);
    this.config = config ? { ...base, ...config } : base;
    this.universeDeps = universeDeps;
  }

  /**
   * Test fixture injector — allows deterministic testing of options chain filtering
   */
  static setTestChainsFixture(fixture: Record<string, ETradeOptionChain>): void {
    DynamicOptionsScreener.testChainsFixture = fixture;
  }

  static clearTestChainsFixture(): void {
    DynamicOptionsScreener.testChainsFixture = {};
  }

  static setTestListingsFixture(fixture: NasdaqStockListing[] | null): void {
    DynamicOptionsScreener.testListingsFixture = fixture;
  }

  /** Issue #1378: the threaded universe seam, or a named throw when neither fixture nor seam exists. */
  private async fetchUniverseListings(): Promise<NasdaqStockListing[]> {
    if (this.universeDeps) return this.universeDeps.fetchListings();
    throw new Error(
      "options discovery requires universeDeps — no dep-less listings fetch exists (#1378)"
    );
  }

  /**
   * Resolve explicit underlyings or discover from all current U.S. exchange listings.
   * Discovery is deterministic (alphabetically sorted) and always capped at
   * `maxUnderlyings`, which sanitizeOptionScreenerFilter clamps to MAX_SCAN_SYMBOLS.
   */
  async resolveUnderlyings(filter: OptionScreenerFilter): Promise<string[]> {
    if (filter.underlyingSymbols && filter.underlyingSymbols.length > 0) {
      return Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    }

    // Issue #1378: discovery routes through the threaded universe
    // seam — never a direct listings-module call. Neither fixture
    // nor seam is an honest throw naming the seam, not a fetch.
    const listings =
      DynamicOptionsScreener.testListingsFixture ?? (await this.fetchUniverseListings());
    const discovered = Array.from(new Set(listings.map((listing) => listing.symbol.toUpperCase()))).sort();
    const cap = filter.maxUnderlyings && filter.maxUnderlyings > 0 ? filter.maxUnderlyings : this.config.maxScanSymbols;
    return discovered.slice(0, cap);
  }

  /**
   * Fetches every expiration of a symbol inside the effective DTE window.
   *
   * Returns per-symbol diagnostics alongside the chains so callers can distinguish a
   * legitimate empty slice (expirations exist, none in the window) from upstream
   * failures (auth/network/rate-limit/empty payload). Identical expirations are
   * deduped and at most maxExpirationsPerSymbol requests are issued, pooled at
   * expiryFetchConcurrency.
   */
  private async fetchChainsForSymbol(
    symbol: string,
    filter: OptionScreenerFilter,
    budget: SubrequestBudget
  ): Promise<{ chains: ETradeOptionChain[]; fetchErrors: OptionScreenFetchError[]; expirationsTruncated: number; deferred: boolean }> {
    const fixture = DynamicOptionsScreener.testChainsFixture[symbol];
    if (fixture) return { chains: [fixture], fetchErrors: [], expirationsTruncated: 0, deferred: false };
    if (!this.source) {
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: "No option chain source configured for live chain fetch." }],
        expirationsTruncated: 0,
        deferred: false,
      };
    }
    const client = this.source;

    // Issue #1204: budget gate. A symbol that cannot afford even its
    // expire-dates fetch is deferred — no fetch is issued for it, and
    // the deferral is reported under its own name, never as an
    // upstream failure. The client charges at the fetch boundary before
    // awaiting the network, so the symbol/expiry pools cannot overspend.
    if (budget.used >= budget.limit) {
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }],
        expirationsTruncated: 0,
        deferred: true,
      };
    }
    let expirations: Array<{ year: number; month: number; day: number }> = [];
    let expirationError: string | null = null;
    try {
      if (client.supportsOptionRequestBudget) {
        expirations = await client.getOptionExpireDates(symbol, undefined, budget);
      } else if (budget.tryConsume()) {
        // Compatibility for injected providers without a wire-level limiter.
        expirations = await client.getOptionExpireDates(symbol);
      }
    } catch (err) {
      expirationError = err instanceof Error ? err.message : "Expiration date fetch failed.";
    }
    if (budget.exhausted) {
      return { chains: [], fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }], expirationsTruncated: 0, deferred: true };
    }

    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const seenExpirations = new Set<string>();
    const eligibleExpirations = expirations
      .filter((expiry) => {
        const key = `${expiry.year}-${expiry.month}-${expiry.day}`;
        if (seenExpirations.has(key)) return false;
        seenExpirations.add(key);
        const expirationUtc = Date.UTC(expiry.year, expiry.month - 1, expiry.day);
        const dte = Math.ceil((expirationUtc - todayUtc) / (24 * 60 * 60 * 1000));
        return (filter.minDte === undefined || dte >= filter.minDte) &&
          (filter.maxDte === undefined || dte <= filter.maxDte);
      })
      .sort((a, b) => Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day));

    if (eligibleExpirations.length === 0) {
      // Expirations exist but none fall inside the requested window: a legitimate empty slice.
      if (expirations.length > 0) return { chains: [], fetchErrors: [], expirationsTruncated: 0, deferred: false };
      // Expiration feed unavailable: fall back to a single unscoped chain request.
      // Issue #1204: the fallback fetch is budgeted like every other fetch.
      if (budget.used >= budget.limit) {
        return {
          chains: [],
          fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }],
          expirationsTruncated: 0,
          deferred: true,
        };
      }
      const chain = await (client.supportsOptionRequestBudget
        ? client.getOptionChains({ symbol }, budget)
        : budget.tryConsume()
          ? client.getOptionChains({ symbol })
          : Promise.resolve(null)).catch(() => null);
      if (budget.exhausted) {
        return { chains: [], fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }], expirationsTruncated: 0, deferred: true };
      }
      if (chain) return { chains: [chain], fetchErrors: [], expirationsTruncated: 0, deferred: false };
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: expirationError || client.lastError || "Option chain fetch returned no data." }],
        expirationsTruncated: 0,
        deferred: false,
      };
    }

    const selectedExpirations = filter.expirationDteBands?.length
      ? filter.expirationDteBands.flatMap((band) => eligibleExpirations
        .filter((expiry) => {
          const dte = Math.ceil((Date.UTC(expiry.year, expiry.month - 1, expiry.day) - todayUtc) / (24 * 60 * 60 * 1000));
          return dte >= band.minDte && dte <= band.maxDte;
        })
        .slice(0, band.maxExpirations ?? 4))
      : eligibleExpirations;
    const uniqueSelected = Array.from(new Map(selectedExpirations.map((expiry) => [
      `${expiry.year}-${expiry.month}-${expiry.day}`, expiry,
    ])).values()).sort((a, b) => Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day));
    const requested = uniqueSelected.slice(0, this.config.maxExpirationsPerSymbol);
    const expirationsTruncated = uniqueSelected.length - requested.length;
    // Use the remaining budget to cap the planned batch. The client
    // enforces the hard limit at each actual fetch attempt, including a
    // fallback; pooled symbols cannot overspend even if an attempt uses
    // more than one request.
    const affordable = Math.max(0, Math.min(requested.length, budget.limit - budget.used));
    const toFetch = requested.slice(0, affordable);
    const deferredExpirations = requested.length - toFetch.length;
    if (toFetch.length === 0) {
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }],
        expirationsTruncated,
        deferred: true,
      };
    }
    const chains = await mapLimit(toFetch, this.config.expiryFetchConcurrency, (expiry) => {
      const params = {
        symbol,
        expiryYear: expiry.year,
        expiryMonth: expiry.month,
        expiryDay: expiry.day,
        includeWeekly: true,
      };
      const request = client.supportsOptionRequestBudget
        ? client.getOptionChains(params, budget)
        : budget.tryConsume()
          ? client.getOptionChains(params)
          : Promise.resolve(null);
      return request.catch(() => null);
    });
    const fetched = chains.filter((chain): chain is ETradeOptionChain => Boolean(chain));
    if (budget.exhausted && fetched.length === 0) {
      return { chains: [], fetchErrors: [{ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON }], expirationsTruncated, deferred: true };
    }
    if (fetched.length === 0) {
      return {
        chains: [],
        fetchErrors: [{
          symbol,
          reason: client.lastError || expirationError || `All ${toFetch.length} expiration fetches returned no data.`,
        }],
        expirationsTruncated,
        deferred: deferredExpirations > 0,
      };
    }
    const fetchErrors: OptionScreenFetchError[] = [];
    if (fetched.length < toFetch.length) {
      fetchErrors.push({
        symbol,
        reason: `${toFetch.length - fetched.length} of ${toFetch.length} expiration fetches returned no data.`,
      });
    }
    if (deferredExpirations > 0) {
      fetchErrors.push({
        symbol,
        reason: `${deferredExpirations} of ${requested.length} expiration fetches deferred (subrequest budget exhausted).`,
      });
    }
    if (budget.exhausted && deferredExpirations === 0 && fetched.length < toFetch.length) {
      fetchErrors.push({ symbol, reason: SUBREQUEST_BUDGET_DEFERRED_REASON });
    }
    return {
      chains: fetched,
      fetchErrors,
      expirationsTruncated,
      deferred: deferredExpirations > 0 || budget.exhausted,
    };
  }

  fetchChainForSymbolSync(symbol: string): ETradeOptionChain | null {
    const cleanSym = symbol.toUpperCase().trim();
    if (DynamicOptionsScreener.testChainsFixture[cleanSym]) {
      return DynamicOptionsScreener.testChainsFixture[cleanSym];
    }
    return null;
  }

  /**
   * Synchronous options screening for explicit symbols with injected test fixtures only.
   * Applies the same sanitization and validation as `screenOptions`.
   */
  screenOptionsSync(rawFilter: OptionScreenerFilter = {}): OptionScreenResult {
    const { filter, warnings } = sanitizeOptionScreenerFilter(rawFilter, this.config);
    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols.",
      };
    }
    const symbols = filter.underlyingSymbols || [];
    if (symbols.length === 0) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "Synchronous screening requires explicit underlying symbols.",
      };
    }
    const chains = symbols.flatMap((sym) => {
      const chain = this.fetchChainForSymbolSync(sym);
      return chain ? [{ symbol: sym, chain }] : [];
    });
    const fetchErrors: OptionScreenFetchError[] = symbols
      .filter((sym) => !DynamicOptionsScreener.testChainsFixture[sym])
      .map((symbol) => ({ symbol, reason: "No injected chain fixture for symbol." }));
    const result = this.evaluateChains(chains, filter, symbols.length, { fetchErrors, warnings });
    if (fetchErrors.length > 0 && chains.length === 0) result.status = "error";
    return result;
  }

  /**
   * Evaluates options filters across one or more underlyings (async with live upstream fetch).
   *
   * The filter is sanitized first (invalid inputs dropped, bounds clamped, defaults applied),
   * symbols are fetched through a bounded concurrency pool, and upstream failures are reported
   * via `fetchErrors` with `status: "error"` when nothing could be fetched.
   */
  /**
   * Issue #3186 - the fetch half of screenOptions, split out so the
   * options pipeline's chainFetch stage wraps the same function.
   * Sanitizes, validates, resolves underlyings, fetches chains per
   * symbol (with the #915 retry pass and the #1204 deferral
   * accounting), and flattens + reports diagnostics. Validation
   * failures throw OptionsValidationError (never an error result -
   * the caller decides the result shape).
   */
  async fetchChains(
    rawFilter: OptionScreenerFilter = {},
    budget: SubrequestBudget = createSubrequestBudget(this.config.subrequestBudget)
  ): Promise<{
    filter: OptionScreenerFilter;
    warnings: string[];
    symbols: string[];
    chains: Array<{ symbol: string; chain: ETradeOptionChain }>;
    fetchErrors: OptionScreenFetchError[];
    expirationsTruncated: number;
    deferredSymbols: string[];
  }> {
    const { filter, warnings } = sanitizeOptionScreenerFilter(rawFilter, this.config);

    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) {
      throw new OptionsValidationError(
        "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols.",
        filter,
        warnings,
      );
    }
    if ((!filter.underlyingSymbols || filter.underlyingSymbols.length === 0) && filter.maxUnderlyings === undefined) {
      throw new OptionsValidationError(
        "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains.",
        filter,
        warnings,
      );
    }

    const symbols = await this.resolveUnderlyings(filter);
    const outcomes = await mapLimit(symbols, this.config.symbolFetchConcurrency, (symbol) =>
      this.fetchChainsForSymbol(symbol, filter, budget),
    );
    // Issue #915: one sequential retry pass for symbols that failed
    // outright (fetch error, zero chains), mirroring the #727 quote
    // recovery. The pooled first pass makes a transient upstream failure
    // (throttle, blip) final for that symbol — and at 100 symbols the
    // scheduled coverage gate turns any single failure into a failed
    // run. Sequential, spaced retries back the upstream off; with one
    // symbol in flight, the shared client's lastError also attributes
    // the surviving reason to the right symbol. Symbols holding a
    // legitimate empty slice (no error) or partial chains are not
    // retried; without a client the error is deterministic, so the pass
    // is skipped entirely.
    if (this.source) {
      let retried = 0;
      for (let i = 0; i < symbols.length; i++) {
        const outcome = outcomes[i];
        if (outcome.chains.length > 0 || outcome.fetchErrors.length === 0) continue;
        // Issue #1204: a deferred symbol was never fetched — retrying
        // it inside the same invocation cannot succeed (the budget is
        // the binding constraint, not a transient failure) and the
        // retry would spend against the same exhausted ledger.
        if (outcome.deferred) continue;
        if (retried > 0) await new Promise((r) => setTimeout(r, 500));
        retried++;
        outcomes[i] = await this.fetchChainsForSymbol(symbols[i], filter, budget);
      }
    }
    const chains = outcomes.flatMap((outcome, index) =>
      outcome.chains.map((chain) => ({ symbol: symbols[index], chain })),
    );
    const fetchErrors = outcomes.flatMap((outcome) => outcome.fetchErrors);
    const expirationsTruncated = outcomes.reduce((total, outcome) => total + outcome.expirationsTruncated, 0);
    // Issue #1204: deferral disclosure — a budget-bounded scan is a
    // partial scan, and the result must say so wherever it travels.
    const deferredSymbols = symbols.filter((_, i) => outcomes[i].deferred);
    if (deferredSymbols.length > 0) {
      const named = deferredSymbols.slice(0, 10).join(", ");
      warnings.push(
        `${deferredSymbols.length} underlying(s) deferred (subrequest budget ${budget.limit} exhausted after ${budget.used} fetches): ${named}` +
        `${deferredSymbols.length > 10 ? ", …" : ""}. Narrow the universe or DTE window, or raise screener.subrequestBudget.`
      );
    }
    if (expirationsTruncated > 0) {
      warnings.push(
        `Fetch window capped at ${this.config.maxExpirationsPerSymbol} expirations per symbol; ${expirationsTruncated} later expiration(s) were skipped. Tighten the DTE window to include them.`,
      );
    }

    return { filter, warnings, symbols, chains, fetchErrors, expirationsTruncated, deferredSymbols };
  }

  async screenOptions(
    rawFilter: OptionScreenerFilter = {},
    budget: SubrequestBudget = createSubrequestBudget(this.config.subrequestBudget)
  ): Promise<OptionScreenResult> {
    let fetched: Awaited<ReturnType<DynamicOptionsScreener["fetchChains"]>>;
    try {
      fetched = await this.fetchChains(rawFilter, budget);
    } catch (err) {
      if (err instanceof OptionsValidationError) {
        return {
          ...this.evaluateChains([], err.filter, 0, { warnings: err.warnings }),
          status: "error",
          validationError: err.message,
        };
      }
      throw err;
    }

    const result = this.evaluateChains(fetched.chains, fetched.filter, fetched.symbols.length, { fetchErrors: fetched.fetchErrors, warnings: fetched.warnings });
    if (fetched.fetchErrors.length > 0 && fetched.chains.length === 0) {
      result.status = "error";
    }
    return result;
  }

  evaluateChains(
    chains: Array<{ symbol: string; chain: ETradeOptionChain }>,
    filter: OptionScreenerFilter = {},
    totalUnderlyingsScanned = new Set(chains.map((chain) => chain.symbol)).size,
    diagnostics: { fetchErrors?: OptionScreenFetchError[]; warnings?: string[] } = {}
  ): OptionScreenResult {
    // Issue #3186: the composition of evaluateContracts (enrich) +
    // aggregateScreenResult (screen). Same signature, same results -
    // the two callers (etradeOptionsScreen.ts fallback, OptionsDataAgent
    // snapshot) and every existing test keep passing unchanged.
    return aggregateScreenResult(
      evaluateContracts(chains, filter, this.config),
      chains,
      filter,
      totalUnderlyingsScanned,
      diagnostics,
      this.config,
    );
  }
}

/** Shared per-expiration values used while screening each contract. */
interface ContractScreenContext {
  symbol: string;
  expiry: { year: number; month: number; day: number };
  expirationDate: string;
  daysToExpiration: number;
  underlyingPrice: number;
}

interface ContractOutcome {
  rejection?: OptionScreenRejection;
  item?: ScreenedOptionContractItem;
}

function contractRejection(
  code: OptionScreenRejection["code"],
  contractSymbol: string,
  underlyingSymbol: string,
  reason: string,
  extra: Partial<OptionScreenRejection> = {},
): OptionScreenRejection {
  return { code, contractSymbol, underlyingSymbol, reason, ...extra };
}

/**
 * Applies every filter to a single contract in rejection-priority order
 * (adjusted -> quote validity -> spread -> premium -> DTE -> Greeks -> IV ->
 * liquidity -> moneyness -> strike distance). Returns either the first rejection
 * or the fully enriched result item; never mutates its inputs.
 */
function evaluateContract(
  c: ETradeOptionChainContract,
  context: ContractScreenContext,
  filter: OptionScreenerFilter,
  config: EtapiScreenerConfig = getScreenerConfig(),
): ContractOutcome {
  const { symbol, expiry, expirationDate, daysToExpiration, underlyingPrice } = context;
  const contractSym = c.osiKey
    || buildOsiSymbol(c.optionRootSymbol || c.symbol || symbol, expiry, c.optionType, c.strikePrice);
  const delta = c.delta !== undefined ? Math.abs(c.delta) : undefined;
  const gamma = c.gamma;
  const theta = c.theta;
  const vega = c.vega;
  const rho = c.rho;
  const iv = c.impliedVolatility;
  const vol = c.volume;
  const oi = c.openInterest;
  const strike = c.strikePrice;

  if (c.adjustedFlag) {
    return { rejection: contractRejection("ADJUSTED_CONTRACT", contractSym, symbol, "Adjusted/non-standard contract is excluded") };
  }

  // Quote age; negative ages (future timestamps / clock skew) are treated as unknown.
  const quoteTimestampMs = c.timeStamp
    ? c.timeStamp < 1_000_000_000_000 ? c.timeStamp * 1000 : c.timeStamp
    : undefined;
  const quoteAgeSeconds = quoteTimestampMs === undefined
    ? undefined
    : (Date.now() - quoteTimestampMs) / 1000;
  const freshnessReference = filter.maxQuoteAgeSeconds ?? DEFAULT_QUOTE_AGE_SECONDS;
  const quoteFreshness = quoteAgeSeconds === undefined || quoteAgeSeconds < 0
    ? "UNKNOWN" as const
    : quoteAgeSeconds > freshnessReference ? "STALE" as const : "FRESH" as const;

  if (c.bid <= 0 || c.ask <= 0 || c.ask < c.bid) {
    return { rejection: contractRejection("INVALID_QUOTE", contractSym, symbol, `Invalid bid/ask quote (bid ${c.bid}, ask ${c.ask})`) };
  }
  const midpoint = (c.bid + c.ask) / 2;
  const spreadPct = ((c.ask - c.bid) / midpoint) * 100;
  if (filter.maxSpreadPct !== undefined && spreadPct > filter.maxSpreadPct) {
    return { rejection: contractRejection("SPREAD_TOO_WIDE", contractSym, symbol, `Spread (${spreadPct.toFixed(2)}%) exceeds maximum ${filter.maxSpreadPct}%`, { spreadPct }) };
  }

  // Premium bounds, evaluated on the bid/ask midpoint.
  if (filter.minPrice !== undefined && midpoint < filter.minPrice) {
    return { rejection: contractRejection("PREMIUM_OUT_OF_RANGE", contractSym, symbol, `Premium ($${midpoint.toFixed(2)}) below minimum $${filter.minPrice}`, { spreadPct }) };
  }
  if (filter.maxPrice !== undefined && midpoint > filter.maxPrice) {
    return { rejection: contractRejection("PREMIUM_OUT_OF_RANGE", contractSym, symbol, `Premium ($${midpoint.toFixed(2)}) exceeds maximum $${filter.maxPrice}`, { spreadPct }) };
  }

  if (filter.minDte !== undefined && daysToExpiration < filter.minDte) {
    return { rejection: contractRejection("DTE_OUT_OF_RANGE", contractSym, symbol, `DTE (${daysToExpiration}d) below minimum ${filter.minDte}d`, { daysToExpiration }) };
  }
  if (filter.maxDte !== undefined && daysToExpiration > filter.maxDte) {
    return { rejection: contractRejection("DTE_OUT_OF_RANGE", contractSym, symbol, `DTE (${daysToExpiration}d) exceeds maximum ${filter.maxDte}d`, { daysToExpiration }) };
  }

  // Delta filters compare the ABSOLUTE delta; rejections report the absolute value
  // while returned contracts keep their signed delta (see OptionScreenerFilter docs).
  if (filter.minDelta !== undefined && (delta === undefined || delta < filter.minDelta)) {
    return { rejection: contractRejection("DELTA_OUT_OF_RANGE", contractSym, symbol, `Delta (${delta?.toFixed(2) ?? "N/A"}) below minimum ${filter.minDelta}`, { delta }) };
  }
  if (filter.maxDelta !== undefined && (delta === undefined || delta > filter.maxDelta)) {
    return { rejection: contractRejection("DELTA_OUT_OF_RANGE", contractSym, symbol, `Delta (${delta?.toFixed(2) ?? "N/A"}) exceeds maximum ${filter.maxDelta}`, { delta }) };
  }

  if (filter.minGamma !== undefined && (gamma === undefined || gamma < filter.minGamma)) {
    return { rejection: contractRejection("GAMMA_OUT_OF_RANGE", contractSym, symbol, `Gamma (${gamma?.toFixed(4) ?? "N/A"}) below minimum ${filter.minGamma}`, { gamma }) };
  }
  if (filter.maxGamma !== undefined && (gamma === undefined || gamma > filter.maxGamma)) {
    return { rejection: contractRejection("GAMMA_OUT_OF_RANGE", contractSym, symbol, `Gamma (${gamma?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxGamma}`, { gamma }) };
  }
  if (filter.minTheta !== undefined && (theta === undefined || theta < filter.minTheta)) {
    return { rejection: contractRejection("THETA_OUT_OF_RANGE", contractSym, symbol, `Theta (${theta?.toFixed(4) ?? "N/A"}) below minimum ${filter.minTheta}`, { theta }) };
  }
  if (filter.maxTheta !== undefined && (theta === undefined || theta > filter.maxTheta)) {
    return { rejection: contractRejection("THETA_OUT_OF_RANGE", contractSym, symbol, `Theta (${theta?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxTheta}`, { theta }) };
  }

  if (filter.minVega !== undefined && (vega === undefined || vega < filter.minVega)) {
    return { rejection: contractRejection("VEGA_OUT_OF_RANGE", contractSym, symbol, `Vega (${vega?.toFixed(4) ?? "N/A"}) below minimum ${filter.minVega.toFixed(4)}`, { vega }) };
  }
  if (filter.maxVega !== undefined && (vega === undefined || vega > filter.maxVega)) {
    return { rejection: contractRejection("VEGA_OUT_OF_RANGE", contractSym, symbol, `Vega (${vega?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxVega.toFixed(4)}`, { vega }) };
  }
  if (filter.minRho !== undefined && (rho === undefined || rho < filter.minRho)) {
    return { rejection: contractRejection("RHO_OUT_OF_RANGE", contractSym, symbol, `Rho (${rho?.toFixed(4) ?? "N/A"}) below minimum ${filter.minRho.toFixed(4)}`, { rho }) };
  }
  if (filter.maxRho !== undefined && (rho === undefined || rho > filter.maxRho)) {
    return { rejection: contractRejection("RHO_OUT_OF_RANGE", contractSym, symbol, `Rho (${rho?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxRho.toFixed(4)}`, { rho }) };
  }

  if (filter.minImpliedVolatility !== undefined && (iv === undefined || iv < filter.minImpliedVolatility)) {
    return { rejection: contractRejection("IV_OUT_OF_RANGE", contractSym, symbol, `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) below minimum ${(filter.minImpliedVolatility * 100).toFixed(1)}%`, { iv }) };
  }
  if (filter.maxImpliedVolatility !== undefined && (iv === undefined || iv > filter.maxImpliedVolatility)) {
    return { rejection: contractRejection("IV_OUT_OF_RANGE", contractSym, symbol, `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) exceeds maximum ${(filter.maxImpliedVolatility * 100).toFixed(1)}%`, { iv }) };
  }

  if (filter.minVolume !== undefined && (vol === undefined || vol < filter.minVolume)) {
    return { rejection: contractRejection("VOLUME_TOO_LOW", contractSym, symbol, `Volume (${vol?.toLocaleString() ?? "N/A"}) below minimum ${filter.minVolume.toLocaleString()}`, { volume: vol }) };
  }
  if (filter.minOpenInterest !== undefined && (oi === undefined || oi < filter.minOpenInterest)) {
    return { rejection: contractRejection("OPEN_INTEREST_TOO_LOW", contractSym, symbol, `Open Interest (${oi?.toLocaleString() ?? "N/A"}) below minimum ${filter.minOpenInterest.toLocaleString()}`) };
  }

  // Moneyness with configurable ATM band around the underlying price.
  const strikeDistPct = Number((Math.abs(strike - underlyingPrice) / underlyingPrice * 100).toFixed(2));
  const atmBand = config.atmBandPct;
  let moneyness: "ITM" | "OTM" | "ATM" = "ATM";
  if (c.optionType === "CALL") {
    if (strike < underlyingPrice * (1 - atmBand)) moneyness = "ITM";
    else if (strike > underlyingPrice * (1 + atmBand)) moneyness = "OTM";
  } else {
    if (strike > underlyingPrice * (1 + atmBand)) moneyness = "ITM";
    else if (strike < underlyingPrice * (1 - atmBand)) moneyness = "OTM";
  }
  if (filter.moneyness && filter.moneyness !== "ALL" && moneyness !== filter.moneyness) {
    return { rejection: contractRejection("MONEYNESS_MISMATCH", contractSym, symbol, `Moneyness (${moneyness}) does not match filter (${filter.moneyness})`, { strikePrice: strike }) };
  }

  if (filter.maxStrikeDistancePct !== undefined && strikeDistPct > filter.maxStrikeDistancePct) {
    return { rejection: contractRejection("STRIKE_DISTANCE_TOO_WIDE", contractSym, symbol, `Strike distance (${strikeDistPct}%) exceeds maximum ${filter.maxStrikeDistancePct}%`, { strikePrice: strike }) };
  }

  // Passed all checks: compute signals and enrich the result item.
  const volOiRatio = oi && oi > 0 && vol !== undefined ? Number((vol / oi).toFixed(2)) : undefined;
  const item: ScreenedOptionContractItem = {
    ...c,
    osiKey: contractSym,
    underlyingSymbol: symbol,
    underlyingPrice,
    daysToExpiration,
    expirationDate,
    moneyness,
    strikeDistancePct: strikeDistPct,
    spreadPct,
    quoteAgeSeconds,
    quoteFreshness,
    ...(quoteTimestampMs !== undefined && quoteAgeSeconds !== undefined && quoteAgeSeconds >= 0
      ? { quoteTimestamp: new Date(quoteTimestampMs).toISOString() }
      : {}),
    volumeOiRatio: volOiRatio,
    technicalSignal: computeTechnicalSignal(volOiRatio, delta, iv, config),
    highlightReason: `${symbol} $${strike} ${c.optionType} | ${daysToExpiration}d DTE | IV: ${iv === undefined ? "N/A" : `${(iv * 100).toFixed(0)}%`}`,
  };
  return { item };
}

/** Direction-agnostic technical signal derived from liquidity and volatility heuristics. */
function computeTechnicalSignal(
  volOiRatio: number | undefined,
  absDelta: number | undefined,
  iv: number | undefined,
  config: EtapiScreenerConfig = getScreenerConfig()
): string {
  if (volOiRatio !== undefined && volOiRatio >= config.unusualVolumeOiRatio) {
    return `Unusual Volume Spike (Vol/OI: ${volOiRatio}x)`;
  }
  if (absDelta !== undefined && absDelta >= config.highDeltaThreshold) {
    return `High Delta Momentum (|delta| >= ${config.highDeltaThreshold})`;
  }
  if (iv !== undefined && iv >= config.highIvThreshold) return "High Implied Volatility Expansion";
  if (iv !== undefined && iv <= config.lowIvThreshold) return "Low IV Value Opportunity";
  return "Liquid Standard Option";
}

const SCREENED_CONTRACT_COMPARATORS: Record<OptionScreenSortKey, (a: ScreenedOptionContractItem, b: ScreenedOptionContractItem) => number> = {
  volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
  spreadPct: (a, b) => a.spreadPct - b.spreadPct,
  iv: (a, b) => (b.impliedVolatility ?? -1) - (a.impliedVolatility ?? -1),
  volumeOiRatio: (a, b) => (b.volumeOiRatio ?? -1) - (a.volumeOiRatio ?? -1),
  dte: (a, b) => a.daysToExpiration - b.daysToExpiration,
  strikeDistance: (a, b) => a.strikeDistancePct - b.strikeDistancePct,
};

/** In-place sort honoring `sortBy` with deterministic tie-breakers (symbol, then strike). */
function sortScreenedContracts(contracts: ScreenedOptionContractItem[], sortBy: OptionScreenSortKey = "volume"): void {
  const compare = SCREENED_CONTRACT_COMPARATORS[sortBy] ?? SCREENED_CONTRACT_COMPARATORS.volume;
  contracts.sort((a, b) => compare(a, b) || a.underlyingSymbol.localeCompare(b.underlyingSymbol) || a.strikePrice - b.strikePrice);
}
