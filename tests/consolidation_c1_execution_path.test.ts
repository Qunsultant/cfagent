/**
 * Consolidation C1 (issue #1201, epic #1151) — converge the execution
 * path (R1, R2):
 *
 *  - The #1096 unified stack gets real production callers: a goal-driven
 *    screen runs from a route (and, via the schedule payload + service,
 *    from a schedule) through the Phase 0 ScreeningProvider registry
 *    over production engines, and backtest-on-screen gets a production
 *    entry point in the same surface.
 *  - One provider registry: the client adapter derives from the server
 *    registry's descriptor table (SCREENING_PROVIDER_DESCRIPTORS) —
 *    no hand-mirrored second registry.
 *
 * These tests were written red first (gitops §7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createDefaultScreeningRegistry,
  SCREENING_PROVIDER_DESCRIPTORS,
  STOCK_SCREENING_PROVIDER_ID,
  OPTIONS_SCREENING_PROVIDER_ID,
  NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
} from "../src/trading/screeningProvider";
import {
  SCREENING_PROVIDERS,
  getScreeningProviders,
  providerSupportsFilter,
} from "../src/client/screeningAdapters";
import {
  createLiveStockScreener,
  createProductionScreeningRegistry,
  runProductionGoalScreen,
  executeGoalScreenRun,
  executeScreenBacktest,
  scenarioFromStoredRecord,
} from "../src/services/screeningRuntime";
import {
  ScreenerTaskLedger,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";
import { buildScenario, GOAL_KINDS } from "../src/services/goalScenarioEngine";
import {
  ensureGoalScenarioTables,
  createGoal,
  getGoal,
  createScenario,
  getScenario,
} from "../src/services/goalScenarioStore";
import {
  buildSchedulePayload,
  SCREENING_SCHEDULE_CALLBACKS,
  SCREENING_GOAL_KINDS,
} from "../src/trading/screeningSchemas";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { buildScreeningActivityFeed } from "../src/services/screeningActivity";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";

const SRC = path.resolve(__dirname, "../src");
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function stockResult(symbols: string[]) {
  return {
    totalScanned: 100,
    totalScreened: 100,
    matchedCount: symbols.length,
    filterApplied: {},
    filterSummary: "fixture",
    stocks: symbols.map((symbol) => ({ symbol })),
    scannedAt: "2026-10-23T12:00:00.000Z",
  } as any;
}

function optionsResult(underlyings: string[]) {
  return {
    totalUnderlyingsScanned: 40,
    totalContractsEvaluated: 900,
    matchedCount: underlyings.length * 3,
    filterApplied: {},
    filterSummary: "fixture",
    contracts: underlyings.flatMap((u) =>
      [0, 1, 2].map((i) => ({ underlyingSymbol: u, strikePrice: 100 + i }))
    ),
    scannedAt: "2026-10-23T12:00:00.000Z",
    dataSource: "live",
  } as any;
}

function memoryStore(): ScreenerTaskStore {
  const map = new Map<string, string>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async list(prefix) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

function incomeScenario() {
  return buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
      { assetClass: "options", providerId: OPTIONS_SCREENING_PROVIDER_ID, symbol: "NVDA", structures: ["cash_secured_put"] },
    ],
    counts: { stocksScanned: 100, stocksMatched: 1, optionsUnderlyingsScanned: 40, optionsContractsMatched: 3, hits: 2 },
    completedAt: "2026-10-23T12:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* R2 — one provider registry                                          */
/* ------------------------------------------------------------------ */

