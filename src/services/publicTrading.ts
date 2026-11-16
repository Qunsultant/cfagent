/**
 * Issue #3990 Slice C — Public.com trading mappings: the neutral
 * shapes the PublicTradingPlatform serves, mapped from the hosted
 * MCP server's tool payloads.
 *
 * Payload shapes are unpublished, so extraction is liberal in the
 * publicData.ts manner (candidate field lists, best-array walks) —
 * and strict about honesty: a field the payload does not carry stays
 * ABSENT in the mapped result. Nothing is zero-filled, estimated, or
 * defaulted. The one exception is a quote's timestamp, which the
 * DATA adapter (not this module) falls back to the fetch instant.
 *
 * Order semantics (official MCP docs + SDK, verified 2026-11-10):
 *  - place_order is single-leg stock/crypto/options; bracket via
 *    order_class BRACKET/OCO/OTO + take_profit_limit_price /
 *    stop_loss_stop_price / stop_loss_limit_price; whole-share
 *    quantity for brackets; prices are decimal strings on the wire
 *    (numbers are accepted here and sent as numbers — the schema
 *    mapping decides the wire name, the server parses both).
 *  - Placement is async: place_order returns an order ID (an
 *    acceptance receipt, NOT a fill); callers poll get_order.
 *    Order statuses: NEW, PARTIALLY_FILLED, FILLED, CANCELLED,
 *    QUEUED_CANCELLED, PENDING_CANCEL, PENDING_REPLACE, REPLACED,
 *    REJECTED, EXPIRED.
 *  - No paper mode: a TEST-mode placement is refused with
 *    FAILURE_PUBLIC_NO_PAPER_MODE before any MCP call (see
 *    publicNoPaperModeRefusal). Reads + preflight work in TEST.
 */

import type {
  BrokerAccount,
  BrokerCancelOrderResult,
  BrokerOrderDraft,
  BrokerOrderExecutionResult,
  BrokerPosition,
  BrokerRemoteOrder,
} from "../types";
import type { TradingOrderLeg, OrderPreviewParams, PlaceOrderParams } from "../trading";
import { codedMessage, getOutcome } from "../outcomes/outcomeAspects";

/** The outcome code for a TEST-mode Public placement refusal (Q2). */
export const PUBLIC_NO_PAPER_MODE_CODE = "FAILURE_PUBLIC_NO_PAPER_MODE";

/** The catalog-worded refusal: code + business message, no invention. */
export function publicNoPaperModeRefusal(): { code: string; message: string } {
  return {
    code: PUBLIC_NO_PAPER_MODE_CODE,
    message: codedMessage(PUBLIC_NO_PAPER_MODE_CODE),
  };
}

/** True when the catalog carries the refusal (a broken catalog must fail loudly, not silently place). */
export function publicNoPaperModeOutcomeExists(): boolean {
  return getOutcome(PUBLIC_NO_PAPER_MODE_CODE) !== null;
}

/* ------------------------- argument mapping ------------------------- */

type SemanticSpec = Record<string, { names: string[]; value: unknown }>;

function orderSide(action: string): string {
  return action === "BUY_TO_COVER" ? "BUY" : action === "SELL_SHORT" ? "SELL" : action;
}

function orderType(orderType?: string): string {
  switch ((orderType ?? "MARKET").toUpperCase()) {
    case "LIMIT":
      return "LIMIT";
    case "STOP":
      return "STOP";
    case "STOP_LIMIT":
      return "STOP_LIMIT";
    default:
      return "MARKET";
  }
}

/**
 * The semantic arguments for a single-leg place/preflight, in the
 * SDK's names — the trading client maps them onto the live schema's
 * property names, so a server rename is absorbed, never guessed.
 */
