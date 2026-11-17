/**
 * Tastytrade Trading Platform Adapter (issue #4675, Gap 21).
 *
 * Implements `ITradingPlatform` over Tastytrade's REST API using the
 * OAuth2 personal refresh-token session in `./credentials`.
 *
 * Hosts:
 *   - TEST / paper: `https://api.cert.tastyworks.com` (override: `TASTYTRADE_PAPER_URL`)
 *   - PROD / live:  `https://api.tastyworks.com`      (override: `TASTYTRADE_LIVE_URL`)
 */
import type {
  Env,
  BrokerAccount,
  BrokerCancelOrderResult,
  BrokerOrderDraft,
  BrokerOrderExecutionResult,
  BrokerPosition,
  BrokerQuote,
  BrokerRemoteOrder,
  BrokerStatus,
  StockScreenerFilter,
  StockScreenResult,
} from "../../types";
import type { DatabaseORM } from "../../orm";
import { BROKER_CATALOG, type TradingType } from "../brokerCatalog";
import type {
  ExpectedTradeTerms,
  ITradingPlatform,
  OrderPreviewParams,
  PlaceOrderParams,
} from "../interfaces";
import { TASTYTRADE_CONFIG } from "../../config/tastytrade";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";
import { NeutralMarketScreener } from "../neutralMarketScreener";
import { platformQuoteSource } from "../stockQuoteSource";
import {
  resolveTastytradeBaseUrl,
  resolveTastytradeCredentials,
  TastytradeOAuthSession,
  tastytradeTradingSide,
} from "./credentials";

export interface TastytradePlatformDeps {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

function mapTastytradeOrderStatus(raw: unknown): BrokerRemoteOrder["status"] {
  const status = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (
    status === "received" ||
    status === "routed" ||
    status === "in flight" ||
    status === "live" ||
    status === "contingent" ||
    status === "cancel requested" ||
    status === "replace requested"
  ) {
    return "OPEN";
  }
  if (status === "filled") return "EXECUTED";
  if (status === "partially filled") return "INDIVIDUAL_FILLS";
  if (status === "cancelled" || status === "canceled" || status === "expired" || status === "removed") {
    return "CANCELLED";
  }
  if (status === "rejected") return "REJECTED";
  return "UNKNOWN";
}

function toTastytradeTimeInForce(tif?: string): "Day" | "GTC" | "IOC" | "FOK" {
  switch ((tif ?? "day").toLowerCase()) {
    case "gtc":
      return "GTC";
    case "ioc":
      return "IOC";
    case "fok":
      return "FOK";
    default:
      return "Day";
  }
}

function toTastytradeOrderType(orderType?: string): "Market" | "Limit" | "Stop" | "Stop Limit" {
  switch ((orderType ?? "MARKET").toUpperCase()) {
    case "LIMIT":
      return "Limit";
    case "STOP":
      return "Stop";
    case "STOP_LIMIT":
      return "Stop Limit";
    default:
      return "Market";
  }
}

function toTastytradeAction(action?: string): "Buy to Open" | "Sell to Close" | "Buy to Close" | "Sell to Open" {
  switch ((action ?? "BUY").toUpperCase()) {
    case "SELL":
      return "Sell to Close";
    case "BUY_TO_COVER":
      return "Buy to Close";
    case "SELL_SHORT":
      return "Sell to Open";
    default:
      return "Buy to Open";
  }
}

export class TastytradeTradingPlatform implements ITradingPlatform {
  readonly platformId = "tastytrade" as const;
  readonly name = "Tastytrade";

  private readonly env: Env;
  private readonly orm: DatabaseORM | undefined;
  private readonly userLogin: string;
  private readonly overrideEnv?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private session: TastytradeOAuthSession | null = null;
  private lastError: string | undefined;

