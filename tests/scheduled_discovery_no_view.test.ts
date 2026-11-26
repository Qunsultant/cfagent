import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose
// real module graph pulls in `cloudflare:` protocol imports the node
// test loader cannot resolve. Mock it with a plain base class (the
// same pattern as tests/scheduled_discovery_profile_derived.test.ts).
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
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  InMemoryDiscoveryRunStore,
  SqlDiscoveryRunStore,
  type DiscoveryRunInput,
  type DiscoverySqlExecutor,
} from "../src/trading/options/discoveryRunStore";
import type { NoViewStrategyRequest } from "../src/trading/options/strategyEngine";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import { createD1CommercialDb, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import type { Env, ETradeOptionChain } from "../src/types";

/**
 * Issue #534 (PR-534-B) — no-view scheduled discovery: persistence +
 * service + routes.
 *
 * The third input model: a schedule arms constraint sets (a symbol
 * plus constraints per set — NO thesis, NO target). At fire time each
 * symbol's live chain is ranked once by the target-free score model
 * (no-view-v1); a symbol whose chain loads but where nothing clears
 * the gates ABSTAINS as a completed outcome (flagged, reasons
 * recorded, no pick) — an all-abstained fire is a completed run.
 *
 * These tests pin: the store round-trip for the no-view shape (input
 * model stamped, constraint sets verbatim + IV constant, the
 * abstention-aware counts, #103 visibility); the service's status
 * matrix over live-shaped fixtures (mixed → partial, all-abstain →
 * completed, all-failed → failed on the #112 path) and its
 * pre-execution shape discipline (mixed/empty/invalid/smuggled
 * payloads persist NOTHING); and the routes (arm-time 400 matrix,
 * trigger passthrough).
 */

// ---------------------------------------------------------------------
// Hermeticity (the #168/#244 lesson, same as the sibling files).
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

const USER = "noview_trader";
const OTHER_USER = "other_trader";

// A rich live-shaped chain (five strikes around spot 100, IV 0.30,
// expiry ~30 days out) whose economics mirror the PR-534-A engine
// fixtures: under a permissive constraint set several structures
// clear the no-view gates; under a 0.99 POP floor none do.
function makeAcmeChain(): ETradeOptionChain {
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const contract = (optionType: "CALL" | "PUT", strikePrice: number) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strikePrice - 100) * 0.12);
    const mid = Math.max(
      0.3,
      (optionType === "CALL" ? Math.max(100 - strikePrice, 0) : Math.max(strikePrice - 100, 0)) + timeValue
    );
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strikePrice) / 40));
    return {
      symbol: "ACME",
      optionType,
      strikePrice,
      bid: Number((mid - 0.1).toFixed(2)),
      ask: Number((mid + 0.1).toFixed(2)),
      volume: 1000,
      openInterest: 2000,
      impliedVolatility: 0.3,
      delta: optionType === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      rho: 0.01,
    };
  };
  return {
    symbol: "ACME",
    underlyingPrice: 100,
    quoteTime: Date.now(),
    selectedExpiry: {
      year: expiry.getUTCFullYear(),
      month: expiry.getUTCMonth() + 1,
      day: expiry.getUTCDate(),
    },
    pairs: [90, 95, 100, 105, 110].map((strike) => ({
      call: contract("CALL", strike),
      put: contract("PUT", strike),
    })),
  } as unknown as ETradeOptionChain;
}

function makeEnv(): Env {
  // #6102: audit rows land in D1 now — each makeEnv() builds a
  // fresh mock (a shared env would share the memoized port across
  // tests). The store is stashed module-level so the service
  // helpers below, which build their own env, can hand it back to
  // the test for the D1 read.
  const d1Mock = new MockD1Database();
  lastAuditStore = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    AGENT_DB: d1Mock as any,
  } as unknown as Env;
}

