import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { accountsEndpoint } from "../src/client/brokerEndpoints";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui";
import { setTenantProvidersStateForTest, resetTenantProvidersStateForTest } from "../src/client/tenantProviders";
import { brokerPresentation } from "../src/trading";
import {
  portfolioFromPayload,
  portfolioSummary,
  formatMoney,
  formatSignedMoney,
} from "../src/client/brokerPortfolio";

describe("Sub-Issue 1 (#3417): Portfolio Tab Broker Neutrality", () => {
  afterEach(() => {
    resetTenantProvidersStateForTest();
    vi.restoreAllMocks();
  });

  describe("accountsEndpoint", () => {
    it("returns legacy endpoint for etrade", () => {
      expect(accountsEndpoint("etrade")).toBe("/api/etrade/accounts");
    });

    it("returns neutral endpoint for alpaca", () => {
      expect(accountsEndpoint("alpaca")).toBe("/api/broker/accounts");
    });

    it("returns neutral endpoint for default/unrecognized broker", () => {
      expect(accountsEndpoint("")).toBe("/api/broker/accounts");
      expect(accountsEndpoint("unknown" as any)).toBe("/api/broker/accounts");
    });
  });

  describe("brokerPresentation", () => {
    it("provides presentation for etrade", () => {
      const p = brokerPresentation("etrade");
      expect(p.known).toBe(true);
      expect(p.label).toBe("E*TRADE");
      expect(p.deskName).toBe("E*TRADE Voice Trading Desk");
      expect(p.modeBadge.live).toBe("LIVE BROKERAGE");
      expect(p.modeBadge.paper).toBe("PAPER TRADING SANDBOX");
    });

    it("provides presentation for alpaca", () => {
      const p = brokerPresentation("alpaca");
      expect(p.known).toBe(true);
      expect(p.label).toBe("Alpaca");
      expect(p.deskName).toBe("Alpaca Voice Trading Desk");
      expect(p.modeBadge.live).toBe("LIVE TRADING");
      expect(p.modeBadge.paper).toBe("PAPER TRADING");
    });

    it("provides unknown presentation fallback without hardcoding etrade", () => {
      const p = brokerPresentation("something_else");
      expect(p.known).toBe(false);
      expect(p.label).toBe("Selected broker");
      expect(p.label).not.toContain("E*TRADE");
    });
  });

  describe("brokerPortfolio payload unwrapping & summary", () => {
    it("unwraps legacy etrade positions payload directly", () => {
      const payload = {
        account: {
          accountId: "et-1",
          accountKey: "k-1",
          accountDesc: "E*TRADE Account",
          accountType: "MARGIN",
          netAccountValue: 50000,
          totalAccountValue: 50000,
          cashAvailableForInvestment: 12000,
        },
        positions: [
          {
            symbol: "SPY",
            description: "SPDR S&P 500",
            quantity: 20,
            marketValue: 10000,
            unrealizedGainLoss: 500,
            daysGain: 120,
            securityType: "EQ",
            pricePaid: 475,
            costBasis: 9500,
            currentPrice: 500,
            marketPrice: 500,
            totalGain: 500,
            totalGainPercent: 5.26,
            unrealizedGainLossPercent: 5.26,
            daysGainPercent: 1.2,
          },
        ],
      };

      const read = portfolioFromPayload(payload);
      expect(read.reported).toBe(true);
      expect(read.account?.accountId).toBe("et-1");
      expect(read.positions).toHaveLength(1);
      expect(read.positions[0].symbol).toBe("SPY");

      const summary = portfolioSummary(read.account, read.positions);
      expect(summary.equity).toBe(50000);
      expect(summary.cash).toBe(12000);
      expect(summary.positionCount).toBe(1);
      expect(summary.unrealisedGain).toBe(500);
      expect(summary.dayGain).toBe(120);
    });

    it("unwraps neutral broker (Alpaca) positions payload from result envelope", () => {
      const payload = {
        broker: "alpaca",
        environment: "TEST",
        result: {
          account: {
            accountId: "alpaca-paper-1",
            accountKey: "alpaca-paper-1",
            accountDesc: "Alpaca Trading Account",
            accountType: "MARGIN",
            netAccountValue: 105432.5,
            totalAccountValue: 105432.5,
            cashAvailableForInvestment: 85000,
            marginBuyingPower: 170000,
          },
          positions: [
            {
              symbol: "NVDA",
              description: "NVIDIA Corporation",
              quantity: 50,
              marketValue: 60000,
              unrealizedGainLoss: 2500,
              daysGain: -450,
              securityType: "EQ",
              pricePaid: 1150,
              costBasis: 57500,
              currentPrice: 1200,
              marketPrice: 1200,
              totalGain: 2500,
              totalGainPercent: 4.35,
              unrealizedGainLossPercent: 4.35,
              daysGainPercent: -0.74,
            },
          ],
        },
      };

      const read = portfolioFromPayload(payload);
      expect(read.reported).toBe(true);
      expect(read.account?.accountId).toBe("alpaca-paper-1");
      expect(read.positions).toHaveLength(1);
      expect(read.positions[0].symbol).toBe("NVDA");

      const summary = portfolioSummary(read.account, read.positions);
      expect(summary.equity).toBe(105432.5);
      expect(summary.cash).toBe(85000);
      expect(summary.buyingPower).toBe(170000);
      expect(summary.positionCount).toBe(1);
      expect(summary.unrealisedGain).toBe(2500);
      expect(summary.dayGain).toBe(-450);

      expect(formatMoney(summary.equity)).toBe("$105,432.50");
      expect(formatSignedMoney(summary.unrealisedGain)).toBe("+$2,500.00");
      expect(formatSignedMoney(summary.dayGain)).toBe("-$450.00");
    });
  });

  describe("Portfolio Header Branding & Vocabulary", () => {
    it("displays Alpaca branding in hero header when broker is alpaca", () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
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

      const text = html.replaceAll("<!-- -->", "");
      expect(text).toContain("Alpaca Portfolio Holdings &amp; Open Positions");
      expect(text).toContain("across your connected Alpaca brokerage desk");
    });

    it("displays E*TRADE branding in hero header when broker is etrade", () => {
      setTenantProvidersStateForTest({ brokerId: "etrade" });
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

      const text = html.replaceAll("<!-- -->", "");
      expect(text).toContain("E*TRADE Portfolio Holdings &amp; Open Positions");
      expect(text).toContain("across your connected E*TRADE brokerage desk");
    });
  });
});
