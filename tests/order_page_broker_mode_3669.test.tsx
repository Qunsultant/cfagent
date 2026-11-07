/** @vitest-environment jsdom */
/**
 * Issue #3669: the order page (?tab=order) honors the selected broker and mode.
 *
 * Defect this pins away: the order branch rendered E*TRADE's OAuth object
 * for every tenant, so an Alpaca/paper tenant was permanently told to
 * "Connect your E*TRADE account" — a flow that tenant can never complete.
 *
 * What these tests defend:
 *   1. With Alpaca/paper selected, the page shows Alpaca + PAPER TRADING,
 *      shows the Alpaca connect flow, never prompts for E*TRADE, and never
 *      calls E*TRADE's OAuth status read.
 *   2. With E*TRADE selected and unauthenticated, the E*TRADE prompt is
 *      still there (the flow that broker actually has).
 *   3. With Alpaca connected, no connect notice shows at all.
 *   4. The mode badge follows the TEST/PROD selection, not hub `isLive`:
 *      even when the broker status read reports live, a Paper selection
 *      still badges PAPER TRADING. Before #3668 landed (9112193f), `isLive`
 *      ORed the broker status in, so the badge would have inherited the
 *      stuck-live value; the test pins the badge to the selection
 *      regardless of what the status read says.
 *
 * Harness follows tests/order_ticket_page_3088.test.tsx: react-dom client
 * in jsdom, stubbed fetch, ToastProvider, hub rendered directly.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { saveTenantProviders } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calledUrls: string[];

async function flush(ms = 150) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

let currentBroker = "alpaca";

function mockFetch(opts: { alpacaConfigured: boolean; brokerStatusLive: boolean }) {
  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    calledUrls.push(url);
    if (url.startsWith("/api/tenant/settings/providers")) {
      return okJson({ brokerId: currentBroker, dataProviderId: currentBroker });
    }
    if (url.startsWith("/api/broker/etrade/environment")) {
      return okJson({ environment: "TEST" });
    }
    if (url.startsWith("/api/etrade/oauth/status")) {
      return okJson({ authenticated: false, environment: "TEST", renewable: false });
    }
    if (url.startsWith("/api/broker/connect/alpaca")) {
      return okJson({
        broker: "alpaca",
        side: "paper",
        configured: opts.alpacaConfigured,
        signedIn: opts.alpacaConfigured,
        source: opts.alpacaConfigured ? "user" : "none",
        keyIdLast4: opts.alpacaConfigured ? "1234" : null,
        storedAt: null,
      });
    }
    if (url.startsWith("/api/broker/status")) {
      // The status read reports live even though the TEST (paper)
      // selection stands. The order badge must not inherit it.
      return okJson({
        broker: "alpaca",
        environment: opts.brokerStatusLive ? "live" : "paper",
        activeEnvironment: opts.brokerStatusLive ? "PROD" : "TEST",
        configured: opts.alpacaConfigured,
        status: {
          broker: "alpaca",
          environment: opts.brokerStatusLive ? "live" : "paper",
          activeEnvironment: opts.brokerStatusLive ? "PROD" : "TEST",
          configured: opts.alpacaConfigured,
        },
      });
    }
    if (url.startsWith("/api/etrade/status")) {
      return okJson({ oauthAuthenticated: false, activeEnvironment: "TEST", environment: "TEST", configured: false });
    }
    if (url.startsWith("/api/broker/positions") || url.startsWith("/api/etrade/positions")) {
      return okJson({ account: null, positions: [] });
    }
    if (url.startsWith("/api/broker/orders")) return okJson({ orders: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function selectBroker(brokerId: string): Promise<void> {
  currentBroker = brokerId;
  await saveTenantProviders({ brokerId, dataProviderId: brokerId });
}

async function renderOrderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <ETradeTradingHub activeSubTab="order" />
      </ToastProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  calledUrls = [];
  currentBroker = "alpaca";
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

function bodyText(): string {
  return document.body.textContent ?? "";
}

describe("order page honors the selected broker and mode (#3669)", () => {
  it("shows Alpaca/paper with the Alpaca connect flow — never an E*TRADE prompt", async () => {
    mockFetch({ alpacaConfigured: false, brokerStatusLive: true });
    await selectBroker("alpaca");
    await renderOrderPage();

    const text = bodyText();
    expect(text).toContain("Alpaca");
    expect(text).toContain("PAPER TRADING");
    expect(text).not.toContain("LIVE TRADING");
    expect(text).toContain("Connect your Alpaca account");
    expect(text).not.toContain("Connect your E*TRADE account");
    expect(text).not.toContain("Connect E*TRADE");
    expect(calledUrls.some((u) => u.startsWith("/api/etrade/oauth/status"))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith("/api/broker/connect/alpaca"))).toBe(true);
  });

  it("shows no connect notice once Alpaca is connected", async () => {
    mockFetch({ alpacaConfigured: true, brokerStatusLive: false });
    await selectBroker("alpaca");
    await renderOrderPage();

    const text = bodyText();
    expect(text).toContain("Alpaca");
    expect(text).toContain("PAPER TRADING");
    expect(text).not.toContain("Connect your Alpaca account");
    expect(text).not.toContain("Connect your E*TRADE account");
  });

  it("keeps the E*TRADE prompt for an unauthenticated E*TRADE tenant", async () => {
    mockFetch({ alpacaConfigured: false, brokerStatusLive: false });
    await selectBroker("etrade");
    await renderOrderPage();

    const text = bodyText();
    expect(text).toContain("E*TRADE");
    expect(text).toContain("PAPER TRADING SANDBOX");
    expect(text).toContain("Connect your E*TRADE account");
    expect(text).not.toContain("Connect your Alpaca account");
    expect(calledUrls.some((u) => u.startsWith("/api/etrade/oauth/status"))).toBe(true);
  });
});
