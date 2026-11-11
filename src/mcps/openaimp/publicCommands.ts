/**
 * Issue #3990 Slice D — Public.com copilot tools.
 *
 * The five tools the catalog's public copilot block names
 * (public_get_quote, public_preview_order, public_place_order,
 * public_orders, public_cancel_order), each routing through the
 * neutral trading platform (the registry's public factory) instead
 * of a Public-specific service — the same shape as the Alpaca
 * commands in marketDataCommands.ts, with three Public differences:
 *
 *  1. Environment: the platform is constructed with the tenant's
 *     stored broker environment, resolved exactly like the neutral
 *     routes (resolveTradeEnvironmentFromSettings on the context's
 *     readSettingRaw; unset → TEST). A TEST platform refuses
 *     placement with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP
 *     call (Slice C); a PROD platform places as the user's explicit
 *     live act. No env pin, no silent paper/live mix-up.
 *  2. Preview-first placement: public_place_order takes an orderId
 *     and settles the STORED preview draft (the #3846 invariant:
 *     the executed terms are the previewed terms). A call without
 *     an orderId is refused and names public_preview_order — there
 *     is no direct placement path that would bypass the DID
 *     attestation + terms binding the draft carries.
 *  3. No ladder: the cancel tool cancels ONE order by id (the
 *     Public MCP surface has cancel_order, not a ladder). There is
 *     no cancel-all on Public — the panel gates its cancel-all
 *     control to alpaca for the same reason.
 */
import { z } from "zod";
import { recordTradingRunOutcome } from "../../services/tradingRunOutcome";
import { notifyOrderExecution } from "../../services/orderExecutionNotifier";
import { getUserDid } from "../../agents/did";
import { marketDataQuoteAuditEvent } from "../../config/marketDataModes";
import { resolveTradeEnvironmentFromSettings } from "../../agents/routes/brokerEnvironment";
import type { BrokerEnvironment } from "../../agents/routes/brokerEnvironment";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";

/** MCP-mode symbol requirement (legacy): a missing/blank symbol throws, it never defaults. */
function requireMcpSymbol(input: any): string {
  if (typeof input?.symbol !== "string" || !input.symbol.trim()) {
    throw new Error("symbol is required");
  }
  return input.symbol;
}

/** The copilot's stored broker environment as the platform's paper/live mode. */
function publicModeFromEnvironment(environment: BrokerEnvironment): "paper" | "live" {
  return environment === "PROD" ? "live" : "paper";
}

async function publicPlatform(context: McpToolContext) {
  // The registry lives behind the src/trading public seam (index.ts)
  // — the #290 boundary test forbids importing a trading-internal
  // path from outside src/trading/. The import stays dynamic so the
  // trading tree (which itself reaches the MCP client modules) loads
  // at call time, not module load.
  const { TradingPlatformRegistry } = await import("../../trading");
  const environment = resolveTradeEnvironmentFromSettings(context.readSettingRaw, context.env);
  const platform = TradingPlatformRegistry.getPlatform(
    "public",
    context.env,
    context.orm,
    context.sessionId,
    environment,
  );
  return { platform, environment, mode: publicModeFromEnvironment(environment) };
}

function normalizePublicAction(input: any): "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT" {
  const raw = String(input?.action ?? input?.orderAction ?? input?.side ?? "BUY").trim().toUpperCase();
  if (raw === "BUY" || raw === "SELL" || raw === "BUY_TO_COVER" || raw === "SELL_SHORT") return raw;
  return "BUY";
}

function normalizePublicOrderType(input: any): "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" {
  const raw = String(input?.orderType ?? input?.type ?? "MARKET").trim().toUpperCase();
  if (raw === "MARKET" || raw === "LIMIT" || raw === "STOP" || raw === "STOP_LIMIT") return raw;
  return "MARKET";
}