export function publicSingleLegArgs(params: {
  symbol: string;
  assetClass?: string;
  action: string;
  quantity: number;
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  orderClass?: "simple" | "bracket" | "oco" | "oto";
  takeProfit?: { limitPrice?: number };
  stopLoss?: { stopPrice?: number; limitPrice?: number };
}): SemanticSpec {
  const spec: SemanticSpec = {
    symbol: { names: ["symbol", "ticker"], value: params.symbol },
    instrument_type: {
      names: ["instrument_type", "instrumentType"],
      value: params.assetClass === "options" ? "OPTION" : "EQUITY",
    },
    order_side: { names: ["order_side", "side", "orderSide"], value: orderSide(params.action) },
    order_type: { names: ["order_type", "type", "orderType"], value: orderType(params.orderType) },
    quantity: { names: ["quantity", "qty"], value: params.quantity },
  };
  if (params.limitPrice !== undefined) {
    spec.limit_price = { names: ["limit_price", "limitPrice"], value: params.limitPrice };
  }
  if (params.stopPrice !== undefined) {
    spec.stop_price = { names: ["stop_price", "stopPrice"], value: params.stopPrice };
  }
  if (params.orderClass && params.orderClass !== "simple") {
    spec.order_class = {
      names: ["order_class", "orderClass"],
      value: params.orderClass.toUpperCase(),
    };
    if (params.takeProfit?.limitPrice !== undefined) {
      spec.take_profit_limit_price = {
        names: ["take_profit_limit_price", "takeProfitLimitPrice"],
        value: params.takeProfit.limitPrice,
      };
    }
    if (params.stopLoss?.stopPrice !== undefined) {
      spec.stop_loss_stop_price = {
        names: ["stop_loss_stop_price", "stopLossStopPrice"],
        value: params.stopLoss.stopPrice,
      };
    }
    if (params.stopLoss?.limitPrice !== undefined) {
      spec.stop_loss_limit_price = {
        names: ["stop_loss_limit_price", "stopLossLimitPrice"],
        value: params.stopLoss.limitPrice,
      };
    }
  }
  return spec;
}

/** The semantic arguments for a multi-leg place/preflight. */
export function publicMultilegArgs(params: {
  legs: TradingOrderLeg[];
  quantity: number;
  limitPrice?: number;
}): SemanticSpec {
  const spec: SemanticSpec = {
    legs: {
      names: ["legs"],
      value: params.legs.map((leg) => ({
        symbol: leg.underlyingSymbol,
        instrument_type: leg.securityType === "OPTN" ? "OPTION" : "EQUITY",
        order_side: orderSide(leg.side),
        quantity: leg.quantity,
        ...(leg.optionType ? { option_type: leg.optionType } : {}),
        ...(leg.strike !== undefined ? { strike_price: leg.strike } : {}),
        ...(leg.expirationDate ? { expiration_date: leg.expirationDate } : {}),
      })),
    },
    quantity: { names: ["quantity", "qty"], value: params.quantity },
  };
  if (params.limitPrice !== undefined) {
    spec.limit_price = { names: ["limit_price", "limitPrice"], value: params.limitPrice };
  }
  return spec;
}

/* ------------------------- payload reading -------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstArray(payload: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return undefined;
  for (const key of keys) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function pickField(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

/** The order id from a place/cancel payload, from candidate fields. */
export function parsePublicOrderId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return str(pickField(payload, ["order_id", "orderId", "id"]));
}

/** The status word from an order payload, carried verbatim. */
export function parsePublicOrderStatus(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return str(pickField(payload, ["status", "state"]));
}

export function parsePublicAccounts(payload: unknown): BrokerAccount[] {
  const rows = firstArray(payload, ["accounts", "account_list", "data"]);
  if (!rows) return [];
  const out: BrokerAccount[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = str(pickField(row, ["account_id", "accountId", "id", "account_number", "accountNumber"]));
    if (!id) continue;
    out.push({
      accountId: id,
      accountKey: id,
      accountDesc: str(pickField(row, ["account_type", "type", "name"])) ?? "Public.com",
      accountType: str(pickField(row, ["account_type", "type"])) ?? "individual",
      netAccountValue: num(pickField(row, ["net_account_value", "netAccountValue", "account_value", "accountValue"])) ?? 0,
      totalAccountValue: num(pickField(row, ["total_account_value", "totalAccountValue", "account_value", "accountValue"])) ?? 0,
      cashAvailableForInvestment: num(pickField(row, ["cash_available", "cashAvailable", "buying_power", "buyingPower"])) ?? 0,
      dayTraderStatus: false,
    });
  }
  return out;
}

