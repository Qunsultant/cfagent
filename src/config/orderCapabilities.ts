/**
 * Order-entry capabilities (issue #4573) — the one source for "which order
 * types and time-in-force does this broker, in this mode, support for this
 * asset class".
 *
 * The matrix is data: `config/order-capabilities.json`. No component
 * hardcodes a broker rule — the ticket renders the lists this module
 * returns, disables everything else, and the preview body carries only a
 * combination that came from here.
 *
 * Fail closed: an unknown broker, an unknown mode, or an unknown asset
 * class returns an empty capability set (`supported: false`) rather than a
 * guessed default. An empty set means the ticket offers nothing and says
 * so, never that it silently sends a combination the broker may reject.
 */
import raw from "../../config/order-capabilities.json";

export type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type OrderTimeInForce = "DAY" | "GTC" | "IOC" | "FOK" | "OPG" | "CLS";
export type BrokerMode = "paper" | "live";
export type OrderAssetClass = "equity" | "options";

/** Every order type the ticket knows how to render, in display order. */
export const ALL_ORDER_TYPES: readonly OrderType[] = ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"];

/** Every time-in-force the ticket knows how to render, in display order. */
export const ALL_TIME_IN_FORCE: readonly OrderTimeInForce[] = ["DAY", "GTC", "IOC", "FOK", "OPG", "CLS"];

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  MARKET: "Market",
  LIMIT: "Limit",
  STOP: "Stop",
  STOP_LIMIT: "Stop Limit",
};

export const TIME_IN_FORCE_LABELS: Record<OrderTimeInForce, string> = {
  DAY: "Day",
  GTC: "Good-til-cancelled",
  IOC: "Immediate-or-cancel",
  FOK: "Fill-or-kill",
  // Issue #4671 (matrix gap 17): the auction values. With a Market order they
  // are MOO/MOC, with a Limit order LOO/LOC — the pair decides, so the label
  // names the session rather than inventing a second order-type list.
  OPG: "At the open (auction)",
  CLS: "At the close (auction)",
};

export interface OrderCapabilities {
  /** True when the matrix has an entry for this broker/mode/asset class. */
  supported: boolean;
  /** Supported order types, in matrix order. */
  orderTypes: readonly OrderType[];
  /** Supported time-in-force values, in matrix order. */
  timeInForce: readonly OrderTimeInForce[];
}

const EMPTY: OrderCapabilities = { supported: false, orderTypes: [], timeInForce: [] };

interface RawEntry {
  orderTypes?: unknown;
  timeInForce?: unknown;
}

interface RawConfig {
  brokers?: Record<string, Record<string, Record<string, RawEntry>>>;
}

/** The parsed matrix, exposed for tests and for the config-drift pin. */
export const ORDER_CAPABILITY_MATRIX = raw as unknown as RawConfig;

function asOrderTypes(value: unknown): OrderType[] {
  if (!Array.isArray(value)) return [];
  return ALL_ORDER_TYPES.filter((t) => (value as unknown[]).includes(t));
}

function asTimeInForce(value: unknown): OrderTimeInForce[] {
  if (!Array.isArray(value)) return [];
  return ALL_TIME_IN_FORCE.filter((t) => (value as unknown[]).includes(t));
}

/**
 * Capabilities for one broker in one mode for one asset class.
 * Unknown inputs fail closed to an empty, `supported: false` set.
 */
export function orderCapabilitiesFor(input: {
  brokerId: string;
  mode: BrokerMode;
  assetClass: OrderAssetClass;
}): OrderCapabilities {
  const entry = ORDER_CAPABILITY_MATRIX.brokers?.[input.brokerId]?.[input.mode]?.[input.assetClass];
  if (!entry) return EMPTY;
  return {
    supported: true,
    orderTypes: asOrderTypes(entry.orderTypes),
    timeInForce: asTimeInForce(entry.timeInForce),
  };
}

/** Whether the broker/mode/asset class supports this order type. */
export function supportsOrderType(caps: OrderCapabilities, type: OrderType): boolean {
  return caps.orderTypes.includes(type);
}

/** Whether the broker/mode/asset class supports this time-in-force. */
export function supportsTimeInForce(caps: OrderCapabilities, tif: OrderTimeInForce): boolean {
  return caps.timeInForce.includes(tif);
}

/**
 * Keep the current selection when it is supported; otherwise fall back to
 * the first supported value. Returns null when nothing is supported, so the
 * caller can render "not available" rather than a wrong default.
 */
export function resolveOrderType(caps: OrderCapabilities, current: OrderType): OrderType | null {
  if (supportsOrderType(caps, current)) return current;
  return caps.orderTypes[0] ?? null;
}

/** Time-in-force counterpart of {@link resolveOrderType}. */
export function resolveTimeInForce(
  caps: OrderCapabilities,
  current: OrderTimeInForce,
): OrderTimeInForce | null {
  if (supportsTimeInForce(caps, current)) return current;
  return caps.timeInForce[0] ?? null;
}
