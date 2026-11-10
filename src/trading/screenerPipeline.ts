/**
 * Shared screener pipeline (issue #259).
 *
 * The shared pipeline helper library used by ScreenerAgent: universe
 * acquisition, screening and result shaping live here, exactly once,
 * and both the manual and scheduled stock-screen paths run through
 * ScreenerAgent into it. It is NOT itself an entry point — the entry
 * points are the REST routes (POST /api/etrade/screen,
 * POST /api/market-data/screen), the NLQ port, and the autonomousMarketScreen
 * schedule callback, and since issue #959 every one of them validates
 * its criteria through the single shared schema module,
 * src/trading/screeningSchemas.ts, before anything reaches this
 * pipeline. (The original #259 header claimed this module was the one
 * entry point through which every stock screen flows; that was never
 * true of the routes, the NLQ port, or the schedules, and the claim
 * is corrected here under #959.)
 *
 * Capability union (all preserved, none lost):
 * - Manual: full listings universe (6,629), user filters (search/limit/
 *   exchange/price-range/trend), unsupported-filter detection, discovery
 *   metadata, ledger.
 * - Scheduled: keyword-filtered symbols, E*TRADE-primary live quotes with
 *   per-symbol Nasdaq fallback + retries, standout detection, full scanned
 *   set with provenance, event publishing inputs.
 *
 * Both triggers already shared DynamicMarketScreener.evaluateUniverse
 * (via screenWithQuotes); this module unifies everything above it.
 */

import { DynamicMarketScreener, inferSectorFromCompanyName, resolveStockSector } from "./screener";
import {
  filterTechnologySymbols,
  withRetries,
} from "./liveScreener";
import { DEFAULT_PIPELINE_POLICY, type RetryPolicy } from "../services/pipelinePolicy";
import { withRetry } from "../services/resilience";
import {
  YFINANCE_MARKET_UNIVERSE,
  getCuratedStockBySymbol,
  type CuratedStockSecurity,
} from "../config/curatedStockUniverse";
import type {
  DataProvider,
  DataRunContext,
} from "./dataProviders/contract";
import {
  bootstrapDataProviders,
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  type CapabilityRouteRecord,
  type ProviderConfigRecord,
} from "./dataProviders/providerConfigStore";
import {
  transitionProvider,
  transitionProviderViaPort,
} from "./dataProviders/lifecycle";
import type { ProviderConfigStore } from "../data/providerConfigPorts";
import type { ProviderCaptureStore } from "../data/providerCapturePorts";
import type { DataProviderPorts } from "../data/buildDataProviderPorts";
import {
  createNasdaqDataProvider,
  verifyNasdaqDataProvider,
} from "./dataProviders/adapters";
import { createCaptureFetchOutcomeRecorder } from "./dataProviders/captureStore";
import {
  DataProviderNotFoundError,
  DataProviderRegistry,
} from "./dataProviders/registry";
import { computeScreeningIndicators } from "./screeningIndicators";
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";
import type { YahooTechnicals } from "./technicals";
import {
  computeFactorGrades,
  EMPTY_GRADES,
  type FactorGrades,
  type GradeableStock,
} from "./factorGrades";
import {
  type NasdaqStockListing,
} from "../services/nasdaqListings";
import type { SqlStorage } from "../orm";
import type {
  Env,
  ETradeQuote,
  MarketDataResearchQuote,
  ScreenedStockItem,
  StockScreenerFilter,
  StockScreenResult,
} from "../types";

// ---------------------------------------------------------------------------
// Serializable shapes — single source of truth for every consumer
// (panel, retained runs, events, publishers).
// ---------------------------------------------------------------------------

/** One scanned symbol, JSON-safe. Superset of what the panel needs. */
/** Screening indicators (issue #261) — E*TRADE-honest, methodology-labeled. */
export interface ScreenedIndicators {
  sentiment: string;
  directional: boolean;
  rangeZone: string;
  valueZone: string;
  screenScore: number;
  intradayPosition: number | null;
  rangePosition: number | null;
  summary: string;
}

/** Yahoo-complement technicals (issue #269) — real RSI/MACD/gaps from history. */
export interface StockTechnicals {
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  /**
   * #3931 — Wilder ATR(14) from the same daily bars (live or
   * persisted). Null when history is insufficient — the results
   * view renders "—", never a zero.
   */
  atr14: number | null;
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  historyBars: number;
  historySource: string | null;
}

export interface ScannedStock {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
  rsi14: number | null;
  source: string;
  indicators: ScreenedIndicators;
  /** SA-style factor grades (issue #266). Attached via attachFactorGrades. */
  factorGrades: FactorGrades;
  /** Yahoo technicals (issue #269). Attached via attachTechnicals. */
  technicals: StockTechnicals;
  /** Grading inputs (not displayed). */
  peRatio?: number | null;
  sector?: string;
}

/** One standout opportunity, JSON-safe. */
export interface OpportunityStock {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
  indicators: ScreenedIndicators;
  factorGrades: FactorGrades;
  technicals: StockTechnicals;
}

// ---------------------------------------------------------------------------
// Universe acquisition — the ONLY stage that varies by trigger.
// ---------------------------------------------------------------------------

export type UniverseMode = "all-listings" | "live-quotes" | "etrade-only" | "yahoo" | "alpaca";

/**
 * Issue #1007: which data provider feeds a run. A provider changes
 * data provenance only — never semantics, scoring, result shape, or
 * persistence. Recorded on ScreenerRunResult and in the canonical
 * report body so every run states which provider produced it.
 */
export type StockScreenProvider = "etrade" | "yahoo" | "alpaca";

export interface AcquireUniverseOptions {
  mode: UniverseMode;
  /** Tunables (defaults to DEFAULT_SCREENER_CONFIG). */
  config?: ScreenerConfig;
  /** all-listings: exchange scope filter ("ALL" or exchange code). */
  exchange?: string;
  /** live-quotes / etrade-only / yahoo: pre-filtered listings (default: tech-keyword filter; yahoo: the curated Yahoo universe). */
  symbols?: NasdaqStockListing[];
  /** live-quotes / etrade-only / yahoo: cap on symbols quoted (default 50). */
  maxSymbols?: number;
  /**
   * live-quotes / etrade-only: platform quote fetcher (required for
   * these modes). Bound by bindEtradeQuoteDeps (etrade-only:
   * E*TRADE or nothing) or bindLiveQuotesQuoteDeps (live-quotes:
   * E*TRADE primary + Yahoo gap-fill per element). Replaces the
   * retired broker-shaped LiveScreenerDeps seam (#1356).
   */
  quoteDeps?: QuoteScreenerDeps;
  /** yahoo: Yahoo fetcher (required for that mode) — the data-source adapter seam. */
  yahooDeps?: YahooScreenerDeps;
  /**
   * all-listings: Nasdaq universe fetcher (the platform nasdaq
   * provider, bound by bindNasdaqUniverseDeps). Issue #1378
   * removed the dep-less direct fallback: without universeDeps
   * or universeRoute, all-listings returns the error-result shape
   * naming the missing seam (decision D1), and the
   * live-quotes/etrade-only symbol legs throw when symbols are
   * absent. No dep-less production path remains.
   */
  universeDeps?: NasdaqUniverseDeps;
  /**
   * Issue #1378: the route bundle a caller threads instead of a
   * pre-bound fetcher (service paths that cannot bind a fetcher
   * without a DO context). Resolution happens INSIDE
   * acquireUniverse (decision D1) so a route-unservable universe
   * becomes the existing error-result shape naming the
   * route/provider, never a caller-propagated throw and never a
   * per-site improvisation. Built by
   * nasdaqUniverseRouteBundle; pre-bound universeDeps wins when
   * both are present.
   */
  universeRoute?: NasdaqUniverseRouteBundle;
}

export interface AcquiredUniverse {
  quotes: ETradeQuote[];
  /** Issue #1007: the provider that produced these quotes. */
  provider?: StockScreenProvider;
  discovery: {
    mode: "all_us_listings" | "live_quotes";
    candidateCount: number;
    listingCount: number;
    sourceCounts?: Record<string, number>;
    message: string;
    isCuratedUniverse?: boolean;
    error?: string;
  };
  /**
   * Issue #462: set when E*TRADE quoted only part of the requested universe.
   * The pipeline returns the successful quotes and the screen runs on them;
   * the result is published as a *qualified partial* report (never as a
   * complete screen, and never as a failure). No fallback data is substituted.
   */
  partial?: PartialQuoteQualification;
  /** Set when acquisition failed under a test fixture (screenLive parity). */
  error?: string;
}

/**
 * Issue #462: qualification metadata for a screen run on an incomplete
 * quote set. Carried on AcquiredUniverse -> ScreenerRunResult ->
 * ScreenerCompletedEvent -> PDF/publishers so every delivery shows the
 * qualification prominently.
 */
export interface PartialQuoteQualification {
  /** Symbols successfully quoted (the subset the screen ran on). */
  quotedCount: number;
  /** Symbols requested from the universe (the full target). */
  requestedCount: number;
  /** Symbols that failed to quote (no fallback substituted). */
  failedSymbols: string[];
  /** Categorized failure counts (e.g. { other: 53 }). */
  failureReasons: Record<string, number>;
  /** Up to 3 redacted failure samples for diagnostics. */
  failureSamples: string[];
}

/**
 * Issue #1770: named reason recorded for a symbol whose quote fetches
 * were never issued (or could not complete) because the run's
 * subrequest budget ran out. A deferral is not an upstream failure:
 * the symbol was not fetched, so it must never be reported as a
 * broker/quote failure — it lands in the qualified partial under
 * failureReasons["request-budget"], the same category the pipeline
 * already uses when the platform itself reports a subrequest cap.
 * Stock-side twin of the options ledger (#1204); deliberately a
 * separate definition, not an import of optionsScreener, because
 * optionsScreener imports this module's universe types — importing
 * it back would be a cycle.
 */
export const STOCK_SUBREQUEST_BUDGET_DEFERRED_REASON =
  "Subrequest budget exhausted: quote fetch deferred (Worker per-invocation subrequest limit).";

/**
 * Issue #1770: a per-run ledger bounding how many upstream quote
 * fetches stock acquisition may issue inside one Worker invocation.
 * The ledger is created once per acquireUniverse call and shared
 * across every batch and per-symbol call of that run, so the bound
 * applies to the run, not to each symbol. Callers charge it
 * synchronously before each actual upstream invocation — including
 * retries, which re-invoke the charged wrapper — so concurrent
 * calls cannot overspend. Universe-listing resolution is outside
 * this ledger (a separate single fetch per run); the ledger bounds
 * the quote fan-out, which is the unbounded part.
 */
export interface StockSubrequestBudget {
  readonly limit: number;
  used: number;
  exhausted: boolean;
  tryConsume(): boolean;
}

