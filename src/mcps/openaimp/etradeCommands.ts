/**
 * GoF Command Pattern: E*TRADE Trading & Screening MCP Tools
 *
 * Implements:
 * - GoF Command Pattern: IMcpToolCommand encapsulation for each trading capability.
 * - Human-in-the-Loop (HITL) Order Safety with Agent DID attestation.
 * - Multi-turn agent dogfooding for stock scanning, quote inspection, and order placement.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { ETradeService } from "../../services/etrade";
import { TradingPlatformRegistry, fetchQuoteLiveStrict } from "../../trading";
import { resolveEnvironmentConfig } from "../../config/environment";
import {
  levelsForEtradeSwitch,
  resolveEtradeScanMode,
  resolveEtradeQuoteMode,
  resolveEtradePreviewMode,
  resolveEtradePositionsMode,
  resolveEtradeStatusMode,
  resolveEtradeDiscoveryMode,
  etradeConfigErrorEvent,
  ETRADE_SCAN_MODE_SWITCH,
  ETRADE_QUOTE_MODE_SWITCH,
  ETRADE_PREVIEW_MODE_SWITCH,
  ETRADE_POSITIONS_MODE_SWITCH,
  ETRADE_STATUS_MODE_SWITCH,
  ETRADE_DISCOVERY_MODE_SWITCH,
  type ResolvedEtradeSwitch,
} from "../../config/etradeModes";
import {
  checkEtradeExecuteGate,
  resolveEtradeAuthorizerDid,
} from "../../services/etradeExecutionGate";
import { notifyOrderExecution } from "../../services/orderExecutionNotifier";
import { orderPayloadHash, parseStrategyOrder } from "../../agents/routes/orderPayloadHash";
import { ETradeBrowserService } from "../../services/browserAgent";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "mcps/openaimp/etradeCommands",
});

/**
 * #1726 helpers: resolve one switch for this call and, on an invalid
 * value, fail closed to the surface legacy + audit etrade.config_error.
 * The execute gate never passes through here — it is not switchable.
 */
function etradeModeLevels(context: McpToolContext, key: "scan" | "quote" | "preview" | "positions" | "status" | "discovery", run: unknown, envVar: string) {
  return levelsForEtradeSwitch(context.scopedEtradeModes, key, run, (context.env as any)?.[envVar]);
}

function auditEtradeConfigError(context: McpToolContext, switchName: string, resolved: ResolvedEtradeSwitch<any>) {
  if (!resolved.invalid) return;
  context.audit(etradeConfigErrorEvent(), "trading", {
    switch: switchName,
    raw: resolved.raw,
    level: resolved.level,
    failedClosedTo: resolved.mode,
  });
}

/** TEST/PROD override from a per-call `environment` input (REST route rule: anything else = unset). */
function etradeRequestedEnv(input: any): "TEST" | "PROD" | undefined {
  const raw = typeof input?.environment === "string" ? input.environment.toUpperCase().trim() : "";
  return raw === "TEST" || raw === "PROD" ? raw : undefined;
}

/**
 * 1. E*TRADE Market Scan & Screener Command
 */
