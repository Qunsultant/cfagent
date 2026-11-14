import { brokerDisplayName } from "../trading";
import type { TradeRecord } from "../types";

/**
 * Ledger table data logic: which broker a stored row belongs to, the
 * per-broker tabs, and the sortable-column sort state.
 *
 * Broker resolution: a row carries the broker id it was previewed
 * under. Rows recorded before that stamp carry no id; the stored-draft
 * rule resolves those to the legacy broker, so the overview and the
 * broker tabs never show a blank broker. Display names always come
 * from the one broker presentation helper — this module holds no
 * broker names of its own.
 */

/** The broker id for a stored row that carries none (see module note). */
const LEGACY_BROKER_ID = "etrade";

/** The broker id a row belongs to, with the legacy rule applied. */
export function ledgerBrokerId(order: TradeRecord): string {
  return order.broker || LEGACY_BROKER_ID;
}

/** The display name for a row's broker. */
export function ledgerBrokerLabel(order: TradeRecord): string {
  return brokerDisplayName(ledgerBrokerId(order));
}

/** One per-broker tab: the broker id plus its display name. */
export interface LedgerBrokerTab {
  id: string;
  label: string;
}

/**
 * The broker tabs for the loaded rows, in display-name order, so the
 * tabs are stable regardless of row order. The overview tab is not
 * included here; the panel adds it first.
 */
export function ledgerBrokerTabs(orders: readonly TradeRecord[]): LedgerBrokerTab[] {
  const ids = new Set<string>();
  for (const order of orders) ids.add(ledgerBrokerId(order));
  return [...ids]
    .map((id) => ({ id, label: brokerDisplayName(id) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export type LedgerSortKey =
  | "id"
  | "symbol"
  | "action"
  | "quantity"
  | "price"
  | "totalValue"
  | "status"
  | "broker"
  | "orderRef"
  | "proposerDid"
  | "createdAt";

export type LedgerSortDirection = "asc" | "desc";

export interface LedgerSort {
  key: LedgerSortKey;
  dir: LedgerSortDirection;
}

/** The panel's default: newest first, exactly as the API returns it. */
export const LEDGER_SORT_DEFAULT: LedgerSort = { key: "createdAt", dir: "desc" };

/**
 * The direction a column starts in when it becomes the active sort.
 * Dates and money read best newest/largest-first; labels and ids read
 * best A to Z.
 */
const SORT_DEFAULT_DIRECTION: Record<LedgerSortKey, LedgerSortDirection> = {
  id: "asc",
  symbol: "asc",
  action: "asc",
  quantity: "desc",
  price: "desc",
  totalValue: "desc",
  status: "asc",
  broker: "asc",
  orderRef: "asc",
  proposerDid: "asc",
  createdAt: "desc",
};

/** Next sort state for a header click: same column reverses, a new one starts fresh. */
export function nextLedgerSort(current: LedgerSort, key: LedgerSortKey): LedgerSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: SORT_DEFAULT_DIRECTION[key] };
}

type SortValue = string | number | null;

function ledgerSortValue(order: TradeRecord, key: LedgerSortKey): SortValue {
  switch (key) {
    case "createdAt": {
      const time = Date.parse(order.createdAt);
      return Number.isNaN(time) ? null : time;
    }
    case "quantity":
    case "price":
    case "totalValue": {
      const value = Number(order[key]);
      return Number.isFinite(value) ? value : null;
    }
    case "broker":
      return ledgerBrokerLabel(order);
    case "orderRef":
      return order.orderRef || null;
    default:
      return order[key] || null;
  }
}

function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Stable fallback order: newest first, then row id descending. It keeps
 * equal primary keys from reshuffling between renders.
 */
function compareLedgerFallback(a: TradeRecord, b: TradeRecord): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return bTime - aTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Sorts the ledger rows for the active column. Absent values (no
 * recorded reference, no parseable date, no finite amount) sort last
 * in BOTH directions: "not recorded" is not a small value, it is the
 * absence of one, and burying it keeps the recorded rows comparable.
 * The input array is untouched.
 */
export function sortLedgerRows(rows: readonly TradeRecord[], sort: LedgerSort): TradeRecord[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = ledgerSortValue(a, sort.key);
    const bValue = ledgerSortValue(b, sort.key);

    if (aValue === null || bValue === null) {
      if (aValue === null && bValue === null) return compareLedgerFallback(a, b);
      return aValue === null ? 1 : -1;
    }

    const primary = compareSortValues(aValue, bValue) * sign;
    return primary !== 0 ? primary : compareLedgerFallback(a, b);
  });
}