export function createStockSubrequestBudget(limit: number): StockSubrequestBudget {
  const budget: StockSubrequestBudget = {
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

/** Error thrown when a charged fetch finds the run budget exhausted. */
function stockBudgetError(): Error {
  return new Error(STOCK_SUBREQUEST_BUDGET_DEFERRED_REASON);
}

/**
 * Issue #1317: Yahoo acquisition, moved here from the deleted
 * src/trading/yahooDataSource.ts (the pipeline's yahoo-mode helpers
 * are pipeline logic — retry policy, curated universe, pipeline
 * quote shape — not platform adapter logic, which must not retry or
 * convert). Behaviour is byte-identical to the moved module; only
 * the data source changed: production deps are now bound over the
 * platform yahoo provider (bindYahooScreenerDeps) instead of a
 * directly-injected YahooFinanceProvider, so every Yahoo fetch in a
 * run is captured (E1) and outcome-tracked (E7) under the run id.
 *
 * Honesty rules (carried from #913/#916, previously enforced inside
 * the retired YFinanceMarketScreener):
 * - Only a genuinely live provider quote (provenance === "live",
 *   price > 0) may enter the pipeline. The provider's static/generated
 *   sync fallback is not live data and is never re-stamped as a Yahoo
 *   quote here.
 * - A failed lookup yields NO row for that symbol — never a substitute
 *   quote. If every lookup fails the caller (acquireUniverse, yahoo
 *   mode) fails the run visibly; there is no silent fallback to
 *   another provider's data.
 *
 * YFinance's indicator work survives as adapter internals: the RSI-14
 * and MACD values YahooFinanceProvider computes from daily history
 * (computeRsi14 / computeMacd in marketDataResearch.ts) ride through as DATA
 * fields on the adapted quote (rsi, macdSignal) where the pipeline can
 * consume them — the pipeline's RSI filter reads the quote's RSI, and
 * screenWithQuotes surfaces the MACD signal on the screened row.
 */

/** Provider id recorded in canonical-report provenance for Yahoo runs. */
export const YAHOO_PROVIDER_ID = "yahoo" as const;

/** Source label stamped on every adapted quote (its provenance). */
export const YAHOO_QUOTE_SOURCE = "Yahoo Finance";

/**
 * The Yahoo provider seam — mirrors QuoteScreenerDeps: an injected
 * per-symbol live-quote fetcher. Production binds the platform yahoo
 * provider (bindYahooScreenerDeps); tests bind fixtures.
 */
export interface YahooScreenerDeps {
  /** Fetch a live Yahoo quote for a symbol. Throws on failure. */
  fetchYahooQuote: (symbol: string) => Promise<MarketDataResearchQuote>;
  /** Issue #1184 (#1173 R2): batch quote fetcher (one request per
   *  symbol chunk). Optional — providers without it keep the
   *  per-symbol path for everything. */
  fetchYahooBatchQuotes?: (symbols: string[]) => Promise<MarketDataResearchQuote[]>;
  /** Issue #1181 (#1173 R1): retry policy for per-symbol fetches.
   *  Defaults to the pipeline policy's acquisition policy — the
   *  Yahoo path's first retry coverage (it previously had none). */
  retryPolicy?: RetryPolicy;
  /** Test seam: sleep implementation for the retry executor. */
  retrySleep?: (ms: number) => Promise<void>;
}

/** Bind a YahooFinanceProvider-shaped object as pipeline deps. */
export function yahooDepsFromProvider(provider: {
  getQuote: (symbol: string) => Promise<MarketDataResearchQuote>;
  getQuotes?: (symbols: string[]) => Promise<MarketDataResearchQuote[]>;
}): YahooScreenerDeps {
  return {
    fetchYahooQuote: (symbol) => provider.getQuote(symbol),
    ...(typeof provider.getQuotes === "function"
      ? { fetchYahooBatchQuotes: (symbols: string[]) => provider.getQuotes!(symbols) }
      : {}),
  };
}

/**
 * Issue #1317: bind the platform yahoo provider to the pipeline seam
 * — the E2 platform-binding pattern for Yahoo. The provider's
 * getQuote/getQuotesBatch results are MarketDataResearchQuote rows (P1 parity: the
 * envelope wraps by reference); the run context rides along so every
 * quote the run acquires is captured under the run's id. The batch
 * dep exists only when the provider offers getQuotesBatch (the market-data
 * adapter offers it only when the wrapped provider has getQuotes),
 * so providers without batch keep the per-symbol path.
 */
export function bindYahooScreenerDeps(
  provider: DataProvider,
  runContext: DataRunContext
): YahooScreenerDeps {
  return {
    fetchYahooQuote: async (symbol: string) =>
      (await provider.getQuote!(symbol, runContext)).result as MarketDataResearchQuote,
    ...(typeof provider.getQuotesBatch === "function"
      ? {
          fetchYahooBatchQuotes: async (symbols: string[]) =>
            (await provider.getQuotesBatch!(symbols, runContext)).result as MarketDataResearchQuote[],
        }
      : {}),
  };
}

/**
 * The Nasdaq universe seam — mirrors YahooScreenerDeps: an injected
 * listings fetcher. Production binds the platform nasdaq provider
 * (bindNasdaqUniverseDeps); tests bind fixtures.
 */
export interface NasdaqUniverseDeps {
  /** Fetch the full listings directory. Throws on failure. */
  fetchListings: () => Promise<NasdaqStockListing[]>;
}

/**
 * Issue #1368: bind the platform nasdaq provider to the pipeline
 * seam — the E2 platform-binding pattern for Nasdaq. The
 * provider's getScreenUniverse result is the listings array (the
 * envelope wraps by reference); the run context rides along so every
 * universe the run acquires is captured under the run's id.
 */
export function bindNasdaqUniverseDeps(
  provider: DataProvider,
  runContext: DataRunContext
): NasdaqUniverseDeps {
  return {
    fetchListings: async () =>
      (await provider.getScreenUniverse!(runContext)).result as NasdaqStockListing[],
  };
}

/**
 * Issue #1368: resolve the universe provider from the platform
 * route table — the screenUniverse route's primary assignment
 * (seeded: nasdaq, freemium, no gap-fill). The route must name
 * nasdaq as primary, nasdaq's config must be enabled (state and
 * flag), and the registry must hold a screenUniverse-capable
 * nasdaq adapter. Anything else throws — no silent substitution,
 * no fallback to another provider.
 */
export function nasdaqUniverseProviderFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): DataProvider {
  const route = routes.find((r) => r.capability === "screenUniverse");
  if (!route || route.primaryProviderId !== "nasdaq") {
    throw new Error(
      "Nasdaq-mode universe resolution failed: the screenUniverse route does not name nasdaq as primary."
    );
  }
  const config = configs.find((c) => c.id === "nasdaq");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    throw new Error(
      "Nasdaq-mode universe resolution failed: the nasdaq provider is not enabled (lifecycle state and flag)."
    );
  }
  const provider = registry.get("nasdaq");
  if (!provider || !provider.capabilities.includes("screenUniverse")) {
    throw new Error(
      "Nasdaq-mode universe resolution failed: no screenUniverse-capable nasdaq adapter is registered."
    );
  }
  return provider;
}

/**
 * Issue #1378: the route bundle a caller threads to acquireUniverse
 * instead of a pre-bound fetcher. It carries the registry (with the
 * nasdaq adapter registered), the route table snapshot, and the run
 * context — but NOT a resolved provider: resolution stays inside
 * acquireUniverse (decision D1), so route-unservable failures
 * convert to the existing error-result shape there.
 */
export interface NasdaqUniverseRouteBundle {
  registry: DataProviderRegistry;
  configs: readonly ProviderConfigRecord[];
  routes: readonly CapabilityRouteRecord[];
  runContext: DataRunContext;
}

/**
 * Issue #1378: input for nasdaqUniverseRouteBundle. The caller
 * supplies DO sql (and, where it has one, blob storage); the helper
 * performs the screener-agent #1368 sequence — bootstrap, verify →
 * enable when not already enabled, adapter construction, registry
 * registration — and returns the bundle WITHOUT resolving it.
 * With storage the adapter captures full blobs; without storage it
 * records outcomes only (the #1331 fit-runner precedent: a
 * capture_failed marker on every successful fetch would poison
 * provider health, so no capture is attempted without a blob
 * handle — see providerHealth.ts, where capture_failed counts as
 * a failure). The helper THROWS on failure (neutral); each caller
 * chooses per its established contract — service paths catch and
 * degrade to the missing-seam error result, shard/scheduled paths
 * propagate into their failure boundaries, research paths catch
 * and degrade to empty.
 */
export interface NasdaqUniverseRouteBundleInput {
  sql: SqlStorage;
  /** Blob storage when the caller has a DO storage handle; omitted → outcome-only. */
  storage?: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> };
  env: Env;
  userLogin: string;
  runId: string;
  tenantId?: string;
  /** Override fetcher (tests); omitted → the adapter's live feed fetcher. */
  fetchListings?: () => Promise<NasdaqStockListing[]>;
  /**
   * #2303 (#1976 step 1): the data-layer ports. When the caller
   * supplies them, bootstrap/transitions/route reads run on D1
   * through the config port and captures/outcomes land through
   * the capture port; otherwise the sql path above runs.
   */
  configPort?: ProviderConfigStore | null;
  capturePort?: ProviderCaptureStore | null;
}

export async function nasdaqUniverseRouteBundle(
  input: NasdaqUniverseRouteBundleInput
): Promise<NasdaqUniverseRouteBundle> {
  const { sql, storage, env, userLogin, runId } = input;
  const configPort = input.configPort ?? null;
  if (configPort) await configPort.bootstrapDataProviders();
  else bootstrapDataProviders(sql);
  const config = configPort
    ? await configPort.getProviderConfig("nasdaq")
    : getProviderConfig(sql, "nasdaq");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    const verifyDeps = {
      verifier: async () =>
        verifyNasdaqDataProvider(
          input.fetchListings ? { fetchListings: input.fetchListings } : {}
        ),
    };
    if (configPort) {
      await transitionProviderViaPort(configPort, "nasdaq", "verify", userLogin, verifyDeps);
      await transitionProviderViaPort(configPort, "nasdaq", "enable", userLogin, {});
    } else {
      await transitionProvider(sql, "nasdaq", "verify", userLogin, verifyDeps);
      await transitionProvider(sql, "nasdaq", "enable", userLogin, {});
    }
  }
  const registry = new DataProviderRegistry();
  registry.register(
    createNasdaqDataProvider(
      input.fetchListings,
      storage
        ? {
            capture: {
              sql,
              blobStorage: storage as never,
              env,
              ...(input.capturePort ? { capturePort: input.capturePort } : {}),
            },
          }
        : {
            outcomeRecorder: input.capturePort
              ? input.capturePort.createFetchOutcomeRecorder()
              : createCaptureFetchOutcomeRecorder(sql),
          }
    )
  );
  return {
    registry,
    configs: configPort
      ? await configPort.listProviderConfigs()
      : listProviderConfigs(sql),
    routes: configPort
      ? await configPort.listCapabilityRoutes()
      : listCapabilityRoutes(sql),
    runContext: {
      runId,
      tenantId: input.tenantId ?? "default",
      userLogin,
    },
  };
}