  constructor(
    env: Env,
    orm: DatabaseORM | undefined,
    userLogin: string,
    overrideEnv?: string,
    deps: TastytradePlatformDeps = {},
  ) {
    this.env = env;
    this.orm = orm;
    this.userLogin = userLogin;
    this.overrideEnv = overrideEnv;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.userAgent = deps.userAgent ?? TASTYTRADE_CONFIG.userAgent;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  private tradingSide(): TradingType {
    return tastytradeTradingSide(this.env, this.overrideEnv);
  }

  private async getSession(): Promise<TastytradeOAuthSession> {
    if (this.session) return this.session;
    const creds = await resolveTastytradeCredentials(this.env, this.userLogin, this.overrideEnv);
    if (!creds) {
      throw new Error(
        "Tastytrade credentials are not configured. Set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN or connect via SessionStore.",
      );
    }
    this.session = new TastytradeOAuthSession({
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      baseUrl: creds.baseUrl,
      userAgent: this.userAgent,
      fetchImpl: this.fetchImpl,
    });
    return this.session;
  }

  private async apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const session = await this.getSession();
    const token = await session.getAccessToken();
    const resp = await this.fetchImpl(`${session.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TASTYTRADE_CONFIG.requestTimeoutMs),
    });

    if (!resp.ok) {
      this.lastError = `Tastytrade API error (${resp.status})`;
      throw new Error(`Tastytrade request failed (HTTP ${resp.status}).`);
    }

    const json = (await resp.json().catch(() => null)) as { data?: T } | null;
    if (!json || json.data === undefined) {
      throw new Error("Tastytrade API returned an unreadable payload.");
    }
    this.lastError = undefined;
    return json.data;
  }

  async getStatus(): Promise<BrokerStatus> {
    const side = this.tradingSide();
    const vocabulary = BROKER_CATALOG.tastytrade.statusVocabulary;
    const baseUrl = resolveTastytradeBaseUrl(this.env, this.overrideEnv);
    const creds = await resolveTastytradeCredentials(this.env, this.userLogin, this.overrideEnv);
    const capabilities = Object.entries(BROKER_CATALOG.tastytrade.supports)
      .filter(([, supported]) => supported)
      .map(([name]) => name);

    if (!creds) {
      return {
        broker: "tastytrade",
        name: this.name,
        configured: false,
        mode: vocabulary.mode[side],
        protocol: vocabulary.protocol,
        environment: vocabulary.environment[side],
        activeEnvironment: side === "live" ? "PROD" : "TEST",
        apiUrl: baseUrl,
        credentialSource: "none",
        oauthAuthenticated: false,
        capabilities,
      };
    }

    try {
      await this.getAccounts();
      return {
        broker: "tastytrade",
        name: this.name,
        configured: true,
        mode: vocabulary.mode[side],
        protocol: vocabulary.protocol,
        environment: vocabulary.environment[side],
        activeEnvironment: side === "live" ? "PROD" : "TEST",
        apiUrl: creds.baseUrl,
        credentialSource: creds.source === "stored" ? "user" : "deployment",
        oauthAuthenticated: true,
        capabilities,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Tastytrade connection unavailable.";
      return {
        broker: "tastytrade",
        name: this.name,
        configured: true,
        mode: vocabulary.mode[side],
        protocol: vocabulary.protocol,
        environment: vocabulary.environment[side],
        activeEnvironment: side === "live" ? "PROD" : "TEST",
        apiUrl: creds.baseUrl,
        credentialSource: creds.source === "stored" ? "user" : "deployment",
        oauthAuthenticated: false,
        capabilities,
      };
    }
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    const data = await this.apiRequest<{
      items?: Array<{
        account?: {
          "account-number"?: string;
          nickname?: string;
          "account-type-name"?: string;
          "is-closed"?: boolean;
        };
      }>;
    }>("/customers/me/accounts");

    const items = Array.isArray(data.items) ? data.items : [];
    const accounts: BrokerAccount[] = [];
    for (const item of items) {
      const acct = item.account;
      const acctNo = acct?.["account-number"];
      if (!acctNo) continue;

      let buyingPower = 0;
      let totalAccountValue = 0;
      try {
        const bal = await this.apiRequest<{
          "equity-buying-power"?: string | number;
          "net-liquidating-value"?: string | number;
        }>(`/accounts/${encodeURIComponent(acctNo)}/balances`);
        buyingPower = Number(bal["equity-buying-power"] ?? 0) || 0;
        totalAccountValue = Number(bal["net-liquidating-value"] ?? 0) || 0;
      } catch {
        // Balance read is best-effort if account list succeeded.
      }

      const acctName = acct?.nickname || acct?.["account-type-name"] || `Tastytrade ${acctNo}`;
      accounts.push({
        accountId: acctNo,
        accountKey: acctNo,
        accountIdKey: acctNo,
        accountDesc: acctName,
        accountName: acctName,
        accountType: acct?.["account-type-name"] || "MARGIN",
        accountStatus: acct?.["is-closed"] ? "CLOSED" : "ACTIVE",
        institutionType: "TASTYTRADE",
        netAccountValue: totalAccountValue,
        totalAccountValue,
        cashAvailableForInvestment: buyingPower,
        marginBuyingPower: buyingPower,
        dayTraderStatus: false,
      });
    }
    return accounts;
  }

  private async resolveDefaultAccountNumber(accountKey?: string): Promise<string> {
    if (accountKey && accountKey.trim()) return accountKey.trim();
    const accounts = await this.getAccounts();
    const first = accounts[0]?.accountIdKey || accounts[0]?.accountId;
    if (!first) {
      throw new Error("No active Tastytrade account found.");
    }
    return first;
  }

  async getPositions(
    accountKey?: string,
    _includeBalance = false,
  ): Promise<{ account: BrokerAccount; positions: BrokerPosition[] }> {
    const accounts = await this.getAccounts();
    const account =
      (accountKey
        ? accounts.find((a) => a.accountIdKey === accountKey || a.accountId === accountKey)
        : accounts[0]) ?? accounts[0];
    if (!account) {
      throw new Error("No Tastytrade account available.");
    }

    const acctKey = account.accountIdKey || account.accountId;
    const data = await this.apiRequest<{
      items?: Array<{
        symbol?: string;
        "instrument-type"?: string;
        quantity?: string | number;
        "quantity-direction"?: string;
        "average-open-price"?: string | number;
        "close-price"?: string | number;
        "mark-price"?: string | number;
      }>;
    }>(`/accounts/${encodeURIComponent(acctKey)}/positions`);

    const items = Array.isArray(data.items) ? data.items : [];
    const positions: BrokerPosition[] = items.map((pos) => {
      const rawQty = Number(pos.quantity ?? 0) || 0;
      const qty =
        String(pos["quantity-direction"] ?? "").toLowerCase() === "short" ? -Math.abs(rawQty) : rawQty;
      const mark = Number(pos["mark-price"] ?? pos["close-price"] ?? 0) || 0;
      const cost = Number(pos["average-open-price"] ?? 0) || 0;
      const costBasis = cost * Math.abs(qty);
      const marketValue = qty * mark;
      const totalGain = (mark - cost) * qty;
      const totalGainPercent = cost > 0 ? ((mark - cost) / cost) * 100 : 0;
      return {
        symbol: String(pos.symbol ?? ""),
        description: String(pos.symbol ?? ""),
        quantity: qty,
        positionType: qty < 0 ? "SHORT" : "LONG",
        securityType: String(pos["instrument-type"] ?? "").toLowerCase().includes("option") ? "OPTN" : "EQ",
        costBasisKnown: cost > 0,
        pricePaid: cost,
        costBasis,
        currentPrice: mark,
        marketPrice: mark,
        marketValue,
        totalGain,
        unrealizedGainLoss: totalGain,
        totalGainPercent,
        unrealizedGainLossPercent: totalGainPercent,
        daysGain: 0,
        daysGainPercent: 0,
      };
    });

    return { account, positions };
  }

  async getQuoteDetailed(symbol: string): Promise<{ quote: BrokerQuote | null; error: string | null }> {
    const sym = symbol.trim().toUpperCase();
    try {
      const data = await this.apiRequest<{
        items?: Array<{
          symbol?: string;
          last?: string | number;
          bid?: string | number;
          ask?: string | number;
          "prev-close"?: string | number;
          "open-price"?: string | number;
          dayHighPrice?: string | number;
          dayLowPrice?: string | number;
          "day-high-price"?: string | number;
          "day-low-price"?: string | number;
          volume?: string | number;
        }>;
      }>(`/market-data/by-type?equity=${encodeURIComponent(sym)}`);

      const item = data.items?.[0];
      if (!item) {
        return { quote: null, error: `No Tastytrade quote returned for ${sym}.` };
      }
      const last = Number(item.last ?? 0) || 0;
      const prevClose = Number(item["prev-close"] ?? last) || last;
      const change = last - prevClose;
      const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
      return {
        quote: {
          symbol: item.symbol || sym,
          companyName: item.symbol || sym,
          lastPrice: last,
          price: last,
          change,
          changePercent,
          bid: Number(item.bid ?? last) || last,
          ask: Number(item.ask ?? last) || last,
          volume: Number(item.volume ?? 0) || 0,
          open: Number(item["open-price"] ?? prevClose) || prevClose,
          high: Number(item["day-high-price"] ?? item.dayHighPrice ?? last) || last,
          low: Number(item["day-low-price"] ?? item.dayLowPrice ?? last) || last,
          previousClose: prevClose,
          timestamp: new Date().toISOString(),
        },
        error: null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : `Tastytrade quote failed for ${sym}.`;
      this.lastError = msg;
      return { quote: null, error: msg };
    }
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const { quote, error } = await this.getQuoteDetailed(symbol);
    if (!quote) {
      throw new Error(error || `Unable to fetch Tastytrade quote for ${symbol}.`);
    }
    return quote;
  }

  async screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult> {
    const source = platformQuoteSource(this);
    if (!source) {
      throw new Error("Tastytrade quote source unavailable for market screening.");
    }
    const screener = new NeutralMarketScreener({ quoteSource: source });
    return screener.screenMarkets(filter);
  }

  async previewOrder(params: OrderPreviewParams): Promise<BrokerOrderDraft> {
    const accountNumber = await this.resolveDefaultAccountNumber();
    const symbol = params.symbol.trim().toUpperCase();
    const action = params.action ?? params.orderAction ?? "BUY";
    const orderType = params.orderType ?? "LIMIT";

    const dryRunBody = {
      "time-in-force": toTastytradeTimeInForce(params.timeInForce),
      "order-type": toTastytradeOrderType(orderType),
      ...(params.limitPrice !== undefined ? { price: String(params.limitPrice) } : {}),
      ...(params.stopPrice !== undefined ? { "stop-trigger": String(params.stopPrice) } : {}),
      legs: [
        {
          "instrument-type": params.assetClass === "options" ? "Equity Option" : "Equity",
          symbol,
          quantity: params.quantity,
          action: toTastytradeAction(action),
        },
      ],
    };

    const preview = await this.apiRequest<{
      order?: { id?: string | number };
      "buying-power-effect"?: { "change-in-buying-power"?: string | number };
      "fee-calculation"?: { "total-fees"?: string | number };
      warnings?: Array<{ message?: string }>;
    }>(`/accounts/${encodeURIComponent(accountNumber)}/orders/dry-run`, {
      method: "POST",
      body: JSON.stringify(dryRunBody),
    });

    const estPrice = params.limitPrice ?? params.stopPrice ?? 0;
    const orderId = `tt-draft-${crypto.randomUUID()}`;
    const bpChange = Math.abs(Number(preview["buying-power-effect"]?.["change-in-buying-power"] ?? 0) || 0);
    const commission = Math.abs(Number(preview["fee-calculation"]?.["total-fees"] ?? 0) || 0);
    const estimatedTotal = bpChange || estPrice * params.quantity;
    const authorizerDid = getUserDid(this.userLogin);
    const attestation = createDidAttestationSync({
      draftId: orderId,
      action,
      amount: estimatedTotal,
      currency: "USD",
      customer: `Tastytrade:${symbol}`,
      gateway: this.tradingSide() === "live" ? "live" : "sandbox",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
    });

    const draft: BrokerOrderDraft = {
      orderId,
      previewId: preview.order?.id ? String(preview.order.id) : orderId,
      symbol,
      action,
      orderAction: action,
      orderType,
      quantity: params.quantity,
      estimatedPrice: estPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: (params.timeInForce ?? "day").toLowerCase() === "gtc" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
      estimatedCommission: commission,
      estimatedTotal,
      status: "previewed",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      proofSignature: attestation.signature,
      previewMessage: `Tastytrade dry-run verified for ${params.quantity} ${symbol}.`,
      broker: "tastytrade",
      previewNotes: Array.isArray(preview.warnings)
        ? preview.warnings.map((w) => w.message).filter(Boolean).join("; ") || undefined
        : undefined,
    };

    if (this.orm?.trades) {
      this.orm.trades.create({
        id: draft.orderId,
        sessionId: params.sessionId || this.userLogin,
        symbol: draft.symbol,
        action: draft.action,
        orderType: draft.orderType,
        quantity: draft.quantity,
        price: draft.estimatedPrice,
        totalValue: draft.estimatedTotal,
        status: draft.status,
        orderRef: draft.previewId,
        stopPrice: draft.stopPrice,
        timeInForce: params.timeInForce,
        proposerDid: draft.proposerDid,
        authorizerDid: draft.authorizerDid,
        proofSignature: draft.proofSignature,
        previewNotes: draft.previewNotes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return draft;
  }

  async executeOrder(
    orderId: string,
    authorizerDid: string,
    decision: "approved" | "rejected",
    expectedTerms?: ExpectedTradeTerms,
  ): Promise<BrokerOrderExecutionResult> {
    const nowIso = new Date().toISOString();
    if (decision === "rejected") {
      return {
        success: false,
        orderId,
        executionId: `tt-rej-${orderId}`,
        brokerOrderRef: "",
        authorizerDid,
        status: "rejected",
        symbol: expectedTerms?.symbol ?? "",
        action: expectedTerms?.action ?? "BUY",
        quantity: expectedTerms?.quantity ?? 0,
        executionPrice: 0,
        totalSettled: 0,
        message: "Tastytrade order rejected by human approver.",
        timestamp: nowIso,
      };
    }

    const stored = this.orm?.trades?.findById(orderId) as
      | {
          symbol: string;
          action: string;
          quantity: number;
          orderType: string;
          limitPrice?: number | null;
          stopPrice?: number | null;
          estimatedPrice?: number | null;
          previewId?: string | null;
        }
      | null
      | undefined;
    if (!stored) {
      return {
        success: false,
        orderId,
        executionId: `tt-err-${orderId}`,
        brokerOrderRef: "",
        authorizerDid,
        status: "failed",
        symbol: expectedTerms?.symbol ?? "",
        action: expectedTerms?.action ?? "BUY",
        quantity: expectedTerms?.quantity ?? 0,
        executionPrice: 0,
        totalSettled: 0,
        message: `Order draft ${orderId} not found.`,
        timestamp: nowIso,
      };
    }

    if (expectedTerms) {
      const priceDiff = Math.abs((stored.limitPrice ?? stored.estimatedPrice ?? 0) - expectedTerms.price);
      if (
        stored.symbol !== expectedTerms.symbol ||
        stored.action !== expectedTerms.action ||
        stored.quantity !== expectedTerms.quantity ||
        priceDiff > 0.01
      ) {
        return {
          success: false,
          orderId,
          executionId: `tt-err-${orderId}`,
          brokerOrderRef: "",
          authorizerDid,
          status: "failed",
          symbol: stored.symbol,
          action: stored.action,
          quantity: stored.quantity,
          executionPrice: 0,
          totalSettled: 0,
          message: "Order draft terms changed after approval; refusing execution.",
          timestamp: nowIso,
        };
      }
    }

    return this.placeOrderRemote({
      orderId,
      symbol: stored.symbol,
      action: stored.action as PlaceOrderParams["action"],
      quantity: stored.quantity,
      orderType: stored.orderType,
      limitPrice: stored.limitPrice ?? undefined,
      stopPrice: stored.stopPrice ?? undefined,
      previewId: stored.previewId ?? undefined,
      userLogin: this.userLogin,
    });
  }

  async placeOrderRemote(params: PlaceOrderParams): Promise<BrokerOrderExecutionResult> {
    const accountNumber = await this.resolveDefaultAccountNumber();
    const symbol = params.symbol.trim().toUpperCase();
    const nowIso = new Date().toISOString();
    const estPrice = Number(params.limitPrice ?? params.stopPrice ?? 0);
    const body = {
      "time-in-force": toTastytradeTimeInForce(params.timeInForce),
      "order-type": toTastytradeOrderType(params.orderType),
      ...(params.limitPrice !== undefined ? { price: String(params.limitPrice) } : {}),
      ...(params.stopPrice !== undefined ? { "stop-trigger": String(params.stopPrice) } : {}),
      legs: [
        {
          "instrument-type": "Equity",
          symbol,
          quantity: params.quantity,
          action: toTastytradeAction(params.action),
        },
      ],
    };

    try {
      const placed = await this.apiRequest<{
        order?: { id?: string | number; status?: string };
      }>(`/accounts/${encodeURIComponent(accountNumber)}/orders`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const brokerOrderId = placed.order?.id ? String(placed.order.id) : params.orderId;
      const did = getUserDid(this.userLogin);
      const attestation = createDidAttestationSync({
        draftId: brokerOrderId,
        action: params.action,
        amount: estPrice * params.quantity,
        currency: "USD",
        customer: `Tastytrade:${symbol}`,
        gateway: this.tradingSide() === "live" ? "live" : "sandbox",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: did,
      });

      return {
        success: true,
        orderId: params.orderId,
        executionId: `tt-exec-${brokerOrderId}`,
        brokerOrderRef: brokerOrderId,
        authorizerDid: did,
        status: "submitted",
        symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: estPrice,
        totalSettled: estPrice * params.quantity,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid: did,
          signature: attestation.signature,
        },
        message: `Tastytrade accepted order ${brokerOrderId} for ${params.quantity} ${symbol}.`,
        timestamp: nowIso,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tastytrade order placement failed.";
      return {
        success: false,
        orderId: params.orderId,
        executionId: `tt-fail-${params.orderId}`,
        brokerOrderRef: "",
        status: "failed",
        symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        message,
        timestamp: nowIso,
      };
    }
  }

  async cancelOrderRemote(
    orderId: string | number,
    accountKey?: string,
  ): Promise<BrokerCancelOrderResult> {
    const accountNumber = await this.resolveDefaultAccountNumber(accountKey);
    const nowIso = new Date().toISOString();
    try {
      await this.apiRequest<unknown>(
        `/accounts/${encodeURIComponent(accountNumber)}/orders/${encodeURIComponent(String(orderId))}`,
        { method: "DELETE" },
      );
      return {
        success: true,
        orderId: String(orderId),
        message: `Tastytrade cancelled order ${orderId}.`,
        timestamp: nowIso,
      };
    } catch (error) {
      return {
        success: false,
        orderId: String(orderId),
        message: error instanceof Error ? error.message : "Tastytrade cancel failed.",
        timestamp: nowIso,
      };
    }
  }

  async getOrderHistory(status: "open" | "closed" | "all"): Promise<BrokerRemoteOrder[]> {
    const accountNumber = await this.resolveDefaultAccountNumber();
    const path =
      status === "open"
        ? `/accounts/${encodeURIComponent(accountNumber)}/orders/live`
        : `/accounts/${encodeURIComponent(accountNumber)}/orders`;

    const data = await this.apiRequest<{
      items?: Array<{
        id?: string | number;
        status?: string;
        "order-type"?: string;
        "time-in-force"?: string;
        price?: string | number;
        "received-at"?: string;
        "updated-at"?: string;
        legs?: Array<{
          symbol?: string;
          quantity?: number;
          action?: string;
        }>;
      }>;
    }>(path);

    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map((row): BrokerRemoteOrder => {
        const leg = row.legs?.[0];
        const mappedStatus = mapTastytradeOrderStatus(row.status);
        const placedStr = row["received-at"] || row["updated-at"];
        return {
          orderId: String(row.id ?? ""),
          symbol: String(leg?.symbol ?? ""),
          orderAction: String(leg?.action ?? "BUY"),
          quantity: Number(leg?.quantity ?? 0) || 0,
          orderType: String(row["order-type"] ?? "MARKET"),
          priceType: String(row["order-type"] ?? "MARKET"),
          limitPrice: row.price !== undefined ? Number(row.price) : undefined,
          status: mappedStatus,
          rawStatus: row.status,
          orderTerm: String(row["time-in-force"] ?? "DAY"),
          placedTime: placedStr ? Date.parse(placedStr) || undefined : undefined,
        };
      })
      .filter((order) => {
        if (status === "open") return order.status === "OPEN" || order.status === "INDIVIDUAL_FILLS";
        if (status === "closed") return order.status !== "OPEN" && order.status !== "INDIVIDUAL_FILLS";
        return true;
      });
  }
}
