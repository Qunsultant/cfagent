/**
 * Issue #5765 — the neutral broker order-control family on MCP.
 *
 * The neutral, broker-routed order routes exist (`/broker/order/preview`,
 * `/execute`, `/replace`, `/cancel`, `/broker/orders/*`), but the MCP
 * surface only ever offered per-broker tools (the `<broker>_cancel_order`
 * family): "cancel my order" therefore worked only when the caller already
 * knew the broker. This module is the neutral face.
 *
 * The tool is a SURFACE: routing lives in `cancelOrderViaSelectedBroker`,
 * which the HTTP route calls too. The broker is resolved by the platform,
 * never by the model, and a broker without the capability refuses by name.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  cancelAllViaSelectedBroker,
  cancelOrderViaSelectedBroker,
  cancelTickerViaSelectedBroker,
  listOrdersViaSelectedBroker,
} from "../../services/brokerOrderCancel";
import { replaceOrderViaSelectedBroker } from "../../services/brokerOrderReplace";
import { previewOrderViaSelectedBroker } from "../../services/brokerOrderPreview";
import { createOrderViaSelectedBroker } from "../../services/brokerOrderCreate";

export interface BrokerOrderCancelToolInput {
  orderId: string;
  reason?: string;
}

export class BrokerOrderCancelCommand
  implements IMcpToolCommand<BrokerOrderCancelToolInput>
{
  readonly name = "broker_order_cancel";
  readonly description =
    "Cancel ONE open order on whichever broker holds it, chosen by the platform's broker selection — never by the caller. Works for any routed broker that declares order cancellation; a broker without the capability refuses by name and no other broker is asked to cancel it. Where the platform has its own cancellation engine, that engine runs (bracket/OCO family and leg semantics; a filled order refuses). The receipt names the broker and its reported status. Synchronous: the call returns the definitive outcome, not a queue receipt. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: {
        type: "string",
        description: "The broker order id to cancel",
      },
      reason: {
        type: "string",
        description:
          "Optional note explaining the cancel; audited, never sent to the broker",
      },
    },
    required: ["orderId"],
  };
  readonly zodSchema = z.object({
    orderId: z.string().min(1),
    reason: z.string().max(500).optional(),
  });

  async execute(input: BrokerOrderCancelToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await cancelOrderViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      orderId: input.orderId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    context.audit("broker_order_cancel", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      orderId: result.orderId,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

export interface BrokerOrderReplaceToolInput {
  orderId: string;
  quantity?: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: string;
  trail_price?: number;
  trail_percent?: number;
}

/**
 * Issue #5766 — the neutral replace surface. Only the fields the caller
 * states are sent, so an unstated term keeps its broker value; an empty
 * replace is refused rather than forwarded. The broker is resolved by the
 * platform, never named by the model, and a broker that cannot replace
 * refuses by name — nothing is cancelled and re-placed behind the user.
 */