/**
 * Issue #1378: the seam screenLive and its callers thread — either
 * a pre-bound fetcher or a route bundle (never both needed;
 * pre-bound deps win in acquireUniverse).
 */
export interface NasdaqUniverseSeam {
  universeDeps?: NasdaqUniverseDeps;
  universeRoute?: NasdaqUniverseRouteBundle;
  /**
   * Issue #1998 (Phase 3): optional gather hook for listing-feed
   * screens whose filter needs technical fields. Absent = today's
   * refusal behavior, unchanged. Type-only import: the hook
   * implementation lives outside src/trading.
   */
  enrichment?: import("./screener").ScreenLiveEnrichment;
}

/**
 * Issue #1378: build the screenLive seam from a service-held ORM.
 * Issue #1661: when the caller threads a DO blob handle, the bundle
 * captures fully; without one the #1378 outcome-only contract is
 * preserved (route resolution enforced, fetch failures
 * outcome-recorded, successful fetches leave no capture row). A
 * bundle-build failure (verify/network) degrades to undefined +
 * warn — never a throw out of screenLive — so the caller gets the
 * missing-seam error-result shape, matching screenLive's contract.
 */
export async function nasdaqUniverseSeamFromSql(
  sql: SqlStorage | undefined,
  env: Env,
  userLogin: string,
  storage?: NasdaqUniverseRouteBundleInput["storage"],
  ports?: DataProviderPorts
): Promise<NasdaqUniverseSeam | undefined> {
  if (!sql) return undefined;
  try {
    const bundle = await nasdaqUniverseRouteBundle({
      sql,
      env,
      userLogin,
      runId: crypto.randomUUID(),
      ...(storage ? { storage } : {}),
      ...(ports?.config ? { configPort: ports.config } : {}),
      ...(ports?.captures ? { capturePort: ports.captures } : {}),
    });
    return { universeRoute: bundle };
  } catch (err) {
    console.warn(
      `[screener] universe seam unavailable, degrading to the missing-seam error result: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Issue #1378: resolve the all-listings universe from the threaded
 * seam. Called INSIDE acquireUniverse's try block (decision D1),
 * so every failure — missing seam, route not naming nasdaq,
 * nasdaq not enabled, fetch failure — becomes the existing
 * error-result shape naming the route/provider.
 */
async function resolveAllListings(
  opts: AcquireUniverseOptions
): Promise<NasdaqStockListing[]> {
  if (opts.universeDeps) return opts.universeDeps.fetchListings();
  if (opts.universeRoute) {
    const provider = nasdaqUniverseProviderFromRoute(
      opts.universeRoute.registry,
      opts.universeRoute.configs,
      opts.universeRoute.routes
    );
    return bindNasdaqUniverseDeps(provider, opts.universeRoute.runContext).fetchListings();
  }
  throw new Error(
    "all-listings mode requires universeDeps or universeRoute — no dep-less listings fetch exists (#1378)"
  );
}

/**
 * Issue #1378: resolve the live-quotes/etrade-only symbol source
 * from the threaded seam, with the pre-#1378 three-attempt retry
 * (the old fetchTechnologySymbols wrapper) preserved around the
 * seam fetch. Symbols explicitly passed still win; when they are
 * absent and no seam exists, the throw mirrors the existing
 * quoteDeps throw pattern for the same modes.
 */
async function resolveUniverseListings(
  opts: AcquireUniverseOptions,
  mode: "live-quotes" | "etrade-only" | "alpaca"
): Promise<NasdaqStockListing[]> {
  if (opts.symbols) return opts.symbols;
  if (opts.universeDeps) {
    return withRetries(() => opts.universeDeps!.fetchListings(), "Nasdaq listings");
  }
  if (opts.universeRoute) {
    const provider = nasdaqUniverseProviderFromRoute(
      opts.universeRoute.registry,
      opts.universeRoute.configs,
      opts.universeRoute.routes
    );
    const deps = bindNasdaqUniverseDeps(provider, opts.universeRoute.runContext);
    return withRetries(() => deps.fetchListings(), "Nasdaq listings");
  }
  throw new Error(
    `${mode} mode requires universeDeps or universeRoute when symbols are absent (#1378)`
  );
}

/**
 * Issue #1317: resolve the yahoo-mode quote provider from the
 * platform route table. The full resolveRoute cannot serve yahoo
 * mode: it throws when the route's etrade primary is unservable,
 * and a Yahoo-provider run must never construct the broker service
 * (#1007). So this helper reads the same route table directly: the
 * quotes route must exist, yahoo's config must be enabled (state
 * and flag), and the registry must hold a quotes-capable yahoo
 * adapter. Anything else throws — no silent substitution, no
 * fallback to another provider.
 * Issue #2144: the route no longer needs to name yahoo as gap-fill
 * — the seed names no quotes gap-fill, and a live quote row is
 * never gap-filled. Yahoo mode is a caller-selected uniform mode
 * (provider "yahoo"), so it resolves on yahoo being enabled and
 * registered, not on the gap-fill field.
 */
export function yahooQuoteProviderFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): DataProvider {
  const route = routes.find((r) => r.capability === "quotes");
  if (!route) {
    throw new Error(
      "Yahoo-mode quote resolution failed: no quotes route exists."
    );
  }
  const config = configs.find((c) => c.id === "yahoo");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    throw new Error(
      "Yahoo-mode quote resolution failed: the yahoo provider is not enabled (lifecycle state and flag)."
    );
  }
  const provider = registry.get("yahoo");
  if (!provider || !provider.capabilities.includes("quotes")) {
    throw new Error(
      "Yahoo-mode quote resolution failed: no quotes-capable yahoo adapter is registered."
    );
  }
  return provider;
}

/**
 * Issue #1356: the platform quote seam — replaces the retired
 * broker-shaped LiveScreenerDeps. An injected live-quote fetcher
 * bound over a platform DataProvider (never over a broker service
 * directly). Production binds the quotes-route provider(s);
 * tests bind fixtures.
 */
export interface QuoteScreenerDeps {
  /** Fetch a live quote for a symbol. Throws on failure. */
  fetchQuote: (symbol: string) => Promise<ETradeQuote>;
  /**
   * Issue #495 (carried from the retired LiveScreenerDeps batch):
   * fetch quotes for many symbols in one request. Optional —
   * providers without it keep the per-symbol path. Returns the
   * quotes actually served; the caller diffs against the request
   * to see which symbols are missing.
   */
  fetchQuotes?: (symbols: string[]) => Promise<ETradeQuote[]>;
  /**
   * Issue #1356: label of the gap-fill provider the live-quotes
   * composer consults ("Yahoo Finance"), for honest-failure
   * messages. Absent on the etrade-only binding, which has no
   * gap-fill by construction.
   */
  gapFillLabel?: string;
}

/**
 * Issue #1356: resolve the etrade-only quote provider from the
 * platform route table — the quotes route's primary assignment
 * (seeded: etrade primary, yahoo gap-fill, freemium). The route
 * must name etrade as primary, etrade's config must be enabled
 * (state and flag), and the registry must hold a quotes-capable
 * etrade adapter. Anything else throws DataProviderNotFoundError —
 * no silent substitution, no promotion of the gap-fill.
 */
export function etradeQuoteProviderFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): DataProvider {
  const route = routes.find((r) => r.capability === "quotes");
  if (!route || route.primaryProviderId !== "etrade") {
    throw new DataProviderNotFoundError("quotes");
  }
  const config = configs.find((c) => c.id === "etrade");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    throw new DataProviderNotFoundError("quotes");
  }
  const provider = registry.get("etrade");
  if (!provider || !provider.capabilities.includes("quotes")) {
    throw new DataProviderNotFoundError("quotes");
  }
  return provider;
}

/**
 * Issue #1356: resolve the live-quotes quote providers from the
 * platform route table. Issue #2144 (owner ruling): the quotes
 * route never yields a gap-fill — live quote rows are never filled
 * by another provider, even when the route declares one — so this
 * helper returns the primary only. The primary must resolve exactly
 * as etradeQuoteProviderFromRoute resolves it: an unservable primary
 * throws DataProviderNotFoundError even when Yahoo could serve —
 * gap-fill is never silently promoted to primary.
 */
export function quotesProvidersFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): { primary: DataProvider; gapFill?: DataProvider } {
  const primary = etradeQuoteProviderFromRoute(registry, configs, routes);
  return { primary };
}

/**
 * Issue #1356: bind one platform quotes provider to the pipeline
 * seam — the etrade-only binding. The provider's getQuote /
 * getQuotesBatch results are pipeline quotes (P1 parity: the
 * envelope wraps by reference); the run context rides along so
 * every quote the run acquires is captured under the run's id.
 * The batch dep exists only when the provider offers
 * getQuotesBatch, so providers without batch keep the per-symbol
 * path. This binding takes NO gap-fill parameter: etrade-only
 * means E*TRADE or nothing, by construction.
 */
export function bindEtradeQuoteDeps(
  provider: DataProvider,
  runContext: DataRunContext
): QuoteScreenerDeps {
  return {
    fetchQuote: async (symbol: string) =>
      (await provider.getQuote!(symbol, runContext)).result as ETradeQuote,
    ...(typeof provider.getQuotesBatch === "function"
      ? {
          fetchQuotes: async (symbols: string[]) =>
            (await provider.getQuotesBatch!(symbols, runContext)).result as ETradeQuote[],
        }
      : {}),
  };
}

/**
 * Issue #3655: bind one platform quotes provider to the pipeline
 * seam — the Alpaca binding. The binding itself is provider-generic
 * (the same getQuote/getQuotesBatch shape as the etrade-only
 * binding); only the name differs, so an Alpaca run's deps are
 * visibly Alpaca-bound at the call site and never pass through an
 * E*TRADE-named binding. This binding takes NO gap-fill parameter:
 * alpaca means Alpaca or nothing, by construction.
 */
export function bindAlpacaQuoteDeps(
  provider: DataProvider,
  runContext: DataRunContext
): QuoteScreenerDeps {
  return bindEtradeQuoteDeps(provider, runContext);
}

/**
 * Issue #3655: resolve the alpaca-mode quote provider from the
 * platform route table, mirroring yahooQuoteProviderFromRoute. The
 * quotes route must exist, alpaca's config must be enabled (state
 * and flag), and the registry must hold a quotes-capable alpaca
 * adapter. Anything else throws — no silent substitution, no
 * fallback to another provider.
 */
