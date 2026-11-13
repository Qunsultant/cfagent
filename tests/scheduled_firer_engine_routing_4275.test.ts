/**
 * Issue #4275 (#3551 follow-up) — the scheduled firer routes through
 * the engine-routed panel: runDiscoveryRequest dispatches a strategy
 * engine job (`strategy-screen:<runId>`) with a durable run record,
 * instead of calling runPanelWithAgents directly. The engine panel
 * helper accepts the firer's pre-built agents (the #4068 ledger's
 * prescribed fix shape: the firer constructs shared PanelAgents once
 * from the scheduled universe deps).
 *
 * Snapshot-input mode and feed provenance are unchanged: the stored
 * snapshot still replaces the live load through the panel's snapshot
 * seam, and the outcome still carries its snapshot provenance and
 * dataSource — pinned here through the engine path, not just the
 * direct path the #1236 suite pins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlStorage } from "../src/orm";
import type { ETradeOptionChain } from "../src/types";
import { DynamicOptionsScreener, OptionsDataAgent, RecommendationAgent, StrategyRiskAgent } from "../src/trading";
import { ETradeService } from "../src/services/etrade";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { InMemoryDiscoveryRunStore } from "../src/trading/options/discoveryRunStore";
import { SqlFeedSnapshotStore } from "../src/services/feedSnapshotStore";
import { produceFeedSnapshot } from "../src/services/feedSnapshotProducer";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";
import {
  optionsEngineStoresFromSql,
  runOptionsPanelViaEngineWithAgents,
} from "../src/workflows/optionsScreenEngine";

const USER = "firer_tester";

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

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: { year: 2026, month: 11, day: 20 },
  pairs: [
    {
      call: {
        symbol: "NVDA", optionType: "CALL", strikePrice: 130,
        bid: 5.5, ask: 5.8, volume: 800, openInterest: 2000,
        impliedVolatility: 0.45, delta: 0.52, gamma: 0.04,
        theta: -0.05, vega: 0.12, rho: 0.02,
      },
      put: {
        symbol: "NVDA", optionType: "PUT", strikePrice: 130,
        bid: 5.4, ask: 5.7, volume: 600, openInterest: 1800,
        impliedVolatility: 0.45, delta: -0.48, gamma: 0.04,
        theta: -0.05, vega: 0.12, rho: -0.02,
      },
    },
  ],
} as ETradeOptionChain;

function makeEnv(): Env {
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
  } as unknown as Env;
}

function makeOrm() {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: { findMany: vi.fn(() => []) },
  } as any;
}

/** The node:sqlite DO-storage double (tests/strategy_entry_routing_4273 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

async function assertStrategyJobOnly(sql: SqliteTestStorage, expectedJobs = 1) {
  const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
  const definitions = await engineStores.stores.definitions.listDefinitions();
  const strategyJobs = definitions.filter(
    (definition) => (definition.root as { kind?: string }).kind === "strategy-screen",
  );
  const optionsJobs = definitions.filter(
    (definition) => (definition.root as { kind?: string }).kind === "options-screen",
  );
  expect(strategyJobs.length).toBe(expectedJobs);
  expect(strategyJobs[0]?.jobId.startsWith("strategy-screen:")).toBe(true);
  expect(optionsJobs).toHaveLength(0);
  // The run record is durable: the strategy job has a latest run.
  const latest = await engineStores.runRecorder.latestRun(strategyJobs[0]!.jobId);
  expect(latest).toBeDefined();
  expect(latest?.jobId).toBe(strategyJobs[0]!.jobId);
  expect(latest?.outcome).toBe("success");
  return latest;
}

const SCRUBBED_ENV_KEYS = ["ETRADE_ACCESS_TOKEN", "ETRADE_ACCESS_SECRET"];
let savedProcessEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  DynamicOptionsScreener.setTestChainsFixture({ NVDA: NVDA_CHAIN });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
  vi.unstubAllGlobals();
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
});

describe("scheduled firer routing (#4275)", () => {
  it("no scheduled path calls the direct panel: the firer routes via the engine panel helper", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/services/scheduledTasks.ts"), "utf8");
    expect(source).not.toMatch(/\brunPanelWithAgents(Retired4275)?\s*\(/);
    expect(source).toContain("runOptionsPanelViaEngineWithAgents");
  });

  it("a scheduled live screen defines a strategy job (not an options job), durably", async () => {
    const sql = new SqliteTestStorage();
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-firer-live" });
    // Constructor positions: env, orm, userLogin, scanRunStore,
    // ivHistoryStore, discoveryRunStore, strategyProfileStore,
    // followupScheduler, platformDeps, shardSubmit, feedSnapshotStore,
    // stageQueue, runStockScreenViaEngine, engineSql.
    const service = new ScheduledTasksService(
      makeEnv(), makeOrm(), USER, undefined, undefined, runStore,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, sql as unknown as SqlStorage,
    );
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    const stored = await runStore.get("run-firer-live", { userLogin: USER });
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
    expect(stored!.outcomes[0].snapshot?.dataSource).toBe("live");
    const latest = await assertStrategyJobOnly(sql);
    expect(latest?.triggeredBy).toBe("scheduled");
  });

  it("snapshot-input mode runs on the stored snapshot through the engine, provenance unchanged", async () => {
    const sql = new SqliteTestStorage();
    const feedStore = new SqlFeedSnapshotStore(sql as never, { idFactory: () => "feed-firer" });
    const orm = makeOrm();
    // Produce the artifact from the fixture, then prove the bypass:
    // live would now fail (no fixture, fetch throws).
    const etrade = new ETradeService(orm, makeEnv(), USER, "TEST");
    const agent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client));
    const snapshot = await agent.loadSnapshot({ symbol: "NVDA" });
    const { artifactId } = await produceFeedSnapshot({
      store: feedStore, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => snapshot,
      loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 },
      nowIso: "2026-10-26T05:00:02.000Z",
    });
    DynamicOptionsScreener.clearTestChainsFixture();
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-firer-snap" });
    const service = new ScheduledTasksService(
      makeEnv(), orm, USER, undefined, undefined, runStore,
      undefined, undefined, undefined, undefined, feedStore,
      undefined, undefined, sql as unknown as SqlStorage,
    );
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
      snapshotInput: { artifacts: { NVDA: artifactId } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    const stored = await runStore.get("run-firer-snap", { userLogin: USER });
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
    expect(stored!.outcomes[0].snapshotInput).toMatchObject({ artifactId, stale: false });
    expect(stored!.outcomes[0].snapshot?.dataSource).toBe("live");
    await assertStrategyJobOnly(sql);
  });

  it("the caller-agents panel helper honors a snapshot override without live-loading", async () => {
    const agent = new OptionsDataAgent(new DynamicOptionsScreener(undefined));
    const snapshot = await agent.loadSnapshot({ symbol: "NVDA" });
    DynamicOptionsScreener.clearTestChainsFixture();
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const result = await runOptionsPanelViaEngineWithAgents(
      {
        data: new OptionsDataAgent(new DynamicOptionsScreener(undefined)),
        risk: new StrategyRiskAgent(),
        recommender: new RecommendationAgent(),
      },
      VALID_REQUEST,
      {
        snapshotOverride: snapshot,
        userLogin: USER,
        trigger: "scheduled",
        engineStores,
      },
    );
    expect(result.snapshot.symbol).toBe("NVDA");
    expect(result.snapshot.contracts.length).toBeGreaterThan(0);
    expect(result.snapshot.dataSource).toBe(snapshot.dataSource);
    expect(Array.isArray(result.ranked)).toBe(true);
    await assertStrategyJobOnly(sql);
  });
});
