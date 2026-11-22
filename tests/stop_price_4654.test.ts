/**
 * Issue #4654 — Gap 4 of #4634: "STOP / STOP_LIMIT stop price is dropped by the
 * ticket on every broker".
 *
 * The ticket types a stop price and the hub never sent it, so a STOP order
 * reached the broker with no trigger and could not be placed from the UI on any
 * broker. Pinned here, end to end:
 *  - the preview body carries `stopPrice` for a stop type and only for one;
 *  - the preview route stores it on the draft row (the only carrier from preview
 *    to execute — the row's `price` is the quote or the limit, never the stop);
 *  - the execute route derives `limitPrice` for LIMIT **and STOP_LIMIT** (it
 *    used to drop it for the latter) and `stopPrice` for STOP/STOP_LIMIT, and
 *    forwards both to the platform's placement call;
 *  - the `mas_trades` schema declares the column in the catalogue AND ships the
 *    guarded ALTER that reaches pre-existing tables.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildOrderPreviewBody, type OrderPreviewInput } from "../src/client/trading/orderPreviewBody";
import { handleBrokerOrderRoutes, type BrokerOrderRouteContext } from "../src/agents/routes/brokerOrders";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { upsertAccountBinding } from "../src/services/accountBindings";
import { ORM_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/ormCatalogue";
import { REMAINDER_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/remainderCatalogue";
import { TRADE_COLUMN_MAP } from "../src/data/ormColumnMaps";

type Row = Record<string, unknown>;

const basePreview: OrderPreviewInput = {
  brokerId: "etrade",
  mode: "paper",
  assetClass: "equity",
  symbol: "acme",
  orderAction: "BUY",
  quantity: 10,
  orderType: "STOP",
  timeInForce: "DAY",
};

describe("#4654 — the ticket's stop price leaves the client", () => {
  it("carries stopPrice for STOP and STOP_LIMIT, and nothing for the other types", () => {
    const stop = buildOrderPreviewBody({ ...basePreview, stopPrice: "95.50" });
    expect(stop.ok).toBe(true);
    if (!stop.ok) return;
    expect(stop.body.stopPrice).toBe("95.50");
    expect(stop.body.limitPrice).toBeUndefined();

    const stopLimit = buildOrderPreviewBody({ ...basePreview, orderType: "STOP_LIMIT", stopPrice: "95.50" });
    expect(stopLimit.ok).toBe(true);
    if (!stopLimit.ok) return;
    expect(stopLimit.body.stopPrice).toBe("95.50");

    for (const orderType of ["LIMIT", "MARKET"] as const) {
      const other = buildOrderPreviewBody({ ...basePreview, orderType, stopPrice: "95.50", limitPrice: "96" });
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.body.stopPrice, orderType).toBeUndefined();
    }
  });
});

/* ------------------------- route chain (preview → execute) ------------------------- */

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
 * executions, so the chain tests build their context on a
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

/** A stub platform that echoes the preview's terms and records the placement call. */
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
          orderId: "alp_ord_stop",
          symbol: params.symbol,
          action: params.orderAction || params.action || "BUY",
          orderAction: params.orderAction || params.action || "BUY",
          orderType: params.orderType || "MARKET",
          quantity: params.quantity,
          estimatedPrice: 100,
          estimatedTotal: 100 * params.quantity,
          stopPrice: params.stopPrice,
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

describe("#4654 — the stop price survives preview → draft → execute", () => {
  let stub: ReturnType<typeof stubPlatform>;

  beforeEach(() => {
    stub = stubPlatform();
    TradingPlatformRegistry.register("alpaca", () => stub.platform as never);
    TradingPlatformRegistry.register("etrade", () => stub.platform as never);
  });

  it("stores the previewed stop price on the draft and forwards it on execute (STOP)", async () => {
    const store = makeStore();
    const ctx = await boundCtx(store);
    const previewRes = await handleBrokerOrderRoutes(
      req("/broker/order/preview", {
        broker: "alpaca",
        symbol: "ACME",
        quantity: 1,
        orderAction: "BUY",
        orderType: "STOP",
        stopPrice: 95.5,
      }),
      urlOf("/broker/order/preview"),
      "/broker/order/preview",
      "alice",
      ctx,
    );
    expect(previewRes!.status).toBe(200);
    expect(stub.previewed[0].stopPrice).toBe(95.5);
    const draft = await previewRes!.json();
    expect((store.trades.findById(draft.orderId) as Row).stopPrice).toBe(95.5);

    const executeRes = await handleBrokerOrderRoutes(
      req("/broker/order/execute", { orderId: draft.orderId, decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      ctx,
    );
    expect(executeRes!.status).toBe(200);
    expect(stub.placed).toHaveLength(1);
    expect(stub.placed[0].stopPrice).toBe(95.5);
    expect(stub.placed[0].limitPrice).toBeUndefined();
  });

  it("keeps the limit price for STOP_LIMIT on execute (it used to be dropped)", async () => {
    const store = makeStore([
      {
        id: "sl_draft",
        symbol: "ACME",
        action: "BUY",
        orderType: "STOP_LIMIT",
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
        stopPrice: 95.5,
        createdAt: "2026-11-16T00:00:00.000Z",
        updatedAt: "2026-11-16T00:00:00.000Z",
      },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("/broker/order/execute", { orderId: "sl_draft", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      await boundCtx(store),
    );
    expect(res!.status).toBe(200);
    expect(stub.placed[0].limitPrice).toBe(100);
    expect(stub.placed[0].stopPrice).toBe(95.5);
  });

  it("falls back to the draft price as the trigger on a legacy stop draft with no stop_price", async () => {
    const store = makeStore([
      {
        id: "legacy_stop",
        symbol: "ACME",
        action: "BUY",
        orderType: "STOP",
        quantity: 1,
        price: 90,
        totalValue: 90,
        status: "previewed",
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        accountId: "PA-900",
        bindingScope: "copilot",
        bindingSource: "binding",
        createdAt: "2026-11-16T00:00:00.000Z",
        updatedAt: "2026-11-16T00:00:00.000Z",
      },
    ]);
    const res = await handleBrokerOrderRoutes(
      req("/broker/order/execute", { orderId: "legacy_stop", decision: "approved" }),
      urlOf("/broker/order/execute"),
      "/broker/order/execute",
      "alice",
      await boundCtx(store),
    );
    expect(res!.status).toBe(200);
    expect(stub.placed[0].stopPrice).toBe(90);
  });
});

describe("#4654 — the draft column is declared once and reaches existing tables", () => {
  it("adds stop_price to the mas_trades CREATE", () => {
    const entry = ORM_CATALOGUE_ENTRIES.find((e) => e.code === "schema.orm.mas_trades.create_table");
    expect(entry).toBeTruthy();
    expect(entry!.statement).toContain("stop_price REAL");
  });

  it("ships the guarded ALTER for pre-existing tables, and maps the column", () => {
    const alter = REMAINDER_CATALOGUE_ENTRIES.find(
      (e) => e.code === "schema.orm.mas_trades.alter_table_add_column_stop_price",
    );
    expect(alter).toBeTruthy();
    expect(alter!.statement).toBe("ALTER TABLE mas_trades ADD COLUMN stop_price REAL");
    expect(TRADE_COLUMN_MAP.stopPrice).toBe("stop_price");
  });
});
