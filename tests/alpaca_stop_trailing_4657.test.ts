/**
 * Issue #4657 — Gap 6 of #4634: "Alpaca STOP/trailing refused on the neutral path".
 *
 * `placeOrderRemote` mapped MARKET/LIMIT only and refused everything else with a
 * hand-written sentence, while the provider beneath it has supported
 * `stop` / `stop_limit` / `trailing_stop` / `trailing_stop_limit` all along —
 * and carried `trail_price` / `trail_percent` but **no** `stop_price`, so even a
 * stop order that got through would have POSTed with no trigger.
 *
 * Pinned here, at the wire (stubbed fetch, the #3158 pattern):
 *  - each order type maps to its Alpaca `type` token;
 *  - `stop_price` and the trailing distances actually reach the POST body;
 *  - a missing required parameter is a NAMED refusal with no POST (the registry
 *    in `advancedOrders` decides what each type requires — its first production
 *    caller is this gate);
 *  - trailing refuses exactly-one violations in both directions;
 *  - MARKET/LIMIT bodies are unchanged (a basic order sends no stop/trail keys);
 *  - the extended-session rule (limit only) still refuses a stop before the wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import type { Env } from "../src/types";

const KEY_ID = ["PK", "TEST"].join("");
const SECRET = ["SK", "TEST"].join("");
const PAPER_ENV = { ALPACA_API_KEY_ID: KEY_ID, ALPACA_API_SECRET_KEY: SECRET } as unknown as Env;

type FetchCall = { url: string; init: any };

function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: any) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        id: `alpaca-order-${calls.length}`,
        client_order_id: body.client_order_id ?? "alp_ord_test",
        symbol: body.symbol ?? "AAPL",
        qty: String(body.qty ?? 1),
        side: body.side ?? "buy",
        type: body.type ?? "market",
        time_in_force: body.time_in_force ?? "day",
        status: "accepted",
        filled_avg_price: null,
      });
    },
  );
  return calls;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function platform(): AlpacaTradingPlatform {
  return new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
}

const base = {
  orderId: "alp_ord_test",
  symbol: "AAPL",
  action: "BUY" as const,
  quantity: 1,
  userLogin: "boss",
};

describe("#4657 — Alpaca's stop and trailing types place from the neutral seam", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("maps STOP to type=stop with the trigger on the wire", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "STOP", stopPrice: 95.5 });
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://paper-api.alpaca.markets/v2/orders");
    expect(bodyOf(calls[0])).toMatchObject({ type: "stop", stop_price: 95.5, side: "buy" });
    expect(bodyOf(calls[0]).limit_price).toBeUndefined();
  });

  it("maps STOP_LIMIT to type=stop_limit with both prices", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({
      ...base,
      orderType: "STOP_LIMIT",
      stopPrice: 95.5,
      limitPrice: 95.4,
      priceSource: { kind: "user" },
    });
    expect(res.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "stop_limit", stop_price: 95.5, limit_price: 95.4 });
  });

  it("maps TRAILING_STOP with a dollar distance", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "TRAILING_STOP", trailPrice: 2.5 });
    expect(res.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "trailing_stop", trail_price: 2.5 });
    expect(bodyOf(calls[0]).trail_percent).toBeUndefined();
  });

  it("maps TRAILING_STOP with a percent distance", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "TRAILING_STOP", trailPercent: 3 });
    expect(res.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "trailing_stop", trail_percent: 3 });
    expect(bodyOf(calls[0]).trail_price).toBeUndefined();
  });

  it("maps TRAILING_STOP_LIMIT with a distance and a limit price", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({
      ...base,
      orderType: "TRAILING_STOP_LIMIT",
      trailPercent: 2,
      limitPrice: 180,
      priceSource: { kind: "user" },
    });
    expect(res.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "trailing_stop_limit", trail_percent: 2, limit_price: 180 });
  });
});

describe("#4657 — a missing parameter is a named refusal, before any POST", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("refuses STOP with no stop price, naming the field", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "STOP" });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/stop_price/);
    expect(res.message).toMatch(/not placed/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses STOP_LIMIT with a trigger but no limit price", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "STOP_LIMIT", stopPrice: 95.5 });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/limit_price/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a trailing order that carries both distances (the registry's conflict)", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({
      ...base,
      orderType: "TRAILING_STOP",
      trailPrice: 2,
      trailPercent: 1,
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/trail_price|trail_percent/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a trailing order that carries neither distance", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "TRAILING_STOP" });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/trail_price \/ trail_percent/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a trailing distance on a non-trailing type instead of silently dropping it", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "MARKET", trailPercent: 1 });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/does not take a trailing distance/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses an order type the broker does not have, by name", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "MOO" });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/MOO|unknown/i);
    expect(calls).toHaveLength(0);
  });

  it("keeps the extended-session rule: a stop is refused outside regular hours", async () => {
    const calls = installFetch();
    const res = await platform().placeOrderRemote({
      ...base,
      orderType: "STOP",
      stopPrice: 95.5,
      session: "after_hours",
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/extended-hours|limit order/i);
    expect(calls).toHaveLength(0);
  });
});

describe("#4657 — the existing bodies are untouched", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("a market order still sends exactly its five fields", async () => {
    const calls = installFetch();
    await platform().placeOrderRemote({ ...base, orderType: "MARKET" });
    expect(bodyOf(calls[0])).toEqual({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
    });
  });

  it("a limit order still sends only limit_price", async () => {
    const calls = installFetch();
    await platform().placeOrderRemote({
      ...base,
      orderType: "LIMIT",
      limitPrice: 155.5,
      priceSource: { kind: "user" },
    });
    expect(bodyOf(calls[0])).toEqual({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "limit",
      time_in_force: "day",
      limit_price: 155.5,
    });
  });
});
