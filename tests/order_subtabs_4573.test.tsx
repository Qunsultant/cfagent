/** @vitest-environment jsdom */
/**
 * Issue #4573 — order sub-tabs, the stock-tab context leak, and the
 * full-width ticket.
 *
 * Composition tests on the real panel (the #4538 harness): the two new
 * sub-tabs render their content and no other tab renders it, switching to
 * the stock tab drops a seeded options context instead of showing its
 * header, and the ticket card is no longer confined to half the width.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { OrderTicketPanel, type OrderTicketModel } from "../src/client/OrderTicketPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import type { TradeAssetClass, TradeOrderContext } from "../src/client/trading/tradeOrderContext";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const DRAFT = {
  id: "tr-1",
  status: "previewed",
  symbol: "NVDA",
  action: "BUY",
  quantity: 10,
  orderType: "LIMIT",
  price: 180.5,
  totalValue: 1805,
  proposerDid: "did:agent:openaimp:trading",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  previewNotes: "",
};

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/etrade/oauth/status")) return okJson({ authenticated: true, environment: "TEST", renewable: true });
      if (url.startsWith("/api/etrade/status")) return okJson({ oauthAuthenticated: true, activeEnvironment: "TEST", environment: "TEST", configured: true, hasApiKey: true });
      if (url.startsWith("/api/etrade/positions")) return okJson({ account: null, positions: [] });
      if (url.startsWith("/api/broker/orders")) return okJson({ trades: [DRAFT] });
      if (url === "/api/trading/reports/pending") return okJson({ pending: [] });
      if (url === "/api/jobs?limit=30") return okJson({ jobs: [] });
      if (url === "/api/ops/dlq/records") return okJson({ records: [] });
      return okJson({});
    }),
  );
}

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderNode(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

async function renderOrderPage(tab: string) {
  window.history.pushState(null, "", `?tab=order&orderTab=${tab}`);
  await renderNode(
    <ToastProvider>
      <ETradeTradingHub activeSubTab="order" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockFetch();
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

const OPTIONS_CONTEXT: TradeOrderContext = {
  symbol: "NVDA",
  label: "Options Order Ticket",
  assetClass: "options",
  optionLegs: [
    {
      side: "BUY",
      quantity: 1,
      optionType: "CALL",
      strike: 200,
      expirationDate: "2027-01-15",
      securityType: "OPTN",
    },
  ],
  legs: ["BUY 1 NVDA 2027-01-15 200 C"],
  strategyNetDebit: 250,
};

/** The panel with its own state, so applyTab's context clearing is observable. */
function PanelHarness() {
  const [asset, setAsset] = useState<TradeAssetClass>("options");
  const [context, setContext] = useState<TradeOrderContext | null>(OPTIONS_CONTEXT);
  const model: OrderTicketModel = {
    orderSymbol: "NVDA",
    orderAction: "BUY",
    orderType: "LIMIT",
    orderTif: "DAY",
    orderQuantity: 1,
    orderLimitPrice: "5.00",
    orderQuote: null,
    quoteLoading: false,
    previewLoading: false,
    orderError: "",
    orderContext: context,
    orderAssetClass: asset,
    orderLegs: context?.optionLegs ?? [],
    activeDraft: null,
    brokerId: "alpaca",
    tradingType: "paper",
    brokerConnected: true,
    onConnectBroker: async () => {},
    setOrderSymbol: () => {},
    setOrderAction: () => {},
    setOrderType: () => {},
    setOrderTif: () => {},
    setOrderQuantity: () => {},
    setOrderLimitPrice: () => {},
    setOrderContext: setContext,
    setActiveDraft: () => {},
    setLastExecutionResult: () => {},
    setOrderError: () => {},
    setOrderAssetClass: setAsset,
    fetchSymbolQuote: async () => {},
    updateOptionLeg: () => {},
    addOptionLeg: () => {},
    removeOptionLeg: () => {},
    setOptionLegs: () => {},
    setOptionNetOrderDirection: () => {},
    handlePreviewOrder: async () => {},
    sendNlqToChat: () => {},
    setRiskSubject: () => {},
    seedManualOptions: () => {},
  };
  return <OrderTicketPanel ticket={model} />;
}