export function parsePublicPositions(payload: unknown): {
  positions: BrokerPosition[];
  buyingPower?: number;
} {
  const rows = firstArray(payload, ["positions", "holdings", "data"]);
  const positions: BrokerPosition[] = [];
  for (const row of rows ?? []) {
    if (!isRecord(row)) continue;
    const symbol = str(pickField(row, ["symbol", "ticker"]));
    const quantity = num(pickField(row, ["quantity", "qty", "shares"]));
    if (!symbol || quantity === undefined) continue;
    const marketValue = num(pickField(row, ["market_value", "marketValue"])) ?? 0;
    const currentPrice = num(pickField(row, ["current_price", "currentPrice", "last_price", "lastPrice"])) ?? 0;
    const pricePaid = num(pickField(row, ["average_cost", "averageCost", "cost_basis", "costBasis"]));
    // Issue #4048: an absent average cost is UNKNOWN, not zero. Computing
    // marketValue − 0 reports the whole market value as a gain the broker
    // never sent, and the copilot would repeat it as the user's P&L.
    const costBasisKnown = pricePaid !== undefined;
    const paidPerShare = pricePaid ?? 0;
    const costBasis = paidPerShare * quantity;
    const gain = costBasisKnown ? marketValue - costBasis : 0;
    const gainPercent = costBasisKnown && costBasis > 0 ? (gain / costBasis) * 100 : 0;
    positions.push({
      symbol,
      description: symbol,
      quantity,
      costBasisKnown,
      pricePaid: paidPerShare,
      costBasis,
      currentPrice,
      marketPrice: currentPrice,
      marketValue,
      totalGain: gain,
      unrealizedGainLoss: gain,
      totalGainPercent: gainPercent,
      unrealizedGainLossPercent: gainPercent,
      daysGain: 0,
      daysGainPercent: 0,
    });
  }
  const buyingPower = isRecord(payload)
    ? num(pickField(payload, ["buying_power", "buyingPower", "cash_available", "cashAvailable"]))
    : undefined;
  return { positions, buyingPower };
}

function mapPublicOrderStatus(raw: string | undefined): BrokerRemoteOrder["status"] {
  switch ((raw ?? "").toUpperCase()) {
    case "FILLED":
      return "EXECUTED";
    case "CANCELLED":
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED":
      return raw!.toUpperCase() === "REJECTED" ? "REJECTED" : "CANCELLED";
    case "NEW":
    case "PARTIALLY_FILLED":
    case "QUEUED_CANCELLED":
    case "PENDING_CANCEL":
    case "PENDING_REPLACE":
    case "REPLACED":
      return "OPEN";
    default:
      return "UNKNOWN";
  }
}

export function parsePublicOrders(payload: unknown): BrokerRemoteOrder[] {
  const rows = firstArray(payload, ["orders", "order_list", "data"]);
  if (!rows) return [];
  const out: BrokerRemoteOrder[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = parsePublicOrderId(row);
    if (id === undefined) continue;
    const rawStatus = parsePublicOrderStatus(row);
    out.push({
      orderId: id,
      orderType: str(pickField(row, ["order_type", "orderType", "type"])) ?? "MARKET",
      status: mapPublicOrderStatus(rawStatus),
      rawStatus,
      orderAction: str(pickField(row, ["order_side", "side", "orderSide"])),
      quantity: num(pickField(row, ["quantity", "qty"])),
      symbol: str(pickField(row, ["symbol", "ticker"])),
      limitPrice: num(pickField(row, ["limit_price", "limitPrice"])),
      placedTime: num(pickField(row, ["created_at", "placed_time", "timestamp"]))
        ? Date.parse(String(pickField(row, ["created_at", "placed_time", "timestamp"]))) || undefined
        : undefined,
    });
  }
  return out;
}

/* ------------------------- draft / execution ------------------------ */

