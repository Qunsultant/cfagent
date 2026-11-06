/**
 * Issue #3422 — Stock Copilot status/control routes.
 *
 * Pins:
 * - The handler returns null for non-matching paths (the router
 *   keeps routing), and fails closed (401) when the instance holds
 *   no verified login context — no status leaks, no control writes.
 * - GET /stock-copilot/status composes flag state, per-instance
 *   pause state, market-open state, open positions WITH exit plans,
 *   recently closed positions, and recent cycle activity.
 * - #3451: the status also reports the effective trading selection
 *   (active broker + mode) and the named mode_unresolved /
 *   inactive_broker states.
 * - POST /stock-copilot/control writes the caller's OWN instance
 *   control record through the data-layer port (per-login scoped),
 *   validates the body, and audits the change.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import { StockCopilotPositionStore } from "../src/services/stockCopilotStore";

/** Minimal SqlStorage shim over node:sqlite (same shape as #2528's harness). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const STATUS_PATH = "/api/stock-copilot/status";
const CONTROL_PATH = "/api/stock-copilot/control";

/** The #3451 selection readers for the default ctx: Alpaca is the
 *  tenant's active broker and the stored trade environment is TEST
 *  (paper) — the state in which the pre-#3451 status composition
 *  (paused / outside-hours / live) applies. */
async function alpacaCommercial(): Promise<InMemoryCommercialAdapter> {
  const commercial = new InMemoryCommercialAdapter();
  await commercial.setTenantProviders(resolveIaaaTenant({}), {
    dataProviderId: "etrade",
    brokerId: "alpaca",
  });
  return commercial;
}

