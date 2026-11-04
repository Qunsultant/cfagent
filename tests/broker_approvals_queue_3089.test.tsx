/** @vitest-environment jsdom */
/**
 * Issue #3089 (S3): every approval-facing surface names the broker.
 *
 * The queue used to render drafts with no broker anywhere. Now each
 * row shows the stored draft's broker (legacy rows without one read
 * as E*TRADE), the approve dialog titles the broker ("Approve order
 * at Alpaca"), and the result notice names it. The queue fetches and
 * executes through the broker-routed endpoints.
 *
 * Harness follows tests/trading_approvals_queue.test.tsx: jsdom
 * render, stubbed global fetch, portal dialog content on
 * document.body.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: null,
    previewNotes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockBrokerOrders(lists: Array<Record<string, unknown>[]>) {
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
      return { ok: true, status: 200, json: async () => ({ status: "executed" }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function buttonByText(text: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | null;
}

describe("Broker-named approvals (#3089)", () => {
  it("rows show the stored broker, legacy rows read as E*TRADE", async () => {
    mockBrokerOrders([[
      trade({ id: "alp-1", broker: "alpaca" }),
      trade({ id: "old-1", symbol: "AMD" }),
    ]]);
    await render(<TradingApprovalsQueue />);
    const text = container.textContent || "";
    expect(text).toContain("Alpaca");
    expect(text).toContain("E*TRADE");
  });

  it("approve dialog titles the broker and executes through the broker route", async () => {
    const { calls } = mockBrokerOrders([[trade({ id: "alp-1", broker: "alpaca" })], []]);
    await render(<TradingApprovalsQueue />);
    await act(async () => {
      buttonByText("Approve")!.click();
    });
    await flush();
    const dialogText = document.body.textContent || "";
    expect(dialogText).toContain("Approve order at Alpaca");
    await act(async () => {
      buttonByText("Approve and place order")!.click();
    });
    await flush();
    const execute = calls.find((c) => c.url.includes("/broker/order/execute"));
    expect(execute).toBeDefined();
    expect(execute!.body).toMatchObject({ orderId: "alp-1", decision: "approved" });
    expect(container.textContent || "").toContain("approved at Alpaca");
  });
});