// The service's audit() helper stays sync and fire-and-forgets the
// D1 write, so poll briefly until the row lands instead of
// asserting a race. Payload reads back as the stored JSON TEXT.
let lastAuditStore: D1AuditEventStore | null = null;
async function waitForAuditEvents(type: string, expected = 1) {
  const store = lastAuditStore!;
  let rows: any[] = [];
  for (let i = 0; i < 50; i++) {
    rows = await store.findMany({ where: { type } });
    if (rows.length >= expected) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return rows;
}
function auditPayload(row: any) {
  return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
}

function makeOrm() {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: { findMany: vi.fn(() => []) },
  } as any;
}

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  DynamicOptionsScreener.setTestChainsFixture({ ACME: makeAcmeChain() });
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
// Statement-exact fake SQL executor for SqlDiscoveryRunStore (mirrors
// FakeDiscoverySql in tests/scheduled_strategy_discovery.test.ts).
// ---------------------------------------------------------------------
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
    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) return [];
    if (q.startsWith("INSERT INTO mas_discovery_runs")) {
      const [id, created_at, status, user_login, summary_json, run_json] = params as [
        string, string, string, string | null, string, string,
      ];
      if (!this.rows.some((r) => r.id === id)) {
        this.rows.push({ id, created_at, status, user_login, summary_json, run_json });
      }
      return [];
    }
    if (q.startsWith("SELECT * FROM mas_discovery_runs WHERE id = ?")) {
      return this.rows
        .filter((r) => r.id === params[0])
        .map((r) => ({ ...r }));
    }
    if (q.startsWith("SELECT summary_json FROM mas_discovery_runs WHERE")) {
      const [scope, limit, offset] = params as [string | null, number, number];
      return this.sorted()
        .filter((r) => r.user_login == null || (scope != null && r.user_login === scope))
        .slice(offset, offset + limit)
        .map((r) => ({ summary_json: r.summary_json }));
    }
    if (q.startsWith("SELECT COUNT(*)")) return [{ count: this.rows.length }];
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
    throw new Error(`FakeDiscoverySql: unhandled statement: ${q}`);
  }
}

// ---------------------------------------------------------------------
// Constraint sets used across the suite.
// ---------------------------------------------------------------------
const GOOD_SET: NoViewStrategyRequest = {
  symbol: "ACME",
  maxPlannedLoss: 1000,
  minRewardRisk: 0.1,
  allowedStrategies: ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "long_straddle"],
};

/** Same chain, an unsatisfiable POP floor: the gates abstain. */
const IMPOSSIBLE_SET: NoViewStrategyRequest = {
  ...GOOD_SET,
  minProbabilityOfProfit: 0.99,
};

/** No fixture chain exists for MSFT: the chain fetch fails. */
const FAILING_SET: NoViewStrategyRequest = {
  symbol: "MSFT",
  maxPlannedLoss: 1000,
  minRewardRisk: 0.1,
};

function noViewService(store: InMemoryDiscoveryRunStore, orm = makeOrm()) {
  return new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, store);
}

