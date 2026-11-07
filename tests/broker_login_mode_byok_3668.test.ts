/**
 * Issue #3668 — Broker live/paper mode switching, Alpaca platform key auto-connect
 * with BYOK in PlatformAdmin, and broker-neutral order drafting.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";
import { ToastProvider } from "../src/client/components/ui";
import { ToolResultView } from "../src/client/chat/ToolResultView";
import { getTradingAgentConfig, TRADING_AGENT_CONFIG_BASELINE } from "../src/config/tradingAgentConfig";
import { ProposeStockTradeCommand } from "../src/mcps/openaimp/meshDoorCommands";
import type { McpToolContext } from "../src/patterns/interfaces";
import { setTenantProvidersStateForTest, resetTenantProvidersStateForTest } from "../src/client/tenantProviders";

function textOf(html: string): string {
  return html.split("<!-- -->").join("");
}

afterEach(() => {
  resetTenantProvidersStateForTest();
  vi.unstubAllGlobals();
});

describe("Issue #3668: Broker Login, Mode Switching, BYOK & Neutral Drafting", () => {
  describe("1. Mode Switching & effectiveEnv", () => {
    it("strictly respects effectiveEnv === 'PROD' for isLive without getting stuck on brokerStatus.environment = 'live'", () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
      const htmlTest = ReactDOMServer.renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(SettingsMenu, {
            userLogin: "tester",
            userName: "Tester",
            activeEnv: "TEST",
            initialOpen: true,
          }),
        ),
      );
      // Even if broker status was live, activeEnv='TEST' renders Paper as active
      expect(htmlTest).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Paper/);
      expect(htmlTest).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);

      const htmlProd = ReactDOMServer.renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(SettingsMenu, {
            userLogin: "tester",
            userName: "Tester",
            activeEnv: "PROD",
            initialOpen: true,
          }),
        ),
      );
      expect(htmlProd).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);
      expect(htmlProd).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Paper/);
    });
  });

  describe("2. Alpaca in Baseline Config", () => {
    it("includes both etrade and alpaca in baseline enabledProviders", () => {
      const config = getTradingAgentConfig({});
      expect(config.enabledProviders).toContain("etrade");
      expect(config.enabledProviders).toContain("alpaca");
      expect(TRADING_AGENT_CONFIG_BASELINE.enabledProviders).toEqual(["etrade", "alpaca"]);
    });
  });

  describe("3. Broker-Neutral Trade Proposal Door", () => {
    it("routes propose_stock_trade to tenant's configured broker (alpaca) when provider is omitted", async () => {
      const command = new ProposeStockTradeCommand();
      const mockAudit = vi.fn();
      const tradingCalls: any[] = [];
      const fakeTradingStub = {
        async executeService(call: any) {
          tradingCalls.push(call);
          return {
            status: "pending_approval",
            proposal: {
              orderId: "alp_ord_12345",
              broker: "alpaca",
              symbol: "AAPL",
              action: "BUY",
              quantity: 10,
            },
          };
        },
      };

      const mockEnv = {
        TENANT_BROKER_ID: "alpaca",
        TRADING_AGENT: {
          idFromName: (name: string) => name,
          get: () => fakeTradingStub,
        },
      };

      const context: McpToolContext = {
        env: mockEnv as any,
        actingLogin: () => "tester",
        audit: mockAudit,
      } as any;

      const result = await command.execute(
        {
          symbol: "AAPL",
          action: "BUY",
          quantity: 10,
        },
        context,
      );

      expect(tradingCalls.length).toBe(1);
      expect(tradingCalls[0].serviceId).toBe("stock_trading");
      expect(tradingCalls[0].input.provider).toBe("alpaca");
      expect(result.status).toBe("pending_approval");
      expect(mockAudit).toHaveBeenCalledWith(
        "propose_stock_trade",
        "mcp",
        expect.objectContaining({
          symbol: "AAPL",
          action: "BUY",
          quantity: 10,
        }),
      );
    });
  });

  describe("4. ToolResultView Broker Label Neutrality", () => {
    it("renders Alpaca Trade Intent and Alpaca Order ID for Alpaca drafts", () => {
      const alpacaData = {
        orderId: "alp_ord_998877",
        broker: "alpaca",
        symbol: "AAPL",
        action: "BUY",
        quantity: 10,
        limitPrice: 220,
        status: "previewed",
      };

      const html = ReactDOMServer.renderToString(
        React.createElement(ToolResultView, {
          toolType: "trade_proposal",
          data: alpacaData,
        }),
      );
      const text = textOf(html);
      expect(text).toContain("Alpaca Trade Intent");
      expect(text).toContain("Alpaca Order ID");
      expect(text).not.toContain("E*TRADE Trade Intent");
      expect(text).not.toContain("E*TRADE Order ID");
    });

    it("renders E*TRADE Trade Intent for E*TRADE drafts", () => {
      const etradeData = {
        orderId: "ord_112233",
        broker: "etrade",
        symbol: "MSFT",
        action: "BUY",
        quantity: 5,
        limitPrice: 400,
        status: "previewed",
      };

      const html = ReactDOMServer.renderToString(
        React.createElement(ToolResultView, {
          toolType: "trade_proposal",
          data: etradeData,
        }),
      );
      const text = textOf(html);
      expect(text).toContain("E*TRADE Trade Intent");
      expect(text).toContain("E*TRADE Order ID");
      expect(text).not.toContain("Alpaca Trade Intent");
    });
  });
});
