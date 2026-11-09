/**
 * Alpaca Trading Platform Adapter
 *
 * Implements ITradingPlatform for Alpaca Trading API v2
 */

import type { Env, BrokerQuote, BrokerAccount, BrokerPosition, BrokerPositionLot, BrokerOrderDraft, BrokerOrderExecutionResult, BrokerStatus, BrokerOptionChain, BrokerOptionContract, BrokerOptionExpireDate, StockScreenerFilter, StockScreenResult, BrokerRemoteOrder, BrokerActivity, BrokerWatchlist, BrokerCancelOrderResult, OrderPriceSource } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ITradingPlatform, OrderPreviewParams, PlaceOrderParams } from "../interfaces";
import { BROKER_CATALOG, type TradingType } from "../brokerCatalog";
import { deriveLotsFromFills, parseAlpacaFill, type DerivedLots } from "./fillLots";
import { NeutralMarketScreener } from "../neutralMarketScreener";
import { decodeOrderPriceSource, encodeOrderPriceSource } from "../quotePolicies";
import { computeBracketExits } from "../bracketPercent";
import { platformQuoteSource } from "../stockQuoteSource";
import { formatOccSymbol, parseOccSymbol } from "./occSymbol";
import { withAlpacaCredentials, alpacaTradingSide, normalizeAlpacaBaseUrl } from "./credentials";
import { applyAlpacaPair, resolveAlpacaPair, type AlpacaCredentialSource } from "./credentialResolution";
import {
  fetchAlpacaOptionContracts,
  fetchAlpacaOptionSnapshots,
  displayPriceFor,
  type AlpacaOptionsConfig,
} from "./optionsData";
import { AlpacaMarketDataProvider } from "../../services/marketDataResearch";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";

/**
 * Issue #3158 — single paper/live resolver for the Alpaca adapter.
 * The default base URL is the paper host; a base URL counts as live
 * only when it is set and is not a paper host. The trading client
 * (AlpacaMarketDataProvider.getTradingUrl) uses the same default, so
 * status and placement can never disagree about paper vs live.
 */
const ALPACA_PAPER_HOST = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_HOST = "https://api.alpaca.markets";

/**
 * Issue #3866 — the configured URL, normalized once.
 *
 * `resolveAlpacaTradingBase` used to answer a hardcoded host for the `TEST`
 * selection while the client used `env.ALPACA_BASE_URL`. Status therefore
 * advertised a URL the client never called, which is how four portfolio reads
 * failed against an apparently healthy connection.
 */
function configuredAlpacaBase(env: Env): string {
  return normalizeAlpacaBaseUrl(env.ALPACA_BASE_URL);
}

export function resolveAlpacaTradingBase(
  env: Env,
  overrideEnv?: string,
): { baseUrl: string; isLive: boolean; source: "pin" | "selection" | "inference" } {
  // Issue #3233: an explicit trading type wins over inference. Without it the
  // legacy rule stands (paper host = paper), so nothing silently changes for
  // an environment that only sets ALPACA_BASE_URL.
  const explicit = String(env.ALPACA_TRADING_TYPE ?? "").trim().toLowerCase();
  const configured = configuredAlpacaBase(env);
  if (explicit === "paper") {
    return { baseUrl: configured.includes("paper-api") ? configured : ALPACA_PAPER_HOST, isLive: false, source: "pin" };
  }
  if (explicit === "live") {
    return { baseUrl: configured.includes("paper-api") ? ALPACA_LIVE_HOST : configured, isLive: true, source: "pin" };
  }
  // Issue #3272: the persisted selection is authoritative when the deployment
  // has not pinned a trading type. TEST means paper, PROD means live - the
  // same mapping the catalog declares for every broker (#3232), so the hub
  // switch now means the same thing on both brokers instead of being an
  // E*TRADE-only control that Alpaca silently ignored.
  const selection = String(overrideEnv ?? "").trim().toUpperCase();
  if (selection === "TEST" || selection === "PAPER" || selection === "SANDBOX") {
    return { baseUrl: configured.includes("paper-api") ? configured : ALPACA_PAPER_HOST, isLive: false, source: "selection" };
  }
  if (selection === "PROD" || selection === "LIVE") {
    return { baseUrl: configured.includes("paper-api") ? ALPACA_LIVE_HOST : configured, isLive: true, source: "selection" };
  }
  return { baseUrl: configured, isLive: !configured.includes("paper-api"), source: "inference" };
}

/**
 * Issue #3158 — upstream failures map to business errors. The HTTP
 * status classifies the failure; the upstream message body is NEVER
 * surfaced (it carries technical text and, for HTML error pages, raw
 * markup). A missing status means the request never reached Alpaca.
 */
function mapAlpacaFailureToBusiness(
  httpStatus: number | undefined,
  operation: "order" | "account" | "positions" | "history",
): string {
  const subject =
    operation === "order"
      ? "the order was not placed"
      : operation === "account"
        ? "account data is unavailable"
        : operation === "history"
          ? "order history is unavailable"
          : "position data is unavailable";
  if (httpStatus === 401 || httpStatus === 403) {
    return `Alpaca rejected the broker credentials. Check the configured Alpaca API key and secret; ${subject}.`;
  }
  if (httpStatus === 422) {
    return operation === "order"
      ? "Alpaca rejected the order details. Check the symbol, quantity, and buying power; the order was not placed."
      : `Alpaca rejected the ${operation} request; ${subject}.`;
  }
  if (httpStatus === 429) {
    return `Alpaca is busy. ${operation === "order" ? "The order was not placed; please retry shortly." : `${subject}; please retry shortly.`}`;
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return `Alpaca is temporarily unavailable. ${operation === "order" ? "The order was not placed; please retry." : `${subject}; please retry.`}`;
  }
  if (httpStatus === undefined) {
    return operation === "order"
      ? "Could not reach Alpaca. The order was not placed; please retry."
      : `Could not reach Alpaca; ${subject}.`;
  }
  return operation === "order"
    ? "Alpaca rejected the order. The order was not placed."
    : `Alpaca rejected the ${operation} request; ${subject}.`;
}

/** Alpaca money/quantity fields arrive as numeric strings; an unreadable one fails explicit, never zero-filled. */
function finiteAlpacaNumber(value: unknown, field: string): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`Alpaca returned an unreadable ${field} value.`);
  }
  return n;
}

/**
 * Issue #3359: Alpaca's order statuses, mapped once, totally.
 *
 * The neutral status is the platform's vocabulary; `rawStatus` carries Alpaca's
 * own word alongside it, so nothing is lost and no display has to guess. A
 * status the platform does not model becomes `UNKNOWN` — mapping an unfamiliar
 * value onto OPEN or REJECTED would invent a fact about the user's order.
 */
const ALPACA_OPEN_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "held",
  "calculated",
  "pending_cancel",
  "pending_replace",
]);

export function mapAlpacaOrderStatus(raw: unknown): BrokerRemoteOrder["status"] {
  const status = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ALPACA_OPEN_ORDER_STATUSES.has(status)) return "OPEN";
  if (status === "filled") return "EXECUTED";
  if (status === "partially_filled") return "INDIVIDUAL_FILLS";
  if (status === "canceled" || status === "cancelled" || status === "expired" || status === "replaced") {
    return "CANCELLED";
  }
  if (status === "rejected") return "REJECTED";
  return "UNKNOWN";
}

