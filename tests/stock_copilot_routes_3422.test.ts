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
 *   inactive_broker states. Follow-up (owner clarification): with
 *   no broker selection stored, the reported selection is the
 *   copilot default — alpaca/paper — from the same resolver the
 *   cycle consumes.
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
import { COPILOT_SESSIONS } from "../src/services/stockCopilotSessions";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { STOCK_COPILOT_TASK_ID } from "../src/agents/orchestrator/scheduledTasksCopilot";
import { upsertAccountBinding } from "../src/services/accountBindings";

/** Minimal D1Database stand-in over node:sqlite (the #6101 double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

/** The D1 run-ledger store over one mock binding (#6101). */
function ledgerD1(d1: MockD1Database) {
  return new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
}

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

/** A ctx whose env carries a binding store seeded for the owner. */
async function boundCtx() {
  const { ctx, sql, d1 } = await makeCtx({
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      SESSION_STORE: makeMemoryDoNamespace(),
    } as StockCopilotRouteContext["env"],
  });
  await upsertAccountBinding(ctx.env as never, "owner", {
    broker: "alpaca",
    mode: "paper",
    accountType: "stock",
    scope: "tenant",
    accountId: "PA-900",
  });
  return { ctx, sql, d1 };
}

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
  // Issue #6101 — the status route reads the D1 ledger: every ctx
  // carries a bound mock AGENT_DB, added on top of whatever env the
  // caller supplied — so the flag-off test's `env: {}` still unsets
  // the flag while keeping the ledger binding.
  const d1 = new MockD1Database();
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
  (ctx.env as unknown as Record<string, unknown>).AGENT_DB = d1;
  return { ctx, sql, d1 };
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

async function seed(sql: SqliteTestStorage, d1: MockD1Database) {
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
  // Issue #5085 (S6): the Loop status reads the runs ledger, so
  // the live lastCycle comes from a cycle ledger row, not the
  // activity record above (the activity feed stays as detail).
  // Issue #6101 — the row is seeded in D1, the only ledger now.
  const ledger = ledgerD1(d1);
  await ledger.record(
    buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: STOCK_COPILOT_TASK_ID,
      operation: STOCK_COPILOT_TASK_ID,
      started: "2026-11-04T15:00:00.000Z",
      finished: "2026-11-04T15:00:00.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      trigger: "scheduled",
      scheduleId: STOCK_COPILOT_TASK_ID,
      asyncJobId: null,
      workflowId: null,
      descriptor: "cycle complete: traded",
    }),
  );
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
    const { ctx, sql, d1 } = await makeCtx();
    await seed(sql, d1);
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
    // #3398: the status derivation follows the session state it
    // reports — live only inside one of the user's enabled
    // sessions (default: regular only), the named outside state
    // otherwise.
    expect(body.enabledSessions).toEqual(COPILOT_SESSIONS);
    const inEnabledSession =
      body.currentSession !== null && body.enabledSessions.includes(body.currentSession);
    expect(body.status).toBe(inEnabledSession ? "live" : "outside_enabled_sessions");

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

  it("status carries the masked active binding when bound (#5100)", async () => {
    const { ctx, sql, d1 } = await boundCtx();
    await seed(sql, d1);
    const res = await call(ctx, req("GET", STATUS_PATH));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.activeBinding).toBeTruthy();
    expect(body.activeBinding.accountType).toBe("stock");
    // Masked: the suffix survives, the full id never leaves the server.
    expect(body.activeBinding.accountId).toContain("900");
    expect(body.activeBinding.accountId).not.toBe("PA-900");
  });

  it("status carries a null active binding when unbound (#5100)", async () => {
    const { ctx, sql, d1 } = await makeCtx();
    await seed(sql, d1);
    const res = await call(ctx, req("GET", STATUS_PATH));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.activeBinding).toBeNull();
  });

  it("status reports off when the global flag is off", async () => {
    // Phase 3 (#6550): STOCK_COPILOT_PAPER_ENABLED lives in
    // environment.config.json (ON in production); "unset" no longer
    // means off, so the flag is set off explicitly.
    const { ctx } = await makeCtx({ env: { STOCK_COPILOT_PAPER_ENABLED: "0" } as StockCopilotRouteContext["env"] });
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

  it("status reports the copilot default (alpaca/paper) when the tenant has stored no broker selection (#3451 follow-up)", async () => {
    // No tenant row at all: the route consumes the same resolver as
    // the cycle, so the copilot-scoped default surfaces identically
    // here — alpaca/paper, never the shared store's etrade default.
    const { ctx } = await makeCtx({ commercial: new InMemoryCommercialAdapter() });
    const res = await call(ctx, req("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.selectionResolved).toBe(true);
    expect(body.activeBroker).toBe("alpaca");
    expect(body.activeMode).toBe("paper");
    expect(body.status).not.toBe("inactive_broker");
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
