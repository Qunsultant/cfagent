/**
 * Issue #5765 — cancel ONE order on whichever routed broker holds it.
 *
 * The neutral route (`src/agents/routes/brokerOrders.ts`, `POST
 * /broker/order/cancel`) and the new MCP tool both call this function:
 * one routing rule, two surfaces, so they cannot give different answers
 * about one order (#3883's concern, now past a single provider).
 *
 * The rule, unchanged from the route:
 *  - the broker is RESOLVED (tenant selection), never supplied by a
 *    caller or a model — an order stays on the broker that holds it;
 *  - the broker must declare the `orderCancel` capability, else the
 *    refusal names it and no other broker is asked to cancel;
 *  - where the platform has its own cancellation engine, that engine
 *    runs (`cancelSingleOrder`: bracket/OCO family semantics, leg
 *    detection, a filled order's refusal) so the surfaces that share it
 *    cannot disagree;
 *  - every other broker goes through its platform adapter;
 *  - a cancel is recorded through `recordCancelOutcome` either way.
 */
import {
  brokerSupports,
  resolveTradingLimits,
  TradingPlatformRegistry,
  type BrokerId,
} from "../trading";
import { resolveTenantBroker } from "./tenantProviders";
import { createSqlCancelPreviewStore } from "./cancelPreviewStore";
import {
  cancelAllOrders,
  cancelSingleOrder,
  cancelTickerOrders,
  createCancelBrokerPort,
  createPlatformCancelPort,
  markDraftRowCancelledIfPresent,
  recordCancelOutcome,
  recordScopedCancelOutcome,
  type CancelBrokerPort,
  type ScopedCancelReceipt,
} from "./orderCancellation";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";

export interface BrokerOrderCancelInput {
  env: Env;
  orm?: DatabaseORM;
  /** The acting login; control is never anonymous. */
  userLogin: string;
  orderId: string;
  /** A caller's note, audited and never sent to the broker. */
  reason?: string;
  /** The resolved trade environment (TEST / LIVE), as the routes resolve it. */
  requestedEnv?: string;
}

export interface BrokerOrderCancelResult {
  success: boolean;
  /** The broker that was asked (never a caller-supplied one). */
  broker: BrokerId | "unknown";
  orderId: string;
  code?: string;
  message: string;
  /** The broker's/engine's own receipt, unflattened. */
  receipt: unknown;
}

function refusal(
  broker: BrokerId | "unknown",
  orderId: string,
  code: string,
  message: string,
): BrokerOrderCancelResult {
  return { success: false, broker, orderId, code, message, receipt: null };
}

function usesServiceCancelPort(broker: BrokerId): boolean {
  return broker === "alpaca";
}