export function alpacaQuoteProviderFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): DataProvider {
  const route = routes.find((r) => r.capability === "quotes");
  if (!route) {
    throw new Error(
      "Alpaca-mode quote resolution failed: no quotes route exists."
    );
  }
  const config = configs.find((c) => c.id === "alpaca");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    throw new Error(
      "Alpaca-mode quote resolution failed: the alpaca provider is not enabled (lifecycle state and flag)."
    );
  }
  const provider = registry.get("alpaca");
  if (!provider || !provider.capabilities.includes("quotes")) {
    throw new Error(
      "Alpaca-mode quote resolution failed: no quotes-capable alpaca adapter is registered."
    );
  }
  return provider;
}

/**
 * Issue #2056: bind a Yahoo-only quote seam — the mirror of
 * bindEtradeQuoteDeps, with Yahoo rows adapted through
 * yahooQuoteToPipelineQuote (non-live or non-positive rows are
 * refused, never re-stamped). The gather path fetches live and
 * Yahoo separately and intersects on symbols, so it needs Yahoo
 * membership proven independently — the combined seam's gap-fill
 * alone cannot prove it (gap-fill only touches live-missed
 * symbols). fetchQuote throws on failure, per the QuoteScreenerDeps
 * contract; fetchQuotes returns only adapted rows.
 */
export function bindYahooQuoteDeps(
  provider: DataProvider,
  runContext: DataRunContext
): QuoteScreenerDeps {
  return {
    fetchQuote: async (symbol: string) => {
      const row = (await provider.getQuote!(symbol, runContext)).result as MarketDataResearchQuote;
      const quote = yahooQuoteToPipelineQuote(row);
      if (!quote) throw new Error(`Yahoo Finance returned no live quote for ${symbol}`);
      return quote;
    },
    ...(typeof provider.getQuotesBatch === "function"
      ? {
          fetchQuotes: async (symbols: string[]) => {
            const rows = (await provider.getQuotesBatch!(symbols, runContext))
              .result as MarketDataResearchQuote[];
            const out: ETradeQuote[] = [];
            for (const row of rows) {
              const quote = yahooQuoteToPipelineQuote(row);
              if (quote) out.push(quote);
            }
            return out;
          },
        }
      : {}),
  };
}

/**
 * Issue #1356: bind the live-quotes composition to the pipeline
 * seam — E*TRADE primary + Yahoo gap-fill, per element. Each
 * element is served by the primary when it serves a positive-price
 * quote; exactly the elements the primary omits, fails, or
 * zero-prices go to the gap-fill, adapted through
 * yahooQuoteToPipelineQuote (non-live or non-positive gap-fill
 * rows are refused, never re-stamped). A gap-fill failure for an
 * element never masks the primary's error: when nothing serves the
 * element, the primary's failure is what the caller categorizes.
 * Provenance is stamped here: primary rows are stamped
 * "E*TRADE live" / "LIVE" (the adapter's own rows carry the
 * service's feed label, and the retired leg overwrote it the same
 * way), gap-fill rows carry yahooQuoteToPipelineQuote's
 * "Yahoo Finance" / "LIVE". The run context rides along to both
 * providers so every quote the run acquires is captured under the
 * run's id.
 */
export function bindLiveQuotesQuoteDeps(
  primary: DataProvider,
  gapFill: DataProvider | undefined,
  runContext: DataRunContext
): QuoteScreenerDeps {
  const primaryDeps = bindEtradeQuoteDeps(primary, runContext);
  const gapQuote = gapFill
    ? async (symbol: string): Promise<ETradeQuote | null> => {
        try {
          const row = (await gapFill.getQuote!(symbol, runContext)).result as MarketDataResearchQuote;
          return yahooQuoteToPipelineQuote(row);
        } catch {
          return null;
        }
      }
    : null;
  const gapQuotes =
    gapFill && typeof gapFill.getQuotesBatch === "function"
      ? async (symbols: string[]): Promise<Map<string, ETradeQuote>> => {
          try {
            const rows = (await gapFill.getQuotesBatch!(symbols, runContext))
              .result as MarketDataResearchQuote[];
            const out = new Map<string, ETradeQuote>();
            for (const row of rows) {
              const quote = yahooQuoteToPipelineQuote(row);
              if (quote) out.set(quote.symbol.toUpperCase(), quote);
            }
            return out;
          } catch {
            return new Map();
          }
        }
      : null;
  return {
    fetchQuote: async (symbol: string) => {
      try {
        const prime = await primaryDeps.fetchQuote(symbol);
        if (prime && prime.lastPrice > 0) {
          return { ...prime, source: "E*TRADE live", quoteStatus: "LIVE" } as ETradeQuote;
        }
        if (gapQuote) {
          const filled = await gapQuote(symbol);
          if (filled) return filled;
        }
        return prime;
      } catch (err) {
        if (gapQuote) {
          const filled = await gapQuote(symbol);
          if (filled) return filled;
        }
        throw err;
      }
    },
    ...(primaryDeps.fetchQuotes || gapQuotes
      ? {
          fetchQuotes: async (symbols: string[]) => {
            const served = new Map<string, ETradeQuote>();
            if (primaryDeps.fetchQuotes) {
              try {
                const rows = await primaryDeps.fetchQuotes(symbols);
                for (const row of rows) {
                  if (row && row.lastPrice > 0) {
                    served.set(row.symbol.toUpperCase(), {
                      ...row,
                      source: "E*TRADE live",
                      quoteStatus: "LIVE",
                    } as ETradeQuote);
                  }
                }
              } catch {
                // Whole-batch primary failure: every element stays
                // missing for the gap-fill pass below.
              }
            }
            const missing = symbols.filter((s) => !served.has(s.toUpperCase()));
            if (gapQuotes && missing.length > 0) {
              const filled = await gapQuotes(missing);
              for (const [symbol, quote] of filled) served.set(symbol, quote);
            }
            return symbols
              .filter((s) => served.has(s.toUpperCase()))
              .map((s) => served.get(s.toUpperCase())!);
          },
        }
      : {}),
    ...(gapFill ? { gapFillLabel: YAHOO_QUOTE_SOURCE } : {}),
  };
}

/**
 * Adapt one live Yahoo provider quote to the pipeline quote shape.
 * Returns null when the quote is not genuinely live Yahoo data
 * (provenance !== "live" or no positive price) — the caller skips the
 * symbol rather than screening fabricated data.
 */
export function yahooQuoteToPipelineQuote(
  live: MarketDataResearchQuote,
  base?: CuratedStockSecurity
): ETradeQuote | null {
  if (!live || live.provenance !== "live" || !(live.price > 0)) return null;
  const symbol = (live.symbol || base?.symbol || "").toUpperCase();
  if (!symbol) return null;
  const prevClose =
    live.previousClose ||
    Number((live.price - live.change).toFixed(2));
  const change = Number((live.price - prevClose).toFixed(2));
  const changePercent =
    prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;
  return {
    symbol,
    companyName: live.companyName || base?.companyName || symbol,
    sector: base?.sector,
    lastPrice: live.price,
    price: live.price,
    change,
    changePercent,
    bid: live.bid || live.price,
    ask: live.ask || live.price,
    volume: live.volume || 0,
    open: live.open || live.price,
    high: live.high || live.price,
    low: live.low || live.price,
    previousClose: prevClose,
    peRatio: live.trailingPE,
    // Yahoo reports market cap in raw dollars; the pipeline's
    // evaluator normalizes magnitudes itself (screener.ts).
    marketCap: live.marketCap,
    // Indicator DATA fields: real RSI-14 / MACD from Yahoo history,
    // computed by the provider. Absent when history was insufficient —
    // never estimated here.
    rsi: live.rsi14,
    macdSignal: live.macdSignal,
    quoteStatus: "LIVE",
    source: YAHOO_QUOTE_SOURCE,
    timestamp: live.timestamp || new Date().toISOString(),
  };
}

/**
 * Fetch live Yahoo quotes for a symbol list (concurrency-batched).
 * Symbols whose lookup fails or is not
 * genuinely live are SKIPPED — no fallback data is substituted. The
 * caller decides what an empty/short result means (acquireUniverse's
 * yahoo mode fails the run when nothing quoted, and qualifies a
 * partial set exactly like the E*TRADE path).
 */
/** Symbols per batch-endpoint request (issue #1184). */
const YAHOO_BATCH_CHUNK = 50;