/**
 * 1. Public Get Quote Command
 * Fetches a live equity quote from Public.com's hosted MCP — the
 * copilot's quote leg when the tenant's broker is Public. Live-only
 * (#923, same as market_data_get_quote with provider "alpaca"): the
 * result carries provider "public" + provenance "live" + timestamp;
 * when a live fetch fails the command throws an explicit unavailable
 * error — no static or generated substitute is served.
 */
export class PublicGetQuoteCommand implements IMcpToolCommand {
  readonly name = "public_get_quote";
  readonly description =
    "Retrieve a live market quote (price, bid/ask, volume, OHLC) for an equity ticker from Public.com. Live-only: the result carries provider 'public', provenance 'live', and a timestamp; when Public cannot serve a live quote the command throws an explicit unavailable error — no static or generated substitute is served.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, NVDA, MSFT)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol (e.g. AAPL, NVDA, MSFT)"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const symbol = requireMcpSymbol(input);
    const { platform } = await publicPlatform(context);
    const quote = await platform.getQuote(symbol);
    const event = marketDataQuoteAuditEvent("mcp");
    if (event) context.audit?.(event, "research", { symbol, provider: "public", price: quote.price, provenance: "live" });
    return { ...quote, provider: "public", provenance: "live" as const };
  }
}

/**
 * 2. Public Preview Order Command
 * Drafts an equity or options order proposal on Public.com with Agent
 * DID attestation — the Public counterpart of alpaca_preview_order,
 * completing the catalog's declared orderPreview capability as an
 * agent tool. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD.
 * Awaiting human confirmation (place via public_place_order on
 * explicit approval). A LIMIT draft with no user-supplied limit prices
 * off the LIVE Public quote (getQuote throws when no live quote is
 * available, so no draft is created); a user-supplied limit always
 * wins over the quote; every draft carries priceSource.
 */