export class ETradeMarketScanCommand implements IMcpToolCommand<{
  exchange?: "ALL" | "NASDAQ" | "NYSE" | "AMEX";
  minPrice?: number;
  maxPrice?: number;
  minMarketCap?: number;
  gainersOnly?: boolean;
  losersOnly?: boolean;
  search?: string;
  limit?: number;
}> {
  readonly name = "etrade_market_scan";
  readonly description = "Screen all current Nasdaq, NYSE, and AMEX listings using price, exchange, market cap, daily change, and ticker/company search filters.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      exchange: { type: "string", enum: ["ALL", "NASDAQ", "NYSE", "AMEX"], description: "Listing exchange; defaults to all three" },
      minPrice: { type: "number", description: "Minimum last-sale price in USD" },
      maxPrice: { type: "number", description: "Maximum last-sale price in USD" },
      minMarketCap: { type: "number", description: "Minimum market capitalization in billions of USD" },
      gainersOnly: { type: "boolean", description: "Only listings with positive daily change" },
      losersOnly: { type: "boolean", description: "Only listings with negative daily change" },
      search: { type: "string", description: "Search term or keyword to match symbol or company name" },
      limit: { type: "number", description: "Maximum rows to return; omit to return all matches" },
      mode: { type: "string", description: "#1726 run-level ETRADE_SCAN_MODE override (listings | screened)" },
    },
  };
  readonly zodSchema = z.object({
    exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional().describe("Listing exchange"),
    minPrice: z.number().nonnegative().optional().describe("Minimum last-sale price"),
    maxPrice: z.number().positive().optional().describe("Maximum last-sale price"),
    minMarketCap: z.number().nonnegative().optional().describe("Minimum market cap in billions"),
    gainersOnly: z.boolean().optional().describe("Only positive daily change"),
    losersOnly: z.boolean().optional().describe("Only negative daily change"),
    search: z.string().optional().describe("Ticker or company name search"),
    limit: z.number().int().positive().optional().describe("Maximum rows to return; omitted means all matches"),
    mode: z.string().optional().describe("#1726 run-level ETRADE_SCAN_MODE override (listings | screened)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E01: listings is the MCP legacy; screened is NOT runnable
    // here (ScreenerAgent is not bound in MCP context) and fails loud
    // rather than silently substituting the listings engine.
    const resolved = resolveEtradeScanMode(etradeModeLevels(context, "scan", input?.mode, ETRADE_SCAN_MODE_SWITCH), "listings");
    auditEtradeConfigError(context, ETRADE_SCAN_MODE_SWITCH, resolved);
    if (resolved.mode === "screened") {
      throw new Error("ETRADE_SCAN_MODE=screened: the ScreenerAgent screened pipeline is not available in MCP context; use listings mode or the REST /etrade/screen route.");
    }
    const etrade = new ETradeService(context.orm, context.env, context.sessionId, undefined, context.storage);
    const result = await etrade.screenMarketsAsync(input);

    context.audit("etrade.market_scanned", "trading", {
      matchedCount: result.matchedCount,
      exchange: input.exchange,
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
    });

    return result;
  }
}

/**
 * 2. E*TRADE Get Quote Command
 */
export class ETradeGetQuoteCommand implements IMcpToolCommand<{ symbol: string }> {
  readonly name = "etrade_get_quote";
  readonly description = "Fetch a live market quote, bid/ask depth, daily and average volume, valuation fields, and 52-week range for an equity ticker.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The stock ticker symbol (e.g. NVDA, AAPL, MSFT, TSLA, PLTR)" },
      mode: { type: "string", description: "#1726 run-level ETRADE_QUOTE_MODE override (mcp | rest)" },
      environment: { type: "string", description: "#1726 rest-mode TEST/PROD override" },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(10).describe("Stock ticker symbol (e.g. NVDA, AAPL, TSLA)"),
    mode: z.string().optional().describe("#1726 run-level ETRADE_QUOTE_MODE override (mcp | rest)"),
    environment: z.string().optional().describe("#1726 rest-mode TEST/PROD override (mirrors x-environment / ?env)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E02: mcp = legacy (sessionId login, quote_fetched audit,
    // symbol required); rest = REST route semantics (env override
    // honored, no audit, missing symbol defaults to NVDA).
    const resolved = resolveEtradeQuoteMode(etradeModeLevels(context, "quote", input?.mode, ETRADE_QUOTE_MODE_SWITCH), "mcp");
    auditEtradeConfigError(context, ETRADE_QUOTE_MODE_SWITCH, resolved);
    if (resolved.mode === "rest") {
      const symbol = (typeof input?.symbol === "string" ? input.symbol.trim().toUpperCase() : "") || "NVDA";
      const requestedEnv = etradeRequestedEnv(input);
      const platform = TradingPlatformRegistry.getPlatform("etrade", context.env, context.orm, context.sessionId, requestedEnv);
      return await fetchQuoteLiveStrict(platform, symbol, {
        isLive: resolveEnvironmentConfig(context.env, requestedEnv).isLive,
      });
    }
    if (typeof input?.symbol !== "string" || !input.symbol.trim()) {
      throw new Error("symbol is required");
    }
    const symbol = input.symbol.trim().toUpperCase();
    // #291 Q4: registry-resolved platform + the LIVE_STRICT policy — the
    // semantics getQuoteAsync enforced (live failure propagates to the
    // MCP framework exactly as before; no user override existed here).
    // Issue #1185: post-#180 the MCP context is bound to a per-user API
    // key / app session, and context.sessionId IS that caller's login
    // (the sibling commands use it directly) — no synthetic default.
    const platform = TradingPlatformRegistry.getPlatform("etrade", context.env, context.orm, context.sessionId);
    const quote = await fetchQuoteLiveStrict(platform, symbol, {
      isLive: resolveEnvironmentConfig(context.env).isLive,
    });

    context.audit("etrade.quote_fetched", "trading", {
      symbol: quote.symbol,
      lastPrice: quote.lastPrice,
      changePercent: quote.changePercent,
    });

    return quote;
  }
}

