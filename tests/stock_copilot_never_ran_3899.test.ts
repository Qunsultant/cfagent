/**
 * Issue #3899 — Stock Copilot never executed a cycle.
 *
 * RED pins (TDD, written against pristine main `deb63fc` before the
 * fix — each must FAIL there and pass after):
 *
 * RC1 — the Think task `stock-copilot-paper-cycle` is declared only
 *   from `getScheduledTasks()` data that cannot exist at cold start,
 *   and nothing ever re-reconciles: the first authenticated request
 *   (which writes the screener execution context) and `onStart`
 *   (after maintenance) must call `internal_reconcileScheduledTasks()`.
 * RC2 — agentic-mode refusals write NO activity record, so
 *   `lastCycle` stays null forever: every refusal outcome must
 *   append an activity record (mirroring the deterministic path).
 * RC3 — the status surface reports configuration as liveness with a
 *   hardcoded Alpaca broker: the status must read the REAL stored
 *   broker selection, and must surface "never executed" when
 *   `lastCycle` is null and no cycle ledger rows exist.
 * RC4 — the NASDAQ100 preset is 12 hand-picked symbols: when the
 *   preset is NASDAQ100 the cycle must resolve the stored 100-member
 *   list, with the 12-symbol preset as the LABELLED fallback only.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// RC1 harness — the real OrchestratorAgent class (the cutover-suite
// idiom: the agents/Think graphs cannot load under Node, so the SDK
// bases are stubbed and the class's own methods run for real).
// ---------------------------------------------------------------------------
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("@cloudflare/think", () => {
  return {
    Think: class StubThink {
      ctx: any;
      env: any;
      lifecycle: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.lifecycle = { start: async () => {} };
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
      async listSchedules() {
        return [];
      }
      async cancelSchedule(_id: string) {
        return true;
      }
      async clearMessages() {}
    },
  };
});
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error("generateText disabled in #3899 tests");
    }),
  };
});
// RC4 host test: the cycle host builds its own MarketDataResearchService
// (a live-fetch boundary). Stub ONLY that class — every other export of
// the module stays real — so the host runs the real cycle with empty
// bars (no signals, no platform calls) instead of hitting the network.
vi.mock("../src/services/marketDataResearch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/marketDataResearch")>();
  return {
    ...actual,
    MarketDataResearchService: class StubMarketDataResearchService {
      constructor(_env: unknown) {}
      async getHistoricalBars() {
        return [];
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  runStockCopilotAgenticCycle,
} from "../src/services/stockCopilotAgenticLoop";
import {
  STOCK_COPILOT_INACTIVE_BROKER,
  STOCK_COPILOT_MODE_UNRESOLVED,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import { STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS } from "../src/services/stockCopilotSessions";
import {
  getStockCopilotStatusViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { introspectStockCopilot } from "../src/services/stockCopilotIntrospection";
import { handleStockCopilotRoutes } from "../src/agents/routes/stockCopilot";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import {
  resolveCopilotUniverseFull,
} from "../src/services/stockCopilotConfiguration";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { PRESET_UNIVERSES } from "../src/services/stockCopilotConfiguration";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import type { IndexMember } from "../src/trading";

/** A Wednesday inside market hours (15:00 UTC = 10:00 ET, EST). */
const MARKET_OPEN_NOW = () => new Date("2026-11-04T15:00:00Z");

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

function makeAgent(env: Record<string, unknown> = { AI: {} }) {
  const sql = new MockSqlStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => "3899-session-1" },
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
  };
  const agent = new OrchestratorAgent(ctx as never, env as never) as any;
  return { agent, sql, kv };
}

function authenticatedJobsRequest(login: string): Request {
  return new Request("http://localhost/api/jobs", {
    method: "GET",
    headers: { "x-user-login": login },
  });
}

