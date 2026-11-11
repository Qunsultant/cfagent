/**
 * Issue #3990 Slice C — Public.com trading platform.
 *
 * The broker half of the Public integration: quotes and chains ride
 * the DATA adapter (createPublicDataProviderFromEnv — one quote
 * mapping, not two), orders ride the TRADING client
 * (PublicTradingMcpClient). The platform is the neutral seam the
 * broker routes, the draft ledger, and (Slice D) the copilot call.
 *
 * Public has NO paper trading mode (official docs, verified twice):
 * a tenant in TEST mode gets reads + preview only. Placement in
 * TEST is refused with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP
 * call — the refusal is the honest interpretation of the mode
 * default staying paper, and it is enforced HERE, at the placement
 * seam, not in a comment. Live (PROD) placement is an explicit act
 * by the caller, never a default: this constructor defaults to
 * TEST when no environment is passed, exactly as the neutral
 * routes' requestedEnv resolves it.
 *
 * Placement is async on Public's side: place_order returns an
 * order ID (acceptance receipt, NOT a fill). The execution result
 * says so in its message, and callers poll get_order for the fill.
 * No idempotency key exists on the MCP surface, so a failed place
 * is never retried by this platform.
 */

import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { BROKER_CATALOG, type TradingEnvironment, type TradingType } from "../brokerCatalog";
import type {
  ITradingPlatform,
  OrderPreviewParams,
  PlaceOrderParams,
  ExpectedTradeTerms,
  OptionRequestBudget,
} from "../interfaces";
import type {
  BrokerAccount,
  BrokerCancelOrderResult,
  BrokerOrderDraft,
  BrokerOrderExecutionResult,
  BrokerPosition,
  BrokerQuote,
  BrokerRemoteOrder,
  BrokerStatus,
  BrokerOptionChain,
  BrokerOptionExpireDate,
} from "../../types";
import type { DataProvider } from "../dataProviders/contract";
import { createPublicDataProviderFromEnv } from "../dataProviders/adapters";
import { PublicTradingMcpClient } from "../../mcps/public/publicTradingMcp";
import {
  parsePublicAccounts,
  parsePublicOrderId,
  parsePublicOrders,
  parsePublicPositions,
  publicDraftFromPreflight,
  publicMultilegArgs,
  publicNoPaperModeOutcomeExists,
  publicNoPaperModeRefusal,
  publicPlacedExecution,
  publicRefusedExecution,
  publicSingleLegArgs,
} from "../../services/publicTrading";
import { getPublicAccessToken, getPublicCredentialSource } from "../../security/publicOAuth";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";
import { decodeOrderPriceSource, encodeOrderPriceSource } from "../quotePolicies";
import { computeBracketExits } from "../bracketPercent";
import { NeutralMarketScreener } from "../neutralMarketScreener";
import { platformQuoteSource } from "../stockQuoteSource";
import type { StockScreenerFilter, StockScreenResult } from "../../types";

export interface PublicPlatformDeps {
  accessTokenProvider?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Injected for tests; production builds the data adapter from env. */
  dataProvider?: DataProvider;
  sleep?: (ms: number) => Promise<void>;
}

export class PublicTradingPlatform implements ITradingPlatform {
  readonly platformId = "public" as const;
  readonly name = "Public.com";
  private readonly env: Env;
  private readonly orm: DatabaseORM | undefined;
  private readonly userLogin: string;
  private readonly overrideEnv?: string;
  private readonly trading: PublicTradingMcpClient;
  private readonly tokenProvider: () => Promise<string | null>;
  private dataProvider: DataProvider;
  private lastError: string | undefined;

