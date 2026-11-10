/** @vitest-environment jsdom */
/**
 * Issue #3937: the broker panel speaks for the SELECTED broker.
 *
 * What these tests defend:
 *   1. Under broker=etrade the panel renders E*TRADE's label, its own data
 *      (accounts, positions, history, activity, watchlists) and its alerts
 *      through the neutral route — and no Alpaca string anywhere.
 *   2. The default stays alpaca: alerts remain the gate's coded, named
 *      refusal, never another broker's data.
 *
 * Harness: jsdom + a stubbed global fetch, as in
 * tests/alpaca_panel_2853.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlpacaBrokerPanel } from "../src/client/AlpacaBrokerPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function stubFetch(payloads: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(payloads).find((path) => url.includes(path));
      const res = key ? payloads[key] : { status: 404, body: { code: "not_found" } };
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body,
      } as unknown as Response;
    }),
  );
}

const ETRADE_PAYLOADS = {
  "/broker/accounts": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      result: [{ accountId: "et-1", accountKey: "k1", accountDesc: "E*TRADE Paper", accountType: "INDIVIDUAL" }],
    },
  },
  "/broker/positions": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      result: {
        account: { accountId: "et-1", accountKey: "k1", accountDesc: "E*TRADE Paper", accountType: "INDIVIDUAL" },
        positions: [{ symbol: "AAPL", description: "Apple Inc", quantity: 2, pricePaid: 340, costBasis: 680 }],
      },
    },
  },
  "/broker/orders/history": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      status: "all",
      orders: [
        {
          orderId: "o1",
          orderType: "limit",
          status: "OPEN",
          symbol: "AAPL",
          orderAction: "BUY",
          quantity: 10,
          limitPrice: 300,
          placedTime: 1700000000000,
        },
      ],
    },
  },
  "/broker/activities": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      activities: [
        {
          activityId: "a1",
          activityType: "BUY",
          activityDate: 1700000000000,
          symbol: "AAPL",
          quantity: 10,
          price: 300,
          netAmount: 3000,
        },
      ],
    },
  },
  "/broker/watchlists": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      watchlists: [{ watchlistId: "w1", name: "Core", symbols: ["AAPL"] }],
    },
  },
  "/broker/alerts": {
    status: 200,
    body: {
      broker: "etrade",
      environment: "TEST",
      alerts: [{ id: 1, createTime: 1700000000000, subject: "Dividend paid", status: "UNREAD" }],
    },
  },
};

describe("the broker panel speaks for the selected broker (#3937)", () => {
  it("under broker=etrade renders E*TRADE's label, its own data, and its alerts", async () => {
    stubFetch(ETRADE_PAYLOADS);
    await act(async () => {
      root.render(<AlpacaBrokerPanel broker="etrade" />);
    });
    await flush();

    expect(container.querySelector('[data-broker="etrade"]')).toBeTruthy();
    expect(container.textContent).toContain("E*TRADE");
    expect(container.textContent).toContain("E*TRADE Paper");
    expect(container.textContent).toContain("AAPL");
    expect(container.textContent).toContain("Dividend paid");
    expect(container.textContent).toContain("UNREAD");
    expect(container.textContent).toContain("Core");
    // No Alpaca string anywhere: no other broker's label, copy, or refusal.
    expect(container.textContent).not.toContain("Alpaca");
    // The alerts gate allowed the read, so no refusal wrapper renders.
    expect(container.querySelector('[data-broker-surface="alerts"]')).toBeNull();
  });

  it("defaults to alpaca: alerts stay the gate's coded refusal, never another broker's data", async () => {
    stubFetch({
      "/broker/accounts": {
        status: 200,
        body: {
          broker: "alpaca",
          environment: "TEST",
          result: [{ accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" }],
        },
      },
      "/broker/positions": {
        status: 200,
        body: {
          broker: "alpaca",
          environment: "TEST",
          result: {
            account: { accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" },
            positions: [{ symbol: "AAPL", description: "Apple Inc", quantity: 3, pricePaid: 100, costBasis: 300 }],
          },
        },
      },
    });
    await act(async () => {
      root.render(<AlpacaBrokerPanel />);
    });
    await flush();

    expect(container.querySelector('[data-broker="alpaca"]')).toBeTruthy();
    expect(container.textContent).toContain("Alpaca Paper");
    // Alerts are a coded absence for Alpaca: the gate's named refusal, not
    // an empty table and not another broker's alerts.
    expect(container.querySelector('[data-broker-surface="alerts"]')).toBeTruthy();
    expect(container.textContent).toContain("Alerts unavailable on Alpaca");
    expect(container.textContent).not.toContain("Dividend paid");
    expect(container.textContent).not.toContain("E*TRADE");
  });
});
