import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeFakeSessionStore } from "./fake-session-store";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose
// real module graph pulls in `cloudflare:` protocol imports the node
// test loader cannot resolve. Mock it with a plain base class (the
// same pattern as tests/schedules_create_route.test.ts); the create
// route tests below stub the SDK scheduling methods per-test.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent, CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator";
import { handleSchedulesRoutes, type SchedulesRouteContext } from "../src/agents/routes/schedules";
import { handleEtradeOptionsRoutes } from "../src/agents/routes/etradeOptions";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  InMemoryDiscoveryRunStore,
  SqlDiscoveryRunStore,
  type DiscoveryRunInput,
  type DiscoverySqlExecutor,
} from "../src/trading/options/discoveryRunStore";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { MockSqlStorage } from "./mock-sql";
import type { Env, ETradeOptionChain } from "../src/types";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";

/**
 * Issue #126 (PR-E) — scheduled strategy discovery.
 *
 * The scheduled task re-runs SAVED StrategyRequests verbatim (user
 * decision on #126) through the real panel pipeline function and persists
 * one run record per execution. These tests pin:
 *  - the store (SQL + in-memory): round-trip, issue #103 visibility,
 *    retention pruning;
 *  - the service: a completed run persists with provenance and
 *    per-symbol outcomes; a per-symbol failure yields a "partial" run;
 *    an all-failed run persists as "failed" AND takes the #112
 *    failure path; missing identity / invalid payload / missing
 *    store fail honestly with NOTHING persisted;
 *  - the read routes serve what the service persisted, scoped per
 *    user;
 *  - the create route accepts the new callback (with payload
 *    validation) and still rejects internal-only callbacks;
 *  - the trigger route runs the task as a manual trigger.
 *
 * Live chains come from DynamicOptionsScreener's test fixture (the
 * scheduled_options_screening.test.ts pattern); the failing symbol
 * has no fixture and no stored tokens, so its chain fetch fails the
 * way a missing E*TRADE session fails in production.
 */

// ---------------------------------------------------------------------
// Hermeticity (the #168/#244 lesson): CI injects real ET_* secrets
// into process.env and resolveEnvironmentConfig falls back to it, and
// the isolate token cache can leak a token across tests. Scrub both.
// ---------------------------------------------------------------------
const SCRUBBED_ENV_KEYS = [
  "ET_API_KEY",
  "ET_API_SECRET",
  "ET_BASE_URL",
  "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET",
  "PROD_ET_API_KEY",
  "PROD_ET_API_SECRET",
] as const;
let savedProcessEnv: Record<string, string | undefined> = {};

const USER = "discovery_trader";
const OTHER_USER = "other_trader";

const VALID_REQUEST: StrategyRequest = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 1,
  maxDte: 365,
  allowedStrategies: ["long_call", "long_put"],
  candidateLimit: 5,
};

const FAILING_REQUEST: StrategyRequest = {
  ...VALID_REQUEST,
  symbol: "MSFT",
};

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: { year: 2026, month: 11, day: 20 },
  pairs: [
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 130,
        bid: 5.5,
        ask: 5.8,
        volume: 800,
        openInterest: 2000,
        impliedVolatility: 0.45,
        delta: 0.52,
        gamma: 0.04,
        theta: -0.05,
        vega: 0.12,
        rho: 0.02,
      },
      put: {
        symbol: "NVDA",
        optionType: "PUT",
        strikePrice: 130,
        bid: 5.4,
        ask: 5.7,
        volume: 600,
        openInterest: 1800,
        impliedVolatility: 0.45,
        delta: -0.48,
        gamma: 0.04,
        theta: -0.05,
        vega: 0.12,
        rho: -0.02,
      },
    },
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 140,
        bid: 2.5,
        ask: 2.8,
        volume: 1200,
        openInterest: 3500,
        impliedVolatility: 0.42,
        delta: 0.35,
        gamma: 0.03,
        theta: -0.04,
        vega: 0.10,
        rho: 0.01,
      },
    },
  ],
} as ETradeOptionChain;