describe("C1 R2: descriptor table is the one registry source", () => {
  it("the descriptor table names exactly the providers the default registry builds", () => {
    const registry = createDefaultScreeningRegistry({
      stockScreener: { screenMarkets: async () => stockResult([]) },
      optionsScreener: { screenOptions: async () => optionsResult([]) },
    });
    const listed = registry.list().map((p) => ({ id: p.id, assetClasses: [...p.assetClasses] }));
    const described = SCREENING_PROVIDER_DESCRIPTORS.map((d) => ({
      id: d.id,
      assetClasses: [...d.assetClasses],
    }));
    expect(described).toEqual(listed);
    expect(described.map((d) => d.id)).toEqual([
      STOCK_SCREENING_PROVIDER_ID,
      OPTIONS_SCREENING_PROVIDER_ID,
      // Issue #3272: registered, therefore describable.
      NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
    ]);
  });

  it("the client adapter is derived from the descriptor table (same entries, same order)", () => {
    const expected = SCREENING_PROVIDER_DESCRIPTORS.flatMap((d) =>
      Object.entries(d.clientEndpoints).flatMap(([assetClass, variants]) =>
        (variants ?? []).map((v) => ({
          id: v.id,
          label: v.label,
          kind: v.kind,
          registryProviderId: d.id,
          assetClasses: [assetClass],
          endpointByAssetClass: { [assetClass]: v.endpoint },
          filtersByAssetClass: { [assetClass]: v.filters },
        }))
      )
    );
    expect(SCREENING_PROVIDERS).toEqual(expected);
  });

  it("client stock providers keep today's ids, endpoints and filters", () => {
    const stocks = getScreeningProviders("stocks");
    expect(stocks.map((p) => p.id)).toEqual(["etrade", "yahoo-finance", "selected-broker"]);
    expect(stocks[0].endpointByAssetClass.stocks).toBe("/api/etrade/screen");
    expect(stocks[1].endpointByAssetClass.stocks).toBe("/api/market-data/screen");
    // Issue #3272: the neutral endpoint is a first-class stock provider choice.
    expect(stocks[2].endpointByAssetClass.stocks).toBe("/api/broker/screen");
    expect(stocks[2].registryProviderId).toBe(NEUTRAL_STOCK_SCREENING_PROVIDER_ID);
    // The first two endpoints belong to the legacy stock provider; the third
    // (neutral, #3272) belongs to its own registry entry, asserted above.
    for (const p of stocks.slice(0, 2)) {
      expect(p.registryProviderId).toBe(STOCK_SCREENING_PROVIDER_ID);
      expect(providerSupportsFilter(p, "stocks", "search")).toBe(true);
      expect(providerSupportsFilter(p, "stocks", "price-range")).toBe(true);
      expect(providerSupportsFilter(p, "stocks", "contract-type")).toBe(false);
    }
  });

  it("options stays adapter-free by design (the hub hosts the options research surface, S8)", () => {
    expect(getScreeningProviders("options")).toEqual([]);
  });

  it("the client module declares no provider endpoints by hand (drift pin)", () => {
    const src = readSrc("client/screeningAdapters.ts");
    expect(src).not.toContain("/api/etrade/screen");
    expect(src).not.toContain("/api/market-data/screen");
    expect(src).toContain("SCREENING_PROVIDER_DESCRIPTORS");
  });
});

/* ------------------------------------------------------------------ */
/* R1 — production registry + goal-screen composition                  */
/* ------------------------------------------------------------------ */

