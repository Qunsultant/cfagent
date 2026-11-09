/**
 * Issue #3884 — cancel every open order for one ticker.
 *
 * What these pins defend:
 *   1. It lists the broker's own open orders for the symbol, then cancels
 *      each, returning a per-order receipt.
 *   2. `dryRun` returns the target list and cancels nothing.
 *   3. A partial failure names which orders survived and why.
 *   4. A bracket parent and its legs in one call are not double-cancelled.
 *   5. A symbol with no open orders refuses with `no_orders_matched` naming
 *      the read that established it — never a silent success.
 *   6. The configured cancel cap is honoured; an unset cap does not block a
 *      de-risking ticker cancel (stated asymmetry vs cancel-all).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cancelTickerOrders, recordScopedCancelOutcome } from "../src/services/orderCancellation";
import { resolveTradingLimits } from "../src/trading";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { resolveToolScope } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MockSqlStorage } from "./mock-sql";
import { stubBroker, simpleOrder } from "./cancelTestPort";

function limitsWith(cancelMaxCount: number | null, symbol?: string) {
  const values: Record<string, string> = {};
  if (cancelMaxCount !== null) values["trading:limits"] = JSON.stringify({ cancelMaxCount });
  return resolveTradingLimits({
    symbol,
    readSetting: (key) => values[key] ?? null,
  });
}

describe("#3884 — every open order for one ticker", () => {
  it("lists, then cancels, every open order for the symbol, per-order receipt", async () => {
    const broker = stubBroker([
      simpleOrder({ id: "a1", symbol: "AAPL" }),
      simpleOrder({ id: "a2", symbol: "AAPL", type: "market" }),
      simpleOrder({ id: "m1", symbol: "MSFT" }),
    ]);
    const receipt = await cancelTickerOrders(broker, { symbol: "aapl" });

    expect(receipt.success).toBe(true);
    expect(receipt.action).toBe("cancel_ticker");
    expect(receipt.targeted).toBe(2);
    expect(receipt.cancelled.map((entry) => entry.orderId).sort()).toEqual(["a1", "a2"]);
    expect(receipt.cancelled[0]).toMatchObject({ symbol: "AAPL", statusBefore: "new", statusAfter: "canceled" });
    expect(broker.cancelled.sort()).toEqual(["a1", "a2"]);
    // MSFT was never touched.
    expect(broker.orders.get("m1")?.status).toBe("new");
  });

  it("a dry run returns the target list and cancels nothing", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2" })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL", dryRun: true });

    expect(receipt.dryRun).toBe(true);
    expect(receipt.targeted).toBe(2);
    expect(receipt.planned.map((entry) => entry.orderId).sort()).toEqual(["a1", "a2"]);
    expect(receipt.cancelled).toEqual([]);
    expect(broker.cancelled).toEqual([]);
    expect(receipt.message).toContain("nothing was cancelled");
  });

  it("itemises a partial failure: what survived and why", async () => {
    const broker = stubBroker([
      simpleOrder({ id: "a1" }),
      simpleOrder({ id: "a2", __refuse: true }),
      simpleOrder({ id: "a3" }),
    ]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL" });

    expect(receipt.success).toBe(false);
    expect(receipt.cancelled.map((entry) => entry.orderId).sort()).toEqual(["a1", "a3"]);
    expect(receipt.refused).toHaveLength(1);
    expect(receipt.refused[0]).toMatchObject({ orderId: "a2", code: "cancel_failed" });
    expect(receipt.refused[0].message).toContain("insufficient qty");
    expect(receipt.message).toContain("targeted 3, cancelled 2, refused 1");
    expect(receipt.message).toContain("a2");
  });

  it("cancels a bracket parent and its legs in one call without double-cancelling", async () => {
    const broker = stubBroker([
      simpleOrder({ id: "parent", order_class: "bracket", legs: [{ id: "tp" }, { id: "sl" }] }),
      simpleOrder({ id: "tp", status: "held" }),
      simpleOrder({ id: "sl", status: "held", type: "stop" }),
    ]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL" });

    // The parent is the only cancel sent; the legs are folded out.
    expect(broker.cancelled).toEqual(["parent"]);
    expect(receipt.foldedLegIds.sort()).toEqual(["sl", "tp"]);
    expect(receipt.cancelled[0].legs).toEqual({ declared: 2, cancelled: 2, refused: 0 });
    expect(receipt.message).toContain("2 leg(s) covered by their parent's cancel");
  });

  it("refuses a symbol with no open orders, naming the read and echoing the filter", async () => {
    const broker = stubBroker([simpleOrder({ id: "m1", symbol: "MSFT" })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL" });

    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("no_orders_matched");
    expect(receipt.message).toContain("symbol=AAPL");
    expect(broker.lists).toBe(1);
    expect(broker.cancelled).toEqual([]);
  });

  it("refuses when the broker's open-order read fails, instead of reporting zero", async () => {
    const broker = stubBroker([]);
    broker.listOpenOrders = async () => ({ success: false, message: "HTTP 503 from the broker", httpStatus: 503 });
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL" });
    expect(receipt.code).toBe("cancel_read_failed");
    expect(receipt.message).toContain("HTTP 503");
  });

  it("honours the shared filter: cancel the ladder, keep the protective stop", async () => {
    const broker = stubBroker([
      simpleOrder({ id: "rung-1", order_class: "bracket", client_order_id: "lad_7_x-r1", legs: [{ id: "rung-1-tp" }] }),
      simpleOrder({ id: "rung-1-tp", status: "held" }),
      simpleOrder({ id: "protect", type: "stop", status: "held" }),
    ]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL", orderClass: "bracket" });

    expect(receipt.success).toBe(true);
    expect(broker.cancelled).toEqual(["rung-1"]);
    expect(broker.orders.get("protect")?.status).toBe("held");
  });
});

describe("#3884 — the cancel cap (#3888)", () => {
  it("refuses above the configured cap and reports the real count", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2" }), simpleOrder({ id: "a3" })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL", limits: limitsWith(2) });

    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("cancel_max_exceeded");
    expect(receipt.message).toContain("targets 3 orders but cancelMaxCount is 2");
    expect(broker.cancelled).toEqual([]);
  });

  it("proceeds at exactly the cap", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2" })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL", limits: limitsWith(2) });
    expect(receipt.success).toBe(true);
  });

  it("an unset cap does not block a de-risking ticker cancel, and says so", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL", limits: limitsWith(null) });
    expect(receipt.success).toBe(true);
    expect(receipt.message).toContain("cancelMaxCount is unset");
  });
});

describe("#3884 — records and surfaces", () => {
  function ledgerRows(sql: MockSqlStorage): any[] {
    return Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
  }

  it("records ONE cancel_ticker run with the real counts", async () => {
    const sql = new MockSqlStorage();
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2", __refuse: true })]);
    const receipt = await cancelTickerOrders(broker, { symbol: "AAPL" });
    recordScopedCancelOutcome(sql, receipt, "alpaca_cancel_ticker", { ALPACA_TRADING_TYPE: "paper" } as any, "cancel_ticker:test");

    const rows = ledgerRows(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "order:cancel_ticker:test", kind: "trading", status: "failed", scanned: 2, matched: 1 });
    expect(JSON.parse(rows[0].delivery_json)).toMatchObject({ action: "cancel_ticker", outcome: "cancel_failed", symbol: "AAPL" });
  });

  it("the tool is registered on the trade scope and declares the shared filter", () => {
    const tool = McpToolFactory.getTool("alpaca_cancel_ticker");
    expect(tool).toBeDefined();
    expect(resolveToolScope("alpaca_cancel_ticker")).toBe("mcp:trade");
    const properties = Object.keys(tool!.jsonSchema.properties);
    for (const key of ["symbol", "orderClass", "orderSide", "ladderId", "placedAfter", "dryRun"]) {
      expect(properties).toContain(key);
    }
  });

  it("the route exposes the ticker scope and refuses another broker by name", () => {
    const source = readFileSync("src/agents/routes/brokerOrders.ts", "utf8");
    expect(source).toContain('path.endsWith("/broker/orders/cancel-ticker")');
    expect(source).toContain("cancelTickerOrders(createAlpacaCancelPort(ctx.env)");
    expect(source).toContain("provider_unsupported");
  });

  it("the tool resolves limits from the caller's own settings, not a literal", () => {
    const source = readFileSync("src/mcps/openaimp/cancelOrderCommands.ts", "utf8");
    expect(source).toContain("readLimitsFor(context, symbol)");
    expect(source).toContain("resolveTradingLimits");
  });
});
