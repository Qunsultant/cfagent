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
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
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
    expect(sessionTimed?.broker.etrade).toBe("none");
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
  it("Alpaca equity lists OPG and CLS in both modes; E*TRADE lists neither", () => {
    for (const mode of ["paper", "live"] as const) {
      const alpaca = orderCapabilitiesFor({ brokerId: "alpaca", mode, assetClass: "equity" });
      expect(alpaca.timeInForce).toContain("OPG");
      expect(alpaca.timeInForce).toContain("CLS");
      const etrade = orderCapabilitiesFor({ brokerId: "etrade", mode, assetClass: "equity" });
      expect(etrade.timeInForce).not.toContain("OPG");
      expect(etrade.timeInForce).not.toContain("CLS");
    }
  });

  it("Public has no capability entry at all, so it fails closed to its own refusal", () => {
    const publicCaps = orderCapabilitiesFor({ brokerId: "public", mode: "live", assetClass: "equity" });
    expect(publicCaps.supported).toBe(false);
  });

  it("the ticket body carries OPG for Alpaca and refuses it for E*TRADE before sending", () => {
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

    const refused = buildOrderPreviewBody({
      brokerId: "etrade",
      mode: "paper",
      assetClass: "equity",
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
  it("accepts an auction pair on the broker that declares it", () => {
    for (const timeInForce of ["opg", "cls"]) {
      for (const type of ["market", "limit"]) {
        const verdict = validateAdvancedOrder({
          type,
          broker: "alpaca",
          params: { time_in_force: timeInForce, ...(type === "limit" ? { limit_price: 100 } : {}) },
        });
        expect(verdict.ok, `${type}+${timeInForce}`).toBe(true);
      }
    }
  });

  it("refuses an auction pair on a broker with no auction support, naming the capability", () => {
    const refused = validateAdvancedOrder({
      type: "market",
      broker: "etrade",
      params: { time_in_force: "opg" },
    });
    expect(refused).toMatchObject({ ok: false, code: "order_type_unsupported" });
    if (refused.ok) return;
    expect(refused.message).toContain("session_timed @ etrade");
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

describe("#4671 — E*TRADE refuses an auction term before any POST", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the named refusal and contacts nobody", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return new Response("Not Found", { status: 404 });
      }),
    );
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("sess_4671");
    const platform = new ETradeTradingPlatform(SANDBOX_ENV, orm, "boss");
    const res = await platform.placeOrderRemote({
      orderId: "ord_4671",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      timeInForce: "opg",
      userLogin: "did:user:github:boss",
    });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/session_timed @ etrade/);
    expect(String(res.message)).toMatch(/not placed/i);
    expect(calls).toHaveLength(0);
  });
});
