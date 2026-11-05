/**
 * Issue #3367 — the account section nav follows the selected broker.
 *
 * The nav used to be one hardcoded E*TRADE list rendered for every broker, so an
 * Alpaca tenant had chips ("Alerts", "Watchlists") that scrolled into sections
 * their panel does not render, and chips ("Transactions", "Orders") that aimed
 * at E*TRADE anchors instead of the Alpaca panel's own order-history and
 * activity sections — which had no ids at all. A control that lands nowhere is
 * worse than an absent control: it reads as a broken page.
 *
 * The rule here is the same one the panels follow: the selection decides. The
 * ids returned are the ones the rendered panel actually carries — pinned by
 * `tests/broker_section_nav_3367.test.ts`, which asserts each id exists in the
 * module that renders that broker's panel.
 *
 * Deliberately NOT here: the absences. Alpaca's alerts and watchlists are
 * explained inside its panel (#3359); linking the nav to an explanation the user
 * then has to read is slower than seeing it where it is.
 */
import { isBrokerId, type BrokerId } from "../trading/brokerCatalog";

export interface BrokerSection {
  /** The chip's text. */
  readonly label: string;
  /** The DOM id the chip scrolls to. */
  readonly id: string;
}

/** Sections E*TRADE's `AccountPanels` renders, in document order. */
const ETRADE_SECTIONS: readonly BrokerSection[] = [
  { label: "Positions", id: "section-positions" },
  { label: "Alerts", id: "section-alerts" },
  { label: "Transactions", id: "section-transactions" },
  { label: "Watchlists", id: "section-watchlists" },
  { label: "Orders", id: "section-orders" },
];

/** Sections `AlpacaBrokerPanel` renders, in document order. */
const ALPACA_SECTIONS: readonly BrokerSection[] = [
  { label: "Positions", id: "section-positions" },
  { label: "Order history", id: "section-order-history" },
  { label: "Activity", id: "section-activity" },
];

/** The portfolio-risk section is the platform's and is rendered for both. */
const RISK_SECTION: BrokerSection = { label: "Portfolio Risk", id: "section-portfolio-risk" };

/**
 * The chips for one broker. An unrecognised stored id is treated as E*TRADE's
 * list, because that is the panel the hub renders for an unknown value — the
 * other place that decision is made, kept consistent rather than duplicated
 * with a different rule.
 */
export function brokerSectionNav(broker: unknown): BrokerSection[] {
  const id: BrokerId = isBrokerId(broker) ? (broker as BrokerId) : "etrade";
  const own = id === "alpaca" ? ALPACA_SECTIONS : ETRADE_SECTIONS;
  return [...own, RISK_SECTION];
}
