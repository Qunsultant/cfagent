/**
 * Issue #1098 (Phase 0 of epic #1096): unified ScreeningProvider contract.
 *
 * Stock screening (E*TRADE/Yahoo pipeline behind DynamicMarketScreener,
 * which implements IMarketScreener) and options screening
 * (DynamicOptionsScreener.screenOptions) previously had no shared
 * contract: goal/scenario-driven screening (Phase 1+) had nothing uniform
 * to build on. This module wraps — never rewrites — both screeners behind
 * one discriminated request/result contract and a registry.
 *
 * Semantics that differ deliberately from TradingPlatformRegistry:
 *  - Resolution fails EXPLICITLY (ScreeningProviderNotFoundError) when no
 *    provider serves an asset class. (TradingPlatformRegistry likewise
 *    throws for an unregistered id since #3460; for screening a silent
 *    fallback would mislabel provenance — a stock result must never be
 *    returned for an options request.)
 *  - Provider ids are unique in a registry: re-registering an id throws,
 *    so provenance ids stay unambiguous.
 *
 * Providers return the wrapped screener's result object unchanged; the
 * wrapper only tags it with the provider id and asset class.
 */

import type {
  StockScreenerFilter,
  StockScreenResult,
  OptionScreenerFilter,
  OptionScreenResult,
} from "../types";
import type { IMarketScreener } from "./interfaces";
import { NeutralMarketScreener } from "./neutralMarketScreener";
import type { DynamicOptionsScreener } from "./optionsScreener";

export type ScreeningProviderAssetClass = "stocks" | "options";

/* ------------------------------------------------------------------ */
/* Provider descriptors — the ONE registry source (consolidation C1,   */
/* issue #1201, epic #1151 R2).                                        */
/*                                                                     */
/* Before C1 the providers were described twice: here (the runtime     */
/* registry) and by hand in src/client/screeningAdapters.ts            */
/* (SCREENING_PROVIDERS), and the two had already drifted in shape:     */
/* the client listed two stock "providers" (etrade, yahoo-finance)     */
/* that are in fact route variants of the ONE stock provider below     */
/* (the Yahoo entry is the #1007 data-source adapter inside the one     */
/* ScreenerAgent pipeline, reached via /api/market-data/screen).              */
/*                                                                     */
/* This table is now the single source: the runtime registry is built  */
/* under these ids, and the client adapter DERIVES its provider list   */
/* from the clientEndpoints variants declared here (imported through   */
/* the trading barrel, the #290 boundary surface). A parity test pins   */
/* descriptor table ↔ registry.list(), and a drift pin fails if the     */
/* client declares provider endpoints by hand again.                   */
/* ------------------------------------------------------------------ */

/** Filter capability vocabulary the hub form can ask a provider about. */
export type ScreeningFilter =
  | "search"
  | "limit"
  | "exchange"
  | "price-range"
  | "trend"
  | "contract-type"
  | "dte-range"
  | "min-volume"
  | "min-open-interest"
  | "max-spread";

export type ScreeningProviderKind = "broker-api" | "market-data-api" | "mcp";

/** A client-selectable endpoint variant of a registry provider. */
export interface ScreeningProviderEndpointVariant {
  id: string;
  label: string;
  kind: ScreeningProviderKind;
  endpoint: string;
  filters: readonly ScreeningFilter[];
}

export interface ScreeningProviderDescriptor {
  /** Registry provider id (the provenance id stamped on results). */
  id: string;
  label: string;
  kind: ScreeningProviderKind;
  assetClasses: readonly ScreeningProviderAssetClass[];
  /** The production route that executes this provider, per asset class. */
  routes: Partial<Record<ScreeningProviderAssetClass, string>>;
  /**
   * Endpoint variants the client may offer for this provider, per
   * asset class. The options provider declares none: the hub's options
   * tab is the options research surface, not the adapter-driven form
   * (the #958 S8 design), so getScreeningProviders("options") stays
   * empty — by derivation now, not by a second hand-kept list.
   */
  clientEndpoints: Partial<
    Record<ScreeningProviderAssetClass, readonly ScreeningProviderEndpointVariant[]>
  >;
}