// ---------------------------------------------------------------------------
// RC1 — reconcile the declaration when the data it reads changes
// ---------------------------------------------------------------------------
describe("Issue #3899 RC1 — declaration reconciles on context write / onStart", () => {
  it("arms the copilot task on the first authenticated request that writes the execution context", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    const reconcile = vi.fn().mockResolvedValue(undefined);
    agent.internal_reconcileScheduledTasks = reconcile;

    const res = await agent.onRequest(authenticatedJobsRequest("owner"));
    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not re-reconcile when the stored context is unchanged", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    const reconcile = vi.fn().mockResolvedValue(undefined);
    agent.internal_reconcileScheduledTasks = reconcile;

    await agent.onRequest(authenticatedJobsRequest("owner"));
    await agent.onRequest(authenticatedJobsRequest("owner"));
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("re-reconciles when the acting login changes", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    const reconcile = vi.fn().mockResolvedValue(undefined);
    agent.internal_reconcileScheduledTasks = reconcile;

    await agent.onRequest(authenticatedJobsRequest("owner"));
    await agent.onRequest(authenticatedJobsRequest("trader2"));
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("a reconcile failure never fails the request", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    agent.internal_reconcileScheduledTasks = vi
      .fn()
      .mockRejectedValue(new Error("reconcile exploded"));

    const res = await agent.onRequest(authenticatedJobsRequest("owner"));
    expect(res.status).toBe(200);
  });

  it("onStart reconciles after maintenance", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    const reconcile = vi.fn().mockResolvedValue(undefined);
    agent.internal_reconcileScheduledTasks = reconcile;

    await agent.onStart();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("an onStart reconcile failure never fails startup", async () => {
    const { agent } = makeAgent({ AI: {}, STOCK_COPILOT_PAPER_ENABLED: "1" });
    agent.internal_reconcileScheduledTasks = vi
      .fn()
      .mockRejectedValue(new Error("reconcile exploded"));

    await expect(agent.onStart()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RC2 — agentic refusals are recorded as activity
// ---------------------------------------------------------------------------
function agenticDeps(overrides: Partial<StockCopilotDeps> = {}): StockCopilotDeps {
  const activity = createInMemoryStockCopilotActivityPort();
  return {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    positions: createInMemoryStockCopilotPositionPort(),
    activity,
    userLogin: "owner",
    platform: {
      platformId: "alpaca",
      async getPositions() {
        return {
          account: { netAccountValue: 100_000, totalAccountValue: 100_000 },
          positions: [],
        };
      },
      async getQuote(symbol: string) {
        return { symbol, lastPrice: 100 };
      },
      async placeOrderRemote(params: Record<string, unknown>) {
        return {
          success: true,
          orderId: String(params.orderId),
          executionId: "alpaca-1",
          brokerOrderRef: "alpaca-1",
          status: "submitted",
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          executionPrice: 100,
          totalSettled: 0,
          message: "submitted (fake)",
          timestamp: new Date().toISOString(),
        };
      },
    } as any,
    selection: {
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    },
    enabledSessions: ["regular"],
    aroundTheClock: false,
    loadBars: async () => [100, 100, 100, 100, 100, 100],
    now: MARKET_OPEN_NOW,
    executionMode: "agentic",
    ...overrides,
  } as StockCopilotDeps;
}

describe("Issue #3899 RC2 — agentic refusals are recorded as activity", () => {
  it("disabled (flag off) records a refused activity entry", async () => {
    const deps = agenticDeps({ env: {} as any });
    const result = await runStockCopilotAgenticCycle(deps);
    expect(result.status).toBe("disabled");
    const activity = deps.activity!.listActivity("owner", 10);
    expect(activity).toHaveLength(1);
    expect(activity[0].outcome).toBe("refused");
    expect(activity[0].detail).toBe("disabled");
    expect(activity[0].mode).toBe("agentic");
  });

  it("mode_unresolved records a refused activity entry", async () => {
    const deps = agenticDeps({ selection: { resolved: false } as any });
    const result = await runStockCopilotAgenticCycle(deps);
    expect(result.status).toBe("mode_unresolved");
    expect(result.refusal).toBe(STOCK_COPILOT_MODE_UNRESOLVED);
    const activity = deps.activity!.listActivity("owner", 10);
    expect(activity).toHaveLength(1);
    expect(activity[0].outcome).toBe("refused");
    expect(activity[0].detail).toBe(STOCK_COPILOT_MODE_UNRESOLVED);
    expect(activity[0].mode).toBe("agentic");
  });

  it("inactive_broker records an inactive activity entry", async () => {
    const deps = agenticDeps({
      selection: {
        resolved: true,
        selection: { brokerId: "etrade", environment: "TEST", mode: "paper" },
      } as any,
    });
    const result = await runStockCopilotAgenticCycle(deps);
    expect(result.status).toBe("inactive_broker");
    expect(result.refusal).toBe(STOCK_COPILOT_INACTIVE_BROKER);
    const activity = deps.activity!.listActivity("owner", 10);
    expect(activity).toHaveLength(1);
    expect(activity[0].outcome).toBe("inactive");
    expect(activity[0].detail).toBe(STOCK_COPILOT_INACTIVE_BROKER);
    expect(activity[0].mode).toBe("agentic");
  });

  it("outside_enabled_sessions records one transition entry, not one per firing", async () => {
    const deps = agenticDeps({ enabledSessions: ["pre_market"] as any });
    const first = await runStockCopilotAgenticCycle(deps);
    expect(first.status).toBe("outside_enabled_sessions");
    const second = await runStockCopilotAgenticCycle(deps);
    expect(second.status).toBe("outside_enabled_sessions");
    const activity = deps.activity!.listActivity("owner", 10);
    expect(activity).toHaveLength(1);
    expect(activity[0].outcome).toBe("outside_sessions");
    expect(activity[0].detail).toBe(
      `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:regular`,
    );
    expect(activity[0].mode).toBe("agentic");
  });

  it("a firing that evaluates the market still records exactly one ok-path entry", async () => {
    const deps = agenticDeps();
    const result = await runStockCopilotAgenticCycle(deps);
    expect(result.status).toBe("ok");
    const activity = deps.activity!.listActivity("owner", 10);
    expect(activity).toHaveLength(1);
    expect(activity[0].outcome).toBe("no_trade");
  });
});

// ---------------------------------------------------------------------------
// RC3 — status honesty: real broker selection + never-executed state
// ---------------------------------------------------------------------------
async function etradeCommercial(): Promise<InMemoryCommercialAdapter> {
  const commercial = new InMemoryCommercialAdapter();
  await commercial.setTenantProviders(resolveIaaaTenant({}), {
    dataProviderId: "etrade",
    brokerId: "etrade",
  });
  return commercial;
}

async function emptyCommercial(): Promise<InMemoryCommercialAdapter> {
  return new InMemoryCommercialAdapter();
}

function makeDoorCtx(
  sql: SqliteTestStorage,
  overrides: Partial<StockCopilotDoorContext> = {},
): StockCopilotDoorContext {
  const settings = new Map<string, string>([
    ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
  ]);
  return {
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      STOCK_COPILOT_AROUND_THE_CLOCK: "true",
    } as any,
    sql: sql as any,
    readSettingRaw: (k: string) => settings.get(k) ?? null,
    writeSetting: (k: string, v: string) => settings.set(k, v),
    audit: vi.fn(),
    ...overrides,
  };
}

describe("Issue #3899 RC3 — status reads the real broker selection", () => {
  it("reports the real stored broker (etrade), not the hardcoded alpaca", async () => {
    const sql = new SqliteTestStorage();
    const ctx = makeDoorCtx(sql, { commercial: await etradeCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.selectionResolved).toBe(true);
    expect(status.activeBroker).toBe("etrade");
    // E*TRADE is a copilot-supported broker per the catalog (#3839),
    // so the gates pass — and with zero history the honest state is
    // never_executed, not live.
    expect(status.neverExecuted).toBe(true);
    expect(status.status).toBe("never_executed");
  });

  it("reports inactive_broker for a stored broker the copilot cannot run on", async () => {
    const sql = new SqliteTestStorage();
    const commercial = new InMemoryCommercialAdapter();
    await commercial.setTenantProviders(resolveIaaaTenant({}), {
      dataProviderId: "schwab",
      brokerId: "schwab",
    });
    const ctx = makeDoorCtx(sql, { commercial });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.selectionResolved).toBe(true);
    expect(status.activeBroker).toBe("schwab");
    expect(status.status).toBe("inactive_broker");
  });

  it("an absent stored selection resolves to the copilot default (alpaca) through the real store", async () => {
    const sql = new SqliteTestStorage();
    const ctx = makeDoorCtx(sql, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.selectionResolved).toBe(true);
    expect(status.activeBroker).toBe("alpaca");
  });

  it("an unbound store (commercial null) is unresolved, never alpaca", async () => {
    const sql = new SqliteTestStorage();
    const ctx = makeDoorCtx(sql, { commercial: null });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.selectionResolved).toBe(false);
    expect(status.activeBroker).toBeNull();
    expect(status.status).toBe("mode_unresolved");
  });

  it("never executed: no activity and no ledger rows → status never_executed", async () => {
    const sql = new SqliteTestStorage();
    const ctx = makeDoorCtx(sql, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.lastCycle).toBeNull();
    expect(status.neverExecuted).toBe(true);
    expect(status.status).toBe("never_executed");
  });

  it("an activity record clears the never-executed state", async () => {
    const sql = new SqliteTestStorage();
    const { createStockCopilotActivityPort } = await import(
      "../src/data/createStockCopilotStorePorts"
    );
    const activity = createStockCopilotActivityPort(sql as any);
    activity.ensureSchema();
    activity.appendActivity({
      id: "act-1",
      userLogin: "owner",
      cycleAt: new Date().toISOString(),
      outcome: "no_trade",
      session: "regular",
      entries: [],
      exits: [],
      detail: null,
      mode: "deterministic",
    });
    const ctx = makeDoorCtx(sql, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.neverExecuted).toBe(false);
    expect(status.lastCycle).not.toBeNull();
    expect(status.status).toBe("live");
  });

  it("a cycle ledger row without activity also clears the never-executed state", async () => {
    const sql = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(sql as any);
    const nowIso = new Date().toISOString();
    store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: STOCK_COPILOT_TASK_ID,
        operation: STOCK_COPILOT_TASK_ID,
        started: nowIso,
        finished: nowIso,
        outcome: "skipped",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: STOCK_COPILOT_TASK_ID,
        asyncJobId: null,
        workflowId: null,
        detail: "seeded firing",
      }),
    );
    const ctx = makeDoorCtx(sql, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.neverExecuted).toBe(false);
    expect(status.lastCycle).toBeNull();
  });

  it("REST status surfaces never_executed with a null lastCycle", async () => {
    const sql = new SqliteTestStorage();
    const settings = new Map<string, string>([
      ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
    ]);
    const req = new Request("http://localhost/api/stock-copilot/status", {
      method: "GET",
    });
    const res = await handleStockCopilotRoutes(req, new URL(req.url), "/api/stock-copilot/status", "session-1", {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        STOCK_COPILOT_AROUND_THE_CLOCK: "true",
      } as any,
      sql: sql as any,
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : (settings.get(key) ?? null),
      commercial: await emptyCommercial(),
      audit: vi.fn(),
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("never_executed");
    expect(body.neverExecuted).toBe(true);
    expect(body.lastCycle).toBeNull();
  });

  it("introspection reads the real stored broker (etrade)", async () => {
    const sql = new SqliteTestStorage();
    const {
      createStockCopilotPositionPort,
      createStockCopilotActivityPort,
      createStockCopilotControlPort,
    } = await import("../src/data/createStockCopilotStorePorts");
    const positionPort = createStockCopilotPositionPort(sql as any);
    const activityPort = createStockCopilotActivityPort(sql as any);
    const controlPort = createStockCopilotControlPort(sql as any);
    positionPort.ensureSchema();
    activityPort.ensureSchema();
    controlPort.ensureSchema();
    const result = await introspectStockCopilot({
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" } as any,
      userLogin: "owner",
      readSettingRaw: () => null,
      positionPort,
      activityPort,
      controlPort,
      commercial: await etradeCommercial(),
    });
    expect(result.configuration.selectionResolved).toBe(true);
    expect(result.configuration.broker).toBe("etrade");
  });

  it("introspection with an unbound store reports no broker, never alpaca", async () => {
    const sql = new SqliteTestStorage();
    const {
      createStockCopilotPositionPort,
      createStockCopilotActivityPort,
      createStockCopilotControlPort,
    } = await import("../src/data/createStockCopilotStorePorts");
    const positionPort = createStockCopilotPositionPort(sql as any);
    const activityPort = createStockCopilotActivityPort(sql as any);
    const controlPort = createStockCopilotControlPort(sql as any);
    positionPort.ensureSchema();
    activityPort.ensureSchema();
    controlPort.ensureSchema();
    const result = await introspectStockCopilot({
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" } as any,
      userLogin: "owner",
      readSettingRaw: () => null,
      positionPort,
      activityPort,
      controlPort,
      commercial: null,
    });
    expect(result.configuration.selectionResolved).toBe(false);
    expect(result.configuration.broker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RC4 — the NASDAQ100 preset resolves to the stored 100-member list
// ---------------------------------------------------------------------------
function nasdaq100Members(count: number): IndexMember[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `N100_${String(i + 1).padStart(3, "0")}`,
    name: `Nasdaq 100 member ${i + 1}`,
  }));
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe("Issue #3899 RC4 — NASDAQ100 resolves to the stored 100-member list", () => {
  it("resolves the stored fresh nasdaq100 list (100 symbols)", async () => {
    const store = new InMemoryIndexListStore();
    await store.store({
      index: "nasdaq100",
      snapshotDate: daysAgoIso(0),
      symbols: nasdaq100Members(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia NASDAQ-100",
      derivedFromHoldings: false,
    });
    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: (key: string) =>
        key === "stock_copilot:universe" ? "NASDAQ100" : null,
      env: {} as any,
      indexListStore: store,
    });
    expect(resolved.source).toBe("stored-index");
    expect(resolved.symbols).toHaveLength(100);
    expect(resolved.symbols).toContain("N100_001");
    expect(resolved.symbols).toContain("N100_100");
  });

  it("a missing stored list falls back to the labelled 12-symbol preset", async () => {
    const store = new InMemoryIndexListStore();
    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: (key: string) =>
        key === "stock_copilot:universe" ? "NASDAQ100" : null,
      env: {} as any,
      indexListStore: store,
    });
    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.symbols).toEqual([...PRESET_UNIVERSES.NASDAQ100]);
    expect(resolved.reason).toMatch(/no stored index list for nasdaq100/i);
  });

  it("a stale stored list falls back to the labelled 12-symbol preset", async () => {
    const store = new InMemoryIndexListStore();
    await store.store({
      index: "nasdaq100",
      snapshotDate: daysAgoIso(30),
      symbols: nasdaq100Members(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia NASDAQ-100",
      derivedFromHoldings: false,
    });
    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: (key: string) =>
        key === "stock_copilot:universe" ? "NASDAQ100" : null,
      env: {} as any,
      indexListStore: store,
    });
    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.symbols).toEqual([...PRESET_UNIVERSES.NASDAQ100]);
    expect(resolved.stale).toBe(true);
    expect(resolved.reason).toMatch(/stale/i);
  });

  // #3936 changed this premise: SP100 is now an INDEX preset and resolves
  // stored membership. A symbol preset still never reads the store.
  it("a symbol-list universe never touches the index store", async () => {
    const throwingStore = {
      async latest(): Promise<never> {
        throw new Error("store must not be read for MEGA_TECH");
      },
      async store(): Promise<never> {
        throw new Error("store must not be written");
      },
    };
    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: (key: string) =>
        key === "stock_copilot:universe" ? "MEGA_TECH" : null,
      env: {} as any,
      indexListStore: throwingStore as any,
    });
    expect(resolved.source).toBe("configured");
    expect(resolved.symbols).toEqual([...PRESET_UNIVERSES.MEGA_TECH]);
  });

  it("an index-store read failure falls back to the labelled preset, never a silent no-op", async () => {
    const throwingStore = {
      async latest(): Promise<never> {
        throw new Error("sqlite exploded");
      },
      async store(): Promise<never> {
        throw new Error("sqlite exploded");
      },
    };
    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: (key: string) =>
        key === "stock_copilot:universe" ? "NASDAQ100" : null,
      env: {} as any,
      indexListStore: throwingStore as any,
    });
    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.symbols).toEqual([...PRESET_UNIVERSES.NASDAQ100]);
    expect(resolved.reason).toMatch(/sqlite exploded/);
  });

  it("the cycle host runs the stored 100-member universe and audits its provenance", async () => {
    const sql = new SqliteTestStorage();
    const { SqlIndexListStore } = await import(
      "../src/data/doSqliteIndexListAdapter"
    );
    const listStore = new SqlIndexListStore(sql as any);
    await listStore.store({
      index: "nasdaq100",
      snapshotDate: daysAgoIso(0),
      symbols: nasdaq100Members(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia NASDAQ-100",
      derivedFromHoldings: false,
    });
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const settings = new Map<string, string>([
      ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
      ["stock_copilot:universe", "NASDAQ100"],
      [BROKER_ENVIRONMENT_SETTING_KEY, "TEST"],
    ]);
    const tasks = await declareStockCopilotTasks({
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        STOCK_COPILOT_AROUND_THE_CLOCK: "true",
      } as any,
      agentCtx: { storage: { sql: sql as any } } as any,
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      getOrm: () => undefined,
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      commercial: await emptyCommercial(),
      audit: (type, _agent, payload) => {
        audits.push({ type, payload });
      },
    });
    expect(Object.keys(tasks)).toEqual([STOCK_COPILOT_TASK_ID]);
    await tasks[STOCK_COPILOT_TASK_ID].handler({
      taskId: "test-task-1",
      scheduledFor: Date.now(),
      scheduledForDate: new Date(),
      occurrenceKey: "test-1",
      idempotencyKey: "test-1",
      schedule: "every 30 minutes",
      scheduleKind: "interval",
    });
    const cycleAudit = audits.find((a) => a.type === "stock_copilot.cycle");
    expect(cycleAudit).toBeDefined();
    expect(cycleAudit!.payload.universeSource).toBe("stored-index");
    expect(cycleAudit!.payload.universeSymbols).toBe(100);
  });
});
