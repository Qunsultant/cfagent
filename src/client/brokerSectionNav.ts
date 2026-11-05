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
 * The branch here is deliberately the SAME branch the hub uses to choose a
 * panel (`selectedBroker === "etrade" ? AccountPanels : AlpacaBrokerPanel`), so
 * an unrecognised stored id gets Alpaca's list because it gets Alpaca's panel —
 * one rule, not two. This module holds no broker list of its own: it knows which
 * sections each of the two panels renders, and nothing about what a broker can
 * do (that is the catalogue's, and the panels read it).
 *
 * No trading import: the boundary (#290) keeps client modules out of
 * `src/trading`, and nothing here needs a capacity — only DOM anchors.
 */

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
 * The chips for one broker. The comparison matches the hub's panel branch
 * exactly: E*TRADE's panel for `"etrade"`, Alpaca's for everything else.
 */
export function brokerSectionNav(broker: unknown): BrokerSection[] {
  const own = broker === "etrade" ? ETRADE_SECTIONS : ALPACA_SECTIONS;
  return [...own, RISK_SECTION];
}