export const STOCK_SCREENING_PROVIDER_ID = "etrade-yahoo-stocks";
export const NEUTRAL_STOCK_SCREENING_PROVIDER_ID = "broker-neutral-stocks";
export const OPTIONS_SCREENING_PROVIDER_ID = "dynamic-options";

const STOCK_PROVIDER_FILTERS: readonly ScreeningFilter[] = [
  "search",
  "limit",
  "exchange",
  "price-range",
  "trend",
];

export const SCREENING_PROVIDER_DESCRIPTORS: readonly ScreeningProviderDescriptor[] = [
  {
    id: STOCK_SCREENING_PROVIDER_ID,
    label: "E*TRADE / Yahoo stock screening pipeline",
    kind: "broker-api",
    assetClasses: ["stocks"],
    routes: { stocks: "/api/etrade/screen" },
    clientEndpoints: {
      stocks: [
        {
          id: "etrade",
          label: "Nasdaq All-Exchange Listing Feed (Live API · E*TRADE Execution)",
          kind: "broker-api",
          endpoint: "/api/etrade/screen",
          filters: STOCK_PROVIDER_FILTERS,
        },
        {
          id: "yahoo-finance",
          label: "Yahoo Finance Engine (Market Data API)",
          kind: "market-data-api",
          endpoint: "/api/market-data/screen",
          filters: STOCK_PROVIDER_FILTERS,
        },
      ],
    },
  },
  {
    id: OPTIONS_SCREENING_PROVIDER_ID,
    label: "Dynamic Options Screener",
    kind: "broker-api",
    assetClasses: ["options"],
    routes: { options: "/trading/options/screen" },
    clientEndpoints: {},
  },
  {
    // Issue #3272: the same screening math over the SELECTED broker quotes.
    // The universe is explicit via filter.universe; no broker context is a
    // named refusal, never an empty result.
    id: NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
    label: "Selected broker quotes (neutral stock screen)",
    kind: "broker-api",
    assetClasses: ["stocks"],
    routes: { stocks: "/api/broker/screen" },
    clientEndpoints: {
      stocks: [
        {
          id: "selected-broker",
          label: "Selected broker quotes (explicit universe)",
          kind: "broker-api",
          endpoint: "/api/broker/screen",
          filters: STOCK_PROVIDER_FILTERS,
        },
      ],
    },
  },
];

export type ScreeningRequest =
  | { assetClass: "stocks"; filter?: StockScreenerFilter; providerId?: string }
  | { assetClass: "options"; filter?: OptionScreenerFilter; providerId?: string };

export type ScreeningResult =
  | { assetClass: "stocks"; providerId: string; result: StockScreenResult }
  | { assetClass: "options"; providerId: string; result: OptionScreenResult };

export interface ScreeningProvider {
  readonly id: string;
  readonly assetClasses: readonly ScreeningProviderAssetClass[];
  screen(request: ScreeningRequest): Promise<ScreeningResult>;
}

export class ScreeningProviderNotFoundError extends Error {
  readonly assetClass: ScreeningProviderAssetClass;
  constructor(assetClass: ScreeningProviderAssetClass) {
    super(`No screening provider registered for asset class "${assetClass}".`);
    this.name = "ScreeningProviderNotFoundError";
    this.assetClass = assetClass;
  }
}

function assertServes(providerId: string, served: ScreeningProviderAssetClass, requested: ScreeningProviderAssetClass): void {
  if (served !== requested) {
    throw new Error(
      `Screening provider "${providerId}" does not serve asset class "${requested}" (it serves "${served}").`
    );
  }
}

/** Wrap a stock screener (IMarketScreener — DynamicMarketScreener over the E*TRADE/Yahoo pipeline). */
export function createStockScreeningProvider(id: string, screener: IMarketScreener): ScreeningProvider {
  return {
    id,
    assetClasses: ["stocks"] as const,
    async screen(request: ScreeningRequest): Promise<ScreeningResult> {
      assertServes(id, "stocks", request.assetClass);
      const filter = request.assetClass === "stocks" ? request.filter : undefined;
      const result = await screener.screenMarkets(filter);
      return { assetClass: "stocks", providerId: id, result };
    },
  };
}

