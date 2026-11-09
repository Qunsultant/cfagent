/**
 * Issue #3846 — approval executes the stored Alpaca preview draft.
 *
 * The transcript called a nonexistent `alpaca_execute_order` and then
 * started an approval job that never settled. This pins the real path:
 * preview persists a draft; `alpaca_execute_order` (or `alpaca_place_order`
 * with an orderId) loads it and submits the SAME terms, including bracket
 * legs and price provenance. A missing/non-previewed draft is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const storedPair = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));
vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return { ...actual, getAlpacaCredentials: async () => storedPair.record };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import type { Env } from "../src/types";

const PAPER_ENV = {
  ALPACA_API_KEY_ID: ["PK", "TEST"].join(""),
  ALPACA_API_SECRET_KEY: ["SK", "TEST"].join(""),
} as unknown as Env;

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("trader_3846");
  return orm;
}

function ctx(orm: DatabaseORM): any {
  return { env: PAPER_ENV, orm, sessionId: "trader_3846", audit: vi.fn() };
}

type FetchCall = { url: string; init: any };

function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url, init });
    if (String(url).includes("/quotes/latest")) {
      return Response.json({
        quote: { bp: 99.95, ap: 100.05, bs: 100, as: 120, t: "2026-11-09T15:30:00Z" },
      });
    }
    if (String(url).includes("/v2/orders") || String(url).endsWith("/orders")) {
      return Response.json({
        id: "alpaca-order-3846",
        client_order_id: "alp_ord_seed",
        symbol: "AAPL",
        qty: "10",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "accepted",
        filled_avg_price: null,
      });
    }
    return Response.json({}, { status: 404 });
  });
  return calls;
}

beforeEach(() => {
  storedPair.record = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("alpaca_execute_order (#3846)", () => {
  it("preview persists a draft and execute submits the same bracket terms", async () => {
    const calls = installFetch();
    const orm = makeOrm();
    const preview = await McpToolFactory.getTool("alpaca_preview_order")!.execute(
      {
        symbol: "AAPL",
        action: "BUY",
        quantity: 10,
        orderType: "LIMIT",
        limitPrice: 100,
        takeProfitPercent: 4,
        stopLossPercent: 2,
      },
      ctx(orm),
    );
    expect(preview.status).toBe("previewed");
    const stored = orm.trades.findById(preview.orderId);
    expect(stored?.status).toBe("previewed");
    expect(stored?.previewNotes).toContain("bracket");

    const executed = await McpToolFactory.getTool("alpaca_execute_order")!.execute(
      { orderId: preview.orderId, decision: "approved" },
      ctx(orm),
    );
    expect(executed.success).toBe(true);
    expect(executed.brokerOrderRef).toBe("alpaca-order-3846");
    expect(orm.trades.findById(preview.orderId)?.status).toBe("submitted");

    const post = calls.find((c) => String(c.url).includes("/orders") && c.init?.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post!.init.body));
    expect(body.order_class).toBe("bracket");
    expect(body.take_profit).toEqual({ limit_price: 104 });
    expect(body.stop_loss).toEqual({ stop_price: 98 });
    expect(body.time_in_force).toBe("day");
  });

  it("alpaca_place_order with an orderId settles the same stored draft", async () => {
    installFetch();
    const orm = makeOrm();
    const preview = await McpToolFactory.getTool("alpaca_preview_order")!.execute(
      { symbol: "AAPL", action: "BUY", quantity: 5, orderType: "LIMIT", limitPrice: 100 },
      ctx(orm),
    );
    const executed = await McpToolFactory.getTool("alpaca_place_order")!.execute(
      { orderId: preview.orderId, decision: "approved" },
      ctx(orm),
    );
    expect(executed.success).toBe(true);
    expect(orm.trades.findById(preview.orderId)?.status).toBe("submitted");
  });

  it("refuses an unknown draft and a non-previewed draft", async () => {
    const orm = makeOrm();
    const missing = await McpToolFactory.getTool("alpaca_execute_order")!.execute(
      { orderId: "alp_ord_missing" },
      ctx(orm),
    );
    expect(missing.success).toBe(false);
    expect(missing.message).toContain("not found");

    orm.trades.create({
      id: "alp_ord_done",
      sessionId: "trader_3846",
      symbol: "AAPL",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 100,
      totalValue: 100,
      status: "submitted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stale = await McpToolFactory.getTool("alpaca_execute_order")!.execute(
      { orderId: "alp_ord_done" },
      ctx(orm),
    );
    expect(stale.success).toBe(false);
    expect(stale.message).toContain("not 'previewed'");
  });
});