export async function fetchYahooQuotes(
  symbols: string[],
  deps: YahooScreenerDeps,
  opts?: {
    /**
     * Issue #1770: per-run subrequest budget. When supplied, every
     * actual upstream invocation charges one unit (the first attempt
     * is charged synchronously before launch; retries charge on each
     * re-invocation), and symbols never attempted because the budget
     * ran out are reported via onBudgetDeferred — never fetched past
     * the budget, never silently dropped. Absent = unbounded legacy
     * behaviour (existing callers/tests unaffected).
     */
    budget?: StockSubrequestBudget;
    onBudgetDeferred?: (symbols: string[]) => void;
  }
): Promise<ETradeQuote[]> {
  const policy = deps.retryPolicy ?? DEFAULT_PIPELINE_POLICY.retry.acquisition;
  const bySymbol = new Map<string, ETradeQuote>();
  const budget = opts?.budget;
  const deferredSymbols: string[] = [];

  // Issue #1184 (#1173 R2): batch first — one request per chunk of
  // 50 replaces 2–3 requests per symbol (the burst Yahoo throttled
  // to 25% success on 2026-10-23). A failed chunk (after the shared
  // acquisition policy's retries) falls back to per-symbol fetches
  // for its symbols; symbols a batch response omits do the same.
  if (deps.fetchYahooBatchQuotes) {
    for (let i = 0; i < symbols.length; i += YAHOO_BATCH_CHUNK) {
      if (budget?.exhausted) {
        deferredSymbols.push(...symbols.slice(i));
        break;
      }
      const chunk = symbols.slice(i, i + YAHOO_BATCH_CHUNK);
      // First attempt charged synchronously before launch; retries
      // charge on each re-invocation through the wrapper.
      if (budget && !budget.tryConsume()) {
        deferredSymbols.push(...symbols.slice(i));
        break;
      }
      let attempts = 0;
      try {
        const batch = await withRetry(
          () => {
            attempts++;
            if (attempts > 1 && budget && !budget.tryConsume()) {
              throw stockBudgetError();
            }
            return deps.fetchYahooBatchQuotes!(chunk);
          },
          policy,
          { label: `yahoo-batch:${chunk.length}`, sleep: deps.retrySleep }
        );
        for (const live of batch) {
          const adapted = yahooQuoteToPipelineQuote(
            live,
            getCuratedStockBySymbol(live.symbol)
          );
          if (adapted) bySymbol.set(adapted.symbol.toUpperCase(), adapted);
        }
      } catch (err) {
        console.warn(
          `[yahooAcquisition] batch quote chunk failed (${chunk.length} symbols); falling back per-symbol:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  const missing = symbols.filter(
    (s) =>
      !bySymbol.has(s.toUpperCase()) &&
      !deferredSymbols.some((d) => d.toUpperCase() === s.toUpperCase())
  );
  const quotes: ETradeQuote[] = [];
  const CONCURRENCY = 10;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    if (budget?.exhausted) {
      deferredSymbols.push(...missing.slice(i));
      break;
    }
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        // Issue #1770: the budget gate runs synchronously before the
        // first await, so concurrent callbacks in one chunk consume
        // in order and cannot overspend; the symbol is deferred, not
        // attempted, once the budget is gone.
        if (budget && !budget.tryConsume()) {
          deferredSymbols.push(symbol);
          return null;
        }
        // Issue #1181 (#1173 R1): every symbol fetch retries under
        // the shared acquisition policy (exponential backoff) — the
        // parity the E*TRADE path always had. A symbol is dropped
        // only after its attempts are exhausted; the partial-quote
        // qualification in acquireUniverse reports it as before.
        let attempts = 0;
        return withRetry(
          async () => {
            attempts++;
            if (attempts > 1 && budget && !budget.tryConsume()) {
              throw stockBudgetError();
            }
            const live = await deps.fetchYahooQuote(symbol);
            const adapted = yahooQuoteToPipelineQuote(
              live,
              getCuratedStockBySymbol(symbol)
            );
            if (!adapted) {
              throw new Error(
                `Yahoo Finance returned no live quote for ${symbol}`
              );
            }
            return adapted;
          },
          policy,
          { label: `yahoo:${symbol}`, sleep: deps.retrySleep }
        );
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) quotes.push(r.value);
    }
  }
  if (deferredSymbols.length > 0) opts?.onBudgetDeferred?.(deferredSymbols);
  for (const q of quotes) bySymbol.set(q.symbol.toUpperCase(), q);
  // Input order, batch and per-symbol results merged.
  return symbols
    .map((s) => bySymbol.get(s.toUpperCase()))
    .filter((q): q is ETradeQuote => !!q);
}

/**
 * The Yahoo provider's default universe: the curated market universe
 * (the membership the retired engine screened), expressed as pipeline
 * listings. Membership only — prices always come from live quotes.
 */
export function yahooUniverseListings(): NasdaqStockListing[] {
  return YFINANCE_MARKET_UNIVERSE.map((item) => ({
    symbol: item.symbol,
    companyName: item.companyName,
    exchange: item.exchange,
    change: 0,
    changePercent: 0,
    marketCap: item.marketCap,
    sector: item.sector,
  }));
}

/**
 * Acquire the screening universe. Manual uses all-listings; the
 * screener agent and scheduled runs use etrade-only; live-quotes is
 * the composed E*TRADE-primary + Yahoo gap-fill mode (#1356).
 * Returns quotes ready for screenWithQuotes plus discovery metadata
 * for the UI.
 */
export async function acquireUniverse(
  opts: AcquireUniverseOptions
): Promise<AcquiredUniverse> {
  // Issue #1007: yahoo mode — Yahoo Finance as a data-source adapter
  // inside this pipeline. Quotes arrive already adapted to the
  // pipeline quote shape with RSI/MACD as data fields (helpers above,
  // moved from yahooDataSource.ts in #1317); production deps are
  // bound over the platform yahoo provider (bindYahooScreenerDeps),
  // so every fetch is captured and outcome-tracked under the run id.
  // Everything downstream (screenUniverse, shaping, persistence) is
  // identical to the E*TRADE path. Honest failure: if Yahoo returns
  // no live quote the run FAILS — there is no fallback to E*TRADE
  // data and no fabricated row. A partial set is qualified exactly
  // like the E*TRADE path's partial (issue #462).
  if (opts.mode === "yahoo") {
    if (!opts.yahooDeps) {
      throw new Error("yahoo mode requires yahooDeps.fetchYahooQuote");
    }
    const cfg = opts.config ?? DEFAULT_SCREENER_CONFIG;
    const symbols = opts.symbols ?? yahooUniverseListings();
    const maxSymbols = opts.maxSymbols ?? cfg.acquisition.defaultMaxSymbols;
    const limited = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
    if (limited.length === 0) {
      throw new Error("The selected Yahoo universe contains no listings; no static symbols were substituted.");
    }
    // Issue #1770: the run's subrequest budget bounds Yahoo
    // acquisition exactly like the E*TRADE legs below; deferred
    // symbols are a named reason, not yahoo-unavailable.
    const budget = createStockSubrequestBudget(
      cfg.acquisition.maxSubrequestsPerRun
    );
    const budgetDeferred: string[] = [];
    const quotes = await fetchYahooQuotes(
      limited.map((l) => l.symbol),
      opts.yahooDeps,
      {
        budget,
        onBudgetDeferred: (symbols) => budgetDeferred.push(...symbols),
      }
    );
    const quotedSymbols = new Set(quotes.map((q) => q.symbol.toUpperCase()));
    const failed = limited
      .map((l) => l.symbol)
      .filter((s) => !quotedSymbols.has(s.toUpperCase()));
    const deferredSet = new Set(budgetDeferred.map((s) => s.toUpperCase()));
    const failureReasons: Record<string, number> = {};
    if (failed.length - budgetDeferred.length > 0) {
      failureReasons["yahoo-unavailable"] =
        failed.length - budgetDeferred.length;
    }
    if (budgetDeferred.length > 0) {
      failureReasons["request-budget"] = budgetDeferred.length;
    }
    if (quotes.length === 0) {
      throw new Error(
        `Yahoo Finance unavailable: no live quotes returned (0 of ${limited.length} symbols quoted` +
          (failed.length > 0 ? ` (failed: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : "") +
          (budgetDeferred.length > 0
            ? ` (failure reasons: request-budget=${budgetDeferred.length})`
            : "") +
          `). No fallback data substituted.`
      );
    }
    const partial: PartialQuoteQualification | undefined =
      failed.length > 0
        ? {
            quotedCount: quotes.length,
            requestedCount: limited.length,
            failedSymbols: failed,
            failureReasons,
            failureSamples: failed
              .slice(0, 3)
              .map((s) =>
                deferredSet.has(s.toUpperCase())
                  ? `${s}: request-budget (${STOCK_SUBREQUEST_BUDGET_DEFERRED_REASON})`
                  : `${s}: yahoo-unavailable (Yahoo Finance returned no live quote)`
              ),
          }
        : undefined;
    return {
      quotes,
      provider: "yahoo",
      ...(partial ? { partial } : {}),
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message: partial
          ? `Partial screen — qualified results: Yahoo Finance quoted ${quotes.length} of ${limited.length} symbols ` +
            `(${failed.length} unavailable: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}). Screen ran on the quoted subset only; no fallback data substituted.`
          : `Yahoo Finance live quotes; ${quotes.length} of ${limited.length} symbols quoted.`,
      },
    };
  }

  // Issue #1356: live-quotes mode — E*TRADE primary + Yahoo gap-fill
  // per element, composed by bindLiveQuotesQuoteDeps. The retired
  // Nasdaq-listing DELAYED fallback is gone: a symbol neither
  // provider serves is a categorized failure, never a stale row.
  // Unlike etrade-only, an empty universe returns empty quotes
  // (the pre-#1356 live-quotes behaviour for empty input).
  if (opts.mode === "live-quotes") {
    if (!opts.quoteDeps) {
      throw new Error("live-quotes mode requires quoteDeps.fetchQuote");
    }
    const cfg = opts.config ?? DEFAULT_SCREENER_CONFIG;
    // Issue #1770: same run budget as the etrade-only leg below —
    // batch + per-symbol passes share one ledger per run, and
    // budget-deferred symbols are never re-attempted.
    const budget = createStockSubrequestBudget(
      cfg.acquisition.maxSubrequestsPerRun
    );
    const budgetDeferred = new Set<string>();
    const symbols =
      opts.symbols ?? filterTechnologySymbols(await resolveUniverseListings(opts, "live-quotes"));
    const maxSymbols = opts.maxSymbols ?? cfg.acquisition.defaultMaxSymbols;
    const limited = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
    const gapFillLabel = opts.quoteDeps.gapFillLabel;
    const providerLabel = gapFillLabel ? `E*TRADE and ${gapFillLabel}` : "E*TRADE";
    if (limited.length === 0) {
      return {
        quotes: [],
        provider: "etrade",
        discovery: {
          mode: "live_quotes",
          candidateCount: symbols.length,
          listingCount: 0,
          message: `E*TRADE-primary live quotes${gapFillLabel ? ` with ${gapFillLabel} gap-fill` : ""}; 0 of 0 symbols quoted.`,
        },
      };
    }
    const quotes: ETradeQuote[] = [];
    const quotedSymbols = new Set<string>();
    const failed: string[] = [];
    const failureReasons: Record<string, number> = {};
    const failureSamples: string[] = [];
    const quoteErrors = new Map<string, unknown>();
    const listingsBySymbol = new Map(
      limited.map((listing) => [listing.symbol.toUpperCase(), listing])
    );
    const CONCURRENCY = Math.min(cfg.acquisition.quoteConcurrency, 5);
    const BATCH_PAUSE_MS = 500;

    // Provenance-preserving accept: the composer already stamps each
    // row's source (E*TRADE live / Yahoo Finance). The leg keeps
    // that stamp and only fills sector/companyName enrichment.
    const acceptQuote = (
      listing: NasdaqStockListing,
      live: ETradeQuote | null
    ): boolean => {
      if (!live || !(live.lastPrice > 0)) return false;
      if (quotedSymbols.has(listing.symbol.toUpperCase())) return true;
      quotes.push({
        ...live,
        symbol: listing.symbol,
        companyName: live.companyName || listing.companyName,
        sector: resolveStockSector(listing.symbol, live.companyName || listing.companyName, live.sector || listing.sector),
        source: live.source || "E*TRADE live",
        quoteStatus: live.quoteStatus || "LIVE",
      } as ETradeQuote);
      quotedSymbols.add(listing.symbol.toUpperCase());
      return true;
    };

    const batchSize = Math.max(1, cfg.acquisition.quoteBatchSize);
    if (opts.quoteDeps.fetchQuotes) {
      const requestedSymbols = limited.map((listing) => listing.symbol);
      for (let i = 0; i < requestedSymbols.length; i += batchSize) {
        // Issue #1770: an exhausted budget defers every remaining
        // chunk without issuing (or retry-delaying) another fetch.
        if (!budget.tryConsume()) {
          for (const symbol of requestedSymbols.slice(i)) {
            budgetDeferred.add(symbol.toUpperCase());
            quoteErrors.set(symbol, stockBudgetError());
          }
          break;
        }
        const chunk = requestedSymbols.slice(i, i + batchSize);
        let batchAttempts = 0;
        try {
          const batchQuotes = await withRetries(
            () => {
              batchAttempts++;
              if (batchAttempts > 1 && !budget.tryConsume()) {
                throw stockBudgetError();
              }
              return opts.quoteDeps!.fetchQuotes!(chunk);
            },
            "Live quotes batch"
          );
          const bySymbol = new Map(
            batchQuotes.map((quote) => [
              String(quote.symbol || "").toUpperCase(),
              quote,
            ])
          );
          for (const symbol of chunk) {
            const listing = listingsBySymbol.get(symbol.toUpperCase());
            const live = bySymbol.get(symbol.toUpperCase());
            if (!listing) continue;
            if (!live) {
              quoteErrors.set(symbol, new Error(`Batch quote omitted ${symbol}`));
            } else if (!acceptQuote(listing, live)) {
              quoteErrors.set(
                symbol,
                new Error(`No live quote returned for ${symbol} [zero-price(lastPrice=${live.lastPrice})]`)
              );
            }
          }
        } catch (err) {
          // Whole-batch failure: remember it per symbol, then let the
          // per-symbol pass produce the specific error where affordable.
          for (const symbol of chunk) quoteErrors.set(symbol, err);
        }
        // Pace batches to stay under provider rate limits.
        if (i + batchSize < requestedSymbols.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
        }
      }
    }

    // Per-symbol pass: covers providers without a batch fetcher and
    // symbols a successful batch omitted. Bounded by
    // maxIndividualQuoteRetries so a provider-wide outage cannot
    // turn one screen into hundreds of requests.
    // Issue #1770: budget-deferred symbols are excluded here and
    // every fetch charges the run budget (first attempt synchronously
    // before launch, retries on each re-invocation).
    const missingSymbols = limited
      .map((listing) => listing.symbol)
      .filter(
        (symbol) =>
          !quotedSymbols.has(symbol.toUpperCase()) &&
          !budgetDeferred.has(symbol.toUpperCase())
      );
    const retryBudget = Math.max(0, cfg.acquisition.maxIndividualQuoteRetries);
    const retrySymbols = missingSymbols.slice(0, retryBudget);
    for (let i = 0; i < retrySymbols.length; i += CONCURRENCY) {
      if (budget.exhausted) {
        for (const symbol of retrySymbols.slice(i)) {
          budgetDeferred.add(symbol.toUpperCase());
          quoteErrors.set(symbol, stockBudgetError());
        }
        break;
      }
      const batch = retrySymbols.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          if (!budget.tryConsume()) {
            budgetDeferred.add(symbol.toUpperCase());
            quoteErrors.set(symbol, stockBudgetError());
            return { symbol, live: null, deferred: true as const };
          }
          let attempts = 0;
          const live = await withRetries(
            () => {
              attempts++;
              if (attempts > 1 && !budget.tryConsume()) {
                throw stockBudgetError();
              }
              return opts.quoteDeps!.fetchQuote(symbol);
            },
            "Live quote",
            symbol
          );
          if (!live || !(live.lastPrice > 0)) {
            // Preserve the underlying state for diagnostics: distinguish
            // null (provider returned nothing) from zero-price (empty quote).
            const detail = !live ? "null-response" : `zero-price(lastPrice=${live.lastPrice})`;
            throw new Error(`No live quote returned for ${symbol} [${detail}]`);
          }
          return { symbol, live, deferred: false as const };
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && !r.value.deferred) {
          const listing = listingsBySymbol.get(batch[j].toUpperCase());
          if (listing) acceptQuote(listing, r.value.live);
        } else if (r.status === "rejected") {
          quoteErrors.set(batch[j], r.reason);
        }
        // Fulfilled + deferred: the budget error is already recorded
        // in quoteErrors above; nothing further to do for the symbol.
      }
      // Pace batches to stay under provider rate limits.
      if (i + CONCURRENCY < retrySymbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    for (const symbol of limited.map((listing) => listing.symbol)) {
      if (quotedSymbols.has(symbol.toUpperCase())) continue;
      failed.push(symbol);
      const reason =
        quoteErrors.get(symbol) ??
        new Error(`No live quote returned for ${symbol} [null-response]`);
      const category = categorizeQuoteFailure(reason);
      failureReasons[category] = (failureReasons[category] ?? 0) + 1;
      if (failureSamples.length < 3) {
        failureSamples.push(`${symbol}: ${category} (${safeQuoteFailure(reason)})`);
      }
    }
    if (failed.length > 0) {
      console.warn(
        `[screenerPipeline] Live quote failures: ${failed.length}/${limited.length}. ` +
          `Reasons: ${JSON.stringify(failureReasons)}. Samples: ${failureSamples.join("; ")}`
      );
    }
    const reasonSummary = Object.entries(failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    if (quotes.length === 0 && failed.length > 0) {
      // With zero quotes there is no screen to qualify — fail
      // honestly with the full diagnostics (mirrors etrade-only,
      // issue #462/#902/#907: any auth failure makes the root
      // cause auth, hence FAILURE_AUTH_TOKEN_EXPIRED).
      const authFailures = failureReasons["auth"] ?? 0;
      if (authFailures > 0) {
        const { BusinessError } = await import("../outcomes/outcomeAspects");
        throw new BusinessError("FAILURE_AUTH_TOKEN_EXPIRED", { failedCount: failed.length, authFailures });
      }
      throw new Error(
        `Live quotes unavailable: ${providerLabel} returned no live quotes (${quotes.length} of ${limited.length} symbols quoted` +
          (failed.length > 0 ? ` (failed: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : "") +
          (reasonSummary ? ` (failure reasons: ${reasonSummary})` : "") +
          (failureSamples.length > 0 ? ` (diagnostics: ${failureSamples.join("; ")})` : "") +
          `). No fallback data substituted.`
      );
    }
    const gapFillCount = quotes.filter((q) => q.source === YAHOO_QUOTE_SOURCE).length;
    const partial: PartialQuoteQualification | undefined =
      failed.length > 0
        ? {
            quotedCount: quotes.length,
            requestedCount: limited.length,
            failedSymbols: failed,
            failureReasons,
            failureSamples,
          }
        : undefined;
    return {
      quotes,
      provider: "etrade",
      ...(partial ? { partial } : {}),
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message: partial
          ? `Partial screen — qualified results: live quotes covered ${quotes.length} of ${limited.length} symbols ` +
            (gapFillLabel && gapFillCount > 0 ? `(${gapFillLabel} gap-fill covered ${gapFillCount}) ` : "") +
            `(${failed.length} unavailable: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}` +
            (reasonSummary ? `; failure reasons: ${reasonSummary}` : "") +
            `). Screen ran on the quoted subset only; no fallback data substituted.`
          : `E*TRADE-primary live quotes${gapFillLabel ? ` with ${gapFillLabel} gap-fill` : ""}; ${quotes.length} of ${limited.length} symbols quoted.`,
      },
    };
  }

  // Issue #261: etrade-only mode — market data comes from E*TRADE or
  // nothing. No Nasdaq fallback, no zero-filled substitute rows. If
  // Categorize an E*TRADE quote failure for diagnostics.
  function categorizeQuoteFailure(reason: unknown): string {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const lower = msg.toLowerCase();
    if (lower.includes("rate") || lower.includes("429") || lower.includes("throttl")) {
      return "rate-limited";
    }
    // Cloudflare Workers cap subrequests per invocation. Batch acquisition
    // exists to stay under that cap; a run that still exceeds it must say so
    // instead of reporting a broker outage.
    if (lower.includes("too many subrequests") || lower.includes("subrequest")) {
      return "request-budget";
    }
    if (
      lower.includes("auth") ||
      lower.includes("oauth") ||
      lower.includes("signature") ||
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("token")
    ) {
      return "auth";
    }
    if (lower.includes("null-response")) {
      return "api-empty-response";
    }
    if (lower.includes("http 200 empty response") || lower.includes("returned no quote data")) {
      return "api-empty-response";
    }
    if (lower.includes("zero-price")) {
      return "api-zero-price";
    }
    // Issue #462: the E*TRADE client's actual error strings (previously
    // unrecognized, so every one of these landed in "other"):
    // "contained no positive trade or bid price" is E*TRADE's zero-price.
    if (lower.includes("no positive trade or bid price")) {
      return "api-zero-price";
    }
    // "Quote API Error [HTTP <n>]" with 5xx is an upstream E*TRADE failure
    // (4xx statuses are caught above by their digits: 401/403 → auth,
    // 429 → rate-limited).
    const httpStatus = lower.match(/quote api error \[http (\d{3})\]/);
    if (httpStatus) {
      return Number(httpStatus[1]) >= 500 ? "api-http-5xx" : "api-http-error";
    }
    if (lower.includes("symbol mismatch") || lower.includes("mismatched sandbox quote")) {
      return "symbol-mismatch";
    }
    if (lower.includes("batch quote omitted")) {
      return "batch-omitted";
    }
    if (
      lower.includes("no live quote") ||
      lower.includes("no quote") ||
      lower.includes("not found") ||
      lower.includes("invalid symbol")
    ) {
      return "symbol-not-quotable";
    }
    if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("network")) {
      return "network";
    }
    return "other";
  }

  // Keep enough upstream detail to diagnose a failed quote run while
  // preventing credentials or OAuth signing material from entering logs and
  // user-visible errors.
  function safeQuoteFailure(reason: unknown): string {
    const message = reason instanceof Error ? reason.message : String(reason);
    return message
      .replace(/\b(oauth_(?:token|token_secret|signature|consumer_key|consumer_secret))=[^\s&,]+/gi, "$1=[redacted]")
      .replace(/\b(accessToken|accessTokenSecret|consumerSecret|tokenSecret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 180);
  }

  // E*TRADE cannot quote a symbol it is skipped; if it cannot quote
  // any, the screen fails honestly instead of presenting fake data.
  // Issue #3655: "alpaca" mode shares this live-quotes branch with
  // "etrade-only": the branch is generic over the bound quoteDeps
  // (the caller binds the Alpaca adapter for alpaca, the E*TRADE
  // adapter for etrade-only). Labels, provenance, and the auth
  // failure code are parameterized on the mode below, so an Alpaca
  // run never reports E*TRADE provenance or an E*TRADE OAuth code.
  if (opts.mode === "etrade-only" || opts.mode === "alpaca") {
    if (!opts.quoteDeps) {
      throw new Error(`${opts.mode} mode requires quoteDeps.fetchQuote`);
    }
    const isAlpacaQuotes = opts.mode === "alpaca";
    const quoteProviderName = isAlpacaQuotes ? "Alpaca" : "E*TRADE";
    const quoteProviderId: StockScreenProvider = isAlpacaQuotes ? "alpaca" : "etrade";
    const cfg = opts.config ?? DEFAULT_SCREENER_CONFIG;
    // Issue #1770: the run's subrequest budget, shared by the batch
    // and per-symbol passes below. Symbols deferred by the budget are
    // tracked separately so the per-symbol pass never re-attempts
    // them and the final loop reports request-budget, not a broker
    // failure, for them.
    const budget = createStockSubrequestBudget(
      cfg.acquisition.maxSubrequestsPerRun
    );
    const budgetDeferred = new Set<string>();
    const symbols =
      opts.symbols ?? filterTechnologySymbols(await resolveUniverseListings(opts, isAlpacaQuotes ? "alpaca" : "etrade-only"));
    const maxSymbols = opts.maxSymbols ?? cfg.acquisition.defaultMaxSymbols;
    const limited = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
    if (limited.length === 0) {
      throw new Error("The selected live universe contains no listings; no static symbols were substituted.");
    }
    const quotes: ETradeQuote[] = [];
    const quotedSymbols = new Set<string>();
    const failed: string[] = [];
    // Categorized failure reasons for diagnostics (issue: stuck-at-6).
    const failureReasons: Record<string, number> = {};
    const failureSamples: string[] = [];
    // Last error seen for a symbol: batch-pass omission first, then the
    // per-symbol retry result (which is the more specific one).
    const quoteErrors = new Map<string, unknown>();
    const listingsBySymbol = new Map(
      limited.map((listing) => [listing.symbol.toUpperCase(), listing])
    );
    // Lower concurrency + pacing: the provider rate-limits rapid quote bursts.
    const CONCURRENCY = Math.min(cfg.acquisition.quoteConcurrency, 5);
    const BATCH_PAUSE_MS = 500;

    const acceptQuote = (
      listing: NasdaqStockListing,
      live: ETradeQuote | null
    ): boolean => {
      if (!live || !(live.lastPrice > 0)) return false;
      if (quotedSymbols.has(listing.symbol.toUpperCase())) return true;
      quotes.push({
        ...live,
        symbol: listing.symbol,
        companyName: live.companyName || listing.companyName,
        // This provider's quote payloads do not reliably include sector. The
        // dynamically fetched Nasdaq listing row does, and resolveStockSector
        // provides curated/inferred enrichment.
        sector: resolveStockSector(listing.symbol, live.companyName || listing.companyName, live.sector || listing.sector),
        source: isAlpacaQuotes ? "Alpaca live" : "E*TRADE live",
        quoteStatus: "LIVE",
      } as ETradeQuote);
      quotedSymbols.add(listing.symbol.toUpperCase());
      return true;
    };

    // Issue #495: ask the provider for the universe in batches. One request per
    // symbol (100 calls for NASDAQ100, each retried) exhausted the Worker
    // subrequest budget and the provider's quote rate limit, so 53 of 100 symbols
    // failed with a generic "no live quote" and the run died with 47 quotes.
    // The quote endpoint takes a symbol list: a 100-symbol screen is two
    // requests, and per-symbol calls are kept for the stragglers only.
    const batchSize = Math.max(1, cfg.acquisition.quoteBatchSize);
    if (opts.quoteDeps.fetchQuotes) {
      const requestedSymbols = limited.map((listing) => listing.symbol);
      for (let i = 0; i < requestedSymbols.length; i += batchSize) {
        // Issue #1770: an exhausted budget defers every remaining
        // chunk without issuing (or retry-delaying) another fetch.
        if (!budget.tryConsume()) {
          for (const symbol of requestedSymbols.slice(i)) {
            budgetDeferred.add(symbol.toUpperCase());
            quoteErrors.set(symbol, stockBudgetError());
          }
          break;
        }
        const chunk = requestedSymbols.slice(i, i + batchSize);
        let batchAttempts = 0;
        try {
          const batchQuotes = await withRetries(
            () => {
              batchAttempts++;
              if (batchAttempts > 1 && !budget.tryConsume()) {
                throw stockBudgetError();
              }
              return opts.quoteDeps!.fetchQuotes!(chunk);
            },
            `${quoteProviderName} batch quote`
          );
          const bySymbol = new Map(
            batchQuotes.map((quote) => [
              String(quote.symbol || "").toUpperCase(),
              quote,
            ])
          );
          for (const symbol of chunk) {
            const listing = listingsBySymbol.get(symbol.toUpperCase());
            const live = bySymbol.get(symbol.toUpperCase());
            if (!listing) continue;
            if (!live) {
              quoteErrors.set(
                symbol,
                new Error(`${quoteProviderName} batch quote omitted ${symbol}`)
              );
            } else if (!acceptQuote(listing, live)) {
              quoteErrors.set(
                symbol,
                new Error(`${quoteProviderName} returned zero-price quote for ${symbol}`)
              );
            }
          }
        } catch (err) {
          // Whole-batch failure: remember it per symbol, then let the
          // per-symbol pass produce the specific error where affordable.
          for (const symbol of chunk) quoteErrors.set(symbol, err);
        }
        // Pace batches to stay under the provider rate limits.
        if (i + batchSize < requestedSymbols.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
        }
      }
    }

    // Per-symbol pass: covers brokers without a batch fetcher and symbols a
    // successful batch omitted. Bounded by maxIndividualQuoteRetries so a
    // broker-wide outage cannot turn one screen into hundreds of requests.
    // Issue #1770: budget-deferred symbols are excluded here (the
    // batch leg already recorded them) and every fetch charges the
    // run budget — first attempt synchronously before launch, retries
    // on each re-invocation — so the pass stops at the budget instead
    // of issuing fetches past it.
    const missingSymbols = limited
      .map((listing) => listing.symbol)
      .filter(
        (symbol) =>
          !quotedSymbols.has(symbol.toUpperCase()) &&
          !budgetDeferred.has(symbol.toUpperCase())
      );
    const retryBudget = Math.max(0, cfg.acquisition.maxIndividualQuoteRetries);
    const retrySymbols = missingSymbols.slice(0, retryBudget);
    for (let i = 0; i < retrySymbols.length; i += CONCURRENCY) {
      if (budget.exhausted) {
        for (const symbol of retrySymbols.slice(i)) {
          budgetDeferred.add(symbol.toUpperCase());
          quoteErrors.set(symbol, stockBudgetError());
        }
        break;
      }
      const batch = retrySymbols.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          if (!budget.tryConsume()) {
            budgetDeferred.add(symbol.toUpperCase());
            quoteErrors.set(symbol, stockBudgetError());
            return { symbol, live: null, deferred: true as const };
          }
          let attempts = 0;
          const live = await withRetries(
            () => {
              attempts++;
              if (attempts > 1 && !budget.tryConsume()) {
                throw stockBudgetError();
              }
              return opts.quoteDeps!.fetchQuote(symbol);
            },
            quoteProviderName,
            symbol
          );
          if (!live || !(live.lastPrice > 0)) {
            // Preserve the underlying state for diagnostics: distinguish
            // null (API returned nothing) from zero-price (empty quote).
            const detail = !live ? "null-response" : `zero-price(lastPrice=${live.lastPrice})`;
            throw new Error(`${quoteProviderName} returned no quote for ${symbol} [${detail}]`);
          }
          return { symbol, live, deferred: false as const };
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && !r.value.deferred) {
          const listing = listingsBySymbol.get(batch[j].toUpperCase());
          if (listing) acceptQuote(listing, r.value.live);
        } else if (r.status === "rejected") {
          quoteErrors.set(batch[j], r.reason);
        }
        // Fulfilled + deferred: the budget error is already recorded
        // in quoteErrors above; nothing further to do for the symbol.
      }
      // Pace batches to stay under the provider rate limits.
      if (i + CONCURRENCY < retrySymbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    for (const symbol of limited.map((listing) => listing.symbol)) {
      if (quotedSymbols.has(symbol.toUpperCase())) continue;
      failed.push(symbol);
      const reason =
        quoteErrors.get(symbol) ??
        new Error(`${quoteProviderName} returned no quote for ${symbol} [null-response]`);
      const category = categorizeQuoteFailure(reason);
      failureReasons[category] = (failureReasons[category] ?? 0) + 1;
      if (failureSamples.length < 3) {
        failureSamples.push(`${symbol}: ${category} (${safeQuoteFailure(reason)})`);
      }
    }
    if (failed.length > 0) {
      console.warn(
        `[screenerPipeline] ${quoteProviderName} quote failures: ${failed.length}/${limited.length}. ` +
          `Reasons: ${JSON.stringify(failureReasons)}. Samples: ${failureSamples.join("; ")}`
      );
    }
    const reasonSummary = Object.entries(failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    if (quotes.length === 0 && failed.length > 0) {
      // Issue #462: with zero quotes there is no screen to qualify — fail
      // honestly with the full diagnostics. (A partial set, by contrast,
      // returns qualified results below instead of failing.)
      // Issue #902/#907: if ANY auth failures occurred and no quotes were
      // returned, the root cause is auth (batch-omitted are secondary to the
      // auth failure). Throw BusinessError with FAILURE_AUTH_TOKEN_EXPIRED instead of the
      // technical "OAuth access token is missing".
      const authFailures = failureReasons["auth"] ?? 0;
      // Issue #3655: FAILURE_AUTH_TOKEN_EXPIRED is the E*TRADE OAuth
      // code — an Alpaca run with auth failures falls through to the
      // generic provider-unavailable error below, which names Alpaca.
      if (authFailures > 0 && !isAlpacaQuotes) {
        const { BusinessError } = await import("../outcomes/outcomeAspects");
        throw new BusinessError("FAILURE_AUTH_TOKEN_EXPIRED", { failedCount: failed.length, authFailures });
      }
      throw new Error(
        `${quoteProviderName} unavailable: no live quotes returned (${quotes.length} of ${limited.length} symbols quoted` +
          (failed.length > 0 ? ` (failed: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : "") +
          (reasonSummary ? ` (failure reasons: ${reasonSummary})` : "") +
          (failureSamples.length > 0 ? ` (diagnostics: ${failureSamples.join("; ")})` : "") +
          `). No fallback data substituted.`
      );
    }
    const partial: PartialQuoteQualification | undefined =
      failed.length > 0
        ? {
            quotedCount: quotes.length,
            requestedCount: limited.length,
            failedSymbols: failed,
            failureReasons,
            failureSamples,
          }
        : undefined;
    return {
      quotes,
      provider: quoteProviderId,
      ...(partial ? { partial } : {}),
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message: partial
          ? `Partial screen — qualified results: ${quoteProviderName} quoted ${quotes.length} of ${limited.length} symbols ` +
            `(${failed.length} unavailable: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}` +
            (reasonSummary ? `; failure reasons: ${reasonSummary}` : "") +
            `). Screen ran on the quoted subset only; no fallback data substituted.`
          : `${quoteProviderName}-only live quotes; ${quotes.length} of ${limited.length} symbols quoted.`,
      },
    };
  }

  // all-listings mode. Production membership always comes from the live
  // listings directory; test fixtures are only used by explicit tests.
  const sourceCounts: Record<string, number> = {};
  let listings: NasdaqStockListing[];
  try {
    listings =
      DynamicMarketScreener.getTestListingsFixture() ??
      (await resolveAllListings(opts));
    if (!DynamicMarketScreener.getTestListingsFixture() && (!listings || listings.length === 0)) {
      throw new Error("The live listings directory returned no symbols; no static universe was substituted.");
    }
  } catch (error) {
    if (
      DynamicMarketScreener.getTestListingsFixture() !== null &&
      DynamicMarketScreener.getTestListingsFixture() !== undefined
    ) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        quotes: [],
        discovery: {
          mode: "all_us_listings",
          candidateCount: 0,
          listingCount: 0,
          sourceCounts,
          message: `Dynamic all-exchange listing request failed: ${message}`,
          error: message,
        },
        error: message,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      quotes: [],
      discovery: {
        mode: "all_us_listings",
        candidateCount: 0,
        listingCount: 0,
        sourceCounts,
        message: `Dynamic all-exchange listing request failed: ${message}; no static universe was substituted.`,
        error: message,
      },
      error: message,
    };
  }

  for (const listing of listings)
    sourceCounts[listing.exchange] = (sourceCounts[listing.exchange] || 0) + 1;
  sourceCounts.uniqueListings = listings.length;
  let selectedListings =
    opts.exchange && opts.exchange !== "ALL"
      ? listings.filter(
          (listing) => listing.exchange.toUpperCase() === opts.exchange
        )
      : listings;
  // This non-E*TRADE discovery view displays the listings feed's last sale as
  // its price. Keep symbol-only rows for universe resolution elsewhere, but do
  // not render a made-up zero-price quote in this view.
  selectedListings = selectedListings.filter(
    (listing) => typeof listing.lastPrice === "number" && listing.lastPrice > 0
  );
  if (
    selectedListings.length === 0 &&
    !DynamicMarketScreener.getTestListingsFixture()
  ) {
    selectedListings = listings;
  }
  sourceCounts.selectedListings = selectedListings.length;
  if (selectedListings.length === 0) {
    // Valid empty result (not a failure): screenLive returns the discovery
    // message with an empty screen. No top-level error set.
    const message =
      listings.length === 0
        ? "Dynamic all-exchange listing request returned no rows from Nasdaq, NYSE, or AMEX."
        : `No dynamic listings were returned for ${opts.exchange}; ${listings.length.toLocaleString()} rows were loaded across all exchanges.`;
    return {
      quotes: [],
      discovery: {
        mode: "all_us_listings",
        candidateCount: 0,
        listingCount: 0,
        sourceCounts,
        message,
      },
    };
  }

  const quotes: ETradeQuote[] = selectedListings.map((listing) => {
    const listingPrice = listing.lastPrice!; // selectedListings excludes missing last-sale values above
    const sector =
      listing.sector ||
      inferSectorFromCompanyName(listing.companyName);
    return {
      symbol: listing.symbol,
      companyName: listing.companyName,
      listingExchange: listing.exchange.toUpperCase(),
      lastPrice: listingPrice,
      price: listingPrice,
      change: listing.change,
      changePercent: listing.changePercent,
      bid: 0,
      ask: 0,
      volume: 0,
      open: 0,
      high: 0,
      low: 0,
      marketCap: listing.marketCap,
      week52High: 0,
      week52Low: 0,
      sector,
      quoteStatus: "AS_OF_UNKNOWN",
      source: "Nasdaq all-exchange stock listings (source quote time unavailable)",
      timestamp: "",
    };
  });

  const message = `Loaded ${listings.length.toLocaleString()} current listings from Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters. Source quote timestamps are unavailable.`;

  return {
    quotes,
    discovery: {
      mode: "all_us_listings",
      candidateCount: selectedListings.length,
      listingCount: quotes.length,
      sourceCounts,
      message,
    },
  };
}

