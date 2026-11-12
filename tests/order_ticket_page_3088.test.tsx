/** @vitest-environment jsdom */
/**
 * Issue #3088: the Fast Order Ticket is its own shell-conforming page.
 * - The hub's order branch renders OrderTicketPanel (PageShell) with
 *   Stock/Options URL-synced tabs (?orderTab=stock|options, default stock).
 * - A new "Stock order" sub-menu sits beside the existing "Options order"
 *   one under Fast Order Ticket; the legacy ?assetClass=options link keeps
 *   working (pinned by tests/order_options_submenu_3038.test.tsx).
 * - Switching tabs preserves the symbol; switching to options with no
 *   context seeds the manual options ticket exactly as #3038 does.
 *
 * Harness follows tests/order_options_submenu_3038.test.tsx: react-dom
 * client in jsdom, stubbed fetch, ToastProvider, hub rendered directly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { DEFAULT_LEFT_NAV_CONFIG } from "../src/client/navConfig";
import {
  DEEP_LINK_OVERRIDES,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function mockFetch() {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/etrade/oauth/status")) {
      return okJson({ authenticated: true, environment: "TEST", renewable: true });
    }
    if (url.startsWith("/api/etrade/status")) {
      return okJson({ oauthAuthenticated: true, activeEnvironment: "TEST", environment: "TEST", configured: true, hasApiKey: true });
    }
    if (url.startsWith("/api/etrade/positions")) return okJson({ account: null, positions: [] });
    if (url.startsWith("/api/broker/orders")) return okJson({ orders: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
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
  mockFetch();
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

function findOrderItem(): any {
  for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
    for (const item of section.items as any[]) {
      if (item.id === "order") return item;
    }
  }
  return null;
}

function symbolInput(): HTMLInputElement | null {
  return document.querySelector('input[placeholder="e.g. NVDA, AAPL"]');
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Order ticket page (issue #3088)", () => {
  it("renders the ticket through OrderTicketPanel, not inline hub JSX", () => {
    const hub = readFileSync(join(HERE, "..", "src", "client", "ETradeTradingHub.tsx"), "utf8");
    const panel = readFileSync(join(HERE, "..", "src", "client", "OrderTicketPanel.tsx"), "utf8");
    expect(hub).toContain("<OrderTicketPanel");
    expect(panel).toContain("<PageTemplate");
    expect(panel).toContain('param: "orderTab"');
    expect(panel).not.toContain("style={{");
    expect(panel).not.toContain("<button ");
    expect(panel).not.toContain("<input ");
  });

  it("flips the order sub-tab to the conforming map and out of the register", () => {
    const gates = readFileSync(join(HERE, "ux_conformance_gates_3047.test.ts"), "utf8");
    expect(gates).toContain('"order": "src/client/OrderTicketPanel.tsx"');
    const register = JSON.parse(
      readFileSync(join(HERE, "ux_shell_exceptions_3047.json"), "utf8"),
    );
    expect(register.subTabs.order).toBeUndefined();
  });

  it("carries a Stock order sub-menu entry beside Options order", () => {
    const item = findOrderItem();
    expect(item).not.toBeNull();
    const ids = (item.subItems as any[]).map((s) => s.id);
    expect(ids).toContain("stock-order");
    expect(ids).toContain("options-order");
    const stock = (item.subItems as any[]).find((s) => s.id === "stock-order");
    expect(stock.label).toBe("Stock order");
  });

  it("resolves order:stock-order to ?tab=order&orderTab=stock", () => {
    expect(DEEP_LINK_OVERRIDES["order:stock-order"]).toBeDefined();
    expect(deepLinkForNavNode("order", "stock-order")).toEqual({
      tab: "order",
      params: { orderTab: "stock" },
    });
    expect(deepLinkHrefForNavNode("order", "stock-order")).toBe("?tab=order&orderTab=stock");
  });

  it("renders the options ticket on ?tab=order&orderTab=options, no legacy param needed", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=options");
    await renderOrderPage();
    expect(document.body.textContent).toContain("Options Order Ticket");
    expect(document.body.textContent).toContain("Build your order");
    expect(document.body.textContent).not.toContain("Equity / ETF Order Ticket");
    expect(new URLSearchParams(window.location.search).get("assetClass")).toBeNull();
  });

  it("renders the equity ticket on ?tab=order&orderTab=stock", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=stock");
    await renderOrderPage();
    expect(document.body.textContent).toContain("Equity / ETF Order Ticket");
    expect(document.body.textContent).not.toContain("Build your order");
  });

  it("tab switch to options preserves the symbol and seeds the manual ticket", async () => {
    window.history.pushState(null, "", "?tab=order");
    await renderOrderPage();
    const input = symbolInput();
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "NVDA");
    });
    await flush();
    const optionsTab = document.getElementById("order-ticket-tab-options");
    expect(optionsTab).not.toBeNull();
    await act(async () => {
      optionsTab!.click();
    });
    await flush();
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("options");
    expect(document.body.textContent).toContain("Options Order Ticket");
    expect(document.body.textContent).toContain("Build your order");
    expect(symbolInput()!.value).toBe("NVDA");
  });
});