// ---------------------------------------------------------------------
// Statement-exact fake SQL executor for SqlDiscoveryRunStore (mirrors
// FakeScanSql in tests/options_scan_persistence.test.ts): implements
// the store's fixed statement set with real semantics. Issue #4275:
// statements outside the emulated store run on real SQLite (the
// engine's job-pipeline tables, via the trigger route's wired
// engineSql handle) instead of throwing — in prod, one DO handle
// serves all stores, and this fallback mirrors that. A mistyped
// discovery statement still fails loudly (its table does not exist
// in the fallback).
interface FakeDiscoveryRow {
  id: string;
  created_at: string;
  status: string;
  user_login: string | null;
  summary_json: string;
  run_json: string;
}

class FakeDiscoverySql implements DiscoverySqlExecutor {
  rows: FakeDiscoveryRow[] = [];

  // Issue #4275: real-SQLite fallback for statements outside the
  // emulated discovery store (the engine's job-pipeline tables).
  private readonly fallback = new DatabaseSync(":memory:");

  private sorted(): FakeDiscoveryRow[] {
    return [...this.rows].sort((a, b) =>
      a.created_at !== b.created_at
        ? a.created_at < b.created_at
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
    );
  }

  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    // DDL for the emulated store is swallowed (the fake needs no
    // tables); DDL for anything else runs on the fallback, so the
    // engine's tables actually exist when its DML arrives.
    if (
      (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) &&
      q.includes("mas_discovery_runs")
    ) {
      return [];
    }
    if (q.startsWith("INSERT INTO mas_discovery_runs")) {
      const [id, created_at, status, user_login, summary_json, run_json] = params as [
        string, string, string, string | null, string, string,
      ];
      if (!this.rows.some((r) => r.id === id)) {
        this.rows.push({ id, created_at, status, user_login, summary_json, run_json });
      }
      return [];
    }
    if (q.startsWith("SELECT summary_json, run_json FROM mas_discovery_runs WHERE id = ?")) {
      return this.rows
        .filter((r) => r.id === params[0])
        .map((r) => ({ summary_json: r.summary_json, run_json: r.run_json }));
    }
    if (q.startsWith("SELECT summary_json FROM mas_discovery_runs WHERE")) {
      const [scope, limit, offset] = params as [string | null, number, number];
      return this.sorted()
        .filter((r) => r.user_login == null || (scope != null && r.user_login === scope))
        .slice(offset, offset + limit)
        .map((r) => ({ summary_json: r.summary_json }));
    }
    if (q.startsWith("SELECT COUNT(*)") && q.includes("mas_discovery_runs")) {
      return [{ count: this.rows.length }];
    }
    if (q.startsWith("DELETE FROM mas_discovery_runs WHERE created_at < ?")) {
      const cutoff = params[0] as string;
      this.rows = this.rows.filter((r) => !(r.created_at < cutoff));
      return [];
    }
    if (q.startsWith("DELETE FROM mas_discovery_runs WHERE id NOT IN")) {
      const keep = new Set(this.sorted().slice(0, params[0] as number).map((r) => r.id));
      this.rows = this.rows.filter((r) => keep.has(r.id));
      return [];
    }
    // Issue #4275: anything outside the emulated store runs on
    // real SQLite (the engine's job-pipeline tables, via the wired
    // engineSql handle).
    const stmt = this.fallback.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function makeEnv(): Env {
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
  } as unknown as Env;
}

/** Loose ORM double: `trades` present so ETradeService treats it as
 *  an ORM (its constructor discriminates on that key); events/messages
 *  capture the #112 surfacing calls. */
function makeOrm() {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: { findMany: vi.fn(() => []) },
  } as any;
}

