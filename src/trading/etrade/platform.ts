/**
 * E*TRADE Trading Platform Adapter
 *
 * Implements:
 * - Strategy Pattern (GoF): Concrete implementation of ITradingPlatform for E*TRADE Securities.
 * - Resilience: Real E*TRADE REST API execution with graceful fallback to live market data feeds.
 * - Human-in-the-Loop (HITL) Execution Safety with W3C Agent DID Attestations.
 */

import type { Env, ETradeQuote, ETradeAccount, ETradePosition, ETradePositionLot, ETradeOrderDraft, ETradeOrderExecutionResult, ETradeBrokerStatus, StockScreenerFilter, StockScreenResult, ETradeOptionChain, ETradeOptionExpireDate, BrokerCancelOrderResult } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ExpectedTradeTerms, ITradingPlatform, OrderPreviewParams } from "../interfaces";
import { etradeOrderKind, validateTradingOrderLegs } from "./optionOrders";
import { ETradeRestClient } from "./client";
import { isStubQuote } from "../quotePolicies";
import { DynamicMarketScreener } from "../screener";
import {
  nasdaqUniverseSeamFromSql,
  type NasdaqUniverseSeam,
} from "../screenerPipeline";
import type { DataProviderPorts } from "../../data/buildDataProviderPorts";
import { buildRegisteredDataProviderPorts } from "../../data/dataProviderPortsProvider";
import { resolveEnvironmentConfig } from "../../config/environment";
import {
  levelsForQuoteSwitch,
  resolveQuoteEtradeUnknownMode,
  type QuoteScopedModes,
} from "../../config/quoteModes";
import { getCuratedStockBySymbol } from "../../config/curatedStockUniverse";
import { getETradeAuthStatus, etradeIdentityFromLogin } from "../../security/etradeOAuth";
import { parseStrategyOrder } from "../../agents/routes/orderPayloadHash";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";
import { computeBracketExits } from "../bracketPercent";

/**
 * Quote provenance (issue #118, audit F12/F13).
 *
 * A quote may only be stamped "REALTIME" when it was fetched from the live
 * E*TRADE REST API in this call. Every static fallback — the curated stock
 * universe table or a cached screener-universe entry — must say so in its
 * quoteStatus/source instead of impersonating the live feed.
 */
export const STATIC_FALLBACK_QUOTE_STATUS = "STATIC_FALLBACK";
export const STATIC_CURATED_QUOTE_SOURCE = "Static curated stock universe table (not live market data)";
export const CACHED_UNIVERSE_QUOTE_SOURCE = "E*TRADE Market Universe (cached screener universe — not a live quote)";

/** True only when the quote was fetched live from the broker in this call. */
export function isLiveQuoteStatus(quoteStatus?: string): boolean {
  return quoteStatus === "REALTIME";
}

/**
 * True when a quote carries no live price at all (static table fallback or
 * unavailable), so anything priced from it must be flagged, never presented
 * as priced from live market data.
 */
export function isNonLivePricingQuoteStatus(quoteStatus?: string): boolean {
  return quoteStatus === STATIC_FALLBACK_QUOTE_STATUS || quoteStatus === "AUTH_REQUIRED";
}

/** Disclosure appended to order previews priced from a non-live quote. */
export function nonLivePricingNotice(quoteStatus?: string): string {
  return `⚠ PRICED FROM A NON-LIVE QUOTE (${quoteStatus}): live E*TRADE quote unavailable — the estimated price uses static fallback data, not live market data. Verify the price before authorizing.`;
}

export class ETradeTradingPlatform implements ITradingPlatform {
  readonly platformId = "etrade" as const;
  readonly name = "E*TRADE by Morgan Stanley Brokerage";
  private client: ETradeRestClient;
  private screener: DynamicMarketScreener;

