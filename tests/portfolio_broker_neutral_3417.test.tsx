/**
 * Issue #3417 (epic #3416) — the portfolio tab follows the selected broker.
 *
 * What these tests defend:
 *   1. A neutral `{ broker, environment, result }` payload and a legacy
 *      `{ account, positions }` payload resolve to the SAME read. Before this,
 *      an Alpaca tenant's account resolved to `undefined` and the hero printed
 *      "$0.00" for a funded account — a zero is a claim, not an absence.
 *   2. An unreported figure stays `null` (the hero prints an em dash) instead
 *      of becoming zero.
 *   3. The broker's NAME and MODE come from the presentation module, so Alpaca
 *      never renders E*TRADE's words ("PAPER TRADING SANDBOX").
 *   4. The rendered hero names the selected broker.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  accountsFromPayload,
  formatMoney,
  formatSignedMoney,
  portfolioFromPayload,
  portfolioSummary,
} from "../src/client/brokerPortfolio";
import {
  brokerDisplayName,
  brokerModeBadge,
  brokerPresentation,
  brokerPresentationIsComplete,
} from "../src/trading/brokerPresentation";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui";
import {
  resetTenantProvidersStateForTest,
  setTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import type { BrokerAccount, BrokerPosition } from "../src/types";

const ACCOUNT: BrokerAccount = {
  accountId: "acct-1",
  accountKey: "key-1",
  accountDesc: "Individual",
  accountType: "INDIVIDUAL",
  netAccountValue: 25_000,
  totalAccountValue: 25_500,
  cashAvailableForInvestment: 5_000,
  marginBuyingPower: 10_000,
  dayTraderStatus: false,
};

function position(overrides: Partial<BrokerPosition>): BrokerPosition {
  return {
    symbol: "AAPL",
    description: "Apple Inc.",
    quantity: 10,
    securityType: "EQ",
    pricePaid: 100,
    costBasis: 1_000,
    currentPrice: 110,
    marketPrice: 110,
    marketValue: 1_100,
    totalGain: 100,
    unrealizedGainLoss: 100,
    totalGainPercent: 10,
    unrealizedGainLossPercent: 10,
    daysGain: 12,
    daysGainPercent: 1.1,
    ...overrides,
  };
}

afterEach(() => {
  resetTenantProvidersStateForTest();
});

describe("portfolio payload normalisation (#3417)", () => {
  it("unwraps the neutral { broker, environment, result } envelope", () => {
    const read = portfolioFromPayload({
      broker: "alpaca",
      environment: "PROD",
      result: { account: ACCOUNT, positions: [position({})] },
    });
    expect(read.account?.accountId).toBe("acct-1");
    expect(read.positions).toHaveLength(1);
    expect(read.reported).toBe(true);
  });

  it("reads the legacy E*TRADE { account, positions } payload unchanged", () => {
    const read = portfolioFromPayload({ account: ACCOUNT, positions: [] });
    expect(read.account?.accountId).toBe("acct-1");
    expect(read.reported).toBe(true);
  });

  it("distinguishes an absent positions array from an empty one", () => {
    expect(portfolioFromPayload({ account: ACCOUNT }).reported).toBe(false);
    expect(portfolioFromPayload({ broker: "alpaca", status: {} }).reported).toBe(false);
    expect(portfolioFromPayload({ positions: [] }).reported).toBe(true);
  });

  it("does not throw on a malformed body", () => {
    expect(portfolioFromPayload(null).positions).toEqual([]);
    expect(portfolioFromPayload("nope").account).toBeNull();
    expect(portfolioFromPayload({ result: "nope" }).reported).toBe(false);
  });

  it("reads accounts from both route shapes", () => {
    expect(accountsFromPayload({ count: 1, accounts: [ACCOUNT] })).toHaveLength(1);
    expect(accountsFromPayload({ broker: "alpaca", result: [ACCOUNT] })).toHaveLength(1);
    expect(accountsFromPayload({ broker: "alpaca", result: { account: ACCOUNT } })).toEqual([]);
  });
});

describe("portfolio summary resolution (#3417)", () => {
  it("prefers the broker's own account totals", () => {
    const summary = portfolioSummary(ACCOUNT, [position({})]);
    expect(summary.equity).toBe(25_500);
    expect(summary.cash).toBe(5_000);
    expect(summary.buyingPower).toBe(10_000);
    expect(summary.dayGain).toBe(12);
    expect(summary.unrealisedGain).toBe(100);
  });

  it("falls back to the sum of market values when the account reports no total", () => {
    const summary = portfolioSummary(
      { ...ACCOUNT, totalAccountValue: 0, netAccountValue: 0 },
      [position({}), position({ symbol: "MSFT", marketValue: 900 })],
    );
    expect(summary.equity).toBe(2_000);
  });

  it("falls back to cash when the broker reports no margin buying power", () => {
    const summary = portfolioSummary({ ...ACCOUNT, marginBuyingPower: undefined }, []);
    expect(summary.buyingPower).toBe(5_000);
  });

  it("reports null — not zero — when nothing was read", () => {
    const summary = portfolioSummary(null, []);
    expect(summary.equity).toBeNull();
    expect(summary.cash).toBeNull();
    expect(summary.buyingPower).toBeNull();
    expect(summary.dayGain).toBeNull();
    expect(summary.unrealisedGain).toBeNull();
  });

  it("counts options and equities separately", () => {
    const summary = portfolioSummary(ACCOUNT, [
      position({ symbol: "AAPL" }),
      position({ symbol: "NVDA.260117C100", securityType: "OPTN" }),
    ]);
    expect(summary.positionCount).toBe(2);
    expect(summary.optionCount).toBe(1);
    expect(summary.equityCount).toBe(1);
  });

  it("prints an em dash for an unreported figure and signs gains", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatSignedMoney(12)).toBe("+$12.00");
    expect(formatSignedMoney(-12)).toBe("-$12.00");
    expect(formatSignedMoney(null)).toBe("—");
  });
});

describe("broker presentation vocabulary (#3417)", () => {
  it("names each broker with its own words", () => {
    expect(brokerDisplayName("etrade")).toBe("E*TRADE");
    expect(brokerDisplayName("alpaca")).toBe("Alpaca");
    expect(brokerPresentation("alpaca").botName).toBe("AlpacaAgent");
    expect(brokerPresentation("alpaca").deskName).toBe("Alpaca Voice Trading Desk");
  });

  it("does not lend E*TRADE's sandbox vocabulary to another broker", () => {
    expect(brokerModeBadge("etrade", "paper")).toBe("PAPER TRADING SANDBOX");
    expect(brokerModeBadge("alpaca", "paper")).toBe("PAPER TRADING");
    expect(brokerModeBadge("alpaca", "live")).toBe("LIVE TRADING");
    expect(brokerModeBadge("alpaca", "paper")).not.toContain("SANDBOX");
  });

  it("describes an unrecognised id without naming any broker", () => {
    const unknown = brokerPresentation("robinhood");
    expect(unknown.known).toBe(false);
    expect(unknown.label).not.toContain("E*TRADE");
    expect(unknown.deskName).not.toContain("E*TRADE");
    expect(brokerPresentation(null).known).toBe(false);
  });

  it("covers every broker in the catalogue", () => {
    expect(brokerPresentationIsComplete()).toBe(true);
  });
});

describe("portfolio hero render follows the selection (#3417)", () => {
  function renderHub(): string {
    return ReactDOMServer.renderToString(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ETradeTradingHub, { activeSubTab: "portfolio" }),
      ),
    );
  }

  it("names Alpaca when Alpaca is selected", () => {
    setTenantProvidersStateForTest({ brokerId: "alpaca", dataProviderId: "alpaca" });
    const html = renderHub();
    expect(html).toContain('data-broker="alpaca"');
    expect(html).toMatch(/Alpaca<!-- --> Portfolio Holdings/);
    expect(html).not.toContain("PAPER TRADING SANDBOX");
    expect(html).toContain("Buying Power");
  });

  it("names E*TRADE when E*TRADE is selected", () => {
    setTenantProvidersStateForTest({ brokerId: "etrade", dataProviderId: "etrade" });
    const html = renderHub();
    expect(html).toMatch(/E\*TRADE<!-- --> Portfolio Holdings/);
    expect(html).toContain("Buying Power");
    expect(html).not.toContain("Alpaca Portfolio Holdings");
  });
});
