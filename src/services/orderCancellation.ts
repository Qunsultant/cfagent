/**
 * Issue #3883 — order cancellation as a named, counted, audited operation.
 *
 * The platform could cancel one order through a REST route and nothing else:
 * no tool, no bracket-leg semantics, and no record of what a cancel targeted
 * and what the broker refused. This module is the engine behind every cancel
 * scope (#3883 single, #3884 ticker, #3885 all), so all of them share one
 * notion of a target, one receipt and one refusal vocabulary.
 *
 * Shape of the answer, always:
 *   - what it targeted (id, symbol, class, role, status before),
 *   - what it cancelled (status after, verified at the broker),
 *   - what the broker refused (with the broker's own message and status),
 *   - a coded refusal when nothing happened.
 * Silence is a defect: an unread order is reported as unread, never as
 * "0 orders cancelled".
 *
 * Cancelling a compound order (bracket/OCO/OTO) cancels its held legs at the
 * broker; the receipt says how many legs the parent declared, how many are
 * now cancelled and how many the broker refused. Cancelling one leg is
 * allowed and reports what survived (the parent, and any sibling leg).
 */

import type { Env } from "../types";
import { MarketDataResearchService } from "./marketDataResearch";
import { recordTradingRunOutcome } from "./tradingRunOutcome";
import type { SqlStorage } from "../orm";
import {
  type CancelableOrder,
  type CancelOrderClass,
  type CancelOrderRole,
  mapAlpacaOrderList,
  mapAlpacaOrderRow,
  findParentOrder,
} from "../trading";
import { alpacaModeFromEnv } from "./tradingRunOutcome";

/** The broker operations a cancel needs. Injected so tests move no funds. */
export interface CancelBrokerPort {
  getOrder(orderId: string): Promise<{ success: boolean; order?: any; message?: string; httpStatus?: number }>;
  listOpenOrders(): Promise<{ success: boolean; orders?: any[]; message?: string; httpStatus?: number }>;
  cancelOrder(orderId: string): Promise<{ success: boolean; orderId: string; message: string; httpStatus?: number }>;
}

/** The Alpaca port over the one service the ladder already uses (#3673). */
export function createAlpacaCancelPort(env: Env): CancelBrokerPort {
  const service = new MarketDataResearchService(env);
  return {
    getOrder: (orderId) => service.getAlpacaOrder(orderId),
    listOpenOrders: () => service.getAlpacaOrders("open"),
    cancelOrder: (orderId) => service.cancelAlpacaOrder(orderId),
  };
}

export type CancelRefusalCode =
  | "invalid_order_id"
  | "order_not_found"
  | "cancel_read_failed"
  | "cancel_not_possible"
  | "cancel_failed";

export interface CancelLegSummary {
  declared: number;
  cancelled: number;
  refused: number;
}

export interface CancelTargetReceipt {
  orderId: string;
  symbol: string;
  orderClass: CancelOrderClass;
  role: CancelOrderRole;
  statusBefore: string;
  /** The broker's status after the cancel, re-read; null when unread. */
  statusAfter: string | null;
  cancelled: boolean;
  message: string;
  httpStatus?: number;
  /** Compound-parent bookkeeping: how its held legs fared. */
  legs?: CancelLegSummary;
  /** Legs the broker still held after the attempt. */
  survivingLegs?: string[];
  /** For a leg cancel: the parent that is still open. */
  survivingParent?: { orderId: string; status: string } | null;
}

export interface CancelReceipt {
  success: boolean;
  action: "cancel_order";
  code?: CancelRefusalCode;
  target: CancelTargetReceipt | null;
  message: string;
  reason?: string;
}

function receiptRefusal(code: CancelRefusalCode, message: string, target?: CancelTargetReceipt | null): CancelReceipt {
  return { success: false, action: "cancel_order", code, target: target ?? null, message };
}

function canRead(order: any): boolean {
  return Boolean(order);
}

/**
 * Cancel exactly one order, with its bracket/OCO family semantics.
 *
 * `reason` is a caller's note (audited, never sent to the broker): Alpaca has
 * no reason field, and inventing one would misrepresent the wire.
 */
