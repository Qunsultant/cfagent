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
  cancelAllOrders,
  cancelSingleOrder,
  cancelTickerOrders,
  createCancelBrokerPort,
  markDraftRowCancelledIfPresent,
  markScopedDraftsCancelledIfPresent,
  recordCancelOutcome,
  recordScopedCancelOutcome,
} from "../../services/orderCancellation";
import {
  createInMemoryCancelPreviewStore,
  createSqlCancelPreviewStore,
  type CancelPreviewStore,
} from "../../services/cancelPreviewStore";
import {
  CANCEL_ORDER_CLASSES,
  TIME_IN_FORCE_VALUES,
  TradingPlatformRegistry,
  normalizeTimeInForce,
  resolveTradingLimits,
  type TradingLimitsSnapshot,
} from "../../trading";
import { createSettingsPort } from "../../data/createSettingsPorts";

/**
 * A host without Durable Object storage still gets a working two-step flow
 * inside one process; the TTL bounds how long a token can live either way.
 */
const fallbackPreviewStore = createInMemoryCancelPreviewStore();

function previewStoreFor(context: McpToolContext): CancelPreviewStore {
  const sql = context.orm?.getSql?.();
  if (!sql) return fallbackPreviewStore;
  try {
    return createSqlCancelPreviewStore(sql);
  } catch {
    return fallbackPreviewStore;
  }
}

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
    await recordCancelOutcome(context.orm?.getSql?.(), receipt, "alpaca_cancel_order", context.env);
    if (receipt.success) {
      markDraftRowCancelledIfPresent(context.orm, receipt.target?.orderId ?? input.orderId);
    }
    return receipt;
  }
}

async function resolveSelectedAlpacaPlatform(context: McpToolContext) {
  const { resolveTradeEnvironmentFromSettings } = await import("../../agents/routes/brokerEnvironment");
  const environment = resolveTradeEnvironmentFromSettings(context.readSettingRaw, context.env);
  return {
    environment,
    platform: TradingPlatformRegistry.getPlatform("alpaca", context.env, context.orm, context.sessionId, environment),
  };
}

/**
 * Issue #4670 (matrix gap 16) — `alpaca_replace_order`: change ONE open order in
 * place, as an agent tool.
 *
 * The gap this closes is that replace existed only as a validator with no
 * caller: a caller could cancel and re-place, which drops queue position and
 * (for a bracket) detaches the held legs. This tool runs the SAME platform
 * method the neutral route runs, so the two surfaces cannot disagree.
 *
 * The refusal is coded and factual, exactly like cancel: a compound parent
 * (bracket/oco/oto) and an order that is no longer open answer with a named
 * code rather than a silent no-op.
 */
export class AlpacaReplaceOrderCommand implements IMcpToolCommand<{
  orderId: string;
  quantity?: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: string;
  trail_price?: number;
  trail_percent?: number;
}> {
  readonly name = "alpaca_replace_order";
  readonly description =
    "Replace ONE open Alpaca order in place (PATCH /v2/orders/{id}): quantity, limit price, stop price, time-in-force or trail. Only the fields you state are sent, so an unstated term keeps its broker value. A bracket/OCO/OTO parent and an order that is no longer open are refused by name — nothing is cancelled and re-placed behind your back.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The broker order id to replace" },
      quantity: { type: "number", description: "New quantity (omit to keep)" },
      limit_price: { type: "number", description: "New limit price (omit to keep)" },
      stop_price: { type: "number", description: "New stop trigger (omit to keep)" },
      time_in_force: {
        type: "string",
        enum: [...TIME_IN_FORCE_VALUES],
        description: "New time-in-force (omit to keep)",
      },
      trail_price: { type: "number", description: "New trail distance in dollars (omit to keep)" },
      trail_percent: { type: "number", description: "New trail distance in percent (omit to keep)" },
    },
    required: ["orderId"],
  };

  readonly zodSchema = z.object({
    orderId: z.string().min(1).describe("The broker order id to replace"),
    quantity: z.number().positive().optional(),
    limit_price: z.number().positive().optional(),
    stop_price: z.number().positive().optional(),
    time_in_force: z.enum([...TIME_IN_FORCE_VALUES] as [string, ...string[]]).optional(),
    trail_price: z.number().positive().optional(),
    trail_percent: z.number().positive().optional(),
  });

  async execute(
    input: {
      orderId: string;
      quantity?: number;
      limit_price?: number;
      stop_price?: number;
      time_in_force?: string;
      trail_price?: number;
      trail_percent?: number;
    },
    context: McpToolContext,
  ) {
    const orderId = String(input?.orderId ?? "").trim();
    if (!orderId) throw new Error("orderId is required");

    // The tenant's STORED environment, never a per-call override — the same
    // resolution the sibling order tools use.
    const { environment, platform } = await resolveSelectedAlpacaPlatform(context);
    if (typeof platform.replaceOrderRemote !== "function") {
      throw new Error("This broker does not provide order replacement on this platform instance.");
    }

    const receipt = await platform.replaceOrderRemote({
      orderId,
      quantity: input.quantity,
      limitPrice: input.limit_price,
      stopPrice: input.stop_price,
      timeInForce: normalizeTimeInForce(input.time_in_force),
      trailPrice: input.trail_price,
      trailPercent: input.trail_percent,
    });

    context.audit?.(receipt.success ? "alpaca.order_replaced" : "alpaca.order_replace_refused", "trading", {
      orderId: receipt.orderId,
      status: receipt.status,
      code: receipt.code,
      environment,
      message: receipt.message,
    });
    return receipt;
  }
}