// ---------------------------------------------------------------------------
// Screening — shared by both triggers.
// ---------------------------------------------------------------------------

export function screenUniverse(
  screener: DynamicMarketScreener,
  acquired: AcquiredUniverse,
  filter: StockScreenerFilter = {}
): StockScreenResult {
  return screener.screenWithQuotes(acquired.quotes, filter, false);
}

// ---------------------------------------------------------------------------
// Result shaping — single implementations, used by every consumer.
// ---------------------------------------------------------------------------

/**
 * Map one quote (+ optional screened fields) to the serializable shape.
 * The ONLY place this mapping lives.
 */
export function toScannedStock(
  quote: Pick<
    ETradeQuote,
    | "symbol"
    | "companyName"
    | "lastPrice"
    | "changePercent"
    | "source"
    | "open"
    | "high"
    | "low"
    | "week52High"
    | "week52Low"
    | "peRatio"
    | "volume"
    | "averageVolume"
    | "sector"
  >,
  screened?: Pick<ScreenedStockItem, "signal" | "momentumScore" | "rsi14"> | null
): ScannedStock {
  const ind = computeScreeningIndicators({
    lastPrice: quote.lastPrice || 0,
    changePercent: quote.changePercent || 0,
    open: quote.open || 0,
    high: quote.high || 0,
    low: quote.low || 0,
    week52High: quote.week52High || 0,
    week52Low: quote.week52Low || 0,
    peRatio: quote.peRatio,
    volume: quote.volume || 0,
    averageVolume: quote.averageVolume,
  });
  return {
    symbol: quote.symbol,
    companyName: quote.companyName || quote.symbol,
    signal: screened?.signal || "unknown",
    momentumScore: screened?.momentumScore ?? 0,
    lastPrice: quote.lastPrice || 0,
    changePercent: quote.changePercent || 0,
    rsi14: screened?.rsi14 ?? null,
    source: quote.source || "unknown",
    indicators: {
      sentiment: ind.sentiment,
      directional: ind.directional,
      rangeZone: ind.rangeZone,
      valueZone: ind.valueZone,
      screenScore: ind.screenScore,
      intradayPosition: ind.intradayPosition,
      rangePosition: ind.rangePosition,
      summary: ind.summary,
    },
    // Issue #266: default grades; attachFactorGrades() replaces with the
    // universe-relative computation.
    factorGrades: EMPTY_GRADES,
    // Issue #269: default technicals; attachTechnicals() fills from Yahoo.
    technicals: EMPTY_TECHNICALS,
    peRatio: quote.peRatio ?? null,
    sector: resolveStockSector(quote.symbol, quote.companyName, quote.sector),
  };
}

