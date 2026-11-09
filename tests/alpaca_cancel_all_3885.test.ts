/**
 * Issue #3885 — cancel every open order, with a preview token and a cap.
 *
 * What these pins defend:
 *   1. A bare call NEVER cancels: it returns the preview (count, symbols,
 *      classes, oldest/newest) and a single-use token.
 *   2. An expired or reused token refuses with `cancel_all_preview_expired` —
 *      it never cancels twice.
 *   3. Above the configured `cancelMaxCount` the call refuses and reports the
 *      real count and the cap; an unset cap refuses too (never unbounded).
 *   4. The receipt lists every order with its terminal status, and a partial
 *      failure is itemised.
 *   5. Only the previewed ids are acted on — an order placed after the
 *      preview is not swept up.
 *   6. The Portfolio dialog shows the preview, presents the token on confirm,
 *      and refreshes the table only after a completed cancel.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cancelAllOrders, recordScopedCancelOutcome } from "../src/services/orderCancellation";
import { createInMemoryCancelPreviewStore, CANCEL_ALL_PREVIEW_TTL_MS } from "../src/services/cancelPreviewStore";
import { resolveTradingLimits } from "../src/trading";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { resolveToolScope } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MockSqlStorage } from "./mock-sql";
import { stubBroker, simpleOrder } from "./cancelTestPort";

function limitsWith(cancelMaxCount: number | null) {
  const values: Record<string, string> = {};
  if (cancelMaxCount !== null) values["trading:limits"] = JSON.stringify({ cancelMaxCount });
  return resolveTradingLimits({ readSetting: (key) => values[key] ?? null });
}

function threeOrders() {
  return [
    simpleOrder({ id: "a1", symbol: "AAPL", submitted_at: "2026-11-09T14:00:00.000Z" }),
    simpleOrder({ id: "m1", symbol: "MSFT", submitted_at: "2026-11-09T15:00:00.000Z" }),
    simpleOrder({ id: "n1", symbol: "NVDA", order_class: "bracket", legs: [{ id: "n1-tp" }], submitted_at: "2026-11-09T13:00:00.000Z" }),
    simpleOrder({ id: "n1-tp", symbol: "NVDA", status: "held" }),
  ];
}

describe("#3885 — a bare call previews and never cancels", () => {
  it("returns the preview and a token, and cancels nothing", async () => {
    const broker = stubBroker(threeOrders());
    const store = createInMemoryCancelPreviewStore();
    const receipt = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);

    expect(receipt.success).toBe(false);
    expect(receipt.code).toBe("cancel_all_needs_preview");
    expect(receipt.preview).toMatchObject({
      count: 3,
      symbols: ["AAPL", "MSFT", "NVDA"],
      classes: ["bracket", "limit"],
      oldest: "2026-11-09T13:00:00.000Z",
      newest: "2026-11-09T15:00:00.000Z",
    });
    expect(receipt.previewToken).toBeTruthy();
    expect(broker.cancelled).toEqual([]);
    expect(receipt.message).toContain("Nothing has been cancelled");
  });

  it("a dry run returns the preview without issuing a token", async () => {
    const broker = stubBroker(threeOrders());
    const receipt = await cancelAllOrders(broker, { dryRun: true, limits: limitsWith(10) }, createInMemoryCancelPreviewStore());
    expect(receipt.preview?.count).toBe(3);
    expect(receipt.previewToken).toBeUndefined();
    expect(broker.cancelled).toEqual([]);
  });

  it("refuses when there is nothing open, and when the read fails", async () => {
    const empty = await cancelAllOrders(stubBroker([]), { limits: limitsWith(10) }, createInMemoryCancelPreviewStore());
    expect(empty.code).toBe("no_orders_matched");

    const broken = stubBroker(threeOrders());
    broken.listOpenOrders = async () => ({ success: false, message: "HTTP 502", httpStatus: 502 });
    const failed = await cancelAllOrders(brokerOr(broken), { limits: limitsWith(10) }, createInMemoryCancelPreviewStore());
    expect(failed.code).toBe("cancel_read_failed");
  });
});

function brokerOr(broker: ReturnType<typeof stubBroker>) {
  return broker;
}

describe("#3885 — the token is single use and short lived", () => {
  it("cancels exactly the previewed orders on the second call", async () => {
    const broker = stubBroker(threeOrders());
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);

    expect(receipt.success).toBe(true);
    expect(receipt.targeted).toBe(3);
    // The bracket parent is cancelled once; its leg is covered by the cascade.
    expect(broker.cancelled.sort()).toEqual(["a1", "m1", "n1"]);
    expect(receipt.cancelled.map((entry) => entry.orderId).sort()).toEqual(["a1", "m1", "n1"]);
    expect(receipt.message).toContain("targeted 3, cancelled 3, refused 0");
  });

  it("refuses a replayed token instead of cancelling twice", async () => {
    const broker = stubBroker(threeOrders());
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);
    const replay = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);

    expect(replay.code).toBe("cancel_all_preview_expired");
    expect(replay.message).toContain("already used");
    expect(broker.cancelled).toHaveLength(3);
  });

  it("refuses an expired token", async () => {
    const broker = stubBroker(threeOrders());
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    // Age the stored preview past its TTL.
    const record = store.find(preview.previewToken!)!;
    store.save({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() });

    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);
    expect(receipt.code).toBe("cancel_all_preview_expired");
    expect(receipt.message).toContain("expired");
    expect(broker.cancelled).toEqual([]);
  });

  it("refuses an unknown token", async () => {
    const receipt = await cancelAllOrders(stubBroker(threeOrders()), { token: "nope" }, createInMemoryCancelPreviewStore());
    expect(receipt.code).toBe("cancel_all_preview_expired");
  });

  it("acts only on the previewed ids: an order placed after the preview survives", async () => {
    const broker = stubBroker(threeOrders());
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    broker.orders.set("late", simpleOrder({ id: "late", symbol: "TSLA" }));

    await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);
    expect(broker.cancelled).not.toContain("late");
    expect(broker.orders.get("late")?.status).toBe("new");
  });
});

describe("#3885 — the configured cap", () => {
  it("refuses above the cap, reporting the real count and the cap", async () => {
    const broker = stubBroker(threeOrders());
    const receipt = await cancelAllOrders(broker, { limits: limitsWith(2) }, createInMemoryCancelPreviewStore());
    expect(receipt.code).toBe("cancel_all_too_many");
    expect(receipt.message).toContain("targets 3 orders but cancelMaxCount is 2");
    expect(receipt.previewToken).toBeUndefined();
    expect(broker.cancelled).toEqual([]);
  });

  it("refuses an unset cap instead of running unbounded", async () => {
    const receipt = await cancelAllOrders(stubBroker(threeOrders()), { limits: limitsWith(null) }, createInMemoryCancelPreviewStore());
    expect(receipt.code).toBe("limit_not_configured");
    expect(receipt.message).toContain("cancelMaxCount is not configured");
    expect(receipt.previewToken).toBeUndefined();
  });

  it("honours the cap at exactly the limit", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2" })]);
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(2) }, store);
    expect(preview.preview?.count).toBe(2);
    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(2) }, store);
    expect(receipt.success).toBe(true);
  });
});

describe("#3885 — the receipt itemises", () => {
  it("names the orders that survived and why", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2", __refuse: true })]);
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);

    expect(receipt.success).toBe(false);
    expect(receipt.cancelled.map((entry) => entry.orderId)).toEqual(["a1"]);
    expect(receipt.refused[0]).toMatchObject({ orderId: "a2", code: "cancel_failed" });
    expect(receipt.refused[0].message).toContain("insufficient qty");
    expect(receipt.message).toContain("Survived: a2");
  });

  it("refuses an id that filled between the preview and the confirm", async () => {
    const broker = stubBroker([simpleOrder({ id: "a1" }), simpleOrder({ id: "a2" })]);
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    const filled = broker.orders.get("a2")!;
    filled.status = "filled";

    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);
    expect(receipt.refused.map((entry) => entry.orderId)).toContain("a2");
    expect(receipt.refused.find((entry) => entry.orderId === "a2")?.message).toContain("filled");
  });

  it("the preview TTL is short and stated", () => {
    expect(CANCEL_ALL_PREVIEW_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    const source = readFileSync("src/services/cancelPreviewStore.ts", "utf8");
    expect(source).toContain("single use");
  });
});

describe("#3885 — records and surfaces", () => {
  it("records one cancel_all run with the counts", async () => {
    const sql = new MockSqlStorage();
    const broker = stubBroker([simpleOrder({ id: "a1" })]);
    const store = createInMemoryCancelPreviewStore();
    const preview = await cancelAllOrders(broker, { limits: limitsWith(10) }, store);
    const receipt = await cancelAllOrders(broker, { token: preview.previewToken, limits: limitsWith(10) }, store);
    recordScopedCancelOutcome(sql, receipt, "alpaca_cancel_all", {} as any, "cancel_all:test");

    const rows = Array.from(sql.exec("SELECT * FROM mas_job_outcomes") as any) as any[];
    expect(rows[0]).toMatchObject({ id: "order:cancel_all:test", status: "completed", scanned: 1, matched: 1 });
    expect(JSON.parse(rows[0].delivery_json).action).toBe("cancel_all");
  });

  it("the tool is registered on the trade scope with a confirm token", () => {
    const tool = McpToolFactory.getTool("alpaca_cancel_all");
    expect(tool).toBeDefined();
    expect(resolveToolScope("alpaca_cancel_all")).toBe("mcp:trade");
    expect(Object.keys(tool!.jsonSchema.properties)).toContain("confirm");
    expect(tool!.description).toContain("two steps");
  });

  it("the route exposes cancel-all and needs a preview store", () => {
    const route = readFileSync("src/agents/routes/brokerOrders.ts", "utf8");
    expect(route).toContain('path.endsWith("/broker/orders/cancel-all")');
    expect(route).toContain("createSqlCancelPreviewStore(sql)");
    expect(route).toContain("cancel_preview_store_unavailable");
  });

  it("the panel mounts the cancel-all control", () => {
    const panel = readFileSync("src/client/AlpacaBrokerPanel.tsx", "utf8");
    expect(panel).toContain("<AlpacaCancelAllControl");
    expect(panel).toContain("onCancelled={() => setOrderHistoryNonce");
  });
});
