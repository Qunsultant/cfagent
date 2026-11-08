/**
 * Issue #3158 — Alpaca order-placement client (follow-on of S3 #3089).
 *
 * TDD Red: these pins FAIL on the pre-slice tree — the Alpaca adapter
 * has no placeOrderRemote, and getAccounts / getPositions return
 * hardcoded paper stubs (alpaca_paper_01, $100,000, empty positions).
 * They pass once the adapter wires the Alpaca Trading API v2
 * order-placement client with business-error mapping, paper/live base
 * URL handling, and live account/position reads.
 *
 * Verification is paper-only by design: every placement test runs
 * against a stubbed fetch. No test moves funds, and no test claims a
 * broker execution without a broker order id in the stubbed response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Issue #3404: live placement requires the user's OWN pair, so the live-host
// assertions hand the adapter a stored pair instead of widening the guard.
const storedPair = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));
vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return { ...actual, getAlpacaCredentials: async () => storedPair.record };
});

beforeEach(() => {
  // Every case starts with no stored pair unless it says otherwise.
  storedPair.record = null;
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import type { Env } from "../src/types";

const KEY_ID = ["PK", "TEST"].join("");
const SECRET = ["SK", "TEST"].join("");

const PAPER_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
} as unknown as Env;

const LIVE_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
  ALPACA_BASE_URL: "https://api.alpaca.markets",
} as unknown as Env;

const PAPER_HOST_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as unknown as Env;

const NO_KEYS_ENV = {} as unknown as Env;

function makeOrm(sessionId: string): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(sessionId);
  return orm;
}

function seedPreviewedTrade(orm: DatabaseORM, id: string): string {
  orm.trades.create({
    id,
    sessionId: "sess_3158",
    symbol: "AAPL",
    action: "BUY",
    orderType: "MARKET",
    quantity: 10,
    price: 150,
    totalValue: 1500,
    status: "previewed",
    orderRef: undefined,
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: "did:user:github:boss",
    proofSignature: "sig_3158_seed",
    previewNotes: "Alpaca Order Preview: BUY 10 AAPL.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

type FetchCall = { url: string; init: any };
type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function installFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: any) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  );
  return calls;
}

const ORDER_OK = {
  id: "alpaca-order-1",
  client_order_id: "alp_ord_seed",
  symbol: "AAPL",
  qty: "10",
  side: "buy",
  type: "market",
  time_in_force: "day",
  status: "accepted",
  filled_avg_price: null,
};

const ACCOUNT_OK = {
  id: "acct-live-1",
  account_number: "PA123456",
  status: "ACTIVE",
  currency: "USD",
  buying_power: "250000.00",
  cash: "120000.00",
  portfolio_value: "260000.00",
  pattern_day_trader: false,
  multiplier: "2",
};

const POSITIONS_OK = [
  {
    asset_id: "asset-1",
    symbol: "AAPL",
    exchange: "NASDAQ",
    asset_class: "us_equity",
    qty: "10",
    avg_entry_price: "140.00",
    side: "long",
    market_value: "1500.00",
    cost_basis: "1400.00",
    unrealized_pl: "100.00",
    unrealized_plpc: "0.0714",
    unrealized_intraday_pl: "20.00",
    unrealized_intraday_plpc: "0.0135",
    current_price: "150.00",
    lastday_price: "148.00",
    change_today: "0.0135",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("Alpaca placeOrderRemote (#3158)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("market buy maps to POST /v2/orders on the paper host with key/secret headers", async () => {
    const calls = installFetch(async (call) => {
      expect(call.url).toBe("https://paper-api.alpaca.markets/v2/orders");
      expect(call.init.method).toBe("POST");
      expect(call.init.headers["APCA-API-KEY-ID"]).toBe(KEY_ID);
      expect(call.init.headers["APCA-API-SECRET-KEY"]).toBe(SECRET);
      const body = JSON.parse(call.init.body);
      expect(body).toEqual({
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });
      return jsonResponse(ORDER_OK);
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "alp_ord_seed",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(calls).toHaveLength(1);
    expect(res.success).toBe(true);
    expect(res.status).toBe("submitted");
    expect(res.brokerOrderRef).toBe("alpaca-order-1");
    expect(res.executionId).toBe("alpaca-order-1");
    expect(res.message).toMatch(/Alpaca/);
    expect(res.message).toMatch(/paper/);
  });

  it("limit sell maps limit_price; SELL_SHORT maps to sell; BUY_TO_COVER maps to buy", async () => {
    const seen: any[] = [];
    installFetch(async (call) => {
      seen.push(JSON.parse(call.init.body));
      return jsonResponse({ ...ORDER_OK, id: `alpaca-order-${seen.length}` });
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    await alpaca.placeOrderRemote({
      orderId: "o1",
      symbol: "AAPL",
      action: "SELL",
      quantity: 5,
      orderType: "LIMIT",
      limitPrice: 155.5,
      // Issue #3782: the caller-supplied limit price declares user provenance for the placeOrder guard.
      priceSource: { kind: "user" },
      userLogin: "boss",
    });
    await alpaca.placeOrderRemote({
      orderId: "o2",
      symbol: "AAPL",
      action: "SELL_SHORT",
      quantity: 2,
      orderType: "MARKET",
      userLogin: "boss",
    });
    await alpaca.placeOrderRemote({
      orderId: "o3",
      symbol: "AAPL",
      action: "BUY_TO_COVER",
      quantity: 2,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(seen[0]).toMatchObject({ side: "sell", type: "limit", limit_price: 155.5 });
    expect(seen[1]).toMatchObject({ side: "sell", type: "market" });
    expect(seen[1]).not.toHaveProperty("limit_price");
    expect(seen[2]).toMatchObject({ side: "buy", type: "market" });
  });

  it("option legs without contract detail are refused without any fetch (#3329)", async () => {
    const calls = installFetch(async () => jsonResponse(ORDER_OK));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "o-opt",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
      optionLegs: [{ securityType: "OPTN" } as any],
    });
    expect(calls).toHaveLength(0);
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.brokerOrderRef).toBe("");
    // Issue #3329: option legs ARE placed now, with a limit price and OCC
    // symbols. This leg carries no type/strike/expiry, so it is refused by
    // name before any request — the same no-fetch guarantee as before.
    expect(res.message).toMatch(/type, strike, and expiry/i);
  });

  it("invalid quantity and missing symbol are refused without any fetch", async () => {
    const calls = installFetch(async () => jsonResponse(ORDER_OK));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    for (const params of [
      { orderId: "o-q0", symbol: "AAPL", action: "BUY" as const, quantity: 0, orderType: "MARKET", userLogin: "boss" },
      { orderId: "o-qn", symbol: "AAPL", action: "BUY" as const, quantity: -3, orderType: "MARKET", userLogin: "boss" },
      { orderId: "o-nosym", symbol: "  ", action: "BUY" as const, quantity: 1, orderType: "MARKET", userLogin: "boss" },
    ]) {
      const res = await alpaca.placeOrderRemote(params);
      expect(res.success).toBe(false);
      expect(res.brokerOrderRef).toBe("");
    }
    expect(calls).toHaveLength(0);
  });

  it("unconfigured credentials are refused without any fetch and without technical text", async () => {
    const calls = installFetch(async () => jsonResponse(ORDER_OK));
    const alpaca = new AlpacaTradingPlatform(NO_KEYS_ENV, undefined, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "o-nokeys",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(calls).toHaveLength(0);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Alpaca/);
    expect(res.message).toMatch(/not configured/);
    expect(res.message).not.toMatch(/APCA|API_KEY|SECRET/);
  });

  it("live base URL uses the live host and names live; an explicit paper host stays paper", async () => {
    // Issue #3404: a live placement needs the user's own pair; the deployment
    // pair is paper-only. The host behaviour is what this test is about, so the
    // sign-in is supplied rather than the guard widened.
    storedPair.record = { keyId: "user-live-key", secretKey: "user-live-secret" };
    const liveCalls = installFetch(async (call) => {
      expect(call.url).toBe("https://api.alpaca.markets/v2/orders");
      return jsonResponse(ORDER_OK);
    });
    const live = new AlpacaTradingPlatform(LIVE_ENV, undefined, "boss");
    const liveRes = await live.placeOrderRemote({
      orderId: "o-live",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(liveCalls).toHaveLength(1);
    expect(liveRes.success).toBe(true);
    expect(liveRes.message).toMatch(/live/);
    vi.unstubAllGlobals();

    const paperCalls = installFetch(async (call) => {
      expect(call.url).toBe("https://paper-api.alpaca.markets/v2/orders");
      return jsonResponse(ORDER_OK);
    });
    const paper = new AlpacaTradingPlatform(PAPER_HOST_ENV, undefined, "boss");
    const paperRes = await paper.placeOrderRemote({
      orderId: "o-paper",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(paperCalls).toHaveLength(1);
    expect(paperRes.message).toMatch(/paper/);
  });

  it("upstream failures map to business errors and never surface upstream text", async () => {
    const upstream = "insufficient buying power for this order, code 42210000";
    const cases: Array<{ status: number; match: RegExp; notMatch?: RegExp }> = [
      { status: 401, match: /credentials/ },
      { status: 403, match: /credentials/ },
      { status: 422, match: /rejected.*order|buying power/ },
      { status: 429, match: /busy|retry/ },
      { status: 500, match: /temporarily unavailable/ },
    ];
    for (const c of cases) {
      vi.unstubAllGlobals();
      installFetch(async () => jsonResponse({ code: c.status, message: upstream }, c.status));
      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
      const res = await alpaca.placeOrderRemote({
        orderId: `o-${c.status}`,
        symbol: "AAPL",
        action: "BUY",
        quantity: 1,
        orderType: "MARKET",
        userLogin: "boss",
      });
      expect(res.success).toBe(false);
      expect(res.status).toBe("failed");
      expect(res.brokerOrderRef).toBe("");
      expect(res.message).toMatch(c.match);
      expect(res.message).not.toContain(upstream);
      expect(res.message).not.toContain("42210000");
    }
  });

  it("network failure and non-JSON upstream bodies map to business errors", async () => {
    installFetch(async () => {
      throw new Error("fetch failed: socket hangup");
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const net = await alpaca.placeOrderRemote({
      orderId: "o-net",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(net.success).toBe(false);
    expect(net.message).toMatch(/reach Alpaca/);
    expect(net.message).not.toContain("socket hangup");
    vi.unstubAllGlobals();

    installFetch(async () => new Response("<!doctype html><title>Bad Gateway</title>", { status: 502 }));
    const html = await alpaca.placeOrderRemote({
      orderId: "o-html",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(html.success).toBe(false);
    expect(html.message).not.toContain("<!doctype");
    expect(html.message).toMatch(/Alpaca/);
  });

  it("a success response without a broker order id is NOT reported as executed", async () => {
    installFetch(async () => jsonResponse({ status: "accepted", symbol: "AAPL" }));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "o-noid",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.brokerOrderRef).toBe("");
    expect(res.message).toMatch(/not confirmed|No funds were moved/);
  });

  it("preview then placeOrderRemote executes against a paper account with the broker named", async () => {
    installFetch(async (call) => {
      if (call.url.includes("/quotes/latest")) {
        return jsonResponse({ quote: { bp: 149, ap: 151, bs: 100, as: 100, t: new Date().toISOString() } });
      }
      if (call.url.endsWith("/v2/orders")) {
        return jsonResponse(ORDER_OK);
      }
      throw new Error(`unexpected fetch ${call.url}`);
    });
    const orm = makeOrm("sess_3158");
    const draftId = seedPreviewedTrade(orm, "alp_ord_flow");
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, orm, "boss");
    const preview = await alpaca.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      sessionId: "sess_3158",
    } as any);
    expect(preview.status).toBe("previewed");
    expect(preview.previewMessage).toMatch(/Alpaca/);
    const res = await alpaca.placeOrderRemote({
      orderId: draftId,
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      userLogin: "boss",
    });
    expect(res.success).toBe(true);
    expect(res.status).toBe("submitted");
    expect(res.brokerOrderRef).toBe("alpaca-order-1");
    expect(res.didAttestation?.signature).toBe("sig_3158_seed");
    expect(res.message).toMatch(/Alpaca/);
    expect(res.message).toMatch(/paper/);
  });

  it("limit order without a limit price and unknown order types are refused without any fetch", async () => {
    const calls = installFetch(async () => jsonResponse(ORDER_OK));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    for (const params of [
      { orderId: "o-nolimit", symbol: "AAPL", action: "BUY" as const, quantity: 1, orderType: "LIMIT", userLogin: "boss" },
      { orderId: "o-stop", symbol: "AAPL", action: "BUY" as const, quantity: 1, orderType: "STOP", userLogin: "boss" },
    ]) {
      const res = await alpaca.placeOrderRemote(params);
      expect(res.success).toBe(false);
      expect(res.brokerOrderRef).toBe("");
    }
    expect(calls).toHaveLength(0);
  });

  it("executeOrder approval failure is unchanged (the #2389 honest failure)", async () => {
    const orm = makeOrm("sess_3158");
    const id = seedPreviewedTrade(orm, "alp_ord_2389pin");
    const alpaca = new AlpacaTradingPlatform(NO_KEYS_ENV, orm, "boss");
    const res = await alpaca.executeOrder(id, "did:user:github:boss", "approved");
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.executionId).toBe("");
    expect(res.brokerOrderRef).toBe("");
    expect(res.message).toMatch(/was NOT executed/);
    expect(orm.trades.findById(id)?.status).toBe("previewed");
  });
});

describe("Alpaca live accounts and positions (#3158)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getAccounts returns the live account, never the hardcoded paper stub", async () => {
    installFetch(async (call) => {
      expect(call.url).toBe("https://paper-api.alpaca.markets/v2/account");
      return jsonResponse(ACCOUNT_OK);
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const accounts = await alpaca.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountId).toBe("acct-live-1");
    expect(accounts[0].accountId).not.toBe("alpaca_paper_01");
    expect(accounts[0].netAccountValue).toBe(260000);
    expect(accounts[0].cashAvailableForInvestment).toBe(120000);
    expect(accounts[0].accountStatus).toBe("ACTIVE");
  });

  it("getPositions returns live mapped positions, never an empty stub", async () => {
    installFetch(async (call) => {
      if (call.url.endsWith("/v2/account")) return jsonResponse(ACCOUNT_OK);
      if (call.url.endsWith("/v2/positions")) return jsonResponse(POSITIONS_OK);
      throw new Error(`unexpected fetch ${call.url}`);
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const { account, positions } = await alpaca.getPositions();
    expect(account.accountId).toBe("acct-live-1");
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("AAPL");
    expect(positions[0].quantity).toBe(10);
    expect(positions[0].pricePaid).toBe(140);
    expect(positions[0].currentPrice).toBe(150);
    expect(positions[0].marketValue).toBe(1500);
    expect(positions[0].unrealizedGainLoss).toBe(100);
  });

  it("unconfigured accounts and positions fail explicit, never fabricated", async () => {
    const calls = installFetch(async () => jsonResponse(ACCOUNT_OK));
    const alpaca = new AlpacaTradingPlatform(NO_KEYS_ENV, undefined, "boss");
    await expect(alpaca.getAccounts()).rejects.toThrow(/not configured/);
    await expect(alpaca.getPositions()).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it("status reports paper by default and live only for a non-paper base URL", async () => {
    const unset = new AlpacaTradingPlatform(NO_KEYS_ENV, undefined, "boss");
    const unsetStatus = await unset.getStatus();
    expect(unsetStatus.environment).toBe("paper");
    expect(unsetStatus.apiUrl).toBe("https://paper-api.alpaca.markets");
    const live = new AlpacaTradingPlatform(LIVE_ENV, undefined, "boss");
    const liveStatus = await live.getStatus();
    expect(liveStatus.environment).toBe("live");
    expect(liveStatus.apiUrl).toBe("https://api.alpaca.markets");
    const paper = new AlpacaTradingPlatform(PAPER_HOST_ENV, undefined, "boss");
    expect((await paper.getStatus()).environment).toBe("paper");
  });
});
