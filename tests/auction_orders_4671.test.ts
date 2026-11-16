/**
 * Issue #4671 — Gap 17 of #4634: "MOO/MOC/LOO/LOC and OPG/CLS do not exist".
 *
 * The four auction order types are NOT four new wire types. An auction order is
 * a market or limit order whose time-in-force names an exchange auction, which
 * is exactly how the broker API models it, and the order-type registry already
 * declared the capability (`session_timed`, `tif: opg/cls`) with no broker behind
 * it. This slice gives it the broker that has it and makes every surface answer
 * from the ONE table that already existed:
 *
 *  - the abbreviations derive from (type, time-in-force), never a second list;
 *  - the ticket vocabulary, the wire vocabulary and the registry cannot drift;
 *  - Alpaca is sent opg / cls on the wire;
 *  - E*TRADE refuses by name before any POST — never a silent day order;
 *  - Public refuses through its own unverified-schema refusal;
 *  - the config matrix offers the values only where they are supported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { auctionOrderMnemonic, advancedOrderType, validateAdvancedOrder } from "../src/trading/advancedOrders";
import { AUCTION_TIME_IN_FORCE, TIME_IN_FORCE_VALUES } from "../src/trading/timeInForce";
import {
  ALL_TIME_IN_FORCE,
  orderCapabilitiesFor,
} from "../src/config/orderCapabilities";
import { buildOrderPreviewBody } from "../src/client/trading/orderPreviewBody";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import {
  ETradeTradingPlatform,
  auctionOrderRefusal,
  etradeAuctionPriceType,
} from "../src/trading/etrade/platform";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const PAPER_ENV = {
  ALPACA_API_KEY_ID: ["PK", "TEST"].join(""),
  ALPACA_API_SECRET_KEY: ["SK", "TEST"].join(""),
} as unknown as Env;

const SANDBOX_ENV = {
  ETRADE_CONSUMER_KEY: "ckey_4671",
  ETRADE_CONSUMER_SECRET: ["csecret", "4671"].join(""),
  ETRADE_OAUTH_TOKEN: ["otoken", "4671"].join(""),
  ETRADE_OAUTH_TOKEN_SECRET: ["otokensecret", "4671"].join(""),
  ETRADE_ACCOUNT_ID_KEY: "acct_4671",
  ETRADE_ENVIRONMENT: "sandbox",
} as unknown as Env;

type FetchCall = { url: string; init: any };

function installAlpacaFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: any) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        id: `alpaca-order-${calls.length}`,
        client_order_id: "alp_ord_4671",
        symbol: body.symbol ?? "AAPL",
        qty: String(body.qty ?? 1),
        side: body.side ?? "buy",
        type: body.type ?? "market",
        time_in_force: body.time_in_force ?? "day",
        status: "accepted",
      });
    },
  );
  return calls;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const base = {
  orderId: "alp_ord_4671",
  symbol: "AAPL",
  action: "BUY" as const,
  quantity: 1,
  userLogin: "boss",
};

describe("#4671 — MOO / MOC / LOO / LOC derive from (type, time-in-force)", () => {
  it("names the four abbreviations from the pair, not from a second list", () => {
    expect(auctionOrderMnemonic("market", "opg")).toBe("MOO");
    expect(auctionOrderMnemonic("market", "cls")).toBe("MOC");
    expect(auctionOrderMnemonic("limit", "opg")).toBe("LOO");
    expect(auctionOrderMnemonic("limit", "cls")).toBe("LOC");
    // Case-insensitive on both halves: the ticket sends uppercase, the wire lowercase.
    expect(auctionOrderMnemonic("LIMIT", "CLS")).toBe("LOC");
  });

  it("returns null for every pair that is not an auction order", () => {
    expect(auctionOrderMnemonic("market", "day")).toBeNull();
    expect(auctionOrderMnemonic("limit", undefined)).toBeNull();
    expect(auctionOrderMnemonic("stop", "opg")).toBeNull();
    expect(auctionOrderMnemonic("stop_limit", "cls")).toBeNull();
  });
});

describe("#4671 — one vocabulary across the ticket, the wire and the registry", () => {
  it("the registry's auction capability IS the canonical auction vocabulary", () => {
    const sessionTimed = advancedOrderType("session_timed");
    expect(sessionTimed?.tif).toEqual([...AUCTION_TIME_IN_FORCE]);
    expect(sessionTimed?.broker.alpaca).toBe("native");
    // Issue #4957: E*TRADE documents the auction as a PRICE TYPE, so the same
    // capability entry is now native there too.
    expect(sessionTimed?.broker.etrade).toBe("native");
  });

  it("the ticket's list and the wire's list are the same values in the same order", () => {
    expect(ALL_TIME_IN_FORCE.map((value) => value.toLowerCase())).toEqual([...TIME_IN_FORCE_VALUES]);
    expect(TIME_IN_FORCE_VALUES).toEqual(expect.arrayContaining([...AUCTION_TIME_IN_FORCE]));
  });

  it("the MCP place-order schema offers the auction values (one enum, not a copy)", () => {
    const tool = McpToolFactory.getTool("alpaca_place_order")!;
    const enumValues = (tool.jsonSchema as any).properties.time_in_force.enum as string[];
    for (const value of TIME_IN_FORCE_VALUES) expect(enumValues).toContain(value);
  });
});

describe("#4671 — the capability matrix offers auction values only where supported", () => {
  it("both equity tables that document an auction list OPG and CLS; options list neither", () => {
    for (const mode of ["paper", "live"] as const) {
      for (const brokerId of ["alpaca", "etrade"]) {
        const equity = orderCapabilitiesFor({ brokerId, mode, assetClass: "equity" });
        expect(equity.timeInForce, `${brokerId} ${mode}`).toContain("OPG");
        expect(equity.timeInForce, `${brokerId} ${mode}`).toContain("CLS");
        // An option order states neither: no documented auction price type, so
        // the ticket must not offer one (the seam refuses it too).
        const options = orderCapabilitiesFor({ brokerId, mode, assetClass: "options" });
        expect(options.timeInForce, `${brokerId} ${mode} options`).not.toContain("OPG");
      }
    }
  });

  it("Public lists the on-close value it documents, and fails closed where it has no mode", () => {
    // Issue #4958: Public's documented order types include MARKET_ON_CLOSE /
    // LIMIT_ON_CLOSE, so live equity offers CLS (never OPG, which it does not
    // document). Public has no paper mode, so the TEST matrix stays empty.
    const live = orderCapabilitiesFor({ brokerId: "public", mode: "live", assetClass: "equity" });
    expect(live.supported).toBe(true);
    expect(live.timeInForce).toContain("CLS");
    expect(live.timeInForce).not.toContain("OPG");
    expect(orderCapabilitiesFor({ brokerId: "public", mode: "paper", assetClass: "equity" }).supported).toBe(false);
  });

  it("the ticket body carries OPG for every broker that documents an auction", () => {
    const ok = buildOrderPreviewBody({
      brokerId: "alpaca",
      mode: "paper",
      assetClass: "equity",
      symbol: "aapl",
      orderAction: "BUY",
      quantity: 1,
      orderType: "MARKET",
      timeInForce: "OPG",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.body).toMatchObject({ timeInForce: "OPG", orderType: "MARKET" });

    const etradeOk = buildOrderPreviewBody({
      brokerId: "etrade",
      mode: "paper",
      assetClass: "equity",
      symbol: "AAPL",
      orderAction: "BUY",
      quantity: 1,
      orderType: "MARKET",
      timeInForce: "OPG",
    });
    expect(etradeOk.ok).toBe(true);

    // An option order states no auction term on either broker.
    const refused = buildOrderPreviewBody({
      brokerId: "etrade",
      mode: "paper",
      assetClass: "options",
      symbol: "AAPL",
      orderAction: "BUY",
      quantity: 1,
      orderType: "MARKET",
      timeInForce: "OPG",
    });
    expect(refused).toEqual({ ok: false, reason: "TIME_IN_FORCE_UNSUPPORTED" });
  });
});

describe("#4671 — the registry decides the refusal, per broker", () => {
  it("accepts an auction pair on both brokers that document one", () => {
    for (const broker of ["alpaca", "etrade"] as const) {
      for (const timeInForce of ["opg", "cls"]) {
        for (const type of ["market", "limit"]) {
          const verdict = validateAdvancedOrder({
            type,
            broker,
            params: { time_in_force: timeInForce, ...(type === "limit" ? { limit_price: 100 } : {}) },
          });
          expect(verdict.ok, `${broker} ${type}+${timeInForce}`).toBe(true);
        }
      }
    }
  });

  it("derives E*TRADE's documented auction PRICE TYPE from the same pair (#4957)", () => {
    expect(etradeAuctionPriceType("MARKET", "opg")).toBe("MARKET_ON_OPEN");
    expect(etradeAuctionPriceType("MARKET", "cls")).toBe("MARKET_ON_CLOSE");
    expect(etradeAuctionPriceType("LIMIT", "opg")).toBe("LIMIT_ON_OPEN");
    expect(etradeAuctionPriceType("LIMIT", "cls")).toBe("LIMIT_ON_CLOSE");
    // Not an auction request at all → nothing to map.
    expect(etradeAuctionPriceType("MARKET", "day")).toBeNull();
    // A stop cannot participate in an auction: no documented price type.
    expect(etradeAuctionPriceType("STOP", "opg")).toBeNull();
  });

  it("refuses the pairs E*TRADE cannot express, naming the reason", () => {
    expect(auctionOrderRefusal("STOP", "opg", false)).toMatch(/no auction price type for a STOP order/);
    expect(auctionOrderRefusal("MARKET", "opg", true)).toMatch(/equity orders/);
    expect(auctionOrderRefusal("MARKET", "opg", false)).toBeNull();
    expect(auctionOrderRefusal("MARKET", "day", false)).toBeNull();
  });

  it("leaves the ordinary session terms alone on both brokers", () => {
    for (const broker of ["alpaca", "etrade"] as const) {
      expect(validateAdvancedOrder({ type: "market", broker, params: { time_in_force: "day" } }).ok).toBe(true);
    }
  });
});

describe("#4671 — Alpaca is sent the auction term on the wire", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function platform(): AlpacaTradingPlatform {
    return new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
  }

  it("sends time_in_force=opg for a MOO and =cls for a MOC", async () => {
    const calls = installAlpacaFetch();
    const moo = await platform().placeOrderRemote({ ...base, orderType: "MARKET", timeInForce: "opg" });
    expect(moo.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "market", time_in_force: "opg" });

    const moc = await platform().placeOrderRemote({ ...base, orderType: "MARKET", timeInForce: "cls" });
    expect(moc.success).toBe(true);
    expect(bodyOf(calls[1])).toMatchObject({ type: "market", time_in_force: "cls" });
  });

  it("carries the limit price for a LOO / LOC", async () => {
    const calls = installAlpacaFetch();
    const loo = await platform().placeOrderRemote({ ...base, orderType: "LIMIT", limitPrice: 100, timeInForce: "opg", priceSource: { kind: "user" } });
    expect(loo.success).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ type: "limit", limit_price: 100, time_in_force: "opg" });
  });
});

describe("#4957 — E*TRADE carries the auction as its documented PRICE TYPE", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function installPlaceFetch(): FetchCall[] {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        calls.push({ url, init });
        if (String(url).includes("/orders/place")) {
          return new Response(JSON.stringify({ PlaceOrderResponse: { OrderIds: [{ orderId: 780001 }] } }), {
            status: 200,
          });
        }
        if (String(url).includes("/accounts/list")) {
          return new Response(
            JSON.stringify({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "acct_4671" }] } } }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      }),
    );
    return calls;
  }

  function placedOrder(call: FetchCall): any {
    return JSON.parse(String(call.init?.body ?? "{}"))?.PlaceOrderRequest?.Order?.[0] ?? {};
  }

  function platform(): ETradeTradingPlatform {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("sess_4671");
    return new ETradeTradingPlatform(SANDBOX_ENV, orm, "boss");
  }

  const base = {
    orderId: "ord_4957",
    symbol: "NVDA",
    action: "BUY" as const,
    quantity: 1,
    userLogin: "did:user:github:boss",
  };

  it("a MOO places as priceType MARKET_ON_OPEN and a MOC as MARKET_ON_CLOSE", async () => {
    const calls = installPlaceFetch();
    const moo = await platform().placeOrderRemote({ ...base, orderType: "MARKET", timeInForce: "opg" });
    expect(moo.success).toBe(true);
    expect(placedOrder(calls[0]).priceType).toBe("MARKET_ON_OPEN");
    expect(placedOrder(calls[0]).limitPrice).toBeUndefined();

    const moc = await platform().placeOrderRemote({ ...base, orderType: "MARKET", timeInForce: "cls" });
    expect(moc.success).toBe(true);
    expect(placedOrder(calls[1]).priceType).toBe("MARKET_ON_CLOSE");
  });

  it("a LOO / LOC places as the LIMIT_ON_* price type AND carries the limit price", async () => {
    const calls = installPlaceFetch();
    const loo = await platform().placeOrderRemote({
      ...base,
      orderType: "LIMIT",
      limitPrice: 101.25,
      timeInForce: "opg",
      priceSource: { kind: "user" },
    });
    expect(loo.success).toBe(true);
    expect(placedOrder(calls[0]).priceType).toBe("LIMIT_ON_OPEN");
    expect(placedOrder(calls[0]).limitPrice).toBe(101.25);

    const loc = await platform().placeOrderRemote({
      ...base,
      orderType: "LIMIT",
      limitPrice: 99.5,
      timeInForce: "cls",
      priceSource: { kind: "user" },
    });
    expect(loc.success).toBe(true);
    expect(placedOrder(calls[1]).priceType).toBe("LIMIT_ON_CLOSE");
    expect(placedOrder(calls[1]).limitPrice).toBe(99.5);
  });

  it("a STOP in an auction is refused by name and contacts nobody", async () => {
    const calls = installPlaceFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "STOP", stopPrice: 95, timeInForce: "opg" });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/no auction price type for a STOP order/);
    expect(calls).toHaveLength(0);
  });

  it("an ordinary order is untouched: no auction key, no price type rewriting", async () => {
    const calls = installPlaceFetch();
    const res = await platform().placeOrderRemote({ ...base, orderType: "MARKET", timeInForce: "day" });
    expect(res.success).toBe(true);
    expect(placedOrder(calls[0]).priceType).toBe("MARKET");
  });

  it("the client itself carries the price type and its limit price (the wire, not just the seam)", async () => {
    const calls = installPlaceFetch();
    const client = new ETradeRestClient(SANDBOX_ENV, "boss");
    await client.placeOrder({
      orderId: "ord_4957_client",
      symbol: "NVDA",
      action: "SELL",
      quantity: 2,
      orderType: "LIMIT_ON_CLOSE",
      limitPrice: 88.75,
      userLogin: "did:user:github:boss",
    });
    expect(placedOrder(calls[0]).priceType).toBe("LIMIT_ON_CLOSE");
    expect(placedOrder(calls[0]).limitPrice).toBe(88.75);
  });
});
