/**
 * Issue #3937: the E*TRADE adapter's account-history reads.
 *
 * The catalog declares etrade supports orderHistory / accountActivity /
 * watchlists / alerts, but the adapter implemented none of them — the
 * neutral reads answered provider_unsupported for data E*TRADE has.
 * These tests pin the adapter methods against a stubbed client (no live
 * broker calls): status filtering is client-side over the normalized
 * neutral status, a failed read throws the client's lastError instead
 * of returning an empty list that would read as "no rows", and no field
 * is invented where the upstream row has none.
 */
import { describe, it, expect } from "vitest";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import type { ETradeRestClient } from "../src/trading/etrade/client";
import type { BrokerRemoteOrder } from "../src/types";

function orderRow(orderId: number, status: string, symbol = "AAPL"): BrokerRemoteOrder {
  return {
    orderId,
    orderType: "EQ",
    status: status as BrokerRemoteOrder["status"],
    orderAction: "BUY",
    quantity: 10,
    symbol,
  };
}

const ALL_STATUSES = [
  orderRow(1, "OPEN"),
  orderRow(2, "INDIVIDUAL_FILLS"),
  orderRow(3, "EXECUTED"),
  orderRow(4, "CANCELLED"),
  orderRow(5, "REJECTED"),
  // E*TRADE's EXPIRED is not in the neutral union: it normalizes to
  // UNKNOWN with the verbatim word kept, and it is terminal, so it
  // belongs to "closed", never to "open".
  orderRow(6, "EXPIRED"),
];

interface FakeClientState {
  orders: BrokerRemoteOrder[];
  transactions: Array<Record<string, unknown>>;
  watchlists: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  lastError: string | undefined;
  seenFetchOrdersParams: Array<Record<string, unknown> | undefined>;
}

function fakeClient(state: FakeClientState): ETradeRestClient {
  return {
    fetchOrders: async (_accountKey?: string, params?: Record<string, unknown>) => {
      state.seenFetchOrdersParams.push(params);
      return state.orders;
    },
    fetchTransactions: async () => state.transactions,
    getWatchlists: async () => state.watchlists,
    fetchAlerts: async () => state.alerts,
    getLastError: () => state.lastError,
  } as unknown as ETradeRestClient;
}

function platformWith(state: FakeClientState): ETradeTradingPlatform {
  return new ETradeTradingPlatform({} as never, undefined, "user-1", "TEST", fakeClient(state));
}

function liveState(): FakeClientState {
  return {
    orders: ALL_STATUSES,
    transactions: [
      { transactionId: "t-1", accountId: "a-1", transactionDate: 1780000000000, amount: -3423.7, description: "Bought 10 AAPL", transactionType: "Buy" },
      { transactionId: "t-2", accountId: "a-1", transactionDate: 1780000001000, amount: 12.5, description: "Dividend", transactionType: "Dividend" },
    ],
    watchlists: [{ watchlistId: "w-1", name: "Core", symbols: ["AAPL", "MSFT"], source: "etrade_api" }],
    alerts: [
      { id: 1, createTime: 1780000000000, subject: "Price alert: AAPL", status: "UNREAD" },
      { id: 2, createTime: 1780000001000, subject: "Order filled", status: "READ" },
    ],
    lastError: undefined,
    seenFetchOrdersParams: [],
  };
}

describe("E*TRADE adapter order history (#3937)", () => {
  it("returns open orders (OPEN + INDIVIDUAL_FILLS) without a server status filter", async () => {
    const state = liveState();
    const platform = platformWith(state);
    const orders = await platform.getOrderHistory("open");
    expect(orders.map((o) => o.orderId)).toEqual([1, 2]);
    // The E*TRADE list API's status filter semantics are not trusted:
    // fetch unfiltered (count-bounded) and filter client-side.
    expect(state.seenFetchOrdersParams[0]?.status).toBeUndefined();
    expect(state.seenFetchOrdersParams[0]?.count).toBe(50);
  });

  it("returns closed orders (EXECUTED + CANCELLED + REJECTED + normalized UNKNOWN)", async () => {
    const platform = platformWith(liveState());
    const orders = await platform.getOrderHistory("closed");
    expect(orders.map((o) => o.orderId)).toEqual([3, 4, 5, 6]);
  });

  it("returns every order for 'all', normalizing an unrecognised status to UNKNOWN with rawStatus kept", async () => {
    const platform = platformWith(liveState());
    const orders = await platform.getOrderHistory("all");
    expect(orders).toHaveLength(6);
    const expired = orders.find((o) => o.orderId === 6)!;
    expect(expired.status).toBe("UNKNOWN");
    expect(expired.rawStatus).toBe("EXPIRED");
    expect(orders.find((o) => o.orderId === 1)!.status).toBe("OPEN");
  });

  it("throws the client's lastError instead of an empty list when the read fails", async () => {
    const state = liveState();
    state.orders = [];
    state.lastError = "E*TRADE consumer credentials are not configured for order requests.";
    const platform = platformWith(state);
    await expect(platform.getOrderHistory("open")).rejects.toThrow("consumer credentials are not configured");
  });

  it("returns an empty list when the broker genuinely has no orders", async () => {
    const state = liveState();
    state.orders = [];
    const platform = platformWith(state);
    await expect(platform.getOrderHistory("open")).resolves.toEqual([]);
  });
});