/** Wrap the dynamic options screener (DynamicOptionsScreener.screenOptions). */
export function createOptionsScreeningProvider(
  id: string,
  screener: Pick<DynamicOptionsScreener, "screenOptions">
): ScreeningProvider {
  return {
    id,
    assetClasses: ["options"] as const,
    async screen(request: ScreeningRequest): Promise<ScreeningResult> {
      assertServes(id, "options", request.assetClass);
      const filter = request.assetClass === "options" ? request.filter : undefined;
      const result = await screener.screenOptions(filter);
      return { assetClass: "options", providerId: id, result };
    },
  };
}

/**
 * Issue #3460: the fail-closed options screener for a tenant whose
 * selected broker's platform has no options chain source. Both entry
 * points throw `provider_unsupported` naming the broker — never a
 * result, never another broker's data. The throw is deliberate: the
 * options leg has no chain source at all, so there is nothing to
 * evaluate, and the failure must surface visibly (a failed leg/run,
 * not a silent wrong result). Stocks-only goals never touch this
 * screener, so they proceed untouched.
 */
export function createRefusingOptionsScreener(
  brokerId: string,
): Pick<DynamicOptionsScreener, "screenOptions" | "fetchChains"> {
  const refusal = (): Error =>
    new Error(
      `provider_unsupported: broker "${brokerId}" does not provide an options chain source (no getOptionChains/getOptionExpireDates); no other broker's data is used in its place.`,
    );
  return {
    async screenOptions(): Promise<OptionScreenResult> {
      throw refusal();
    },
    async fetchChains(): Promise<
      Awaited<ReturnType<DynamicOptionsScreener["fetchChains"]>>
    > {
      throw refusal();
    },
  };
}

export class ScreeningProviderRegistry {
  private providers = new Map<string, ScreeningProvider>();

  register(provider: ScreeningProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Screening provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ScreeningProvider | undefined {
    return this.providers.get(id);
  }

  list(): ScreeningProvider[] {
    return Array.from(this.providers.values());
  }

  /** First registered provider serving the asset class; throws ScreeningProviderNotFoundError when none does. */
  resolve(assetClass: ScreeningProviderAssetClass): ScreeningProvider {
    for (const provider of this.providers.values()) {
      if (provider.assetClasses.includes(assetClass)) return provider;
    }
    throw new ScreeningProviderNotFoundError(assetClass);
  }

  /** Issue #3272: a run may name the engine that served it, so the result
   *  is labelled with that provider instead of whichever registered first. */
  async screen(request: ScreeningRequest): Promise<ScreeningResult> {
    if (request.providerId) {
      const named = this.get(request.providerId);
      if (!named) throw new Error(`Unknown screening provider "${request.providerId}".`);
      return named.screen(request);
    }
    return this.resolve(request.assetClass).screen(request);
  }
}

/**
 * Default wiring under the descriptor table's provenance ids
 * (SCREENING_PROVIDER_DESCRIPTORS): the E*TRADE/Yahoo stock pipeline
 * and the dynamic options screener.
 */
export function createDefaultScreeningRegistry(deps: {
  stockScreener: IMarketScreener;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
  /** Issue #3272: the broker-neutral stock screen. Omitted callers get one
   *  that refuses with a named reason instead of reporting "no matches". */
  neutralStockScreener?: IMarketScreener;
}): ScreeningProviderRegistry {
  const registry = new ScreeningProviderRegistry();
  registry.register(createStockScreeningProvider(STOCK_SCREENING_PROVIDER_ID, deps.stockScreener));
  registry.register(createOptionsScreeningProvider(OPTIONS_SCREENING_PROVIDER_ID, deps.optionsScreener));
  // Issue #3272: always registered, so the descriptor table and this registry
  // can never disagree about which providers exist.
  registry.register(
    createStockScreeningProvider(
      NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
      deps.neutralStockScreener ?? new NeutralMarketScreener(),
    ),
  );
  return registry;
}
