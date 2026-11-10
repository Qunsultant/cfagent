/**
 * Issue #3937: the cancel engine over a neutral platform adapter.
 *
 * Cancel-all / cancel-ticker ran only on the Alpaca service port
 * (createCancelBrokerPort), so any other broker was refused by name in
 * the route. The same engine now runs over a platform port built from
 * the broker's own adapter — list via getOrderHistory, cancel via
 * cancelOrderRemote — with the Alpaca path untouched (its bracket-leg
 * semantics live in the Alpaca row shape, not in the neutral one).
 * No test moves funds: the platform is in-memory.
 */
import { describe, it, expect } from "vitest";
import {
  cancelAllOrders,
  cancelSingleOrder,
  cancelTickerOrders,
  createPlatformCancelPort,
  recordScopedCancelOutcome,
} from "../src/services/orderCancellation";
import { createInMemoryCancelPreviewStore } from "../src/services/cancelPreviewStore";
import { resolveTradingLimits } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";
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

interface FakePlatform {
  orders: Map<string, BrokerRemoteOrder>;
  cancelled: string[];
  getOrderHistory: (status: "open" | "closed" | "all") => Promise<BrokerRemoteOrder[]>;
  cancelOrderRemote: (orderId: string | number) => Promise<{ success: boolean; orderId: string; message: string; timestamp: string }>;
}

function fakePlatform(initial: BrokerRemoteOrder[], refuseIds: string[] = []): FakePlatform {
  const orders = new Map(initial.map((o) => [String(o.orderId), { ...o }]));
  const cancelled: string[] = [];
  return {
    orders,
    cancelled,
    async getOrderHistory(status: "open" | "closed" | "all") {
      const rows = [...orders.values()];
      if (status === "all") return rows;
      if (status === "closed") return rows.filter((o) => o.status !== "OPEN" && o.status !== "INDIVIDUAL_FILLS");
      return rows.filter((o) => o.status === "OPEN" || o.status === "INDIVIDUAL_FILLS");
    },
    async cancelOrderRemote(orderId: string | number) {
      const id = String(orderId);
      const found = orders.get(id);
      if (!found) {
        return { success: false, orderId: id, message: "order not found", timestamp: new Date().toISOString() };
      }
      if (refuseIds.includes(id)) {
        return { success: false, orderId: id, message: "insufficient qty available", timestamp: new Date().toISOString() };
      }
      found.status = "CANCELLED";
      cancelled.push(id);
      return { success: true, orderId: id, message: `Order ${id} cancelled.`, timestamp: new Date().toISOString() };
    },
  };
}

function limitsWith(cancelMaxCount: number | null) {
  const values: Record<string, string> = {};
  if (cancelMaxCount !== null) values["trading:limits"] = JSON.stringify({ cancelMaxCount });
  return resolveTradingLimits({ readSetting: (key) => values[key] ?? null });
}