describe("C1 R1: production screening runtime", () => {
  it("the live stock adapter delegates screenMarkets to the live listing-feed engine (screenLive)", async () => {
    const screenLive = vi.fn(async () => stockResult(["AAPL"]));
    const adapter = createLiveStockScreener({ screenLive } as any);
    const out = await adapter.screenMarkets({ search: "AAP" } as any);
    expect(screenLive).toHaveBeenCalledTimes(1);
    expect(screenLive).toHaveBeenCalledWith({ search: "AAP" });
    expect(out.stocks[0].symbol).toBe("AAPL");
  });

  it("the production registry resolves both asset classes under the descriptor ids", async () => {
    const registry = createProductionScreeningRegistry({
      stockScreener: createLiveStockScreener({ screenLive: async () => stockResult(["MSFT"]) } as any),
      optionsScreener: { screenOptions: async () => optionsResult(["NVDA"]) },
    });
    const stocks = await registry.screen({ assetClass: "stocks", filter: {} });
    expect(stocks.providerId).toBe(STOCK_SCREENING_PROVIDER_ID);
    const options = await registry.screen({ assetClass: "options", filter: {} });
    expect(options.providerId).toBe(OPTIONS_SCREENING_PROVIDER_ID);
  });

  it("runProductionGoalScreen executes a complete run through the registry + ledger", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const out = await runProductionGoalScreen({
      ledger,
      stockScreener: createLiveStockScreener({ screenLive: async () => stockResult(["AAPL"]) } as any),
      optionsScreener: { screenOptions: async () => optionsResult(["NVDA"]) },
      scenario: incomeScenario(),
      trigger: "manual",
      idempotencyKey: "goal-screen:test:1",
      userLogin: "alice",
    });
    expect(out.executed).toBe(true);
    expect(out.result?.status).toBe("complete");
    expect(out.result?.hits.map((h) => h.symbol).sort()).toEqual(["AAPL", "NVDA"]);
    expect(out.result?.hits.every((h) => h.providerId.includes("-"))).toBe(true);
    expect(out.task.status).toBe("completed");
  });

  it("a failing options engine yields a labeled partial, never a silent complete", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const out = await runProductionGoalScreen({
      ledger,
      stockScreener: createLiveStockScreener({ screenLive: async () => stockResult(["AAPL"]) } as any),
      optionsScreener: {
        screenOptions: async () => {
          throw new Error("E*TRADE options chain unavailable");
        },
      },
      scenario: incomeScenario(),
      trigger: "scheduled",
      idempotencyKey: "goal-screen:test:2",
      userLogin: "alice",
    });
    expect(out.executed).toBe(true);
    expect(out.result?.status).toBe("partial");
    expect(out.result?.partial?.failedClasses).toEqual(["options"]);
    expect(out.result?.partial?.reasons.options).toContain("unavailable");
  });

  it("a duplicate delivery returns the existing ledger record without re-executing", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const screenLive = vi.fn(async () => stockResult(["AAPL"]));
    const deps = {
      ledger,
      stockScreener: createLiveStockScreener({ screenLive } as any),
      optionsScreener: { screenOptions: async () => optionsResult(["NVDA"]) },
      scenario: incomeScenario(),
      trigger: "scheduled" as const,
      idempotencyKey: "goal-screen:test:dup",
      userLogin: "alice",
    };
    const first = await runProductionGoalScreen(deps);
    const second = await runProductionGoalScreen(deps);
    expect(first.executed).toBe(true);
    expect(second.executed).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(screenLive).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* R1 — shared run execution (report + activity + delivery seams)      */
/* ------------------------------------------------------------------ */

describe("C1 R1: executeGoalScreenRun records the run on the canonical seams", () => {
  function setup() {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    return { sql, orm };
  }

  it("stores a canonical mas_reports record and an activity entry for an executed run", async () => {
    const { orm } = setup();
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-1", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const out = await executeGoalScreenRun({
      agent: agent as any,
      orm: orm as any,
      env: {},
      userLogin: "alice",
      scenario: incomeScenario(),
      scenarioSource: "built",
      trigger: "manual",
      idempotencyKey: "goal-screen:manual:alice:1",
    });
    expect(out.executed).toBe(true);
    expect(out.result?.status).toBe("complete");
    expect(agent.runGoalScreen).toHaveBeenCalledTimes(1);
    const rows = [...orm.exec("SELECT source, title FROM mas_reports WHERE source = 'goal_screen'")] as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("income");
    const feed = buildScreeningActivityFeed(orm as any, "alice", 10);
    expect(feed.some((e) => e.kind === "screen_run" && e.summary.includes("income"))).toBe(true);
    // Tenant isolation: bob sees nothing of alice's run.
    const bobFeed = buildScreeningActivityFeed(orm as any, "bob", 10);
    expect(bobFeed.some((e) => e.summary.includes("income"))).toBe(false);
  });

  it("a duplicate (executed=false) stores no second canonical report", async () => {
    const { orm } = setup();
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-1", status: "completed" },
        executed: false,
        result: undefined,
      })),
    };
    const out = await executeGoalScreenRun({
      agent: agent as any,
      orm: orm as any,
      env: {},
      userLogin: "alice",
      scenario: incomeScenario(),
      scenarioSource: "built",
      trigger: "scheduled",
      idempotencyKey: "goal-screen:scheduled:alice:1",
    });
    expect(out.executed).toBe(false);
    const rows = [...orm.exec("SELECT source FROM mas_reports WHERE source = 'goal_screen'")] as any[];
    expect(rows).toHaveLength(0);
  });

  it("delivers over the Phase 6 channels when requested, reporting per-channel outcomes", async () => {
    const { orm } = setup();
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-2", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const out = await executeGoalScreenRun({
      agent: agent as any,
      orm: orm as any,
      env: {},
      userLogin: "alice",
      scenario: incomeScenario(),
      scenarioSource: "built",
      trigger: "manual",
      idempotencyKey: "goal-screen:manual:alice:2",
      deliver: ["voice"],
    });
    // Voice is conversational-only in the Phase 6 delivery contract:
    // the outcome is an explicit per-channel failure, never a fake send.
    expect(out.delivery).toEqual([
      { channel: "voice", ok: false, error: expect.stringContaining("conversational") },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* R1 — stored scenario reconstruction                                 */
/* ------------------------------------------------------------------ */

describe("C1 R1: scenarioFromStoredRecord", () => {
  it("rebuilds a ScenarioDefinition from a tenant's stored goal + scenario", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    ensureGoalScenarioTables(orm as any);
    const goal = createGoal(orm as any, {
      userLogin: "alice",
      kind: "hedge_protect",
      title: "Protect the book",
      source: "user",
    })!;
    const record = createScenario(orm as any, {
      userLogin: "alice",
      goalId: goal.id,
      portfolioRef: { kind: "real", ref: "acct-1" },
      shocks: { pricePct: [-10, 0, 10], ivShift: [0, 5], daysForward: [30] },
      constraints: {
        contracts: 2,
        dteWindow: { min: 30, max: 90 },
        configSnapshot: { snapshotOf: "test" },
      },
    })!;
    const scenario = scenarioFromStoredRecord(
      getGoal(orm as any, "alice", goal.id)!,
      getScenario(orm as any, "alice", record.id)!
    );
    expect(scenario.goalKind).toBe("hedge_protect");
    expect(scenario.portfolioRef).toEqual({ kind: "real", ref: "acct-1" });
    expect(scenario.constraints.dteWindow).toEqual({ min: 30, max: 90 });
    expect(scenario.configSnapshot).toEqual({ snapshotOf: "test" });
    // Tenant isolation at the store seam: bob cannot read alice's scenario.
    expect(getScenario(orm as any, "bob", record.id)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* R1 — schedule payload for the goal-screen callback                  */
/* ------------------------------------------------------------------ */

describe("C1 R1: autonomousGoalScreen schedule payload", () => {
  it("is a registered screening schedule callback", () => {
    expect(SCREENING_SCHEDULE_CALLBACKS).toContain("autonomousGoalScreen");
  });

  it("the schema goal-kind list cannot drift from GOAL_KINDS", () => {
    expect([...SCREENING_GOAL_KINDS]).toEqual([...GOAL_KINDS]);
  });

  it("builds a validated, identity-stamped payload", () => {
    const built = buildSchedulePayload(
      "autonomousGoalScreen",
      { goalKind: "income", symbols: ["AAPL", "NVDA"], pushToSlack: true },
      { userLogin: "alice", environment: "PROD", trigger: "scheduled" }
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.goalKind).toBe("income");
      expect(built.value.symbols).toEqual(["AAPL", "NVDA"]);
      expect(built.value.userLogin).toBe("alice");
      expect(built.value.environment).toBe("PROD");
      expect(built.value.trigger).toBe("scheduled");
    }
  });

  it("rejects an unknown goal kind with a field-named error", () => {
    const built = buildSchedulePayload(
      "autonomousGoalScreen",
      { goalKind: "moonshot" },
      { userLogin: "alice", trigger: "scheduled" }
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("goalKind");
  });

  it("rejects a missing goal kind", () => {
    const built = buildSchedulePayload(
      "autonomousGoalScreen",
      { symbols: ["AAPL"] },
      { userLogin: "alice", trigger: "scheduled" }
    );
    expect(built.ok).toBe(false);
  });

  it("rejects unknown criteria keys (strict object)", () => {
    const built = buildSchedulePayload(
      "autonomousGoalScreen",
      { goalKind: "income", bogus: 1 },
      { userLogin: "alice", trigger: "scheduled" }
    );
    expect(built.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* R1 — backtest-on-screen production entry                            */
/* ------------------------------------------------------------------ */

describe("C1 R1: executeScreenBacktest", () => {
  const bars = (start: number, n: number, step = 1) =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      close: start + i * step,
    }));

  it("runs the walk-forward backtest over supplied price history with provenance + limitations", async () => {
    const fetchPrices = vi.fn(async (symbol: string) =>
      symbol === "AAPL" ? bars(100, 40) : null
    );
    const out = await executeScreenBacktest({
      symbols: ["AAPL", "NOPE"],
      fetchPrices: fetchPrices as any,
      folds: 2,
      holdingBars: 5,
    });
    expect(out.provenance).toBe("live");
    expect(out.limitations.length).toBeGreaterThan(0);
    expect(out.folds.length).toBe(2);
    const excluded = out.folds.flatMap((f) => f.excluded);
    expect(excluded.some((e) => e.symbol === "NOPE")).toBe(true);
    expect(out.aggregate.totalTrades).toBeGreaterThan(0);
  });

  it("never fabricates: a symbol with no history is excluded with its reason in every fold", async () => {
    const out = await executeScreenBacktest({
      symbols: ["GHOST"],
      fetchPrices: (async () => null) as any,
    });
    expect(out.aggregate.totalTrades).toBe(0);
    for (const fold of out.folds) {
      expect(fold.excluded.some((e) => e.symbol === "GHOST" && /never fabricated/.test(e.reason))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* R1 — routes                                                         */
/* ------------------------------------------------------------------ */

describe("C1 R1: screening routes (goal-screen + backtest)", () => {
  const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

  function routeCtx(agent: unknown) {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const settings = new Map<string, string>();
    const ctx = {
      getScreenerAgent: vi.fn(() => agent),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      getResearchAgent: vi.fn(() => null),
      runResearchAndPublish: vi.fn(async () => ({ success: true })),
      getOrm: vi.fn(() => orm),
      readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
      writeSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
      env: {},
    } as unknown as ScreenerResearchRouteContext;
    return { ctx, orm, sql };
  }

  it("POST /screening/goal-screen runs the screen and returns the unified result", async () => {
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const { ctx, orm } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income" }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.executed).toBe(true);
    expect(body.result.status).toBe("complete");
    expect(body.result.counts.hits).toBe(2);
    expect(agent.runGoalScreen).toHaveBeenCalledTimes(1);
    const rows = [...orm.exec("SELECT source FROM mas_reports WHERE source = 'goal_screen'")] as any[];
    expect(rows).toHaveLength(1);
  });

  it("POST /screening/goal-screen rejects an unknown goal kind with 400 and runs nothing", async () => {
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "moonshot" }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx
    );
    expect(res!.status).toBe(400);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("POST /screening/goal-screen 404s a stored scenario the tenant cannot see", async () => {
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { scenarioId: "does-not-exist" }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx
    );
    expect(res!.status).toBe(404);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("POST /screening/goal-screen answers a failed run with 502 + the labeled result", async () => {
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-f", status: "escalated" },
        executed: true,
        result: fakeGoalResult({
          status: "failed",
          hits: [],
          counts: { stocksScanned: 0, stocksMatched: 0, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 0 },
          partial: { failedClasses: ["stocks", "options"], reasons: { stocks: "down", options: "down" } },
        }),
      })),
    };
    const { ctx } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income" }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx
    );
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
    expect(body.result.status).toBe("failed");
    expect(body.result.partial.failedClasses).toEqual(["stocks", "options"]);
  });

  describe("POST /screening/backtest (Yahoo chart fetch stubbed)", () => {
    beforeEach(() => {
      const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
      const timestamps = closes.map((_, i) => 1767225600 + i * 86400);
      // #923: the backtest route resolves history through the platform,
      // whose Yahoo verification runs the conformance kit (quote, bars,
      // fundamentals) against the live provider — the stub must serve
      // realistic live payloads for every leg, not just bars. A
      // meta-less chart stub now correctly fails verification (the
      // provider no longer falls back to a profile), which degrades
      // history to undefined and trades to zero.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: any) => {
          const url = String(input);
          // Exact-hostname check (CodeQL js/incomplete-url-substring-sanitization).
          const isFcYahoo = (() => {
            try {
              return new URL(url).hostname === "fc.yahoo.com";
            } catch {
              return false;
            }
          })();
          if (isFcYahoo) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              headers: { get: (h: string) => (h === "set-cookie" ? "A1=dummy; path=/" : null) },
            };
          }
          if (url.includes("getcrumb")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "dummy-crumb",
              headers: { get: (_h: string) => null },
            };
          }
          if (url.includes("/v10/finance/quoteSummary/")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                quoteSummary: {
                  result: [
                    {
                      price: { longName: "Test Corporation", marketCap: { raw: 1e12 } },
                      summaryDetail: {
                        trailingPE: { raw: 25 },
                        forwardPE: { raw: 22 },
                        marketCap: { raw: 1e12 },
                        fiftyTwoWeekHigh: { raw: 160 },
                        fiftyTwoWeekLow: { raw: 90 },
                        dividendYield: { raw: 0.01 },
                      },
                      defaultKeyStatistics: {
                        enterpriseValue: { raw: 1.1e12 },
                        pegRatio: { raw: 1.2 },
                        priceToBook: { raw: 10 },
                        beta: { raw: 1.1 },
                      },
                      financialData: {
                        targetMeanPrice: { raw: 170 },
                        targetHighPrice: { raw: 190 },
                        targetLowPrice: { raw: 140 },
                        recommendationKey: "buy",
                        recommendationMean: { raw: 2.0 },
                        numberOfAnalystOpinions: { raw: 20 },
                        profitMargins: { raw: 0.3 },
                        operatingMargins: { raw: 0.35 },
                        returnOnEquity: { raw: 0.4 },
                        totalRevenue: { raw: 5e10 },
                        grossProfits: { raw: 3e10 },
                        ebitda: { raw: 2e10 },
                        freeCashflow: { raw: 1e10 },
                      },
                    },
                  ],
                },
              }),
              text: async () => "",
              headers: { get: (_h: string) => null },
            };
          }
          const chartSym = url.split("/v8/finance/chart/")[1]?.split("?")[0] || "ZZC1";
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chart: {
                result: [
                  {
                    meta: {
                      symbol: decodeURIComponent(chartSym),
                      longName: "Test Corporation",
                      currency: "USD",
                      regularMarketPrice: 159,
                      regularMarketPreviousClose: 158,
                      chartPreviousClose: 158,
                      regularMarketVolume: 60000,
                      regularMarketDayHigh: 160,
                      regularMarketDayLow: 157,
                      fiftyTwoWeekHigh: 160,
                      fiftyTwoWeekLow: 90,
                      bid: 158.9,
                      ask: 159.1,
                    },
                    timestamp: timestamps,
                    indicators: {
                      quote: [
                        {
                          close: closes,
                          open: closes,
                          high: closes,
                          low: closes,
                          volume: closes.map(() => 1000),
                        },
                      ],
                    },
                  },
                ],
              },
            }),
            text: async () => "",
            headers: { get: (_h: string) => null },
          };
        })
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("returns a walk-forward result with provenance + limitations", async () => {
      const { ctx } = routeCtx({});
      const res = await handleScreenerResearchRoutes(
        req("POST", "/screening/backtest", { symbols: ["ZZC1"], folds: 2, holdingBars: 5 }, { "x-user-login": "alice" }),
        urlOf("/screening/backtest"),
        "/screening/backtest",
        "s1",
        ctx
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.success).toBe(true);
      expect(body.provenance).toBe("live");
      expect(body.limitations.length).toBeGreaterThan(0);
      expect(body.aggregate.totalTrades).toBeGreaterThan(0);
    });

    it("rejects an empty symbol list with 400", async () => {
      const { ctx } = routeCtx({});
      const res = await handleScreenerResearchRoutes(
        req("POST", "/screening/backtest", { symbols: [] }, { "x-user-login": "alice" }),
        urlOf("/screening/backtest"),
        "/screening/backtest",
        "s1",
        ctx
      );
      expect(res!.status).toBe(400);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Production-caller source pins                                       */
/* ------------------------------------------------------------------ */

describe("C1: production callers exist (source pins)", () => {
  it("ScreenerAgent composes the production goal-screen run over its DO ledger", () => {
    const src = readSrc("agents/screener-agent.ts");
    expect(src).toContain("runGoalScreen");
    expect(src).toContain("runProductionGoalScreen");
  });

  it("the options screen route executes through the one options pipeline (#3186)", () => {
    // Old pin asserted the manual screen route ran through the Phase 0
    // ScreeningProvider; #3186 step 3d moved the route onto the one options
    // pipeline, and the provider now lives only on the
    // strategy-recommendation path (next test). #4068 moved the route onto
    // the engine-routed dispatch of the same pipeline (runOptionsScreenViaEngine
    // drives the composer through the engine step), so this pin now proves
    // the route runs the pipeline via its ports through the engine.
    const src = readSrc("agents/routes/etradeOptionsScreen.ts");
    expect(src).toContain("runOptionsScreenViaEngine");
    expect(src).toContain("createOptionsScreenPorts");
  });

  it("the strategy-recommendation path still executes through the Phase 0 options provider", () => {
    const src = readSrc("agents/routes/etradeOptions.ts");
    expect(src).toContain("createOptionsScreeningProvider");
    expect(src).toContain("OPTIONS_SCREENING_PROVIDER_ID");
  });

  it("the scheduled path wires the goal-screen callback end to end", () => {
    expect(readSrc("agents/orchestrator/scheduledCallbacks.ts")).toContain("autonomousGoalScreen");
    expect(readSrc("services/scheduledTasks.ts")).toContain("autonomousGoalScreen");
    expect(readSrc("agents/orchestrator.ts")).toContain('"autonomousGoalScreen"');
  });

  it("the trading hub hosts the goal-screen surface (#2971: own page, not a hub tab)", () => {
    const src = readSrc("client/ETradeTradingHub.tsx");
    expect(src).toContain("GoalScreenPanel");
    expect(src).toContain('effectiveSubTab === "goal-screen"');
  });
});
