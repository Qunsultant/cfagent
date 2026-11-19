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
import { cancelOrderViaSelectedBroker } from "../../services/brokerOrderCancel";
import { replaceOrderViaSelectedBroker } from "../../services/brokerOrderReplace";

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
    const { resolveTradeEnvironmentFromSettings } = await import(
      "../../agents/routes/brokerEnvironment"
    );
    const requestedEnv = resolveTradeEnvironmentFromSettings(
      context.readSettingRaw,
      context.env,
    );
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
