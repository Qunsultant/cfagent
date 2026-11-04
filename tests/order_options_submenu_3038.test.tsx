/** @vitest-environment jsdom */
/**
 * Issue #3038: order page — Pending approvals below the ticket, and the
 * Options order sub-menu under Fast Order Ticket.
 * - Nav config: the order item carries an options-order sub-menu entry,
 *   and the deep-link override resolves it to
 *   ?tab=order&assetClass=options.
 * - Hub render: landing on that URL seeds a manual options ticket
 *   through the existing no-legs path (blank BUY CALL leg, editable
 *   underlying, leg editor); without the param the equity ticket
 *   renders instead.
 * - Hub render: Pending approvals renders AFTER the ticket header in
 *   document order — the bottom of the order page, not above it.
 *
 * Harness follows tests/etradeDisconnect2386.test.tsx: react-dom/client
 * in jsdom, stubbed fetch, ToastProvider.
 */
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
    const method = init?.method || "GET";
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

describe("Order page sub-menu and layout (issue #3038)", () => {
  it("carries an Options order sub-menu entry on the Fast Order Ticket item", () => {
    const order = findOrderItem();
    expect(order).not.toBeNull();
    const sub = (order.subItems as any[]).find((s) => s.id === "options-order");
    expect(sub).toBeDefined();
    expect(sub.label).toBe("Options order");
  });

  it("resolves order:options-order to ?tab=order&assetClass=options", () => {
    expect(DEEP_LINK_OVERRIDES["order:options-order"]).toEqual({
      tab: "order",
      params: { assetClass: "options" },
    });
    expect(deepLinkForNavNode("order", "options-order")).toEqual({
      tab: "order",
      params: { assetClass: "options" },
    });
    expect(deepLinkHrefForNavNode("order", "options-order")).toBe("?tab=order&assetClass=options");
  });

  it("renders the manual options ticket on ?tab=order&assetClass=options", async () => {
    window.history.pushState(null, "", "?tab=order&assetClass=options");
    await renderOrderPage();
    expect(document.body.textContent).toContain("Options Order Ticket");
    expect(document.body.textContent).toContain("Build your order");
    expect(document.body.textContent).not.toContain("Equity / ETF Order Ticket");
    // The param is a one-shot trigger: consumed on arrival so it
    // cannot linger into later tab navigations.
    expect(new URLSearchParams(window.location.search).get("assetClass")).toBeNull();
  });

  it("renders the equity ticket on ?tab=order without the param", async () => {
    window.history.pushState(null, "", "?tab=order");
    await renderOrderPage();
    expect(document.body.textContent).toContain("Equity / ETF Order Ticket");
    expect(document.body.textContent).not.toContain("Build your order");
  });

  it("renders Pending approvals below the ticket, not above it", async () => {
    window.history.pushState(null, "", "?tab=order");
    await renderOrderPage();
    const headings = Array.from(document.querySelectorAll("h3, h4"));
    const ticket = headings.find((h) => (h.textContent ?? "").includes("Equity / ETF Order Ticket"));
    const approvals = headings.find((h) => (h.textContent ?? "").trim() === "Pending approvals");
    expect(ticket).toBeDefined();
    expect(approvals).toBeDefined();
    // DOCUMENT_POSITION_FOLLOWING (4): approvals comes after the ticket.
    expect(ticket!.compareDocumentPosition(approvals!) & 4).toBe(4);
  });
});