/** Empty technicals — Yahoo history unavailable or not yet fetched. */
export const EMPTY_TECHNICALS: StockTechnicals = {
  rsi14: null,
  macdLine: null,
  macdSignalLine: null,
  macdHistogram: null,
  macdSignal: null,
  atr14: null,
  gapPercent: null,
  gapDirection: null,
  historyBars: 0,
  historySource: null,
};

/**
 * Attach Yahoo technicals (issue #269). Returns new objects; input unmutated.
 * Symbols missing from the map keep EMPTY_TECHNICALS (honest, not zeroed).
 */
export function attachTechnicals(
  stocks: ScannedStock[],
  technicalsBySymbol: Map<string, YahooTechnicals>
): ScannedStock[] {
  return stocks.map((s) => {
    const t = technicalsBySymbol.get(s.symbol);
    if (!t) return s;
    return {
      ...s,
      // Real RSI from Yahoo history supersedes the (usually null) snapshot RSI.
      rsi14: t.rsi14 ?? s.rsi14,
      technicals: {
        rsi14: t.rsi14,
        macdLine: t.macdLine,
        macdSignalLine: t.macdSignalLine,
        macdHistogram: t.macdHistogram,
        macdSignal: t.macdSignal,
        atr14: t.atr14,
        gapPercent: t.gapPercent,
        gapDirection: t.gapDirection,
        historyBars: t.barsUsed,
        historySource: t.source,
      },
    };
  });
}

