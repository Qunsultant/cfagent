/** @vitest-environment jsdom */
/**
 * Issue #3125: Risk as a tab on the Order Ticket page + any-security
 * analysis (stocks and options), with host-applied chrome.
 * - The order page gains a Risk tab seeded from the live ticket: equity
 *   seeds Long Equity, an options ticket seeds its legs as a multi-leg
 *   subject, and ticket legs carry no IV so the tab must disclose the
 *   missing-IV gap instead of silently complete Greeks.
 * - The standalone page gains a Stock/Options switch with a legs editor.
 * - The Fast Order Ticket "Risk Analysis" sub-menu lands on the Risk tab;
 *   the standalone ?tab=risk-analysis route keeps working.
 * - Composability (revised 2026-11-04, Ceos's redirection): NO split
 *   component. The Risk tab renders the SAME RiskAnalysisPanel the
 *   standalone route renders; the host applies chrome via
 *   PageChromeContext (page/tab/nested). The panel never reads the
 *   context and never branches on its host — the three-host test below
 *   proves one component renders correctly in all three hosts.
 * - Layout: the order-workspace pattern (form card, summary card,
 *   responsive grid, a card per block), not bare tables.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  OrderTicketPanel,
  type OrderTicketModel,
} from "../src/client/OrderTicketPanel";
import { RiskAnalysisPanel } from "../src/client/RiskAnalysisPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  PageChromeContext,
  type PageChromeMode,
} from "../src/client/components/ui/PageShell";
import {
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import type { TradeOrderContext } from "../src/client/trading/tradeOrderContext";

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
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/broker/orders")) return okJson({ orders: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

function makeModel(overrides: Partial<OrderTicketModel> = {}): OrderTicketModel {
  const noop = () => {};
  const noopAsync = async () => {};
  return {
    orderSymbol: "AAPL",
    orderAction: "BUY",
    orderType: "LIMIT",
    orderQuantity: 10,
    orderLimitPrice: "",
    orderQuote: {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      lastPrice: 250,
      change: 0,
      changePercent: 0,
      bid: 249.9,
      ask: 250.1,
      volume: 1000,
      open: 248,
      high: 251,
      low: 247,
    },
    quoteLoading: false,
    previewLoading: false,
    orderError: "",
    orderContext: null,
    orderAssetClass: "equity",
    orderLegs: [],
    activeDraft: null,
    brokerId: "etrade",
    tradingType: "paper",
    brokerConnected: true,
    setOrderSymbol: noop,
    setOrderAction: noop,
    setOrderType: noop,
    setOrderQuantity: noop,
    setOrderLimitPrice: noop,
    setOrderContext: noop,
    setActiveDraft: noop,
    setLastExecutionResult: noop,
    setOrderError: noop,
    setOrderAssetClass: noop,
    fetchSymbolQuote: noopAsync,
    updateOptionLeg: noop,
    addOptionLeg: noop,
    removeOptionLeg: noop,
    setOptionNetOrderDirection: noop,
    handlePreviewOrder: async (e: React.FormEvent) => {
      e.preventDefault();
    },
    onConnectBroker: noopAsync,
    sendNlqToChat: noop,
    setRiskSubject: noop,
    seedManualOptions: noop,
    ...overrides,
  };
}

async function renderPanel(model: OrderTicketModel) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <OrderTicketPanel ticket={model} />
      </ToastProvider>,
    );
  });
  await flush();
}

async function renderRiskStandalone() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RiskAnalysisPanel />);
  });
  await flush();
}

async function renderRiskInHost(mode: PageChromeMode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PageChromeContext.Provider value={mode}>
        <RiskAnalysisPanel />
      </PageChromeContext.Provider>,
    );
  });
  await flush();
}

function unmountCurrent() {
  if (root) root.unmount();
  root = undefined as any;
  container?.remove();
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Control (input/select) whose <label> starts with the given text. */
function controlForLabel(text: string): HTMLElement | null {
  const labels = Array.from(document.querySelectorAll("label"));
  const label = labels.find((l) => (l.textContent ?? "").trim().startsWith(text));
  if (!label) return null;
  const forId = label.getAttribute("for");
  if (forId) return document.getElementById(forId);
  return label.parentElement?.querySelector("input, select");
}

function clickTab(id: string) {
  const tab = document.getElementById(`order-ticket-tab-${id}`);
  expect(tab).not.toBeNull();
  return act(async () => {
    tab!.click();
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, "", "/?tab=order");
  mockFetch();
});