function runInput(overrides: Partial<DiscoveryRunInput> = {}): DiscoveryRunInput {
  return {
    createdAt: "2026-10-20T12:00:00.000Z",
    trigger: "scheduled",
    userLogin: USER,
    // Issue #533: DiscoveryRunInput.inputModel is required — saved-
    // request runs are stamped explicitly (the only change to this
    // pre-existing helper; no assertion in this file changes).
    inputModel: "saved-request",
    requests: [VALID_REQUEST],
    outcomes: [
      {
        symbol: "NVDA",
        status: "completed",
        request: VALID_REQUEST,
        ranked: [],
        snapshot: {
          dataSource: "live",
          screen: { underlyingsScanned: 1, contractsEvaluated: 3, contractsMatched: 3 },
        },
      },
    ],
    status: "completed",
    ...overrides,
  };
}

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  DynamicOptionsScreener.setTestChainsFixture({ NVDA: NVDA_CHAIN });
  // No test in this file may reach the real network: any live fetch
  // attempt (the failing symbol's chain) fails fast and locally.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
});

afterEach(() => {
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------
// 1. Stores
// ---------------------------------------------------------------------
describe("discovery run stores (#126)", () => {
  it("SqlDiscoveryRunStore round-trips a run over its exact statements", async () => {
    const sql = new FakeDiscoverySql();
    const store = new SqlDiscoveryRunStore(sql, { idFactory: () => "disc-run-1" });
    const saved = await store.save(runInput({ scheduleId: "sched-9" }));
    expect(saved.id).toBe("disc-run-1");
    expect(saved.inputModel).toBe("saved-request");
    expect(saved.trigger).toBe("scheduled");
    expect(saved.scheduleId).toBe("sched-9");
    expect(saved.requestCount).toBe(1);
    expect(saved.completedCount).toBe(1);
    expect(saved.failedCount).toBe(0);
    expect(saved.symbols).toEqual(["NVDA"]);

    const listed = await store.list({ userLogin: USER });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("disc-run-1");

    const got = await store.get("disc-run-1", { userLogin: USER });
    expect(got).not.toBeNull();
    expect(got!.requests).toEqual([VALID_REQUEST]);
    expect(got!.outcomes[0].status).toBe("completed");
    expect(got!.outcomes[0].snapshot?.dataSource).toBe("live");
  });

  it("applies the issue #103 visibility rule identically in both stores", async () => {
    const idSequence = () => {
      let n = 0;
      return () => `vis-${++n}`;
    };
    const stores = [
      new SqlDiscoveryRunStore(new FakeDiscoverySql(), { idFactory: idSequence() }),
      new InMemoryDiscoveryRunStore({ idFactory: idSequence() }),
    ];
    for (const store of stores) {
      await store.save(runInput());
      // Owner sees it; another user does not (list or get); an
      // unscoped caller sees only unscoped runs, so not this one.
      expect(await store.list({ userLogin: USER })).toHaveLength(1);
      expect(await store.list({ userLogin: OTHER_USER })).toHaveLength(0);
      expect(await store.list({})).toHaveLength(0);
      expect(await store.get("vis-1", { userLogin: OTHER_USER })).toBeNull();
      expect(await store.get("vis-1", { userLogin: USER })).not.toBeNull();
      // An unscoped (legacy-style) run is visible to everyone.
      await store.save(runInput({ userLogin: undefined, createdAt: "2026-10-20T13:00:00.000Z" }));
      expect(await store.list({ userLogin: OTHER_USER })).toHaveLength(1);
      expect(await store.list({})).toHaveLength(1);
    }
  });

  it("prunes by retention age and row cap, oldest first", async () => {
    const store = new InMemoryDiscoveryRunStore({ retentionDays: 365, maxRows: 2 });
    await store.save(runInput({ createdAt: "2024-01-01T00:00:00.000Z" }));
    await store.save(runInput({ createdAt: "2026-10-19T00:00:00.000Z" }));
    await store.save(runInput({ createdAt: "2026-10-20T00:00:00.000Z" }));
    // The 2024 run is beyond retention relative to the newest save;
    // the cap then keeps only the two newest.
    const listed = await store.list({ userLogin: USER, limit: 10 });
    expect(listed.map((r) => r.createdAt)).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
    ]);
  });
});

