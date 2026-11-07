/**
 * Issue #3419 (epic #3416) — Dynamic broker menu enhancement and single active mode.
 *
 * What these tests defend:
 *   1. Only one mode per broker is active at a time (TEST vs PROD).
 *      For Alpaca: "🧪 Paper" vs "🔴 Live", labelled "Alpaca · Paper" / "Alpaca · Live".
 *      For E*TRADE: "🧪 Sandbox" vs "🔴 Live", labelled "E*TRADE · Sandbox" / "E*TRADE · Live".
 *   2. The dynamic menu buttons adapt to the selected broker without leaking
 *      E*TRADE OAuth wording or fake E*TRADE test account numbers onto Alpaca.
 *   3. Alpaca connection status reflects API key configuration, not E*TRADE OAuth state.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";
import { ToastProvider } from "../src/client/components/ui";
import { setTenantProvidersStateForTest, resetTenantProvidersStateForTest } from "../src/client/tenantProviders";

function renderMenu(props: Partial<React.ComponentProps<typeof SettingsMenu>> = {}): string {
  return ReactDOMServer.renderToString(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(SettingsMenu, {
        userLogin: "test_user",
        userName: "Test User",
        initialOpen: true,
        ...props,
      }),
    ),
  );
}

function textOf(html: string): string {
  return html.split("<!-- -->").join("");
}

afterEach(() => {
  resetTenantProvidersStateForTest();
  vi.unstubAllGlobals();
});

describe("Sub-Issue 3 (#3419): Single Active Mode & Dynamic Broker Menu", () => {
  describe("Single active mode per broker", () => {
    it("renders Paper and Live for Alpaca, with only one active mode at a time (#3719 single toggle)", () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });

      // TEST mode (Paper)
      const testHtml = renderMenu({ activeEnv: "TEST" });
      const testText = textOf(testHtml);
      expect(testText).toContain("🧪 Paper");
      expect(testText).not.toContain("🔴 Live");
      expect(testText).not.toContain("🧪 Sandbox");
      // Paper button has active class in TEST mode
      expect(testHtml).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Paper/);
      expect(testHtml).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);

      // PROD mode (Live)
      const prodHtml = renderMenu({ activeEnv: "PROD" });
      const prodText = textOf(prodHtml);
      expect(prodText).not.toContain("🧪 Paper");
      expect(prodText).toContain("🔴 Live");
      // Live button has active class in PROD mode
      expect(prodHtml).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);
      expect(prodHtml).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Paper/);
    });

    it("renders Sandbox and Live for E*TRADE, with only one active mode at a time (#3719 single toggle)", () => {
      setTenantProvidersStateForTest({ brokerId: "etrade" });

      // TEST mode (Sandbox)
      const testHtml = renderMenu({ activeEnv: "TEST" });
      const testText = textOf(testHtml);
      expect(testText).toContain("🧪 Sandbox");
      expect(testText).not.toContain("🔴 Live");
      expect(testHtml).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Sandbox/);
      expect(testHtml).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);

      // PROD mode (Live)
      const prodHtml = renderMenu({ activeEnv: "PROD" });
      const prodText = textOf(prodHtml);
      expect(prodText).not.toContain("🧪 Sandbox");
      expect(prodText).toContain("🔴 Live");
      expect(prodHtml).toMatch(/btn-env-mini\s+active[^>]*>[^<]*🔴\s*Live/);
      expect(prodHtml).not.toMatch(/btn-env-mini\s+active[^>]*>[^<]*🧪\s*Sandbox/);
    });
  });

  describe("Broker dynamic adaptation and E*TRADE isolation", () => {
    it("adapts dynamic menu headers and badges to Alpaca", () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
      const html = renderMenu({ activeEnv: "TEST" });
      const text = textOf(html);

      expect(text).toContain("Alpaca Brokerage API");
      expect(text).toContain("Alpaca selected");
      expect(text).not.toContain("OAuth Session Active");
      expect(text).not.toContain("Connect E*TRADE");
      expect(text).not.toContain("E*TRADE Brokerage API");
    });

    it("does not fabricate an E*TRADE test account number on Alpaca", () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
      const html = renderMenu({ activeEnv: "TEST", account: null });
      const text = textOf(html);

      expect(text).not.toContain("••••4748");
    });

    it("presents E*TRADE controls when E*TRADE is the selected broker", () => {
      setTenantProvidersStateForTest({ brokerId: "etrade" });
      const html = renderMenu({ activeEnv: "TEST" });
      const text = textOf(html);

      expect(text).toContain("E*TRADE Brokerage API");
      expect(text).toContain("E*TRADE selected");
    });

    it("names the active broker and environment in the trigger tooltip", () => {
      // Alpaca Paper
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
      const alpacaPaperHtml = renderMenu({ activeEnv: "TEST", initialOpen: false });
      expect(alpacaPaperHtml).toContain("Settings (Alpaca · Paper)");

      // Alpaca Live
      const alpacaLiveHtml = renderMenu({ activeEnv: "PROD", initialOpen: false });
      expect(alpacaLiveHtml).toContain("Settings (Alpaca · Live)");

      // E*TRADE Sandbox
      setTenantProvidersStateForTest({ brokerId: "etrade" });
      const etradeSandboxHtml = renderMenu({ activeEnv: "TEST", initialOpen: false });
      expect(etradeSandboxHtml).toContain("Settings (E*TRADE · Sandbox)");

      // E*TRADE Live
      const etradeLiveHtml = renderMenu({ activeEnv: "PROD", initialOpen: false });
      expect(etradeLiveHtml).toContain("Settings (E*TRADE · Live)");
    });
  });
});
