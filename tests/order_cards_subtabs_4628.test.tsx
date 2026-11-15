/** @vitest-environment jsdom */
/**
 * Issue 4628 (S3, parent issue 4625) — the order ticket, the quote
 * strip and the approvals rail belong to the asset tabs only.
 *
 * Composition tests on the real panel (the issue 4573 harness): on the
 * approvals and NLQ & Guarantee sub-tabs the ticket WorkCard is hidden,
 * the quote ContextStrip does not render, and the "Pending approvals"
 * queueRail does not render — while the Tabs bar, the PageTemplate
 * title, the approvals queue (approvals) and the two NLQ/Guarantee
 * cards (nlq-guarantee) still render. The asset panel keeps `retain`
 * (the risk tab's shape): it stays mounted-hidden so in-flight ticket
 * work survives tab switches, so these tests assert visibility
 * (the panel's `hidden` attribute), never absence from the DOM.
 *
 * Edge case: a seed landing (asset class moving underneath the page)
 * must not yank the user off approvals or NLQ & Guarantee onto an
 * asset tab — the post-mount follow effect guards all three non-asset
 * tabs, the way the mount effect already does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OrderTicketPanel, type OrderTicketModel } from "../src/client/OrderTicketPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import type { TradeAssetClass, TradeOrderContext } from "../src/client/trading/tradeOrderContext";
import type { ETradeQuote } from "../src/types";
import { readFileSync } from "fs";

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

const QUOTE: ETradeQuote = {
  symbol: "NVDA",
  companyName: "NVIDIA Corporation",
  lastPrice: 180.5,
  price: 180.5,
  change: 2.5,
  changePercent: 1.4,
  bid: 180.4,
  ask: 180.6,
  volume: 1000000,
  open: 178,
  high: 181,
  low: 177,
  quoteStatus: "live",
  source: "test",
  timestamp: new Date().toISOString(),
};

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

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/broker/orders")) return okJson({ trades: [DRAFT] });
      if (url === "/api/trading/reports/pending") return okJson({ pending: [] });
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

function makeModel(overrides: Partial<OrderTicketModel>): OrderTicketModel {
  return {
    orderSymbol: "NVDA",
    orderAction: "BUY",
    orderType: "LIMIT",
    orderTif: "DAY",
    orderQuantity: 1,
    orderLimitPrice: "5.00",
    orderQuote: QUOTE,
    quoteLoading: false,
    previewLoading: false,
    orderError: "",
    orderContext: null,
    orderAssetClass: "stock",
    orderLegs: [],
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
    setOrderContext: () => {},
    setActiveDraft: () => {},
    setLastExecutionResult: () => {},
    setOrderError: () => {},
    setOrderAssetClass: () => {},
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
    ...overrides,
  };
}

/**
 * The panel with its own asset-class state, so the post-mount follow
 * effect is observable: the flip button moves the asset class
 * underneath the page the way a landing seed does.
 */
function PanelHarness({
  initialAsset = "stock",
  initialContext = null as TradeOrderContext | null,
}: {
  initialAsset?: TradeAssetClass;
  initialContext?: TradeOrderContext | null;
}) {
  const [asset, setAsset] = useState<TradeAssetClass>(initialAsset);
  const [context, setContext] = useState<TradeOrderContext | null>(initialContext);
  const model = makeModel({
    orderAssetClass: asset,
    orderContext: context,
    orderLegs: context?.optionLegs ?? [],
    setOrderAssetClass: setAsset,
    setOrderContext: setContext,
  });
  return (
    <ToastProvider>
      <button data-testid="flip-asset" onClick={() => setAsset(asset === "stock" ? "options" : "stock")}>
        flip asset
      </button>
      <OrderTicketPanel ticket={model} />
    </ToastProvider>
  );
}

async function renderPanel(tab: string, harnessProps?: { initialAsset?: TradeAssetClass; initialContext?: TradeOrderContext | null }) {
  window.history.pushState(null, "", `?tab=order&orderTab=${tab}`);
  await renderNode(<PanelHarness {...harnessProps} />);
}

/** The asset tabpanel, whichever asset class the ticket currently is. */
function assetPanel(): HTMLElement | null {
  return (
    document.getElementById("order-ticket-panel-stock") ??
    document.getElementById("order-ticket-panel-options")
  );
}

/** The rail link: the anchor inside the "Pending approvals" section. */
function railLink(): HTMLAnchorElement | null {
  const links = Array.from(container.querySelectorAll('a[href="?tab=order&orderTab=approvals"]'));
  return (
    (links.find((a) => {
      const section = a.closest("section");
      return section?.querySelector("h2")?.textContent?.trim() === "Pending approvals";
    }) as HTMLAnchorElement | undefined) ?? null
  );
}

