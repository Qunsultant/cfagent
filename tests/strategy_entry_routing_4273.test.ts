/**
 * Issue #4273 (#3552 S3) — strategy entry-point routing: every strategy
 * screen entry dispatches through the dedicated strategy engine job
 * (`strategy-screen:<runId>`), never through the options job and never
 * outside the engine.
 *
 * The audit (see ~/workspace/verify-fully-on-engine/4273/audit.md) found
 * every strategy entry already routes through the strategy job — #4271
 * switched them — except the scheduled firer (`runDiscoveryRequest`,
 * scheduledTasks.ts:4239), which runs a StrategyRequest directly through
 * runPanelWithAgents and is explicitly #4275's scope. There is no paid
 * strategy surface (paid_options_screener is a plain options screen).
 *
 * These tests pin the entry points that were not yet pinned at the entry
 * level, so a future bypass is caught: the NLQ panel leg, the NLQ scan
 * leg (the mesh door `run_options_strategy_screen` dispatches to the NLQ
 * action, so pinning the action pins the door), and the manual panel
 * route. Each asserts the run defines exactly one strategy job, zero
 * options jobs, and a durable run record. The dispatch seam and the
 * panel/scan helpers are already pinned by #4271; the mesh door's seam
 * plumbing is pinned by #2581.
 */
import { describe, expect, it, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener, OptionsDataAgent } from "../src/trading";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { optionsEngineStoresFromSql } from "../src/workflows/optionsScreenEngine";
import { runManualPanelViaPipeline } from "../src/workflows/manualPanelScreen";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.05,
          ask: 1.1,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.05,
          ask: 1.1,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async <T>(key: string) => map.get(key) as T | undefined,
    keys: () => [...map.keys()],
  };
}

/** The node:sqlite DO-storage double (tests/feed_pipeline_host_3543 idiom). */
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

function etradeStub() {
  return {
    client: new DynamicOptionsScreener(undefined),
    fetchQuoteRemote: async () => ({ lastPrice: 100 }),
    getWatchlists: async () => [],
    screenMarketsAsync: async () => ({ stocks: [] }),
  };
}

function baseStrategyRequest() {
  const target = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return {
    symbol: "AAPL",
    thesis: "bullish",
    targetPrice: 105,
    expectedIvDirection: "rise",
    targetDate: target,
    maxPlannedLoss: 500,
    minRewardRisk: 1,
    allowedStrategies: ["bull_call_spread"],
    minDte: 21,
    maxDte: 60,
  };
}

async function assertStrategyJobOnly(sql: SqliteTestStorage) {
  const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
  const definitions = await engineStores.stores.definitions.listDefinitions();
  const strategyJobs = definitions.filter(
    (definition) => (definition.root as { kind?: string }).kind === "strategy-screen",
  );
  const optionsJobs = definitions.filter(
    (definition) => (definition.root as { kind?: string }).kind === "options-screen",
  );
  expect(strategyJobs.length).toBe(1);
  expect(strategyJobs[0]?.jobId.startsWith("strategy-screen:")).toBe(true);
  expect(optionsJobs).toHaveLength(0);
  // The run record is durable: the strategy job has a latest run.
  const latest = await engineStores.runRecorder.latestRun(strategyJobs[0]!.jobId);
  expect(latest).toBeDefined();
  expect(latest?.jobId).toBe(strategyJobs[0]!.jobId);
  expect(latest?.outcome).toBe("success");
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("strategy entry-point routing (#4273)", () => {
  it("the NLQ panel leg defines a strategy job (not an options job), durably", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    const sql = new SqliteTestStorage();
    const res = await runOptionsStrategyAction(
      etradeStub(),
      "options_strategies",
      {
        request: baseStrategyRequest(),
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
      } as never,
      {
        userLogin: "owner@example.com",
        pipelineStorage: storage,
        engineSql: sql as unknown as SqlStorage,
      },
    );
    // The engine over a two-contract fixture may rank nothing; the
    // pin is the envelope shape + the staged run + the strategy job,
    // not a candidate.
    expect(["ranked_candidates", "no_candidates"]).toContain(res.status);
    expect(res.summary).toContain("AAPL");
    await assertStrategyJobOnly(sql);
  });

  it("the NLQ scan leg defines a strategy job (not an options job), durably", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL"), MSFT: makeChain("MSFT") });
    const storage = memoryStorage();
    const sql = new SqliteTestStorage();
    const saved: Array<Record<string, unknown>> = [];
    const scanRunStore = {
      save: async (result: unknown) => {
        saved.push(result as Record<string, unknown>);
        return { id: "scan-4273" };
      },
    };
    const res = await runOptionsStrategyAction(
      etradeStub(),
      "options_opportunities",
      {
        request: {
          thesis: "bullish",
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 5_000,
          minRewardRisk: 0.1,
          allowedStrategies: ["long_call"],
          minDte: 14,
          maxDte: 60,
          contractLimit: 500,
          candidateLimit: 10,
          maxStrikesPerSide: 12,
          maxIronCondors: 100,
          maxQuoteAgeSeconds: 60,
          eventPolicy: "warn",
        },
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
        scope: { kind: "symbols", symbols: ["AAPL", "MSFT"] },
      } as never,
      {
        userLogin: "owner@example.com",
        pipelineStorage: storage,
        scanRunStore: scanRunStore as never,
        engineSql: sql as unknown as SqlStorage,
      },
    );
    expect(["ranked_opportunities", "no_opportunities"]).toContain(res.status);
    expect(res.summary).toContain("AAPL");
    expect(saved).toHaveLength(1);
    await assertStrategyJobOnly(sql);
  });

  it("the manual panel route defines a strategy job (not an options job), durably", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const sql = new SqliteTestStorage();
    const result = await runManualPanelViaPipeline({
      userLogin: "owner@example.com",
      strategyRequest: baseStrategyRequest() as never,
      dataAgent: new OptionsDataAgent(new DynamicOptionsScreener(undefined)),
      getSql: () => sql as unknown as SqlStorage,
    });
    expect(result).toBeDefined();
    expect(Array.isArray(result.ranked)).toBe(true);
    await assertStrategyJobOnly(sql);
  });
});
