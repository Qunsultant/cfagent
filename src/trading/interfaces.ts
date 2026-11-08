/**
 * Pluggable Trading Capability Architecture: Domain Interfaces
 *
 * Implements:
 * - Strategy Pattern (GoF): ITradingPlatform abstracts individual brokerage/exchange platforms.
 * - Single Responsibility Principle (SRP): Decouples platform communication from agent reasoning and screening.
 * - Open/Closed Principle (OCP): New platforms (a brokerage or exchange integration) plug in without modifying existing code.
 */

import type {
  BrokerQuote,
  StockScreenerFilter,
  StockScreenResult,
  ScreenedStockItem,
  BrokerOrderDraft,
  BrokerOrderExecutionResult,
  BrokerPosition,
  BrokerPositionLot,
  BrokerAccount,
  BrokerActivity,
  BrokerWatchlist,
  BrokerRemoteOrder,
  BrokerStatus,
  BrokerOptionChain,
  BrokerOptionExpireDate,
  BrokerCancelOrderResult,
  OrderPriceSource,
} from "../types";
import type { BrokerId } from "./brokerCatalog";

/** Optional invocation-wide limiter for outbound option API fetch attempts. */
export interface OptionRequestBudget {
  tryConsume(): boolean;
}

/**
 * Broker ids the platform contract accepts (#3232, program #3216).
 * `sandbox` is NOT a broker — it was E*TRADE's test environment leaking into
 * the id space. It stays accepted, as a declared legacy alias that resolves to
 * (etrade, TEST) via `resolveBrokerSelection`; new code must use {@link BrokerId}.
 */
export type TradingPlatformId = BrokerId | "sandbox";
/** Asset classes with implemented order forms and broker routing. Extend this union with a dedicated order adapter when a new market is added. */
export type TradeAssetClass = "equity" | "options";

export interface OrderPreviewParams {
  assetClass?: TradeAssetClass;
  symbol: string;
  action?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  stopPrice?: number;
  sessionId?: string;
  notes?: string;
  /** Optional bracket order parameters. */
  orderClass?: "simple" | "bracket" | "oco" | "oto";
  takeProfit?: { limitPrice?: number };
  stopLoss?: { stopPrice?: number; limitPrice?: number };
  /** Opening legs for a native multi-leg options order. */
  optionLegs?: TradingOrderLeg[];
  /** Net strategy price: positive is debit, negative is credit. */
  strategyNetDebit?: number;
}

export interface TradingOrderLeg {
  underlyingSymbol: string;
  securityType: "EQ" | "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface PlaceOrderParams {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: string;
  limitPrice?: number;
  previewId?: string;
  /**
   * Issue #3782: where the limit price came from. The trade workflow
   * attaches it (from the stored draft's provenance, or the caller's
   * own named origin); placeOrder refuses a limit price without it.
   */
  priceSource?: OrderPriceSource;
  userLogin: string;
  optionLegs?: TradingOrderLeg[];
  strategyNetDebit?: number;
  /** Optional bracket order parameters. */
  orderClass?: "simple" | "bracket" | "oco" | "oto";
  takeProfit?: { limitPrice?: number };
  stopLoss?: { stopPrice?: number; limitPrice?: number };
  /**
   * Issue #3508: trading session identifier ("pre_market", "regular",
   * "after_hours", "exto").
   */
  session?: string;
  /**
   * Issue #3508: whether the order is eligible for execution in
   * extended hours / overnight sessions.
   */
  extendedHours?: boolean;
  /**
   * Issue #3508: optional Time-In-Force specification.
   */
  timeInForce?: "day" | "gtc" | "ioc" | "fok" | "opg" | "cls";
}

/**
 * Issue #1393 — frozen snapshot of a previewed proposal's material
 * terms, captured at approval time. When a settle caller supplies
 * these, the platform must refuse execution if the CURRENT draft
 * terms differ: a proposal edited after approval cannot execute
 * under the old approval (invariant 5). The parameter is optional
 * so existing orderId-only callers keep their current behaviour;
 * callers that carry an approval snapshot pass it through.
 */
