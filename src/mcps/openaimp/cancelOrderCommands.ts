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
  cancelTickerOrders,
  createCancelBrokerPort,
  recordCancelOutcome,
  recordScopedCancelOutcome,
} from "../../services/orderCancellation";
import { CANCEL_ORDER_CLASSES, resolveTradingLimits, type TradingLimitsSnapshot } from "../../trading";
import { createSettingsPort } from "../../data/createSettingsPorts";

/** The limits snapshot the cancel caps read (#3888), over the caller's own settings. */
export function readLimitsFor(context: McpToolContext, symbol?: string): TradingLimitsSnapshot {
  const sql = context.orm?.getSql?.();
  let get: ((key: string) => string | null) | undefined;
  if (sql) {
    try {
      const settings = createSettingsPort(sql);
      get = (key) => {
        try {
          return settings.get(key);
        } catch {
          return null;
        }
      };
    } catch {
      get = undefined;
    }
  }
  return resolveTradingLimits({ symbol: symbol ?? null, env: context.env, readSetting: get });
}

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
    const receipt = await cancelSingleOrder(createCancelBrokerPort(context.env), {
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

/**
 * Issue #3884 — `alpaca_cancel_ticker`: every open order for one symbol.
 *
 * The filter (#3886) rides along, so “cancel the ladder but keep my
 * protective stop” is one call. A dry run returns the target list and
 * cancels nothing; an empty match refuses with `no_orders_matched` and the
 * filter echoed — never “cancelled 0”.
 */
export class AlpacaCancelTickerCommand implements IMcpToolCommand {
  readonly name = "alpaca_cancel_ticker";
  readonly description =
    "Cancel every open order for ONE symbol, optionally narrowed by order class (simple/market/limit/stop/stop_limit/bracket/oco/oto), side, ladder id or placement time. Returns a per-order receipt (id, class, status before/after). A dry run lists the targets and cancels nothing. A filter that matches nothing refuses with no_orders_matched rather than reporting zero cancels.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker whose open orders should be cancelled (e.g. AAPL)" },
      orderClass: {
        type: "string",
        enum: [...CANCEL_ORDER_CLASSES],
        description: "Only cancels matching this class (a bracket parent is a bracket, not a limit order)",
      },
      orderSide: { type: "string", enum: ["buy", "sell"], description: "Only cancels orders on this side" },
      ladderId: { type: "string", description: "Only cancels this ladder batch's rungs (lad_…)" },
      placedAfter: { type: "string", description: "Only cancels orders placed at/after this instant (ISO timestamp or epoch ms)" },
      dryRun: { type: "boolean", description: "List the targets and cancel nothing" },
      reason: { type: "string", description: "Why the caller is cancelling (audited, never sent to the broker)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Ticker to cancel"),
    orderClass: z.enum(CANCEL_ORDER_CLASSES as unknown as [string, ...string[]]).optional(),
    orderSide: z.enum(["buy", "sell"]).optional(),
    ladderId: z.string().min(1).optional(),
    placedAfter: z.union([z.string(), z.number()]).optional(),
    dryRun: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });

  async execute(
    input: {
      symbol: string;
      orderClass?: string;
      orderSide?: "buy" | "sell";
      ladderId?: string;
      placedAfter?: string | number;
      dryRun?: boolean;
      reason?: string;
    },
    context: McpToolContext,
  ) {
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    const receipt = await cancelTickerOrders(createCancelBrokerPort(context.env), {
      symbol,
      orderClass: input.orderClass,
      orderSide: input.orderSide,
      ladderId: input.ladderId,
      placedAfter: input.placedAfter,
      dryRun: input.dryRun,
      reason: input.reason,
      limits: readLimitsFor(context, symbol),
    });

    context.audit?.(receipt.success ? "alpaca.ticker_cancelled" : "alpaca.ticker_cancel_failed", "trading", {
      symbol,
      filter: receipt.filter,
      dryRun: receipt.dryRun === true,
      targeted: receipt.targeted,
      cancelled: receipt.cancelled.map((entry) => entry.orderId),
      refused: receipt.refused.map((entry) => ({ orderId: entry.orderId, code: entry.code, message: entry.message })),
      foldedLegIds: receipt.foldedLegIds,
      code: receipt.code,
      reason: receipt.reason,
    });
    if (!receipt.dryRun) {
      recordScopedCancelOutcome(context.orm?.getSql?.(), receipt, "alpaca_cancel_ticker", context.env);
    }
    return receipt;
  }
}
