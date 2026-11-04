/** @vitest-environment jsdom */
/**
 * Issue #1327: TradingAgent order placement is approval-gated by design
 * (preview -> proposal -> 24h wait -> executeApprovedOrder) but the door
 * had no UI. The approvals queue lists proposed orders with authorizer,
 * expiry, and approve/reject actions wired to the EXISTING approval path
 * (POST /broker/order/execute) — the broker-routed approval path (#3089).
 *
 * Data source: GET /etrade/orders (existing, last 50 trades), filtered
 * client-side to status 'previewed'. Expiry is the preview flow's own
 * 15-minute HITL timer: the draft row is created at preview time and the
 * schedule fires 900s later (expireStaleOrderDraft marks it 'expired'),
 * so expiresAt = createdAt + 900s. The server stays authoritative:
 * executing a non-previewed draft 400s, and the list refresh drops
 * decided/expired rows.
 *
 * Pins:
 *  - only previewed drafts render in the pending queue
 *  - approve opens a confirm dialog with the exact order details and
 *    POSTs decision 'approved' to the existing execute route, then
 *    refreshes the list
 *  - reject POSTs decision 'rejected' and refreshes the list
 *  - an expired row shows Expired and disables Approve
 *  - a server refusal surfaces its business message, not a crash
 *  - an empty pending list renders an honest empty state
 *  - ETradeTradingHub wires the queue into the order tab (source pin)
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { TradingApprovalsQueue } from "../src/client/TradingApprovalsQueue";

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

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    symbol: "NVDA",
    action: "BUY",
    orderType: "LIMIT",
    quantity: 10,
    price: 180.5,
    totalValue: 1805,
    status: "previewed",
    orderRef: null,
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: null,
    previewNotes: null,
    expirationScheduleId: "sched-1",
    createdAt: iso(now - 60 * 1000),
    updatedAt: iso(now - 60 * 1000),
    ...overrides,
  };
}

function mockOrders(lists: Array<Record<string, unknown>[]>, executeStatus = 200, executeBody: unknown = { status: "executed" }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let listCalls = 0;
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method || "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, method, body });
    if (url.includes("/broker/orders") && method === "GET") {
      const list = lists[Math.min(listCalls, lists.length - 1)];
      listCalls += 1;
      return { ok: true, status: 200, json: async () => ({ count: list.length, trades: list }) } as any;
    }
    if (url.includes("/broker/order/execute") && method === "POST") {
      return { ok: executeStatus >= 200 && executeStatus < 300, status: executeStatus, json: async () => executeBody } as any;
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

// The confirm dialog renders through a portal into document.body, so
// modal buttons live outside the render container — search the body.
function buttonByText(text: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  ) as HTMLButtonElement | null;
}

describe("Issue #1327 — TradingApprovalsQueue", () => {
  it("renders only previewed drafts in the pending queue", async () => {
    mockOrders([
      [
        trade({ id: "ord-1" }),
        trade({ id: "ord-2", symbol: "AMD", status: "executed" }),
        trade({ id: "ord-3", symbol: "TSM", status: "expired" }),
      ],
    ]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("NVDA");
    expect(text).not.toContain("AMD");
    expect(text).not.toContain("TSM");
  });

  it("approve confirms the exact order then POSTs approved and refreshes", async () => {
    const { calls } = mockOrders([
      [trade({ id: "ord-1" })],
      [],
    ]);
    await render(<TradingApprovalsQueue />);
    await act(async () => {
      buttonByText("Approve")!.click();
    });
    await flush();
    // Confirm dialog shows the exact action/target/content/cost (portal content lives on the body).
    const dialogText = document.body.textContent || "";
    expect(dialogText).toContain("NVDA");
    expect(dialogText).toContain("BUY");
    expect(dialogText).toContain("1805");
    await act(async () => {
      buttonByText("Approve and place order")!.click();
    });
    await flush();
    const execute = calls.find((c) => c.url.includes("/broker/order/execute"));
    expect(execute).toBeDefined();
    expect(execute!.method).toBe("POST");
    expect(execute!.body).toMatchObject({ orderId: "ord-1", decision: "approved" });
    expect(container.textContent || "").toContain("No pending approvals");
  });

  it("reject POSTs rejected and refreshes the list", async () => {
    const { calls } = mockOrders([
      [trade({ id: "ord-1" })],
      [],
    ]);
    await render(<TradingApprovalsQueue />);
    await act(async () => {
      buttonByText("Reject")!.click();
    });
    await flush();
    await act(async () => {
      buttonByText("Reject proposal")!.click();
    });
    await flush();
    const execute = calls.find((c) => c.url.includes("/broker/order/execute"));
    expect(execute).toBeDefined();
    expect(execute!.body).toMatchObject({ orderId: "ord-1", decision: "rejected" });
    expect(container.textContent || "").toContain("No pending approvals");
  });

  it("an expired row shows Expired and disables Approve", async () => {
    mockOrders([
      [trade({ id: "ord-1", createdAt: iso(now - 20 * 60 * 1000) })],
    ]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("Expired");
    expect(buttonByText("Approve")!.disabled).toBe(true);
  });

  it("a server refusal surfaces its business message", async () => {
    mockOrders(
      [[trade({ id: "ord-1" })]],
      400,
      { error: "Order draft 'ord-1' cannot be executed. Current status is 'expired'. Only 'previewed' drafts may be executed." }
    );
    await render(<TradingApprovalsQueue />);
    await act(async () => {
      buttonByText("Approve")!.click();
    });
    await flush();
    await act(async () => {
      buttonByText("Approve and place order")!.click();
    });
    await flush();
    expect(container.textContent || "").toContain("cannot be executed");
  });

  it("an empty pending list renders an honest empty state", async () => {
    mockOrders([[]]);
    await render(<TradingApprovalsQueue />);
    expect(container.textContent || "").toContain("No pending approvals");
  });

  it("ETradeTradingHub wires the queue into the order tab (source pin)", () => {
    const hub = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");
    expect(hub).toContain("TradingApprovalsQueue");
  });

  it("A3-a: card states the approval contract, version, limit bound, and fee note", async () => {
    mockOrders([
      [trade({ id: "ord-1", payloadHash: "abcdef1234567890abcdef1234567890" })],
    ]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("Approval contract");
    expect(text).toContain("Version abcdef123456");
    expect(text).toContain("bounded by this price");
    expect(text).toContain("Commission is not shown here");
  });

  it("A3-a: market order states plainly that price is unbounded", async () => {
    mockOrders([
      [trade({ id: "ord-1", orderType: "MARKET", payloadHash: "abcdef1234567890" })],
    ]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("no price bound");
    expect(text).not.toContain("bounded by this price");
  });

  it("A3-a: strategy legs render from the stored strategy-order-v1 notes", async () => {
    const notes = JSON.stringify({
      kind: "strategy-order-v1",
      optionLegs: [{ securityType: "OPTN" }, { securityType: "EQ" }],
      strategyNetDebit: 1.25,
    });
    mockOrders([[trade({ id: "ord-1", previewNotes: notes })]]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("Multi-leg strategy: 2 legs (1 option, 1 equity)");
    expect(text).toContain("net debit $1.25");
  });

  it("A3-a: approve modal shows the version and that approval cannot be undone", async () => {
    mockOrders([
      [trade({ id: "ord-1", payloadHash: "abcdef1234567890" })],
      [],
    ]);
    await render(<TradingApprovalsQueue />);
    await act(async () => {
      buttonByText("Approve")!.click();
    });
    await flush();
    const dialogText = document.body.textContent || "";
    expect(dialogText).toContain("Version abcdef123456");
    expect(dialogText).toContain("Approval cannot be undone");
  });

  it("A3-a: no version line renders when the server response predates payload versions", async () => {
    mockOrders([[trade({ id: "ord-1" })]]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).not.toContain("Version ");
    expect(text).toContain("Approval contract");
  });
});