export class BrokerOrderReplaceCommand
  implements IMcpToolCommand<BrokerOrderReplaceToolInput>
{
  readonly name = "broker_order_replace";
  readonly description =
    "Replace ONE open order in place on whichever broker holds it, chosen by the platform's broker selection — never by the caller. Only the fields you state are sent, so an unstated term keeps its broker value; at least one change is required. A broker that cannot replace an open order refuses by name — nothing is cancelled and re-placed (that would drop queue position and detach bracket legs). A compound parent and an order that is no longer open are refused by name. Synchronous: the call returns the definitive outcome, not a queue receipt. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The broker order id to replace" },
      quantity: { type: "number", description: "New quantity (omit to keep)" },
      limit_price: { type: "number", description: "New limit price (omit to keep)" },
      stop_price: { type: "number", description: "New stop trigger (omit to keep)" },
      time_in_force: {
        type: "string",
        description: "New time-in-force (omit to keep)",
      },
      trail_price: { type: "number", description: "New trail distance in dollars (omit to keep)" },
      trail_percent: { type: "number", description: "New trail distance in percent (omit to keep)" },
    },
    required: ["orderId"],
  };
  readonly zodSchema = z.object({
    orderId: z.string().min(1),
    quantity: z.number().positive().optional(),
    limit_price: z.number().positive().optional(),
    stop_price: z.number().positive().optional(),
    time_in_force: z.string().min(1).optional(),
    trail_price: z.number().positive().optional(),
    trail_percent: z.number().positive().optional(),
  });

  async execute(input: BrokerOrderReplaceToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const requestedEnv = await resolveRequestedEnv(context);
    const result = await replaceOrderViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      orderId: input.orderId,
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      ...(input.limit_price !== undefined ? { limitPrice: input.limit_price } : {}),
      ...(input.stop_price !== undefined ? { stopPrice: input.stop_price } : {}),
      ...(input.time_in_force !== undefined ? { timeInForce: input.time_in_force } : {}),
      ...(input.trail_price !== undefined ? { trailPrice: input.trail_price } : {}),
      ...(input.trail_percent !== undefined ? { trailPercent: input.trail_percent } : {}),
      requestedEnv,
    });
    context.audit("broker_order_replace", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      orderId: result.orderId,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

export interface BrokerOrderPreviewToolInput {
  symbol: string;
  orderAction: string;
  quantity: number;
  orderType: string;
  broker?: string;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: string;
  asset_class?: string;
  option_legs?: unknown[];
  strategy_net_debit?: number;
}

/**
 * Issue #5767 — the neutral preview surface. It returns the broker's own
 * computed terms for the described order and PLACES NOTHING. It does not
 * create an approvable draft: that needs the route's payload hash,
 * proposer attestation, autopilot verdict and draft row, and creating one
 * from chat would move the execute gate that the broker-tool mode config records as not
 * switchable. Approvable creation stays on `propose_stock_trade` + the
 * approval flow.
 */
export class BrokerOrderPreviewCommand
  implements IMcpToolCommand<BrokerOrderPreviewToolInput>
{
  readonly name = "broker_order_preview";
  readonly description =
    "Preview an order at a broker and return the broker's own computed terms: symbol, action, quantity, order type, optional limit/stop, time-in-force, equity or options legs. The broker may be named or omitted (omitted = the platform's selected broker). PLACES NOTHING and stores no draft — this is a dry run. An order that a broker cannot preview refuses by name, an unconfigured broker returns its connect-flow code, and an invalid term (action, type, quantity, price, time-in-force, asset class/legs) is refused before the broker is called. To create an approvable order, use propose_stock_trade and the approval flow. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol (equity) or underlying (options)" },
      orderAction: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"] },
      quantity: { type: "number", description: "Positive whole number of shares/contracts" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"] },
      broker: { type: "string", description: "Optional routed broker; omit for the selected broker" },
      limit_price: { type: "number", description: "Limit price for LIMIT/STOP_LIMIT" },
      stop_price: { type: "number", description: "Stop trigger for STOP/STOP_LIMIT" },
      time_in_force: { type: "string", description: "Optional time-in-force (DAY, GTC, ...)" },
      asset_class: { type: "string", enum: ["equity", "options"] },
      option_legs: { type: "array", description: "Option contract legs (options only)", items: { type: "object" } },
      strategy_net_debit: { type: "number", description: "Optional net debit for a multi-leg strategy" },
    },
    required: ["symbol", "orderAction", "quantity", "orderType"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1),
    orderAction: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().int().positive(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]),
    broker: z.string().min(1).optional(),
    limit_price: z.number().positive().optional(),
    stop_price: z.number().positive().optional(),
    time_in_force: z.string().min(1).optional(),
    asset_class: z.enum(["equity", "options"]).optional(),
    option_legs: z.array(z.record(z.string(), z.unknown())).optional(),
    strategy_net_debit: z.number().optional(),
  });

  async execute(input: BrokerOrderPreviewToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await previewOrderViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      sessionId: context.sessionId,
      ...(input.broker ? { broker: input.broker } : {}),
      symbol: input.symbol,
      orderAction: input.orderAction,
      quantity: input.quantity,
      orderType: input.orderType,
      ...(input.limit_price !== undefined ? { limitPrice: input.limit_price } : {}),
      ...(input.stop_price !== undefined ? { stopPrice: input.stop_price } : {}),
      ...(input.time_in_force !== undefined ? { timeInForce: input.time_in_force } : {}),
      ...(input.asset_class !== undefined ? { assetClass: input.asset_class } : {}),
      ...(input.option_legs ? { optionLegs: input.option_legs } : {}),
      ...(input.strategy_net_debit !== undefined
        ? { strategyNetDebit: input.strategy_net_debit }
        : {}),
    });
    context.audit("broker_order_preview", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      symbol: input.symbol,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

export interface BrokerOrderCreateToolInput {
  symbol: string;
  action: string;
  quantity: number;
  order_type?: string;
  limit_price?: number;
  stop_price?: number;
  provider?: string;
}

/**
 * Issue #5767 — the neutral create surface: propose on the routed broker and
 * submit the proposal to the approval workflow, in one synchronous call.
 * It places nothing: placement happens only when a human decides the approval
 * and the workflow's settle step executes. Composes the two existing door
 * calls; no second proposal path, no placement path.
 */
export class BrokerOrderCreateCommand
  implements IMcpToolCommand<BrokerOrderCreateToolInput>
{
  readonly name = "broker_order_create";
  readonly description =
    "Create a stock order on the platform-selected broker (or a named one) and submit it for approval, in one synchronous call. Returns the broker's pending-approval proposal and the approval run's id. PLACES NOTHING: a human decides the approval and the workflow's settle step executes; no order reaches the broker for execution from this tool. An invalid action/quantity/price is refused before the broker is called, and a broker that returns no proposal is reported with its status instead of an invented success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol" },
      action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"] },
      quantity: { type: "number", description: "Positive share quantity" },
      order_type: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"] },
      limit_price: { type: "number", description: "Limit price for LIMIT/STOP_LIMIT" },
      stop_price: { type: "number", description: "Stop trigger for STOP/STOP_LIMIT" },
      provider: { type: "string", description: "Optional routed broker; omit for the selected broker" },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().positive(),
    order_type: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
    limit_price: z.number().positive().optional(),
    stop_price: z.number().positive().optional(),
    provider: z.string().min(1).optional(),
  });

  async execute(input: BrokerOrderCreateToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await createOrderViaSelectedBroker({
      env: context.env,
      userLogin: actingLogin ?? "",
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      ...(input.order_type !== undefined ? { orderType: input.order_type } : {}),
      ...(input.limit_price !== undefined ? { limitPrice: input.limit_price } : {}),
      ...(input.stop_price !== undefined ? { stopPrice: input.stop_price } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    });
    context.audit("broker_order_create", "mcp", {
      actingLogin: actingLogin ?? null,
      provider: result.provider ?? null,
      symbol: input.symbol,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

async function resolveRequestedEnv(context: McpToolContext) {
  const { resolveTradeEnvironmentFromSettings } = await import(
    "../../agents/routes/brokerEnvironment"
  );
  return resolveTradeEnvironmentFromSettings(context.readSettingRaw, context.env);
}

export interface BrokerOrdersListToolInput {
  status?: "open" | "all";
  symbol?: string;
}

/**
 * Issue #5806 — neutral orders list on the platform's selected broker.
 */
export class BrokerOrdersListCommand
  implements IMcpToolCommand<BrokerOrdersListToolInput>
{
  readonly name = "broker_orders_list";
  readonly description =
    "List open or all orders on the platform's selected broker (never caller-supplied). Optional symbol filter returns matching orders only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["open", "all"], description: "Order status filter (default open)" },
      symbol: { type: "string", description: "Optional ticker symbol filter" },
    },
    required: [],
  };
  readonly zodSchema = z.object({
    status: z.enum(["open", "all"]).optional(),
    symbol: z.string().min(1).optional(),
  });

  async execute(input: BrokerOrdersListToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const requestedEnv = await resolveRequestedEnv(context);
    const result = await listOrdersViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      ...(input.status ? { status: input.status } : {}),
      ...(input.symbol ? { symbol: input.symbol } : {}),
      requestedEnv,
    });
    context.audit("broker_orders_list", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      status: result.status,
      count: result.count,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

export interface BrokerOrderCancelTickerToolInput {
  symbol: string;
  order_class?: string;
  order_side?: string;
  ladder_id?: string;
  placed_after?: string;
  dry_run?: boolean;
  reason?: string;
}

/**
 * Issue #5806 — neutral per-ticker open-order cancel on the selected broker.
 */
export class BrokerOrderCancelTickerCommand
  implements IMcpToolCommand<BrokerOrderCancelTickerToolInput>
{
  readonly name = "broker_order_cancel_ticker";
  readonly description =
    "Cancel open orders for ONE ticker symbol on the platform's selected broker. A broker without orderCancel refuses by name. Supports dry_run and optional filters (order_class, order_side, ladder_id, placed_after). Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol whose open orders should be cancelled" },
      order_class: { type: "string", description: "Optional order class filter" },
      order_side: { type: "string", description: "Optional order side filter" },
      ladder_id: { type: "string", description: "Optional ladder id filter" },
      placed_after: { type: "string", description: "Optional ISO timestamp filter" },
      dry_run: { type: "boolean", description: "If true, previews matching orders without cancelling" },
      reason: { type: "string", description: "Optional audit note" },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1),
    order_class: z.string().min(1).optional(),
    order_side: z.string().min(1).optional(),
    ladder_id: z.string().min(1).optional(),
    placed_after: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });

  async execute(input: BrokerOrderCancelTickerToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const requestedEnv = await resolveRequestedEnv(context);
    const result = await cancelTickerViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      symbol: input.symbol,
      ...(input.order_class ? { orderClass: input.order_class } : {}),
      ...(input.order_side ? { orderSide: input.order_side } : {}),
      ...(input.ladder_id ? { ladderId: input.ladder_id } : {}),
      ...(input.placed_after ? { placedAfter: input.placed_after } : {}),
      ...(input.dry_run !== undefined ? { dryRun: input.dry_run } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      readSetting: context.readSettingRaw
        ? (key) => {
            const v = context.readSettingRaw?.(key);
            return typeof v === "string" ? v : null;
          }
        : undefined,
      requestedEnv,
    });
    context.audit("broker_order_cancel_ticker", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      symbol: input.symbol,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}