/**
 * Issue #4672 (matrix gap 18) — `alpaca_exercise_option`: exercise an open long
 * option position (`POST /v2/positions/{symbol_or_contract_id}/exercise`).
 */
export class AlpacaExerciseOptionCommand implements IMcpToolCommand<{ symbolOrContractId: string }> {
  readonly name = "alpaca_exercise_option";
  readonly description =
    "Exercise an open long option contract position (POST /v2/positions/{symbol_or_contract_id}/exercise).";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbolOrContractId: {
        type: "string",
        description: "OCC option symbol (e.g. AAPL261218C00200000) or broker position contract id",
      },
    },
    required: ["symbolOrContractId"],
  };

  readonly zodSchema = z.object({
    symbolOrContractId: z.string().min(1).describe("OCC option symbol or contract id"),
  });

  async execute(input: { symbolOrContractId: string }, context: McpToolContext) {
    const symbolOrContractId = String(input?.symbolOrContractId ?? "").trim();
    if (!symbolOrContractId) throw new Error("symbolOrContractId is required");

    const { platform } = await resolveSelectedAlpacaPlatform(context);
    if (typeof platform.exerciseOption !== "function") {
      throw new Error("This broker does not support option exercise on this platform instance.");
    }

    const receipt = await platform.exerciseOption(symbolOrContractId);
    context.audit?.(receipt.success ? "alpaca.option_exercised" : "alpaca.option_exercise_refused", "trading", {
      symbolOrContractId: receipt.symbolOrContractId,
      status: receipt.status,
      code: receipt.code,
      message: receipt.message,
    });
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
      await recordScopedCancelOutcome(context.orm?.getSql?.(), receipt, "alpaca_cancel_ticker", context.env);
      markScopedDraftsCancelledIfPresent(context.orm, receipt);
    }
    return receipt;
  }
}

/**
 * Issue #3885 — `alpaca_cancel_all`: cancel every open order, in two steps.
 *
 * A bare call never cancels: it returns a preview (count, symbols, classes,
 * oldest/newest) plus a single-use token. Only a second call presenting that
 * token acts, on exactly the ids the user was shown. Above `cancelMaxCount`
 * the preview refuses and reports the real count; an unset cap refuses too,
 * because “cancel everything” must never run unbounded.
 */
export class AlpacaCancelAllCommand implements IMcpToolCommand {
  readonly name = "alpaca_cancel_all";
  readonly description =
    "Cancel EVERY open Alpaca order, always in two steps. The first call returns a preview (count, symbols, classes, oldest/newest) and a single-use token; nothing is cancelled. The second call with that token cancels exactly the orders the preview listed. Refuses above the configured cancelMaxCount (reporting the real count) and refuses when no cap is configured. Tokens are single-use and expire.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      confirm: { type: "string", description: "The preview token returned by the first call. Omit to get a preview." },
      dryRun: { type: "boolean", description: "Return the preview and issue no token; cancels nothing" },
      reason: { type: "string", description: "Why the caller is cancelling (audited, never sent to the broker)" },
    },
  };

  readonly zodSchema = z.object({
    confirm: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });

  async execute(
    input: { confirm?: string; dryRun?: boolean; reason?: string },
    context: McpToolContext,
  ) {
    const receipt = await cancelAllOrders(
      createCancelBrokerPort(context.env),
      {
        token: input.confirm,
        dryRun: input.dryRun,
        reason: input.reason,
        limits: readLimitsFor(context),
      },
      previewStoreFor(context),
    );

    context.audit?.(
      receipt.success ? "alpaca.cancel_all_completed" : receipt.previewToken ? "alpaca.cancel_all_previewed" : "alpaca.cancel_all_refused",
      "trading",
      {
        code: receipt.code,
        preview: receipt.preview ?? null,
        targeted: receipt.targeted,
        cancelled: receipt.cancelled.map((entry) => entry.orderId),
        refused: receipt.refused.map((entry) => ({ orderId: entry.orderId, code: entry.code, message: entry.message })),
        dryRun: receipt.dryRun === true,
        reason: receipt.reason,
      },
    );
    if (receipt.success || receipt.cancelled.length > 0 || receipt.refused.length > 0) {
      await recordScopedCancelOutcome(
        context.orm?.getSql?.(),
        receipt,
        "alpaca_cancel_all",
        context.env,
        `cancel_all:${receipt.preview?.expiresAt ?? new Date().toISOString()}`,
      );
      markScopedDraftsCancelledIfPresent(context.orm, receipt);
    }
    return receipt;
  }
}
