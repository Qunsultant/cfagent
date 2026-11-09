/**
 * Issue #3883 / #3886 — the neutral cancel vocabulary.
 *
 * Cancelling one order and cancelling a whole class of orders must agree on
 * what an order IS before either can say what it touched. This module is
 * that vocabulary: the order classes a cancel can name, the status words
 * that mean "still cancellable", and the mapping from a broker's own order
 * row onto a neutral, cancel-shaped record.
 *
 * It is deliberately pure: no fetch, no client, no service. The engine in
 * `src/services/orderCancellation.ts` performs the cancels; the resolver
 * (#3886) filters these records; a tool never has to know Alpaca's field
 * names.
 *
 * Honesty rules:
 *   - a status the platform does not model is `unknown`, never "open" and
 *     never "cancelled" — a cancel decision on an unknown status refuses;
 *   - a leg is a leg only when the broker says so (a parent row declaring
 *     it), never because an id looks different;
 *   - a class is what the broker calls it (`order_class`), never inferred
 *     from the order type: a bracket's entry is a limit order but the
 *     order is a bracket, and cancelling it cancels its children.
 */

/**
 * The classes a caller may name. `simple` is the broker's own word for a
 * single order; `market`/`limit`/`stop`/`stop_limit` are the *type* of such
 * an order, offered as classes because that is how a user asks ("cancel my
 * limit orders on AAPL"). The remaining three are Alpaca's compound
 * classes: `bracket` (entry + TP + SL), `oco` (TP + SL, both held), `oto`
 * (entry + one held leg).
 */
export type CancelOrderClass =
  | "simple"
  | "market"
  | "limit"
  | "stop"
  | "stop_limit"
  | "bracket"
  | "oco"
  | "oto";

export const CANCEL_ORDER_CLASSES: readonly CancelOrderClass[] = [
  "simple",
  "market",
  "limit",
  "stop",
  "stop_limit",
  "bracket",
  "oco",
  "oto",
];

/** The compound classes: cancelling the parent takes its held legs with it. */
export const COMPOUND_CANCEL_CLASSES: readonly CancelOrderClass[] = ["bracket", "oco", "oto"];

/** The classes that are really a simple order's `type`. */
export const SIMPLE_TYPE_CLASSES: readonly CancelOrderClass[] = [
  "market",
  "limit",
  "stop",
  "stop_limit",
];

export function isCancelOrderClass(value: unknown): value is CancelOrderClass {
  return typeof value === "string" && (CANCEL_ORDER_CLASSES as readonly string[]).includes(value);
}

/**
 * Where an order sits in its bracket/OTO/OCO family.
 *   - `parent`  — the row that owns held legs (it may itself be unfilled)
 *   - `leg`     — a held child declared by a parent's `legs`
 *   - `single`  — a standalone order
 */
export type CancelOrderRole = "parent" | "leg" | "single";

/** One broker order, in the shape every cancel path reasons about. */
export interface CancelableOrder {
  orderId: string;
  symbol: string;
  side: "buy" | "sell" | "unknown";
  /** Alpaca's `order_class`, defaulted to `simple` only when the broker omits it. */
  brokerOrderClass: "simple" | "bracket" | "oco" | "oto";
  /** What the caller asked for: the compound class, or a simple type. */
  cancelClass: CancelOrderClass;
  /** The broker's raw `type` (market, limit, stop, stop_limit, trailing_stop, …). */
  orderType: string;
  /** The broker's own status word, verbatim. */
  rawStatus: string;
  /** open | terminal | unknown — the only decision this vocabulary supports. */
  status: CancelOrderStatus;
  clientOrderId: string | null;
  /** The ladder batch this order belongs to, parsed from its client order id. */
  ladderId: string | null;
  /** Leg ids the broker declares on this row (children of a compound order). */
  legIds: string[];
  role: CancelOrderRole;
  /** The parent's order id when this row is a declared leg. */
  parentId: string | null;
  placedAt: number | null;
  quantity: number | null;
  notional: number | null;
}

export type CancelOrderStatus = "open" | "terminal" | "unknown";

/**
 * Alpaca's status vocabulary, classified. `open` is "the broker still holds
 * it, so a cancel can do something"; `terminal` is "nothing to cancel, and
 * the answer must say which state" (the #3883 already-filled refusal);
 * everything else — including statuses Alpaca adds later — is `unknown`,
 * which refuses rather than guessing a direction.
 */
const OPEN_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "pending_replace",
  "pending_cancel",
  "held",
  "calculated",
  "accepted_for_bidding",
]);

const TERMINAL_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "replaced",
  "done_for_day",
  "stopped",
]);

export function normalizeCancelStatus(rawStatus: unknown): CancelOrderStatus {
  const status = String(rawStatus ?? "").trim().toLowerCase();
  if (!status) return "unknown";
  if (OPEN_STATUSES.has(status)) return "open";
  if (TERMINAL_STATUSES.has(status)) return "terminal";
  return "unknown";
}