/** One Alpaca order as a neutral remote-order row. An id-less row is a bad response, not a row. */
export function mapAlpacaOrderHistoryRow(raw: any): BrokerRemoteOrder {
  const orderId = typeof raw?.id === "string" && raw.id ? raw.id : "";
  if (!orderId) throw new Error("Alpaca returned an order without an id.");
  const quantity = Number(raw?.qty);
  const limitPrice = Number(raw?.limit_price);
  const placedTime = Date.parse(String(raw?.submitted_at ?? ""));
  return {
    orderId,
    orderType: typeof raw?.type === "string" ? raw.type : "unknown",
    status: mapAlpacaOrderStatus(raw?.status),
    rawStatus: typeof raw?.status === "string" ? raw.status : undefined,
    ...(Number.isFinite(placedTime) ? { placedTime } : {}),
    ...(Number.isFinite(quantity) ? { quantity } : {}),
    ...(Number.isFinite(limitPrice) && raw?.limit_price !== null ? { limitPrice } : {}),
    ...(typeof raw?.symbol === "string" && raw.symbol ? { symbol: raw.symbol.toUpperCase() } : {}),
    ...(typeof raw?.side === "string" ? { orderAction: raw.side.toUpperCase() } : {}),
  };
}

/**
 * One Alpaca account activity as a neutral row. The activity type stays in
 * Alpaca's words (FILL, DIV, FEE, ...); the surface shows them as they are.
 * Dates arrive as `transaction_time` for trades and `date` for everything else.
 */
/**
 * Issue #3434: one Alpaca watchlist onto the neutral row.
 *
 * `symbols` is the platform's currency (a list of tickers), so a row without
 * one is a failure rather than an empty list — "the broker returned no symbols"
 * and "this list is empty" are different facts. Timestamps are parsed to epoch
 * ms when present and omitted when not.
 */
export function mapAlpacaWatchlist(raw: any): BrokerWatchlist {
  const id = raw?.id;
  const watchlistId = typeof id === "string" && id ? id : "";
  if (!watchlistId) throw new Error("Alpaca returned a watchlist without an id.");
  const name = typeof raw?.name === "string" && raw.name ? raw.name : watchlistId;
  if (!Array.isArray(raw?.symbols)) {
    throw new Error(`Alpaca returned watchlist ${watchlistId} without a symbols array.`);
  }
  const symbols = raw.symbols
    .filter((symbol: unknown): symbol is string => typeof symbol === "string" && symbol.trim() !== "")
    .map((symbol: string) => symbol.trim().toUpperCase());
  const createdAt = Date.parse(String(raw?.created_at ?? ""));
  const updatedAt = Date.parse(String(raw?.updated_at ?? ""));
  return {
    watchlistId,
    name,
    symbols,
    source: "alpaca_api",
    ...(Number.isFinite(createdAt) ? { createdTimestamp: createdAt } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedTimestamp: updatedAt } : {}),
  };
}

export function mapAlpacaActivityRow(raw: any): BrokerActivity {
  const activityId = typeof raw?.id === "string" && raw.id ? raw.id : "";
  if (!activityId) throw new Error("Alpaca returned an activity without an id.");
  const activityType = typeof raw?.activity_type === "string" ? raw.activity_type : "unknown";
  const parsed = Date.parse(String(raw?.transaction_time ?? raw?.date ?? ""));
  const quantity = Number(raw?.qty);
  const price = Number(raw?.price);
  const netAmount = Number(raw?.net_amount);
  return {
    activityId,
    activityType,
    // An unparseable date is stated as epoch 0 only when the broker gave none;
    // a malformed one is a bad response.
    activityDate: Number.isFinite(parsed) ? parsed : 0,
    ...(typeof raw?.symbol === "string" && raw.symbol ? { symbol: raw.symbol.toUpperCase() } : {}),
    ...(Number.isFinite(quantity) ? { quantity } : {}),
    ...(Number.isFinite(price) ? { price } : {}),
    ...(Number.isFinite(netAmount) ? { netAmount } : {}),
    ...(typeof raw?.order_id === "string" && raw.order_id ? { orderId: raw.order_id } : {}),
  };
}

function mapAlpacaAccount(raw: any, isLive: boolean): BrokerAccount {
  if (typeof raw.id !== "string" || !raw.id) {
    throw new Error("Alpaca returned an unreadable account response.");
  }
  const portfolioValue = finiteAlpacaNumber(raw.portfolio_value, "portfolio_value");
  const cash = finiteAlpacaNumber(raw.cash, "cash");
  const buyingPower = finiteAlpacaNumber(raw.buying_power, "buying_power");
  const multiplier = Number(raw.multiplier);
  return {
    accountId: raw.id,
    accountKey: raw.id,
    accountDesc: "Alpaca Trading Account",
    // Alpaca reports no margin flag; the buying-power multiplier is the
    // honest derivation (greater than 1 means margin capability).
    accountType: Number.isFinite(multiplier) && multiplier > 1 ? "MARGIN" : "CASH",
    accountMode: isLive ? "live" : "paper",
    accountStatus: typeof raw.status === "string" ? raw.status : undefined,
    netAccountValue: portfolioValue,
    totalAccountValue: portfolioValue,
    cashAvailableForInvestment: cash,
    marginBuyingPower: buyingPower,
    dayTraderStatus: raw.pattern_day_trader === true,
  };
}

/**
 * Issue #3324: an Alpaca option position arrives as an OCC symbol with no
 * strike/expiry/type fields, which left every option position unresolvable by
 * the risk model. The OCC symbol IS the contract detail — parsed from the end
 * of the symbol, never guessed — so the position carries the same three fields
 * an E*TRADE position does. A symbol that does not parse stays unresolved (the
 * risk report names it) rather than receiving a manufactured contract.
 */
export function mapAlpacaPosition(raw: any): BrokerPosition {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.toUpperCase() : "";
  if (!symbol) {
    throw new Error("Alpaca returned a position without a symbol.");
  }
  const unrealizedPlpc = finiteAlpacaNumber(raw.unrealized_plpc, "unrealized_plpc");
  // Alpaca plpc fields are fractions; ETrade percent fields are percents.
  const intradayPl = raw.unrealized_intraday_pl === undefined || raw.unrealized_intraday_pl === null
    ? 0
    : finiteAlpacaNumber(raw.unrealized_intraday_pl, "unrealized_intraday_pl");
  const intradayPlpc = raw.unrealized_intraday_plpc === undefined || raw.unrealized_intraday_plpc === null
    ? 0
    : finiteAlpacaNumber(raw.unrealized_intraday_plpc, "unrealized_intraday_plpc");
  const assetClass = typeof raw.asset_class === "string" ? raw.asset_class : "";
  const isOption = assetClass === "us_option";
  const contract = isOption ? parseOccSymbol(symbol) : null;
  return {
    symbol,
    description: contract ? `${contract.root} option (Alpaca)` : `${symbol} (Alpaca)`,
    // Neutral broker codes, not Alpaca's. "OPTN" is what the rest of the
    // platform (and #34's risk classifier) reads; "us_option" is a vendor word.
    securityType: assetClass === "us_equity" ? "EQ" : isOption ? "OPTN" : assetClass,
    ...(contract
      ? { optionType: contract.optionType, strikePrice: contract.strikePrice, expirationDate: contract.expirationDate }
      : {}),
    quantity: finiteAlpacaNumber(raw.qty, "qty"),
    positionType: raw.side === "short" ? "SHORT" : "LONG",
    pricePaid: finiteAlpacaNumber(raw.avg_entry_price, "avg_entry_price"),
    costBasis: finiteAlpacaNumber(raw.cost_basis, "cost_basis"),
    currentPrice: finiteAlpacaNumber(raw.current_price, "current_price"),
    marketPrice: finiteAlpacaNumber(raw.current_price, "current_price"),
    marketValue: finiteAlpacaNumber(raw.market_value, "market_value"),
    totalGain: finiteAlpacaNumber(raw.unrealized_pl, "unrealized_pl"),
    unrealizedGainLoss: finiteAlpacaNumber(raw.unrealized_pl, "unrealized_pl"),
    totalGainPercent: unrealizedPlpc * 100,
    unrealizedGainLossPercent: unrealizedPlpc * 100,
    daysGain: intradayPl,
    daysGainPercent: intradayPlpc * 100,
  };
}

