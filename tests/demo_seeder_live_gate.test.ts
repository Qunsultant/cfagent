/**
 * #921 ([#913 S3]): the demo-portfolio seeder must be unreachable from a
 * live/PROD account. `handleSeedDemoPortfolio` writes hardcoded positions
 * (NVDA/AAPL/MSFT/SPY at invented prices) and a fake paper account into
 * component state; its buttons rendered unconditionally, so a live user
 * could seed fabricated holdings into a live brokerage view.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui";
import {
  getBrokerEnvironment,
  switchBrokerEnvironment,
} from "../src/client/brokerEnvironment";

function renderPortfolioHub(): string {
  return ReactDOMServer.renderToString(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ETradeTradingHub, {
        activeSubTab: "portfolio",
        user: { login: "test_user", name: "Test User" },
      })
    )
  );
}

describe("#921 demo seeder live gate", () => {
  it("default render (paper, issue #3857) shows the paper badge and no seeder — the seeder is E*TRADE-paper-only, and the default broker is Alpaca", () => {
    const html = renderPortfolioHub();
    expect(html).toContain("PAPER TRADING");
    // The seeder buttons are gated on !isLive AND selectedBroker === "etrade";
    // with Alpaca the default broker, the default render offers no way to
    // seed fabricated holdings into any view.
    expect(html).not.toContain("Load Demo Holdings");
    expect(html).not.toContain("Reset Demo Holdings");
    expect(html).not.toContain("Load Curated Demo Positions");
  });

  it("PROD render shows NO demo-seed affordance", () => {
    // switchBrokerEnvironment adopts PROD synchronously (optimistic
    // set, before the server round-trip), so the server render below
    // sees PROD. The round-trip then fails in this hermetic test and
    // the catch restores the previous value (TEST) — no stub needed,
    // and no module state leaks to the next test.
    void switchBrokerEnvironment("PROD");
    expect(getBrokerEnvironment()).toBe("PROD");
    const html = renderPortfolioHub();
    // The hub really rendered its portfolio hero in live mode…
    // Issue #3812: the rendered live badge is broker-neutral (Alpaca renders
    // "LIVE TRADING", E*TRADE renders "LIVE BROKERAGE").
    expect(html).toContain("LIVE TRADING");
    // …and offers no way to seed fabricated holdings into it.
    expect(html).not.toContain("Load Demo Holdings");
    expect(html).not.toContain("Reset Demo Holdings");
    expect(html).not.toContain("Load Curated Demo Positions");
  });

  it("source pins: the handler refuses when live, and both buttons are gated", () => {
    const src = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");
    // Handler-level defense in depth: the seeder itself checks liveness.
    const handler = src.slice(src.indexOf("const handleSeedDemoPortfolio"));
    const handlerBody = handler.slice(0, handler.indexOf("setPositions(samplePositions)"));
    expect(handlerBody).toMatch(/if \(isLive\) return;/);
    // Both call sites are render-gated on !isLive. The buttons moved with the
    // portfolio sub-tab into PortfolioPanel (#3050 PR5); the gate travels
    // with them, so count both hosts.
    const panelSrc = readFileSync("src/client/PortfolioPanel.tsx", "utf8");
    const gateCount =
      (src.match(/!isLive && \(/g) || []).length +
      (panelSrc.match(/!isLive && \(/g) || []).length;
    expect(gateCount).toBeGreaterThanOrEqual(2);
  });
});