export interface ExpectedTradeTerms {
  symbol: string;
  action: string;
  quantity: number;
  price: number;
  totalValue: number;
}

export interface ITradingPlatform {
  readonly platformId: TradingPlatformId;
  readonly name: string;

  getStatus(): Promise<BrokerStatus>;
  getQuote(symbol: string): Promise<BrokerQuote>;
  screenMarkets?(filter?: StockScreenerFilter): Promise<StockScreenResult>;
  getAccounts(): Promise<BrokerAccount[]>;
  getPositions(accountKey?: string, includeBalance?: boolean): Promise<{ account: BrokerAccount; positions: BrokerPosition[] }>;
  getPositionLots?(accountKey: string, positionId: string): Promise<BrokerPositionLot[]>;
  previewOrder(params: OrderPreviewParams): Promise<BrokerOrderDraft>;
  executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected", expectedTerms?: ExpectedTradeTerms): BrokerOrderExecutionResult | Promise<BrokerOrderExecutionResult>;
  placeOrderRemote?(params: PlaceOrderParams): Promise<BrokerOrderExecutionResult>;
  /**
   * Issue #3398: session-order support — true when this platform's
   * order path carries a named trading session's terms on the wire
   * (extended-hours eligibility for pre-market / after-hours,
   * overnight terms for EXTO), so an order placed in that session
   * actually trades in it. Optional: a platform that cannot omits
   * it, and session-gated callers (the Stock Copilot) refuse with a
   * named reason instead of silently sending a regular-session
   * order in the session's place. The session id is the caller's
   * session vocabulary (the copilot's: pre_market / regular /
   * after_hours / exto).
   */
  supportsSessionOrders?(session: string): boolean;
  /**
   * Issue #3390: cancel a live order at the broker. Optional: a platform that
   * cannot cancel omits it, and the neutral route answers `provider_unsupported`
   * naming the broker instead of offering a control that does nothing.
   */
  cancelOrderRemote?(orderId: string | number, accountKey?: string): Promise<BrokerCancelOrderResult>;
  /**
   * Options data reads (issue #291 T5b). Optional: platforms without an
   * options data plane omit them and callers get provider_unsupported.
   * Semantics are the broker client's verbatim passthroughs — no
   * caching, fallback, or provenance rewriting at this layer.
   */
  getOptionChains?(params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    noOfStrikes?: number;
    includeWeekly?: boolean;
    chainType?: "CALL" | "PUT" | "CALLPUT";
    includeRawResponse?: boolean;
  }, requestBudget?: OptionRequestBudget): Promise<BrokerOptionChain | null>;
  getOptionExpireDates?(symbol: string, expiryType?: string, requestBudget?: OptionRequestBudget): Promise<BrokerOptionExpireDate[]>;
  /**
   * The broker client's last recorded error, if any (issue #155 pattern:
   * read on the SAME instance that made the call). Optional — platforms
   * without a stateful client omit it.
   */
  getLastError?(): string | undefined;
  /**
   * Quote read with the error carried alongside the result (issue #462:
   * concurrent callers must never read shared instance error state).
   * LIVE fetch only — no cache/curated fallback, no policy: the caller
   * names its failure policy (issue #291 quote unification, Q1).
   * Optional — platforms without a detailed read omit it.
   */
  getQuoteDetailed?(symbol: string): Promise<{ quote: BrokerQuote | null; error: string | null }>;
  /**
   * Account-history reads (issue #3359). Optional for the same reason as every
   * other capability: a broker without order history omits it and the surface
   * says so, instead of an empty table reading like "no orders".
   *
   * Both return the broker's own rows mapped onto the neutral shapes — never
   * another broker's data, never a synthesised row.
   */
  getOrderHistory?(status: "open" | "closed" | "all"): Promise<BrokerRemoteOrder[]>;
  getAccountActivity?(activityType?: string): Promise<BrokerActivity[]>;
  /** Issue #3434: the account's own saved lists, in the broker's vocabulary. */
  getWatchlists?(): Promise<BrokerWatchlist[]>;
}

export interface IMarketScreener {
  screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult>;
}
