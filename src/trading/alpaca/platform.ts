/**
 * Alpaca Trading Platform Adapter
 *
 * Implements ITradingPlatform for Alpaca Trading API v2
 */

import type { Env, BrokerQuote, BrokerAccount, BrokerPosition, BrokerPositionLot, BrokerOrderDraft, BrokerOrderExecutionResult, BrokerStatus, BrokerOptionChain, BrokerOptionContract, BrokerOptionExpireDate, StockScreenerFilter, StockScreenResult } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ITradingPlatform, OrderPreviewParams, PlaceOrderParams } from "../interfaces";
import { BROKER_CATALOG, type TradingType } from "../brokerCatalog";
import { deriveLotsFromFills, parseAlpacaFill, type DerivedLots } from "./fillLots";
import { NeutralMarketScreener } from "../neutralMarketScreener";
import { platformQuoteSource } from "../stockQuoteSource";
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
export function resolveAlpacaTradingBase(
  env: Env,
  overrideEnv?: string,
): { baseUrl: string; isLive: boolean; source: "pin" | "selection" | "inference" } {
  // Issue #3233: an explicit trading type wins over inference. Without it the
  // legacy rule stands (paper host = paper), so nothing silently changes for
  // an environment that only sets ALPACA_BASE_URL.
  const explicit = String(env.ALPACA_TRADING_TYPE ?? "").trim().toLowerCase();
  if (explicit === "paper") {
    return { baseUrl: "https://paper-api.alpaca.markets", isLive: false, source: "pin" };
  }
  if (explicit === "live") {
    const configured = env.ALPACA_BASE_URL;
    const liveUrl = configured && !configured.includes("paper-api") ? configured : "https://api.alpaca.markets";
    return { baseUrl: liveUrl, isLive: true, source: "pin" };
  }
  // Issue #3272: the persisted selection is authoritative when the deployment
  // has not pinned a trading type. TEST means paper, PROD means live - the
  // same mapping the catalog declares for every broker (#3232), so the hub
  // switch now means the same thing on both brokers instead of being an
  // E*TRADE-only control that Alpaca silently ignored.
  const selection = String(overrideEnv ?? "").trim().toUpperCase();
  if (selection === "TEST") {
    return { baseUrl: "https://paper-api.alpaca.markets", isLive: false, source: "selection" };
  }
  if (selection === "PROD") {
    const configured = env.ALPACA_BASE_URL;
    const liveUrl = configured && !configured.includes("paper-api") ? configured : "https://api.alpaca.markets";
    return { baseUrl: liveUrl, isLive: true, source: "selection" };
  }
  const baseUrl = env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  return { baseUrl, isLive: !baseUrl.includes("paper-api"), source: "inference" };
}

/**
 * Issue #3158 — upstream failures map to business errors. The HTTP
 * status classifies the failure; the upstream message body is NEVER
 * surfaced (it carries technical text and, for HTML error pages, raw
 * markup). A missing status means the request never reached Alpaca.
 */
function mapAlpacaFailureToBusiness(
  httpStatus: number | undefined,
  operation: "order" | "account" | "positions",
): string {
  const subject =
    operation === "order"
      ? "the order was not placed"
      : operation === "account"
        ? "account data is unavailable"
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

function mapAlpacaPosition(raw: any): BrokerPosition {
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
  return {
    symbol,
    description: `${symbol} (Alpaca)`,
    quantity: finiteAlpacaNumber(raw.qty, "qty"),
    securityType: assetClass === "us_equity" ? "EQ" : assetClass,
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
    this.alpacaData = new AlpacaMarketDataProvider(env);
  }

  async getStatus(): Promise<BrokerStatus> {
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
      hasApiKey: configured,
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
  async derivePositionLots(positionId: string | number): Promise<DerivedLots> {
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

  async previewOrder(params: OrderPreviewParams): Promise<BrokerOrderDraft> {
    if (params.assetClass === "options" || params.optionLegs?.some((leg) => leg.securityType === "OPTN")) {
      throw new Error("This broker adapter currently supports equity orders only. Options orders require a broker adapter with native options preview support.");
    }
    const quote = await this.getQuote(params.symbol);
    const orderId = `alp_ord_${crypto.randomUUID().slice(0, 8)}`;
    const userDid = getUserDid(params.sessionId || this.userLogin);
    const action = params.action || params.orderAction || "BUY";
    const estimatedTotal = Number((quote.lastPrice * params.quantity).toFixed(2));

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

    return {
      orderId,
      symbol: params.symbol.toUpperCase(),
      action,
      orderAction: action,
      orderType: params.orderType || "MARKET",
      quantity: params.quantity,
      estimatedPrice: quote.lastPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission: 0.0,
      estimatedTotal,
      status: "previewed",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      previewMessage: `Alpaca Order Preview: ${action} ${params.quantity} ${params.symbol} @ ~$${quote.lastPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD.`,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };
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
  async placeOrderRemote(params: PlaceOrderParams): Promise<BrokerOrderExecutionResult> {
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
      return failed("Alpaca supports equity orders only in this client. Options orders require a broker adapter with native options support, so this order was not placed.");
    }
    if (!symbol) {
      return failed("Alpaca order rejected: a symbol is required. The order was not placed.");
    }
    if (!Number.isFinite(params.quantity) || params.quantity <= 0) {
      return failed("Alpaca order rejected: quantity must be positive. The order was not placed.");
    }
    const side = params.action === "SELL" || params.action === "SELL_SHORT" ? "sell" : "buy";
    const orderType = (params.orderType || "MARKET").toUpperCase();
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
    const placed = await this.alpacaData.placeOrder({
      symbol,
      qty: params.quantity,
      side,
      type,
      ...(limitPrice !== undefined ? { limit_price: limitPrice } : {}),
      time_in_force: "day",
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
    // #2389: this adapter has no order-placement client (market data
    // only), so it can never execute. The previous implementation
    // returned a hardcoded "executed" NVDA result on approval —
    // fabricated terms, fabricated references, fabricated signature.
    // Approval now returns an honest not-executed failure; rejection
    // still rejects the stored draft. Nothing here mints a reference
    // or claims a fill the broker never made.
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
      message: `Alpaca execution is not wired on this adapter: no Alpaca order-placement client is connected, so order ${orderId} was NOT executed. No funds were moved.`,
      timestamp: now,
    };
  }
}