export interface BrokerOrderCancelAllToolInput {
  confirm?: string;
  dry_run?: boolean;
  reason?: string;
}

/**
 * Issue #5806 — neutral two-step cancel-all on the platform's selected broker (#3885).
 */
export class BrokerOrderCancelAllCommand
  implements IMcpToolCommand<BrokerOrderCancelAllToolInput>
{
  readonly name = "broker_order_cancel_all";
  readonly description =
    "Cancel EVERY open order on the platform's selected broker in two steps: a bare call returns a preview and single-use confirm token and cancels NOTHING; a second call with confirm=<token> executes the cancellations. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      confirm: { type: "string", description: "Single-use confirmation token from the preview call" },
      dry_run: { type: "boolean", description: "If true, returns the preview without cancelling" },
      reason: { type: "string", description: "Optional audit note" },
    },
    required: [],
  };
  readonly zodSchema = z.object({
    confirm: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });

  async execute(input: BrokerOrderCancelAllToolInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const requestedEnv = await resolveRequestedEnv(context);
    const result = await cancelAllViaSelectedBroker({
      env: context.env,
      ...(context.orm ? { orm: context.orm } : {}),
      userLogin: actingLogin ?? "",
      ...(input.confirm ? { confirm: input.confirm } : {}),
      ...(input.dry_run !== undefined ? { dryRun: input.dry_run } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      readSetting: context.readSettingRaw
        ? (key) => {
            const v = context.readSettingRaw?.(key);
            return typeof v === "string" ? v : null;
          }
        : undefined,
      requestedEnv,
    });
    context.audit("broker_order_cancel_all", "mcp", {
      actingLogin: actingLogin ?? null,
      broker: result.broker,
      success: result.success,
      ...(result.code ? { code: result.code } : {}),
    });
    return result;
  }
}
