/**
 * Issue #3937: the neutral cancel vocabulary over broker remote orders.
 *
 * The cancel engine reasons about CancelableOrder rows. Until #3937 it only
 * knew the Alpaca row shape (mapAlpacaOrderRow/List); a broker that serves
 * its orders through the neutral ITradingPlatform seam (getOrderHistory)
 * had no mapping, so cancel-all / cancel-ticker could not run on it.
 * These tests pin the remote-order mapping: the broker's own status words
 * classify open / terminal / unknown, the order type comes from the
 * broker's price type (E*TRADE's orderType is the security type, EQ),
 * and a remote order is always a simple single order — no legs are ever
 * inferred.
 */
import { describe, it, expect } from "vitest";
import {
  mapBrokerRemoteOrderRow,
  mapBrokerRemoteOrderList,
} from "../src/trading/cancelFilters";
import type { BrokerRemoteOrder } from "../src/types";

function remoteOrder(overrides: Partial<BrokerRemoteOrder> = {}): BrokerRemoteOrder {
  return {
    orderId: 12345,
    orderType: "EQ",
    status: "OPEN",
    orderAction: "BUY",
    quantity: 10,
    symbol: "AAPL",
    priceType: "LIMIT",
    limitPrice: 340,
    placedTime: 1780000000000,
    orderValue: 3400,
    ...overrides,
  };
}

describe("mapBrokerRemoteOrderRow (#3937)", () => {
  it("maps an open limit order onto the neutral cancel record", () => {
    const mapped = mapBrokerRemoteOrderRow(remoteOrder());
    expect(mapped).toMatchObject({
      orderId: "12345",
      symbol: "AAPL",
      side: "buy",
      brokerOrderClass: "simple",
      cancelClass: "limit",
      orderType: "limit",
      rawStatus: "OPEN",
      status: "open",
      clientOrderId: null,
      ladderId: null,
      legIds: [],
      role: "single",
      parentId: null,
      placedAt: 1780000000000,
      quantity: 10,
      notional: 3400,
    });
  });

  it("derives the side from the broker's order action", () => {
    expect(mapBrokerRemoteOrderRow(remoteOrder({ orderAction: "SELL" })).side).toBe("sell");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ orderAction: "BUY_TO_COVER" })).side).toBe("buy");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ orderAction: "SELL_SHORT" })).side).toBe("sell");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ orderAction: "HOLD" })).side).toBe("unknown");
  });

  it("derives the cancel class from the price type, not the security type", () => {
    expect(mapBrokerRemoteOrderRow(remoteOrder({ priceType: "MARKET" })).cancelClass).toBe("market");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ priceType: "STOP" })).cancelClass).toBe("stop");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ priceType: "STOP_LIMIT" })).cancelClass).toBe("stop_limit");
    // No price type: a simple order, never a guessed class.
    expect(mapBrokerRemoteOrderRow(remoteOrder({ priceType: undefined })).cancelClass).toBe("simple");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ priceType: undefined })).orderType).toBe("");
  });

  it("classifies the broker's status words: open, terminal, unknown", () => {
    expect(mapBrokerRemoteOrderRow(remoteOrder({ status: "OPEN" })).status).toBe("open");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ status: "INDIVIDUAL_FILLS" })).status).toBe("open");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ status: "EXECUTED" })).status).toBe("terminal");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ status: "CANCELLED" })).status).toBe("terminal");
    expect(mapBrokerRemoteOrderRow(remoteOrder({ status: "REJECTED" })).status).toBe("terminal");
    const expired = mapBrokerRemoteOrderRow(remoteOrder({ status: "EXPIRED" as BrokerRemoteOrder["status"] }));
    expect(expired.status).toBe("unknown");
    expect(expired.rawStatus).toBe("EXPIRED");
    const unknown = mapBrokerRemoteOrderRow(remoteOrder({ status: "UNKNOWN", rawStatus: "SUSPENDED" }));
    expect(unknown.status).toBe("unknown");
    expect(unknown.rawStatus).toBe("SUSPENDED");
  });

  it("never invents legs, a client order id, or a ladder", () => {
    const mapped = mapBrokerRemoteOrderRow(remoteOrder());
    expect(mapped.legIds).toEqual([]);
    expect(mapped.role).toBe("single");
    expect(mapped.clientOrderId).toBeNull();
    expect(mapped.ladderId).toBeNull();
    expect(mapped.parentId).toBeNull();
  });
});

describe("mapBrokerRemoteOrderList (#3937)", () => {
  it("maps a whole list, each row a simple single order", () => {
    const mapped = mapBrokerRemoteOrderList([
      remoteOrder({ orderId: 1 }),
      remoteOrder({ orderId: 2, symbol: "MSFT", status: "EXECUTED" }),
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped.map((o) => o.orderId)).toEqual(["1", "2"]);
    expect(mapped.every((o) => o.role === "single")).toBe(true);
    expect(mapped[1].status).toBe("terminal");
  });
});