export async function cancelOrderViaSelectedBroker(
  input: BrokerOrderCancelInput,
): Promise<BrokerOrderCancelResult> {
  const login =
    typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return refusal(
      "unknown",
      String(input.orderId ?? ""),
      "identity_required",
      "A cancel needs the acting login; nothing was sent.",
    );
  }
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) {
    return refusal(
      "unknown",
      "",
      "invalid_order_id",
      "A cancel needs an order id; nothing was sent.",
    );
  }

  const broker = await resolveTenantBroker(input.env);
  const platform = brokerSupports(broker, "orderCancel")
    ? TradingPlatformRegistry.getPlatform(
        broker,
        input.env,
        input.orm,
        login,
        input.requestedEnv,
      )
    : null;
  if (!platform) {
    return refusal(
      broker,
      orderId,
      "provider_unsupported",
      `${broker} does not declare the orderCancel capability here; no other broker was asked to cancel it.`,
    );
  }

  const sql = input.orm?.getSql?.();

  if (usesServiceCancelPort(broker)) {
    const receipt = await cancelSingleOrder(createCancelBrokerPort(input.env), {
      orderId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await recordCancelOutcome(sql, receipt, "broker_order_cancel", input.env);
    if (receipt.success) {
      markDraftRowCancelledIfPresent(input.orm as never, receipt.target?.orderId ?? orderId);
    }
    return {
      success: receipt.success,
      broker,
      orderId: receipt.target?.orderId ?? orderId,
      ...(receipt.code ? { code: receipt.code } : {}),
      message: receipt.message,
      receipt,
    };
  }

  if (typeof platform.cancelOrderRemote !== "function") {
    return refusal(
      broker,
      orderId,
      "provider_unsupported",
      `${broker} exposes no remote cancel; no other broker was asked to cancel it.`,
    );
  }
  const cancelled = await platform.cancelOrderRemote(orderId);
  if (cancelled.success) {
    markDraftRowCancelledIfPresent(input.orm as never, orderId);
  }
  return {
    success: cancelled.success === true,
    broker,
    orderId,
    ...(cancelled.success ? {} : { code: "cancel_refused" }),
    message:
      typeof (cancelled as { message?: unknown }).message === "string"
        ? ((cancelled as { message: string }).message)
        : cancelled.success
          ? `Cancelled order ${orderId} on ${broker}.`
          : `${broker} refused to cancel order ${orderId}.`,
    receipt: cancelled,
  };
}

/**
 * Shared cancel port resolver across the service-port broker and any
 * ITradingPlatform broker that exposes `getOrderHistory` + `cancelOrderRemote` (#3937, #5806).
 */
export function cancelPortForBroker(
  broker: BrokerId,
  env: Env,
  orm: DatabaseORM | undefined,
  userLogin: string,
  requestedEnv?: string,
): CancelBrokerPort | null {
  if (usesServiceCancelPort(broker)) return createCancelBrokerPort(env);
  const platform = TradingPlatformRegistry.getPlatform(
    broker,
    env,
    orm,
    userLogin,
    requestedEnv,
  );
  if (
    typeof platform.getOrderHistory !== "function" ||
    typeof platform.cancelOrderRemote !== "function"
  ) {
    return null;
  }
  return createPlatformCancelPort(platform);
}

/**
 * Ledger identity for a scoped cancel on a non-service-port broker (#3937).
 */
export function scopedCancelLedger(
  broker: string,
  requestedEnv?: string,
): { broker: string; mode: "live" | "paper" } {
  return {
    broker,
    mode: requestedEnv === "PROD" || requestedEnv === "live" ? "live" : "paper",
  };
}

export interface BrokerOrdersListInput {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
  status?: "open" | "all";
  symbol?: string;
  requestedEnv?: string;
}

export interface BrokerOrdersListResult {
  success: boolean;
  broker: BrokerId | "unknown";
  status: "open" | "all";
  count: number;
  orders: unknown[];
  code?: string;
  message: string;
}

/**
 * List open or all orders on the tenant's selected broker (#5806).
 */
export async function listOrdersViaSelectedBroker(
  input: BrokerOrdersListInput,
): Promise<BrokerOrdersListResult> {
  const login = typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  const status: "open" | "all" = input.status === "all" ? "all" : "open";
  if (!login) {
    return {
      success: false,
      broker: "unknown",
      status,
      count: 0,
      orders: [],
      code: "identity_required",
      message: "Listing orders needs the acting login; nothing was queried.",
    };
  }
  const broker = await resolveTenantBroker(input.env);
  if (!brokerSupports(broker, "orderHistory")) {
    return {
      success: false,
      broker,
      status,
      count: 0,
      orders: [],
      code: "provider_unsupported",
      message: `${broker} does not declare orderHistory here; no other broker was queried.`,
    };
  }
  const platform = TradingPlatformRegistry.getPlatform(
    broker,
    input.env,
    input.orm,
    login,
    input.requestedEnv,
  );
  if (typeof platform.getOrderHistory !== "function") {
    return {
      success: false,
      broker,
      status,
      count: 0,
      orders: [],
      code: "provider_unsupported",
      message: `${broker} exposes no order history reader; no other broker was queried.`,
    };
  }
  try {
    const rawOrders = await platform.getOrderHistory(status);
    const symbolFilter = input.symbol?.trim().toUpperCase();
    const orders = symbolFilter
      ? rawOrders.filter(
          (o) => String((o as { symbol?: unknown }).symbol ?? "").trim().toUpperCase() === symbolFilter,
        )
      : rawOrders;
    return {
      success: true,
      broker,
      status,
      count: orders.length,
      orders,
      message: `Retrieved ${orders.length} ${status} order${orders.length === 1 ? "" : "s"} from ${broker}.`,
    };
  } catch (err) {
    return {
      success: false,
      broker,
      status,
      count: 0,
      orders: [],
      code: "order_history_failed",
      message: err instanceof Error ? err.message : `Failed to list orders on ${broker}.`,
    };
  }
}

export interface BrokerOrderCancelTickerInput {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
  symbol: string;
  orderClass?: string;
  orderSide?: string;
  ladderId?: string;
  placedAfter?: string;
  dryRun?: boolean;
  reason?: string;
  readSetting?: (key: string) => string | null;
  requestedEnv?: string;
}

export interface BrokerScopedCancelResult {
  success: boolean;
  broker: BrokerId | "unknown";
  code?: string;
  message: string;
  receipt: ScopedCancelReceipt | null;
}

/**
 * Cancel open orders for a single ticker on the tenant's selected broker (#5806).
 */
export async function cancelTickerViaSelectedBroker(
  input: BrokerOrderCancelTickerInput,
): Promise<BrokerScopedCancelResult> {
  const login = typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return {
      success: false,
      broker: "unknown",
      code: "identity_required",
      message: "A ticker cancel needs the acting login; nothing was cancelled.",
      receipt: null,
    };
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    return {
      success: false,
      broker: "unknown",
      code: "no_orders_matched",
      message: "A ticker cancel needs a symbol. Nothing was cancelled.",
      receipt: null,
    };
  }
  const broker = await resolveTenantBroker(input.env);
  if (!brokerSupports(broker, "orderCancel")) {
    return {
      success: false,
      broker,
      code: "provider_unsupported",
      message: `${broker} does not expose a per-symbol open-order cancel here; no other broker was asked to cancel ${symbol}.`,
      receipt: null,
    };
  }
  const port = cancelPortForBroker(broker, input.env, input.orm, login, input.requestedEnv);
  if (!port) {
    return {
      success: false,
      broker,
      code: "BROKER_CAPABILITY_NOT_IMPLEMENTED",
      message: `${broker} declares order cancellation but does not implement the reads it needs; no other broker was asked to cancel ${symbol}.`,
      receipt: null,
    };
  }
  const limits = resolveTradingLimits({
    symbol,
    env: input.env,
    readSetting: input.readSetting,
  });
  const receipt = await cancelTickerOrders(port, {
    symbol,
    orderClass: input.orderClass as never,
    orderSide: input.orderSide as never,
    ladderId: input.ladderId,
    placedAfter: input.placedAfter,
    dryRun: input.dryRun === true,
    reason: input.reason,
    limits,
  });
  if (!receipt.dryRun) {
    const sql = input.orm?.getSql?.();
    if (usesServiceCancelPort(broker)) {
      await recordScopedCancelOutcome(sql, receipt, "broker_orders_cancel_ticker", input.env);
    } else {
      await recordScopedCancelOutcome(
        sql,
        receipt,
        "broker_orders_cancel_ticker",
        input.env,
        undefined,
        scopedCancelLedger(broker, input.requestedEnv),
      );
    }
  }
  return {
    success: receipt.success,
    broker,
    ...(receipt.code ? { code: receipt.code } : {}),
    message: receipt.message,
    receipt,
  };
}

