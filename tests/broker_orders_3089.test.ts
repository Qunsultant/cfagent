/**
 * Issue #3089 (S3): broker-routed order endpoints.
 *
 * The UI order path hardwires /api/etrade/* and the server order
 * handlers construct an E*TRADE-only service, so a non-E*TRADE broker
 * selection can never preview or execute. These tests pin the new
 * broker-routed surface: preview/execute/orders resolve the platform
 * from the registry, the broker is stamped on the stored draft, and
 * execution derives the broker from the draft — never from the
 * caller's current selection.
 *
 * Harness follows tests/etrade_broker_routes_extraction.test.ts:
 * the handler is called directly with a fake route context and an
 * in-memory trades store. Stub platforms are registered into the
 * registry (Map.set overwrites the real registrations).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBrokerOrderRoutes, type BrokerOrderRouteContext } from "../src/agents/routes/brokerOrders";
import { TradingPlatformRegistry } from "../src/trading/registry";

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
    env: {} as any,
    getOrm: () => ({ trades: store.trades }) as any,
    readSettingRaw: () => null,
    audit: vi.fn(),
    getScreenerAgent: () => ({}) as any,
    persistScreenerReportCanonical: vi.fn(),
    evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as any,
    getAutopilotState: () => ({ running: false }),
    incrementAutopilotOrdersToday: vi.fn(),
    schedule: async () => ({ id: "sched-1" }) as any,
    cancelSchedule: async () => true,
  }) as BrokerOrderRouteContext;

const req = (method: string, path: string, body?: unknown, login = "alice") =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

const calls = { preview: [] as string[], execute: [] as string[] };

function stubPlatform(broker: string, opts: { throwOnOptions?: boolean } = {}) {
  return {
    platformId: broker,
    name: broker,
    previewOrder: vi.fn(async (params: any) => {
      calls.preview.push(broker);
      if (opts.throwOnOptions && (params.assetClass === "options" || params.optionLegs?.length)) {
        throw new Error("This broker adapter currently supports equity orders only.");
      }
      return {
        orderId: `${broker}_ord_1`,
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
        previewMessage: `${broker} Order Preview: ${params.symbol}.`,
      };
    }),
    executeOrder: vi.fn(async (orderId: string, _did: string, decision: string) => {
      calls.execute.push(broker);
      return {
        success: decision === "approved",
        orderId,
        executionId: decision === "approved" ? `${broker}_exec_1` : "",
        brokerOrderRef: "",
        status: decision === "approved" ? "executed" : "rejected",
        symbol: "ACME",
        action: "BUY",
        quantity: 1,
        executionPrice: 100,
        totalSettled: 100,
        message: `${broker} execute ${decision}`,
        timestamp: new Date().toISOString(),
      };
    }),
  };
}

beforeEach(() => {
  calls.preview.length = 0;
  calls.execute.length = 0;
  TradingPlatformRegistry.register("etrade", () => stubPlatform("etrade") as any);
  TradingPlatformRegistry.register("alpaca", () => stubPlatform("alpaca", { throwOnOptions: true }) as any);
});

describe("broker order routes (#3089)", () => {
  it("preview resolves the requested broker and stamps it on the stored draft", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", { broker: "alpaca", symbol: "ACME", quantity: 2, orderAction: "BUY" }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(res!.status).toBe(200);
    expect(body.broker).toBe("alpaca");
    expect(calls.preview).toEqual(["alpaca"]);
    const stored = store.trades.findById(body.orderId);
    expect(stored).not.toBeNull();
    expect((stored as Row).broker).toBe("alpaca");
    expect((stored as Row).status).toBe("previewed");
  });

  it("preview rejects an unknown broker", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", { broker: "nope", symbol: "ACME", quantity: 1 }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(400);
    expect(calls.preview).toEqual([]);
  });

  it("preview rejects local mode — local preview stays on the legacy E*TRADE route", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", { broker: "etrade", symbol: "ACME", quantity: 1, mode: "local" }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(400);
    expect(calls.preview).toEqual([]);
  });

  it("preview requires the session login", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", { broker: "alpaca", symbol: "ACME", quantity: 1 }, null as any),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(401);
  });

  it("a platform preview failure surfaces as an error, never a fabricated draft", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", {
        broker: "alpaca",
        symbol: "ACME",
        quantity: 1,
        assetClass: "options",
        optionLegs: [{ securityType: "OPTN" }],
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(500);
    const body = await res!.json();
    expect(body.error).toMatch(/equity orders only/);
    expect(store.trades.findMany()).toEqual([]);
  });

  it("an unconfigured broker fails loud and coded on preview (#3669)", async () => {
    TradingPlatformRegistry.register(
      "alpaca",
      () =>
        ({
          platformId: "alpaca",
          name: "alpaca",
          previewOrder: vi.fn(async () => {
            throw new Error("Alpaca credentials are not configured; account data is unavailable.");
          }),
        }) as any,
    );
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", {
        broker: "alpaca",
        symbol: "ACME",
        quantity: 1,
        assetClass: "equity",
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_BROKER_UNAVAILABLE");
    expect(body.broker).toBe("alpaca");
    expect(body.message).toMatch(/Alpaca credentials are not configured/);
    expect(body.message).toMatch(/no other broker was used/i);
    expect(body.retryable).toBe(false);
    expect(store.trades.findMany()).toEqual([]);
  });

  it("orders listing returns stored drafts with their broker", async () => {
    const store = makeStore([
      { id: "d1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
      { id: "d0", symbol: "OLD", action: "SELL", orderType: "LIMIT", quantity: 5, price: 50, totalValue: 250, status: "previewed", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("GET", "/broker/orders"),
      urlOf("/broker/orders"),
      "/broker/orders",
      "alice",
      baseCtx(store),
    );
    const body = await res!.json();
    expect(body.count).toBe(2);
    const byId = Object.fromEntries(body.trades.map((t: any) => [t.id, t]));
    expect(byId.d1.broker).toBe("alpaca");
    expect(byId.d0.broker).toBeUndefined();
  });

  it("execute derives the broker from the draft, not the caller's selection", async () => {
    const store = makeStore([
      { id: "alp_ord_1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "alp_ord_1", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(200);
    expect(calls.execute).toEqual(["alpaca"]);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
  });

  it("execute rejects a broker claim that disagrees with the draft", async () => {
    const store = makeStore([
      { id: "alp_ord_1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "alp_ord_1", decision: "approved", broker: "etrade" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(409);
    expect(calls.execute).toEqual([]);
  });

  it("execute on a legacy draft without a broker defaults to etrade", async () => {
    const store = makeStore([
      { id: "pv_old", symbol: "OLD", action: "BUY", orderType: "MARKET", quantity: 1, price: 50, totalValue: 50, status: "previewed", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "pv_old", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(200);
    expect(calls.execute).toEqual(["etrade"]);
  });

  it("rejection updates the stored draft and never calls platform execute", async () => {
    const store = makeStore([
      { id: "alp_ord_1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "alp_ord_1", decision: "rejected" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      baseCtx(store),
    );
    expect(res!.status).toBe(200);
    expect(calls.execute).toEqual([]);
    expect((store.trades.findById("alp_ord_1") as Row).status).toBe("rejected");
  });

  it("non-owned broker paths return null", async () => {
    const store = makeStore();
    const res = await handleBrokerOrderRoutes(
      req("GET", "/broker/unknown"),
      urlOf("/broker/unknown"),
      "/broker/unknown",
      "alice",
      baseCtx(store),
    );
    expect(res).toBeNull();
  });
});
