/**
 * Issue #3272 (S1, programme #3216): the option chain source port.
 *
 * Why this exists: screening is provider-side by policy (`marketScreening:
 * false` for Alpaca in `BROKER_CATALOG`), yet `DynamicOptionsScreener` was
 * constructed with an `ETradeRestClient`. The dependency was a *type*, not a
 * need — `ETradeOptionChain` is already an alias of `BrokerOptionChain`
 * (#3232), and `ITradingPlatform.getOptionChains/getOptionExpireDates` already
 * carry the same signatures, budget included.
 *
 * So the screwdriver, not the screw: a source is anything that can answer
 * "chains for this underlying" and "expiries for this underlying". A broker
 * platform satisfies it. An E*TRADE client satisfies it. A test double
 * satisfies it. The screener never learns which one it holds, and adding a
 * third broker changes nothing here.
 *
 * Honesty rules:
 *   - `platformChainSource` returns null when the platform has no options data
 *     plane; the caller must answer `provider_unsupported`, never an empty
 *     result.
 *   - nothing here caches, retries, or rewrites provenance. The port is a
 *     passthrough, exactly like the platform methods it adapts.
 */
import type { BrokerOptionChain, BrokerOptionExpireDate } from "../types";
import type { ITradingPlatform, OptionRequestBudget } from "./interfaces";

/** The parameters a chain fetch accepts — a subset of `ITradingPlatform`. */
export interface OptionChainParams {
  symbol: string;
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
  noOfStrikes?: number;
  includeWeekly?: boolean;
  chainType?: "CALL" | "PUT" | "CALLPUT";
  includeRawResponse?: boolean;
}

/**
 * What the screener needs. Every member beyond the two fetch methods is
 * optional, so a broker platform (which exposes `getLastError()` rather than a
 * `lastError` field) adapts without pretending to have client state.
 */
export interface OptionChainSource {
  getOptionChains(params: OptionChainParams, requestBudget?: OptionRequestBudget): Promise<BrokerOptionChain | null>;
  getOptionExpireDates(
    symbol: string,
    expiryType?: string,
    requestBudget?: OptionRequestBudget,
  ): Promise<BrokerOptionExpireDate[]>;
  /** True when the source meters outbound calls; the screener then passes a budget. */
  readonly supportsOptionRequestBudget?: boolean;
  /** The last error recorded by the same instance that made the call. */
  readonly lastError?: string;
  /** Deployment env, used only to resolve screener config defaults. */
  readonly env?: unknown;
  readonly overrideEnv?: string;
}

/** Structural guard: a source is exactly "can fetch chains and expiries". */
export function isOptionChainSource(candidate: unknown): candidate is OptionChainSource {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Partial<OptionChainSource>;
  return typeof value.getOptionChains === "function" && typeof value.getOptionExpireDates === "function";
}

/**
 * Adapt a platform into a source. Null when the platform omits its options
 * data plane — callers must then refuse the surface, not degrade it.
 */
export function platformChainSource(platform: ITradingPlatform | null | undefined): OptionChainSource | null {
  if (!platform) return null;
  const getOptionChains = platform.getOptionChains?.bind(platform);
  const getOptionExpireDates = platform.getOptionExpireDates?.bind(platform);
  if (typeof getOptionChains !== "function" || typeof getOptionExpireDates !== "function") return null;

  return {
    getOptionChains: (params, budget) => getOptionChains(params, budget),
    getOptionExpireDates: (symbol, expiryType, budget) => getOptionExpireDates(symbol, expiryType, budget),
    // Platforms forward the budget to their client, so metering is honoured.
    supportsOptionRequestBudget: true,
    get lastError() {
      return platform.getLastError?.();
    },
  };
}
