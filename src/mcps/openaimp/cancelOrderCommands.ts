/**
 * Issue #3883 — `alpaca_cancel_order`: cancel one order, as an agent tool.
 *
 * Synchronous, like `alpaca_execute_order`: the caller gets the receipt in
 * the same turn — what was targeted, what the broker cancelled, what it
 * refused. A bracket parent is cancelled WITH its held legs, and the receipt
 * says how many of each; cancelling a single leg is allowed and names the
 * parent that survived.
 *
 * The refusal is coded and factual: an already-filled order answers
 * `cancel_not_possible` naming the status, never a success and never a silent
 * no-op.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  cancelSingleOrder,
  createAlpacaCancelPort,
  recordCancelOutcome,
} from "../../services/orderCancellation";

export class AlpacaCancelOrderCommand implements IMcpToolCommand {
  readonly name = "alpaca_cancel_order";
  readonly description =
    "Cancel ONE Alpaca order by id. A bracket/OCO/OTO parent cancels its held legs too and the receipt counts them; cancelling a single leg is allowed and reports the parent that survived. An already-filled or otherwise final order refuses with cancel_not_possible naming its status — it never claims a cancel that did not happen.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The broker order id to cancel" },
      reason: { type: "string", description: "Why the caller is cancelling (recorded in the audit trail; never sent to the broker)" },
    },
    required: ["orderId"],
  };

  readonly zodSchema = z.object({
    orderId: z.string().min(1).describe("The broker order id to cancel"),
    reason: z.string().max(500).optional().describe("Caller's reason, recorded in the audit trail"),
  });

  async execute(input: { orderId: string; reason?: string }, context: McpToolContext) {
    const receipt = await cancelSingleOrder(createAlpacaCancelPort(context.env), {
      orderId: input.orderId,
      reason: input.reason,
    });

    context.audit?.(receipt.success ? "alpaca.order_cancelled" : "alpaca.order_cancel_failed", "trading", {
      orderId: receipt.target?.orderId ?? input.orderId,
      symbol: receipt.target?.symbol,
      orderClass: receipt.target?.orderClass,
      role: receipt.target?.role,
      statusBefore: receipt.target?.statusBefore,
      statusAfter: receipt.target?.statusAfter,
      legs: receipt.target?.legs,
      code: receipt.code,
      reason: receipt.reason,
      message: receipt.message,
    });
    recordCancelOutcome(context.orm?.getSql?.(), receipt, "alpaca_cancel_order", context.env);
    return receipt;
  }
}
