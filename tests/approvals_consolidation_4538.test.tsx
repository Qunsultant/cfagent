/** @vitest-environment jsdom */
/**
 * Issue #4538: the Pending approvals queue moves into the Approvals
 * page (?tab=approvals) — the ONE canonical home. The Fast Order
 * Ticket's queueRail slot and the Queues page's Trade approvals
 * section carry a link to the Approvals page instead of the queue;
 * the hub's dead import of the queue is removed. The queue content
 * and the approval door are unchanged — the Approvals page renders
 * the same component with the same props.
 *
 * Harness follows tests/order_ticket_page_3088.test.tsx (hub render
 * with ToastProvider, stubbed fetch) and tests/approvals_panel.test.tsx
 * (direct panel renders with a stubbed pending draft).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { ApprovalsPanel } from "../src/client/ApprovalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchCalls: Array<{ url: string; method: string }> = [];

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
  return { ok: true, status: 200, json: async () => body } as any;
}

function mockFetch() {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("/api/etrade/oauth/status")) {
      return okJson({ authenticated: true, environment: "TEST", renewable: true });
    }
    if (url.startsWith("/api/etrade/status")) {
      return okJson({ oauthAuthenticated: true, activeEnvironment: "TEST", environment: "TEST", configured: true, hasApiKey: true });
    }
    if (url.startsWith("/api/etrade/positions")) return okJson({ account: null, positions: [] });
    if (url.startsWith("/api/broker/orders")) return okJson({ trades: [DRAFT] });
    if (url === "/api/trading/reports/pending") return okJson({ pending: [] });
    if (url === "/api/jobs?limit=30") return okJson({ jobs: [] });
    if (url === "/api/ops/dlq/records") return okJson({ records: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
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

async function renderOrderPage(tab: "stock" | "options" | "risk") {
  window.history.pushState(null, "", `?tab=order&orderTab=${tab}`);
  await renderNode(
    <ToastProvider>
      <ETradeTradingHub activeSubTab="order" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  fetchCalls.length = 0;
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

/** The rail link: the anchor inside the "Pending approvals" section — not the left-nav Approvals entry. */
function railLink(): HTMLAnchorElement | null {
  const links = Array.from(container.querySelectorAll('a[href="?tab=approvals"]'));
  return (
    (links.find((a) => {
      const section = a.closest("section");
      return section?.querySelector("h2")?.textContent?.trim() === "Pending approvals";
    }) as HTMLAnchorElement | undefined) ?? null
  );
}

function queueDomMarkersAbsent(expectedHeadings: number) {
  // The queue's description / empty state / refresh button are
  // distinctive; the link section keeps exactly one "Pending
  // approvals" heading (its own title) on the order page, none on
  // the Queues page. NOTE: /api/broker/orders is NOT a queue
  // signal on the hub-rendered order page — the hub itself fetches
  // it for its order history (ETradeTradingHub fetchOrders) — so
  // absence is pinned on DOM markers here, and on the fetch only
  // where the queue was the sole consumer (Queues page).
  const text = container.textContent ?? "";
  expect(text).not.toContain("No pending approvals");
  expect(text).not.toContain("Proposed orders awaiting human authorization");
  expect(text).not.toContain("↻ Refresh");
  const headings = Array.from(container.querySelectorAll("h2, h3, h4")).filter(
    (h) => (h.textContent ?? "").trim() === "Pending approvals",
  );
  expect(headings).toHaveLength(expectedHeadings);
}

describe("Approvals consolidation (issue #4538)", () => {
  it("stock tab: no queue, link to the Approvals page in its place", async () => {
    await renderOrderPage("stock");
    expect(container.textContent).toContain("Equity / ETF Order Ticket");
    queueDomMarkersAbsent(1);
    expect(railLink()).not.toBeNull();
  });

  it("options tab: no queue, link to the Approvals page in its place", async () => {
    await renderOrderPage("options");
    expect(container.textContent).toContain("Options Order Ticket");
    queueDomMarkersAbsent(1);
    expect(railLink()).not.toBeNull();
  });

  it("risk tab: no queue, link to the Approvals page in its place", async () => {
    await renderOrderPage("risk");
    expect(new URLSearchParams(window.location.search).get("orderTab")).toBe("risk");
    queueDomMarkersAbsent(1);
    expect(railLink()).not.toBeNull();
  });

  it("Approvals page parity: refresh, approve/reject, and expiry all present on a pending draft", async () => {
    await renderNode(<ApprovalsPanel />);
    const text = container.textContent ?? "";
    expect(text).toContain("BUY 10 × NVDA");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(buttons).toContain("↻ Refresh");
    expect(buttons).toContain("Approve");
    expect(buttons).toContain("Reject");
    expect(text).toMatch(/expires in \d+m/);
  });

  it("Approvals page parity: empty state when nothing is pending", async () => {
    // Re-stub with no trades: the queue's empty state is part of the parity surface.
    vi.unstubAllGlobals();
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url === "/api/broker/orders") return okJson({ trades: [] });
      if (url === "/api/trading/reports/pending") return okJson({ pending: [] });
      return okJson({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderNode(<ApprovalsPanel />);
    expect(container.textContent).toContain("No pending approvals");
  });

  it("source pin: the queue renders in exactly one place — the Approvals page", () => {
    const ticket = readFileSync("src/client/OrderTicketPanel.tsx", "utf8");
    expect(ticket).not.toContain("TradingApprovalsQueue");
    expect(ticket).toContain("queueRail=");
    expect(ticket).toContain('href="?tab=approvals"');
    // Issue #4574: the Queues page is retired (its DLQ lives on the
    // Schedules dead-letter-queue view); the page file stays, deprecated
    // in place, and carries no queue — the one-home pin for the queue
    // itself lives in tests/schedules_navigation_4574.test.tsx.
    const queues = readFileSync("src/client/QueuesPage.tsx", "utf8");
    expect(queues).toContain("@deprecated");
    expect(queues).not.toContain("TradingApprovalsQueue");
    const hub = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");
    expect(hub).not.toContain("TradingApprovalsQueue");
    const panel = readFileSync("src/client/ApprovalsPanel.tsx", "utf8");
    expect(panel).toContain("<TradingApprovalsQueue />");
  });
});
