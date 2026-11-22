/**
 * Issue #4656 — Gap 5 of #4634: "No user-facing TIF anywhere".
 *
 * The ticket has offered a time-in-force since #4573 (`OrderTicketModel.orderTif`,
 * the select, and `buildOrderPreviewBody` always sends `timeInForce`), but the
 * server dropped the value: the preview route never parsed it, the draft row had
 * nowhere to keep it, execute forwarded nothing, E*TRADE hardcoded
 * `GOOD_FOR_DAY`, and Public sent nothing at all. Pinned here, end to end:
 *
 *  - the canonical vocabulary is one module (`src/trading/timeInForce.ts`), and a
 *    value outside it is a named 400 — never silently a day order;
 *  - a TIF the broker's own capability matrix does not list is refused at the
 *    route, from the SAME table the ticket renders;
 *  - the approved value is stored on the draft and reaches `placeOrderRemote`;
 *  - E*TRADE maps day/gtc/ioc onto its own orderTerm, and FOK is not offered
 *    because this client has no verified FOK term;
 *  - Public — whose hosted schema is unverified for TIF — refuses anything but
 *    the default by name instead of placing a silent day order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBrokerOrderRoutes, type BrokerOrderRouteContext } from "../src/agents/routes/brokerOrders";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { upsertAccountBinding } from "../src/services/accountBindings";
import { normalizeTimeInForce, TIME_IN_FORCE_VALUES } from "../src/trading";
import { etradeOrderTerm } from "../src/trading/etrade/platform";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { publicAuctionOrderType, publicSingleLegArgs } from "../src/services/publicTrading";
import { orderCapabilitiesFor } from "../src/config/orderCapabilities";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

function makeStore(initial: Row[] = []) {
  const rows = new Map<string, Row>();
  for (const r of initial) rows.set(r.id as string, { ...r });
  return {
    rows,
    trades: {
      create: (rec: Row) => {
        rows.set(rec.id as string, { ...rec });
        return rec;
      },
      update: (id: string, patch: Row) => {
        const cur = rows.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch };
        rows.set(id, next);
        return next;
      },
      findById: (id: string) => rows.get(id) ?? null,
      findMany: () => [...rows.values()],
    },
  };
}

const baseCtx = (store: ReturnType<typeof makeStore>): BrokerOrderRouteContext =>
  ({
    env: {} as never,
    getOrm: () => ({ trades: store.trades }) as never,
    readSettingRaw: () => null,
    audit: vi.fn(),
    getScreenerAgent: () => ({}) as never,
    persistScreenerReportCanonical: vi.fn(),
    evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as never,
    getAutopilotState: () => ({ running: false }),
    incrementAutopilotOrdersToday: vi.fn(),
    schedule: async () => ({ id: "sched-1" }) as never,
    cancelSchedule: async () => true,
  }) as BrokerOrderRouteContext;

/** The #5112 in-memory DO-namespace stub, for seeding bindings. */
function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

/**
 * Issue #5100 (F3 of #5094): the route refuses unbound previews and
 * executions, so the chain test builds its context on a
 * SESSION_STORE stub with alice's Alpaca paper stock account bound.
 */
async function boundCtx(store: ReturnType<typeof makeStore>): Promise<BrokerOrderRouteContext> {
  const env = { SESSION_STORE: makeMemoryDoNamespace() } as never;
  await upsertAccountBinding(env as never, "alice", {
    broker: "alpaca",
    mode: "paper",
    accountType: "stock",
    scope: "tenant",
    accountId: "PA-900",
  });
  return { ...baseCtx(store), env } as BrokerOrderRouteContext;
}