  constructor(
    private env: Env,
    private orm: DatabaseORM | undefined,
    private userLogin: string,
    private overrideEnv?: string,
    existingClient?: ETradeRestClient,
    private storage?: import("../screenerPipeline").NasdaqUniverseRouteBundleInput["storage"]
  ) {
    // Issue #1185: per-user platform — an explicit login is required.
    if (!userLogin) {
      throw new Error("ETradeTradingPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    this.client = existingClient || new ETradeRestClient(env, userLogin, overrideEnv);
    this.screener = new DynamicMarketScreener();
  }

  /**
   * #2303 (#1976 step 1): the data-provider platform ports for
   * the internally built universe seam — built lazily from env
   * (AGENT_DB) via the shared production build, memoized per
   * platform instance; unbound → the seam keeps its sql path.
   */
  private dataProviderPortsPromise?: Promise<DataProviderPorts>;

  private dataProviderPorts(): Promise<DataProviderPorts> {
    if (!this.dataProviderPortsPromise) {
      // The ports builder is resolved through the registered
      // provider (src/data/dataProviderPortsProvider): this
      // module is reachable from the client bundle through the
      // trading barrel, and the builder's graph (D1 adapters
      // → transaction aspect → node:async_hooks) is
      // server-only, so it cannot be imported here, statically
      // or dynamically. The worker entry registers the real
      // builder; unregistered contexts resolve to null ports
      // and the seam keeps its legacy path.
      this.dataProviderPortsPromise =
        buildRegisteredDataProviderPorts(this.env);
    }
    return this.dataProviderPortsPromise;
  }

  public getLastError(): string | undefined {
    return this.client.getLastError();
  }

  /**
   * Issue #2386: the session identity for this platform's login,
   * resolved from its alias record. The platform already trusts
   * userLogin for every token read it makes, so resolving that
   * login's alias record is the same principal, not a trust
   * expansion. No record (or a store blip) yields an empty
   * identity: the read falls back to login keys, as before.
   * Resolved fresh per call — a rename updates the alias record,
   * and a cached identity could outlive it.
   */
  private resolveTokenIdentity() {
    return etradeIdentityFromLogin(this.env, this.userLogin);
  }

  public getEnvConfig() {
    return resolveEnvironmentConfig(this.env, this.overrideEnv);
  }

  async getStatus(): Promise<ETradeBrokerStatus> {
    const envConfig = this.getEnvConfig();
    const isMcp = Boolean(this.env.ETRADE_MCP_SERVER_URL);
    const hasApiKey = Boolean(envConfig.etrade.apiKey && envConfig.etrade.apiSecret);
    const configured = isMcp || hasApiKey;

    const mode = isMcp
      ? "mcp_remote"
      : hasApiKey
      ? (envConfig.isLive ? "live_oauth" : "sandbox_api")
      : "simulated_engine";

    const protocol = isMcp ? "mcp_json_rpc" : hasApiKey ? "etrade_oauth_rest" : "sandbox_simulated";
    const authStatus = await getETradeAuthStatus(this.env, this.userLogin, this.overrideEnv, await this.resolveTokenIdentity()).catch(() => ({
      authenticated: false,
      storedAt: undefined,
      renewable: false,
      environment: envConfig.name,
    }));

    return {
      broker: "etrade",
      name: this.name,
      configured,
      mode,
      protocol,
      mcpServerUrl: this.env.ETRADE_MCP_SERVER_URL,
      environment: envConfig.isLive ? "live" : "sandbox",
      activeEnvironment: envConfig.name,
      apiUrl: envConfig.etrade.baseUrl,
      hasApiKey,
      oauthAuthenticated: authStatus.authenticated,
      oauthExpiresAtEt: authStatus.storedAt,
      oauthRenewable: authStatus.renewable,
      capabilities: [
        "Natural Language Market Screener (NLQ)",
        "Dynamic All-Exchange Stock Listings (Nasdaq, NYSE, AMEX)",
        "Listing-Based Stock Screening with Explicit Price/Cap/Change Filters",
        "Real-Time Level 1 Quotes & Order Depth",
        "Agent DID Attestation Order Stamping",
        "Human-in-the-Loop (HITL) Execution Safety Guarantee",
        "Portfolio Positions & Purchasing Power",
        "Options Data Agent: Chain Screener with Freshness-Tagged OSI Contracts",
        "Strategy & Risk Agent: Multi-Leg Builder, Risk Engine & Strategy Screener",
        "Recommendation Agent: Risk-Profile Ranking & Best-Trade Picker",
        "Dynamic Multi-Broker Capability Architecture",
      ],
    };
  }

  async getQuote(
    symbol: string,
    // #1725 (M7): QUOTE_ETRADE_UNKNOWN_MODE, default "throw" (the
    // #294 fail-fast legacy). Under "zero-object" the unknown tail
    // returns the AUTH_REQUIRED zero-price object (the service sync
    // legacy shape) instead of throwing. The #922 curated-live throw
    // above precedes this tail and stands in every mode. Method opts
    // carry the run level + session/user carriers; the global env
    // level reads from this.env.
    opts?: { unknownMode?: unknown; scoped?: QuoteScopedModes },
  ): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();

    // 1. Direct E*TRADE REST API call
    try {
      const live = await this.client.fetchQuote(cleanSym);
      if (live && live.lastPrice > 0) {
        if (!isStubQuote(live, cleanSym)) return live;
      }
    } catch {
      // Ignore
    }

    // 2. Cached screener-universe entry. This is NOT a fresh live fetch, so in
    // the live environment it must keep the entry's own provenance (or be
    // stamped STATIC_FALLBACK) — never upgraded to REALTIME / "Live Market
    // Feed" (issue #118, audit F12).
    const found = this.screener.getUniverse().find((s) => s.symbol === cleanSym);
    if (found) {
      const envConfig = this.getEnvConfig();
      if (!envConfig.isLive) {
        return {
          ...found,
          price: found.lastPrice,
          high52: found.week52High,
          low52: found.week52Low,
          quoteStatus: "SIMULATED_LEVEL1",
          source: "E*TRADE Market Universe Feed",
        };
      }
      return {
        ...found,
        price: found.lastPrice,
        high52: found.week52High,
        low52: found.week52Low,
        quoteStatus: found.quoteStatus ?? STATIC_FALLBACK_QUOTE_STATUS,
        source: found.source ?? CACHED_UNIVERSE_QUOTE_SOURCE,
      };
    }

    // 3. Static curated-universe table price. Only the table's own price is
    // real data; bid/ask/volume/52-week range are NOT invented (zeroed), and
    // in the live environment the quote is stamped STATIC_FALLBACK with a
    // source naming the static table (issue #118, audit F12).
    const curated = getCuratedStockBySymbol(cleanSym);
    if (curated) {
      const envConfig = this.getEnvConfig();
      // Issue #922 ([#913 S4]): in the live environment a curated-table
      // hit is NOT served as a STATIC_FALLBACK quote — fail explicit
      // instead, mirroring the #294 unknown-symbol fail-fast below. No
      // curated static price, no fresh timestamp over static data, and no
      // substitute numbers are served. Non-live environments keep the
      // labeled simulated path below.
      if (envConfig.isLive) {
        throw new Error(
          `E*TRADE live quote unavailable for ${cleanSym}: no live quote was returned and the curated static price is not served in the live environment (issue #922)`
        );
      }
      const price = curated.defaultPrice ?? 100.0;
      return {
        symbol: cleanSym,
        companyName: curated.companyName,
        lastPrice: price,
        price,
        change: 0,
        changePercent: 0,
        bid: 0,
        ask: 0,
        volume: 0,
        open: price,
        high: price,
        low: price,
        week52High: 0,
        week52Low: 0,
        marketCap: curated.marketCap,
        quoteStatus: envConfig.isLive ? STATIC_FALLBACK_QUOTE_STATUS : "SIMULATED_LEVEL1",
        source: envConfig.isLive ? STATIC_CURATED_QUOTE_SOURCE : "E*TRADE Market Universe Feed",
        timestamp: new Date().toISOString(),
      };
    }

    const envConfig = this.getEnvConfig();
    // Issue #294: Fail fast with auth error instead of returning a zero-price
    // stub. The stub masked auth failures as "api-zero-price", hiding the real
    // root cause. Throwing ensures correct categorization as "auth".
    // #1725: under QUOTE_ETRADE_UNKNOWN_MODE "zero-object", return
    // the zero-price AUTH_REQUIRED object instead (the service sync
    // legacy shape) — same fields, same stamp, no priced value.
    const unknownMode = resolveQuoteEtradeUnknownMode(
      levelsForQuoteSwitch(opts?.scoped, opts?.unknownMode, this.env?.QUOTE_ETRADE_UNKNOWN_MODE),
      "throw"
    ).mode;
    if (unknownMode === "zero-object") {
      return {
        symbol: cleanSym,
        companyName: `${cleanSym} Inc.`,
        lastPrice: 0.0,
        price: 0.0,
        change: 0,
        changePercent: 0,
        bid: 0.0,
        ask: 0.0,
        volume: 0,
        open: 0.0,
        high: 0.0,
        low: 0.0,
        week52High: 0.0,
        week52Low: 0.0,
        quoteStatus: "AUTH_REQUIRED",
        timestamp: new Date().toISOString(),
        source: "E*TRADE Market Data Feed",
      };
    }
    throw new Error(
      `E*TRADE auth required for ${cleanSym}: no valid OAuth tokens available ` +
      `(quoteStatus=AUTH_REQUIRED, env=${envConfig.name})`
    );
  }

  /**
   * Issue #1378: threads the universe seam to screenLive (same
   * contract as ETradeService.screenMarketsAsync: a
   * caller-supplied seam wins, otherwise an outcome-only bundle
   * is built internally from the platform's ORM when present).
   */
  async screenMarkets(
    filter: StockScreenerFilter = {},
    seam?: NasdaqUniverseSeam
  ): Promise<StockScreenResult> {
    const resolved =
      seam ??
      (await nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin, this.storage, await this.dataProviderPorts()));
    return this.screener.screenLive(filter, resolved);
  }

