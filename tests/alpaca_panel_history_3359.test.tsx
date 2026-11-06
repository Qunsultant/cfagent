/** @vitest-environment jsdom */
/**
 * Issue #3359 — the Alpaca account panel renders the broker's own history and
 * states the two surfaces it does not serve.
 *
 * What these tests defend:
 *   1. Order history and account activity render Alpaca's own rows from the
 *      neutral routes.
 *   2. Alerts and watchlists render the catalogued, coded absence — never an
 *      empty table that would read as "you have none".
 *   3. No request goes to /api/etrade/*.
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

function stubFetch(payloads: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(payloads).find((path) => url.includes(path));
      return {
        ok: true,
        status: 200,
        json: async () => (key ? payloads[key] : {}),
      } as unknown as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ACCOUNTS = {
  broker: "alpaca",
  environment: "TEST",
  result: [{ accountId: "acct-1", accountKey: "acct-1", accountDesc: "Alpaca Paper", accountType: "CASH" }],
};

const POSITIONS = {
  broker: "alpaca",
  environment: "TEST",
  result: { account: ACCOUNTS.result[0], positions: [] },
};

const STATUS = {
  broker: "alpaca",
  environment: "TEST",
  status: { configured: true, apiUrl: "https://paper-api.alpaca.markets" },
};

const HISTORY = {
  broker: "alpaca",
  environment: "TEST",
  status: "all",
  orders: [
    {
      orderId: "ord-1",
      orderType: "limit",
      status: "OPEN",
      rawStatus: "new",
      placedTime: 1_700_000_000_000,
      quantity: 2,
      limitPrice: 101.5,
      symbol: "AAPL",
      orderAction: "BUY",
    },
    {
      orderId: "ord-2",
      orderType: "market",
      status: "UNKNOWN",
      rawStatus: "suspended",
      quantity: 1,
      symbol: "MSFT",
      orderAction: "SELL",
    },
  ],
};

const ACTIVITY = {
  broker: "alpaca",
  environment: "TEST",
  activities: [
    {
      activityId: "act-1",
      activityType: "FILL",
      activityDate: 1_700_000_000_000,
      symbol: "AAPL",
      quantity: 2,
      price: 100.25,
      netAmount: 200.5,
    },
  ],
};

describe("the Alpaca panel shows what Alpaca serves (#3359)", () => {
  it("renders the broker's own order history and activity", async () => {
    const calls = stubFetch({
      "/broker/accounts": ACCOUNTS,
      "/broker/positions": POSITIONS,
      "/broker/status": STATUS,
      "/broker/orders/history": HISTORY,
      "/broker/activities": ACTIVITY,
    });

    act(() => root.render(<AlpacaBrokerPanel activeEnv="TEST" />));
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("Order history");
    expect(text).toContain("AAPL");
    expect(text).toContain("Account activity");
    expect(text).toContain("FILL");
    // An unrecognised broker status keeps the broker's own word.
    expect(text).toContain("UNKNOWN (suspended)");

    expect(calls.some((url) => url.includes("/api/broker/orders/history"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/broker/activities"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/etrade/"))).toBe(false);
  });

  it("names the two surfaces Alpaca does not serve", async () => {
    stubFetch({
      "/broker/accounts": ACCOUNTS,
      "/broker/positions": POSITIONS,
      "/broker/status": STATUS,
      "/broker/orders/history": HISTORY,
      "/broker/activities": ACTIVITY,
      "/broker/watchlists": {
        broker: "alpaca",
        environment: "TEST",
        watchlists: [{ watchlistId: "wl-1", name: "Momentum", symbols: ["NVDA", "AAPL"] }],
      },
    });

    act(() => root.render(<AlpacaBrokerPanel activeEnv="TEST" />));
    await flush();

    // Issue #3434: alerts stay a coded absence; watchlists are now data.
    const absence = container.querySelector('[data-broker-surface="alerts"]');
    expect(absence).not.toBeNull();
    expect(absence!.getAttribute("data-code")).toBe("FAILURE_BROKER_UNAVAILABLE");
    expect(absence!.textContent).toContain("Alpaca");

    const watchlistSection = container.querySelector('[id="section-watchlists"]');
    expect(watchlistSection).not.toBeNull();
    expect(watchlistSection!.textContent).toContain("Momentum");
    expect(watchlistSection!.textContent).toContain("NVDA, AAPL");

    // The absence is not an empty table pretending to be data.
    expect(container.textContent).not.toContain("No Alpaca alerts");
  });

  it("states a failed history read with its code instead of an empty table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/broker/orders/history")) {
          return {
            ok: false,
            status: 502,
            json: async () => ({
              code: "BROKER_ORDER_HISTORY_FAILED",
              message: "The selected broker (alpaca) could not list its orders.",
            }),
          } as unknown as Response;
        }
        if (url.includes("/broker/accounts")) {
          return { ok: true, status: 200, json: async () => ACCOUNTS } as unknown as Response;
        }
        if (url.includes("/broker/positions")) {
          return { ok: true, status: 200, json: async () => POSITIONS } as unknown as Response;
        }
        if (url.includes("/broker/status")) {
          return { ok: true, status: 200, json: async () => STATUS } as unknown as Response;
        }
        if (url.includes("/broker/activities")) {
          return { ok: true, status: 200, json: async () => ACTIVITY } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );

    act(() => root.render(<AlpacaBrokerPanel activeEnv="TEST" />));
    await flush();

    expect(container.textContent).toContain("BROKER_ORDER_HISTORY_FAILED");
    expect(container.textContent).not.toContain("No Alpaca orders");
  });
});