export interface BrokerOrderCancelAllInput {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
  confirm?: string;
  dryRun?: boolean;
  reason?: string;
  readSetting?: (key: string) => string | null;
  requestedEnv?: string;
}

/**
 * Cancel every open order on the tenant's selected broker using the two-step
 * preview-token protocol (#3885, #5806).
 */
export async function cancelAllViaSelectedBroker(
  input: BrokerOrderCancelAllInput,
): Promise<BrokerScopedCancelResult> {
  const login = typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return {
      success: false,
      broker: "unknown",
      code: "identity_required",
      message: "Cancel-all needs the acting login; nothing was cancelled.",
      receipt: null,
    };
  }
  const broker = await resolveTenantBroker(input.env);
  if (!brokerSupports(broker, "orderCancel")) {
    return {
      success: false,
      broker,
      code: "provider_unsupported",
      message: `${broker} does not expose a cancel-all here; no other broker was asked to cancel every open order.`,
      receipt: null,
    };
  }
  const port = cancelPortForBroker(broker, input.env, input.orm, login, input.requestedEnv);
  if (!port) {
    return {
      success: false,
      broker,
      code: "BROKER_CAPABILITY_NOT_IMPLEMENTED",
      message: `${broker} declares order cancellation but does not implement the reads it needs; no other broker was asked to cancel every open order.`,
      receipt: null,
    };
  }
  const sql = input.orm?.getSql?.();
  if (!sql) {
    return {
      success: false,
      broker,
      code: "cancel_preview_store_unavailable",
      message: "The preview store is unavailable, so cancel-all refused rather than cancel unbounded.",
      receipt: null,
    };
  }
  const limits = resolveTradingLimits({
    env: input.env,
    readSetting: input.readSetting,
  });
  const receipt = await cancelAllOrders(
    port,
    {
      token: typeof input.confirm === "string" ? input.confirm : undefined,
      dryRun: input.dryRun === true,
      reason: input.reason,
      limits,
    },
    createSqlCancelPreviewStore(sql),
  );
  if (receipt.success || receipt.cancelled.length > 0 || receipt.refused.length > 0) {
    const suffix = `cancel_all:${receipt.preview?.expiresAt ?? new Date().toISOString()}`;
    if (usesServiceCancelPort(broker)) {
      await recordScopedCancelOutcome(sql, receipt, "broker_orders_cancel_all", input.env, suffix);
    } else {
      await recordScopedCancelOutcome(
        sql,
        receipt,
        "broker_orders_cancel_all",
        input.env,
        suffix,
        scopedCancelLedger(broker, input.requestedEnv),
      );
    }
  }
  return {
    success: receipt.success,
    broker,
    ...(receipt.code ? { code: receipt.code } : {}),
    message: receipt.message,
    receipt,
  };
}
