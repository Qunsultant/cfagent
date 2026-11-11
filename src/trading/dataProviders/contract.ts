/**
 * Issue #1118 (P1 of epic #1116): the DataProvider plugin contract.
 *
 * Before this module, provider identity existed in three incompatible
 * vocabularies — `StockScreenProvider = "etrade" | "yahoo"`, the market-data
 * ids `"yfinance" | "alpaca" | "hybrid"`, and the #1103 ScreeningProvider
 * ids `"etrade-yahoo-stocks" | "dynamic-options"` — provider composition
 * was hardcoded at each call site (MarketDataResearchService constructs its
 * providers inline; E*TRADE is constructed at 57 data-path sites), and
 * no module could name "the provider that serves capability X" at all.
 *
 * This contract is the ONE vocabulary (epic #1116; the provider set and
 * precedence are the owner's decision, comment 6358627401 on #1116):
 *
 *   ids:          etrade | public | yahoo | nasdaq | alpaca
 *   capabilities: quotes | optionsChains | screenUniverse |
 *                 historicalBars | fundamentals | news
 *
 * Normalized shapes consolidate the existing interfaces rather than
 * inventing new DTOs: quotes are the two quote shapes the codebase
 * already normalizes to (ETradeQuote for the E*TRADE/pipeline side,
 * MarketDataResearchQuote for the market-data side); chains are ETradeOptionChain; the
 * screen universe is NasdaqStockListing[] (nasdaqListings is the
 * universe-membership source); bars and fundamentals are the market-data
 * shapes. Adapters return the wrapped implementations' results
 * UNCHANGED (parity pinned, the #1103 adapter method) — consolidation
 * here names the shapes under one contract; it does not convert between
 * them. `news` was contract-only until #3932 (sub-issue of
 * #3929): the Yahoo adapter now declares it, served by the
 * Yahoo News search feed (`v1/finance/search`, the same feed
 * #132's fetchRealMarketNews reads) — see
 * `fetchYahooNewsArticles` in adapters.ts. No other adapter
 * declares news yet.
 *
 * Composition + provenance (owner correction, comment 6358714200 on
 * #1116): screening does not pick one winning provider — it COMPOSES
 * several in a single run (today: Nasdaq universe + Yahoo bars and
 * quote gap-fill + E*TRADE quotes/chains). Two consequences live here
 * and in the registry/store:
 *
 *   1. Every result travels in a DataResult envelope tagging the
 *      provider that supplied it and the capability it served — the
 *      #1103 provenance-tagging idiom, at element level: because one
 *      provider call returns one provider's data, the envelope on the
 *      call attributes every element in it. When a run composes
 *      providers, each element keeps the tag of the call that fetched
 *      it. (MarketDataResearchQuote also carries a legacy per-quote `provider` field
 *      in the market-data vocabulary; the envelope's platform id is the
 *      authoritative provenance.)
 *   2. WHICH providers compose a run is capability ROUTING — a
 *      per-capability primary plus an optional declared gap-fill —
 *      stored in the config store (providerConfigStore.ts) and
 *      resolved by the registry (registry.ts). The precedence order
 *      above remains only as the default where no route is declared
 *      and as the overlap-resolution order within routing.
 *
 * A provider declares the capabilities it serves; methods for
 * undeclared capabilities are absent (ISP, mirroring
 * IMarketDataProvider's optional getMarketSnapshot). The registry
 * (registry.ts) resolves capabilities against the provider-config store
 * (providerConfigStore.ts) — declared here, enforced there.
 */

import type {
  Env,
  ETradeQuote,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  MarketDataResearchQuote,
  MarketDataResearchHistoricalBar,
  MarketDataResearchCompanyFundamentals,
} from "../../types";
import type { NasdaqStockListing } from "../../services/nasdaqListings";

/** The five owner-set provider ids, in owner precedence order. */
export const DATA_PROVIDER_IDS = [
  "etrade",
  "public",
  "yahoo",
  "nasdaq",
  "alpaca",
] as const;
export type DataProviderId = (typeof DATA_PROVIDER_IDS)[number];