describe("order sub-tabs (#4573)", () => {
  it("offers stock, options, risk, approvals and NLQ & Guarantee", async () => {
    await renderOrderPage("stock");
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim());
    expect(tabs).toEqual(["Stock order", "Options order", "Risk analysis", "Approvals", "NLQ & Guarantee"]);
  });

  it("renders the approvals queue on its own sub-tab", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=approvals");
    await renderNode(<PanelHarness />);
    const text = container.textContent ?? "";
    expect(text).toContain("Proposed orders awaiting human authorization");
    expect(text).toContain("BUY 10 × NVDA");
    // Issue #4626: the sub-tab IS the one home now — the standalone
    // Approvals page retired onto it, so no self-link renders.
    expect(container.querySelector('a[href="?tab=approvals"]')).toBeNull();
  });

  it("renders the guarantee and the NLQ prompts only on their sub-tab", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=nlq-guarantee");
    await renderNode(<PanelHarness />);
    const text = container.textContent ?? "";
    expect(text).toContain("Agentic HITL Safety Guarantee");
    expect(text).toContain("NLQ Voice & Text Prompts");

    act(() => root.unmount());
    container.remove();

    window.history.pushState(null, "", "?tab=order&orderTab=stock");
    await renderNode(<PanelHarness />);
    const stockText = container.textContent ?? "";
    expect(stockText).not.toContain("Agentic HITL Safety Guarantee");
    expect(stockText).not.toContain("NLQ Voice & Text Prompts");
  });

  it("drops a seeded options context when the stock tab is selected", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=stock");
    await renderNode(<PanelHarness />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Options strategy");
    expect(text).not.toContain("Options Order Ticket");
    expect(text).toContain("Equity / ETF Order Ticket");
  });

  it("gives the ticket card the full width", async () => {
    await renderOrderPage("stock");
    const title = Array.from(container.querySelectorAll("h4")).find((h) =>
      h.textContent?.includes("Equity / ETF Order Ticket"),
    );
    expect(title).toBeDefined();
    // Before #4573 the card sat in a 2-column grid whose other column held
    // the HITL/NLQ cards; the grid went with them.
    expect(title!.closest(".ui-grid")).toBeNull();
  });
});

describe("single-line ticket header (#4573)", () => {
  it("puts title, scope note, broker, mode and Refresh Quote on one header row", async () => {
    // The Refresh Quote control only renders with a symbol, so this uses the
    // stateful harness (symbol NVDA) rather than the bare hub.
    window.history.pushState(null, "", "?tab=order&orderTab=stock");
    await renderNode(<PanelHarness />);
    const header = container.querySelector(".ui-card-header-single") as HTMLElement | null;
    expect(header).toBeTruthy();
    const text = header!.textContent ?? "";
    expect(text).toContain("Equity / ETF Order Ticket");
    expect(text).toContain("Zero-commission equity trading");
    expect(text).toContain("Alpaca");
    expect(text).toContain("PAPER TRADING");
    expect(text).toContain("Refresh Quote");
  });
});

describe("capability matrix in the ticket (#4573)", () => {
  function optionFor(select: HTMLSelectElement, value: string) {
    return Array.from(select.options).find((o) => o.value === value);
  }

  it("disables the order types this broker does not support for options", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=options");
    await renderNode(<PanelHarness />);
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const orderTypeSelect = selects.find((sel) => optionFor(sel, "MARKET") !== undefined)!;
    expect(orderTypeSelect).toBeTruthy();
    // Alpaca options: market and limit only.
    expect(optionFor(orderTypeSelect, "MARKET")!.disabled).toBe(false);
    expect(optionFor(orderTypeSelect, "LIMIT")!.disabled).toBe(false);
    expect(optionFor(orderTypeSelect, "STOP")!.disabled).toBe(true);
    expect(optionFor(orderTypeSelect, "STOP_LIMIT")!.disabled).toBe(true);
  });

  it("offers only the broker's time-in-force values for that asset class", async () => {
    window.history.pushState(null, "", "?tab=order&orderTab=options");
    await renderNode(<PanelHarness />);
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const tifSelect = selects.find((sel) => optionFor(sel, "DAY") !== undefined)!;
    expect(tifSelect).toBeTruthy();
    expect(optionFor(tifSelect, "DAY")!.disabled).toBe(false);
    expect(optionFor(tifSelect, "GTC")!.disabled).toBe(false);
    // Alpaca restricts options to day/gtc.
    expect(optionFor(tifSelect, "IOC")!.disabled).toBe(true);
    expect(optionFor(tifSelect, "FOK")!.disabled).toBe(true);
  });

  it("offers the full equity set for the same broker", async () => {
    await renderOrderPage("stock");
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const orderTypeSelect = selects.find((sel) => optionFor(sel, "MARKET") !== undefined)!;
    for (const type of ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]) {
      expect(optionFor(orderTypeSelect, type)!.disabled, type).toBe(false);
    }
    const tifSelect = selects.find((sel) => optionFor(sel, "DAY") !== undefined)!;
    for (const tif of ["DAY", "GTC", "IOC", "FOK"]) {
      expect(optionFor(tifSelect, tif)!.disabled, tif).toBe(false);
    }
  });
});