/**
 * `lad_1730000000000_ab12cd-r3` → `lad_1730000000000_ab12cd`. The ladder
 * stamps its rung ids as `<ladderId>-r<N>` (#3673), so the prefix is the
 * batch identity a filter can name. A row without that shape has no ladder.
 */
export function parseLadderId(clientOrderId: string | null | undefined): string | null {
  const id = String(clientOrderId ?? "").trim();
  if (!id) return null;
  const match = /^(lad_.+)-r\d+$/.exec(id);
  return match ? match[1] : null;
}

function asNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asSide(value: unknown): "buy" | "sell" | "unknown" {
  const side = String(value ?? "").trim().toLowerCase();
  return side === "buy" || side === "sell" ? side : "unknown";
}

/**
 * Map one Alpaca order row (`GET /v2/orders`, `GET /v2/orders/{id}`) onto the
 * neutral record. Unknown fields stay null/unknown; nothing is inferred from
 * an id's shape except the ladder prefix the ladder itself stamps.
 */
export function mapAlpacaOrderRow(raw: any, parentIds: ReadonlySet<string> = new Set()): CancelableOrder {
  const brokerOrderClass = String(raw?.order_class ?? "simple").trim().toLowerCase();
  const orderClass: CancelableOrder["brokerOrderClass"] =
    brokerOrderClass === "bracket" || brokerOrderClass === "oco" || brokerOrderClass === "oto"
      ? brokerOrderClass
      : "simple";
  const orderType = String(raw?.type ?? "").trim().toLowerCase();
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const legIds = legs
    .map((leg: any) => String(leg?.id ?? "").trim())
    .filter((id: string) => id.length > 0);
  const orderId = String(raw?.id ?? "").trim();

  const cancelClass: CancelOrderClass =
    orderClass !== "simple"
      ? orderClass
      : ((SIMPLE_TYPE_CLASSES as readonly string[]).includes(orderType)
          ? (orderType as CancelOrderClass)
          : "simple");

  const role: CancelOrderRole = parentIds.has(orderId) ? "leg" : legIds.length > 0 ? "parent" : "single";

  return {
    orderId,
    symbol: String(raw?.symbol ?? "").trim().toUpperCase(),
    side: asSide(raw?.side),
    brokerOrderClass: orderClass,
    cancelClass,
    orderType,
    rawStatus: String(raw?.status ?? "").trim().toLowerCase(),
    status: normalizeCancelStatus(raw?.status),
    clientOrderId: raw?.client_order_id ? String(raw.client_order_id) : null,
    ladderId: parseLadderId(raw?.client_order_id),
    legIds,
    role,
    parentId: null,
    placedAt: raw?.submitted_at ? Date.parse(String(raw.submitted_at)) || null : null,
    quantity: asNumber(raw?.qty),
    notional: asNumber(raw?.notional),
  };
}

/**
 * Map a broker's whole order list, wiring each declared leg back to the
 * parent that declared it. Doing it once over the list is what keeps a
 * multi-order cancel from double-cancelling: a leg is identified by the
 * parent's own record, not by asking the broker a second time.
 */
export function mapAlpacaOrderList(rows: readonly any[]): CancelableOrder[] {
  const parentIds = new Set<string>();
  for (const row of rows) {
    for (const leg of Array.isArray(row?.legs) ? row.legs : []) {
      const id = String(leg?.id ?? "").trim();
      if (id) parentIds.add(id);
    }
  }
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const parentId = String(row?.id ?? "").trim();
    for (const leg of Array.isArray(row?.legs) ? row.legs : []) {
      const id = String(leg?.id ?? "").trim();
      if (id && parentId) parentOf.set(id, parentId);
    }
  }
  return rows.map((row) => {
    const mapped = mapAlpacaOrderRow(row, parentIds);
    return { ...mapped, parentId: parentOf.get(mapped.orderId) ?? null };
  });
}

/** The parent that declares this order as a leg, when one is present in the list. */
export function findParentOrder(orderId: string, orders: readonly CancelableOrder[]): CancelableOrder | null {
  return orders.find((candidate) => candidate.legIds.includes(orderId)) ?? null;
}

/** The declared legs of a compound order, as ids. */
export function declaredLegIds(order: CancelableOrder): string[] {
  return [...order.legIds];
}

/**
 * Human-facing target line, e.g. `AAPL bracket buy parent ord-1 (2 held legs)`.
 * The same words appear in the tool receipt and the UI notice, so a user can
 * match what they read to what happened.
 */
export function describeCancelableOrder(order: CancelableOrder): string {
  const role =
    order.role === "parent"
      ? `parent (${order.legIds.length} held ${order.legIds.length === 1 ? "leg" : "legs"})`
      : order.role === "leg"
        ? `leg of ${order.parentId ?? "a parent order"}`
        : "single order";
  return `${order.symbol} ${order.cancelClass} ${order.side} ${role} ${order.orderId}`;
}