/**
 * Issue #3990 — the taxonomy split. A data provider is either a
 * BROKER (etrade, public, alpaca: quote data AND trading — a broker
 * may also be a data source, registered with its declared
 * capabilities) or PURE (yahoo, nasdaq: symbols, delayed quotes,
 * technicals, fundamentals, sentiment — no trading). The two lists
 * are derived from this map, never hand-maintained twice: a sixth
 * provider adds one line here and appears in exactly one list.
 */
export type DataProviderKind = "broker" | "pure";
export const DATA_PROVIDER_KINDS: Record<DataProviderId, DataProviderKind> = {
  etrade: "broker",
  public: "broker",
  yahoo: "pure",
  nasdaq: "pure",
  alpaca: "broker",
} as const;
export const BROKER_DATA_PROVIDER_IDS = DATA_PROVIDER_IDS.filter(
  (id) => DATA_PROVIDER_KINDS[id] === "broker",
);
export const PURE_DATA_PROVIDER_IDS = DATA_PROVIDER_IDS.filter(
  (id) => DATA_PROVIDER_KINDS[id] === "pure",
);

/** The capability vocabulary every provider declares from. */
export const DATA_PROVIDER_CAPABILITIES = [
  "quotes",
  "optionsChains",
  "screenUniverse",
  "historicalBars",
  "fundamentals",
  "news",
] as const;
export type DataProviderCapability = (typeof DATA_PROVIDER_CAPABILITIES)[number];

/**
 * Offering tiers (E5, issue #1202). A capability ROUTE carries the
 * minimum tier a caller must present to be served through it
 * (CapabilityRouteRecord.minTier); entry points present the tier of
 * the surface they serve — the in-app surfaces are freemium, the
 * x402 premium API is premium. "freemium" is the default everywhere:
 * an untiered route serves every caller, exactly as before E5.
 */
export const TIERS = ["freemium", "premium"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return value === "freemium" || value === "premium";
}

/** quotes — the two existing normalized quote shapes (see header). */
export type QuoteResult = ETradeQuote | MarketDataResearchQuote;

/**
 * optionsChains request — consolidates the parameter shape
 * ETradeService.getOptionChains already accepts.
 */
export interface OptionsChainRequest {
  symbol: string;
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
  noOfStrikes?: number;
  includeWeekly?: boolean;
  chainType?: "CALL" | "PUT" | "CALLPUT";
}

/** optionsChains — the E*TRADE chain shape; null = provider has no chain for the request. */
export type OptionsChainResult = ETradeOptionChain | null;

/**
 * Issue #3990: the options-chains source a market-data adapter serves
 * through, injected like the news fetcher (ISP — a provider implements
 * exactly the capabilities it declares). The Alpaca adapter's source
 * is built from src/trading/alpaca/optionsData.ts; tests inject a stub.
 * Both halves travel together: chains and their expiry calendar are
 * one capability (contract comment on getOptionExpiryDates).
 */
export interface OptionsChainSource {
  getChain(
    request: OptionsChainRequest,
    runContext?: DataRunContext,
    requestBudget?: import("../interfaces").OptionRequestBudget
  ): Promise<OptionsChainResult>;
  getExpiryDates(
    symbol: string,
    runContext?: DataRunContext,
    requestBudget?: import("../interfaces").OptionRequestBudget
  ): Promise<ETradeOptionExpireDate[]>;
}

/** screenUniverse — listed-stock universe membership (nasdaqListings shape). */
export type ScreenUniverseResult = NasdaqStockListing[];

/** historicalBars — the market-data bar shape (Yahoo/Alpaca). */
export type HistoricalBarsResult = MarketDataResearchHistoricalBar[];

/** fundamentals — the market-data company-fundamentals shape (Yahoo/Alpaca). */
export type FundamentalsResult = MarketDataResearchCompanyFundamentals;

/**
 * news — the minimal normalized article the platform requires
 * of any news provider. #3932: served by the Yahoo adapter
 * (fetchYahooNewsArticles in adapters.ts, over the Yahoo News
 * search feed); the conformance kit probes headline + publishedAt.
 */
export interface DataNewsArticle {
  headline: string;
  source: string;
  publishedAt: string;
  symbol?: string;
  url?: string;
  summary?: string;
}
export type NewsResult = DataNewsArticle[];

