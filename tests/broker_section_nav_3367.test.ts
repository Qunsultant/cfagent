/**
 * Issue #3367 — the account section nav follows the selected broker.
 *
 * What these tests defend:
 *   1. Alpaca's nav names the sections its panel actually renders, and no others.
 *   2. E*TRADE's nav is unchanged.
 *   3. Every id a nav returns exists somewhere that renders that broker's panel —
 *      asserted against the panel modules themselves, not against a second list,
 *      so a renamed section fails here instead of becoming a dead chip.
 *   4. An unrecognised stored broker id follows the same rule the hub's render
 *      branch applies (the Alpaca panel), not a third rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSectionNav } from "../src/client/brokerSectionNav";

function idsFor(file: string): Set<string> {
  const text = readFileSync(file, "utf8");
  return new Set([...text.matchAll(/id="(section-[a-z-]+)"/g)].map((m) => m[1]));
}

describe("the section nav follows the broker (#3367)", () => {
  it("gives E*TRADE its unchanged list", () => {
    expect(brokerSectionNav("etrade").map((s) => s.label)).toEqual([
      "Positions",
      "Alerts",
      "Transactions",
      "Watchlists",
      "Orders",
      "Portfolio Risk",
    ]);
  });

  it("gives Alpaca the sections its panel renders, and nothing it does not", () => {
    expect(brokerSectionNav("alpaca").map((s) => s.label)).toEqual([
      "Positions",
      "Order history",
      "Activity",
      "Portfolio Risk",
    ]);
    const labels = brokerSectionNav("alpaca").map((s) => s.id);
    expect(labels).not.toContain("section-alerts");
    expect(labels).not.toContain("section-watchlists");
  });

  it("names only ids that exist in the panel that renders that broker", () => {
    // The portfolio sub-tab's sections live in PortfolioPanel (#3050 PR5);
    // the rest live in the hub and the account/risk panels. All of them are
    // part of "what E*TRADE renders".
    const etradeIds = new Set([
      ...idsFor("src/client/ETradeTradingHub.tsx"),
      ...idsFor("src/client/AccountPanels.tsx"),
      ...idsFor("src/client/PortfolioRiskPanel.tsx"),
      ...idsFor("src/client/PortfolioPanel.tsx"),
    ]);
    for (const section of brokerSectionNav("etrade")) {
      expect(etradeIds.has(section.id), `etrade ${section.id}`).toBe(true);
    }

    const alpacaIds = new Set([
      ...idsFor("src/client/AlpacaBrokerPanel.tsx"),
      ...idsFor("src/client/PortfolioRiskPanel.tsx"),
    ]);
    for (const section of brokerSectionNav("alpaca")) {
      expect(alpacaIds.has(section.id), `alpaca ${section.id}`).toBe(true);
    }
  });

  it("treats an unknown stored id the way the hub renders it — as Alpaca's panel", () => {
    // The hub's branch is `selectedBroker === "etrade" ? AccountPanels : AlpacaBrokerPanel`,
    // so an unrecognised id renders the Alpaca panel and must get Alpaca's chips.
    // One rule, not two: this is the only place the nav could disagree with the panel.
    expect(brokerSectionNav("sandbox")).toEqual(brokerSectionNav("alpaca"));
    expect(brokerSectionNav(undefined)).toEqual(brokerSectionNav("alpaca"));
  });
});