/**
 * 3. E*TRADE Preview Order Command (Draft with Agent DID Stamp)
 */
export class ETradePreviewOrderCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  notes?: string;
}> {
  readonly name = "etrade_preview_order";
  readonly description = "Preview an E*TRADE equity order draft (BUY, SELL, BUY_TO_COVER, SELL_SHORT) with Agent Decentralized Identifier (DID) cryptographic attestation. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human confirmation.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, PLTR)" },
      action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
      quantity: { type: "number", description: "Number of shares to trade" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Execution order type (default: MARKET)" },
      limitPrice: { type: "number", description: "Limit price for limit orders" },
      notes: { type: "string", description: "Optional trade notes or strategy rationale" },
      mode: { type: "string", description: "#1726 run-level ETRADE_PREVIEW_MODE override (local | broker)" },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("Stock ticker symbol"),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).describe("Order action"),
    quantity: z.number().positive().describe("Number of shares"),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional().default("MARKET").describe("Order type"),
    limitPrice: z.number().optional().describe("Limit price"),
    notes: z.string().optional().describe("Trade notes"),
    mode: z.string().optional().describe("#1726 run-level ETRADE_PREVIEW_MODE override (local | broker)"),
    stopPrice: z.number().optional().describe("Broker-mode stop price (rejected in local mode)"),
    assetClass: z.string().optional().describe("Broker-mode asset class (equity | options; rejected in local mode)"),
    strategyNetDebit: z.number().optional().describe("Broker-mode strategy net debit/credit"),
    optionLegs: z.array(z.any()).optional().describe("Broker-mode option legs (rejected in local mode)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E03: local = legacy equity-only draft, except option
    // legs / stopPrice / assetClass are now REJECTED loudly instead
    // of being silently dropped; broker = the REST broker draft
    // (previewOrderRemote: equity + option legs, leg/asset-class
    // validation, stopPrice) + payload-hash audit. Broker preview
    // moves no money; the autopilot policy gate, expiry schedule,
    // and Slack ticket remain REST-preview-only (residual, §15) —
    // and REST execute still policy-gates any draft it executes.
    const resolved = resolveEtradePreviewMode(etradeModeLevels(context, "preview", input?.mode, ETRADE_PREVIEW_MODE_SWITCH), "local");
    auditEtradeConfigError(context, ETRADE_PREVIEW_MODE_SWITCH, resolved);
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    if (resolved.mode === "broker") {
      const draft = await etrade.previewOrderRemote({
        assetClass: input.assetClass,
        symbol: input.symbol,
        action: input.action || input.orderAction,
        orderAction: input.orderAction || input.action,
        quantity: input.quantity,
        orderType: input.orderType,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        optionLegs: input.optionLegs,
        strategyNetDebit: input.strategyNetDebit,
        sessionId: context.sessionId,
        notes: input.notes,
      });
      const strategyOrder = parseStrategyOrder((draft as any).previewNotes);
      const payloadHash = await orderPayloadHash({
        symbol: draft.symbol,
        action: draft.orderAction,
        quantity: draft.quantity,
        orderType: draft.orderType,
        price: draft.estimatedPrice,
        totalValue: draft.estimatedTotal,
        optionLegs: (draft as any).optionLegs ?? strategyOrder.optionLegs,
        strategyNetDebit: (draft as any).strategyNetDebit ?? strategyOrder.strategyNetDebit,
      });
      context.audit("etrade.order_previewed", "trading", {
        orderId: draft.orderId,
        symbol: draft.symbol,
        action: draft.action,
        quantity: draft.quantity,
        estimatedTotal: draft.estimatedTotal,
        proposerDid: draft.proposerDid,
        payloadHash,
      });
      return {
        orderId: draft.orderId,
        status: "previewed",
        requiresConfirmation: true,
        symbol: draft.symbol,
        action: draft.action,
        quantity: draft.quantity,
        orderType: draft.orderType,
        limitPrice: draft.limitPrice,
        estimatedTotal: draft.estimatedTotal,
        estimatedCommission: draft.estimatedCommission,
        proposerDid: draft.proposerDid,
        authorizerDid: draft.authorizerDid,
        proofSignature: draft.proofSignature,
        payloadHash,
        safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
        securityGuarantee: "NO MONEY HAS BEEN MOVED & NO SHARES TRADED. Stamped with Agent DID. Requires human confirmation via etrade_execute_order.",
        previewMessage: draft.previewMessage,
      };
    }
    if ((Array.isArray(input?.optionLegs) && input.optionLegs.length > 0) || input?.stopPrice !== undefined || input?.assetClass !== undefined) {
      throw new Error("Local preview mode does not support option legs, stopPrice, or assetClass — they would be silently dropped. Use mode=broker for broker preview (equity + option legs with validation).");
    }
    const draft = etrade.previewOrder({
      symbol: input.symbol,
      action: input.action || input.orderAction,
      orderAction: input.orderAction || input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      sessionId: context.sessionId,
      notes: input.notes,
    });

    context.audit("etrade.order_previewed", "trading", {
      orderId: draft.orderId,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      estimatedTotal: draft.estimatedTotal,
      proposerDid: draft.proposerDid,
    });

    return {
      orderId: draft.orderId,
      status: "previewed",
      requiresConfirmation: true,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      orderType: draft.orderType,
      limitPrice: draft.limitPrice,
      estimatedTotal: draft.estimatedTotal,
      estimatedCommission: draft.estimatedCommission,
      // Issue #3782: price provenance rides with the draft — the
      // preview card renders it and never treats an estimated price
      // as the order price. The refusal itself lives in
      // ETradeService.previewOrder (a LIMIT draft with no user limit
      // and no live quote throws there and no draft is created).
      priceSource: draft.priceSource,
      proposerDid: draft.proposerDid,
      authorizerDid: draft.authorizerDid,
      proofSignature: draft.proofSignature,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      securityGuarantee: "NO MONEY HAS BEEN MOVED & NO SHARES TRADED. Stamped with Agent DID. Requires human confirmation via etrade_execute_order.",
      previewMessage: draft.previewMessage,
    };
  }
}