export class PublicPreviewOrderCommand implements IMcpToolCommand {
  readonly name = "public_preview_order";
  readonly description =
    "Preview a Public.com equity or options order draft (BUY, SELL, BUY_TO_COVER, SELL_SHORT) with Agent Decentralized Identifier (DID) cryptographic attestation. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human confirmation — place via public_place_order only on explicit approval.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, PLTR)" },
      action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
      side: { type: "string", description: "Alias for action (buy/sell)" },
      orderAction: { type: "string", description: "Alias for action" },
      quantity: { type: "number", description: "Number of shares to trade" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Execution order type (default: MARKET)" },
      type: { type: "string", description: "Alias for orderType" },
      limitPrice: { type: "number", description: "Limit price for limit orders (user-supplied; wins over the live quote)" },
      stopPrice: { type: "number", description: "Stop price for stop orders" },
      orderClass: { type: "string", enum: ["simple", "bracket", "oco", "oto"], description: "Order class ('bracket' for parent orders with take-profit and stop-loss legs)" },
      takeProfit: {
        type: "object",
        properties: { limitPrice: { type: "number", description: "Limit price for take-profit leg" } },
        required: ["limitPrice"],
        description: "Take-profit bracket leg parameters",
      },
      stopLoss: {
        type: "object",
        properties: {
          stopPrice: { type: "number", description: "Stop trigger price for stop-loss leg" },
          limitPrice: { type: "number", description: "Optional limit price for stop-loss limit leg" },
        },
        required: ["stopPrice"],
        description: "Stop-loss bracket leg parameters",
      },
      takeProfitPercent: {
        type: "number",
        description:
          "Issue #3812: take-profit distance in percent from the draft entry (e.g. 4 for +4%). Requires stopLossPercent; converted deterministically to an absolute leg price.",
      },
      stopLossPercent: {
        type: "number",
        description:
          "Issue #3812: stop-loss distance in percent from the draft entry (e.g. 2 for -2%). Requires takeProfitPercent; converted deterministically to an absolute leg price.",
      },
      assetClass: { type: "string", enum: ["equity", "options"], description: "Asset class (default: equity)" },
      optionLegs: { type: "array", items: { type: "object" }, description: "Option legs for a multi-leg strategy order" },
      strategyNetDebit: { type: "number", description: "Net strategy price for an options order (positive is debit, negative is credit)" },
    },
    required: ["symbol", "quantity"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("Stock ticker symbol"),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).optional().describe("Order action"),
    side: z.string().optional().describe("Alias for action (buy/sell)"),
    orderAction: z.string().optional().describe("Alias for action"),
    quantity: z.number().positive().describe("Number of shares"),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional().describe("Order type"),
    type: z.string().optional().describe("Alias for orderType"),
    limitPrice: z.number().optional().describe("Limit price"),
    stopPrice: z.number().optional().describe("Stop price"),
    orderClass: z.enum(["simple", "bracket", "oco", "oto"]).optional().describe("Order class"),
    takeProfit: z.object({ limitPrice: z.number() }).optional().describe("Take-profit bracket leg"),
    stopLoss: z.object({ stopPrice: z.number(), limitPrice: z.number().optional() }).optional().describe("Stop-loss bracket leg"),
    takeProfitPercent: z.number().positive().optional().describe("Issue #3812: take-profit distance in percent from the entry (e.g. 4)"),
    stopLossPercent: z.number().positive().optional().describe("Issue #3812: stop-loss distance in percent from the entry (e.g. 2)"),
    assetClass: z.enum(["equity", "options"]).optional().describe("Asset class"),
    optionLegs: z.array(z.any()).optional().describe("Option legs"),
    strategyNetDebit: z.number().optional().describe("Net strategy price"),
  });

  async execute(input: any, context: McpToolContext) {
    const { platform, mode } = await publicPlatform(context);
    const action = normalizePublicAction(input);
    const orderType = normalizePublicOrderType(input);
    let draft: Awaited<ReturnType<typeof platform.previewOrder>>;
    try {
      draft = await platform.previewOrder({
        assetClass: input.assetClass,
        symbol: input.symbol,
        action,
        orderAction: action,
        quantity: input.quantity,
        orderType,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        orderClass: input.orderClass,
        takeProfit: input.takeProfit,
        stopLoss: input.stopLoss,
        // Issue #3812: the percent form of a bracket request. The adapter
        // converts it against the same entry it prices the draft from.
        takeProfitPercent: input.takeProfitPercent,
        stopLossPercent: input.stopLossPercent,
        optionLegs: input.optionLegs,
        strategyNetDebit: input.strategyNetDebit,
        sessionId: context.sessionId,
      });
    } catch (error) {
      // Issue #3812: a refused preview is a run too — record the coded
      // failure before rethrowing so Workflow Runs explains the block.
      const coded =
        (error as { code?: string })?.code || "order_preview_failed";
      recordTradingRunOutcome(context.orm?.getSql?.(), {
        orderId: `preview-refused-${input.symbol}-${Date.now()}`,
        status: "failed",
        action,
        symbol: input.symbol,
        quantity: input.quantity,
        orderType,
        broker: "public",
        mode,
        codedError: coded,
        origin: "public_preview_order",
        takeProfitPercent: input.takeProfitPercent,
        stopLossPercent: input.stopLossPercent,
      });
      throw error;
    }
    context.audit?.("public.order_previewed", "trading", {
      orderId: draft.orderId,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      estimatedTotal: draft.estimatedTotal,
      proposerDid: draft.proposerDid,
      takeProfitPercent: input.takeProfitPercent,
      stopLossPercent: input.stopLossPercent,
    });
    recordTradingRunOutcome(context.orm?.getSql?.(), {
      orderId: draft.orderId,
      status: "completed",
      action: draft.action,
      symbol: draft.symbol,
      quantity: draft.quantity,
      orderType: draft.orderType,
      orderClass: (draft as { orderClass?: string }).orderClass,
      broker: "public",
      mode,
      origin: "public_preview_order",
      takeProfitPercent: input.takeProfitPercent,
      stopLossPercent: input.stopLossPercent,
      takeProfitPrice: (draft as { takeProfit?: { limitPrice?: number } }).takeProfit?.limitPrice,
      stopLossPrice: (draft as { stopLoss?: { stopPrice?: number } }).stopLoss?.stopPrice,
      priceSource: draft.priceSource?.kind,
    });
    return {
      success: true,
      orderId: draft.orderId,
      status: "previewed",
      requiresConfirmation: true,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      orderType: draft.orderType,
      orderClass: (draft as any).orderClass,
      takeProfit: (draft as any).takeProfit,
      stopLoss: (draft as any).stopLoss,
      takeProfitPercent: (draft as any).takeProfitPercent,
      stopLossPercent: (draft as any).stopLossPercent,
      broker: "public",
      limitPrice: draft.limitPrice,
      stopPrice: draft.stopPrice,
      estimatedPrice: draft.estimatedPrice,
      estimatedTotal: draft.estimatedTotal,
      estimatedCommission: draft.estimatedCommission,
      // Issue #3782: price provenance rides with the draft — the
      // preview card renders it and never treats an estimated price
      // as the order price.
      priceSource: draft.priceSource,
      proposerDid: draft.proposerDid,
      authorizerDid: draft.authorizerDid,
      proofSignature: draft.proofSignature,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      securityGuarantee: "NO MONEY HAS BEEN MOVED & NO SHARES TRADED. Stamped with Agent DID. Requires human confirmation via public_place_order.",
      previewMessage: draft.previewMessage,
    };
  }
}

