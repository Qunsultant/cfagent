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
import { upsertAccountBinding } from "../src/services/accountBindings";

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

/**
 * Issue #5100 (F3 of #5094): the route now refuses unbound previews
 * and executions, so tests that exercise a successful preview/execute
 * build their context on a SESSION_STORE stub with alice's Alpaca
 * accounts bound (paper + live, stock + options, tenant scope).
 * Tests that assert a refusal use the unbound baseCtx instead.
 */
async function boundCtx(store: ReturnType<typeof makeStore>): Promise<BrokerOrderRouteContext> {
  const env = { SESSION_STORE: makeMemoryDoNamespace() } as any;
  for (const binding of [
    { broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountId: "PA-900" },
    { broker: "alpaca", mode: "live", accountType: "stock", scope: "tenant", accountId: "PA-900" },
    { broker: "alpaca", mode: "paper", accountType: "options", scope: "tenant", accountId: "PA-900" },
    { broker: "alpaca", mode: "live", accountType: "options", scope: "tenant", accountId: "PA-900" },
    // A legacy draft without a broker defaults to etrade at execute
    // time, so the legacy-refusal test needs an etrade binding too.
    { broker: "etrade", mode: "paper", accountType: "stock", scope: "tenant", accountId: "ET-123" },
  ] as const) {
    await upsertAccountBinding(env, "alice", binding);
  }
  return { ...baseCtx(store), env } as BrokerOrderRouteContext;
}

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
    // Issue #5100 (F3 of #5094): the broker's enumerated accounts, for
    // explicit-accountId validation at preview time.
    getAccounts: vi.fn(async () => [
      { accountId: "PA-900", accountType: "stock", broker },
      { accountId: "PA-901", accountType: "stock", broker, owned: false },
    ]),
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
      await boundCtx(store),
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
    // Issue #5100 (F3 of #5094): the resolved binding tuple rides the draft.
    expect((stored as Row).accountId).toBe("PA-900");
    expect((stored as Row).accountType).toBe("stock");
    expect((stored as Row).bindingScope).toBe("copilot");
    expect((stored as Row).bindingSource).toBe("binding");
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
      await boundCtx(store),
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
      await boundCtx(store),
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
      { id: "alp_ord_1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", mode: "paper", accountType: "stock", accountId: "PA-900", bindingScope: "copilot", bindingSource: "binding", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "alp_ord_1", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      await boundCtx(store),
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

  it("execute on a legacy draft without a binding stamp is refused with re-preview required (#5100)", async () => {
    const store = makeStore([
      { id: "pv_old", symbol: "OLD", action: "BUY", orderType: "MARKET", quantity: 1, price: 50, totalValue: 50, status: "previewed", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", { orderId: "pv_old", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      await boundCtx(store),
    );
    // Issue #5100 (F3 of #5094): a pre-F3 draft carries no stamped
    // tuple, so execute cannot prove its account — fail closed with
    // the coded refusal and a re-preview message, never a default
    // broker. (Pre-F3 this defaulted to etrade and executed.)
    expect(res!.status).toBe(404);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(body.error).toMatch(/fresh preview is required/i);
    expect(calls.execute).toEqual([]);
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

/** Issue #4532 (slice 2): the live/paper mode is stamped on the stored draft at preview time. */
describe("preview stamps the trade mode (#4532 slice 2)", () => {
  const prodCtx = async (store: ReturnType<typeof makeStore>): Promise<BrokerOrderRouteContext> =>
    ({
      ...(await boundCtx(store)),
      readSettingRaw: (key: string) => (key === "etrade:environment" ? "PROD" : null),
    }) as BrokerOrderRouteContext;

  const previewAlpaca = (ctx: BrokerOrderRouteContext) =>
    handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", { broker: "alpaca", symbol: "ACME", quantity: 2, orderAction: "BUY" }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      ctx,
    );

  it("preview with no stored environment (TEST default) stamps paper on the stored draft", async () => {
    const store = makeStore();
    const res = await previewAlpaca(await boundCtx(store));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    const stored = store.trades.findById(body.orderId);
    expect(stored).not.toBeNull();
    expect((stored as Row).mode).toBe("paper");
  });

  it("preview with a stored PROD environment stamps live on the stored draft", async () => {
    const store = makeStore();
    const res = await previewAlpaca(await prodCtx(store));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    const stored = store.trades.findById(body.orderId);
    expect(stored).not.toBeNull();
    expect((stored as Row).mode).toBe("live");
  });

  it("re-preview under another environment re-stamps the mode on the existing draft", async () => {
    const store = makeStore([
      { id: "alpaca_ord_1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 2, price: 100, totalValue: 200, status: "previewed", broker: "alpaca", mode: "paper", createdAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" },
    ]);
    const res = await previewAlpaca(await prodCtx(store));
    expect(res!.status).toBe(200);
    const stored = store.trades.findById("alpaca_ord_1");
    expect((stored as Row).mode).toBe("live");
    expect((stored as Row).broker).toBe("alpaca");
    // Issue #5100 (F3 of #5094): the re-preview re-stamps the tuple too.
    expect((stored as Row).accountId).toBe("PA-900");
    expect((stored as Row).accountType).toBe("stock");
  });

  it("orders listing returns the stamped mode and leaves legacy rows without one", async () => {
    const store = makeStore([
      { id: "d1", symbol: "ACME", action: "BUY", orderType: "MARKET", quantity: 1, price: 100, totalValue: 100, status: "previewed", broker: "alpaca", mode: "live", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
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
    expect(byId.d1.mode).toBe("live");
    expect(byId.d0.mode).toBeUndefined();
  });
});

/** Issue #5100 (F3 of #5094): previews and executions enforce the bound account. */
describe("order preview/execute enforce the bound account (#5100)", () => {
  const previewReq = (body: Record<string, unknown>, ctx: BrokerOrderRouteContext, store: ReturnType<typeof makeStore>) =>
    handleBrokerOrderRoutes(
      req("POST", "/broker/order/preview", body),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      ctx,
    );

  const executeReq = (body: Record<string, unknown>, ctx: BrokerOrderRouteContext) =>
    handleBrokerOrderRoutes(
      req("POST", "/broker/order/execute", body),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      ctx,
    );

  const stampedDraft = (overrides: Row = {}) => ({
    id: "alp_ord_1",
    symbol: "ACME",
    action: "BUY",
    orderType: "MARKET",
    quantity: 1,
    price: 100,
    totalValue: 100,
    status: "previewed",
    broker: "alpaca",
    mode: "paper",
    accountType: "stock",
    accountId: "PA-900",
    bindingScope: "copilot",
    bindingSource: "binding",
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  });

  it("preview unbound is refused with the coded failure, never a draft", async () => {
    const store = makeStore();
    const res = await previewReq(
      { broker: "alpaca", symbol: "ACME", quantity: 1, orderAction: "BUY" },
      baseCtx(store),
      store,
    );
    expect(res!.status).toBe(404);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(calls.preview).toEqual([]);
    expect(store.trades.findMany()).toEqual([]);
  });

  it("preview with an explicit accountId the broker does not enumerate is refused (404)", async () => {
    const store = makeStore();
    const res = await previewReq(
      { broker: "alpaca", symbol: "ACME", quantity: 1, orderAction: "BUY", accountId: "PA-NOPE" },
      await boundCtx(store),
      store,
    );
    expect(res!.status).toBe(404);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(calls.preview).toEqual([]);
    expect(store.trades.findMany()).toEqual([]);
  });

  it("preview with an explicit unowned accountId is refused (403)", async () => {
    const store = makeStore();
    const res = await previewReq(
      { broker: "alpaca", symbol: "ACME", quantity: 1, orderAction: "BUY", accountId: "PA-901" },
      await boundCtx(store),
      store,
    );
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ACCOUNT_UNOWNED");
    expect(calls.preview).toEqual([]);
  });

  it("preview with an explicit enumerated accountId proceeds and stamps it", async () => {
    const store = makeStore();
    const res = await previewReq(
      { broker: "alpaca", symbol: "ACME", quantity: 1, orderAction: "BUY", accountId: "PA-900" },
      await boundCtx(store),
      store,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(calls.preview).toEqual(["alpaca"]);
    const stored = store.trades.findById(body.orderId);
    expect((stored as Row).accountId).toBe("PA-900");
    expect((stored as Row).bindingSource).toBe("explicit");
  });

  it("execute with a re-bound account is refused (409) and names the previewed account, masked", async () => {
    const store = makeStore([stampedDraft()]);
    const ctx = await boundCtx(store);
    // The tenant re-binds the same slot to another account after preview.
    await upsertAccountBinding(ctx.env, "alice", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "tenant",
      accountId: "PA-901",
    });
    const res = await executeReq({ orderId: "alp_ord_1", decision: "approved" }, ctx);
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.error).toMatch(/fresh preview is required/i);
    expect(body.error).not.toContain("PA-900");
    expect(calls.execute).toEqual([]);
  });

  it("execute unbound is refused with the coded failure", async () => {
    const store = makeStore([stampedDraft()]);
    const res = await executeReq({ orderId: "alp_ord_1", decision: "approved" }, baseCtx(store));
    expect(res!.status).toBe(404);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(calls.execute).toEqual([]);
  });
});