/**
 * 4. E*TRADE Execute Order Command (Human-In-The-Loop Confirmation)
 */
export class ETradeExecuteOrderCommand implements IMcpToolCommand<{
  orderId: string;
  decision: "approved" | "rejected";
  note?: string;
}> {
  readonly name = "etrade_execute_order";
  readonly description = "Authorize and execute a previously previewed E*TRADE order draft (etrade_ord_xxxx) using explicit Human-in-the-Loop confirmation with authorizer DID verification.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The unique order preview ID (e.g. etrade_ord_12345)" },
      decision: { type: "string", enum: ["approved", "rejected"], description: "Human authorization decision" },
      note: { type: "string", description: "Optional review note or execution rationale" },
    },
    required: ["orderId", "decision"],
  };
  readonly zodSchema = z.object({
    orderId: z.string().describe("Order draft ID (etrade_ord_xxxx)"),
    decision: z.enum(["approved", "rejected"]).describe("Human confirmation decision"),
    note: z.string().optional().describe("Review note"),
  });

  async execute(input: { orderId: string; decision: "approved" | "rejected"; note?: string }, context: McpToolContext) {
    // #1726 E04 (SAFETY-CRITICAL): the MCP execute path ADOPTS the
    // REST route's HITL gate via the shared gate module — there is
    // NO mode input on this command and no switch can weaken it.
    // Gate order mirrors REST: 403 did:agent: → 404 draft-exists →
    // 400 previewed-status, then the rejection branch, then (for
    // approved) execution from the STORED draft fields only — the
    // caller supplies no symbol/action/quantity, so parameter drift
    // via this call is impossible by construction.
    const { orderId, decision, note } = input;
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    const authorizerDid = resolveEtradeAuthorizerDid(context.sessionId);
    const existingRecord = checkEtradeExecuteGate(context.orm, { orderId, authorizerDid });

    if (decision === "rejected") {
      const result = await etrade.executeOrder(orderId, authorizerDid, decision);
      context.audit("etrade.order_rejected", "trading", {
        orderId,
        decision,
        status: result.status,
        executionId: result.executionId,
        note,
      });
      return result;
    }

    // Approved: mirror completeEtradeOrderExecution's context-free
    // parts — remote placement when broker keys are present, else
    // the local platform execution; executed-payload-hash audit;
    // best-effort Slack transaction snap. Host-only residuals (NOT
    // re-implemented weaker): autopilot policy verdict re-check,
    // orders-today counter, expiry-timer scheduling/cancellation.
    // The expiry timer is safe to leave: expireStaleOrderDraft only
    // expires drafts still in `previewed` status.
    let result: any;
    const strategyOrder = parseStrategyOrder(existingRecord.previewNotes);
    if (context.env.ETRADE_CONSUMER_KEY || context.env.ETRADE_MCP_SERVER_URL || context.env.ET_API_KEY) {
      result = await etrade.placeOrderRemote({
        orderId,
        symbol: existingRecord.symbol,
        action: existingRecord.action,
        quantity: Number(existingRecord.quantity),
        orderType: existingRecord.orderType || "MARKET",
        limitPrice: existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined,
        previewId: existingRecord.orderRef && String(existingRecord.orderRef).trim() !== "" ? String(existingRecord.orderRef).trim() : undefined,
        optionLegs: strategyOrder.optionLegs.length > 0 ? strategyOrder.optionLegs : undefined,
        strategyNetDebit: strategyOrder.strategyNetDebit ?? undefined,
        userLogin: context.sessionId,
      });
      if (result.success && context.orm.trades) {
        context.orm.trades.update(orderId, {
          status: "executed",
          orderRef: result.executionId,
          authorizerDid,
          updatedAt: new Date().toISOString(),
        });
      }
    } else {
      result = await etrade.executeOrder(orderId, authorizerDid, decision);
    }

    const executedPayloadHash = await orderPayloadHash({
      symbol: existingRecord.symbol,
      action: existingRecord.action,
      quantity: existingRecord.quantity,
      orderType: existingRecord.orderType || "MARKET",
      price: existingRecord.price,
      totalValue: existingRecord.totalValue,
      optionLegs: strategyOrder.optionLegs,
      strategyNetDebit: strategyOrder.strategyNetDebit,
      previewNotes: existingRecord.previewNotes,
    });
    context.audit("etrade.order_executed", "trading", {
      orderId,
      decision,
      authorizerDid,
      status: result.status,
      executionId: result.executionId,
      payloadHash: executedPayloadHash,
      note,
    });

    let notifications;
    if (result.status === "executed" || result.success) {
      const envMode = (context.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase();
      try {
        const browserService = new ETradeBrowserService(context.env);
        await browserService.sendTransactionSnapToSlack({
          transactionId: orderId,
          symbol: existingRecord.symbol,
          action: existingRecord.action,
          quantity: Number(existingRecord.quantity),
          price: existingRecord.price || 0,
          orderType: existingRecord.orderType || "MARKET",
          status: "EXECUTED",
          totalValue: existingRecord.totalValue || 0,
          environment: envMode,
          timestamp: new Date().toISOString(),
          humanApproved: decision === "approved",
        });
      } catch (snapErr) {
        structuredLog.warn("etrade.execute_order_slack_snap_failed", {
          message: "[ETradeExecuteOrderCommand] Note: could not send transaction snap to Slack",
          error: snapErr instanceof Error ? snapErr.message : String(snapErr),
        });
      }
      notifications = await notifyOrderExecution(context.env, {
        orderId,
        broker: (existingRecord as any).broker || "broker",
        mode: envMode,
        symbol: existingRecord.symbol,
        action: existingRecord.action,
        quantity: Number(existingRecord.quantity),
        orderType: existingRecord.orderType || "MARKET",
        price: existingRecord.price,
        status: result.status || "executed",
        origin: this.name,
        userLogin: context.actingLogin?.() ?? context.sessionId,
      });
    }

    return notifications ? { ...result, notifications } : result;
  }
}