afterEach(() => {
  unmountCurrent();
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("Risk tab on the Order Ticket page (issue #3125)", () => {
  it("renders a Risk tab that analyzes the seeded equity ticket", async () => {
    await renderPanel(makeModel({}));
    await clickTab("risk");
    await flush();
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("risk");
    expect(document.body.textContent).toContain("Risk score");
    // Equity seed: Long Equity, quantity 10 → Δ +10.00.
    expect(document.body.textContent).toContain("Δ +10.00");
  });

  it("seeds a multi-leg subject from an options ticket and discloses missing IV", async () => {
    const orderContext: TradeOrderContext = {
      assetClass: "options",
      symbol: "AAPL",
      action: "BUY",
      quantity: 2,
      label: "Bull call spread",
      legs: [],
      optionLegs: [
        { securityType: "OPTN", side: "BUY", quantity: 2, optionType: "CALL", strike: 260, expirationDate: "2026-12-18" },
        { securityType: "OPTN", side: "SELL", quantity: 2, optionType: "CALL", strike: 280, expirationDate: "2026-12-18" },
      ],
    };
    await renderPanel(
      makeModel({
        orderAssetClass: "options",
        orderContext,
        orderLegs: orderContext.optionLegs!,
      }),
    );
    await clickTab("risk");
    await flush();
    expect(document.body.textContent).toContain("Risk score");
    // Ticket legs carry no IV: the engine excludes them from Greek sums
    // and the tab must say so instead of showing complete Greeks.
    expect(document.body.textContent).toContain("excluded from Greek sums");
    expect(document.body.textContent).toContain("Δ +0.00");
  });

  it("keeps the risk analysis mounted-hidden when returning to an asset tab", async () => {
    await renderPanel(makeModel({}));
    await clickTab("risk");
    await flush();
    await clickTab("stock");
    await flush();
    const riskPanel = document.getElementById("order-ticket-panel-risk");
    expect(riskPanel).not.toBeNull();
    expect(riskPanel!.hasAttribute("hidden")).toBe(true);
    expect(document.body.textContent).toContain("Equity / ETF Order Ticket");
  });

  it("lands ?orderTab=risk on the Risk tab from the URL", async () => {
    window.history.pushState({}, "", "/?tab=order&orderTab=risk");
    await renderPanel(makeModel({}));
    expect(document.body.textContent).toContain("Risk score");
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("risk");
  });

  it("retargets the Risk Analysis sub-menu to the order page's Risk tab", () => {
    expect(deepLinkForNavNode("order", "risk-analysis")).toEqual({
      tab: "order",
      params: { orderTab: "risk" },
    });
    expect(deepLinkHrefForNavNode("order", "risk-analysis")).toBe(
      "?tab=order&orderTab=risk",
    );
  });

  it("standalone page analyzes a typed options leg and discloses missing IV", async () => {
    await renderRiskStandalone();
    const symbol = controlForLabel("Symbol") as HTMLInputElement;
    expect(symbol).not.toBeNull();
    await act(async () => {
      setInputValue(symbol!, "AAPL");
    });
    const security = controlForLabel("Security type") as HTMLSelectElement;
    expect(security).not.toBeNull();
    await act(async () => {
      setSelectValue(security!, "options");
    });
    await flush();
    expect(document.body.textContent).toContain("Add leg");
    const strike = controlForLabel("Strike ($)") as HTMLInputElement;
    expect(strike).not.toBeNull();
    await act(async () => {
      setInputValue(strike!, "260");
    });
    const analyze = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Analyze",
    );
    expect(analyze).not.toBeNull();
    await act(async () => {
      analyze!.click();
    });
    await flush();
    expect(document.body.textContent).toContain("AAPL — Long Call");
    expect(document.body.textContent).toContain("Risk score");
    // No IV supplied on the leg: Greeks cover nothing, and the panel says so.
    expect(document.body.textContent).toContain("excluded from Greek sums");
    // Order-workspace layout: form card + summary card + responsive grid.
    expect(document.querySelectorAll(".ui-card").length).toBeGreaterThan(0);
    expect(document.querySelector(".ui-grid.autofit-md")).not.toBeNull();
  });

  it("renders the SAME panel in all three hosts with no per-host edits", async () => {
    // Standalone route: full shell, h1 + scope note.
    await renderRiskStandalone();
    expect(document.querySelector("h1")?.textContent).toBe("Risk Analysis");
    expect(document.querySelector(".ui-page-shell")).not.toBeNull();
    unmountCurrent();

    // Tab host: content only — no h1, no shell div; the tab label is the title.
    await renderRiskInHost("tab");
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector(".ui-page-shell")).toBeNull();
    expect(document.body.textContent).toContain("Analyze a symbol");
    unmountCurrent();

    // Nested host: card surface, title as the card heading, never a second h1.
    await renderRiskInHost("nested");
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector(".ui-card")).not.toBeNull();
    expect(document.querySelector("h2")?.textContent).toBe("Risk Analysis");
  });

  it("pins host-applied chrome: panel never branches on its host", () => {
    const risk = readFileSync(join(HERE, "..", "src", "client", "RiskAnalysisPanel.tsx"), "utf8");
    const order = readFileSync(join(HERE, "..", "src", "client", "OrderTicketPanel.tsx"), "utf8");
    const shell = readFileSync(join(HERE, "..", "src", "client", "components", "ui", "PageShell.tsx"), "utf8");
    // One component, no bare variant, no host branching inside the panel.
    // (The panel's doc comment may name the context; the pin is on
    // reading it: no import, no useContext, no provider.)
    expect(risk).toContain("export function RiskAnalysisPanel");
    expect(risk).not.toContain("RiskAnalysisContent");
    expect(risk).not.toContain("useContext(PageChromeContext)");
    expect(risk).not.toContain("PageChromeContext.Provider");
    expect(risk).toContain("<Card>");
    expect(risk).not.toContain("style={{");
    // The tab host applies chrome via context around the unchanged panel.
    expect(order).toContain("PageChromeContext.Provider");
    expect(order).toContain('value="tab"');
    expect(order).toContain("RiskAnalysisPanel");
    expect(order).not.toContain("RiskAnalysisContent");
    expect(order).toContain('"risk"');
    expect(order).not.toContain("style={{");
    // Only PageShell reads the context, in all three modes.
    expect(shell).toContain("PageChromeContext");
    expect(shell).toContain('"tab"');
    expect(shell).toContain('"nested"');
  });
});