  constructor(
    env: Env,
    orm: DatabaseORM | undefined,
    userLogin: string,
    overrideEnv?: string,
    deps?: PublicPlatformDeps
  ) {
    if (!userLogin) {
      throw new Error("PublicTradingPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    this.env = env;
    this.orm = orm;
    this.userLogin = userLogin;
    this.overrideEnv = overrideEnv;
    this.tokenProvider =
      deps?.accessTokenProvider ?? (() => getPublicAccessToken(env, userLogin, deps?.fetchImpl));
    this.trading = new PublicTradingMcpClient({
      accessTokenProvider: this.tokenProvider,
      fetchImpl: deps?.fetchImpl,
      sleep: deps?.sleep,
    });
    this.dataProvider =
      deps?.dataProvider ??
      createPublicDataProviderFromEnv(env, userLogin, { fetchImpl: deps?.fetchImpl });
  }

  /** The resolved environment: the neutral routes pass requestedEnv; absent means TEST (the mode default). */
  private environment(): TradingEnvironment {
    return this.overrideEnv === "PROD" ? "PROD" : "TEST";
  }

  private tradingType(): TradingType {
    return this.environment() === "PROD" ? "live" : "paper";
  }

  /**
   * Issue #4048: the deployment credential (PUBLIC_API_KEY) is a READ
   * credential, shared by every tenant on the deployment. Every mutating
   * call refuses it HERE, at the platform seam both the copilot tools and
   * the neutral broker routes resolve through — otherwise a tenant who
   * never connected a token would preview, place and cancel live orders
   * on the operator's account.
   */
  private async refuseDeploymentCredential(): Promise<void> {
    if ((await getPublicCredentialSource(this.env, this.userLogin)) === "deployment") {
      throw new Error(
        "PUBLIC_DEPLOYMENT_CREDENTIAL_READ_ONLY: the deployment PUBLIC_API_KEY serves reads only and is shared by every tenant on this deployment; paste your own Public token in Settings to preview, place or cancel orders."
      );
    }
  }

  /** Refuse a TEST-mode placement with the named outcome, before any MCP call. Returns the refusal or null. */
  private noPaperModeRefusal(params: {
    orderId: string;
    symbol: string;
    action: string;
    quantity: number;
    authorizerDid: string;
  }): BrokerOrderExecutionResult | null {
    if (this.environment() !== "TEST") return null;
    if (!publicNoPaperModeOutcomeExists()) {
      throw new Error(
        "FAILURE_PUBLIC_NO_PAPER_MODE is missing from the outcome catalog; refusing to place rather than silently proceeding."
      );
    }
    const refusal = publicNoPaperModeRefusal();
    return publicRefusedExecution({ ...params, code: refusal.code, message: refusal.message });
  }

  async getStatus(): Promise<BrokerStatus> {
    const token = await this.tokenProvider().catch(() => null);
    const configured = Boolean(token);
    const tradingType = this.tradingType();
    const vocabulary = BROKER_CATALOG.public.statusVocabulary;
    return {
      broker: "public",
      name: this.name,
      configured,
      mode: vocabulary.mode[tradingType],
      protocol: vocabulary.protocol,
      environment: vocabulary.environment[tradingType],
      activeEnvironment: this.environment(),
      apiUrl: "https://mcp.public.com/mcp",
      mcpServerUrl: "https://mcp.public.com/mcp",
      hasApiKey: configured,
      oauthAuthenticated: configured,
      capabilities: [
        "US Equity & ETF Trading",
        "Options Trading (single-leg and multi-leg)",
        "Native Bracket Orders (TP/SL at the broker)",
        "Market Data via hosted MCP",
      ],
    };
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const envelope = await this.dataProvider.getQuote!(symbol);
    const result = envelope.result as {
      symbol?: string;
      companyName?: string;
      lastPrice?: number;
      price?: number;
      change?: number;
      changePercent?: number;
      bid?: number;
      ask?: number;
      volume?: number;
      open?: number;
      high?: number;
      low?: number;
      previousClose?: number;
      timestamp?: string;
    };
    const lastPrice = result.lastPrice ?? result.price ?? 0;
    return {
      symbol: result.symbol ?? symbol,
      companyName: result.companyName ?? result.symbol ?? symbol,
      lastPrice,
      price: result.price ?? lastPrice,
      change: result.change ?? 0,
      changePercent: result.changePercent ?? 0,
      bid: result.bid ?? 0,
      ask: result.ask ?? 0,
      volume: result.volume ?? 0,
      open: result.open ?? 0,
      high: result.high ?? 0,
      low: result.low ?? 0,
      previousClose: result.previousClose ?? 0,
      timestamp: result.timestamp ?? new Date().toISOString(),
    };
  }

  async getQuoteDetailed(symbol: string): Promise<{ quote: BrokerQuote | null; error: string | null }> {
    try {
      return { quote: await this.getQuote(symbol), error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return { quote: null, error: message };
    }
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    const text = await this.trading.callTradingTool("get_accounts", {});
    return parsePublicAccounts(this.trading.parseResult(text));
  }

  /**
   * Issue #3990 Slice D: screening is the platform's math on the
   * broker's own quotes (the same `NeutralMarketScreener` #3272
   * built), fed by Public's quotes — never another broker's. The
   * catalog declares marketScreening true for public now that this
   * method exists.
   */
  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    return new NeutralMarketScreener({ quoteSource: platformQuoteSource(this) }).screenMarkets(filter);
  }

  async getPositions(): Promise<{ account: BrokerAccount; positions: BrokerPosition[] }> {
    const [accounts, portfolio] = await Promise.all([
      this.getAccounts(),
      this.trading.callTradingTool("get_portfolio", {}).then((t) => this.trading.parseResult(t)),
    ]);
    const { positions, buyingPower } = parsePublicPositions(portfolio);
    const account = accounts[0];
    if (!account) {
      throw new Error("no Public.com account was found for this token; connect Public in Settings first.");
    }
    if (buyingPower !== undefined) account.cashAvailableForInvestment = buyingPower;
    return { account, positions };
  }

  async previewOrder(params: OrderPreviewParams): Promise<BrokerOrderDraft> {
    await this.refuseDeploymentCredential();
    const action = params.action ?? params.orderAction ?? "BUY";
    const userDid = getUserDid(params.sessionId || this.userLogin);
    const orderType = params.orderType ?? "MARKET";
    // Issue #3812: percent exits are converted here, against the SAME
    // entry price the draft is priced from (a user limit, or the live
    // quote). An absolute takeProfit/stopLoss wins when also present.
    const hasUserLimit = Number.isFinite(params.limitPrice) && Number(params.limitPrice) > 0;
    const entryPrice =
      (orderType === "LIMIT" || orderType === "STOP_LIMIT") && hasUserLimit
        ? Number(params.limitPrice)
        : (await this.getQuote(params.symbol)).lastPrice;
    const percentRequested =
      params.takeProfitPercent !== undefined || params.stopLossPercent !== undefined;
    if (
      percentRequested &&
      (params.takeProfitPercent === undefined || params.stopLossPercent === undefined)
    ) {
      throw new Error(
        "Bracket percent exits need both takeProfitPercent and stopLossPercent (both or neither)."
      );
    }
    const percentExits = percentRequested
      ? computeBracketExits({
          side: action,
          entryPrice,
          takeProfitPercent: params.takeProfitPercent as number,
          stopLossPercent: params.stopLossPercent as number,
        })
      : null;
    const takeProfit = params.takeProfit ?? percentExits?.takeProfit;
    const stopLoss = params.stopLoss ?? percentExits?.stopLoss;
    const orderClass = params.orderClass || (takeProfit || stopLoss ? "bracket" : undefined);
    const isMultileg = (params.optionLegs?.length ?? 0) > 1;
    const tool = isMultileg ? "preflight_multileg_order" : "preflight_order";
    const args = isMultileg
      ? publicMultilegArgs({
          legs: params.optionLegs!,
          quantity: params.quantity,
          limitPrice: params.limitPrice,
        })
      : publicSingleLegArgs({
          symbol: params.symbol,
          assetClass: params.assetClass,
          action,
          quantity: params.quantity,
          orderType,
          limitPrice: params.limitPrice,
          stopPrice: params.stopPrice,
          orderClass,
          takeProfit,
          stopLoss,
        });
    const text = await this.trading.callTradingTool(tool, args);
    const payload = this.trading.parseResult(text);
    const draft = publicDraftFromPreflight(
      { ...params, orderType, orderClass, takeProfit, stopLoss },
      payload,
      {
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: userDid,
        proofSignature: "",
      }
    );
    // A preflight that carries no price leaves the draft priced from
    // the entry price above, never zero.
    if (!draft.estimatedPrice) {
      draft.estimatedPrice = entryPrice;
      draft.estimatedTotal = Number((entryPrice * params.quantity).toFixed(2));
    }
    // The DID proof signs the preview's own terms (amount = the
    // preflight's estimated total), mirroring the Alpaca preview.
    const didProof = createDidAttestationSync({
      draftId: draft.orderId,
      action: params.assetClass === "options" ? "options" : "equity",
      amount: draft.estimatedTotal,
      currency: "USD",
      customer: `Public:${params.symbol}`,
      gateway: "public-mcp",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
    });
    draft.proofSignature = didProof.signature;
    const priceSource = decodeOrderPriceSource((params as { priceSourceJson?: unknown }).priceSourceJson);
    draft.previewNotes = JSON.stringify({
      kind: "public-order-v1",
      orderClass: params.orderClass,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      priceSource,
    });
    if (this.orm?.trades) {
      try {
        this.orm.trades.create({
          id: draft.orderId,
          sessionId: params.sessionId || this.userLogin,
          symbol: draft.symbol,
          action,
          orderType: draft.orderType,
          quantity: params.quantity,
          price: draft.estimatedPrice,
          totalValue: draft.estimatedTotal,
          status: "previewed",
          orderRef: draft.orderId,
          proposerDid: didProof.proposerDid,
          authorizerDid: userDid,
          proofSignature: didProof.signature,
          priceSourceJson: encodeOrderPriceSource(priceSource),
          previewNotes: draft.previewNotes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // A store failure must not fabricate an execution; the draft
        // still returns, and executeOrder will refuse an unknown id.
      }
    }
    return draft;
  }

  async executeOrder(
    orderId: string,
    authorizerDid: string,
    decision: "approved" | "rejected",
    expectedTerms?: ExpectedTradeTerms
  ): Promise<BrokerOrderExecutionResult> {
    await this.refuseDeploymentCredential();
    const now = new Date().toISOString();
    const record = this.orm?.trades?.findById(orderId) as
      | {
          symbol?: string;
          action?: string;
          quantity?: number;
          orderType?: string;
          price?: number;
          proofSignature?: string;
          status?: string;
          previewNotes?: string;
          priceSourceJson?: unknown;
        }
      | undefined;
    const symbol = record?.symbol ?? "";
    const action = record?.action ?? "BUY";
    const quantity = record?.quantity ?? 0;
    const proofSignature = record?.proofSignature ?? "";

    if (decision === "rejected") {
      if (record && this.orm?.trades) {
        this.orm.trades.update(orderId, { status: "rejected", authorizerDid, updatedAt: now });
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
        didAttestation: { proposerDid: AGENT_DIDS.TRADING, authorizerDid, signature: proofSignature },
        message: `Public.com order ${orderId} rejected by human authorizer (${authorizerDid}).`,
        timestamp: now,
      };
    }

    if (!record) {
      return this.failedExecution(orderId, authorizerDid, symbol, action, quantity, proofSignature, now,
        `Public.com order draft '${orderId}' was not found. Nothing was executed; preview the order first.`);
    }
    if (record.status !== "previewed") {
      return this.failedExecution(orderId, authorizerDid, symbol, action, quantity, proofSignature, now,
        `Public.com order draft '${orderId}' is '${record.status}', not 'previewed'. Only a previewed draft may execute.`);
    }
    if (expectedTerms) {
      const mismatch =
        expectedTerms.symbol !== symbol ||
        expectedTerms.action !== action ||
        expectedTerms.quantity !== quantity;
      if (mismatch) {
        return this.failedExecution(orderId, authorizerDid, symbol, action, quantity, proofSignature, now,
          `Public.com order draft '${orderId}' terms changed after approval; refusing to execute under the old approval.`);
      }
    }

    // The TEST-mode refusal happens before any MCP call, and the
    // draft stays previewed so the user can retry it in live mode.
    const refusal = this.noPaperModeRefusal({ orderId, symbol, action, quantity, authorizerDid });
    if (refusal) return refusal;

    let notes: Record<string, unknown> = {};
    try {
      notes = typeof record.previewNotes === "string" ? JSON.parse(record.previewNotes) : {};
    } catch {
      notes = {};
    }
    const priceSource = decodeOrderPriceSource(record.priceSourceJson);
    const execution = await this.placeOrderRemote({
      orderId,
      symbol,
      action: action as PlaceOrderParams["action"],
      quantity,
      // The DRAFT's terms, not a fresh market order: the approval
      // settled this preview (orderType + limit price from the row),
      // mirroring the Alpaca execute path.
      orderType: (record.orderType as PlaceOrderParams["orderType"]) ?? "MARKET",
      limitPrice: record.price,
      priceSource,
      userLogin: this.userLogin,
      orderClass: (notes.orderClass as PlaceOrderParams["orderClass"]) ?? undefined,
      takeProfit: notes.takeProfit as PlaceOrderParams["takeProfit"],
      stopLoss: notes.stopLoss as PlaceOrderParams["stopLoss"],
    });
    if (this.orm?.trades && execution.success) {
      this.orm.trades.update(orderId, {
        status: "submitted",
        authorizerDid,
        orderRef: execution.brokerOrderRef || orderId,
        updatedAt: now,
      });
    }
    return execution;
  }

  private failedExecution(
    orderId: string,
    authorizerDid: string,
    symbol: string,
    action: string,
    quantity: number,
    proofSignature: string,
    now: string,
    message: string
  ): BrokerOrderExecutionResult {
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
      didAttestation: { proposerDid: AGENT_DIDS.TRADING, authorizerDid, signature: proofSignature },
      message,
      timestamp: now,
    };
  }

  async placeOrderRemote(params: PlaceOrderParams): Promise<BrokerOrderExecutionResult> {
    await this.refuseDeploymentCredential();
    const refusal = this.noPaperModeRefusal({
      orderId: params.orderId,
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      authorizerDid: getUserDid(this.userLogin),
    });
    if (refusal) return refusal;

    const isMultileg = (params.optionLegs?.length ?? 0) > 1;
    const tool = isMultileg ? "place_multileg_order" : "place_order";
    const args = isMultileg
      ? publicMultilegArgs({
          legs: params.optionLegs!,
          quantity: params.quantity,
          limitPrice: params.limitPrice,
        })
      : publicSingleLegArgs({
          symbol: params.symbol,
          assetClass: params.optionLegs?.[0]?.securityType === "OPTN" ? "options" : "equity",
          action: params.action,
          quantity: params.quantity,
          orderType: params.orderType,
          limitPrice: params.limitPrice,
          orderClass: params.orderClass,
          takeProfit: params.takeProfit,
          stopLoss: params.stopLoss,
        });
    try {
      const text = await this.trading.callTradingTool(tool, args);
      return publicPlacedExecution({
        orderId: params.orderId,
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        authorizerDid: getUserDid(this.userLogin),
        payload: this.trading.parseResult(text),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return publicRefusedExecution({
        orderId: params.orderId,
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        authorizerDid: getUserDid(this.userLogin),
        code: "FAILURE_BROKER_UNAVAILABLE",
        message: `Public.com placement failed: ${message}`,
      });
    }
  }

  async cancelOrderRemote(orderId: string | number): Promise<BrokerCancelOrderResult> {
    await this.refuseDeploymentCredential();
    const text = await this.trading.callTradingTool("cancel_order", {
      order_id: { names: ["order_id", "orderId", "id"], value: String(orderId) },
    });
    const payload = this.trading.parseResult(text);
    const brokerOrderRef = parsePublicOrderId(payload) ?? String(orderId);
    return {
      success: true,
      orderId: brokerOrderRef,
      message: `Public.com order ${brokerOrderRef} cancelled.`,
      timestamp: new Date().toISOString(),
    };
  }

  async getOrderHistory(status: "open" | "closed" | "all"): Promise<BrokerRemoteOrder[]> {
    const text = await this.trading.callTradingTool("get_orders", {});
    const orders = parsePublicOrders(this.trading.parseResult(text));
    if (status === "all") return orders;
    if (status === "open") return orders.filter((o) => o.status === "OPEN");
    return orders.filter((o) => o.status !== "OPEN");
  }

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
    requestBudget?: OptionRequestBudget
  ): Promise<BrokerOptionChain | null> {
    const envelope = await this.dataProvider.getOptionsChain!(
      {
        symbol: params.symbol,
        expiryYear: params.expiryYear,
        expiryMonth: params.expiryMonth,
        expiryDay: params.expiryDay,
        strikePrice: params.strikePrice,
        noOfStrikes: params.noOfStrikes,
        includeWeekly: params.includeWeekly,
        chainType: params.chainType,
      },
      undefined,
      requestBudget
    );
    return envelope.result as BrokerOptionChain;
  }

  async getOptionExpireDates(
    symbol: string,
    expiryType?: string,
    requestBudget?: OptionRequestBudget
  ): Promise<BrokerOptionExpireDate[]> {
    const envelope = await this.dataProvider.getOptionExpiryDates!(symbol, undefined, requestBudget);
    return envelope.result as BrokerOptionExpireDate[];
  }
}