describe("E*TRADE adapter account activity (#3937)", () => {
  it("maps transactions onto neutral activity rows without inventing fields", async () => {
    const platform = platformWith(liveState());
    const activities = await platform.getAccountActivity();
    expect(activities).toEqual([
      { activityId: "t-1", activityType: "Buy", activityDate: 1780000000000, netAmount: -3423.7 },
      { activityId: "t-2", activityType: "Dividend", activityDate: 1780000001000, netAmount: 12.5 },
    ]);
    // The flat transaction list carries no symbol / quantity / price —
    // none is invented.
    for (const activity of activities) {
      expect(activity).not.toHaveProperty("symbol");
      expect(activity).not.toHaveProperty("quantity");
      expect(activity).not.toHaveProperty("price");
    }
  });

  it("filters by the broker's own activity-type word when one is given", async () => {
    const platform = platformWith(liveState());
    const activities = await platform.getAccountActivity("Dividend");
    expect(activities.map((a) => a.activityId)).toEqual(["t-2"]);
  });

  it("throws the client's lastError instead of an empty list when the read fails", async () => {
    const state = liveState();
    state.transactions = [];
    state.lastError = "E*TRADE consumer credentials are not configured for transaction requests.";
    const platform = platformWith(state);
    await expect(platform.getAccountActivity()).rejects.toThrow("consumer credentials are not configured");
  });

  it("returns an empty list when the broker genuinely has no activity", async () => {
    const state = liveState();
    state.transactions = [];
    const platform = platformWith(state);
    await expect(platform.getAccountActivity()).resolves.toEqual([]);
  });
});

describe("E*TRADE adapter watchlists (#3937)", () => {
  it("returns the broker's watchlists verbatim", async () => {
    const platform = platformWith(liveState());
    await expect(platform.getWatchlists()).resolves.toEqual([
      { watchlistId: "w-1", name: "Core", symbols: ["AAPL", "MSFT"], source: "etrade_api" },
    ]);
  });

  it("throws the client's lastError instead of an empty list when the read fails", async () => {
    const state = liveState();
    state.watchlists = [];
    state.lastError = "E*TRADE consumer credentials are not configured for watchlist requests.";
    const platform = platformWith(state);
    await expect(platform.getWatchlists()).rejects.toThrow("consumer credentials are not configured");
  });

  it("returns an empty list when the broker genuinely has no watchlists", async () => {
    const state = liveState();
    state.watchlists = [];
    const platform = platformWith(state);
    await expect(platform.getWatchlists()).resolves.toEqual([]);
  });
});

describe("E*TRADE adapter alerts (#3937)", () => {
  it("returns the broker's alerts verbatim", async () => {
    const platform = platformWith(liveState());
    await expect(platform.getAlerts()).resolves.toEqual([
      { id: 1, createTime: 1780000000000, subject: "Price alert: AAPL", status: "UNREAD" },
      { id: 2, createTime: 1780000001000, subject: "Order filled", status: "READ" },
    ]);
  });

  it("throws the client's lastError instead of an empty list when the read fails", async () => {
    const state = liveState();
    state.alerts = [];
    state.lastError = "E*TRADE consumer credentials are not configured for alert requests.";
    const platform = platformWith(state);
    await expect(platform.getAlerts()).rejects.toThrow("consumer credentials are not configured");
  });

  it("returns an empty list when the broker genuinely has no alerts", async () => {
    const state = liveState();
    state.alerts = [];
    const platform = platformWith(state);
    await expect(platform.getAlerts()).resolves.toEqual([]);
  });
});
