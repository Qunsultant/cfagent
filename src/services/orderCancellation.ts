/**
 * Issue #3883 / #3884 / #3885 / #3886 — order cancellation as a named,
 * counted, audited operation, at every scope.
 *
 * The platform could cancel one order through a REST route and nothing else:
 * no tool, no bracket-leg semantics, and no record of what a cancel targeted
 * and what the broker refused. This module is the engine behind every cancel
 * scope — single order (#3883), one ticker (#3884), all open orders (#3885)
 * — so all of them share one notion of a target, one filter (#3886), one
 * receipt and one refusal vocabulary.
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
 *
 * Caps (#3888): every multi-order cancel honours `cancelMaxCount` when it is
 * configured. When it is NOT configured the two scopes differ deliberately:
 * a ticker cancel proceeds (cancelling reduces exposure, and blocking it on
 * missing configuration would keep a runaway ladder alive), while cancel-all
 * refuses — "cancel everything" must never run unbounded.
 */

import type { Env } from "../types";
import { MarketDataResearchService } from "./marketDataResearch";
import { recordTradingRunOutcome, alpacaModeFromEnv } from "./tradingRunOutcome";
import type { SqlStorage } from "../orm";
import {
  type CancelableOrder,
  type CancelFilter,
  type CancelFilterResolution,
  type CancelOrderClass,
  type CancelOrderRole,
  type TradingLimitsSnapshot,
  describeCancelFilter,
  findParentOrder,
  mapAlpacaOrderList,
  mapAlpacaOrderRow,
  resolveCancelTargets,
  tradingLimitEnvVar,
  TRADING_LIMITS_SETTING_KEY,
} from "../trading";

/** The broker operations a cancel needs. Injected so tests move no funds. */
export interface CancelBrokerPort {
  getOrder(orderId: string): Promise<{ success: boolean; order?: any; message?: string; httpStatus?: number }>;
  listOpenOrders(): Promise<{ success: boolean; orders?: any[]; message?: string; httpStatus?: number }>;
  cancelOrder(orderId: string): Promise<{ success: boolean; orderId: string; message: string; httpStatus?: number }>;
}