/**
 * 3. Public Place Order Command
 * Settles a STORED Public preview draft by orderId through the same
 * approval/settlement path the chat's "yes" expects. This is the
 * only placement path: a call without an orderId is refused and
 * names public_preview_order, so no placement bypasses the draft's
 * DID attestation and stored terms. In TEST (the default) the
 * platform refuses with FAILURE_PUBLIC_NO_PAPER_MODE — Public.com
 * has no paper trading — and the refusal is returned as a failed
 * result, never narrated as a placement.
 */
export class PublicPlaceOrderCommand implements IMcpToolCommand {
  readonly name = "public_place_order";
  readonly description =
    "Place a Public.com order from a stored preview draft (orderId from public_preview_order). Preview-first: a call without an orderId is refused — preview the order first. In TEST mode placement is refused with FAILURE_PUBLIC_NO_PAPER_MODE (Public.com has no paper trading); in PROD the stored draft is placed as the user's explicit live act.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "Draft order ID from public_preview_order (required — preview first)" },
      decision: { type: "string", enum: ["approved", "rejected"], description: "Approval decision (default: approved)" },
      symbol: { type: "string", description: "Accepted alias; ignored — the stored draft's terms win" },
      quantity: { type: "number", description: "Accepted alias; ignored — the stored draft's terms win" },
      side: { type: "string", description: "Accepted alias; ignored — the stored draft's terms win" },
      orderAction: { type: "string", description: "Accepted alias; ignored — the stored draft's terms win" },
      orderType: { type: "string", description: "Accepted alias; ignored — the stored draft's terms win" },
      type: { type: "string", description: "Accepted alias; ignored — the stored draft's terms win" },
      limitPrice: { type: "number", description: "Accepted alias; ignored — the stored draft's terms win" },
    },
  };

  readonly zodSchema = z.object({
    orderId: z.string().optional().describe("Draft order ID from public_preview_order"),
    decision: z.enum(["approved", "rejected"]).optional().describe("Approval decision"),
    symbol: z.string().optional(),
    quantity: z.number().optional(),
    side: z.string().optional(),
    orderAction: z.string().optional(),
    orderType: z.string().optional(),
    type: z.string().optional(),
    limitPrice: z.number().optional(),
  });

  async execute(input: any, context: McpToolContext) {
    // Issue #3846: an orderId executes the stored preview draft through
    // the same approval/settlement path the chat's "yes" expects.
    if (!input.orderId) {
      return {
        success: false,
        orderId: "",
        status: "failed",
        message:
          "No orderId was supplied. Preview the order first with public_preview_order — a Public.com order is placed only from its stored preview draft.",
      };
    }
    const { platform, mode } = await publicPlatform(context);
    const result = await platform.executeOrder(
      input.orderId,
      getUserDid(context.sessionId),
      input.decision ?? "approved",
    );
    context.audit?.("public.order_executed", "trading", {
      orderId: input.orderId,
      decision: input.decision ?? "approved",
      success: result.success,
      brokerOrderRef: result.brokerOrderRef,
    });
    const notifications = result.success
      ? await notifyOrderExecution(context.env, {
          orderId: input.orderId,
          broker: "public",
          mode,
          symbol: result.symbol || "UNKNOWN",
          action: result.action || "BUY",
          quantity: Number(result.quantity ?? 0),
          price: result.executionPrice,
          status: result.status || "executed",
          origin: this.name,
          userLogin: context.actingLogin?.() ?? context.sessionId,
        })
      : undefined;
    recordTradingRunOutcome(context.orm?.getSql?.(), {
      orderId: input.orderId,
      status: result.success ? "completed" : "failed",
      action: result.action,
      symbol: result.symbol,
      quantity: result.quantity,
      broker: "public",
      mode,
      ...(result.success ? {} : { codedError: "order_execution_failed" }),
      origin: "public_place_order",
      priceSource: "draft",
      ...(notifications
        ? {
            slackNotification: notifications.slack.status,
            emailNotification: notifications.email.status,
          }
        : {}),
    });
    return notifications ? { ...result, notifications } : result;
  }
}

