/**
 * Issue #2853: the neutral account/position reads behind the broker panels.
 *
 * What these tests defend:
 *   1. The SELECTED broker serves the read; the registry is never asked for
 *      another broker.
 *   2. A broker that cannot answer is a coded 501 naming that broker — not an
 *      empty list, not another broker's data.
 *   3. The kill switch is authoritative on the server: OFF answers
 *      FEATURE_DISABLED without touching the broker at all.
 *
 * Harness follows tests/broker_options_routes_3233.test.ts: the handler is
 * called directly, the tenant broker is mocked at its single source, and the
 * platform is a spy on the registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { handleBrokerReadsRoutes, type BrokerReadsRouteContext } from "../src/agents/routes/brokerReads";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";

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
  getAccounts: vi.fn(async () => [{ accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" }]),
  getPositions: vi.fn(async () => ({
    account: { accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" },
    positions: [{ symbol: "AAPL", description: "Apple", quantity: 3, pricePaid: 100, costBasis: 300 }],
  })),
  // Issue #3937: the E*TRADE adapter now implements these; the spy stands
  // in for whichever platform the registry returns.
  getOrderHistory: vi.fn(async () => [{ orderId: 1, orderType: "EQ", status: "OPEN", orderAction: "BUY", quantity: 10, symbol: "AAPL" }]),
  getAccountActivity: vi.fn(async () => [{ activityId: "t-1", activityType: "Buy", activityDate: 1780000000000, netAmount: -3423.7 }]),
  getWatchlists: vi.fn(async () => [{ watchlistId: "w-1", name: "Core", symbols: ["AAPL"], source: "etrade_api" }]),
  getAlerts: vi.fn(async () => [{ id: 1, createTime: 1780000000000, subject: "Price alert: AAPL", status: "UNREAD" }]),
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

describe("the reads do not capture other paths (#2853)", () => {
  it("returns null for a path it does not own", async () => {
    const { request, url } = req("/portfolio/accounts");
    expect(await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("serves GET only", async () => {
    const url = new URL(`${BASE}/broker/accounts`);
    const request = new Request(url.toString(), { method: "POST" });
    expect(await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
  });
});

describe("the selected broker serves the read (#2853)", () => {
  it("returns the selected broker's accounts and names both broker and environment", async () => {
    const { request, url } = req("/broker/accounts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.environment).toBe("TEST");
    expect(body.result).toEqual([expect.objectContaining({ accountDesc: "Alpaca Paper" })]);
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("returns positions with their account", async () => {
    const { request, url } = req("/broker/positions");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();
    expect(body.result.account.accountDesc).toBe("Alpaca Paper");
    expect(body.result.positions[0]).toMatchObject({ symbol: "AAPL", quantity: 3 });
  });

  it("serves E*TRADE when that is the selection", async () => {
    tenant.broker = "etrade";
    const { request, url } = req("/broker/accounts");
    await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx({ FEATURE_BROKER_PANEL_CONTRACT: "1", APP_ENV: "PROD" }));
    expect(getPlatform.mock.calls[0][0]).toBe("etrade");
  });
});

describe("a broker that cannot answer says so (#2853)", () => {
  it("answers 501 provider_unsupported naming the broker when the catalog says no", async () => {
    const original = BROKER_CATALOG.alpaca.supports.accounts;
    try {
      (BROKER_CATALOG.alpaca.supports as { accounts: boolean }).accounts = false;
      const { request, url } = req("/broker/accounts");
      const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(501);
      const body = await res!.json();
      expect(body).toMatchObject({ code: "provider_unsupported", broker: "alpaca", retryable: false });
      expect(body.message).toContain("alpaca");
      expect(body).not.toHaveProperty("result");
      // The platform was never constructed for an unsupported capability.
      expect(getPlatform).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { accounts: boolean }).accounts = original;
    }
  });

  it("answers 501 with the not-implemented code when the platform omits the method at runtime", async () => {
    // Issue #3937: a capability the catalog declares but the platform
    // does not implement is a DISTINCT code from provider_unsupported —
    // "declared but unimplemented" must never be indistinguishable from
    // "genuinely unsupported".
    getPlatform.mockImplementation(() => ({ getAccounts: undefined, getPositions: platform.getPositions }) as any);
    const { request, url } = req("/broker/accounts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    const body = await res!.json();
    expect(body.code).toBe("BROKER_CAPABILITY_NOT_IMPLEMENTED");
    expect(body.broker).toBe("alpaca");
    expect(body.message).toContain("Accounts");
  });
});

describe("the alerts read rides the selected broker (#3937)", () => {
  it("serves E*TRADE alerts through /api/broker/alerts when that is the selection", async () => {
    tenant.broker = "etrade";
    const { request, url } = req("/broker/alerts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("etrade");
    expect(body.alerts).toEqual([expect.objectContaining({ subject: "Price alert: AAPL" })]);
    expect(getPlatform.mock.calls[0][0]).toBe("etrade");
  });

  it("answers 501 provider_unsupported for Alpaca, whose catalog says no alerts", async () => {
    tenant.broker = "alpaca";
    const { request, url } = req("/broker/alerts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    const body = await res!.json();
    expect(body).toMatchObject({ code: "provider_unsupported", broker: "alpaca", retryable: false });
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("answers 501 with the not-implemented code when the platform omits getAlerts", async () => {
    tenant.broker = "etrade";
    getPlatform.mockImplementation(() => ({ getAccounts: platform.getAccounts }) as any);
    const { request, url } = req("/broker/alerts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    expect((await res!.json()).code).toBe("BROKER_CAPABILITY_NOT_IMPLEMENTED");
  });
});

describe("the E*TRADE history reads ride the selected broker (#3937)", () => {
  it("serves order history, activity, and watchlists for the etrade selection", async () => {
    tenant.broker = "etrade";
    for (const [path, key] of [
      ["/broker/orders/history", "orders"],
      ["/broker/activities", "activities"],
      ["/broker/watchlists", "watchlists"],
    ] as const) {
      const { request, url } = req(path);
      const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.broker).toBe("etrade");
      expect(body[key]).toHaveLength(1);
    }
  });
});

describe("the kill switch is authoritative on the server (#2853)", () => {
  it("answers FEATURE_DISABLED without touching the broker when the flag is OFF", async () => {
    const { request, url } = req("/broker/accounts");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx({ FEATURE_BROKER_PANEL_CONTRACT: "0" }));
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body).toMatchObject({ code: "FEATURE_DISABLED", feature: "broker_panel_contract" });
    expect(getPlatform).not.toHaveBeenCalled();
    expect(platform.getAccounts).not.toHaveBeenCalled();
  });

  it("inherits the parent flag when its own is absent", async () => {
    const { request, url } = req("/broker/accounts");
    const res = await handleBrokerReadsRoutes(
      request,
      url,
      url.pathname,
      "sid",
      ctx({ FEATURE_OPTIONS_SCREENER: "1" }),
    );
    expect(res!.status).toBe(200);
  });
});
