import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { NavigationMenu, isTabActive, NAVIGATION_ITEMS } from "../src/client/components/NavigationMenu";
import { ToastProvider } from "../src/client/components/ui";

describe("Portfolio Tab Click & Render Inspection", () => {
  it("verifies isTabActive for portfolio", () => {
    expect(isTabActive("portfolio", "portfolio")).toBe(true);
    expect(isTabActive("portfolio", "autopilot")).toBe(false);
  });

  it("verifies portfolio is defined in NAVIGATION_ITEMS under Execution with live badge", () => {
    const portfolioItem = NAVIGATION_ITEMS.find((item) => item.id === "portfolio");
    expect(portfolioItem).toBeDefined();
    expect(portfolioItem?.label).toBe("Portfolio & Holdings");
    expect(portfolioItem?.category).toBe("Execution");
    expect(portfolioItem?.badge).toBe("Broker");
  });

  it("renders NavigationMenu with active portfolio tab", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(NavigationMenu, {
        layout: "left",
        onToggleLayout: () => {},
        activeTab: "portfolio",
        onSelectTab: () => {},
        user: { login: "test_user", name: "Test User", avatar: "" },
      })
    );
    expect(html).toContain("Portfolio &amp; Holdings");
    expect(html).toContain("active");
  });

  it("renders ETradeTradingHub portfolio section with hero header and actions when activeSubTab is portfolio", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ETradeTradingHub, {
          activeSubTab: "portfolio",
          user: { login: "test_user", name: "Test User" },
        })
      )
    );
    // The portfolio section is a PageSection after the #3051 primitives
    // migration (the bespoke `portfolio-section` wrapper div is gone);
    // the hero header and actions render inside it.
    expect(html).toContain('<section class="ui-page-section">');
    expect(html).toContain("Portfolio &amp; holdings");
    expect(html).toContain("PORTFOLIO &amp; HOLDINGS");
    expect(html).toContain("Portfolio Holdings &amp; Open Positions");
    expect(html).toContain("Portfolio Equity");
    expect(html).toContain("Available Cash");
    // Renamed from "Total Active Positions" in 868e754 (option position close
    // workflow), which also added the options/equities breakdown below it.
    // The stat labels render as ui-meta-sm after #3051 (KpiRibbon), not
    // the bespoke `summary-title` spans.
    expect(html).toContain('<span class="ui-meta-sm">Active Positions</span>');
    expect(html).toContain("Refresh Positions");
    expect(html).toContain("Fast Order Ticket");
    // #913/#921: the default render is the PROD (live) environment, where
    // the demo-holdings seeder must NOT be offered. (Previously this pin
    // asserted the fabricated-data affordance was present in live mode.)
    expect(html).not.toContain("Load Demo Holdings");
  });
});