  async getAccounts(): Promise<ETradeAccount[]> {
    const realAccounts = await this.client.fetchAccounts();
    return realAccounts;
  }

  async getPositionLots(accountKey: string, positionId: string): Promise<ETradePositionLot[]> {
    return this.client.fetchPositionLots(accountKey, positionId);
  }

  // Options data reads (#291 T5b): verbatim client passthroughs, matching
  // ETradeService's getOptionChains/getOptionExpireDates semantics exactly.
  async getOptionChains(params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    noOfStrikes?: number;
    includeWeekly?: boolean;
    chainType?: "CALL" | "PUT" | "CALLPUT";
    includeRawResponse?: boolean;
  }, requestBudget?: import("../interfaces").OptionRequestBudget): Promise<ETradeOptionChain | null> {
    return requestBudget ? this.client.getOptionChains(params, requestBudget) : this.client.getOptionChains(params);
  }

  async getOptionExpireDates(symbol: string, expiryType?: string, requestBudget?: import("../interfaces").OptionRequestBudget): Promise<ETradeOptionExpireDate[]> {
    return requestBudget
      ? this.client.getOptionExpireDates(symbol, expiryType, requestBudget)
      : this.client.getOptionExpireDates(symbol, expiryType);
  }

  /** Verbatim client passthrough — see ITradingPlatform.getQuoteDetailed. */
  async getQuoteDetailed(symbol: string): Promise<{ quote: ETradeQuote | null; error: string | null }> {
    return this.client.fetchQuoteDetailed(symbol);
  }

  async getPositions(accountKey?: string, includeBalance: boolean = false): Promise<{ account: ETradeAccount; positions: ETradePosition[] }> {
    const realPortfolio = await this.client.fetchPortfolio(accountKey, includeBalance);
    if (realPortfolio) return realPortfolio;

    const accounts = await this.getAccounts();
    const envConfig = this.getEnvConfig();
    if (accounts.length > 0) {
      const acc = accounts[0];
      const bal = includeBalance ? await this.client.fetchBalance(acc.accountKey || acc.accountId).catch(() => null) : null;
      return {
        account: {
          ...acc,
          netAccountValue: bal?.netAccountValue ?? acc.netAccountValue,
          totalAccountValue: bal?.netAccountValue ?? acc.totalAccountValue,
          cashAvailableForInvestment: bal?.cashBuyingPower ?? acc.cashAvailableForInvestment,
          marginBuyingPower: bal?.marginBuyingPower ?? acc.marginBuyingPower,
        },
        positions: [],
      };
    }

    const account = {
      accountId: "unconnected",
      accountKey: "unconnected",
      accountDesc: `E*TRADE Brokerage Account [${envConfig.label} - Unauthenticated]`,
      accountType: "CASH",
      netAccountValue: 0,
      totalAccountValue: 0,
      cashAvailableForInvestment: 0,
      dayTraderStatus: false,
    };

    return { account, positions: [] };
  }

  async previewOrder(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
    const symbol = params.symbol.trim().toUpperCase();
    const action = (params.action || params.orderAction || "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
    const optionLegs = params.optionLegs || [];
    const isOptionsOrder = params.assetClass === "options" || optionLegs.some((leg) => leg.securityType === "OPTN");
    const assetClass = params.assetClass || (isOptionsOrder ? "options" : "equity");
    if (params.assetClass === "options" && !optionLegs.some((leg) => leg.securityType === "OPTN")) {
      throw new Error("Options orders require at least one option contract leg.");
    }
    if (params.assetClass === "equity" && optionLegs.some((leg) => leg.securityType === "OPTN")) {
      throw new Error("Option contract legs cannot be previewed as an equity order.");
    }
    // A complex options preview is priced from its net limit and option legs;
    // requiring an underlying equity quote here could block valid option orders.
    const quote = isOptionsOrder || optionLegs.length ? undefined : await this.getQuote(symbol);
    const legsError = validateTradingOrderLegs(optionLegs, symbol);
    if (legsError) throw new Error(legsError);
    if (isOptionsOrder && (!Number.isFinite(params.strategyNetDebit) || params.orderType !== "LIMIT" || !Number.isFinite(params.limitPrice) || Number(params.limitPrice) <= 0)) {
      throw new Error("Options strategies require a finite net debit/credit and a positive limit price for broker preview.");
    }
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = params.sessionId || this.userLogin;
    const userDid = getUserDid(sessionId);
    const orderType = params.orderType || "MARKET";

    let executionPrice = orderType === "LIMIT" && params.limitPrice ? params.limitPrice : quote?.lastPrice ?? 0;
    let estimatedTotal = Number((executionPrice * params.quantity).toFixed(2));
    if (optionLegs.length) {
      const hasOptions = optionLegs.some((leg) => leg.securityType === "OPTN");
      const shareQuantity = optionLegs.filter((leg) => leg.securityType === "EQ").reduce((total, leg) => total + leg.quantity, 0);
      executionPrice = params.limitPrice ?? Math.abs(params.strategyNetDebit || 0) / (hasOptions ? 100 : Math.max(shareQuantity, 1));
      estimatedTotal = Number((executionPrice * (hasOptions ? params.quantity * 100 : shareQuantity)).toFixed(2));
    }
    // Issue #3839: percent bracket exits. E*TRADE has no native bracket
    // placement in this client, so the preview carries the computed legs;
    // executeOrder refuses a bracket draft rather than placing a parent
    // with unprotected children. Options brackets are not a supported shape.
    const percentRequested =
      params.takeProfitPercent !== undefined || params.stopLossPercent !== undefined;
    if (percentRequested && optionLegs.length > 0) {
      throw new Error("Percent bracket exits are supported for equity orders only; option strategies price their own legs.");
    }
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

    let estimatedCommission = 0.0;
    let upstreamPreviewId: string | undefined;
    let brokerNotice: string | undefined;
    const brokerOrderType = optionLegs.length ? etradeOrderKind(optionLegs) : "EQ";

    // Check if authentic E*TRADE REST credentials exist and user is authenticated
    // Issue #2386: same identity-aware seam as the broker flag, so the
    // preview gate and the panel label cannot disagree for one session.
    const envConfig = this.getEnvConfig();
    const hasKeys = Boolean(envConfig.etrade.apiKey && envConfig.etrade.apiSecret);
    const authStatus = await getETradeAuthStatus(this.env, this.userLogin, this.overrideEnv, await this.resolveTokenIdentity()).catch(() => ({ authenticated: false }));

    // Never create a local/simulated options draft from modeled client prices.
    // A strategy order must be previewed by the connected broker using its
    // current market data before it can enter the human-approval flow.
    if (isOptionsOrder && (!hasKeys || !authStatus.authenticated)) {
      throw new Error("Connect and authorize E*TRADE to preview option strategies with current broker market data. No simulated option preview is available.");
    }

    if (hasKeys && authStatus.authenticated) {
      try {
        const upstreamPreview = await this.client.previewOrder(undefined, {
          orderId,
          symbol,
          action,
          quantity: params.quantity,
          orderType,
          limitPrice: params.limitPrice,
          stopPrice: params.stopPrice,
          optionLegs,
          strategyNetDebit: params.strategyNetDebit,
        });

        if (upstreamPreview) {
          if (optionLegs.length && !upstreamPreview.previewId) {
            throw new Error(upstreamPreview.message || "E*TRADE did not provide a valid complex-order preview identifier. Nothing was submitted.");
          }
          if (upstreamPreview.previewId) {
            upstreamPreviewId = String(upstreamPreview.previewId);
          }
          if (upstreamPreview.estimatedCommission !== undefined) {
            estimatedCommission = upstreamPreview.estimatedCommission;
          }
          if (upstreamPreview.estimatedTotal !== undefined && upstreamPreview.estimatedTotal > 0) {
            estimatedTotal = upstreamPreview.estimatedTotal;
            executionPrice = Number((estimatedTotal / (params.quantity || 1)).toFixed(2));
          }
          if (upstreamPreview.message) {
            brokerNotice = upstreamPreview.message;
          }
        } else {
          brokerNotice = this.client.getLastError() || undefined;
          if (optionLegs.length) throw new Error(`E*TRADE did not return a valid preview for this strategy: ${brokerNotice || "preview unavailable"}`);
        }
      } catch (err: any) {
        if (optionLegs.length) throw err;
        console.warn("[ETradePlatform] upstream previewOrder notice:", err);
      }
    }

    const didProof = createDidAttestationSync({
      draftId: orderId,
      action: action.toLowerCase(),
      amount: estimatedTotal,
      currency: "USD",
      customer: `E*TRADE:${symbol}`,
      gateway: envConfig.isLive ? "etrade_live" : "sandbox",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
    });

    // Issue #118: an equity preview priced from a static fallback (or
    // unavailable) quote must disclose that in the message itself — it must
    // never read as priced from live market data.
    const pricingQuoteStatus = quote?.quoteStatus;
    const previewMessage = optionLegs.length
      ? `E*TRADE ${brokerOrderType} Preview: ${params.quantity} strategy unit(s) of ${symbol} @ ${params.limitPrice ? `$${params.limitPrice.toFixed(2)} net` : "market"}. Estimated total: $${estimatedTotal.toLocaleString()} USD. No order has been placed; human approval is required.`
      : `E*TRADE Order Preview: ${action} ${params.quantity} ${symbol} @ ${orderType === "MARKET" ? "MKT (~$" + quote!.lastPrice.toFixed(2) + ")" : "$" + executionPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD.${orderClass === "bracket" ? ` Bracket draft: take-profit $${takeProfit?.limitPrice?.toFixed(2) ?? "-"} / stop-loss $${stopLoss?.stopPrice?.toFixed(2) ?? "-"} (E*TRADE preview only; place exits separately).` : ""} NO SHARES HAVE BEEN BOUGHT. Awaiting explicit Human-in-the-Loop authorization.${isNonLivePricingQuoteStatus(pricingQuoteStatus) ? ` ${nonLivePricingNotice(pricingQuoteStatus)}` : ""}`;
    const storedPreviewNotes = optionLegs.length
      ? JSON.stringify({ kind: "strategy-order-v1", assetClass, brokerOrderType, optionLegs, strategyNetDebit: params.strategyNetDebit, note: brokerNotice })
      : orderClass === "bracket"
        ? JSON.stringify({
            kind: "bracket-draft-v1",
            orderClass,
            takeProfit,
            stopLoss,
            takeProfitPercent: percentExits?.takeProfitPercent,
            stopLossPercent: percentExits?.stopLossPercent,
            note: brokerNotice,
          })
        : brokerNotice;

    const draft: ETradeOrderDraft = {
      orderId,
      previewId: upstreamPreviewId || `pv_${orderId}`,
      symbol,
      action,
      orderAction: action,
      orderType,
      brokerOrderType,
      optionLegs: optionLegs.length ? optionLegs : undefined,
      strategyNetDebit: params.strategyNetDebit,
      quantity: params.quantity,
      estimatedPrice: executionPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission,
      estimatedTotal,
      pricingQuoteStatus,
      orderClass,
      takeProfit,
      stopLoss,
      ...(percentExits
        ? {
            takeProfitPercent: percentExits.takeProfitPercent,
            stopLossPercent: percentExits.stopLossPercent,
          }
        : {}),
      status: "previewed",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature.startsWith("sig_0x") ? didProof.signature : `sig_0x${didProof.signature}`,
      previewMessage,
      previewNotes: brokerNotice,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };

    if (this.orm?.trades) {
      try {
        this.orm.trades.create({
          id: orderId,
          sessionId,
          symbol,
          action,
          orderType,
          quantity: params.quantity,
          price: executionPrice,
          totalValue: estimatedTotal,
          status: "previewed",
          orderRef: upstreamPreviewId,
          proposerDid: didProof.proposerDid,
          authorizerDid: userDid,
          proofSignature: draft.proofSignature,
          previewNotes: storedPreviewNotes || previewMessage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn("Failed to persist trade draft to ORM:", err);
      }
    }

    return draft;
  }

  async executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected", expectedTerms?: ExpectedTradeTerms): Promise<ETradeOrderExecutionResult> {
    const now = new Date().toISOString();

    // 1. Strict HITL Gate: authorizer must be a verified human user DID
    if (!authorizerDid || authorizerDid.startsWith("did:agent:")) {
      throw new Error(`HITL Enforcement: Autonomous execution blocked. Authorizer DID must be a verified human user (received '${authorizerDid || "none"}').`);
    }

    // 2. Draft record must exist in ORM
    const record = this.orm?.trades?.findById(orderId);
    if (!record) {
      throw new Error(`Order draft '${orderId}' not found. All orders must be previewed and drafted before execution.`);
    }

    if (record.status !== "previewed") {
      throw new Error(`Order draft '${orderId}' cannot be executed. Current status is '${record.status}'. Only 'previewed' drafts may be executed.`);
    }

    // 2b. Issue #1393 (invariant 5): when the caller carries the
    // approval's frozen terms, the CURRENT draft must still match
    // them before any execution. A proposal edited after approval
    // is refused here — before any status mutation and before any
    // broker reference is minted — so the old approval can never
    // settle the edited terms. Rejections are exempt: rejecting an
    // edited draft moves no funds and needs no snapshot.
    if (decision === "approved" && expectedTerms) {
      const mismatch =
        expectedTerms.symbol.toUpperCase() !== record.symbol.toUpperCase() ||
        expectedTerms.action !== record.action ||
        expectedTerms.quantity !== record.quantity ||
        expectedTerms.price !== record.price ||
        expectedTerms.totalValue !== record.totalValue;
      if (mismatch) {
        throw new Error(
          `Order draft '${orderId}' terms changed since approval (expected ${expectedTerms.quantity} ${expectedTerms.symbol} @ ${expectedTerms.price}, current ${record.quantity} ${record.symbol} @ ${record.price}). Settlement refused: a fresh approval of the edited proposal is required.`,
        );
      }
    }

    const symbol = record.symbol;
    const action = record.action;
    const quantity = record.quantity;
    const proposerDid = record.proposerDid;
    const proofSignature = record.proofSignature;

    // Issue #3839: an E*TRADE bracket preview is a DRAFT with computed
    // legs; this client has no conditional-order placement, so a parent
    // must never be placed alone under a bracket approval. Refuse honestly
    // and leave the draft previewed; separate exit orders are the path.
    if (decision === "approved" && typeof record.previewNotes === "string" && record.previewNotes.includes("bracket-draft-v1")) {
      throw new Error(
        `Order draft '${orderId}' is an E*TRADE bracket preview. This client has no native bracket placement, so placing the parent alone would leave the position unprotected. Nothing was submitted; place the parent and the two exits as separate approved orders.`,
      );
    }

    if (decision === "rejected") {
      if (this.orm?.trades) {
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
          proposerDid,
          authorizerDid,
          signature: proofSignature,
        },
        message: `Order draft ${orderId} was rejected by human authorizer (${authorizerDid}).`,
        timestamp: now,
      };
    }

    if (decision !== "approved") {
      throw new Error(`Invalid decision '${decision}'. Order execution requires explicit 'approved' decision.`);
    }

    // #2389: an approved draft is placed through the real broker
    // client and the record takes the client's outcome — `executed`
    // is persisted only when the client returns broker-confirmed
    // success carrying a reference from an actual placement response.
    // This method used to invent an et_ref_ reference, derive a price
    // from the preview estimate, and stamp the record executed with
    // zero broker calls; that fabrication is what filled the
    // autopilot feed with executions no broker performed. On any
    // non-executed client result the draft is left untouched (still
    // "previewed"), so the approval can be retried once the broker
    // path works — the same posture the broker-orders route takes.
    const strategyOrder = parseStrategyOrder(record.previewNotes);
    const result = await this.client.placeOrder({
      orderId,
      symbol,
      action,
      quantity,
      orderType: record.orderType,
      limitPrice:
        record.orderType === "LIMIT" || record.orderType === "STOP_LIMIT" ? record.price : undefined,
      previewId:
        record.orderRef && String(record.orderRef).trim() !== "" ? String(record.orderRef).trim() : undefined,
      optionLegs: strategyOrder.optionLegs.length > 0 ? (strategyOrder.optionLegs as any) : undefined,
      strategyNetDebit: strategyOrder.strategyNetDebit ?? undefined,
      userLogin: authorizerDid,
    });

    if (
      result.success &&
      this.orm?.trades &&
      (result.status === "executed" || result.status === "submitted")
    ) {
      this.orm.trades.update(orderId, {
        status: result.status,
        orderRef: result.brokerOrderRef || result.executionId,
        authorizerDid,
        updatedAt: now,
      });
    }

    return result;
  }

  /**
   * Issue #3390: cancel through the client the other order calls already use.
   * The broker's result is returned as-is — no invented success.
   */
  async cancelOrderRemote(orderId: string | number, accountKey?: string): Promise<BrokerCancelOrderResult> {
    return this.client.cancelOrder(accountKey, orderId);
  }

  async placeOrderRemote(params: any): Promise<ETradeOrderExecutionResult> {
    return this.client.placeOrder(params);
  }
}
