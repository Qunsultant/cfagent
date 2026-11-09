/**
 * Issue #3883 — single-order cancel parity: tool, bracket cascade, ledger.
 *
 * What these pins defend:
 *   1. `alpaca_cancel_order` cancels a simple open order and records
 *      `order:<id>` in the Workflow Runs ledger with the cancel word and the
 *      broker's own status.
 *   2. A bracket parent cancel reports how many held legs were cancelled and
 *      how many the broker refused — the cascade is counted, not assumed.
 *   3. An already-filled (or otherwise final) order refuses with
 *      `cancel_not_possible` naming the status; nothing is sent, nothing is
 *      claimed.
 *   4. A leg cancel is allowed and names the parent that survived.
 *   5. A refused or unreadable cancel is reported as such, never as
 *      "0 orders cancelled".
 *   6. The UI shows the same words and only refreshes after the broker
 *      confirms.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cancelSingleOrder, recordCancelOutcome, type CancelBrokerPort } from "../src/services/orderCancellation";
import {
  mapAlpacaOrderRow,
  mapAlpacaOrderList,
  normalizeCancelStatus,
  parseLadderId,
} from "../src/trading";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { resolveToolScope } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MockSqlStorage } from "./mock-sql";

function order(overrides: Record<string, any> = {}) {
  return {
    id: "ord-1",
    symbol: "AAPL",
    side: "buy",
    order_class: "simple",
    type: "limit",
    status: "new",
    qty: "10",
    client_order_id: "lad_1730000000000_ab12cd-r1",
    submitted_at: "2026-11-09T14:00:00.000Z",
    ...overrides,
  };
}

function port(overrides: Partial<CancelBrokerPort> & { orders?: Record<string, any> } = {}): CancelBrokerPort & {
  cancelled: string[];
} {
  const orders = overrides.orders ?? {};
  const cancelled: string[] = [];
  return {
    cancelled,
    async getOrder(orderId: string) {
      const found = orders[orderId];
      if (!found) return { success: false, message: "order not found", httpStatus: 404 };
      return { success: true, order: found };
    },
    async listOpenOrders() {
      return {
        success: true,
        orders: Object.values(orders).filter((row: any) => row.status === "new" || row.status === "held"),
      };
    },
    async cancelOrder(orderId: string) {
      cancelled.push(orderId);
      const found = orders[orderId];
      if (found && found.__refuse) {
        return { success: false, orderId, message: "insufficient qty available", httpStatus: 422 };
      }
      if (found) found.status = "canceled";
      return { success: true, orderId, message: `Alpaca order ${orderId} cancelled.`, httpStatus: 204 };
    },
    ...overrides,
  };
}

describe("#3883 — the neutral cancel vocabulary", () => {
  it("classifies a broker status as open, terminal or unknown — never by guess", () => {
    expect(normalizeCancelStatus("new")).toBe("open");
    expect(normalizeCancelStatus("partially_filled")).toBe("open");
    expect(normalizeCancelStatus("filled")).toBe("terminal");
    expect(normalizeCancelStatus("canceled")).toBe("terminal");
    expect(normalizeCancelStatus("suspended")).toBe("unknown");
    expect(normalizeCancelStatus("")).toBe("unknown");
  });

  it("reads the ladder batch off the client order id the ladder stamps", () => {
    expect(parseLadderId("lad_1730000000000_ab12cd-r3")).toBe("lad_1730000000000_ab12cd");
    expect(parseLadderId("lad_1730000000000_ab12cd")).toBeNull();
    expect(parseLadderId(null)).toBeNull();
  });

  it("keeps a bracket a bracket even though its entry is a limit order", () => {
    const mapped = mapAlpacaOrderRow(order({ order_class: "bracket", legs: [{ id: "ord-tp" }, { id: "ord-sl" }] }));
    expect(mapped.cancelClass).toBe("bracket");
    expect(mapped.role).toBe("parent");
    expect(mapped.legIds).toEqual(["ord-tp", "ord-sl"]);
  });

  it("names a simple order's type as the class a user would ask for", () => {
    expect(mapAlpacaOrderRow(order({ type: "limit" })).cancelClass).toBe("limit");
    expect(mapAlpacaOrderRow(order({ type: "stop", order_class: "simple" })).cancelClass).toBe("stop");
    expect(mapAlpacaOrderRow(order({ type: "trailing_stop" })).cancelClass).toBe("simple");
  });

  it("wires a declared leg back to its parent across the list", () => {
    const rows = mapAlpacaOrderList([
      order({ id: "parent", order_class: "bracket", legs: [{ id: "leg-tp" }, { id: "leg-sl" }] }),
      order({ id: "leg-tp", order_class: "simple", status: "held" }),
    ]);
    expect(rows[1]).toMatchObject({ role: "leg", parentId: "parent" });
  });
});

describe("#3883 — cancelling one order", () => {
  it("cancels a simple open order and reports the broker's post-cancel status", async () => {
    const broker = port({ orders: { "ord-1": order() } });
    const receipt = await cancelSingleOrder(broker, { orderId: "ord-1" });

    expect(receipt.success).toBe(true);
    expect(receipt.target).toMatchObject({
      orderId: "ord-1",
      symbol: "AAPL",
      orderClass: "limit",
      role: "single",
      statusBefore: "new",
      statusAfter: "canceled",
      cancelled: true,
    });
    expect(broker.cancelled).toEqual(["ord-1"]);
  });

  it("cancels a bracket parent and counts the legs the broker cancelled", async () => {
    const broker = port({
      orders: {
        parent: order({ id: "parent", order_class: "bracket", legs: [{ id: "tp" }, { id: "sl" }] }),
        tp: order({ id: "tp", status: "held" }),
        sl: order({ id: "sl", status: "held" }),
      },
    });
    const receipt = await cancelSingleOrder(broker, { orderId: "parent" });

    expect(receipt.success).toBe(true);
    // The parent is the only cancel sent: the broker cascades its legs.
    expect(broker.cancelled).toEqual(["parent"]);
    expect(receipt.target?.legs).toEqual({ declared: 2, cancelled: 0, refused: 2 });
    expect(receipt.target?.survivingLegs).toEqual(["tp", "sl"]);
    expect(receipt.message).toContain("0 of 2 held legs are cancelled");
  });

  it("counts the legs a cascading cancel actually cancelled", async () => {
    const orders: Record<string, any> = {
      parent: order({ id: "parent", order_class: "bracket", legs: [{ id: "tp" }, { id: "sl" }] }),
      tp: order({ id: "tp", status: "held" }),
      sl: order({ id: "sl", status: "held" }),
    };
    const broker = port({
      orders,
      async cancelOrder(orderId: string) {
        // Alpaca cancels the parent and its held legs together.
        orders.parent.status = "canceled";
        orders.tp.status = "canceled";
        orders.sl.status = "canceled";
        return { success: true, orderId, message: "cancelled", httpStatus: 204 };
      },
    });

    const receipt = await cancelSingleOrder(broker, { orderId: "parent" });
    expect(receipt.target?.legs).toEqual({ declared: 2, cancelled: 2, refused: 0 });
    expect(receipt.message).toContain("2 of 2 held legs are cancelled");
  });

  it("refuses an already-filled order with cancel_not_possible and sends nothing", async () => {
    const broker = port({ orders: { "ord-1": order({ status: "filled" }) } });
    const receipt = await cancelSingleOrder(broker, { orderId: "ord-1" });

    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("cancel_not_possible");
    expect(receipt.message).toContain("filled");
    expect(broker.cancelled).toEqual([]);
  });

  it("refuses a status it does not recognise instead of assuming it is open", async () => {
    const broker = port({ orders: { "ord-1": order({ status: "suspended" }) } });
    const receipt = await cancelSingleOrder(broker, { orderId: "ord-1" });
    expect(receipt.code).toBe("cancel_not_possible");
    expect(receipt.message).toContain("does not recognise");
    expect(broker.cancelled).toEqual([]);
  });

  it("cancels one leg and names the parent that survived", async () => {
    const broker = port({
      orders: {
        parent: order({ id: "parent", order_class: "bracket", legs: [{ id: "tp" }, { id: "sl" }] }),
        tp: order({ id: "tp", status: "held" }),
        sl: order({ id: "sl", status: "held" }),
      },
    });
    const receipt = await cancelSingleOrder(broker, { orderId: "tp" });

    expect(receipt.success).toBe(true);
    expect(broker.cancelled).toEqual(["tp"]);
    expect(receipt.target).toMatchObject({ role: "leg", survivingParent: { orderId: "parent", status: "new" } });
    expect(receipt.message).toContain("parent parent is 'new'");
  });

  it("reports an unreadable order as unread, never as zero cancelled", async () => {
    const broker = port({ orders: {} });
    const receipt = await cancelSingleOrder(broker, { orderId: "missing" });
    expect(receipt.code).toBe("order_not_found");
    expect(receipt.success).toBe(false);
  });

  it("propagates a read failure with the broker's reason", async () => {
    const broker = port({
      async getOrder() {
        return { success: false, message: "Alpaca rejected the read: 401 unauthorized", httpStatus: 401 };
      },
    });
    const receipt = await cancelSingleOrder(broker, { orderId: "ord-1" });
    expect(receipt.code).toBe("cancel_read_failed");
    expect(receipt.message).toContain("401 unauthorized");
  });

  it("reports a broker refusal with its message and status", async () => {
    const broker = port({ orders: { "ord-1": order({ __refuse: true }) } });
    const receipt = await cancelSingleOrder(broker, { orderId: "ord-1" });
    expect(receipt.code).toBe("cancel_failed");
    expect(receipt.message).toContain("insufficient qty");
    expect(receipt.message).toContain("422");
    expect(receipt.success).toBe(false);
  });

  it("refuses an empty id without touching the broker", async () => {
    const broker = port({ orders: {} });
    const receipt = await cancelSingleOrder(broker, { orderId: "  " });
    expect(receipt.code).toBe("invalid_order_id");
    expect(broker.cancelled).toEqual([]);
  });
});

describe("#3883 — the ledger records every cancel", () => {
  function ledgerRows(sql: MockSqlStorage): any[] {
    return Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any);
  }

  it("records a confirmed cancel as order:<id> with outcome cancelled and the broker status", async () => {
    const sql = new MockSqlStorage();
    const receipt = await cancelSingleOrder(port({ orders: { "ord-1": order() } }), { orderId: "ord-1" });
    recordCancelOutcome(sql, receipt, "alpaca_cancel_order", { ALPACA_TRADING_TYPE: "paper" } as any);

    const rows = ledgerRows(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "order:ord-1",
      kind: "trading",
      status: "completed",
      origin: "alpaca_cancel_order",
    });
    const delivery = JSON.parse(rows[0].delivery_json);
    expect(delivery).toMatchObject({ action: "cancel", outcome: "cancelled", brokerStatus: "canceled", broker: "alpaca" });
  });

  it("records a refused cancel as failed with its code", async () => {
    const sql = new MockSqlStorage();
    const receipt = await cancelSingleOrder(port({ orders: { "ord-1": order({ status: "filled" }) } }), {
      orderId: "ord-1",
    });
    recordCancelOutcome(sql, receipt, "alpaca_cancel_order", {} as any);
    const rows = ledgerRows(sql);
    expect(rows[0]).toMatchObject({ id: "order:ord-1", status: "failed", coded_error: "cancel_not_possible" });
    expect(JSON.parse(rows[0].delivery_json).outcome).toBe("cancel_failed");
  });
});

describe("#3883 — the tool and the route share one implementation", () => {
  it("registers alpaca_cancel_order on the trade scope", () => {
    const tool = McpToolFactory.getTool("alpaca_cancel_order");
    expect(tool).toBeDefined();
    expect(resolveToolScope("alpaca_cancel_order")).toBe("mcp:trade");
    expect(tool!.description).toContain("bracket");
  });

  it("the route runs the same engine for Alpaca", () => {
    const route = readFileSync("src/agents/routes/brokerOrders.ts", "utf8");
    expect(route).toContain("cancelSingleOrder(createCancelBrokerPort(ctx.env)");
    expect(route).toContain('broker === "alpaca"');
    // The neutral broker path is untouched.
    expect(route).toContain("platform.cancelOrderRemote(cancelOrderId)");
  });

  it("the tool audits the attempt with what it targeted", async () => {
    const audits: any[] = [];
    const tool = McpToolFactory.getTool("alpaca_cancel_order")!;
    // A tool call with no reachable broker must still answer, not throw.
    const receipt = (await tool.execute(
      { orderId: "ord-missing" },
      {
        env: {} as any,
        orm: { getSql: () => new MockSqlStorage() } as any,
        sessionId: "s1",
        audit: (type: string, _agent: any, payload: any) => audits.push({ type, payload }),
      } as any,
    )) as any;
    expect(receipt.success).toBe(false);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].payload.orderId).toBe("ord-missing");
  });

  it("the order-history row only refreshes after the broker confirms", () => {
    const panel = readFileSync("src/client/AlpacaBrokerPanel.tsx", "utf8");
    expect(panel).toContain("if (res.ok) setOrderHistoryNonce");
    expect(panel).toContain("body.message");
    expect(panel).toContain("The order may still be open");
  });
});
