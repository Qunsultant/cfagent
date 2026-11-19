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