/** A preview draft from a preflight payload — estimates only, never a placement. */
export function publicDraftFromPreflight(
  params: OrderPreviewParams,
  payload: unknown,
  did: { proposerDid: string; authorizerDid: string; proofSignature: string }
): BrokerOrderDraft {
  const record = isRecord(payload) ? payload : {};
  const estimatedTotal =
    num(pickField(record, ["estimated_total", "estimatedTotal", "estimated_cost", "estimatedCost"])) ?? 0;
  const estimatedCommission =
    num(pickField(record, ["estimated_fees", "estimatedFees", "fees", "commission"])) ?? 0;
  const estimatedPrice =
    num(pickField(record, ["estimated_price", "estimatedPrice", "last_price", "lastPrice"])) ??
    params.limitPrice ??
    0;
  const action = (params.action ?? params.orderAction ?? "BUY") as BrokerOrderDraft["action"];
  return {
    orderId: `public-preview-${params.symbol}-${Date.now()}`,
    symbol: params.symbol,
    action,
    orderAction: action,
    broker: "public",
    brokerOrderType: params.assetClass === "options" ? "OPTN" : "EQ",
    optionLegs: params.optionLegs as BrokerOrderDraft["optionLegs"],
    strategyNetDebit: params.strategyNetDebit,
    orderType: (params.orderType ?? "MARKET") as BrokerOrderDraft["orderType"],
    quantity: params.quantity,
    estimatedPrice,
    limitPrice: params.limitPrice,
    stopPrice: params.stopPrice,
    term: "GOOD_FOR_DAY",
    estimatedCommission,
    estimatedTotal,
    orderClass: params.orderClass,
    takeProfit: params.takeProfit,
    stopLoss: params.stopLoss,
    takeProfitPercent: params.takeProfitPercent,
    stopLossPercent: params.stopLossPercent,
    status: "previewed",
    proposerDid: did.proposerDid,
    authorizerDid: did.authorizerDid,
    proofSignature: did.proofSignature,
    previewMessage: `Public.com Order Preview: ${action} ${params.quantity} ${params.symbol} @ ~$${estimatedPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD.`,
    safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
    placedAt: new Date().toISOString(),
  };
}

/* ---------------------------- cancellation --------------------------- */

/**
 * Issue #4650 (matrix gap 2): the status words a cancel payload may carry
 * that mean the broker ACCEPTED the cancellation. Public's documented order
 * statuses include CANCELLED, QUEUED_CANCELLED and PENDING_CANCEL; the
 * spellings are matched case-insensitively because the hosted schema is
 * unpublished and a single-letter vendor difference must not turn a real
 * cancellation into a reported failure.
 */
const CANCEL_ACCEPTED_STATUS = new Set([
  "CANCELLED",
  "CANCELED",
  "CANCEL_REQUESTED",
  "CANCEL_PENDING",
  "PENDING_CANCEL",
  "QUEUED_CANCELLED",
  "QUEUED_CANCELED",
]);

/**
 * Every other documented order status means the cancel did NOT take effect:
 * the order is still working (NEW, PARTIALLY_FILLED), already done (FILLED,
 * EXPIRED, REJECTED), or replaced (PENDING_REPLACE, REPLACED). Listed rather
 * than inferred so an unknown word falls through to "unconfirmed" instead of
 * being silently read as success.
 */
const CANCEL_REFUSED_STATUS = new Set([
  "NEW",
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "EXPIRED",
  "REJECTED",
  "FAILED",
  "REPLACED",
  "PENDING_REPLACE",
]);

/** The broker's explicit error signal, if the payload carries one. */
function cancelErrorSignal(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (typeof error === "string" && error !== "") return error;
  if (isRecord(error)) {
    const code = str(pickField(error, ["code", "error_code", "errorCode"]));
    if (code) return code;
    const message = str(pickField(error, ["message", "detail"]));
    if (message) return message;
    return "error";
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (isRecord(first)) {
      return str(pickField(first, ["code", "error_code", "errorCode", "message"])) ?? "error";
    }
    return typeof first === "string" && first !== "" ? first : "error";
  }
  return undefined;
}

/**
 * The cancel receipt for a `cancel_order` payload (issue #4650).
 *
 * The old seam returned `success: true` unconditionally, so a refused or
 * unconfirmed cancel read as cancelled. This maps the broker's own signal and
 * FAILS CLOSED: success requires an explicit `success: true` or a status word
 * that means the cancellation was accepted. A refusal, an error, or a payload
 * with no signal at all is `success: false` — the third case says the broker
 * returned no confirmation, because "we do not know" must never render as
 * "cancelled".
 */