/**
 * The provenance envelope every capability result travels in: the
 * wrapped implementation's result object, BY REFERENCE (parity is
 * preserved — the envelope wraps, never copies or converts), tagged
 * with the platform provider id and the capability served.
 */
export interface DataResult<T> {
  readonly providerId: DataProviderId;
  readonly capability: DataProviderCapability;
  readonly result: T;
}

/**
 * Run context for a platform-routed fetch (E1, issue #1133): the run
 * the fetch belongs to, and the tenant/user scope it executes under.
 * Every field is optional for the caller — capture (captureStore.ts)
 * resolves a missing runId to a generated collection-run id and a
 * missing tenant to "default", so a fetch through the platform is
 * always attributable to exactly one run and one tenant scope, and no
 * platform-routed fetch goes uncaptured for want of a caller-supplied
 * context.
 */
export interface DataRunContext {
  runId?: string;
  tenantId?: string;
  userLogin?: string;
}

/**
 * The plugin contract. A provider implements the methods for exactly
 * the capabilities it declares in `capabilities`; the conformance kit
 * (conformance.ts) fails a provider that declares a capability whose
 * method is missing, whose envelope mislabels the serving provider,
 * or whose payload returns a non-conformant shape.
 *
 * Each method takes an optional trailing DataRunContext (E1): the
 * attribution capture writes against. Adapters that do not capture
 * (yet) accept and ignore it.
 */
export interface DataProvider {
  readonly id: DataProviderId;
  readonly name: string;
  readonly capabilities: readonly DataProviderCapability[];
  /** Mirrors IMarketDataProvider: is this provider usable as configured? */
  isConfigured(env?: Env): boolean;
  getQuote?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<QuoteResult>>;
  /**
   * quotes, batch form (E2, issue #1157): many symbols in the
   * provider's own batching (E*TRADE: one request per ≤10 symbols —
   * the #495 subrequest/rate-limit discipline the stock screener
   * depends on). Optional like every capability method: a provider
   * implements it only if it declares batch-capable quotes. The
   * result is the provider's normalized quotes, in request order
   * per sub-batch, with no raw payload attached — raw wire responses
   * live in the capture store, one record per sub-batch. Issue
   * #1317: the element type is QuoteResult (the union), not
   * ETradeQuote alone — the market-data adapters' batch returns MarketDataResearchQuote
   * rows, and narrowing the contract to E*TRADE's shape would force
   * the yahoo binding to convert (breaking P1 parity) or to drop
   * batching (repeating the #1184 throttle incident).
   */
  getQuotesBatch?(
    symbols: string[],
    runContext?: DataRunContext
  ): Promise<DataResult<QuoteResult[]>>;
  getOptionsChain?(
    request: OptionsChainRequest,
    runContext?: DataRunContext,
    requestBudget?: import("../interfaces").OptionRequestBudget
  ): Promise<DataResult<OptionsChainResult>>;
  /**
   * optionsChains, expiry-dates form (E2, issue #1157): the
   * expiration calendar for one symbol — the other half of what the
   * options engines consume alongside chains (DynamicOptionsScreener
   * calls the client's getOptionExpireDates before getOptionChains).
   * Declared under the optionsChains capability, not a capability of
   * its own: it is chain-shaped metadata from the same source.
   * Optional on the interface so providers that serve chains without
   * a separate expiry endpoint (and the market-data adapters, which declare
   * no optionsChains at all) are undisturbed.
   */
  getOptionExpiryDates?(
    symbol: string,
    runContext?: DataRunContext,
    requestBudget?: import("../interfaces").OptionRequestBudget
  ): Promise<DataResult<ETradeOptionExpireDate[]>>;
  getScreenUniverse?(
    runContext?: DataRunContext
  ): Promise<DataResult<ScreenUniverseResult>>;
  getHistoricalBars?(
    symbol: string,
    timeframe?: string,
    limit?: number,
    runContext?: DataRunContext
  ): Promise<DataResult<HistoricalBarsResult>>;
  getFundamentals?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<FundamentalsResult>>;
  getNews?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<NewsResult>>;
}