function tabLabels(): string[] {
  // The order page's own Tabs only: the retained risk panel mounts its
  // own inner tabs too, so a bare [role="tab"] query would also match
  // those. The five order tabs carry order-ticket-tab-* ids.
  return ["stock", "options", "risk", "approvals", "nlq-guarantee"].map(
    (id) => document.getElementById(`order-ticket-tab-${id}`)?.textContent?.trim() ?? "",
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

describe("order cards leave the approvals sub-tab (issue 4628)", () => {
  it("hides the ticket, the quote strip and the rail — the queue stays", async () => {
    await renderPanel("approvals");
    // The ticket panel stays mounted-hidden (retain), never visible.
    const panel = assetPanel();
    expect(panel).not.toBeNull();
    expect(panel!.hasAttribute("hidden")).toBe(true);
    expect(panel!.style.display).toBe("none");
    // The quote strip renders the company name only; nothing else does.
    expect(container.textContent).not.toContain("NVIDIA Corporation");
    // The rail link is gone (the queue's own "Pending approvals"
    // headings are its content, not the rail — assert the link).
    expect(railLink()).toBeNull();
    // What stays: the Tabs bar, the page title, the queue itself.
    expect(tabLabels()).toEqual(["Stock order", "Options order", "Risk analysis", "Approvals", "NLQ & Guarantee"]);
    expect(container.textContent).toContain("Order Ticket");
    expect(container.textContent).toContain("Proposed orders awaiting human authorization");
    expect(container.textContent).toContain("BUY 10 × NVDA");
  });

  it("a seed landing on approvals does not yank the tab to an asset tab", async () => {
    await renderPanel("approvals");
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("approvals");
    await act(async () => {
      (container.querySelector('[data-testid="flip-asset"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("approvals");
    const approvalsPanel = document.getElementById("order-ticket-panel-approvals");
    expect(approvalsPanel).not.toBeNull();
    expect(approvalsPanel!.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Proposed orders awaiting human authorization");
  });
});

describe("order cards leave the NLQ & Guarantee sub-tab (issue 4628)", () => {
  it("hides the ticket, the quote strip and the rail — the NLQ cards stay", async () => {
    await renderPanel("nlq-guarantee");
    const panel = assetPanel();
    expect(panel).not.toBeNull();
    expect(panel!.hasAttribute("hidden")).toBe(true);
    expect(panel!.style.display).toBe("none");
    expect(container.textContent).not.toContain("NVIDIA Corporation");
    expect(railLink()).toBeNull();
    expect(tabLabels()).toEqual(["Stock order", "Options order", "Risk analysis", "Approvals", "NLQ & Guarantee"]);
    expect(container.textContent).toContain("Order Ticket");
    expect(container.textContent).toContain("Agentic HITL Safety Guarantee");
    expect(container.textContent).toContain("NLQ Voice & Text Prompts");
  });

  it("a seed landing on NLQ & Guarantee does not yank the tab to an asset tab", async () => {
    await renderPanel("nlq-guarantee");
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("nlq-guarantee");
    await act(async () => {
      (container.querySelector('[data-testid="flip-asset"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("nlq-guarantee");
    const nlqPanel = document.getElementById("order-ticket-panel-nlq-guarantee");
    expect(nlqPanel).not.toBeNull();
    expect(nlqPanel!.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Agentic HITL Safety Guarantee");
  });
});

describe("order cards stay on the asset tabs (issue 4628)", () => {
  it("stock tab: ticket visible, quote strip and rail present", async () => {
    await renderPanel("stock");
    const panel = assetPanel();
    expect(panel).not.toBeNull();
    expect(panel!.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Equity / ETF Order Ticket");
    expect(container.textContent).toContain("NVIDIA Corporation");
    expect(railLink()).not.toBeNull();
  });

  it("options tab: ticket visible, quote strip and rail present", async () => {
    await renderPanel("options", { initialAsset: "options", initialContext: OPTIONS_CONTEXT });
    const panel = assetPanel();
    expect(panel).not.toBeNull();
    expect(panel!.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Options Order Ticket");
    expect(container.textContent).toContain("NVIDIA Corporation");
    expect(railLink()).not.toBeNull();
  });

  it("a seed landing on an asset tab still follows the asset class", async () => {
    await renderPanel("stock");
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("stock");
    await act(async () => {
      (container.querySelector('[data-testid="flip-asset"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("options");
  });
});

describe("source pin: the asset-only gates (issue 4628)", () => {
  it("gates the ticket panel, the quote strip and the rail to the asset tabs", () => {
    // Single-line assertions: OrderTicketPanel.tsx is CRLF, so no
    // multi-line string match is attempted here.
    const ticket = readFileSync("src/client/OrderTicketPanel.tsx", "utf8");
    expect(ticket).toContain('active={activeTab === "stock" || activeTab === "options"}');
    expect(ticket).toContain('(activeTab === "stock" || activeTab === "options") && orderQuote');
    expect(ticket).toContain('(activeTab === "stock" || activeTab === "options") ? (');
    expect(ticket).toContain('activeTabRef.current === "risk"');
    expect(ticket).toContain('activeTabRef.current === "approvals"');
    expect(ticket).toContain('activeTabRef.current === "nlq-guarantee"');
    expect(ticket).not.toContain('active={activeTab !== "risk"}');
    expect(ticket).not.toContain('activeTab !== "risk" && orderQuote');
  });
});
