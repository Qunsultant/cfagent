/**
 * Issue #4659 — Gap 7 of #4634: "E*TRADE STOP placement is preview-session-dependent".
 *
 * The place body carried `priceType` and (for limit types) `limitPrice`, but no
 * `stopPrice` at all, so a STOP / STOP_LIMIT order was only correct if the
 * preview session it referenced still held the trigger — an invisible dependency
 * with no test behind it. The decision (recorded on the issue) is to PLUMB the
 * trigger onto the order, keep `PreviewIds` for the priced preview, and refuse a
 * stop order that has neither.
 *
 * Pinned here at the wire (stubbed fetch → the sandbox `/orders/place` URL):
 *  - STOP and STOP_LIMIT place bodies carry `stopPrice`;
 *  - LIMIT / MARKET bodies do not;
 *  - a stop type with no trigger and no preview id is refused before any POST;
 *  - the documented preview-session arm is pinned too: no trigger + a preview id
 *    still places, with `PreviewIds` on the body and no `stopPrice`;
 *  - the HITL path (`platform.executeOrder`) forwards the draft's stored trigger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const MOCK_CKEY = "ckey_4659";
const MOCK_CSECRET = "csecret_4659";
const HUMAN_DID = "did:user:github:boss";

const SANDBOX_ENV = {
  ETRADE_CONSUMER_KEY: MOCK_CKEY,
  ETRADE_CONSUMER_SECRET: MOCK_CSECRET,
  ETRADE_OAUTH_TOKEN: "tok_4659",
  ETRADE_OAUTH_TOKEN_SECRET: "toksec_4659",
  ETRADE_ACCOUNT_ID_KEY: "acct_4659",
  ETRADE_ENVIRONMENT: "sandbox",
} as unknown as Env;

type PlaceCall = { url: string; body: any };

/** Stub the place endpoint and record the request bodies it receives. */
function installPlaceFetch(): PlaceCall[] {
  const calls: PlaceCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("/orders/place")) {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ PlaceOrderResponse: { OrderIds: [{ orderId: 445599 }] } }), {
          status: 200,
        });
      }
      // Accounts read, in case the account key is not used verbatim.
      if (url.includes("/accounts/list")) {
        return new Response(
          JSON.stringify({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "acct_4659" }] } } }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
  return calls;
}

function orderOf(call: PlaceCall): any {
  return call.body?.PlaceOrderRequest?.Order?.[0] ?? {};
}

describe("#4659 — the E*TRADE place body states the stop trigger", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("a STOP order sends stopPrice and no limitPrice", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    const res = await client.placeOrder({
      orderId: "ord_4659_stop",
      symbol: "NVDA",
      action: "SELL",
      quantity: 5,
      orderType: "STOP",
      stopPrice: 95.5,
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    const order = orderOf(calls[0]);
    expect(order.priceType).toBe("STOP");
    expect(order.stopPrice).toBe(95.5);
    expect(order.limitPrice).toBeUndefined();
  });

  it("a STOP_LIMIT order sends both stopPrice and limitPrice", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    await client.placeOrder({
      orderId: "ord_4659_stoplimit",
      symbol: "NVDA",
      action: "SELL",
      quantity: 5,
      orderType: "STOP_LIMIT",
      stopPrice: 95.5,
      limitPrice: 95.4,
      userLogin: HUMAN_DID,
    });
    const order = orderOf(calls[0]);
    expect(order.priceType).toBe("STOP_LIMIT");
    expect(order.stopPrice).toBe(95.5);
    expect(order.limitPrice).toBe(95.4);
  });

  it("LIMIT and MARKET bodies carry no stopPrice", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    await client.placeOrder({
      orderId: "ord_4659_limit",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 100,
      userLogin: HUMAN_DID,
    });
    await client.placeOrder({
      orderId: "ord_4659_market",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: HUMAN_DID,
    });
    expect(orderOf(calls[0]).stopPrice).toBeUndefined();
    expect(orderOf(calls[1]).stopPrice).toBeUndefined();
  });

  it("refuses a stop order with neither a trigger nor a preview id, before any POST", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    const res = await client.placeOrder({
      orderId: "ord_4659_bare_stop",
      symbol: "NVDA",
      action: "SELL",
      quantity: 1,
      orderType: "STOP",
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/stop price is required/i);
    expect(calls).toHaveLength(0);
  });

  it("keeps the documented preview-session arm: a preview id alone still places", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    const res = await client.placeOrder({
      orderId: "ord_4659_previewed_stop",
      symbol: "NVDA",
      action: "SELL",
      quantity: 1,
      orderType: "STOP",
      previewId: "778899",
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(true);
    const placeRequest = calls[0].body.PlaceOrderRequest;
    expect(placeRequest.PreviewIds).toEqual([{ previewId: 778899 }]);
    expect(orderOf(calls[0]).stopPrice).toBeUndefined();
  });
});

describe("#4659 — the HITL path forwards the draft's stored trigger", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function seedStopDraft(orm: DatabaseORM, id: string, stopPrice?: number): string {
    orm.trades.create({
      id,
      sessionId: "sess_4659",
      symbol: "NVDA",
      action: "SELL",
      orderType: "STOP",
      quantity: 5,
      price: 100,
      totalValue: 500,
      status: "previewed",
      orderRef: undefined,
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: HUMAN_DID,
      proofSignature: "sig_4659",
      previewNotes: "E*TRADE Order Preview: SELL 5 NVDA.",
      ...(stopPrice !== undefined ? { stopPrice } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return id;
  }

  it("sends the draft's stop_price on the place body", async () => {
    const calls = installPlaceFetch();
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("sess_4659");
    const id = seedStopDraft(orm, "ord_4659_platform_stop", 94.25);
    const platform = new ETradeTradingPlatform(SANDBOX_ENV, orm, "boss");
    const res = await platform.executeOrder(id, HUMAN_DID, "approved");
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    const order = orderOf(calls[0]);
    expect(order.priceType).toBe("STOP");
    expect(order.stopPrice).toBe(94.25);
  });
});