export async function cancelSingleOrder(
  port: CancelBrokerPort,
  request: { orderId: string; reason?: string },
): Promise<CancelReceipt> {
  const orderId = String(request.orderId ?? "").trim();
  if (!orderId) {
    return { ...receiptRefusal("invalid_order_id", "A cancel needs an order id; nothing was sent."), reason: request.reason };
  }

  const read = await port.getOrder(orderId);
  if (!read.success || !canRead(read.order)) {
    if (read.httpStatus === 404) {
      return {
        ...receiptRefusal(
          "order_not_found",
          `Neither broker nor platform knows order ${orderId}; nothing was cancelled.`,
        ),
        reason: request.reason,
      };
    }
    return {
      ...receiptRefusal(
        "cancel_read_failed",
        `Order ${orderId} could not be read, so no cancel was attempted: ${read.message ?? "the broker returned no reason"}`,
      ),
      reason: request.reason,
    };
  }

  // Whether the row is a leg is answered by the parents' own records.
  const openList = await port.listOpenOrders();
  const openOrders = openList.success && Array.isArray(openList.orders) ? mapAlpacaOrderList(openList.orders) : [];
  const mappedFromRead = mapAlpacaOrderRow(read.order);
  const parent = findParentOrder(mappedFromRead.orderId, openOrders);
  const target: CancelableOrder = {
    ...mappedFromRead,
    role: parent ? "leg" : mappedFromRead.role,
    parentId: parent?.orderId ?? mappedFromRead.parentId,
  };

  const refusal = (code: CancelRefusalCode, message: string): CancelReceipt => ({
    success: false,
    action: "cancel_order",
    code,
    target: {
      orderId: target.orderId,
      symbol: target.symbol,
      orderClass: target.cancelClass,
      role: target.role,
      statusBefore: target.rawStatus,
      statusAfter: null,
      cancelled: false,
      message,
    },
    message,
    reason: request.reason,
  });

  if (target.status !== "open") {
    const detail =
      target.status === "terminal"
        ? `order ${orderId} is '${target.rawStatus}', which is final — there is nothing left to cancel`
        : `order ${orderId} reports '${target.rawStatus || "no status"}', which this platform does not recognise as cancellable`;
    return refusal("cancel_not_possible", `cancel_not_possible: ${detail}. No cancel was sent.`);
  }

  const cancel = await port.cancelOrder(orderId);
  if (!cancel.success) {
    return refusal(
      "cancel_failed",
      `The broker refused to cancel order ${orderId}: ${cancel.message}${
        cancel.httpStatus ? ` (HTTP ${cancel.httpStatus})` : ""
      }`,
    );
  }

  // Re-read so the receipt reports the broker's own post-cancel state rather
  // than assuming a 204 means the order is gone.
  const after = await port.getOrder(orderId);
  const statusAfter = after.success && after.order ? String(after.order?.status ?? "").trim().toLowerCase() || null : null;

  if (target.role === "parent" && target.legIds.length > 0) {
    const legStates: string[] = [];
    const surviving: string[] = [];
    for (const legId of target.legIds) {
      const legRead = await port.getOrder(legId);
      const legStatus = legRead.success && legRead.order ? String(legRead.order?.status ?? "").trim().toLowerCase() : "";
      if (!legStatus) {
        legStates.push(`${legId}: unread`);
        surviving.push(legId);
        continue;
      }
      legStates.push(`${legId}: ${legStatus}`);
      if (legStatus !== "canceled" && legStatus !== "cancelled" && legStatus !== "expired" && legStatus !== "filled") {
        surviving.push(legId);
      }
    }
    const cancelledLegs = target.legIds.length - surviving.length;
    const message =
      `Cancelled ${target.symbol} ${target.cancelClass} parent ${orderId}: ${cancelledLegs} of ${target.legIds.length} ` +
      `held legs are cancelled at the broker${surviving.length > 0 ? `; ${surviving.length} still held (${surviving.join(", ")})` : ""}.`;
    return {
      success: true,
      action: "cancel_order",
      target: {
        orderId,
        symbol: target.symbol,
        orderClass: target.cancelClass,
        role: target.role,
        statusBefore: target.rawStatus,
        statusAfter,
        cancelled: true,
        message,
        legs: { declared: target.legIds.length, cancelled: cancelledLegs, refused: surviving.length },
        survivingLegs: surviving,
      },
      message,
      reason: request.reason,
    };
  }

  if (target.role === "leg") {
    const parentRead = target.parentId ? await port.getOrder(target.parentId) : null;
    const parentStatus =
      parentRead && parentRead.success && parentRead.order
        ? String(parentRead.order?.status ?? "").trim().toLowerCase()
        : "unread";
    const message =
      `Cancelled leg ${orderId} of ${target.symbol} ${target.cancelClass}; ` +
      (target.parentId
        ? `parent ${target.parentId} is '${parentStatus}' and was not cancelled by this call.`
        : "the parent order could not be identified, so no parent status is claimed.");
    return {
      success: true,
      action: "cancel_order",
      target: {
        orderId,
        symbol: target.symbol,
        orderClass: target.cancelClass,
        role: target.role,
        statusBefore: target.rawStatus,
        statusAfter,
        cancelled: true,
        message,
        survivingParent: target.parentId ? { orderId: target.parentId, status: parentStatus } : null,
      },
      message,
      reason: request.reason,
    };
  }

  const message = `Cancelled order ${orderId} (${target.symbol} ${target.cancelClass}); the broker reports '${statusAfter ?? "no status read"}'.`;
  return {
    success: true,
    action: "cancel_order",
    target: {
      orderId,
      symbol: target.symbol,
      orderClass: target.cancelClass,
      role: target.role,
      statusBefore: target.rawStatus,
      statusAfter,
      cancelled: true,
      message,
    },
    message,
    reason: request.reason,
  };
}

/**
 * Record the cancel in the Workflow Runs ledger as `order:<orderId>`.
 *
 * The run's status is the platform's own vocabulary (`completed` when the
 * broker confirmed, `failed` when it refused), and the delivery states carry
 * the cancel word (`cancelled` / `cancel_failed`) plus the broker's own
 * status, so the run says both what the platform asked for and what the
 * broker did. Best-effort, like every other trading outcome: a ledger write
 * never turns a confirmed cancel into a failure.
 */
export function recordCancelOutcome(
  sql: SqlStorage | null | undefined,
  receipt: CancelReceipt,
  origin: string,
  env?: Partial<Env>,
): void {
  const orderId = receipt.target?.orderId;
  if (!orderId) return;
  recordTradingRunOutcome(sql, {
    orderId,
    status: receipt.success ? "completed" : "failed",
    action: "cancel",
    symbol: receipt.target?.symbol,
    orderClass: receipt.target?.orderClass,
    broker: "alpaca",
    mode: env ? alpacaModeFromEnv(env) : undefined,
    codedError: receipt.code,
    origin,
    cancelOutcome: receipt.success ? "cancelled" : "cancel_failed",
    brokerStatus: receipt.target?.statusAfter ?? receipt.target?.statusBefore,
  });
}