/**
 * 4. Public Orders Command
 * Queries active and filled orders from Public.com with status filter
 * and agentic DID audit tracing.
 */
export class PublicOrdersCommand implements IMcpToolCommand {
  readonly name = "public_orders";
  readonly description = "Query active and filled orders from Public.com with status filter and agentic DID audit tracing.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["open", "closed", "all"], description: "Order status filter (default: open)" },
    },
  };

  readonly zodSchema = z.object({
    status: z.enum(["open", "closed", "all"]).default("open").optional(),
  });

  async execute(input: { status?: "open" | "closed" | "all" }, context: McpToolContext) {
    const { platform } = await publicPlatform(context);
    const status = input.status || "open";
    // The Public platform implements getOrderHistory and the catalog
    // declares orderHistory for public — the non-null assertion is
    // the platform's own contract, not a guess about another broker.
    const orders = await platform.getOrderHistory!(status);
    context.audit?.("public.orders_queried", "trading", {
      status,
      count: orders?.length || 0,
    });
    return { success: true, orders, count: orders?.length || 0 };
  }
}

/**
 * 5. Public Cancel Order Command
 * Cancels one open Public.com order by order id. There is no
 * cancel-all on the Public MCP surface — one cancel_order call per
 * order — so the panel's cancel-all control stays Alpaca-gated.
 */
export class PublicCancelOrderCommand implements IMcpToolCommand {
  readonly name = "public_cancel_order";
  readonly description = "Cancel one open Public.com order by order ID.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "Order ID to cancel" },
      orderId: { type: "string", description: "CamelCase alias for order_id" },
    },
  };

  readonly zodSchema = z.object({
    order_id: z.string().optional(),
    orderId: z.string().optional(),
  });

  async execute(input: any, context: McpToolContext) {
    const orderId = input.order_id ?? input.orderId;
    if (!orderId) {
      throw new Error("order_id is required");
    }
    const { platform } = await publicPlatform(context);
    // The Public platform implements cancelOrderRemote and the catalog
    // declares orderCancel for public — see the note above.
    const receipt = await platform.cancelOrderRemote!(orderId);
    context.audit?.("public.order_cancelled", "trading", {
      orderId: receipt.orderId,
      success: receipt.success,
    });
    return receipt;
  }
}
