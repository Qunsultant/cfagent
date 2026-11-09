/**
 * Issue #3880 — the hero must not infer the side from local state, and must not
 * claim "0 positions" before a read lands.
 *
 * Live symptom (Alpaca paper, 2 MSFT shares):
 *   badge  "Alpaca LIVE TRADING"        (server had resolved environment: TEST)
 *   copy   "connected live Alpaca …"    (same)
 *   hero   "ACTIVE POSITIONS 0"         (before ↻ Refresh Positions)
 *   API    /api/broker/positions 200 {environment:"TEST", result:{positions:[MSFT x2]}}
 */
import { describe, expect, it } from "vitest";
import { heroTradingType, portfolioSummary } from "../src/client/brokerPortfolio";

describe("heroTradingType (#3880)", () => {
  it("follows the environment the server echoed", () => {
    expect(heroTradingType("TEST", "PROD")).toBe("paper");
    expect(heroTradingType("PROD", "TEST")).toBe("live");
  });

  it("is case- and whitespace-insensitive, and accepts the legacy words", () => {
    expect(heroTradingType(" test ", "PROD")).toBe("paper");
    expect(heroTradingType("paper", "PROD")).toBe("paper");
    expect(heroTradingType("live", "TEST")).toBe("live");
    expect(heroTradingType("SANDBOX", "PROD")).toBe("paper");
  });

  it("falls back to local state only when nothing was resolved", () => {
    expect(heroTradingType(null, "PROD")).toBe("live");
    expect(heroTradingType(undefined, "TEST")).toBe("paper");
    expect(heroTradingType("", "TEST")).toBe("paper");
    expect(heroTradingType(42, "TEST")).toBe("paper");
  });
});

describe("portfolioSummary.reported (#3880)", () => {
  it("is false when nothing was read, so the hero can say unknown", () => {
    const summary = portfolioSummary(null, []);
    expect(summary.reported).toBe(false);
    expect(summary.positionCount).toBe(0);
    expect(summary.equity).toBeNull();
    expect(summary.cash).toBeNull();
  });

  it("is true when an account was read, even with no positions", () => {
    const summary = portfolioSummary(
      { accountId: "a", accountDesc: "Alpaca", totalAccountValue: 100000, cashAvailableForInvestment: 100000 } as any,
      [],
    );
    expect(summary.reported).toBe(true);
    expect(summary.equity).toBe(100000);
  });

  it("is true when positions were read without an account", () => {
    const summary = portfolioSummary(null, [{ symbol: "MSFT", quantity: 2, marketValue: 1082.7 } as any]);
    expect(summary.reported).toBe(true);
    expect(summary.positionCount).toBe(1);
    expect(summary.equity).toBe(1082.7);
  });
});