// ---------------------------------------------------------------------
// 2. Service
// ---------------------------------------------------------------------
describe("ScheduledTasksService.autonomousStrategyDiscovery (#126)", () => {
  it("persists a completed run with provenance and per-symbol outcomes", async () => {
    const store = new InMemoryDiscoveryRunStore({ idFactory: () => "run-completed" });
    const orm = makeOrm();
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, store);
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      scheduleId: "sched-42",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.taskType).toBe("strategy_discovery");
    expect(result.data?.runId).toBe("run-completed");
    expect(result.data?.status).toBe("completed");
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(0);

    const runs = await store.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run-completed",
      userLogin: USER,
      trigger: "scheduled",
      scheduleId: "sched-42",
      inputModel: "saved-request",
      status: "completed",
      symbols: ["NVDA"],
    });
    const stored = await store.get("run-completed", { userLogin: USER });
    expect(stored!.requests).toEqual([VALID_REQUEST]);
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
    expect(Array.isArray(stored!.outcomes[0].ranked)).toBe(true);
    expect(stored!.outcomes[0].snapshot?.dataSource).toBe("live");

    // #112 surfacing on success: completion audit + session message.
    expect(orm.events.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "options.strategy_discovery_completed" })
    );
    expect(orm.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Scheduled Strategy Discovery completed") })
    );
  });

  it("records a per-symbol failure as a partial run and still succeeds overall", async () => {
    const store = new InMemoryDiscoveryRunStore({ idFactory: () => "run-partial" });
    const orm = makeOrm();
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, store);
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST, FAILING_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("partial");
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(1);
    expect(result.data?.failures).toEqual([
      { symbol: "MSFT", error: expect.any(String) },
    ]);
    expect(result.data!.failures[0].error.length).toBeGreaterThan(0);

    const stored = await store.get("run-partial", { userLogin: USER });
    expect(stored!.status).toBe("partial");
    expect(stored!.outcomes.map((o) => [o.symbol, o.status])).toEqual([
      ["NVDA", "completed"],
      ["MSFT", "failed"],
    ]);
    expect(stored!.outcomes[1].error).toBeTruthy();
  });

  it("an all-failed run persists as failed AND takes the #112 failure path", async () => {
    const store = new InMemoryDiscoveryRunStore({ idFactory: () => "run-failed" });
    const orm = makeOrm();
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, store);
    const result = await service.autonomousStrategyDiscovery({
      requests: [FAILING_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("MSFT");
    expect(result.data?.runId).toBe("run-failed");
    expect(result.data?.status).toBe("failed");

    // The record exists for diagnosis — as a failure, never a success.
    const stored = await store.get("run-failed", { userLogin: USER });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("failed");
    expect(stored!.outcomes[0].status).toBe("failed");
    expect(stored!.outcomes[0].error).toBeTruthy();

    expect(orm.events.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "options.strategy_discovery_failed" })
    );
    expect(orm.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Scheduled Strategy Discovery failed") })
    );
  });

  it("fails honestly with NOTHING persisted when there is no account identity", async () => {
    const store = new InMemoryDiscoveryRunStore();
    const orm = makeOrm();
    const service = new ScheduledTasksService(makeEnv(), orm, "", undefined, undefined, store);
    const result = await service.autonomousStrategyDiscovery({ requests: [VALID_REQUEST], trigger: "scheduled" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No authenticated E*TRADE account");
    expect(await store.list({})).toHaveLength(0);
    expect(orm.events.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "options.strategy_discovery_failed" })
    );
  });

  it("rejects empty and malformed saved-request payloads, persisting nothing", async () => {
    const store = new InMemoryDiscoveryRunStore();
    const service = new ScheduledTasksService(makeEnv(), makeOrm(), USER, undefined, undefined, store);

    const empty = await service.autonomousStrategyDiscovery({ requests: [], userLogin: USER });
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("at least one saved strategy request");

    const missing = await service.autonomousStrategyDiscovery({ userLogin: USER });
    expect(missing.success).toBe(false);

    const malformed = await service.autonomousStrategyDiscovery({
      requests: [{ symbol: "NVDA" } as any],
      userLogin: USER,
    });
    expect(malformed.success).toBe(false);
    expect(malformed.error).toContain("Saved discovery request 1 of 1 (NVDA) is invalid");

    expect(await store.list({ userLogin: USER })).toHaveLength(0);
  });

  it("fails honestly when constructed without a discovery run store", async () => {
    const service = new ScheduledTasksService(makeEnv(), makeOrm(), USER);
    const result = await service.autonomousStrategyDiscovery({ requests: [VALID_REQUEST], userLogin: USER });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Discovery run store not configured");
  });
});

