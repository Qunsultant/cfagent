/**
 * Order preview body (issue #4573).
 *
 * The body builder is the send boundary: it always carries time-in-force and
 * refuses a broker/type/TIF combination the capability matrix does not list,
 * so an unsupported order can never leave the client even if a UI control
 * were enabled by mistake.
 */
import { describe, it, expect } from "vitest";
import {
  buildOrderPreviewBody,
  orderPreviewRefusalMessage,
  type OrderPreviewInput,
} from "../src/client/trading/orderPreviewBody";

const base: OrderPreviewInput = {
  brokerId: "etrade",
  mode: "paper",
  assetClass: "equity",
  symbol: "nvda",
  orderAction: "BUY",
  quantity: 10,
  orderType: "LIMIT",
  timeInForce: "DAY",
  limitPrice: "125.50",
};

describe("order preview body (#4573)", () => {
  it("carries the order type and the time-in-force", () => {
    const built = buildOrderPreviewBody(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.orderType).toBe("LIMIT");
    expect(built.body.timeInForce).toBe("DAY");
    expect(built.body.symbol).toBe("NVDA");
    expect(built.body.limitPrice).toBe("125.50");
  });

  it("drops the limit price for a market order", () => {
    const built = buildOrderPreviewBody({ ...base, orderType: "MARKET", limitPrice: "125.50" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.limitPrice).toBeUndefined();
  });

  it("scales option legs and the strategy debit by the quantity", () => {
    const built = buildOrderPreviewBody({
      ...base,
      assetClass: "options",
      quantity: 2,
      optionLegs: [{ side: "BUY", quantity: 1, optionType: "CALL", strike: 200, securityType: "OPTN" }],
      strategyNetDebit: 250,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const legs = built.body.optionLegs as { underlyingSymbol: string; quantity: number }[];
    expect(legs[0].underlyingSymbol).toBe("NVDA");
    expect(legs[0].quantity).toBe(2);
    expect(built.body.strategyNetDebit).toBe(500);
  });

  it("refuses an order type the broker does not support for the asset class", () => {
    const built = buildOrderPreviewBody({ ...base, assetClass: "options", orderType: "STOP" });
    expect(built).toEqual({ ok: false, reason: "ORDER_TYPE_UNSUPPORTED" });
  });

  it("refuses a time-in-force the broker does not support (Alpaca options)", () => {
    const built = buildOrderPreviewBody({
      ...base,
      brokerId: "alpaca",
      assetClass: "options",
      timeInForce: "IOC",
    });
    expect(built).toEqual({ ok: false, reason: "TIME_IN_FORCE_UNSUPPORTED" });
  });

  it("refuses entirely when the broker has no contract for the menu", () => {
    const built = buildOrderPreviewBody({ ...base, brokerId: "unknown-broker" });
    expect(built).toEqual({ ok: false, reason: "BROKER_UNSUPPORTED" });
  });

  it("names the broker and the boundary in each refusal message", () => {
    expect(orderPreviewRefusalMessage("BROKER_UNSUPPORTED", "Alpaca")).toContain("Alpaca");
    expect(orderPreviewRefusalMessage("ORDER_TYPE_UNSUPPORTED", "Alpaca")).toContain("order type");
    expect(orderPreviewRefusalMessage("TIME_IN_FORCE_UNSUPPORTED", "Alpaca")).toContain("time-in-force");
    for (const reason of ["BROKER_UNSUPPORTED", "ORDER_TYPE_UNSUPPORTED", "TIME_IN_FORCE_UNSUPPORTED"] as const) {
      expect(orderPreviewRefusalMessage(reason, "Alpaca").toLowerCase()).toContain("nothing was sent");
    }
  });
});