/** The broker port over the one service the ladder already uses (#3673). */
export function createCancelBrokerPort(env: Env): CancelBrokerPort {
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

export type ScopedCancelRefusalCode =
  | "cancel_read_failed"
  | "no_orders_matched"
  | "unknown_order_class"
  | "invalid_order_side"
  | "invalid_placed_after"
  | "cancel_max_exceeded"
  | "limit_not_configured";

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

export interface ScopedCancelTarget {
  orderId: string;
  symbol: string;
  orderClass: CancelOrderClass;
  role: CancelOrderRole;
  statusBefore: string;
}

export interface ScopedCancelFailure {
  orderId: string;
  symbol: string;
  statusBefore: string;
  code: CancelRefusalCode;
  message: string;
}

export interface ScopedCancelReceipt {
  success: boolean;
  action: "cancel_ticker" | "cancel_all";
  code?: ScopedCancelRefusalCode | CancelRefusalCode;
  filter: CancelFilter;
  /** How many orders the filter matched (the cap is checked against this). */
  targeted: number;
  /** Every target, whether or not it was acted on (the dry run's answer). */
  planned: ScopedCancelTarget[];
  cancelled: CancelTargetReceipt[];
  refused: ScopedCancelFailure[];
  /** Legs dropped because their parent was targeted in the same call. */
  foldedLegIds: string[];
  message: string;
  reason?: string;
  dryRun?: boolean;
}

function receiptRefusal(code: CancelRefusalCode, message: string, target?: CancelTargetReceipt | null): CancelReceipt {
  return { success: false, action: "cancel_order", code, target: target ?? null, message };
}

function isTerminalWord(status: string): boolean {
  return ["canceled", "cancelled", "expired", "filled", "rejected", "replaced", "done_for_day", "stopped"].includes(status);
}

/**
 * Cancel an already-classified target: send the cancel, then re-read so the
 * receipt reports the broker's own post-cancel state rather than assuming a
 * 204 means the order is gone. Shared by every scope.
 */
async function cancelTarget(
  port: CancelBrokerPort,
  target: CancelableOrder,
): Promise<CancelTargetReceipt> {
  const cancel = await port.cancelOrder(target.orderId);
  if (!cancel.success) {
    return {
      orderId: target.orderId,
      symbol: target.symbol,
      orderClass: target.cancelClass,
      role: target.role,
      statusBefore: target.rawStatus,
      statusAfter: null,
      cancelled: false,
      message: `The broker refused to cancel order ${target.orderId}: ${cancel.message}${
        cancel.httpStatus ? ` (HTTP ${cancel.httpStatus})` : ""
      }`,
      httpStatus: cancel.httpStatus,
    };
  }

  const after = await port.getOrder(target.orderId);
  const statusAfter =
    after.success && after.order ? String(after.order?.status ?? "").trim().toLowerCase() || null : null;

  if (target.role === "parent" && target.legIds.length > 0) {
    const surviving: string[] = [];
    for (const legId of target.legIds) {
      const legRead = await port.getOrder(legId);
      const legStatus =
        legRead.success && legRead.order ? String(legRead.order?.status ?? "").trim().toLowerCase() : "";
      if (!legStatus || !isTerminalWord(legStatus)) surviving.push(legId);
    }
    const cancelledLegs = target.legIds.length - surviving.length;
    const message =
      `Cancelled ${target.symbol} ${target.cancelClass} parent ${target.orderId}: ${cancelledLegs} of ${target.legIds.length} ` +
      `held legs are cancelled at the broker${surviving.length > 0 ? `; ${surviving.length} still held (${surviving.join(", ")})` : ""}.`;
    return {
      orderId: target.orderId,
      symbol: target.symbol,
      orderClass: target.cancelClass,
      role: target.role,
      statusBefore: target.rawStatus,
      statusAfter,
      cancelled: true,
      message,
      legs: { declared: target.legIds.length, cancelled: cancelledLegs, refused: surviving.length },
      survivingLegs: surviving,
    };
  }

  if (target.role === "leg") {
    const parentRead = target.parentId ? await port.getOrder(target.parentId) : null;
    const parentStatus =
      parentRead && parentRead.success && parentRead.order
        ? String(parentRead.order?.status ?? "").trim().toLowerCase()
        : "unread";
    const message =
      `Cancelled leg ${target.orderId} of ${target.symbol} ${target.cancelClass}; ` +
      (target.parentId
        ? `parent ${target.parentId} is '${parentStatus}' and was not cancelled by this call.`
        : "the parent order could not be identified, so no parent status is claimed.");
    return {
      orderId: target.orderId,
      symbol: target.symbol,
      orderClass: target.cancelClass,
      role: target.role,
      statusBefore: target.rawStatus,
      statusAfter,
      cancelled: true,
      message,
      survivingParent: target.parentId ? { orderId: target.parentId, status: parentStatus } : null,
    };
  }

  return {
    orderId: target.orderId,
    symbol: target.symbol,
    orderClass: target.cancelClass,
    role: target.role,
    statusBefore: target.rawStatus,
    statusAfter,
    cancelled: true,
    message: `Cancelled order ${target.orderId} (${target.symbol} ${target.cancelClass}); the broker reports '${statusAfter ?? "no status read"}'.`,
  };
}

/**
 * Cancel exactly one order, with its bracket/OCO family semantics.
 *
 * `reason` is a caller's note (audited, never sent to the broker): the wire
 * has no reason field, and inventing one would misrepresent what was sent.
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
  if (!read.success || !read.order) {
    if (read.httpStatus === 404) {
      return {
        ...receiptRefusal("order_not_found", `Neither broker nor platform knows order ${orderId}; nothing was cancelled.`),
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

  const targetReceipt = await cancelTarget(port, target);
  if (!targetReceipt.cancelled) {
    return {
      success: false,
      action: "cancel_order",
      code: "cancel_failed",
      target: targetReceipt,
      message: targetReceipt.message,
      reason: request.reason,
    };
  }

  return {
    success: true,
    action: "cancel_order",
    target: targetReceipt,
    message: targetReceipt.message,
    reason: request.reason,
  };
}

/**
 * The `cancelMaxCount` check shared by the multi-order scopes. `required`
 * is true for cancel-all (an unset cap refuses) and false for a ticker
 * cancel (an unset cap does not block a de-risking action).
 */
function checkCancelCap(
  limits: TradingLimitsSnapshot | undefined,
  targeted: number,
  required: boolean,
): { ok: true; unlimitedBecauseUnset: boolean } | { ok: false; code: ScopedCancelRefusalCode; message: string } {
  const field = limits?.limits.cancelMaxCount;
  const value = field?.value ?? null;
  if (value === null) {
    if (required) {
      return {
        ok: false,
        code: "limit_not_configured",
        message:
          `cancelMaxCount is not configured, so cancelling every open order was refused rather than run unbounded. ` +
          `Set it in ${TRADING_LIMITS_SETTING_KEY} (or ${tradingLimitEnvVar("cancelMaxCount")}).`,
      };
    }
    return { ok: true, unlimitedBecauseUnset: true };
  }
  if (targeted > value) {
    return {
      ok: false,
      code: "cancel_max_exceeded",
      message:
        `This cancel targets ${targeted} orders but cancelMaxCount is ${value}` +
        `${field?.source ? ` (${field.source}${field.readFrom ? `: ${field.readFrom}` : ""})` : ""}. ` +
        `Nothing was cancelled; narrow the filter or raise the cap.`,
    };
  }
  return { ok: true, unlimitedBecauseUnset: false };
}

export interface ScopedCancelOptions {
  filter: CancelFilter;
  action: "cancel_ticker" | "cancel_all";
  dryRun?: boolean;
  reason?: string;
  limits?: TradingLimitsSnapshot;
  /** true for cancel-all: an unset cap refuses instead of proceeding. */
  capRequired?: boolean;
  /** Called for each order before it is cancelled (cancel-all marks its token used). */
  onBeforeCancel?: () => void;
}

/**
 * Cancel every open order a filter matches (#3884 ticker, #3886 classes,
 * #3885 all). Reads the broker's open orders once, resolves the filter onto
 * them, applies the cap, and then cancels each target — parents before the
 * legs they hold (legs whose parent is targeted are folded out).
 *
 * A failure on one order never hides the others: the receipt itemises what
 * was cancelled and what the broker refused, and `success` is true only when
 * every target was cancelled.
 */
export async function cancelScopedOrders(
  port: CancelBrokerPort,
  options: ScopedCancelOptions,
): Promise<ScopedCancelReceipt> {
  const empty = (): ScopedCancelReceipt => ({
    success: false,
    action: options.action,
    filter: options.filter,
    targeted: 0,
    planned: [],
    cancelled: [],
    refused: [],
    foldedLegIds: [],
    message: "",
    reason: options.reason,
  });

  const listed = await port.listOpenOrders();
  if (!listed.success || !Array.isArray(listed.orders)) {
    return {
      ...empty(),
      code: "cancel_read_failed",
      message:
        `The broker's open orders could not be read, so nothing was cancelled: ${listed.message ?? "no reason returned"}` +
        `${listed.httpStatus ? ` (HTTP ${listed.httpStatus})` : ""}.`,
    };
  }

  const orders = mapAlpacaOrderList(listed.orders);
  const resolution: CancelFilterResolution = resolveCancelTargets(orders, options.filter);
  const planned: ScopedCancelTarget[] = resolution.targets.map((order) => ({
    orderId: order.orderId,
    symbol: order.symbol,
    orderClass: order.cancelClass,
    role: order.role,
    statusBefore: order.rawStatus,
  }));

  if (!resolution.matched) {
    return {
      ...empty(),
      code: (resolution.code ?? "no_orders_matched") as ScopedCancelRefusalCode,
      planned,
      message: resolution.message ?? `no_orders_matched: no open order matches ${describeCancelFilter(options.filter)}.`,
    };
  }

  const cap = checkCancelCap(options.limits, resolution.targets.length, options.capRequired === true);
  if (!cap.ok) {
    return { ...empty(), code: cap.code, planned, message: cap.message };
  }

  if (options.dryRun) {
    return {
      success: true,
      action: options.action,
      filter: options.filter,
      targeted: resolution.targets.length,
      planned,
      cancelled: [],
      refused: [],
      foldedLegIds: resolution.foldedLegIds,
      dryRun: true,
      message: `Dry run: ${resolution.targets.length} order${resolution.targets.length === 1 ? "" : "s"} match ${describeCancelFilter(
        options.filter,
      )}; nothing was cancelled.`,
      reason: options.reason,
    };
  }

  options.onBeforeCancel?.();

  const cancelled: CancelTargetReceipt[] = [];
  const refused: ScopedCancelFailure[] = [];
  for (const target of resolution.targets) {
    const receipt = await cancelTarget(port, target);
    if (receipt.cancelled) {
      cancelled.push(receipt);
    } else {
      refused.push({
        orderId: target.orderId,
        symbol: target.symbol,
        statusBefore: target.rawStatus,
        code: "cancel_failed",
        message: receipt.message,
      });
    }
  }

  const success = refused.length === 0 && cancelled.length > 0;
  const message =
    `${options.action === "cancel_all" ? "Cancel all" : `Cancel ${String(options.filter.symbol ?? "matching orders").toUpperCase()}`}: ` +
    `targeted ${resolution.targets.length}, cancelled ${cancelled.length}, refused ${refused.length}` +
    `${resolution.foldedLegIds.length > 0 ? `, ${resolution.foldedLegIds.length} leg(s) covered by their parent's cancel` : ""}` +
    `${cap.unlimitedBecauseUnset ? " (cancelMaxCount is unset, so no cap applied)" : ""}.` +
    (refused.length > 0 ? ` Survived: ${refused.map((entry) => `${entry.orderId} (${entry.message})`).join("; ")}.` : "");

  return {
    success,
    action: options.action,
    filter: options.filter,
    targeted: resolution.targets.length,
    planned,
    cancelled,
    refused,
    foldedLegIds: resolution.foldedLegIds,
    message,
    reason: options.reason,
  };
}

/**
 * Issue #3884: every open order for one ticker, with the shared filter
 * (#3886) so “cancel the ladder but keep my protective stop” is expressible.
 */
export async function cancelTickerOrders(
  port: CancelBrokerPort,
  request: {
    symbol: string;
    orderClass?: string;
    orderSide?: string;
    ladderId?: string;
    placedAfter?: string | number;
    dryRun?: boolean;
    reason?: string;
    limits?: TradingLimitsSnapshot;
  },
): Promise<ScopedCancelReceipt> {
  const symbol = String(request.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    return {
      success: false,
      action: "cancel_ticker",
      code: "no_orders_matched",
      filter: { symbol: null },
      targeted: 0,
      planned: [],
      cancelled: [],
      refused: [],
      foldedLegIds: [],
      message: "no_orders_matched: a ticker cancel needs a symbol. Nothing was cancelled.",
      reason: request.reason,
    };
  }
  return cancelScopedOrders(port, {
    action: "cancel_ticker",
    ...(request.dryRun === true ? { dryRun: true } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.limits ? { limits: request.limits } : {}),
    filter: {
      symbol,
      orderClass: request.orderClass ?? null,
      orderSide: request.orderSide ?? null,
      ladderId: request.ladderId ?? null,
      placedAfter: request.placedAfter ?? null,
    },
  });
}

/**
 * Record a cancel in the Workflow Runs ledger as `order:<orderId>`.
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

/**
 * Record a scoped cancel: ONE Workflow Runs row per job (not one per order),
 * carrying the counts and the refusal when it failed. `order:<id>` rows stay
 * for single-order cancels; a batch is its own run.
 */
export function recordScopedCancelOutcome(
  sql: SqlStorage | null | undefined,
  receipt: ScopedCancelReceipt,
  origin: string,
  env?: Partial<Env>,
  runId?: string,
): void {
  const id = runId ?? `${receipt.action}:${new Date().toISOString()}`;
  recordTradingRunOutcome(sql, {
    orderId: id,
    status: receipt.success ? "completed" : "failed",
    action: receipt.action,
    symbol: receipt.filter.symbol ? String(receipt.filter.symbol).toUpperCase() : undefined,
    broker: "alpaca",
    mode: env ? alpacaModeFromEnv(env) : undefined,
    codedError: receipt.code,
    origin,
    cancelOutcome: receipt.success ? "cancelled" : "cancel_failed",
    scanned: receipt.targeted,
    matched: receipt.cancelled.length,
  });
}