/**
 * 5. E*TRADE Get Positions & Account Balance Command
 */
export class ETradeGetPositionsCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_get_positions";
  readonly description = "Query open E*TRADE brokerage account balances, purchasing power, active stock positions, and unrealized profit/loss metrics.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({
    mode: z.string().optional().describe("#1726 run-level ETRADE_POSITIONS_MODE override (mcp | rest)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E05: mcp = legacy reshaped envelope (2 remote calls);
    // rest = REST shape (spread holdings + error only when
    // unconnected, single call with balance).
    const resolved = resolveEtradePositionsMode(etradeModeLevels(context, "positions", input?.mode, ETRADE_POSITIONS_MODE_SWITCH), "mcp");
    auditEtradeConfigError(context, ETRADE_POSITIONS_MODE_SWITCH, resolved);
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    if (resolved.mode === "rest") {
      const holdings = await etrade.fetchPortfolioRemote(undefined, true);
      const lastError = etrade.getLastError();
      return {
        ...holdings,
        error: lastError && holdings.account.accountId === "unconnected" ? lastError : undefined,
      };
    }
    const { account, positions } = await etrade.fetchPortfolioRemote();
    const accounts = await etrade.fetchAccountsRemote();

    return {
      account,
      accounts,
      positions,
      totalPortfolioValue: account.totalAccountValue,
      totalCash: account.cashAvailableForInvestment,
      positionsCount: positions.length,
      asOf: new Date().toISOString(),
    };
  }
}