const req = (path: string, body: unknown, login = "alice") =>
  new Request(`https://agent.internal${path}`, {
    method: "POST",
    headers: { "x-user-login": login, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function stubPlatform() {
  const previewed: any[] = [];
  const placed: any[] = [];
  return {
    previewed,
    placed,
    platform: {
      platformId: "alpaca",
      name: "alpaca",
      previewOrder: vi.fn(async (params: any) => {
        previewed.push(params);
        return {
          orderId: "tif_draft",
          symbol: params.symbol,
          action: params.orderAction || params.action || "BUY",
          orderAction: params.orderAction || params.action || "BUY",
          orderType: params.orderType || "MARKET",
          quantity: params.quantity,
          estimatedPrice: 100,
          estimatedTotal: 100 * params.quantity,
          status: "previewed",
          proposerDid: "did:agent:openaimp:trading",
          authorizerDid: "did:user:github:alice",
          proofSignature: "sig_stub",
          previewMessage: "stub preview",
        };
      }),
      placeOrderRemote: vi.fn(async (params: any) => {
        placed.push(params);
        return {
          success: true,
          orderId: params.orderId,
          executionId: "exec-1",
          brokerOrderRef: "exec-1",
          authorizerDid: "did:user:github:alice",
          status: "executed",
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          executionPrice: 100,
          totalSettled: 1000,
          message: "placed",
          timestamp: new Date().toISOString(),
        };
      }),
      executeOrder: vi.fn(),
    },
  };
}

describe("#4656 — the canonical vocabulary is one module and fails closed", () => {
  it("normalizes case and whitespace, and refuses anything outside the set", () => {
    expect(normalizeTimeInForce("GTC")).toBe("gtc");
    expect(normalizeTimeInForce(" day ")).toBe("day");
    expect(normalizeTimeInForce(undefined)).toBeUndefined();
    expect(normalizeTimeInForce("")).toBeUndefined();
    expect(normalizeTimeInForce("sweep")).toBeUndefined();
    // Issue #4671 added the two auction values — the vocabulary is one list, so
    // the auction capability cannot exist as a parallel token set.
    expect(TIME_IN_FORCE_VALUES).toEqual(["day", "gtc", "ioc", "fok", "opg", "cls"]);
  });

  it("no longer offers E*TRADE a fill-or-kill it cannot put on the wire", () => {
    const etrade = orderCapabilitiesFor({ brokerId: "etrade", mode: "live", assetClass: "equity" });
    // Since #4957 the auction values are listed too (they are E*TRADE price types,
    // not order terms); FOK is still the one term this broker has no value for.
    expect(etrade.timeInForce).toEqual(["DAY", "GTC", "IOC", "OPG", "CLS"]);
    // Alpaca's own time_in_force enum does carry fok, so it keeps it.
    const alpaca = orderCapabilitiesFor({ brokerId: "alpaca", mode: "live", assetClass: "equity" });
    expect(alpaca.timeInForce).toContain("FOK");
  });

  it("maps the canonical token onto E*TRADE's orderTerm, with no FOK term", () => {
    expect(etradeOrderTerm("day")).toBe("GOOD_FOR_DAY");
    expect(etradeOrderTerm("gtc")).toBe("GOOD_UNTIL_CANCEL");
    expect(etradeOrderTerm("ioc")).toBe("IMMEDIATE_OR_CANCEL");
    expect(etradeOrderTerm("fok")).toBeUndefined();
    expect(etradeOrderTerm(undefined)).toBeUndefined();
  });
});

describe("#4656 — the approved time-in-force survives preview → draft → execute", () => {
  let stub: ReturnType<typeof stubPlatform>;

  beforeEach(() => {
    stub = stubPlatform();
    TradingPlatformRegistry.register("alpaca", () => stub.platform as never);
    TradingPlatformRegistry.register("etrade", () => stub.platform as never);
  });

  it("passes the normalized value to the platform and stores it on the draft", async () => {
    const store = makeStore();
    const ctx = await boundCtx(store);
    const res = await handleBrokerOrderRoutes(
      req("/broker/order/preview", {
        broker: "alpaca",
        symbol: "ACME",
        quantity: 1,
        orderAction: "BUY",
        orderType: "LIMIT",
        limitPrice: 100,
        timeInForce: "GTC",
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(stub.previewed[0].timeInForce).toBe("gtc");
    const draft = await res!.json();
    expect((store.trades.findById(draft.orderId) as Row).timeInForce).toBe("gtc");

    const exec = await handleBrokerOrderRoutes(
      req("/broker/order/execute", { orderId: draft.orderId, decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      ctx,
    );
    expect(exec!.status).toBe(200);
    expect(stub.placed[0].timeInForce).toBe("gtc");
  });

  it("refuses a value outside the vocabulary with a named 400, before the platform", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("/broker/order/preview", {
        broker: "alpaca",
        symbol: "ACME",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 100,
        timeInForce: "SWEEP",
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(400);
    expect(String((await res!.json()).error)).toMatch(/Unsupported timeInForce/i);
    expect(stub.previewed).toHaveLength(0);
  });

  it("refuses a TIF the broker's capability matrix does not list (E*TRADE FOK)", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("/broker/order/preview", {
        broker: "etrade",
        symbol: "ACME",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 100,
        timeInForce: "FOK",
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(400);
    expect(String((await res!.json()).error)).toMatch(/does not accept FOK/i);
    expect(stub.previewed).toHaveLength(0);
  });
});

describe("#4656 — Public refuses a TIF it cannot honour, by name", () => {
  function publicPlatform() {
    return new PublicTradingPlatform({} as Env, undefined, "owner@example.com", "PROD", {
      accessTokenProvider: async () => "pat-token",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      sleep: async () => undefined,
    });
  }

  it("refuses a non-default TIF without expiry (gtd) at preview", async () => {
    await expect(
      publicPlatform().previewOrder({ symbol: "AAPL", quantity: 1, orderType: "LIMIT", limitPrice: 100, timeInForce: "gtd" as any }),
    ).rejects.toThrow(/PUBLIC_TIME_IN_FORCE_UNVERIFIED/);
  });

  it("refuses a non-default TIF without expiry (gtd) at placement with a failed receipt (never a silent day order)", async () => {
    const receipt = await publicPlatform().placeOrderRemote({
      orderId: "draft-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 100,
      timeInForce: "gtd" as any,
      userLogin: "owner@example.com",
    });
    expect(receipt.success).toBe(false);
    expect(receipt.message).toMatch(/PUBLIC_TIME_IN_FORCE_UNVERIFIED/);
  });

  // Issue #4958 (matrix gap 17): Public DOCUMENTS the on-close order types
  // (MARKET_ON_CLOSE / LIMIT_ON_CLOSE) and no on-open type at all, so 'cls' is
  // carried and 'opg' is refused by name against the broker's own documented set.
  it("carries a MOC as Public's documented MARKET_ON_CLOSE type", async () => {
    const placed = await publicPlatform().placeOrderRemote({
      orderId: "draft-moc",
      symbol: "AAPL",
      action: "SELL",
      quantity: 10,
      orderType: "MARKET",
      timeInForce: "cls",
      userLogin: "owner@example.com",
    });
    // Not a time-in-force refusal: the term is expressible on this broker.
    expect(String(placed.message)).not.toMatch(/PUBLIC_AUCTION_ON_OPEN_UNSUPPORTED|PUBLIC_TIME_IN_FORCE_UNVERIFIED/);
  });

  it("puts the broker's on-close type on the wire, not a silent MARKET", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      // The client lists the tools first and refuses anything it did not see,
      // so the stub answers tools/list with the placement tool.
      const result =
        body?.method === "tools/list"
          ? {
              tools: [
                {
                  name: "place_order",
                  inputSchema: {
                    type: "object",
                    properties: {
                      symbol: { type: "string" },
                      instrument_type: { type: "string" },
                      order_side: { type: "string" },
                      order_type: { type: "string" },
                      quantity: { type: "number" },
                      limit_price: { type: "number" },
                    },
                  },
                },
                { name: "preflight_order", inputSchema: { type: "object", properties: {} } },
              ],
            }
          : { content: [{ type: "text", text: JSON.stringify({ orderId: "ord-moc", status: "NEW" }) }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const platform = new PublicTradingPlatform({} as Env, undefined, "owner@example.com", "PROD", {
      accessTokenProvider: async () => "pat-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    await platform.placeOrderRemote({
      orderId: "draft-wire",
      symbol: "AAPL",
      action: "SELL",
      quantity: 10,
      orderType: "MARKET",
      timeInForce: "cls",
      userLogin: "owner@example.com",
    });
    const call = bodies.find((body) => body?.method === "tools/call");
    expect(call, "a tools/call reached the Public MCP client").toBeDefined();
    expect(JSON.stringify(call)).toContain("MARKET_ON_CLOSE");
  });
  it("refuses an on-OPEN term by name, citing the broker's documented order types", async () => {
    const receipt = await publicPlatform().placeOrderRemote({
      orderId: "draft-moo",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      timeInForce: "opg",
      userLogin: "owner@example.com",
    });
    expect(receipt.success).toBe(false);
    expect(receipt.message).toMatch(/PUBLIC_AUCTION_ON_OPEN_UNSUPPORTED/);
    // The reason names what Public DOES document (on-close) and what it does not (on-open).
    expect(receipt.message).toMatch(/on-close order types \(MARKET_ON_CLOSE, LIMIT_ON_CLOSE\) and no on-open type/);
  });

  it("still refuses GTD without an expiration_time", async () => {
    const receipt = await publicPlatform().placeOrderRemote({
      orderId: "draft-gtd",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 100,
      timeInForce: "gtd" as any,
      userLogin: "owner@example.com",
    });
    expect(receipt.success).toBe(false);
    expect(receipt.message).toMatch(/PUBLIC_TIME_IN_FORCE_UNVERIFIED/);
  });

  it("derives the broker's on-close type from the pair, and nothing for on-open", () => {
    expect(publicAuctionOrderType("MARKET", "cls")).toBe("MARKET_ON_CLOSE");
    expect(publicAuctionOrderType("LIMIT", "cls")).toBe("LIMIT_ON_CLOSE");
    expect(publicAuctionOrderType("MARKET", "opg")).toBeNull();
    expect(publicAuctionOrderType("STOP", "cls")).toBeNull();
  });

  it("the single-leg spec carries the on-close type through (no silent MARKET)", () => {
    const moc = publicSingleLegArgs({
      symbol: "AAPL",
      assetClass: "equity",
      action: "SELL",
      quantity: 10,
      orderType: "MARKET_ON_CLOSE",
    });
    expect(moc.order_type.value).toBe("MARKET_ON_CLOSE");

    const loc = publicSingleLegArgs({
      symbol: "AAPL",
      assetClass: "equity",
      action: "SELL",
      quantity: 10,
      orderType: "LIMIT_ON_CLOSE",
      limitPrice: 225,
    });
    expect(loc.order_type.value).toBe("LIMIT_ON_CLOSE");
    expect(loc.limit_price?.value).toBe(225);
  });

  it("the capability matrix lists CLS for Public live equity and never OPG", () => {
    const live = orderCapabilitiesFor({ brokerId: "public", mode: "live", assetClass: "equity" });
    expect(live.supported).toBe(true);
    expect(live.timeInForce).toContain("CLS");
    expect(live.timeInForce).not.toContain("OPG");
    // Public has no paper mode, so the TEST matrix stays empty and the ticket
    // offers nothing there.
    expect(orderCapabilitiesFor({ brokerId: "public", mode: "paper", assetClass: "equity" }).supported).toBe(false);
  });
});