/**
 * Attach SA-style factor grades (issue #266), computed percentile-relative
 * across the given universe. Returns new objects; input is not mutated.
 */
export function attachFactorGrades(stocks: ScannedStock[]): ScannedStock[] {
  const gradeable: GradeableStock[] = stocks.map((s) => ({
    symbol: s.symbol,
    sector: s.sector,
    peRatio: s.peRatio ?? null,
    rangePosition: s.indicators.rangePosition,
    changePercent: s.changePercent,
    intradayPosition: s.indicators.intradayPosition,
    screenScore: s.indicators.screenScore,
  }));
  const grades = computeFactorGrades(gradeable);
  return stocks.map((s) => ({
    ...s,
    factorGrades: grades.get(s.symbol) ?? EMPTY_GRADES,
  }));
}

/** Map one screened stock to the opportunity shape. The ONLY place. */
export function toOpportunityStock(s: ScreenedStockItem): OpportunityStock {
  const scanned = toScannedStock(
    {
      symbol: s.symbol,
      companyName: s.companyName,
      lastPrice: s.lastPrice,
      changePercent: s.changePercent,
      source: (s as any).source,
      open: (s as any).open ?? 0,
      high: (s as any).high ?? 0,
      low: (s as any).low ?? 0,
      week52High: (s as any).week52High ?? 0,
      week52Low: (s as any).week52Low ?? 0,
      peRatio: (s as any).peRatio,
      volume: (s as any).volume ?? 0,
      averageVolume: (s as any).averageVolume,
      sector: (s as any).sector,
    },
    s
  );
  return {
    symbol: scanned.symbol,
    companyName: scanned.companyName,
    signal: scanned.signal,
    momentumScore: scanned.momentumScore,
    lastPrice: scanned.lastPrice,
    changePercent: scanned.changePercent,
    indicators: scanned.indicators,
    factorGrades: scanned.factorGrades,
    technicals: scanned.technicals,
  };
}

/**
 * Standout filter — the ONLY place this predicate lives.
 * (OVERSOLD_BOUNCE / BULLISH_MOMENTUM / momentumScore >= 60, top N.)
 */
export function selectStandouts(
  stocks: ScreenedStockItem[],
  maxItems = 5
): ScreenedStockItem[] {
  return stocks
    .filter(
      (s) =>
        s.signal === "OVERSOLD_BOUNCE" ||
        s.signal === "BULLISH_MOMENTUM" ||
        s.momentumScore >= 60
    )
    .slice(0, maxItems);
}

/**
 * Full scanned set: every acquired quote, enriched with screened fields
 * where the symbol survived filtering. Backs the panel's "all scanned"
 * table (#253).
 */
export function buildAllStocks(
  quotes: ETradeQuote[],
  screened: ScreenedStockItem[]
): ScannedStock[] {
  const screenedBySymbol = new Map(screened.map((s) => [s.symbol, s]));
  return quotes.map((q) => toScannedStock(q, screenedBySymbol.get(q.symbol) ?? null));
}