export function publicCancelReceipt(params: {
  requestedOrderId: string;
  payload: unknown;
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: string;
}): BrokerCancelOrderResult {
  const now = params.now ?? new Date().toISOString();
  const orderId = (isRecord(params.payload) ? parsePublicOrderId(params.payload) : undefined) ?? params.requestedOrderId;
  const status = isRecord(params.payload) ? parsePublicOrderStatus(params.payload) : undefined;
  const statusWord = status ? status.toUpperCase() : undefined;
  const explicitSuccess = isRecord(params.payload) ? params.payload.success : undefined;
  const errorSignal = isRecord(params.payload) ? cancelErrorSignal(params.payload) : undefined;

  if (explicitSuccess === false) {
    return {
      success: false,
      orderId,
      message: `Public.com did not cancel order ${orderId}${errorSignal ? ` (${errorSignal})` : ""}; the order was left as the broker had it.`,
      timestamp: now,
    };
  }
  if (statusWord && CANCEL_REFUSED_STATUS.has(statusWord)) {
    return {
      success: false,
      orderId,
      message: `Public.com did not cancel order ${orderId}: the broker reported status ${statusWord}. Check the order list before retrying.`,
      timestamp: now,
    };
  }
  if (errorSignal && explicitSuccess !== true) {
    return {
      success: false,
      orderId,
      message: `Public.com did not cancel order ${orderId} (${errorSignal}); nothing is reported as cancelled. Check the order list before retrying.`,
      timestamp: now,
    };
  }
  if (explicitSuccess === true || (statusWord && CANCEL_ACCEPTED_STATUS.has(statusWord))) {
    return {
      success: true,
      orderId,
      message: `Public.com cancelled order ${orderId}${statusWord ? ` (status ${statusWord})` : ""}.`,
      timestamp: now,
    };
  }
  return {
    success: false,
    orderId,
    message: `Public.com returned no cancellation confirmation for order ${orderId}; the order may still be open. Check the order list before retrying.`,
    timestamp: now,
  };
}

/** A failed execution result carrying the named refusal (never a placement). */
export function publicRefusedExecution(params: {
  orderId: string;
  symbol: string;
  action: string;
  quantity: number;
  authorizerDid: string;
  code: string;
  message: string;
}): BrokerOrderExecutionResult {
  const now = new Date().toISOString();
  return {
    success: false,
    orderId: params.orderId,
    executionId: "",
    brokerOrderRef: "",
    authorizerDid: params.authorizerDid,
    status: "failed",
    symbol: params.symbol,
    action: params.action as BrokerOrderExecutionResult["action"],
    quantity: params.quantity,
    executionPrice: 0,
    totalSettled: 0,
    message: `${params.code}: ${params.message}`,
    timestamp: now,
  };
}

/** A successful execution result from a place payload (acceptance receipt, NOT a fill). */
export function publicPlacedExecution(params: {
  orderId: string;
  symbol: string;
  action: string;
  quantity: number;
  authorizerDid: string;
  payload: unknown;
}): BrokerOrderExecutionResult {
  const now = new Date().toISOString();
  const brokerOrderRef = parsePublicOrderId(params.payload) ?? "";
  const rawStatus = parsePublicOrderStatus(params.payload);
  return {
    success: true,
    orderId: params.orderId,
    executionId: brokerOrderRef,
    brokerOrderRef,
    authorizerDid: params.authorizerDid,
    status: rawStatus === "FILLED" ? "executed" : "submitted",
    symbol: params.symbol,
    action: params.action as BrokerOrderExecutionResult["action"],
    quantity: params.quantity,
    executionPrice: 0,
    totalSettled: 0,
    message: `Public.com accepted order ${brokerOrderRef || params.orderId} (status ${rawStatus ?? "unknown"} — an acceptance receipt, not a fill; poll get_order for the fill).`,
    timestamp: now,
  };
}

export type { PlaceOrderParams };
