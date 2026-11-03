/** @vitest-environment jsdom */
/**
 * Issue #1705 (A3-c): one top-level Approvals surface composing the
 * existing approval queues. Composition only — no queue capability is
 * removed or reimplemented here, and no new decision endpoint is
 * invented: the panel renders TradingApprovalsQueue (#1327) and
 * PendingReviewQueue (#1324) unchanged, each keeping its own loading,
 * decision, and refresh behavior.
 *
 * Harness follows tests/trading_approvals_queue.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed fetch.
 * Source pins follow the #1327 pattern (read the wired files).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "fs";
import { ApprovalsPanel } from "../src/client/ApprovalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function mockFetch(trades: unknown[], pending: unknown[]) {
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    if (url === "/api/etrade/orders") {
      return { ok: true, status: 200, json: async () => ({ trades }) } as any;
    }
    if (url === "/api/trading/reports/pending") {
      return { ok: true, status: 200, json: async () => ({ pending }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
}

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

const HELD = {
  confirmationId: "c-1",
  kind: "screener",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  detail: "Daily screen ready for review",
  artifacts: ["screen.html"],
};

describe("Issue #1705 — Approvals surface composes the existing queues", () => {
  it("renders both queues' empty states under one header", async () => {
    mockFetch([], []);
    await render(<ApprovalsPanel />);
    const text = container.textContent || "";
    expect(text).toContain("Approvals");
    expect(text).toContain("two decidable queues");
    expect(text).toContain("No pending approvals");
    expect(text).toContain("No deliveries awaiting review");
  });

  it("renders a trade draft and a held delivery side by side", async () => {
    mockFetch([DRAFT], [HELD]);
    await render(<ApprovalsPanel />);
    const text = container.textContent || "";
    expect(text).toContain("BUY 10 × NVDA");
    expect(text).toContain("Daily screen ready for review");
    expect(text).toContain("Approve");
  });

  it("source pin: the panel composes both queues and nothing else decides", () => {
    const panel = readFileSync("src/client/ApprovalsPanel.tsx", "utf8");
    expect(panel).toContain('from "./TradingApprovalsQueue"');
    expect(panel).toContain('from "./PendingReviewQueue"');
    expect(panel).toContain("<TradingApprovalsQueue />");
    expect(panel).toContain("<PendingReviewQueue />");
    expect(panel).not.toContain("/api/etrade/order/execute");
    expect(panel).not.toContain("/api/trading/reports/confirm");
  });

  it("source pin: the panel complies with the UX token architecture with no exemption (ADR-0004)", () => {
    const panel = readFileSync("src/client/ApprovalsPanel.tsx", "utf8");
    expect(panel).toContain('from "./components/ui"');
    expect(panel).toContain("<PageShell");
    expect(panel).toContain("<PageSection");
    const gov = JSON.parse(readFileSync("tests/ui_primitives_1337.json", "utf8")) as {
      exemptions: Array<{ path: string; reason: string }>;
    };
    expect(gov.exemptions.find((e) => e.path === "src/client/ApprovalsPanel.tsx")).toBeUndefined();
  });

  it("source pin: the Approvals tab is wired in the nav and the shell", () => {
    // S1 (#1804/#1808): nav entries live in the central route table,
    // now externalized in nav-config.json (issue #2977), and derive
    // into NavigationMenu.
    const data = JSON.parse(readFileSync("src/client/nav-config.json", "utf8")) as {
      routes: { id: string; navEntry?: { label: string } }[];
    };
    const approvals = data.routes.find((r) => r.id === "approvals");
    expect(approvals?.navEntry?.label).toBe("Approvals");
    const nav = readFileSync("src/client/components/NavigationMenu.tsx", "utf8");
    expect(nav).toContain("ROUTES");
    expect(nav).toContain("DEFAULT_VISIBLE_NAV_TABS");
    const chat = readFileSync("src/client/Chat.tsx", "utf8");
    expect(chat).toContain('from "./ApprovalsPanel"');
    expect(chat).toContain('approvals: (');
    expect(chat).toContain("<ApprovalsPanel />");
  });

  it("source pin: the original queue homes are untouched", () => {
    const hub = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");
    expect(hub).toContain("TradingApprovalsQueue");
    const reports = readFileSync("src/client/ReportsPanel.tsx", "utf8");
    expect(reports).toContain("PendingReviewQueue");
  });
});