// ---------------------------------------------------------------------
// Store round-trip for the no-view shape
// ---------------------------------------------------------------------
describe("discovery run stores — no-view records (#534)", () => {
  function noViewRunInput(): DiscoveryRunInput {
    return {
      createdAt: "2026-10-20T12:00:00.000Z",
      trigger: "scheduled",
      userLogin: USER,
      inputModel: "no-view",
      requests: [],
      constraintSets: [
        { source: "no-view", request: GOOD_SET, expectedIvDirection: "unchanged" },
        { source: "no-view", request: IMPOSSIBLE_SET, expectedIvDirection: "unchanged" },
        { source: "no-view", request: FAILING_SET, expectedIvDirection: "unchanged" },
      ],
      outcomes: [
        {
          symbol: "ACME",
          status: "completed",
          constraintSet: { source: "no-view", request: GOOD_SET, expectedIvDirection: "unchanged" },
          rankedNoView: [],
          bestNoViewTrade: {
            status: "research_only",
            riskProfile: "balanced",
            confidence: "MEDIUM",
            alternatives: [],
            rationale: ["No user view was supplied; this is the best-supported structure under the stated constraints, not a recommendation."],
            blockers: [],
            humanApprovalRequired: true,
            disclaimer: "Research output only.",
          } as any,
        },
        {
          symbol: "ACME",
          status: "completed",
          abstained: true,
          constraintSet: { source: "no-view", request: IMPOSSIBLE_SET, expectedIvDirection: "unchanged" },
          rankedNoView: [],
          excluded: [{ reason: "min-pop", count: 4 }],
          bestNoViewTrade: {
            status: "no_trade",
            riskProfile: "balanced",
            confidence: "LOW",
            alternatives: [],
            rationale: [],
            blockers: ["No qualifying candidates"],
            humanApprovalRequired: true,
            disclaimer: "Research output only.",
          } as any,
        },
        {
          symbol: "MSFT",
          status: "failed",
          constraintSet: { source: "no-view", request: FAILING_SET, expectedIvDirection: "unchanged" },
          error: "chain fetch failed",
        },
      ],
      status: "partial",
    };
  }

  it("round-trips a no-view run in both stores: model stamped, sets verbatim, abstention-aware counts", async () => {
    const idSequence = () => {
      let n = 0;
      return () => `noview-${++n}`;
    };
    const stores = [
      new SqlDiscoveryRunStore(new FakeDiscoverySql(), { idFactory: idSequence() }),
      new InMemoryDiscoveryRunStore({ idFactory: idSequence() }),
    ];
    for (const store of stores) {
      const saved = await store.save(noViewRunInput());
      expect(saved.inputModel).toBe("no-view");
      expect(saved.requestCount).toBe(3);
      expect(saved.completedCount).toBe(1);
      expect(saved.abstainedCount).toBe(1);
      expect(saved.failedCount).toBe(1);
      expect(saved.symbols).toEqual(["ACME", "ACME", "MSFT"]);
      expect(saved.requests).toEqual([]);

      const got = await store.get(saved.id, { userLogin: USER });
      expect(got).not.toBeNull();
      expect(got!.constraintSets).toHaveLength(3);
      expect(got!.constraintSets![0]).toEqual({
        source: "no-view",
        request: GOOD_SET,
        expectedIvDirection: "unchanged",
      });
      // No view exists anywhere in the stored input records.
      for (const set of got!.constraintSets!) {
        expect(set.request).not.toHaveProperty("thesis");
        expect(set.request).not.toHaveProperty("targetPrice");
        expect(set.request).not.toHaveProperty("targetDate");
      }
      const abstained = got!.outcomes[1];
      expect(abstained.status).toBe("completed");
      expect(abstained.abstained).toBe(true);
      expect(abstained.rankedNoView).toEqual([]);
      expect(abstained.bestNoViewTrade?.status).toBe("no_trade");
      expect(got!.outcomes[0].constraintSet?.request).toEqual(GOOD_SET);
      expect(got!.outcomes[0].bestNoViewTrade?.status).toBe("research_only");
    }
  });

  it("keeps no-view runs invisible to other logins (#103)", async () => {
    const store = new InMemoryDiscoveryRunStore({ idFactory: () => "noview-scoped" });
    const saved = await store.save(noViewRunInput());
    expect(await store.get(saved.id, { userLogin: OTHER_USER })).toBeNull();
    expect(await store.list({ userLogin: OTHER_USER })).toHaveLength(0);
    expect(await store.list({ userLogin: USER })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// The service's no-view branch
// ---------------------------------------------------------------------
describe("ScheduledTasksService.autonomousStrategyDiscovery — no-view (#534)", () => {
  it("ranks a permissive constraint set and persists a completed no-view run", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-noview" });
    const orm = makeOrm();
    const service = noViewService(runStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "no-view",
      constraintSets: [GOOD_SET],
      trigger: "scheduled",
      scheduleId: "sched-noview-1",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe("run-noview");
    expect(result.data?.status).toBe("completed");
    expect(result.data?.requestCount).toBe(1);
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(0);
    expect(result.data?.abstained).toEqual([]);

    const runs = await runStore.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run-noview",
      inputModel: "no-view",
      scheduleId: "sched-noview-1",
      status: "completed",
      requestCount: 1,
      completedCount: 1,
      abstainedCount: 0,
      symbols: ["ACME"],
    });

    const stored = await runStore.get("run-noview", { userLogin: USER });
    expect(stored!.requests).toEqual([]);
    expect(stored!.constraintSets).toEqual([
      { source: "no-view", request: GOOD_SET, expectedIvDirection: "unchanged" },
    ]);
    const outcome = stored!.outcomes[0];
    expect(outcome.status).toBe("completed");
    expect(outcome.abstained).toBeUndefined();
    expect(outcome.request).toBeUndefined();
    expect(outcome.constraintSet?.request).toEqual(GOOD_SET);
    expect(outcome.rankedNoView!.length).toBeGreaterThan(0);
    // Every ranked candidate carries the no-view score-model stamp
    // and no target fields.
    for (const ranked of outcome.rankedNoView!) {
      expect(ranked.candidate.scoreModel).toBe("no-view-v1");
      expect(ranked.candidate).not.toHaveProperty("targetPnl");
      expect(ranked.candidate).not.toHaveProperty("targetRewardRisk");
    }
    expect(outcome.bestNoViewTrade?.status).toBe("research_only");
    expect(outcome.bestNoViewTrade?.confidence).not.toBe("HIGH");
    expect(outcome.bestNoViewTrade?.rationale.join(" ")).toContain("not a recommendation");

    // Completion audit carries the model and the abstention list.
    // Audit rows live in D1 now (#6102); the write fire-and-forgets.
    const completed = await waitForAuditEvents("options.strategy_discovery_completed");
    expect(completed).toHaveLength(1);
    expect(auditPayload(completed[0])).toMatchObject({ inputModel: "no-view", abstained: [] });
  });

  it("mixed complete / abstain / failed symbols produce a partial run with reasons recorded", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-noview-mixed" });
    const service = noViewService(runStore);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "no-view",
      constraintSets: [GOOD_SET, IMPOSSIBLE_SET, FAILING_SET],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("partial");
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(1);
    expect(result.data?.symbols).toEqual(["ACME", "ACME", "MSFT"]);
    const abstained = result.data?.abstained ?? [];
    expect(abstained).toHaveLength(1);
    expect(abstained[0].symbol).toBe("ACME");
    expect(abstained[0].reason.length).toBeGreaterThan(0);
    expect(result.data?.failures).toHaveLength(1);
    expect(result.data?.failures[0].symbol).toBe("MSFT");

    const stored = await runStore.get("run-noview-mixed", { userLogin: USER });
    expect(stored!.status).toBe("partial");
    expect(stored!.completedCount).toBe(1);
    expect(stored!.abstainedCount).toBe(1);
    expect(stored!.failedCount).toBe(1);
    expect(stored!.requestCount).toBe(3);
    const abstainedOutcome = stored!.outcomes[1];
    expect(abstainedOutcome.status).toBe("completed");
    expect(abstainedOutcome.abstained).toBe(true);
    expect(abstainedOutcome.rankedNoView).toEqual([]);
    expect(abstainedOutcome.bestNoViewTrade?.status).toBe("no_trade");
    expect(abstainedOutcome.excluded!.length).toBeGreaterThan(0);
    expect(stored!.outcomes[2].status).toBe("failed");
    expect(stored!.outcomes[2].error).toBeTruthy();
  });

  it("an all-abstained fire is a COMPLETED run — an honest 'nothing qualifies'", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-noview-abstain" });
    const orm = makeOrm();
    const service = noViewService(runStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "no-view",
      constraintSets: [IMPOSSIBLE_SET],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    expect(result.data?.completedCount).toBe(0);
    expect(result.data?.failedCount).toBe(0);
    expect(result.data?.abstained).toHaveLength(1);

    const stored = await runStore.get("run-noview-abstain", { userLogin: USER });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("completed");
    expect(stored!.completedCount).toBe(0);
    expect(stored!.abstainedCount).toBe(1);
    expect(stored!.outcomes[0].abstained).toBe(true);
    // No failure surfacing for an honest abstention.
    // Audit rows live in D1 now (#6102): no such row exists there.
    expect((await lastAuditStore!.findMany({ where: { type: "options.strategy_discovery_failed" } })).length).toBe(0);
  });

  it("an all-failed fire persists a failed run and takes the #112 failure path", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-noview-failed" });
    const orm = makeOrm();
    const service = noViewService(runStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "no-view",
      constraintSets: [FAILING_SET],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(false);
    expect(result.data?.runId).toBe("run-noview-failed");
    expect(result.data?.status).toBe("failed");
    expect(result.data?.failedCount).toBe(1);

    const stored = await runStore.get("run-noview-failed", { userLogin: USER });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("failed");
    expect(stored!.outcomes[0].status).toBe("failed");
    expect(stored!.outcomes[0].constraintSet?.request).toEqual(FAILING_SET);
    // Audit rows live in D1 now (#6102); the write fire-and-forgets.
    const failed = await waitForAuditEvents("options.strategy_discovery_failed");
    expect(failed).toHaveLength(1);
    expect(auditPayload(failed[0])).toMatchObject({ inputModel: "no-view", runId: "run-noview-failed" });
    expect(orm.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Scheduled Strategy Discovery (no-view) failed"),
      })
    );
  });

  it.each([
    ["constraintSets alongside requests", { requests: [{ symbol: "ACME" }], constraintSets: [GOOD_SET] }],
    ["constraintSets alongside symbols", { symbols: ["ACME"], constraintSets: [GOOD_SET] }],
    ["constraintSets alongside a profileId", { profileId: "prof-1", constraintSets: [GOOD_SET] }],
    ["constraintSets under the saved-request discriminator", { inputModel: "saved-request", constraintSets: [GOOD_SET] }],
    ["constraintSets under the profile-derived discriminator", { inputModel: "profile-derived", constraintSets: [GOOD_SET] }],
    ["constraintSets with no discriminator at all", { inputModel: undefined, constraintSets: [GOOD_SET] }],
    ["an empty constraintSets list", { constraintSets: [] }],
    ["no constraintSets at all", { constraintSets: undefined }],
    [
      "more than 25 constraint sets",
      { constraintSets: Array.from({ length: 26 }, (_, i) => ({ ...GOOD_SET, symbol: `S${i + 1}` })) },
    ],
    ["a set missing its risk cap", { constraintSets: [{ symbol: "ACME", minRewardRisk: 0.1 }] }],
    ["a set smuggling a thesis", { constraintSets: [{ ...GOOD_SET, thesis: "bullish" }] }],
    ["a set smuggling a targetPrice", { constraintSets: [{ ...GOOD_SET, targetPrice: 150 }] }],
    ["a set smuggling a targetDate", { constraintSets: [{ ...GOOD_SET, targetDate: "2027-01-15" }] }],
    ["a set smuggling an IV direction", { constraintSets: [{ ...GOOD_SET, expectedIvDirection: "rising" }] }],
  ])("pre-execution failure (%s) persists NOTHING", async (_label, patch: any) => {
    const runStore = new InMemoryDiscoveryRunStore();
    const service = noViewService(runStore);
    const payload: any = {
      inputModel: "no-view",
      constraintSets: [GOOD_SET],
      userLogin: USER,
      environment: "TEST",
      ...patch,
    };
    if (patch.constraintSets === undefined && "constraintSets" in patch) delete payload.constraintSets;
    if (patch.inputModel === undefined && "inputModel" in patch) delete payload.inputModel;
    const result = await service.autonomousStrategyDiscovery(payload);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await runStore.list({ userLogin: USER })).toHaveLength(0);
  });

  it("fails honestly when constructed without a discovery run store, persisting nothing", async () => {
    const service = new ScheduledTasksService(makeEnv(), makeOrm(), USER);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "no-view",
      constraintSets: [GOOD_SET],
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Discovery run store not configured");
  });
});

