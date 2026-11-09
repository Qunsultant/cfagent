/**
 * Issue #3886 — the neutral cancel filter: order class, side, ladder batch
 * and placement time, resolved once for every cancel path.
 *
 * What these pins defend:
 *   1. Every class matches what it says: a bracket is a bracket (not a limit
 *      order), a simple limit matches `limit`, an OCO leg matches on its own
 *      merits.
 *   2. `ladderId` cancels exactly that ladder's rungs — resolved from the
 *      client order id the ladder itself stamps.
 *   3. A leg whose parent is also targeted is folded out, so one call never
 *      double-cancels a bracket.
 *   4. An unknown class refuses with the accepted set; an empty result is
 *      `no_orders_matched` with the filter echoed, never "cancelled 0".
 *   5. Both multi-order tools accept the same filter, and the engine resolves
 *      it, not the tools.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CANCEL_ORDER_CLASSES,
  describeCancelFilter,
  mapAlpacaOrderList,
  resolveCancelTargets,
} from "../src/trading";
import { cancelTickerOrders } from "../src/services/orderCancellation";
import { stubBroker, simpleOrder } from "./cancelTestPort";

function openOrders() {
  return mapAlpacaOrderList([
    simpleOrder({ id: "plain-limit", type: "limit" }),
    simpleOrder({ id: "plain-market", type: "market" }),
    simpleOrder({ id: "plain-stop", type: "stop" }),
    simpleOrder({ id: "plain-stop-limit", type: "stop_limit" }),
    simpleOrder({
      id: "bracket-parent",
      order_class: "bracket",
      type: "limit",
      legs: [{ id: "bracket-tp" }, { id: "bracket-sl" }],
    }),
    simpleOrder({ id: "bracket-tp", type: "limit", status: "held" }),
    simpleOrder({ id: "bracket-sl", type: "stop", status: "held" }),
    simpleOrder({ id: "oco-parent", order_class: "oco", type: "limit", legs: [{ id: "oco-tp" }, { id: "oco-sl" }] }),
    simpleOrder({ id: "oco-tp", type: "limit", status: "held" }),
    simpleOrder({ id: "oco-sl", type: "stop_limit", status: "held" }),
    simpleOrder({ id: "oto-parent", order_class: "oto", type: "limit", legs: [{ id: "oto-tp" }] }),
    simpleOrder({ id: "oto-tp", type: "limit", status: "held" }),
    simpleOrder({ id: "msft-limit", symbol: "MSFT", type: "limit" }),
    simpleOrder({
      id: "lad_1_aa-r1",
      symbol: "NVDA",
      order_class: "bracket",
      type: "limit",
      client_order_id: "lad_1_aa-r1",
      legs: [{ id: "lad_1_aa-r1-tp" }],
    }),
    simpleOrder({
      id: "lad_1_aa-r2",
      symbol: "NVDA",
      order_class: "bracket",
      type: "limit",
      client_order_id: "lad_1_aa-r2",
      legs: [{ id: "lad_1_aa-r2-tp" }],
    }),
    simpleOrder({ id: "lad_2_bb-r1", symbol: "NVDA", order_class: "bracket", client_order_id: "lad_2_bb-r1" }),
  ]);
}

describe("#3886 — every class matches exactly what it says", () => {
  it("`simple` matches single orders of any type and no compound parent", () => {
    const resolved = resolveCancelTargets(openOrders(), { orderClass: "simple" });
    expect(resolved.targets.map((t) => t.orderId).sort()).toEqual(
      [
        "bracket-sl",
        "bracket-tp",
        "msft-limit",
        "oco-sl",
        "oco-tp",
        "oto-tp",
        "plain-limit",
        "plain-market",
        "plain-stop",
        "plain-stop-limit",
      ].sort(),
    );
  });

  it("`limit` matches a simple limit order but NOT a bracket whose entry is a limit", () => {
    const resolved = resolveCancelTargets(openOrders(), { orderClass: "limit" });
    expect(resolved.targets.map((t) => t.orderId)).not.toContain("bracket-parent");
    expect(resolved.targets.map((t) => t.orderId)).toContain("plain-limit");
    expect(resolved.targets.every((t) => t.brokerOrderClass === "simple" && t.orderType === "limit")).toBe(true);
  });

  it("each simple type class matches its own type", () => {
    for (const [orderClass, id] of [
      ["market", "plain-market"],
      ["stop", "plain-stop"],
      ["stop_limit", "plain-stop-limit"],
    ] as const) {
      const resolved = resolveCancelTargets(openOrders(), { orderClass });
      expect(resolved.targets.map((t) => t.orderId)).toContain(id);
      expect(resolved.targets.every((t) => t.orderType === orderClass)).toBe(true);
    }
  });

  it("`bracket`, `oco` and `oto` match the compound parent", () => {
    expect(resolveCancelTargets(openOrders(), { orderClass: "bracket" }).targets.map((t) => t.orderId)).toContain(
      "bracket-parent",
    );
    expect(resolveCancelTargets(openOrders(), { orderClass: "oco" }).targets.map((t) => t.orderId)).toEqual([
      "oco-parent",
    ]);
    expect(resolveCancelTargets(openOrders(), { orderClass: "oto" }).targets.map((t) => t.orderId)).toEqual([
      "oto-parent",
    ]);
  });

  it("filters by side", () => {
    const buys = resolveCancelTargets(openOrders(), { orderSide: "buy" });
    expect(buys.matched).toBe(true);
    expect(buys.targets.every((t) => t.side === "buy")).toBe(true);
    expect(resolveCancelTargets(openOrders(), { orderSide: "sell" }).code).toBe("no_orders_matched");
  });

  it("filters by placement time (ISO and epoch), and refuses a bad value", () => {
    const orders = openOrders();
    const iso = resolveCancelTargets(orders, { symbol: "AAPL", placedAfter: "2026-11-09T13:00:00.000Z" });
    expect(iso.matched).toBe(true);
    const future = resolveCancelTargets(orders, { symbol: "AAPL", placedAfter: "2027-01-01T00:00:00.000Z" });
    expect(future.code).toBe("no_orders_matched");
    const epoch = resolveCancelTargets(orders, { symbol: "AAPL", placedAfter: Date.parse("2026-11-09T13:00:00Z") });
    expect(epoch.matched).toBe(true);
    expect(resolveCancelTargets(orders, { placedAfter: "not-a-date" }).code).toBe("invalid_placed_after");
  });
});

describe("#3886 — the ladder filter", () => {
  it("selects exactly one ladder batch's rungs", () => {
    const resolved = resolveCancelTargets(openOrders(), { ladderId: "lad_1_aa" });
    expect(resolved.targets.map((t) => t.orderId).sort()).toEqual(["lad_1_aa-r1", "lad_1_aa-r2"]);
  });

  it("resolves the ladder id from the client order id prefix the ladder stamps", () => {
    const resolved = resolveCancelTargets(openOrders(), { ladderId: "lad_2_bb" });
    expect(resolved.targets.map((t) => t.orderId)).toEqual(["lad_2_bb-r1"]);
  });

  it("the engine cancels only that batch, end to end over the client-order-id prefix", async () => {
    const broker = stubBroker([
      { ...simpleOrder({ id: "r1", symbol: "NVDA", order_class: "bracket", client_order_id: "lad_1_aa-r1" }) },
      { ...simpleOrder({ id: "r2", symbol: "NVDA", order_class: "bracket", client_order_id: "lad_1_aa-r2" }) },
      { ...simpleOrder({ id: "other", symbol: "NVDA", order_class: "bracket", client_order_id: "lad_9_zz-r1" }) },
    ]);
    const receipt = await cancelTickerOrders(broker, { symbol: "NVDA", ladderId: "lad_1_aa" });
    expect(receipt.success).toBe(true);
    expect(broker.cancelled.sort()).toEqual(["r1", "r2"]);
    expect(broker.orders.get("other")?.status).toBe("new");
  });
});

describe("#3886 — legs, folding and refusal", () => {
  it("a leg-only cancel selects the leg alone and leaves the parent out", () => {
    const resolved = resolveCancelTargets(openOrders(), { symbol: "AAPL", orderClass: "limit" });
    const ids = resolved.targets.map((t) => t.orderId);
    expect(ids).toContain("oco-tp");
    expect(ids).not.toContain("oco-parent");
    // A bracket's entry is the parent, so the parent's own limit type does not leak in.
    expect(ids).not.toContain("bracket-parent");
  });

  it("folds a leg out when its parent is targeted in the same call", () => {
    const resolved = resolveCancelTargets(openOrders(), { symbol: "AAPL" });
    const ids = resolved.targets.map((t) => t.orderId);
    expect(ids).toContain("bracket-parent");
    expect(ids).not.toContain("bracket-tp");
    expect(resolved.foldedLegIds.sort()).toEqual(["bracket-sl", "bracket-tp", "oco-sl", "oco-tp", "oto-tp"]);
  });

  it("refuses an unknown class with the accepted set", () => {
    const resolved = resolveCancelTargets(openOrders(), { orderClass: "iceberg" });
    expect(resolved.code).toBe("unknown_order_class");
    expect(resolved.message).toContain("bracket");
    expect(resolved.targets).toEqual([]);
    expect(CANCEL_ORDER_CLASSES).toContain("oco");
  });

  it("refuses an unknown side", () => {
    expect(resolveCancelTargets(openOrders(), { orderSide: "short" }).code).toBe("invalid_order_side");
  });

  it("refuses an empty result with the filter echoed, never 'cancelled 0'", () => {
    const resolved = resolveCancelTargets(openOrders(), { symbol: "TSLA", orderClass: "bracket" });
    expect(resolved.code).toBe("no_orders_matched");
    expect(resolved.message).toContain("symbol=TSLA");
    expect(resolved.message).toContain("orderClass=bracket");
  });

  it("an empty filter means every open order", () => {
    const resolved = resolveCancelTargets(openOrders(), {});
    expect(resolved.matched).toBe(true);
    expect(describeCancelFilter({})).toBe("every open order");
  });
});

describe("#3886 — one vocabulary, two tools", () => {
  it("both multi-order cancel tools declare the shared class enum", () => {
    const source = readFileSync("src/mcps/openaimp/cancelOrderCommands.ts", "utf8");
    expect(source.match(/CANCEL_ORDER_CLASSES/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the resolver lives in the trading boundary, not in a tool", () => {
    const source = readFileSync("src/services/orderCancellation.ts", "utf8");
    expect(source).toContain("resolveCancelTargets(orders, options.filter)");
  });
});