describe("the cancel engine over a platform port (#3937)", () => {
  it("cancel-ticker lists, then cancels, every open order for the symbol", async () => {
    const platform = fakePlatform([
      remoteOrder(1),
      remoteOrder(2, { priceType: "MARKET" }),
      remoteOrder(3, { symbol: "MSFT" }),
      remoteOrder(4, { status: "EXECUTED" }),
    ]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "aapl" });
    expect(receipt.success).toBe(true);
    expect(receipt.targeted).toBe(2);
    expect(receipt.cancelled.map((e) => e.orderId).sort()).toEqual(["1", "2"]);
    expect(receipt.cancelled[0]).toMatchObject({ symbol: "AAPL", statusBefore: "OPEN", statusAfter: "cancelled" });
    expect(platform.cancelled.sort()).toEqual(["1", "2"]);
    expect(platform.orders.get("3")?.status).toBe("OPEN");
    expect(platform.orders.get("4")?.status).toBe("EXECUTED");
  });

  it("cancel-ticker honours the class filter through the price type", async () => {
    const platform = fakePlatform([
      remoteOrder(1, { priceType: "LIMIT" }),
      remoteOrder(2, { priceType: "MARKET" }),
    ]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "AAPL", orderClass: "limit" });
    expect(receipt.targeted).toBe(1);
    expect(receipt.cancelled.map((e) => e.orderId)).toEqual(["1"]);
    expect(platform.cancelled).toEqual(["1"]);
  });

  it("cancel-ticker dry run cancels nothing", async () => {
    const platform = fakePlatform([remoteOrder(1), remoteOrder(2)]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "AAPL", dryRun: true });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.targeted).toBe(2);
    expect(platform.cancelled).toEqual([]);
  });

  it("cancel-ticker itemises a partial refusal with the broker's message", async () => {
    const platform = fakePlatform([remoteOrder(1), remoteOrder(2), remoteOrder(3)], ["2"]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "AAPL" });
    expect(receipt.success).toBe(false);
    expect(receipt.cancelled.map((e) => e.orderId).sort()).toEqual(["1", "3"]);
    expect(receipt.refused).toHaveLength(1);
    expect(receipt.refused[0]).toMatchObject({ orderId: "2", code: "cancel_failed" });
    expect(receipt.refused[0].message).toContain("insufficient qty");
  });

  it("cancel-single cancels one order and verifies the broker's post-cancel state", async () => {
    const platform = fakePlatform([remoteOrder(1)]);
    const receipt = await cancelSingleOrder(createPlatformCancelPort(platform as never), { orderId: "1" });
    expect(receipt.success).toBe(true);
    expect(receipt.target).toMatchObject({ orderId: "1", statusBefore: "OPEN", statusAfter: "cancelled", cancelled: true });
  });

  it("cancel-single refuses a terminal order without sending a cancel", async () => {
    const platform = fakePlatform([remoteOrder(1, { status: "EXECUTED" })]);
    const receipt = await cancelSingleOrder(createPlatformCancelPort(platform as never), { orderId: "1" });
    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("cancel_not_possible");
    expect(platform.cancelled).toEqual([]);
  });

  it("cancel-all previews, then cancels on the token, and refuses a replay", async () => {
    const platform = fakePlatform([remoteOrder(1), remoteOrder(2), remoteOrder(3, { symbol: "MSFT" })]);
    const port = createPlatformCancelPort(platform as never);
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(port, { limits: limitsWith(10) }, store);
    expect(preview.code).toBe("cancel_all_needs_preview");
    expect(preview.preview?.count).toBe(3);
    expect(preview.previewToken).toBeTruthy();
    expect(platform.cancelled).toEqual([]);

    const done = await cancelAllOrders(port, { token: preview.previewToken, limits: limitsWith(10) }, store);
    expect(done.success).toBe(true);
    expect(done.cancelled.map((e) => e.orderId).sort()).toEqual(["1", "2", "3"]);

    const replay = await cancelAllOrders(port, { token: preview.previewToken, limits: limitsWith(10) }, store);
    expect(replay.success).toBe(false);
    expect(replay.code).toBe("cancel_all_preview_expired");
  });

  it("cancel-all refuses when the cap is not configured", async () => {
    const platform = fakePlatform([remoteOrder(1)]);
    const receipt = await cancelAllOrders(createPlatformCancelPort(platform as never), { limits: limitsWith(null) }, createInMemoryCancelPreviewStore());
    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("limit_not_configured");
    expect(platform.cancelled).toEqual([]);
  });
});

describe("the scoped-cancel ledger names the broker it cancelled on (#3937)", () => {
  it("records the resolved broker and mode, not the Alpaca default", async () => {
    const sql = new MockSqlStorage();
    const platform = fakePlatform([remoteOrder(1), remoteOrder(2)]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "AAPL" });
    recordScopedCancelOutcome(sql, receipt, "broker_orders_cancel_ticker", undefined, "cancel_ticker:test-etrade", {
      broker: "etrade",
      mode: "paper",
    });
    const rows = Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].delivery_json)).toMatchObject({ action: "cancel_ticker", broker: "etrade", mode: "paper" });
  });

  it("defaults to the Alpaca ledger row when no broker is given (the MCP tools)", async () => {
    const sql = new MockSqlStorage();
    const platform = fakePlatform([remoteOrder(1)]);
    const receipt = await cancelTickerOrders(createPlatformCancelPort(platform as never), { symbol: "AAPL" });
    recordScopedCancelOutcome(sql, receipt, "alpaca_cancel_ticker", { ALPACA_TRADING_TYPE: "paper" } as any, "cancel_ticker:test-default");
    const rows = Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].delivery_json)).toMatchObject({ action: "cancel_ticker", broker: "alpaca", mode: "paper" });
  });
});
