/**
 * Alpaca Trading Platform Adapter
 *
 * Implements ITradingPlatform for Alpaca Trading API v2
 */

import type { Env, ETradeQuote, ETradeAccount, ETradePosition, ETradeOrderDraft, ETradeOrderExecutionResult, ETradeBrokerStatus } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ITradingPlatform, OrderPreviewParams, PlaceOrderParams } from "../interfaces";
import { AlpacaMarketDataProvider } from "../../services/marketDataResearch";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";

/**
 * Issue #3158 — single paper/live resolver for the Alpaca adapter.
 * The default base URL is the paper host; a base URL counts as live
 * only when it is set and is not a paper host. The trading client
 * (AlpacaMarketDataProvider.getTradingUrl) uses the same default, so
 * status and placement can never disagree about paper vs live.
 */
function resolveAlpacaTradingBase(env: Env): { baseUrl: string; isLive: boolean } {
  const baseUrl = env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  return { baseUrl, isLive: !baseUrl.includes("paper-api") };
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

function mapAlpacaAccount(raw: any, isLive: boolean): ETradeAccount {
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

function mapAlpacaPosition(raw: any): ETradePosition {
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

  constructor(private env: Env, private orm: DatabaseORM | undefined, private userLogin: string) {
    // Issue #1185: per-user platform — an explicit login is required.
    if (!userLogin) {
      throw new Error("AlpacaTradingPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    this.alpacaData = new AlpacaMarketDataProvider(env);
  }

  async getStatus(): Promise<ETradeBrokerStatus> {
    const hasKey = Boolean(this.env.ALPACA_API_KEY || this.env.ALPACA_API_KEY_ID);
    const hasSecret = Boolean(this.env.ALPACA_SECRET_KEY || this.env.ALPACA_API_SECRET_KEY);
    const configured = hasKey && hasSecret;
    const { baseUrl, isLive } = resolveAlpacaTradingBase(this.env);

    return {
      broker: "alpaca",
      name: this.name,
      configured,
      mode: isLive ? "live_oauth" : "sandbox_api",
      protocol: isLive ? "etrade_oauth_rest" : "sandbox_simulated",
      environment: isLive ? "live" : "sandbox",
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

  async getQuote(symbol: string): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    const snap = await this.alpacaData.getQuote(cleanSym);

    // Issue #1555 (parent #913): pass through, never fabricate. The
    // Alpaca snapshot carries price/bid/ask/volume/OHLC only — it has
    // no peRatio, marketCap, 52-week, or RSI. Those ETradeQuote
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

  async getAccounts(): Promise<ETradeAccount[]> {
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
    return [mapAlpacaAccount(res.account, resolveAlpacaTradingBase(this.env).isLive)];
  }

  async getPositions(): Promise<{ account: ETradeAccount; positions: ETradePosition[] }> {
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

  async previewOrder(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
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
  async placeOrderRemote(params: PlaceOrderParams): Promise<ETradeOrderExecutionResult> {
    const now = new Date().toISOString();
    const userDid = getUserDid(params.userLogin);
    const draft = this.orm?.trades?.findById(params.orderId);
    const attestation = {
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
      signature: draft?.proofSignature ?? "",
    };
    const symbol = (params.symbol || "").trim().toUpperCase();
    const failed = (message: string): ETradeOrderExecutionResult => ({
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

    const { isLive } = resolveAlpacaTradingBase(this.env);
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

  async executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected"): Promise<ETradeOrderExecutionResult> {
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