/**
 * 6. E*TRADE Authentication Status Command (Agentic Token Guardian)
 */
export class ETradeAuthStatusCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_auth_status";
  readonly description = "Check E*TRADE 3-legged OAuth 1.0a authentication status, midnight ET expiration cutoff, token renewal eligibility, and active environment (TEST/PROD).";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({
    mode: z.string().optional().describe("#1726 run-level ETRADE_STATUS_MODE override (mcp | rest)"),
    environment: z.string().optional().describe("#1726 rest-mode TEST/PROD override (mirrors x-environment / ?env)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E06 (status): mcp = legacy (no env threading); rest =
    // REST construction (requestedEnv threaded into the service).
    const resolved = resolveEtradeStatusMode(etradeModeLevels(context, "status", input?.mode, ETRADE_STATUS_MODE_SWITCH), "mcp");
    auditEtradeConfigError(context, ETRADE_STATUS_MODE_SWITCH, resolved);
    const requestedEnv = resolved.mode === "rest" ? etradeRequestedEnv(input) : undefined;
    const etrade = new ETradeService(context.orm, context.env, context.sessionId, requestedEnv);
    const status = await etrade.getStatusAsync();
    return status;
  }
}

/**
 * 7. E*TRADE Account Discovery Command
 */
export class ETradeAccountDiscoveryCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_account_discovery";
  readonly description = "Discover and inspect active E*TRADE brokerage accounts by dynamically calling GET /v1/accounts/list to resolve authentic accountIdKey values.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({
    mode: z.string().optional().describe("#1726 run-level ETRADE_DISCOVERY_MODE override (mcp | rest)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #1726 E06 (discovery): mcp = legacy {count, accounts, asOf};
    // rest = REST shape {count, accounts} + a 502-carrying error
    // when the list is empty with a recorded upstream error (the
    // MCP transport has no HTTP status, so the status rides on the
    // thrown error object, as on the gate errors).
    const resolved = resolveEtradeDiscoveryMode(etradeModeLevels(context, "discovery", input?.mode, ETRADE_DISCOVERY_MODE_SWITCH), "mcp");
    auditEtradeConfigError(context, ETRADE_DISCOVERY_MODE_SWITCH, resolved);
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    const accounts = await etrade.fetchAccountsRemote();
    if (resolved.mode === "rest") {
      if (accounts.length === 0) {
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          const err = new Error(upstreamError) as Error & { status: number };
          err.status = 502;
          throw err;
        }
      }
      return { count: accounts.length, accounts };
    }
    return {
      count: accounts.length,
      accounts,
      asOf: new Date().toISOString(),
    };
  }
}