// ---------------------------------------------------------------------
// Arm-time validation at POST /api/schedules/create
// ---------------------------------------------------------------------
describe("POST /api/schedules/create with a no-view discovery payload (#534)", () => {
  const authenticatedLogin = "noview_create_user";
  const storedTestTokens = JSON.stringify({
    accessToken: "test-access-token",
    accessTokenSecret: "test-access-token-secret",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: authenticatedLogin,
  });
  let scheduleEveryCalls: any[];

  async function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "noview-create-route-test" },
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
    // Issue #5100 (F3 of #5094): creation of an account-scoped
    // schedule refuses when the tenant has no binding, so the
    // success-path tests seed the bound E*TRADE paper account.
    // Seeded raw (the read path JSON-parses the stored array).
    seedSession(
      "account_bindings",
      `acctbind:v1:${authenticatedLogin}`,
      JSON.stringify([
        { broker: "etrade", mode: "paper", accountType: "stock", scope: "tenant", accountId: "ET-123" },
        { broker: "etrade", mode: "paper", accountType: "options", scope: "tenant", accountId: "ET-123" },
      ])
    );
    agent.env = {
      APP_ENV: "TEST",
      SESSION_STORE: sessionStoreNs,
      // Issue #6503 — the unified store is D1 only (fail-closed):
      // without a bound AGENT_DB the create route answers 503
      // "Scheduling unavailable". Same seeding as
      // tests/schedules_create_route.test.ts: binding AGENT_DB
      // switches the commercial read to the D1 adapter, so seed
      // the tenant's broker selection as etrade (tenant
      // "primary", the IAAA default) or creation refuses 409
      // for want of an Alpaca credential.
      AGENT_DB: new MockD1Database(),
    } as any;
    const d1 = agent.env.AGENT_DB as MockD1Database;
    await ensureCommercialSchema(createD1CommercialDb(d1 as never));
    d1.sqlite
      .prepare(
        "INSERT OR REPLACE INTO agent_tenant_settings (tenant_id, ads_enabled, updated_at_ms, broker_id) VALUES ('primary', 0, ?, 'etrade')",
      )
      .run(Date.now());
    agent.schedule = async (when: any, callback: string, payload: any) => {
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

  it("accepts a valid no-view payload", async () => {
    const agent = await makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      // Issue #6482 — the create is a monthly cadence (2,592,000s):
      // creation lands PAUSED and never arms the SDK, so the
      // payload is asserted on the paused record the route returns,
      // not on an armed scheduleEvery call.
      intervalSeconds: 2_592_000,
      callback: "autonomousStrategyDiscovery",
      payload: { inputModel: "no-view", constraintSets: [GOOD_SET] },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.paused).toBe(true);
    expect(body.schedule.state).toBe("paused");
    expect(scheduleEveryCalls).toHaveLength(0);
    expect(body.schedule.definition.payload).toMatchObject({
      inputModel: "no-view",
      constraintSets: [GOOD_SET],
      userLogin: authenticatedLogin,
    });
  });

  it.each([
    ["no constraintSets", { inputModel: "no-view" }],
    ["an empty constraintSets list", { inputModel: "no-view", constraintSets: [] }],
    [
      "more than 25 constraint sets",
      { inputModel: "no-view", constraintSets: Array.from({ length: 26 }, (_, i) => ({ ...GOOD_SET, symbol: `S${i + 1}` })) },
    ],
    ["a set missing its risk cap", { inputModel: "no-view", constraintSets: [{ symbol: "ACME", minRewardRisk: 0.1 }] }],
    ["a set smuggling a thesis", { inputModel: "no-view", constraintSets: [{ ...GOOD_SET, thesis: "bullish" }] }],
    ["a set smuggling a targetPrice", { inputModel: "no-view", constraintSets: [{ ...GOOD_SET, targetPrice: 150 }] }],
    ["a set smuggling an IV direction", { inputModel: "no-view", constraintSets: [{ ...GOOD_SET, expectedIvDirection: "rising" }] }],
    ["constraintSets plus requests (mixed shape)", { inputModel: "no-view", constraintSets: [GOOD_SET], requests: [{}] }],
    ["constraintSets plus symbols (mixed shape)", { inputModel: "no-view", constraintSets: [GOOD_SET], symbols: ["ACME"] }],
    ["constraintSets plus a profileId (mixed shape)", { inputModel: "no-view", constraintSets: [GOOD_SET], profileId: "prof-1" }],
    ["constraintSets under the saved-request model", { inputModel: "saved-request", constraintSets: [GOOD_SET], requests: [{}] }],
    ["constraintSets with no input model", { constraintSets: [GOOD_SET] }],
  ])("rejects %s (400, no schedule created)", async (_label, payload) => {
    const agent = await makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      // Issue #6482 — a monthly cadence: the 400 under test comes
      // from the payload validator, as the test pins — a sub-daily
      // interval would be refused by the floor first and the
      // validator would never run.
      intervalSeconds: 2_592_000,
      callback: "autonomousStrategyDiscovery",
      payload,
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it("names the invalid set and its validator error", async () => {
    const agent = await makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      // Issue #6482 — a monthly cadence: the 400 under test comes
      // from the payload validator, as the test pins — a sub-daily
      // interval would be refused by the floor first.
      intervalSeconds: 2_592_000,
      callback: "autonomousStrategyDiscovery",
      payload: { inputModel: "no-view", constraintSets: [{ ...GOOD_SET, thesis: "bullish" } as any] },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("No-view constraint set 1 (ACME) is invalid");
    expect(body.error).toContain("no thesis, target price, target date, or IV direction");
  });
});

// ---------------------------------------------------------------------
// The trigger route fires no-view payloads through the same call
// ---------------------------------------------------------------------
describe("POST /schedules/trigger-discovery with a no-view payload (#534)", () => {
  function makeCtx(sql: FakeDiscoverySql, orm: any) {
    return {
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
  }

  async function postTrigger(ctx: any, body: Record<string, unknown>) {
    const path = "/api/schedules/trigger-discovery";
    const req = new Request(`https://agent.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": USER },
      body: JSON.stringify(body),
    });
    const res = await handleSchedulesRoutes(req, new URL(`https://agent.test${path}`), path, "session-1", ctx);
    return { status: res!.status, body: (await res!.json()) as any };
  }

  it("fires a no-view payload and persists a manual-trigger no-view run", async () => {
    const sql = new FakeDiscoverySql();
    const ctx = makeCtx(sql, makeOrm());
    const { status, body } = await postTrigger(ctx, {
      inputModel: "no-view",
      constraintSets: [GOOD_SET],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.abstained).toEqual([]);

    const store = new SqlDiscoveryRunStore(sql);
    const runs = await store.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual-trigger");
    expect(runs[0].inputModel).toBe("no-view");
    const stored = await store.get(runs[0].id, { userLogin: USER });
    expect(stored!.constraintSets).toEqual([
      { source: "no-view", request: GOOD_SET, expectedIvDirection: "unchanged" },
    ]);
    expect(stored!.outcomes[0].rankedNoView!.length).toBeGreaterThan(0);
  });

  it("surfaces abstentions in the trigger response alongside failures", async () => {
    const sql = new FakeDiscoverySql();
    const ctx = makeCtx(sql, makeOrm());
    const { status, body } = await postTrigger(ctx, {
      inputModel: "no-view",
      constraintSets: [GOOD_SET, IMPOSSIBLE_SET, FAILING_SET],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("partial");
    expect(body.data.abstained).toHaveLength(1);
    expect(body.data.abstained[0].symbol).toBe("ACME");
    expect(body.data.failures).toHaveLength(1);
    expect(body.data.failures[0].symbol).toBe("MSFT");
  });
});