export class AlpacaTradingPlatform implements ITradingPlatform {
  readonly platformId = "alpaca" as const;
  readonly name = "Alpaca Securities Brokerage (API v2)";
  private alpacaData: AlpacaMarketDataProvider;

  constructor(
    private env: Env,
    private orm: DatabaseORM | undefined,
    private userLogin: string,
    private overrideEnv?: string,
  ) {
    // Issue #1185: per-user platform — an explicit login is required.
    if (!userLogin) {
      throw new Error("AlpacaTradingPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    // Issue #3330: the deployment writes ALPACA_{PAPER,LIVE}_*; this adapter
    // reads the generic names. Map the side once, here, so status, quotes,
    // chains, orders and the market-data provider all see ONE credential set
    // instead of each deciding paper-vs-live for itself.
    this.env = withAlpacaCredentials(env, overrideEnv);
    this.alpacaData = new AlpacaMarketDataProvider(this.env);
  }

  /**
   * Issue #3351 — the pair this instance will actually use, resolved once.
   *
   * Alpaca's credential has two possible sources after sign-in: this login's own
   * verified pair and the deployment's. The adapter is constructed
   * synchronously by the registry, so the resolution is lazy and memoised here
   * rather than in five route handlers — every consumer (a quote, a chain, an
   * order, the IV collector, a scheduled run) gets the same answer instead of
   * each deciding for itself.
   *
   * `credentialSource` is kept for the status read: a surface must be able to say
   * whether the pair in use is the user's or the operator's. Without that, a
   * "connected" badge is a claim about the deployment, not about the account.
   *
   * A store read that cannot reach the Durable Object resolves to the deployment
   * pair (the store returns null rather than throwing), and the source says so.
   * That is the pre-slice behaviour, reported honestly — not a silent revival of
   * a user's pair.
   */
  private credentialSource: AlpacaCredentialSource = "deployment";
  private keyIdLast4: string | null = null;
  private readyPromise: Promise<void> | null = null;

  private ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      const side = alpacaTradingSide(this.env, this.overrideEnv);
      const pair = await resolveAlpacaPair(this.env, this.userLogin, side);
      this.credentialSource = pair.source;
      this.keyIdLast4 = pair.keyIdLast4;
      if (pair.source === "user") {
        this.env = applyAlpacaPair(this.env, pair);
        this.alpacaData = new AlpacaMarketDataProvider(this.env);
      }
    })();
    return this.readyPromise;
  }

  async getStatus(): Promise<BrokerStatus> {
    await this.ready();
    const hasKey = Boolean(this.env.ALPACA_API_KEY || this.env.ALPACA_API_KEY_ID);
    const hasSecret = Boolean(this.env.ALPACA_SECRET_KEY || this.env.ALPACA_API_SECRET_KEY);
    const configured = hasKey && hasSecret;
    const { baseUrl, isLive } = resolveAlpacaTradingBase(this.env, this.overrideEnv);
    // Issue #3232 (program #3216): Alpaca reports ALPACA's own vocabulary and
    // its own trading type. It used to report `protocol: "etrade_oauth_rest"`
    // and `mode: "live_oauth"` — another broker's words — and `environment:
    // "sandbox"` while `activeEnvironment` said TEST, i.e. two vocabularies for
    // one fact, neither of them saying "paper".
    const tradingType: TradingType = isLive ? "live" : "paper";
    const vocabulary = BROKER_CATALOG.alpaca.statusVocabulary;

    return {
      broker: "alpaca",
      name: this.name,
      configured,
      mode: vocabulary.mode[tradingType],
      protocol: vocabulary.protocol,
      environment: vocabulary.environment[tradingType],
      activeEnvironment: isLive ? "PROD" : "TEST",
      apiUrl: baseUrl,
      // Issue #3866: the configured value beside the URL in use. When they
      // differ the panel says so instead of showing a healthy host that no
      // request ever reaches.
      configuredApiUrl: configuredAlpacaBase(this.env),
      urlMismatch: configuredAlpacaBase(this.env) !== baseUrl,
      hasApiKey: configured,
      credentialSource: this.credentialSource,
      keyIdLast4: this.keyIdLast4 ?? undefined,
      oauthAuthenticated: true,
      capabilities: [
        "Real-Time Level 1 / Level 2 Market Depth (IEX/SIP)",
        "Zero-Commission US Equity & ETF Trading",
        "Fractional Shares Execution",
        "Crypto 24/7 Trading (BTC/USD, ETH/USD)",
        "Paper Trading Simulation Sandbox",
        "W3C Agent DID Cryptographic Stamping",
      ],
    };
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    await this.ready();
    const cleanSym = symbol.trim().toUpperCase();
    const snap = await this.alpacaData.getQuote(cleanSym);

    // Issue #1555 (parent #913): pass through, never fabricate. The
    // Alpaca snapshot carries price/bid/ask/volume/OHLC only — it has
    // no peRatio, marketCap, 52-week, or RSI. Those BrokerQuote
    // fields are OPTIONAL, so a snapshot that lacks them yields an
    // omitted field, never a hardcoded 28.0 / 50.0 / high*1.25 /
    // low*0.75 / 50.0. A real snapshot value, if a future Alpaca
    // response carries one, passes through untouched (finite and
    // positive; RSI additionally bounded 0–100). Downstream filters
    // fail closed on missing values (screener.ts: minMarketCap and
    // maxPeRatio reject unknown), which is the honest outcome — an
    // Alpaca name no longer passes those gates on fake numbers.
    const extra = snap as unknown as Record<string, unknown>;
    const positive = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v > 0;
    const rsi = extra["rsi14"];
    const rsiValue =
      typeof rsi === "number" && Number.isFinite(rsi) && rsi >= 0 && rsi <= 100
        ? rsi
        : undefined;

    return {
      symbol: cleanSym,
      companyName: `${cleanSym} (Alpaca Real-Time)`,
      lastPrice: snap.price,
      price: snap.price,
      change: snap.change,
      changePercent: snap.changePercent,
      bid: snap.bid ?? 0,
      ask: snap.ask ?? 0,
      volume: snap.volume,
      open: snap.open,
      high: snap.high,
      low: snap.low,
      ...(positive(extra["peRatio"]) ? { peRatio: extra["peRatio"] as number } : {}),
      ...(positive(extra["marketCap"]) ? { marketCap: extra["marketCap"] as number } : {}),
      ...(positive(extra["high52"])
        ? {
            week52High: extra["high52"] as number,
            high52: extra["high52"] as number,
          }
        : {}),
      ...(positive(extra["low52"])
        ? {
            week52Low: extra["low52"] as number,
            low52: extra["low52"] as number,
          }
        : {}),
      ...(rsiValue !== undefined ? { rsi: rsiValue } : {}),
      source: "Alpaca Real-Time NBBO Feed",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Issue #3325 (programme #3292): stock screening on Alpaca's own quotes.
   *
   * Screening was declared `false` for Alpaca with the reasoning "Alpaca has no
   * screener API" — true, but beside the point: the screening math is the
   * platform's (the same `NeutralMarketScreener` #3272 built), and the only
   * broker-specific input is quotes, which this adapter already reads. Declaring
   * the capability absent meant a surface refused work the engine could do.
   *
   * The universe resolves through the live listings feed; an unresolvable
   * universe or an unconfigured broker is a named refusal from the screener,
   * never an empty "no matches" or another broker's quotes.
   */
  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    return new NeutralMarketScreener({ quoteSource: platformQuoteSource(this) }).screenMarkets(filter);
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    await this.ready();
    // Issue #3158: the hardcoded paper stub (alpaca_paper_01, $100,000)
    // is replaced by the live Trading API read. Unconfigured or failed
    // reads fail explicit — a fabricated account is never returned.
    if (!this.alpacaData.isConfigured()) {
      throw new Error("Alpaca credentials are not configured; account data is unavailable.");
    }
    const res = await this.alpacaData.getAccount();
    if (!res.success || !res.account) {
      throw new Error(mapAlpacaFailureToBusiness(res.httpStatus, "account"));
    }
    return [mapAlpacaAccount(res.account, resolveAlpacaTradingBase(this.env, this.overrideEnv).isLive)];
  }

  /**
   * Issue #3233: Alpaca's options data plane. Configuration comes from the same
   * resolver the trading calls use, so a paper selection never reads live data
   * by accident. `ALPACA_OPTIONS_FEED` selects the feed (indicative by default,
   * which needs no OPRA subscription).
   */
  private optionsConfig(): AlpacaOptionsConfig {
    const { baseUrl } = resolveAlpacaTradingBase(this.env, this.overrideEnv);
    return {
      tradingUrl: baseUrl,
      dataUrl: this.env.ALPACA_DATA_URL || "https://data.alpaca.markets",
      headers: {
        "APCA-API-KEY-ID": this.env.ALPACA_API_KEY || this.env.ALPACA_API_KEY_ID || "",
        "APCA-API-SECRET-KEY": this.env.ALPACA_SECRET_KEY || this.env.ALPACA_API_SECRET_KEY || "",
      },
      feed: this.env.ALPACA_OPTIONS_FEED,
      // Issue #3515 S1: options fetches share the provider's Alpaca budget.
      rateLimiter: this.alpacaData.outboundLimiter,
    };
  }

  /**
   * Expiry dates for one underlying, derived from the contracts Alpaca lists.
   * Distinct and ascending; `expiryType` is echoed back when the caller asked
   * for one (Alpaca does not label weekly vs monthly here, so it is not
   * invented).
   */
  async getOptionExpireDates(
    symbol: string,
    expiryType?: string,
    requestBudget?: import("../interfaces").OptionRequestBudget,
  ): Promise<BrokerOptionExpireDate[]> {
    await this.ready();
    if (requestBudget && !requestBudget.tryConsume()) {
      throw new Error("Alpaca option expire-date request budget exhausted for this run.");
    }
    const contracts = await fetchAlpacaOptionContracts(this.optionsConfig(), { symbol });
    const seen = new Set<string>();
    const dates: BrokerOptionExpireDate[] = [];
    for (const row of contracts) {
      if (seen.has(row.expirationDate)) continue;
      seen.add(row.expirationDate);
      const [year, month, day] = row.expirationDate.split("-").map((part) => Number(part));
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) continue;
      dates.push({ year, month, day, ...(expiryType ? { expiryType } : {}) });
    }
    dates.sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day);
    return dates;
  }

  /**
   * One option chain, assembled from contracts + snapshots.
   *
   * Honesty rules (see optionsData.ts): a contract with no two-sided quote or no
   * displayable price is omitted rather than emitted with invented numbers;
   * greeks and IV appear only when Alpaca sends them.
   */
  async getOptionChains(
    params: {
      symbol: string;
      expiryYear?: number;
      expiryMonth?: number;
      expiryDay?: number;
      strikePrice?: number;
      noOfStrikes?: number;
      includeWeekly?: boolean;
      chainType?: "CALL" | "PUT" | "CALLPUT";
      includeRawResponse?: boolean;
    },
    requestBudget?: import("../interfaces").OptionRequestBudget,
  ): Promise<BrokerOptionChain | null> {
    await this.ready();
    if (requestBudget && !requestBudget.tryConsume()) {
      throw new Error("Alpaca option chain request budget exhausted for this run.");
    }
    const cfg = this.optionsConfig();
    const contracts = await fetchAlpacaOptionContracts(cfg, {
      symbol: params.symbol,
      expiryYear: params.expiryYear,
      expiryMonth: params.expiryMonth,
      expiryDay: params.expiryDay,
      strikePrice: params.strikePrice,
      chainType: params.chainType,
    });
    if (contracts.length === 0) return null;

    if (requestBudget && !requestBudget.tryConsume()) {
      throw new Error("Alpaca option snapshot request budget exhausted for this run.");
    }
    const symbols = contracts.map((row) => row.symbol);
    const snapshots = await fetchAlpacaOptionSnapshots(cfg, params.symbol, symbols);

    const underlying = await this.getQuote(params.symbol);
    const byStrike = new Map<number, { call?: BrokerOptionContract; put?: BrokerOptionContract }>();
    let matched = 0;

    for (const row of contracts) {
      const quote = snapshots.get(row.symbol);
      if (!quote) continue;
      if (quote.bid === undefined || quote.ask === undefined) continue;
      const lastPrice = displayPriceFor(quote);
      if (lastPrice === undefined) continue;
      const contract: BrokerOptionContract = {
        optionType: row.type === "call" ? "CALL" : "PUT",
        strikePrice: row.strikePrice,
        symbol: row.symbol,
        bid: quote.bid,
        ask: quote.ask,
        lastPrice,
        ...(quote.volume !== undefined ? { volume: quote.volume } : {}),
        ...(quote.delta !== undefined ? { delta: quote.delta } : {}),
        ...(quote.gamma !== undefined ? { gamma: quote.gamma } : {}),
        ...(quote.theta !== undefined ? { theta: quote.theta } : {}),
        ...(quote.vega !== undefined ? { vega: quote.vega } : {}),
        ...(quote.rho !== undefined ? { rho: quote.rho } : {}),
        ...(quote.impliedVolatility !== undefined
          ? { impliedVolatility: quote.impliedVolatility }
          : {}),
      };
      const pair = byStrike.get(row.strikePrice) ?? {};
      if (row.type === "call") pair.call = contract;
      else pair.put = contract;
      byStrike.set(row.strikePrice, pair);
      matched++;
    }

    if (matched === 0) return null;

    let strikes = [...byStrike.keys()].sort((a, b) => a - b);
    if (params.noOfStrikes && strikes.length > params.noOfStrikes) {
      // Centre the window on the underlying so the returned strikes are the
      // ones around the money, the same intent as E*TRADE's noOfStrikes.
      const pivot = strikes.reduce((best, s) =>
        Math.abs(s - underlying.lastPrice) < Math.abs(best - underlying.lastPrice) ? s : best,
      );
      const half = Math.floor(params.noOfStrikes / 2);
      const idx = strikes.indexOf(pivot);
      strikes = strikes.slice(Math.max(0, idx - half), Math.max(0, idx - half) + params.noOfStrikes);
    }

    return {
      symbol: underlying.symbol,
      underlyingPrice: underlying.lastPrice,
      selectedExpiry:
        params.expiryYear && params.expiryMonth && params.expiryDay
          ? { year: params.expiryYear, month: params.expiryMonth, day: params.expiryDay }
          : undefined,
      pairs: strikes.map((strike) => byStrike.get(strike) ?? {}),
    };
  }

  /** Verbatim live read with the error carried alongside (#3233 parity with E*TRADE). */
  async getQuoteDetailed(symbol: string): Promise<{ quote: BrokerQuote | null; error: string | null }> {
    try {
      return { quote: await this.getQuote(symbol), error: null };
    } catch (err: any) {
      return { quote: null, error: err?.message ? String(err.message) : "Alpaca quote unavailable." };
    }
  }

  async getPositions(): Promise<{ account: BrokerAccount; positions: BrokerPosition[] }> {
    // Issue #3158: live positions from the Trading API. A failed
    // positions read throws rather than reporting an empty list as
    // "no positions" — unknown is not empty.
    const accounts = await this.getAccounts();
    const res = await this.alpacaData.getPositions();
    if (!res.success || !Array.isArray(res.positions)) {
      throw new Error(mapAlpacaFailureToBusiness(res.httpStatus, "positions"));
    }
    return {
      account: accounts[0],
      positions: res.positions.map(mapAlpacaPosition),
    };
  }

  /**
   * Issue #3328 (programme #3292): tax lots, derived from Alpaca fills.
   *
   * Alpaca has no lot endpoint — the reason `positionLots` was declared
   * unsupported — but it reports account fills with quantity, price and time,
   * and FIFO over those answers the same question. This is the detailed form:
   * it carries the coverage the array-returning contract method cannot, so a
   * caller can say "3 of 5 shares are explained by retained fills".
   */
  /**
   * Issue #3359: the broker's own order history, mapped to neutral rows.
   *
   * The read is gated the same way accounts and positions are: unconfigured
   * credentials throw a business error rather than returning an empty list that
   * would read as "you have no orders".
   */
  async getOrderHistory(status: "open" | "closed" | "all" = "open"): Promise<BrokerRemoteOrder[]> {
    await this.ready();
    if (!this.alpacaData.isConfigured()) {
      throw new Error("Alpaca credentials are not configured; order history is unavailable.");
    }
    const res = await this.alpacaData.getOrders(status);
    if (!res.success || !Array.isArray(res.orders)) {
      // Issue #3866: the real HTTP status decides the class of failure. Passing
      // `undefined` here reported a 4xx as "Could not reach Alpaca" — a network
      // claim that was simply false.
      throw new Error(mapAlpacaFailureToBusiness(res.httpStatus, "history"));
    }
    return res.orders.map(mapAlpacaOrderHistoryRow);
  }

  /** Issue #3359: the broker's own account activities, in its own vocabulary. */
  async getAccountActivity(activityType?: string): Promise<BrokerActivity[]> {
    await this.ready();
    if (!this.alpacaData.isConfigured()) {
      throw new Error("Alpaca credentials are not configured; account activity is unavailable.");
    }
    const res = await this.alpacaData.getAccountActivities(activityType);
    if (!res.success || !Array.isArray(res.activities)) {
      throw new Error(mapAlpacaFailureToBusiness(res.httpStatus, "account"));
    }
    return res.activities.map(mapAlpacaActivityRow);
  }

  /**
   * Issue #3434: the account's own watchlists, mapped onto the neutral row.
   *
   * Alpaca returns `{ id, name, symbols[], created_at, updated_at }`. The id is
   * a UUID string, which is exactly what `watchlistId` is for; nothing is
   * invented when a field is missing — created/updated are epoch ms or absent.
   */
  async getWatchlists(): Promise<BrokerWatchlist[]> {
    await this.ready();
    if (!this.alpacaData.isConfigured()) {
      throw new Error("Alpaca credentials are not configured; watchlists are unavailable.");
    }
    const res = await this.alpacaData.getWatchlists();
    if (!res.success || !Array.isArray(res.watchlists)) {
      throw new Error(mapAlpacaFailureToBusiness(res.httpStatus, "account"));
    }
    return res.watchlists.map(mapAlpacaWatchlist);
  }

  async derivePositionLots(positionId: string | number): Promise<DerivedLots> {
    await this.ready();
    const symbol = String(positionId ?? "").trim().toUpperCase();
    if (!symbol) {
      throw new Error("Alpaca position lots require the position id (the symbol).");
    }
    const holdings = await this.getPositions();
    const position = holdings.positions.find((candidate) => candidate.symbol === symbol);
    if (!position) {
      throw new Error(`Alpaca reports no open position for ${symbol}, so its lots cannot be derived.`);
    }
    const fills = await this.alpacaData.getFills(symbol);
    if (!fills.success || !Array.isArray(fills.fills)) {
      throw new Error(mapAlpacaFailureToBusiness(fills.httpStatus, "positions"));
    }
    const parsed = fills.fills
      .map((row: Record<string, unknown>) => parseAlpacaFill(row))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    // An unreadable row is stated, never silently treated as a fill.
    const derived = deriveLotsFromFills(parsed, position.quantity);
    return { ...derived, incomplete: parsed.length !== fills.fills.length };
  }

  /**
   * The contract method. Returns the lots the retained fills explain; the
   * coverage gap is available through `derivePositionLots`, which the route
   * layer reads. Nothing is invented to fill a gap in the array.
   */
  async getPositionLots(accountKey: string, positionId: string | number): Promise<BrokerPositionLot[]> {
    const derived = await this.derivePositionLots(positionId);
    const symbol = String(positionId ?? "").trim().toUpperCase();
    return derived.lots.map((lot) => ({
      positionId: symbol,
      price: lot.price,
      adjustedPrice: lot.price,
      originalQty: lot.quantity,
      remainingQty: lot.quantity,
      availableQty: lot.quantity,
      acquiredDate: Date.parse(lot.acquiredAt),
      settlementCurrency: "USD",
    }));
  }

  /**
   * Issue #3329 (programme #3292): multi-leg option legs → Alpaca leg objects.
   *
   * Alpaca names contracts by OCC symbol and requires a ratio plus a position
   * intent per leg. `PlaceOrderParams.optionLegs` are opening legs by contract,
   * so the intent follows the side; an equity leg, a missing strike/expiry/type,
   * or more than four legs is refused by name rather than sent as a guess.
   */
  private optionOrderLegs(legs: OrderPreviewParams["optionLegs"]): Array<{
    symbol: string;
    ratio_qty: string;
    side: "buy" | "sell";
    position_intent: string;
  }> {
    const optionLegs = (legs ?? []).filter((leg) => leg.securityType === "OPTN");
    if (optionLegs.length === 0) {
      throw new Error("Alpaca options orders require at least one option contract leg.");
    }
    if (optionLegs.length !== (legs ?? []).length) {
     	throw new Error(
        "Alpaca multi-leg orders support option legs only in this client; an equity leg was not submitted. Use a separate equity order.",
      );
    }
    if (optionLegs.length > 4) {
      throw new Error(`Alpaca supports at most 4 option legs per order; ${optionLegs.length} were given.`);
    }
    return optionLegs.map((leg) => {
      if (!leg.optionType || !leg.strike || !leg.expirationDate) {
        throw new Error(
          `Alpaca option leg for ${leg.underlyingSymbol || "an unnamed underlying"} needs a type, strike, and expiry date.`,
        );
      }
      if (!Number.isFinite(leg.quantity) || leg.quantity <= 0) {
        throw new Error("Alpaca option legs need a positive quantity.");
      }
      const symbol = formatOccSymbol({
        root: leg.underlyingSymbol,
        expirationDate: leg.expirationDate,
        optionType: leg.optionType,
        strikePrice: leg.strike,
      });
      return {
        symbol,
        ratio_qty: String(leg.quantity),
        side: leg.side === "SELL" ? "sell" : "buy",
        // Every leg a caller supplies here opens a position; a close is a
        // separate order in this client, and pretending otherwise would let a
        // closing intent ride on an opening approval.
        position_intent: leg.side === "SELL" ? "sell_to_open" : "buy_to_open",
      };
    });
  }

  /**
   * Issue #3401: live trading requires the user's OWN verified pair.
   *
   * The deployment pair is a legitimate fallback for reads and for paper — one
   * shared Alpaca account the product can open with — but it is a single account
   * shared by every tenant. Letting it place live orders would let any signed-in
   * user trade the operator's account. Paper keeps working on deployment keys, so
   * nothing about first use changes.
   *
   * Returns the refusal sentence, or null when the caller may trade.
   */
  private liveTradingRefusal(): string | null {
    const { isLive } = resolveAlpacaTradingBase(this.env, this.overrideEnv);
    if (!isLive) return null;
    if (this.credentialSource === "user") return null;
    return "Live trading needs your own Alpaca key pair. Sign in with a live key pair in the Alpaca panel — the deployment's keys can trade paper only. Nothing was sent to Alpaca.";
  }

  async previewOrder(params: OrderPreviewParams): Promise<BrokerOrderDraft> {
    await this.ready();
    const liveRefusal = this.liveTradingRefusal();
    if (liveRefusal) throw new Error(liveRefusal);
    const optionLegs = params.optionLegs ?? [];
    const isOptionsOrder = params.assetClass === "options" || optionLegs.some((leg) => leg.securityType === "OPTN");
    if (isOptionsOrder) {
      // The same contract E*TRADE requires, so a client does not branch on the
      // broker: a finite net debit/credit and a positive limit price.
      if (!Number.isFinite(params.strategyNetDebit) || params.orderType !== "LIMIT" || !Number.isFinite(params.limitPrice) || Number(params.limitPrice) <= 0) {
        throw new Error(
          "Alpaca options strategies require a finite net debit/credit and a positive limit price, as E*TRADE does.",
        );
      }
      const legs = this.optionOrderLegs(optionLegs);
      const quote = await this.getQuote(params.symbol);
      const orderId = `alp_mleg_${crypto.randomUUID().slice(0, 8)}`;
      const userDid = getUserDid(params.sessionId || this.userLogin);
      const estimatedTotal = Number((Number(params.limitPrice) * 100 * params.quantity).toFixed(2));
      const didProof = createDidAttestationSync({
        draftId: orderId,
        action: "options",
        amount: estimatedTotal,
        currency: "USD",
        customer: `Alpaca:${params.symbol}`,
        gateway: "sandbox",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: userDid,
      });
      const legSummary = legs.map((leg) => `${leg.side} ${leg.ratio_qty} ${leg.symbol}`).join(", ");
      return {
        orderId,
        symbol: params.symbol.toUpperCase(),
        action: params.action || params.orderAction || "BUY",
        orderAction: params.action || params.orderAction || "BUY",
        orderType: "LIMIT",
        quantity: params.quantity,
        estimatedPrice: Number(params.limitPrice),
        limitPrice: params.limitPrice,
        term: "GOOD_FOR_DAY",
        estimatedCommission: 0,
        estimatedTotal,
        // Issue #3782: options strategies require a user-supplied
        // limit price (validated above), so the price is user-sourced.
        priceSource: { kind: "user" },
        status: "previewed",
        proposerDid: didProof.proposerDid,
        authorizerDid: userDid,
        proofSignature: didProof.signature,
        previewMessage:
          `Alpaca multi-leg preview (${legs.length} legs, ${params.quantity} spread${params.quantity === 1 ? "" : "s"}): ` +
          `${legSummary} @ net ${Number(params.limitPrice).toFixed(2)} (limit). Estimated total: $${estimatedTotal.toLocaleString()} USD. ` +
          `Underlying reference: ${quote.lastPrice.toFixed(2)}. Priced locally — Alpaca has no mleg preview endpoint.`,
        safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
        broker: "alpaca",
        placedAt: new Date().toISOString(),
      };
    }
    if (optionLegs.length > 0) {
      throw new Error("Option contract legs cannot be previewed as an equity order.");
    }
    // Issue #3782: getQuote is live-only — it throws
    // marketDataResearchLiveUnavailableError when no live Alpaca quote
    // is available, so reaching here means the quote IS live (the
    // #913/#920 principle holds by construction on this path: no live
    // quote → no draft). A LIMIT draft with no user limit is therefore
    // priced off the live quote and says so; a user-supplied limit
    // always wins over the quote (the pre-fix code priced every
    // equity draft off the quote, ignoring the user's limit).
    const quote = await this.getQuote(params.symbol);
    const orderId = `alp_ord_${crypto.randomUUID().slice(0, 8)}`;
    const userDid = getUserDid(params.sessionId || this.userLogin);
    const action = params.action || params.orderAction || "BUY";
    const orderType = params.orderType || "MARKET";
    const hasUserLimit = Number.isFinite(params.limitPrice) && Number(params.limitPrice) > 0;
    const executionPrice =
      (orderType === "LIMIT" || orderType === "STOP_LIMIT") && hasUserLimit
        ? Number(params.limitPrice)
        : quote.lastPrice;
    const priceSource: OrderPriceSource = hasUserLimit
      ? { kind: "user" }
      : {
          kind: "live-quote",
          provider: quote.source || "Alpaca Real-Time NBBO Feed",
          timestamp: quote.timestamp || new Date().toISOString(),
        };
    const estimatedTotal = Number((executionPrice * params.quantity).toFixed(2));

    const didProof = createDidAttestationSync({
      draftId: orderId,
      action: action.toLowerCase(),
      amount: estimatedTotal,
      currency: "USD",
      customer: `Alpaca:${params.symbol}`,
      gateway: "sandbox",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
    });

    // Issue #3812: percent exits are converted here, against the SAME
    // execution price the draft is priced from (a user limit, or the live
    // quote above). The conversion is deterministic and the receipt
    // carries both the percent and the absolute leg prices.
    const percentRequested =
      params.takeProfitPercent !== undefined || params.stopLossPercent !== undefined;
    if (
      percentRequested &&
      (params.takeProfitPercent === undefined || params.stopLossPercent === undefined)
    ) {
      throw new Error(
        "Bracket percent exits need both takeProfitPercent and stopLossPercent (both or neither).",
      );
    }
    const percentExits = percentRequested
      ? computeBracketExits({
          side: action,
          entryPrice: executionPrice,
          takeProfitPercent: params.takeProfitPercent as number,
          stopLossPercent: params.stopLossPercent as number,
        })
      : null;
    const takeProfit = params.takeProfit ?? percentExits?.takeProfit;
    const stopLoss = params.stopLoss ?? percentExits?.stopLoss;
    const orderClass = params.orderClass || (takeProfit || stopLoss ? "bracket" : undefined);
    const draft: BrokerOrderDraft = {
      orderId,
      symbol: params.symbol.toUpperCase(),
      action,
      orderAction: action,
      orderType,
      orderClass,
      takeProfit,
      stopLoss,
      ...(percentExits
        ? {
            takeProfitPercent: percentExits.takeProfitPercent,
            stopLossPercent: percentExits.stopLossPercent,
          }
        : {}),
      broker: "alpaca",
      quantity: params.quantity,
      estimatedPrice: executionPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission: 0.0,
      estimatedTotal,
      priceSource,
      status: "previewed",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      previewMessage: `Alpaca Order Preview: ${action} ${params.quantity} ${params.symbol} @ ${hasUserLimit ? `$${executionPrice.toFixed(2)} (limit)` : `~$${executionPrice.toFixed(2)}`}. Estimated Total: $${estimatedTotal.toLocaleString()} USD.${orderClass === "bracket" ? ` (bracket: take-profit $${takeProfit?.limitPrice?.toFixed(2) ?? "-"} / stop-loss $${stopLoss?.stopPrice?.toFixed(2) ?? "-"})` : ""}`,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };

    // Issue #3846: persist the preview so an approval by orderId can settle
    // THIS draft (the transcript's `alp_ord_...` had no stored row, so the
    // approval path could only start a job that waited forever). The stored
    // notes carry the bracket legs and the price provenance the placement
    // call must reuse.
    const tradeSession = params.sessionId || this.userLogin;
    const previewNotes = JSON.stringify({
      kind: "alpaca-order-v1",
      orderClass,
      takeProfit,
      stopLoss,
      ...(percentExits
        ? {
            takeProfitPercent: percentExits.takeProfitPercent,
            stopLossPercent: percentExits.stopLossPercent,
          }
        : {}),
      priceSource,
    });
    draft.previewNotes = previewNotes;
    if (this.orm?.trades) {
      try {
        this.orm.trades.create({
          id: orderId,
          sessionId: tradeSession,
          symbol: draft.symbol,
          action,
          orderType,
          quantity: params.quantity,
          price: executionPrice,
          totalValue: estimatedTotal,
          status: "previewed",
          orderRef: orderId,
          proposerDid: didProof.proposerDid,
          authorizerDid: userDid,
          proofSignature: didProof.signature,
          priceSourceJson: encodeOrderPriceSource(priceSource),
          previewNotes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // A store failure must not fabricate an execution; the draft still
        // returns, and executeOrder will refuse an unknown orderId.
      }
    }
    return draft;
  }

  /**
   * Issue #3158 — Alpaca Trading API v2 order placement, wired as the
   * adapter's remote-submit method so broker-routed execute paths that
   * prefer placeOrderRemote pick it up. This method submits only after
   * the caller has passed the approvals door; it performs no approval
   * itself, and it changes nothing about HITL expiry or DID stamping.
   * Equity only: option legs are refused, never submitted. A success
   * is reported only with a broker order id in hand; anything else is
   * a failed result, never a fabricated execution.
   */
  /**
   * Issue #3390: cancel through the same Alpaca client the placement uses, so
   * the broker's own answer (204 / 404 / 422) is reported verbatim and a
   * refusal is never rendered as a cancelled order.
   */
  async cancelOrderRemote(orderId: string | number): Promise<BrokerCancelOrderResult> {
    await this.ready();
    const res = await this.alpacaData.cancelOrder(orderId);
    return {
      success: res.success,
      orderId: res.orderId,
      message: res.message,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Issue #3398 / #3508: truthful session-orders capability for Alpaca.
   * Alpaca supports pre_market (04:00–09:30 ET), regular (09:30–16:00 ET),
   * after_hours (16:00–20:00 ET), and exto (20:00–04:00 ET 24/5 overnight via BOATS ATS).
   */
  supportsSessionOrders(session: string): boolean {
    return (
      session === "pre_market" ||
      session === "regular" ||
      session === "after_hours" ||
      session === "exto"
    );
  }

  async placeOrderRemote(params: PlaceOrderParams): Promise<BrokerOrderExecutionResult> {
    await this.ready();
    const liveRefusal = this.liveTradingRefusal();
    if (liveRefusal) {
      return {
        success: false,
        orderId: params.orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid: getUserDid(params.userLogin),
        status: "failed",
        symbol: (params.symbol || "").trim().toUpperCase(),
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        message: liveRefusal,
        timestamp: new Date().toISOString(),
      } as BrokerOrderExecutionResult;
    }
    const now = new Date().toISOString();
    const userDid = getUserDid(params.userLogin);
    const draft = this.orm?.trades?.findById(params.orderId);
    const attestation = {
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
      signature: draft?.proofSignature ?? "",
    };
    const symbol = (params.symbol || "").trim().toUpperCase();
    const failed = (message: string): BrokerOrderExecutionResult => ({
      success: false,
      orderId: params.orderId,
      executionId: "",
      brokerOrderRef: "",
      authorizerDid: userDid,
      status: "failed",
      symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 0,
      totalSettled: 0,
      didAttestation: attestation,
      message,
      timestamp: now,
    });

    if (params.optionLegs && params.optionLegs.length > 0) {
      // Issue #3329: the strategy Alpaca accepts is a limit mleg order. A
      // missing price or an unnameable leg is refused by name, never guessed.
      let legs: ReturnType<AlpacaTradingPlatform["optionOrderLegs"]>;
      try {
        legs = this.optionOrderLegs(params.optionLegs);
      } catch (error) {
        return failed(error instanceof Error ? error.message + " The order was not placed." : "Alpaca option legs were rejected. The order was not placed.");
      }
      if (!Number.isFinite(params.limitPrice) || Number(params.limitPrice) <= 0) {
        return failed("Alpaca option orders require a positive limit price. The order was not placed.");
      }
      if (!this.alpacaData.isConfigured()) {
        return failed("Alpaca credentials are not configured, so the order was not placed. No funds were moved.");
      }
      const { isLive } = resolveAlpacaTradingBase(this.env, this.overrideEnv);
      const mode = isLive ? "live" : "paper";
      const placed = await this.alpacaData.placeOptionOrder({
        qty: String(params.quantity),
        limit_price: String(params.limitPrice),
        time_in_force: "day",
        legs,
      });
      if (!placed.success || !placed.orderId) {
        return failed(mapAlpacaFailureToBusiness(placed.httpStatus, "order"));
      }
      return {
        success: true,
        orderId: params.orderId,
        executionId: placed.orderId,
        brokerOrderRef: placed.orderId,
        authorizerDid: userDid,
        status: "submitted",
        symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: attestation,
        message: `Alpaca ${mode} multi-leg order submitted: ${legs.length} legs (broker order ${placed.orderId}).`,
        timestamp: now,
      };
    }
    if (!symbol) {
      return failed("Alpaca order rejected: a symbol is required. The order was not placed.");
    }
    if (!Number.isFinite(params.quantity) || params.quantity <= 0) {
      return failed("Alpaca order rejected: quantity must be positive. The order was not placed.");
    }
    const session = params.session;
    const isExtendedSession =
      params.extendedHours === true ||
      session === "pre_market" ||
      session === "after_hours" ||
      session === "exto";

    const side = params.action === "SELL" || params.action === "SELL_SHORT" ? "sell" : "buy";
    const orderType = (params.orderType || "MARKET").toUpperCase();

    // Issue #3508: Venue rule — extended-hours and overnight sessions require limit orders
    if (isExtendedSession && orderType !== "LIMIT") {
      return failed(
        "Alpaca extended-hours and overnight orders require a limit order type. Market orders are not accepted outside regular hours. The order was not placed."
      );
    }

    let type: "market" | "limit";
    let limitPrice: number | undefined;
    if (orderType === "MARKET") {
      type = "market";
    } else if (orderType === "LIMIT") {
      if (!Number.isFinite(params.limitPrice)) {
        return failed("Alpaca limit order rejected: a limit price is required. The order was not placed.");
      }
      type = "limit";
      limitPrice = params.limitPrice;
    } else {
      return failed(`Alpaca supports market and limit equity orders in this client; order type ${orderType} was not placed.`);
    }
    if (!this.alpacaData.isConfigured()) {
      return failed("Alpaca credentials are not configured, so the order was not placed. No funds were moved.");
    }

    const { isLive } = resolveAlpacaTradingBase(this.env, this.overrideEnv);
    const mode = isLive ? "live" : "paper";
    // Issue #3782: the trade workflow attaches provenance before the
    // broker call — the caller's explicit source wins, otherwise the
    // stored draft's (persisted at preview time as JSON). A limit
    // price with neither is refused inside placeOrder, before any POST.
    const priceSource = params.priceSource ?? decodeOrderPriceSource(draft?.priceSourceJson);
    const placed = await this.alpacaData.placeOrder({
      symbol,
      qty: params.quantity,
      side,
      type,
      ...(limitPrice !== undefined ? { limit_price: limitPrice } : {}),
      ...(priceSource !== undefined ? { priceSource } : {}),
      time_in_force: (params.timeInForce as any) || "day",
      ...(isExtendedSession ? { extended_hours: true } : {}),
      ...(params.orderClass ? { order_class: params.orderClass } : {}),
      ...(params.takeProfit?.limitPrice !== undefined
        ? { take_profit: { limit_price: params.takeProfit.limitPrice } }
        : {}),
      ...(params.stopLoss?.stopPrice !== undefined
        ? {
            stop_loss: {
              stop_price: params.stopLoss.stopPrice,
              ...(params.stopLoss.limitPrice !== undefined ? { limit_price: params.stopLoss.limitPrice } : {}),
            },
          }
        : {}),
    });
    if (!placed.success || !placed.orderId) {
      if (placed.success) {
        return failed("Alpaca did not return an order reference, so the order is not confirmed. No funds were moved.");
      }
      // HTTP 200 without an order id is an unconfirmed outcome, not a
      // rejection: the broker answered but gave nothing to track.
      if (placed.httpStatus === 200) {
        return failed("Alpaca did not return an order reference, so the order is not confirmed. No funds were moved.");
      }
      return failed(mapAlpacaFailureToBusiness(placed.httpStatus, "order"));
    }
    return {
      success: true,
      orderId: params.orderId,
      executionId: placed.orderId,
      brokerOrderRef: placed.orderId,
      authorizerDid: userDid,
      // Submitted, not filled: Alpaca accepted the order and a fill
      // has not been confirmed. Nothing is reported as settled.
      status: "submitted",
      symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 0,
      totalSettled: 0,
      didAttestation: attestation,
      message: `Alpaca ${mode} order submitted: ${side} ${params.quantity} ${symbol} (broker order ${placed.orderId}).`,
      timestamp: now,
    };
  }

  async executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected"): Promise<BrokerOrderExecutionResult> {
    const now = new Date().toISOString();
    // Issue #3846: approval settles the STORED preview through the same
    // placement client `alpaca_place_order` uses. A missing/expired draft
    // or a non-previewed status is refused; nothing is fabricated.
    const record = this.orm?.trades?.findById(orderId);
    const symbol = record?.symbol ?? "";
    const action = record?.action ?? "BUY";
    const quantity = record?.quantity ?? 0;
    const proofSignature = record?.proofSignature ?? "";

    if (decision === "rejected") {
      if (record && this.orm?.trades) {
        this.orm.trades.update(orderId, {
          status: "rejected",
          authorizerDid,
          updatedAt: now,
        });
      }
      return {
        success: false,
        orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid,
        status: "rejected",
        symbol,
        action,
        quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          signature: proofSignature,
        },
        message: `Alpaca order ${orderId} rejected by human authorizer (${authorizerDid}).`,
        timestamp: now,
      };
    }

    if (!record) {
      return {
        success: false,
        orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid,
        status: "failed",
        symbol,
        action,
        quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          signature: "",
        },
        message: `Alpaca order draft '${orderId}' was not found. Nothing was executed; preview the order first.`,
        timestamp: now,
      };
    }
    if (record.status !== "previewed") {
      return {
        success: false,
        orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid,
        status: "failed",
        symbol,
        action,
        quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          signature: proofSignature,
        },
        message: `Alpaca order draft '${orderId}' is '${record.status}', not 'previewed'. Only a previewed draft may execute.`,
        timestamp: now,
      };
    }

    let notes: Record<string, any> = {};
    try {
      notes = typeof record.previewNotes === "string" ? JSON.parse(record.previewNotes) : {};
    } catch {
      notes = {};
    }
    const priceSource = decodeOrderPriceSource((record as any).priceSourceJson);
    const execution = await this.placeOrderRemote({
      orderId,
      symbol: record.symbol,
      action: record.action as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT",
      quantity: record.quantity,
      orderType: record.orderType,
      limitPrice: record.price,
      priceSource,
      userLogin: this.userLogin,
      ...(notes.orderClass === "bracket"
        ? {
            orderClass: "bracket" as const,
            ...(notes.takeProfit ? { takeProfit: notes.takeProfit } : {}),
            ...(notes.stopLoss ? { stopLoss: notes.stopLoss } : {}),
          }
        : {}),
      ...(notes.takeProfitPercent !== undefined ? { timeInForce: "day" as const } : {}),
    });

    if (execution.success) {
      if (this.orm?.trades) {
        this.orm.trades.update(orderId, {
          status: "submitted",
          orderRef: execution.brokerOrderRef,
          updatedAt: now,
        });
      }
      return {
        ...execution,
        orderId,
        authorizerDid,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          signature: proofSignature,
        },
      };
    }
    return {
      ...execution,
      orderId,
      authorizerDid,
      didAttestation: {
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        signature: proofSignature,
      },
    };
  }
}
