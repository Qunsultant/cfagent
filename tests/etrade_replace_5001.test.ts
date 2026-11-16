/**
 * Issue #5001 — Gap 16 follow-up: E*TRADE order replace (change order).
 *
 * E*TRADE's model is a two-step replace: a change PREVIEW, then a change PLACE
 * carrying the preview id. The broker cancels the original and assigns a NEW
 * order id — so the receipt must name the new id and say the original was
 * superseded, never present the change as the same order mutating.
 *
 * Pinned here at the wire (stubbed fetch):
 *  - the order is read first (`GET …/orders/{id}`), and a status that is no
 *    longer open is refused by name with no preview and no place;
 *  - the preview body states the WHOLE order (the broker replaces it), with the
 *    caller's term and the values the order already had where unstated;
 *  - the place body carries the preview id, and the receipt reports the NEW id;
 *  - a stop order whose trigger this surface cannot read is refused by name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const SANDBOX_ENV = {
  ETRADE_CONSUMER_KEY: "ckey_5001",
  ETRADE_CONSUMER_SECRET: ["csecret", "5001"].join(""),
  ETRADE_OAUTH_TOKEN: ["otoken", "5001"].join(""),
  ETRADE_OAUTH_TOKEN_SECRET: ["otokensecret", "5001"].join(""),
  ETRADE_ACCOUNT_ID_KEY: "acct_5001",
  ETRADE_ENVIRONMENT: "sandbox",
} as unknown as Env;

type Call = { url: string; body: any };

const ORDER = {
  orderId: 700001,
  status: "OPEN",
  priceType: "LIMIT",
  limitPrice: 100,
  orderAction: "BUY",
  quantity: 5,
  symbol: "NVDA",
};

function installFetch(order: Record<string, unknown> = ORDER, options: { previewId?: string; newId?: number } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/orders/change/preview")) {
        return Response.json(
          options.previewId === null
            ? { Error: { message: "preview refused by the broker" } }
            : { PreviewOrderResponse: { PreviewIds: { previewId: options.previewId ?? "pv-1" } } },
          { status: 200 },
        );
      }
      if (url.includes("/orders/change/place")) {
        return Response.json(
          options.newId === null
            ? { Error: { message: "change refused by the broker" } }
            : { PlaceOrderResponse: { OrderIds: [{ orderId: options.newId ?? 700999 }] } },
          { status: 200 },
        );
      }
      if (url.includes("/orders/700001") || /\/orders\/[^/?]+(\?|$)/.test(url)) {
        // the shape fetchOrderDetails parses: OrdersResponse.Order[0].OrderDetail[0]
        return Response.json(
          {
            OrdersResponse: {
              Order: [
                {
                  orderId: order.orderId,
                  OrderDetail: [
                    {
                      status: order.status,
                      priceType: order.priceType,
                      ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
                      ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
                      Instrument: [
                        {
                          Product: { symbol: order.symbol, securityType: "EQ" },
                          orderAction: order.orderAction,
                          orderedQuantity: order.quantity,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          { status: 200 },
        );
      }
      if (url.includes("/accounts/list")) {
        return Response.json(
          { AccountListResponse: { Accounts: { Account: [{ accountIdKey: "acct_5001" }] } } },
          { status: 200 },
        );
      }
      // the order read goes through fetchOrderDetails → /orders/{id}
      return Response.json({ OrdersResponse: { Order: [] } }, { status: 200 });
    }),
  );
  return calls;
}

function platform(): ETradeTradingPlatform {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("sess_5001");
  return new ETradeTradingPlatform(SANDBOX_ENV, orm, "boss");
}

describe("#5001 — E*TRADE replace runs change preview then change place", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("previews, places with the preview id, and reports the NEW order id", async () => {
    const calls = installFetch();
    const res = await platform().replaceOrderRemote({ orderId: "700001", quantity: 3, limitPrice: 101.5, timeInForce: "gtc" });
    expect(res.success).toBe(true);
    expect(res.orderId).toBe("700999");
    expect(String(res.message)).toMatch(/replaced by order 700999/);
    expect(String(res.message)).toMatch(/cancelled the original/);

    const preview = calls.find((call) => call.url.includes("/orders/change/preview"));
    const placed = calls.find((call) => call.url.includes("/orders/change/place"));
    expect(preview?.body.PreviewOrderRequest.Order[0]).toMatchObject({
      priceType: "LIMIT",
      limitPrice: 101.5,
      orderTerm: "GOOD_UNTIL_CANCEL",
    });
    expect(preview?.body.PreviewOrderRequest.Order[0].Instrument[0].quantity).toBe(3);
    expect(placed?.body.PlaceOrderRequest.PreviewIds[0].previewId).toBe("pv-1");
    // the broker replaces the whole order, so the symbol travels on the change
    expect(placed?.body.PlaceOrderRequest.Order[0].Instrument[0].Product.symbol).toBe("NVDA");
  });

  it("keeps the order's own values where the caller states nothing", async () => {
    const calls = installFetch();
    const res = await platform().replaceOrderRemote({ orderId: "700001" });
    expect(res.success).toBe(true);
    const preview = calls.find((call) => call.url.includes("/orders/change/preview"));
    expect(preview?.body.PreviewOrderRequest.Order[0]).toMatchObject({ priceType: "LIMIT", limitPrice: 100 });
    expect(preview?.body.PreviewOrderRequest.Order[0].Instrument[0].quantity).toBe(5);
    expect(preview?.body.PreviewOrderRequest.Order[0].orderTerm).toBe("GOOD_FOR_DAY");
  });

  it("refuses an order that is no longer open, before any change call", async () => {
    const calls = installFetch({ ...ORDER, status: "EXECUTED" });
    const res = await platform().replaceOrderRemote({ orderId: "700001", quantity: 3 });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/EXECUTED/);
    expect(calls.filter((call) => call.url.includes("/change/"))).toHaveLength(0);
  });

  it("surfaces a broker refusal from the preview instead of claiming a change", async () => {
    installFetch(ORDER, { previewId: null });
    const res = await platform().replaceOrderRemote({ orderId: "700001", quantity: 3 });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/preview refused by the broker/);
  });

  it("surfaces a broker refusal from the place instead of claiming a change", async () => {
    installFetch(ORDER, { newId: null });
    const res = await platform().replaceOrderRemote({ orderId: "700001", quantity: 3 });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/change refused by the broker/);
  });

  it("refuses a stop order whose trigger this surface cannot read", async () => {
    installFetch({ ...ORDER, priceType: "STOP", limitPrice: undefined });
    const res = await platform().replaceOrderRemote({ orderId: "700001" });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/state stopPrice/);
  });
});
