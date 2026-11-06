/**
 * Issue #3359 — account-panel parity.
 *
 * What these tests defend:
 *   1. The catalogue declares the four account-history surfaces per broker, and
 *      the panel contract derives availability from it: Alpaca serves order
 *      history and activity, and does NOT serve alerts or watchlists.
 *   2. Both supported reads are the BROKER's own rows on neutral routes, with
 *      the broker named in the envelope.
 *   3. A broker that cannot serve one gets a coded 501 naming it — never an
 *      empty list that reads as "you have no orders".
 *   4. Alpaca's status vocabulary is mapped totally: an unrecognised status is
 *      UNKNOWN with its raw word carried, never silently OPEN or REJECTED.
 *   5. The panel renders both present surfaces and both named absences.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { handleBrokerReadsRoutes, type BrokerReadsRouteContext } from "../src/agents/routes/brokerReads";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG, brokerSupports } from "../src/trading/brokerCatalog";
import {
  BROKER_PANEL_SURFACES,
  BROKER_UNAVAILABLE_CODE,
  availablePanels,
  panelAvailability,
} from "../src/trading/brokerPanels";
import {
  mapAlpacaActivityRow,
  mapAlpacaOrderHistoryRow,
  mapAlpacaOrderStatus,
} from "../src/trading/alpaca/platform";

const BASE = "https://example.test/api";

function ctx(vars: Record<string, string> = { FEATURE_BROKER_PANEL_CONTRACT: "1" }): BrokerReadsRouteContext {
  return {
    env: { APP_ENV: "TEST", ...vars } as any,
    getOrm: () => undefined,
    readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
  };
}

function req(path: string) {
  const url = new URL(`${BASE}${path}`);
  return { request: new Request(url.toString(), { method: "GET" }), url };
}

const platform = {
  getAccounts: vi.fn(async () => []),
  getPositions: vi.fn(async () => ({ account: {}, positions: [] })),
  getOrderHistory: vi.fn(async (status: string) => [
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
      __status: status,
    },
  ]),
  getAccountActivity: vi.fn(async (type?: string) => [
    {
      activityId: "act-1",
      activityType: "FILL",
      activityDate: 1_700_000_000_000,
      symbol: "AAPL",
      quantity: 2,
      price: 100,
      netAmount: 200,
      __type: type,
    },
  ]),
};

let getPlatform: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tenant.broker = "alpaca";
  vi.clearAllMocks();
  getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(() => platform as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the catalogue declares the account-history surfaces (#3359)", () => {
  it("E*TRADE serves all four through its own routes", () => {
    for (const op of ["orderHistory", "accountActivity", "alerts", "watchlists"] as const) {
      expect(brokerSupports("etrade", op), op).toBe(true);
    }
  });

  it("Alpaca serves history, activity and its own watchlists, and declares the one it does not", () => {
    expect(brokerSupports("alpaca", "orderHistory")).toBe(true);
    expect(brokerSupports("alpaca", "accountActivity")).toBe(true);
    expect(brokerSupports("alpaca", "alerts")).toBe(false);
    // Issue #3434: Alpaca serves GET /v2/watchlists, so the declared absence
    // this test used to pin is no longer true.
    expect(brokerSupports("alpaca", "watchlists")).toBe(true);
  });

  it("the panel contract turns those declarations into availability, not a second list", () => {
    expect(availablePanels("alpaca")).toEqual([
      "accounts",
      "positions",
      "orders",
      "orderHistory",
      "activity",
      "watchlists",
      "options",
    ]);
    expect(availablePanels("etrade")).toEqual([...BROKER_PANEL_SURFACES]);
  });

  it("names the absence with the shared code and the broker's own name", () => {
    const alerts = panelAvailability("alpaca", "alerts");
    expect(alerts.available).toBe(false);
    expect(alerts.code).toBe(BROKER_UNAVAILABLE_CODE);
    expect(alerts.message).toContain("Alpaca");
    expect(alerts.message).toContain("alerts");
  });
});

describe("Alpaca's own vocabulary is mapped totally (#3359)", () => {
  it("maps every documented status class, and refuses to guess the rest", () => {
    for (const status of ["new", "accepted", "pending_new", "held", "pending_cancel"]) {
      expect(mapAlpacaOrderStatus(status), status).toBe("OPEN");
    }
    expect(mapAlpacaOrderStatus("filled")).toBe("EXECUTED");
    expect(mapAlpacaOrderStatus("partially_filled")).toBe("INDIVIDUAL_FILLS");
    expect(mapAlpacaOrderStatus("canceled")).toBe("CANCELLED");
    expect(mapAlpacaOrderStatus("expired")).toBe("CANCELLED");
    expect(mapAlpacaOrderStatus("rejected")).toBe("REJECTED");
    // Not modelled by the platform: stated as unknown, with the raw word kept.
    expect(mapAlpacaOrderStatus("suspended")).toBe("UNKNOWN");
    expect(mapAlpacaOrderStatus(undefined)).toBe("UNKNOWN");
  });

  it("maps an order row without inventing fields it lacks", () => {
    const row = mapAlpacaOrderHistoryRow({
      id: "ord-9",
      symbol: "msft",
      side: "sell",
      qty: "3",
      type: "market",
      status: "filled",
      submitted_at: "2026-11-05T14:30:00Z",
    });
    expect(row).toMatchObject({
      orderId: "ord-9",
      symbol: "MSFT",
      orderAction: "SELL",
      quantity: 3,
      orderType: "market",
      status: "EXECUTED",
      rawStatus: "filled",
    });
    // No limit price on a market order: the field is absent, not zero.
    expect(row.limitPrice).toBeUndefined();
  });

  it("an order without an id is a bad response, not a row", () => {
    expect(() => mapAlpacaOrderHistoryRow({ symbol: "AAPL" })).toThrow(/without an id/);
  });

  it("maps activity rows in Alpaca's own words, dates included", () => {
    const trade = mapAlpacaActivityRow({
      id: "act-1",
      activity_type: "FILL",
      transaction_time: "2026-11-05T14:30:00Z",
      symbol: "aapl",
      qty: "2",
      price: "100.25",
      net_amount: "200.5",
      order_id: "ord-9",
    });
    expect(trade).toMatchObject({
      activityId: "act-1",
      activityType: "FILL",
      symbol: "AAPL",
      quantity: 2,
      price: 100.25,
      netAmount: 200.5,
      orderId: "ord-9",
    });
    expect(trade.activityDate).toBe(Date.parse("2026-11-05T14:30:00Z"));

    const dividend = mapAlpacaActivityRow({
      id: "act-2",
      activity_type: "DIV",
      date: "2026-11-01",
      net_amount: "1.20",
    });
    expect(dividend.activityType).toBe("DIV");
    expect(dividend.quantity).toBeUndefined();
  });
});

describe("the neutral history reads (#3359)", () => {
  it("serves the broker's own order history and names the broker", async () => {
    const { request, url } = req("/broker/orders/history?status=all");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();

    expect(res!.status).toBe(200);
    expect(body.broker).toBe("alpaca");
    expect(body.status).toBe("all");
    expect(body.orders[0].orderId).toBe("ord-1");
    expect(platform.getOrderHistory).toHaveBeenCalledWith("all");
  });

  it("defaults to open and refuses an unknown status word instead of passing it on", async () => {
    const fallback = req("/broker/orders/history");
    await handleBrokerReadsRoutes(fallback.request, fallback.url, fallback.url.pathname, "sid", ctx());

    const bogus = req("/broker/orders/history?status=everything");
    await handleBrokerReadsRoutes(bogus.request, bogus.url, bogus.url.pathname, "sid", ctx());

    expect(platform.getOrderHistory).toHaveBeenNthCalledWith(1, "open");
    expect(platform.getOrderHistory).toHaveBeenNthCalledWith(2, "open");
  });

  it("serves the broker's own account activity", async () => {
    const { request, url } = req("/broker/activities");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();

    expect(res!.status).toBe(200);
    expect(body.broker).toBe("alpaca");
    expect(body.activities[0].activityType).toBe("FILL");
  });

  it("passes an activity type through when the caller asks for one", async () => {
    const { request, url } = req("/broker/activities?type=div");
    await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(platform.getAccountActivity).toHaveBeenCalledWith("div");
  });

  it("refuses by name when the catalogue says the broker has no history", async () => {
    const original = BROKER_CATALOG.alpaca.supports.orderHistory;
    try {
      (BROKER_CATALOG.alpaca.supports as { orderHistory: boolean }).orderHistory = false;
      const { request, url } = req("/broker/orders/history");
      const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
      const body = await res!.json();

      expect(res!.status).toBe(501);
      expect(body.code).toBe("provider_unsupported");
      expect(body.message).toContain("alpaca");
      expect(platform.getOrderHistory).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { orderHistory: boolean }).orderHistory = original;
    }
  });

  it("answers a failed history read with a coded 502, never an empty list", async () => {
    platform.getOrderHistory.mockRejectedValueOnce(new Error("Alpaca rejected the account request"));
    const { request, url } = req("/broker/orders/history");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();

    expect(res!.status).toBe(502);
    expect(body.code).toBe("BROKER_ORDER_HISTORY_FAILED");
    expect(body.retryable).toBe(true);
  });

  it("does not capture the stored-draft route", async () => {
    const { request, url } = req("/broker/orders");
    expect(await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
  });
});
