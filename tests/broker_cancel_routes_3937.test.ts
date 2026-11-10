/**
 * Issue #3937: cancel-ticker / cancel-all serve the SELECTED broker.
 *
 * Until #3937 the two neutral routes refused any broker !== "alpaca" by
 * name, even though the E*TRADE adapter can list its open orders and
 * cancel them. These tests pin the per-broker route: the selected broker
 * serves the cancel through the same engine, a broker without the
 * orderCancel capability is refused by name, and a broker whose adapter
 * omits a method the engine needs answers with the not-implemented code
 * (never provider_unsupported). The Alpaca path is unchanged — its
 * service port (bracket-leg semantics) still serves it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "etrade" as "etrade" | "alpaca" }));
const alpacaPort = vi.hoisted(() => ({ current: null as any }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

vi.mock("../src/services/orderCancellation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/orderCancellation")>();
  return { ...actual, createCancelBrokerPort: () => alpacaPort.current };
});

import { handleBrokerOrderRoutes, type BrokerOrderRouteContext } from "../src/agents/routes/brokerOrders";
import { TradingPlatformRegistry, BROKER_CATALOG } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";
import { stubBroker, simpleOrder } from "./cancelTestPort";
import type { BrokerRemoteOrder } from "../src/types";

function remoteOrder(orderId: number, overrides: Partial<BrokerRemoteOrder> = {}): BrokerRemoteOrder {
  return {
    orderId,
    orderType: "EQ",
    status: "OPEN",
    orderAction: "BUY",
    quantity: 10,
    symbol: "AAPL",
    priceType: "LIMIT",
    placedTime: 1780000000000,
    ...overrides,
  };
}

function etradePlatform(initial: BrokerRemoteOrder[]) {
  const orders = new Map(initial.map((o) => [String(o.orderId), { ...o }]));
  const cancelled: string[] = [];
  return {
    orders,
    cancelled,
    platformId: "etrade",
    name: "E*TRADE",
    async getOrderHistory(status: "open" | "closed" | "all") {
      const rows = [...orders.values()];
      if (status === "all") return rows;
      if (status === "closed") return rows.filter((o) => o.status !== "OPEN" && o.status !== "INDIVIDUAL_FILLS");
      return rows.filter((o) => o.status === "OPEN" || o.status === "INDIVIDUAL_FILLS");
    },
    async cancelOrderRemote(orderId: string | number) {
      const id = String(orderId);
      const found = orders.get(id);
      if (!found) return { success: false, orderId: id, message: "order not found", timestamp: new Date().toISOString() };
      found.status = "CANCELLED";
      cancelled.push(id);
      return { success: true, orderId: id, message: `Order ${id} cancelled.`, timestamp: new Date().toISOString() };
    },
  };
}

function baseCtx(sql: MockSqlStorage): BrokerOrderRouteContext {
  return {
    env: {} as any,
    getOrm: () => ({ trades: { findMany: () => [] }, getSql: () => sql }) as any,
    readSettingRaw: (key: string) => (key === "trading:limits" ? JSON.stringify({ cancelMaxCount: 10 }) : null),
    audit: vi.fn(),
    getScreenerAgent: () => ({}) as any,
    persistScreenerReportCanonical: vi.fn(),
    evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as any,
    getAutopilotState: () => ({ running: false }),
    incrementAutopilotOrdersToday: vi.fn(),
    schedule: async () => ({ id: "sched-1" }) as any,
    cancelSchedule: async () => true,
  } as BrokerOrderRouteContext;
}

const req = (method: string, path: string, body?: unknown, login = "alice") =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function call(path: string, body: unknown, sql: MockSqlStorage) {
  return handleBrokerOrderRoutes(req("POST", path, body), urlOf(path), path, "alice", baseCtx(sql));
}

beforeEach(() => {
  tenant.broker = "etrade";
  alpacaPort.current = null;
});

describe("cancel-ticker serves the selected broker (#3937)", () => {
  it("cancels the E*TRADE open orders for the symbol, and records the etrade ledger row", async () => {
    const platform = etradePlatform([
      remoteOrder(1),
      remoteOrder(2, { priceType: "MARKET" }),
      remoteOrder(3, { symbol: "MSFT" }),
    ]);
    TradingPlatformRegistry.register("etrade", () => platform as any);
    const sql = new MockSqlStorage();
    const res = await call("/broker/orders/cancel-ticker", { symbol: "AAPL" }, sql);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.cancelled.map((e: any) => e.orderId).sort()).toEqual(["1", "2"]);
    expect(platform.cancelled.sort()).toEqual(["1", "2"]);
    expect(platform.orders.get("3")?.status).toBe("OPEN");
    const rows = Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].delivery_json)).toMatchObject({ action: "cancel_ticker", broker: "etrade", mode: "paper" });
  });

  it("still serves Alpaca through its service port", async () => {
    tenant.broker = "alpaca";
    alpacaPort.current = stubBroker([
      simpleOrder({ id: "a1", symbol: "AAPL" }),
      simpleOrder({ id: "a2", symbol: "AAPL" }),
    ]);
    const sql = new MockSqlStorage();
    const res = await call("/broker/orders/cancel-ticker", { symbol: "AAPL" }, sql);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.cancelled.map((e: any) => e.orderId).sort()).toEqual(["a1", "a2"]);
    const rows = Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
    expect(JSON.parse(rows[0].delivery_json)).toMatchObject({ broker: "alpaca" });
  });

  it("refuses by name a broker whose catalog says no orderCancel", async () => {
    const original = BROKER_CATALOG.etrade.supports.orderCancel;
    try {
      (BROKER_CATALOG.etrade.supports as { orderCancel: boolean }).orderCancel = false;
      const platform = etradePlatform([remoteOrder(1)]);
      TradingPlatformRegistry.register("etrade", () => platform as any);
      const res = await call("/broker/orders/cancel-ticker", { symbol: "AAPL" }, new MockSqlStorage());
      expect(res!.status).toBe(501);
      const body = await res!.json();
      expect(body).toMatchObject({ code: "provider_unsupported", broker: "etrade" });
      expect(platform.cancelled).toEqual([]);
    } finally {
      (BROKER_CATALOG.etrade.supports as { orderCancel: boolean }).orderCancel = original;
    }
  });

  it("answers the not-implemented code when the adapter omits getOrderHistory", async () => {
    TradingPlatformRegistry.register("etrade", () => ({ platformId: "etrade", cancelOrderRemote: async () => ({}) }) as any);
    const res = await call("/broker/orders/cancel-ticker", { symbol: "AAPL" }, new MockSqlStorage());
    expect(res!.status).toBe(501);
    expect((await res!.json()).code).toBe("BROKER_CAPABILITY_NOT_IMPLEMENTED");
  });
});

describe("cancel-all serves the selected broker (#3937)", () => {
  it("previews, then cancels on the token, for E*TRADE", async () => {
    const platform = etradePlatform([remoteOrder(1), remoteOrder(2), remoteOrder(3, { symbol: "MSFT" })]);
    TradingPlatformRegistry.register("etrade", () => platform as any);
    const sql = new MockSqlStorage();
    const previewRes = await call("/broker/orders/cancel-all", {}, sql);
    expect(previewRes!.status).toBe(409);
    const preview = await previewRes!.json();
    expect(preview.code).toBe("cancel_all_needs_preview");
    expect(preview.preview.count).toBe(3);
    expect(preview.previewToken).toBeTruthy();
    expect(platform.cancelled).toEqual([]);

    const doneRes = await call("/broker/orders/cancel-all", { confirm: preview.previewToken }, sql);
    expect(doneRes!.status).toBe(200);
    const done = await doneRes!.json();
    expect(done.success).toBe(true);
    expect(done.cancelled.map((e: any) => e.orderId).sort()).toEqual(["1", "2", "3"]);

    const replayRes = await call("/broker/orders/cancel-all", { confirm: preview.previewToken }, sql);
    expect((await replayRes!.json()).code).toBe("cancel_all_preview_expired");
  });

  it("still previews for Alpaca through its service port", async () => {
    tenant.broker = "alpaca";
    alpacaPort.current = stubBroker([simpleOrder({ id: "a1", symbol: "AAPL" })]);
    const sql = new MockSqlStorage();
    const res = await call("/broker/orders/cancel-all", {}, sql);
    const body = await res!.json();
    expect(body.code).toBe("cancel_all_needs_preview");
    expect(body.preview.count).toBe(1);
  });
});
