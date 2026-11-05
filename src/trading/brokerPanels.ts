/**
 * Issue #2853 (programme #3216, gap G2): the broker panel contract.
 *
 * Why this module exists: the trading hub is written against one broker.
 * Its panels are E*TRADE components, so an Alpaca tenant sees E*TRADE
 * surfaces — the opposite of the programme's promise that broker selection
 * drives every screen. The fix is not a second page; it is a contract each
 * broker satisfies and each surface reads:
 *
 *     surface  →  operations it requires  →  does THIS broker support them?
 *
 * The answers are derived from `BROKER_CATALOG` (#3232), never hand-written
 * here, so a broker that gains or loses a capability changes every surface
 * at once and no second list can drift.
 *
 * Honesty rules this module makes mechanical:
 *   - an unsupported surface is `available: false` with a coded reason and
 *     the broker's own name in the message — never a blank panel;
 *   - the code is the same string the server sends
 *     (`FAILURE_BROKER_UNAVAILABLE`), so the client and the API cannot
 *     describe the same gap two different ways;
 *   - nothing here ever substitutes another broker's data.
 */
import { BROKER_CATALOG, ROUTED_BROKER_IDS, type BrokerId, type BrokerOperation } from "./brokerCatalog";

/** A panel a broker can render in the trading hub. */
export type BrokerPanelSurface =
  | "accounts"
  | "positions"
  | "orders"
  | "options"
  // Issue #3359: the account-history surfaces. They are separate from
  // `orders` (which is the order TICKET: preview + place) because history is a
  // read, and a broker can perfectly well have one without the other.
  | "orderHistory"
  | "activity"
  | "alerts"
  | "watchlists";

/** Every surface, in render order. */
export const BROKER_PANEL_SURFACES: readonly BrokerPanelSurface[] = [
  "accounts",
  "positions",
  "orders",
  "orderHistory",
  "activity",
  "alerts",
  "watchlists",
  "options",
];

/**
 * The operations a surface needs *all* of before it may render. A panel is
 * only as available as its weakest requirement: an order panel that can
 * preview but not place is not an order panel.
 */
export const SURFACE_OPERATIONS: Readonly<Record<BrokerPanelSurface, readonly BrokerOperation[]>> = {
  accounts: ["accounts"],
  positions: ["positions"],
  orders: ["orderPreview", "orderPlace"],
  orderHistory: ["orderHistory"],
  activity: ["accountActivity"],
  alerts: ["alerts"],
  watchlists: ["watchlists"],
  options: ["optionChains", "optionExpireDates"],
};

/** How a surface is named to a user. */
export const SURFACE_LABELS: Readonly<Record<BrokerPanelSurface, string>> = {
  accounts: "Accounts",
  positions: "Positions",
  orders: "Orders",
  orderHistory: "Order history",
  activity: "Account activity",
  alerts: "Alerts",
  watchlists: "Watchlists",
  options: "Options",
};

/** The coded refusal, shared with the server's 501 body. */
export const BROKER_UNAVAILABLE_CODE = "FAILURE_BROKER_UNAVAILABLE" as const;

export interface BrokerPanelAvailability {
  readonly broker: BrokerId;
  readonly surface: BrokerPanelSurface;
  readonly available: boolean;
  /** Null when available; the shared code when not. */
  readonly code: typeof BROKER_UNAVAILABLE_CODE | null;
  /** The platform capability that is missing, in the broker's own words. */
  readonly capability: string | null;
  /** User-facing sentence naming the broker. Empty when available. */
  readonly message: string;
}

/** The operations this surface is missing for this broker (empty = available). */
export function missingOperations(broker: BrokerId, surface: BrokerPanelSurface): BrokerOperation[] {
  const supports = BROKER_CATALOG[broker].supports;
  return SURFACE_OPERATIONS[surface].filter((operation) => supports[operation] !== true);
}

/**
 * Resolve one (broker, surface) pair. Total by type: every broker in the
 * catalog answers for every surface, so a new broker cannot silently omit one.
 */
export function panelAvailability(broker: BrokerId, surface: BrokerPanelSurface): BrokerPanelAvailability {
  const missing = missingOperations(broker, surface);
  if (missing.length === 0) {
    return { broker, surface, available: true, code: null, capability: null, message: "" };
  }
  const label = BROKER_CATALOG[broker].label;
  return {
    broker,
    surface,
    available: false,
    code: BROKER_UNAVAILABLE_CODE,
    capability: missing.join(", "),
    message: `${label} does not provide ${SURFACE_LABELS[surface].toLowerCase()} in this platform (${missing.join(", ")}). No other broker's data is shown in its place.`,
  };
}

/** The surfaces this broker can render, in render order. */
export function availablePanels(broker: BrokerId): BrokerPanelSurface[] {
  return BROKER_PANEL_SURFACES.filter((surface) => panelAvailability(broker, surface).available);
}

/**
 * Every broker's contract, resolved. Exposed so a surface can render a
 * complete picture (available + named gaps) without asking per-panel.
 */
export function panelContract(broker: BrokerId): BrokerPanelAvailability[] {
  return BROKER_PANEL_SURFACES.map((surface) => panelAvailability(broker, surface));
}

/** The brokers a panel may be asked about — the same list the routes accept. */
export const PANEL_BROKERS: readonly BrokerId[] = ROUTED_BROKER_IDS;
