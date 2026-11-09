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

describe("#921 demo seeder live gate", () => {
  it("PROD render (the default environment) shows NO demo-seed affordance", () => {
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
    // Both call sites are render-gated on !isLive.
    const gateCount = (src.match(/!isLive && \(/g) || []).length;
    expect(gateCount).toBeGreaterThanOrEqual(2);
  });
});