async function makeCtx(overrides: Partial<StockCopilotRouteContext> = {}) {
  const sql = new SqliteTestStorage();
  const ctx: StockCopilotRouteContext = {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as StockCopilotRouteContext["env"],
    sql: sql as never,
    getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    readSettingRaw: (key: string) =>
      key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : null,
    commercial: await alpacaCommercial(),
    audit: vi.fn(),
    ...overrides,
  };
  return { ctx, sql };
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const call = (ctx: StockCopilotRouteContext, request: Request) => {
  const url = new URL(request.url);
  return handleStockCopilotRoutes(request, url, url.pathname, "session-1", ctx);
};

async function seed(sql: SqliteTestStorage) {
  const positions = createStockCopilotPositionPort(sql as never);
  const store = new StockCopilotPositionStore(positions);
  const open = await store.openPosition({
    userLogin: "owner",
    symbol: "TEST",
    strategy: "mean_reversion",
    quantity: 10,
    entryPrice: 98,
    stopPrice: 93.1,
    targetPrice: 107.8,
    brokerOrderRef: "alpaca-entry",
    openedAt: "2026-11-04T14:30:00.000Z",
  });
  const closedRow = await store.openPosition({
    userLogin: "owner",
    symbol: "OLD",
    strategy: "sma_crossover",
    quantity: 5,
    entryPrice: 100,
    stopPrice: 95,
    targetPrice: 110,
    brokerOrderRef: "alpaca-entry-2",
    openedAt: "2026-11-03T15:00:00.000Z",
  });
  await store.closePosition(closedRow.id, {
    exitBrokerOrderRef: "alpaca-exit-2",
    exitPrice: 110,
    exitReason: "take_profit",
    closedAt: "2026-11-04T14:45:00.000Z",
  });
  const activity = createStockCopilotActivityPort(sql as never);
  activity.ensureSchema();
  activity.appendActivity({
    id: "a1",
    userLogin: "owner",
    cycleAt: "2026-11-04T15:00:00.000Z",
    outcome: "traded",
    entries: ["TEST"],
    exits: [],
    detail: null,
  });
  return { open };
}

describe("stock copilot routes (#3422)", () => {
  it("returns null for non-matching paths so the router keeps routing", async () => {
    const { ctx } = await makeCtx();
    expect(await call(ctx, req("GET", "/api/audit"))).toBeNull();
    expect(await call(ctx, req("GET", "/api/stock-copilot"))).toBeNull();
    expect(await call(ctx, req("DELETE", STATUS_PATH))).toBeNull();
  });

  it("fails closed (401) with no verified login context — status and control alike", async () => {
    const { ctx, sql } = await makeCtx({
      getScreenerExecutionContext: async () => undefined,
    });
    const status = await call(ctx, req("GET", STATUS_PATH));
    expect(status?.status).toBe(401);
    const control = await call(ctx, req("POST", CONTROL_PATH, { paused: true }));
    expect(control?.status).toBe(401);
    // The rejected write left no control record behind.
    const port = createStockCopilotControlPort(sql as never);
    port.ensureSchema();
    expect(port.getControl("owner")).toBeNull();
  });

  it("status composes flag, pause, market, positions with exit plans, closed, activity", async () => {
    const { ctx, sql } = await makeCtx();
    await seed(sql);
    const res = await call(ctx, req("GET", STATUS_PATH));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.flagEnabled).toBe(true);
    expect(body.paused).toBe(false);
    expect(body.userLogin).toBe("owner");
    // #3451: the effective selection rides the status read.
    expect(body.selectionResolved).toBe(true);
    expect(body.activeBroker).toBe("alpaca");
    expect(body.activeMode).toBe("paper");
    expect(typeof body.marketOpen).toBe("boolean");
    // Status derivation is consistent with the market state it reports.
    expect(body.status).toBe(body.marketOpen ? "live" : "outside_market_hours");

    expect(body.openPositions).toHaveLength(1);
    expect(body.openPositions[0]).toMatchObject({
      symbol: "TEST",
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      openedAt: "2026-11-04T14:30:00.000Z",
    });
    expect(body.closedPositions).toHaveLength(1);
    expect(body.closedPositions[0]).toMatchObject({
      symbol: "OLD",
      exitReason: "take_profit",
      exitPrice: 110,
    });
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]).toMatchObject({ outcome: "traded", entries: ["TEST"] });
  });

  it("status reports off when the global flag is unset", async () => {
    const { ctx } = await makeCtx({ env: {} as StockCopilotRouteContext["env"] });
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.flagEnabled).toBe(false);
    expect(body.status).toBe("off");
  });

  it("pause write round-trips: status shows paused, the change is audited", async () => {
    const { ctx } = await makeCtx();
    const write = await call(ctx, req("POST", CONTROL_PATH, { paused: true }));
    expect(write?.status).toBe(200);
    expect(await write!.json()).toMatchObject({ ok: true, paused: true });
    expect(ctx.audit).toHaveBeenCalledWith(
      "stock_copilot.control",
      "orchestrator",
      expect.objectContaining({ userLogin: "owner", paused: true }),
    );
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.paused).toBe(true);
    expect(body.status).toBe("paused");

    const resume = await call(ctx, req("POST", CONTROL_PATH, { paused: false }));
    expect(resume?.status).toBe(200);
    const after = (await (await call(ctx, req("GET", STATUS_PATH)))!.json()) as any;
    expect(after.paused).toBe(false);
    expect(after.status).not.toBe("paused");
  });

  it("control writes are scoped to the caller's own login", async () => {
    const sql = new SqliteTestStorage();
    const owner = (await makeCtx({ sql: sql as never })).ctx;
    await call(owner, req("POST", CONTROL_PATH, { paused: true }));
    const other = (await makeCtx({
      sql: sql as never,
      getScreenerExecutionContext: async () => ({ userLogin: "other", environment: "TEST" as const }),
    })).ctx;
    const body = (await (await call(other, req("GET", STATUS_PATH)))!.json()) as any;
    expect(body.paused).toBe(false);
    expect(body.userLogin).toBe("other");
  });

  it("status reports the LIVE selection when the stored trade environment is PROD (#3451)", async () => {
    const { ctx } = await makeCtx({
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY ? "PROD" : null,
    });
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.selectionResolved).toBe(true);
    expect(body.activeBroker).toBe("alpaca");
    expect(body.activeMode).toBe("live");
  });

  it("status reports inactive_broker when the tenant's active broker is not alpaca (#3451)", async () => {
    const etrade = new InMemoryCommercialAdapter();
    await etrade.setTenantProviders(resolveIaaaTenant({}), {
      dataProviderId: "etrade",
      brokerId: "etrade",
    });
    const { ctx } = await makeCtx({ commercial: etrade });
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.status).toBe("inactive_broker");
    expect(body.selectionResolved).toBe(true);
    expect(body.activeBroker).toBe("etrade");
    expect(body.activeMode).toBe("paper");
  });

  it("status reports mode_unresolved when the broker selection cannot be read (#3451)", async () => {
    const { ctx } = await makeCtx({ commercial: null });
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.status).toBe("mode_unresolved");
    expect(body.selectionResolved).toBe(false);
    expect(body.activeBroker).toBeNull();
    expect(body.activeMode).toBeNull();
  });

  it("control write validates the body (paused must be a boolean)", async () => {
    const { ctx, sql } = await makeCtx();
    const bad = await call(ctx, req("POST", CONTROL_PATH, { paused: "yes" }));
    expect(bad?.status).toBe(400);
    const empty = await call(ctx, req("POST", CONTROL_PATH, {}));
    expect(empty?.status).toBe(400);
    const port = createStockCopilotControlPort(sql as never);
    port.ensureSchema();
    expect(port.getControl("owner")).toBeNull();
  });
});