// ---------------------------------------------------------------------
// 3. Read routes serve what the service persisted (shared SQL backend)
// ---------------------------------------------------------------------
describe("discovery run read routes (#126)", () => {
  function optionsCtx(sql: FakeDiscoverySql, orm: any) {
    return {
      env: makeEnv(),
      getOrm: () => orm,
      agentCtx: { storage: { sql } } as any,
      ensureTables: () => sql as any,
      requestedEnv: "TEST" as const,
    } as any;
  }

  async function callRoute(ctx: any, path: string, userLogin: string) {
    const url = new URL(`https://agent.test${path}`);
    const req = new Request(url, { method: "GET", headers: { "x-user-login": userLogin } });
    return handleEtradeOptionsRoutes(req, url, path, "session-1", ctx);
  }

  it("lists and fetches the persisted run for its owner; hides it from others", async () => {
    const sql = new FakeDiscoverySql();
    const store = new SqlDiscoveryRunStore(sql, { idFactory: () => "run-routes" });
    const service = new ScheduledTasksService(makeEnv(), makeOrm(), USER, undefined, undefined, store);
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      scheduleId: "sched-7",
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(true);

    const ctx = optionsCtx(sql, makeOrm());

    const listRes = await callRoute(ctx, "/api/etrade/options/discovery-runs", USER);
    expect(listRes!.status).toBe(200);
    const listBody = (await listRes!.json()) as any;
    expect(listBody.count).toBe(1);
    expect(listBody.runs[0]).toMatchObject({
      id: "run-routes",
      trigger: "scheduled",
      scheduleId: "sched-7",
      inputModel: "saved-request",
      status: "completed",
    });

    const getRes = await callRoute(ctx, "/api/etrade/options/discovery-runs/run-routes", USER);
    expect(getRes!.status).toBe(200);
    const getBody = (await getRes!.json()) as any;
    expect(getBody.requests).toEqual([VALID_REQUEST]);
    expect(getBody.outcomes[0].status).toBe("completed");

    // Another user: empty list, and the by-id read is the same 404 as
    // a missing run (existence never leaks across users, issue #103).
    const otherList = await callRoute(ctx, "/api/etrade/options/discovery-runs", OTHER_USER);
    expect(((await otherList!.json()) as any).count).toBe(0);
    const otherGet = await callRoute(ctx, "/api/etrade/options/discovery-runs/run-routes", OTHER_USER);
    expect(otherGet!.status).toBe(404);
    const missing = await callRoute(ctx, "/api/etrade/options/discovery-runs/nope", USER);
    expect(missing!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------
// 4. Trigger route (manual fire of the same task)
// ---------------------------------------------------------------------
describe("POST /schedules/trigger-discovery (#126)", () => {
  it("runs the task and persists a manual-trigger run", async () => {
    const sql = new FakeDiscoverySql();
    const orm = makeOrm();
    const ctx = {
      env: makeEnv(),
      agentCtx: { storage: { sql } },
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: USER, environment: "TEST" as const })),
      getOrm: () => orm,
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [...CREATABLE_SCHEDULE_CALLBACKS],
      accountScopedScheduleCallbacks: new Set<string>(CREATABLE_SCHEDULE_CALLBACKS),
    } as unknown as SchedulesRouteContext;

    const path = "/api/schedules/trigger-discovery";
    const req = new Request(`https://agent.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": USER },
      body: JSON.stringify({ requests: [VALID_REQUEST] }),
    });
    const res = await handleSchedulesRoutes(req, new URL(`https://agent.test${path}`), path, "session-1", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.taskType).toBe("strategy_discovery");
    expect(body.data.status).toBe("completed");

    const store = new SqlDiscoveryRunStore(sql);
    const runs = await store.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual-trigger");
  });

  it("requires an authenticated account (401 without any identity)", async () => {
    const ctx = {
      env: makeEnv(),
      agentCtx: { storage: { sql: new FakeDiscoverySql() } },
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: () => makeOrm(),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [...CREATABLE_SCHEDULE_CALLBACKS],
      accountScopedScheduleCallbacks: new Set<string>(CREATABLE_SCHEDULE_CALLBACKS),
    } as unknown as SchedulesRouteContext;

    const path = "/api/schedules/trigger-discovery";
    const req = new Request(`https://agent.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [VALID_REQUEST] }),
    });
    const res = await handleSchedulesRoutes(req, new URL(`https://agent.test${path}`), path, "session-1", ctx);
    expect(res!.status).toBe(401);
    expect(((await res!.json()) as any).success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 5. Create route: allow-list + payload validation
// ---------------------------------------------------------------------
describe("POST /api/schedules/create with autonomousStrategyDiscovery (#126)", () => {
  const authenticatedLogin = "discovery_create_user";
  const storedTestTokens = JSON.stringify({
    accessToken: "test-access-token",
    accessTokenSecret: "test-access-token-secret",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: authenticatedLogin,
  });
  let scheduleEveryCalls: any[];

  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "discovery-create-route-test" },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    // #604: tokens live in the SessionStore DO (ns "etrade"), not KV.
    const { namespace: sessionStoreNs, seed: seedSession } =
      makeFakeSessionStore();
    seedSession(
      "etrade",
      `etrade:token:TEST:${authenticatedLogin}`,
      storedTestTokens
    );
    agent.env = {
      APP_ENV: "TEST",
      SESSION_STORE: sessionStoreNs,
    } as any;
    agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
      return { id: "real-schedule-1", callback, payload };
    };
    agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
      scheduleEveryCalls.push([intervalSeconds, callback, payload]);
      return { id: "real-interval-1", callback, payload };
    };
    return agent;
  }

  async function postCreate(agent: any, body: Record<string, unknown>) {
    const res = await agent.onRequest(
      new Request("https://agent.test/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeEach(() => {
    scheduleEveryCalls = [];
  });

  it("accepts the discovery callback and stamps the trusted identity onto the payload", async () => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload: { requests: [VALID_REQUEST] },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(scheduleEveryCalls).toHaveLength(1);
    expect(scheduleEveryCalls[0][0]).toBe(3600);
    expect(scheduleEveryCalls[0][1]).toBe("autonomousStrategyDiscovery");
    expect(scheduleEveryCalls[0][2]).toMatchObject({
      userLogin: authenticatedLogin,
      environment: "TEST",
      trigger: "scheduled",
    });
    expect(scheduleEveryCalls[0][2].requests).toEqual([VALID_REQUEST]);
  });

  it.each([
    ["no requests key", {}],
    ["an empty requests list", { requests: [] }],
    ["a malformed saved request", { requests: [{ symbol: "NVDA" }] }],
  ])("rejects a discovery payload with %s (400, no schedule created)", async (_label, payload) => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload,
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it("still rejects an internal-only callback with 400", async () => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 300,
      callback: "executeAsyncJob",
      payload: {},
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(scheduleEveryCalls).toHaveLength(0);
  });
});
