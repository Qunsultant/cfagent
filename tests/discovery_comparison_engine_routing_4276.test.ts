/**
 * Issue #4276 (#3551 follow-up) — the discovery and comparison legs
 * thread with engine stores, the #4066 pattern: a discovery run's
 * panel expressions and a comparison run each create an engine job
 * with a durable pipeline record, and per-stage control addresses
 * them (or refuses with a named reason). Ranking / comparison
 * semantics are unchanged — pinned here by running the same inputs
 * with and without stores and comparing outcomes.
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the discovery market deps are the
 * discovery_service.test.ts fakes; the DO storage is the node:sqlite
 * double from the #4068/#4275 suites. The engine, the ports, the
 * control plane, and the NLQ threading are all real. The comparison
 * core (runProductionComparison) is mocked at the runner seam: the
 * real core needs a live LLM gateway, so the engine-path tests prove
 * dispatch + record + control around it, and the C5 suite pins the
 * core's semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading";
import { InMemoryDiscoverySetupStore } from "../src/trading/options/discoverySetupStore";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import type { PipelineResult } from "../src/trading/options/index";
import type { BestTradePick, RankedStrategy } from "../src/trading/options/recommendationAgent";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import type { YahooDailyBar } from "../src/trading/technicals";
import {
  runDiscovery,
  type DiscoveryRunRequest,
  type DiscoveryServiceDeps,
} from "../src/services/discoveryService";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import {
  comparisonJobId,
  optionsEngineStoresFromSql,
  runComparisonViaEngine,
  runOptionsPanelViaEngine,
  type OptionsEngineStores,
} from "../src/workflows/optionsScreenEngine";
import { memoryStageStorage } from "../src/workflows/optionsScreenWorkflow";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { createComparisonRunner } from "../src/services/comparisonNlqRunner";
import type { ProductionComparisonResult } from "../src/services/comparisonRunner";
import type { StrategyRequest } from "../src/trading";

// The comparison core (runProductionComparison) needs a live LLM
// gateway, so the runner tests mock it at the seam: the mock records
// the args it received and returns a canned result, proving dispatch
// + record + control around the core. The C5 suite pins the core.
const { mockRunProductionComparison } = vi.hoisted(() => ({
  mockRunProductionComparison: vi.fn(),
}));
vi.mock("../src/services/comparisonRunner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/comparisonRunner")>();
  return { ...actual, runProductionComparison: mockRunProductionComparison };
});

const USER = "legs_tester";

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

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string, spot: number): ETradeOptionChain {
  const pairs = [spot - 5, spot, spot + 5].map((strike) => ({
    call: {
      symbol, optionType: "CALL", strikePrice: strike,
      bid: 5.5, ask: 5.8, volume: 800, openInterest: 2000,
      impliedVolatility: 0.45, delta: 0.52, gamma: 0.04,
      theta: -0.05, vega: 0.12, rho: 0.02,
    },
    put: {
      symbol, optionType: "PUT", strikePrice: strike,
      bid: 5.4, ask: 5.7, volume: 600, openInterest: 1800,
      impliedVolatility: 0.45, delta: -0.48, gamma: 0.04,
      theta: -0.05, vega: 0.12, rho: -0.02,
    },
  }));
  return {
    symbol,
    underlyingPrice: spot,
    quoteTime: Date.now(),
    selectedExpiry: expiryAtDte(35),
    pairs,
  } as ETradeOptionChain;
}

function barsFromCloses(closes: number[]): YahooDailyBar[] {
  return closes.map((close, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  }));
}

function linearCloses(start: number, end: number, n: number): number[] {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

function fakeSnapshot(symbol: string, spot: number, contractCount: number): OptionsDataSnapshot {
  const contracts = Array.from({ length: contractCount }, (_, i) => ({
    symbol: `${symbol}251120C${100 + i * 5}`,
    underlyingSymbol: symbol,
    underlyingPrice: spot,
    strikePrice: spot - 10 + i * 5,
    expirationDate: "2026-11-20",
    daysToExpiration: 29,
    moneyness: "ATM" as const,
    strikeDistancePct: 0,
    spreadPct: 3,
    technicalSignal: "",
    highlightReason: "",
    bid: 1,
    ask: 1.05,
    volume: 900,
    openInterest: 6_000,
    impliedVolatility: 0.3,
  }));
  return {
    symbol,
    contracts: contracts as unknown as OptionsDataSnapshot["contracts"],
    dataSource: "live",
    screen: { underlyingsScanned: 1, contractsEvaluated: contractCount, contractsMatched: contractCount },
    rejections: [],
  };
}

function pipelineResult(score: number): PipelineResult {
  const candidate = {
    id: "cand-1",
    type: "long_call",
    label: "Long call",
    symbol: "TREND",
    expirationDate: "2026-11-20",
    dataFreshness: "FRESH",
    modelImpliedProbabilityOfProfit: 0.42,
  } as unknown as StrategyCandidate;
  const best: RankedStrategy = {
    candidate,
    rank: 1,
    compositeScore: score,
    components: { engineScore: 0, probability: 0, rewardRisk: 0, capitalSafety: 0, liquidity: 0 },
  };
  const pick: BestTradePick = {
    status: "recommended",
    riskProfile: "balanced",
    confidence: "MEDIUM",
    best,
    alternatives: [],
    rationale: [],
    blockers: [],
    humanApprovalRequired: true,
    disclaimer: "fixture",
  };
  return {
    snapshot: {},
    strategies: {},
    screenedOut: [],
    ranked: [best],
    riskReports: [],
    bestTrade: pick,
  } as unknown as PipelineResult;
}

const TREND_BARS = barsFromCloses([...linearCloses(100, 132, 60), 130]);

function makeFakeDeps(
  store: InMemoryDiscoverySetupStore,
  runPipeline: DiscoveryServiceDeps["runPipeline"],
): DiscoveryServiceDeps {
  return {
    loadSnapshot: async (symbol) => fakeSnapshot(symbol, 130, 12),
    fetchBars: async () => TREND_BARS,
    ivStatsFor: async () => null,
    calendarFor: async (symbol) => ({
      symbol,
      covered: false,
      source: "test",
      earningsDate: null,
      daysToEarnings: null,
      exDividendDate: null,
      daysToExDiv: null,
      fetchedAt: "2026-10-22T12:00:00.000Z",
    }),
    flowFor: async () => [],
    runPipeline,
    store,
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  };
}

const DISCOVERY_REQUEST: DiscoveryRunRequest = {
  symbols: ["TREND"],
  scopeKey: "test:scope",
  source: "test",
  caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
};

async function expectControlError(
  promise: Promise<unknown>,
  code: string,
): Promise<OptionsStageControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OptionsStageControlError);
    expect((error as OptionsStageControlError).code).toBe(code);
    return error as OptionsStageControlError;
  }
  throw new Error(`expected control error ${code}, but the call succeeded`);
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

const etradeStub = {
  client: {} as never,
  fetchQuoteRemote: async () => ({ lastPrice: 260 }),
  getWatchlists: async () => [],
  screenMarketsAsync: async () => ({ stocks: [] }),
};

describe("discovery leg engine threading (#4276)", () => {
  it("threads the request's engine stores into the pipeline runner", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const seen: Array<{ engineStores?: OptionsEngineStores | null }> = [];
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-thread" });
    await runDiscovery(
      makeFakeDeps(store, async (_req, options) => {
        seen.push({ engineStores: options?.engineStores });
        return pipelineResult(72);
      }),
      { ...DISCOVERY_REQUEST, engineStores },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].engineStores).toBe(engineStores);
  });

  it("without engine stores the runner receives no stores (accepted-absent, #4069)", async () => {
    const seen: Array<{ engineStores?: OptionsEngineStores | null }> = [];
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-absent" });
    await runDiscovery(
      makeFakeDeps(store, async (_req, options) => {
        seen.push({ engineStores: options?.engineStores });
        return pipelineResult(72);
      }),
      DISCOVERY_REQUEST,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].engineStores).toBeUndefined();
  });

  it("ranking semantics are unchanged with engine stores threaded (same inputs, same outcome)", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const storeA = new InMemoryDiscoverySetupStore({ idFactory: () => "run-sem-a" });
    const storeB = new InMemoryDiscoverySetupStore({ idFactory: () => "run-sem-b" });
    const without = await runDiscovery(
      makeFakeDeps(storeA, async () => pipelineResult(72)),
      DISCOVERY_REQUEST,
    );
    const withStores = await runDiscovery(
      makeFakeDeps(storeB, async () => pipelineResult(72)),
      { ...DISCOVERY_REQUEST, engineStores },
    );
    expect(withStores.run.counts).toEqual(without.run.counts);
    expect(withStores.run.items).toEqual(without.run.items);
    expect(withStores.errors).toEqual(without.errors);
    expect(withStores.run.items[0]?.kind).toBe("setup");
  });

  it("a discovery run over real engine stores defines a strategy job with a durable run record, addressable by control", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ TREND: makeChain("TREND", 130) });
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-real" });
    const { run, errors } = await runDiscovery(
      makeFakeDeps(store, (request, options) =>
        runOptionsPanelViaEngine(undefined, request, {}, USER, undefined, options?.engineStores),
      ),
      { ...DISCOVERY_REQUEST, engineStores },
    );
    expect(errors).toEqual([]);
    expect(run.counts.setups + run.counts.abstentions).toBe(1);

    const definitions = await engineStores.stores.definitions.listDefinitions();
    const strategyJobs = definitions.filter(
      (definition) => (definition.root as { kind?: string }).kind === "strategy-screen",
    );
    const optionsJobs = definitions.filter(
      (definition) => (definition.root as { kind?: string }).kind === "options-screen",
    );
    expect(strategyJobs).toHaveLength(1);
    expect(optionsJobs).toHaveLength(0);
    const jobId = strategyJobs[0]!.jobId;
    expect(jobId.startsWith("strategy-screen:")).toBe(true);
    const latest = await engineStores.runRecorder.latestRun(jobId);
    expect(latest).toBeDefined();
    expect(latest?.jobId).toBe(jobId);
    expect(latest?.outcome).toBe("success");

    // Control reaches the run: stop on a completed run refuses with
    // the engine's named code, not job_not_found — the job resolved,
    // the vocabulary node was found, and the stage state was read.
    const runId = jobId.slice("strategy-screen:".length);
    const refused = await expectControlError(
      controlOptionsStage({
        sql: sql as unknown as SqlStorage,
        storage: { ...memoryStageStorage(), sql: sql as unknown as SqlStorage },
        runId,
        stage: "screen",
        operation: "stop",
        userLogin: USER,
      }),
      "stage_not_stoppable",
    );
    expect(refused.message).toContain(runId);
  });

  it("the NLQ discovery leg threads engine stores from engineSql, and omits them when absent", async () => {
    const sql = new SqliteTestStorage();
    const mockOutcome = {
      run: {
        id: "run-nlq",
        counts: { considered: 1, setups: 1, abstentions: 0, prescreenedOut: 0, errors: 0 },
        items: [{
          kind: "setup", symbol: "NVDA", thesis: "bullish", ruleId: "trend-up",
          discoveryScore: 72, gateBucket: "fit", evidence: "trend",
          targetPrice: 140, targetDate: "2026-12-18",
        }],
      },
      deltas: [],
      errors: [],
    };
    const runWithSql = vi.fn(async () => mockOutcome);
    await runOptionsStrategyAction(
      etradeStub,
      "options_fit_discovery",
      { scope: { kind: "symbols", symbols: ["NVDA"] } } as never,
      {
        discoveryRunner: { run: runWithSql } as never,
        userLogin: USER,
        engineSql: sql as unknown as SqlStorage,
      },
    );
    expect(runWithSql).toHaveBeenCalledTimes(1);
    const threaded = runWithSql.mock.calls[0][0] as DiscoveryRunRequest;
    expect(threaded.engineStores).toBeDefined();
    expect(threaded.engineStores?.stores).toBeDefined();
    expect(threaded.engineStores?.runRecorder).toBeDefined();

    const runWithoutSql = vi.fn(async () => mockOutcome);
    await runOptionsStrategyAction(
      etradeStub,
      "options_fit_discovery",
      { scope: { kind: "symbols", symbols: ["NVDA"] } } as never,
      { discoveryRunner: { run: runWithoutSql } as never, userLogin: USER },
    );
    expect(runWithoutSql).toHaveBeenCalledTimes(1);
    const unthreaded = runWithoutSql.mock.calls[0][0] as DiscoveryRunRequest;
    expect(unthreaded.engineStores).toBeUndefined();
  });
});

const COMPARISON_REQUEST: StrategyRequest = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 260,
  targetDate: "2026-11-20",
  expectedIvDirection: "unchanged",
  allowedStrategies: ["iron_condor"],
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 7,
  maxDte: 90,
};

function cannedComparisonResult(runId: string | undefined): ProductionComparisonResult {
  const arm = (ids: string[]) => ({
    attrition: { generated: ids.length + 1, gatePassed: ids.length, priced: ids.length, falsified: ids.length, ranked: ids.length },
    ranked: ids.map((id, i) => ({ id, structure: "iron_condor", label: `Iron condor ${id}`, status: "qualified", score: 10 - i })),
  });
  return {
    artifact: {
      runId: runId ?? "cmp-direct",
      arms: { llm: arm(["llm-1", "llm-2"]), quant: arm(["q-1"]), hybrid: arm(["h-1", "h-2", "h-3"]) },
      overlap: { sharedStructures: ["iron_condor"], armUnique: { llm: [], quant: [], hybrid: [] } },
      stats: { armRankedCounts: { llm: 2, quant: 1, hybrid: 3 }, sharedStructureCount: 1 },
    },
    generationNotes: { model: "test-model", citedCount: 4, droppedCount: 1, llmGenerated: 2, llmBuilderLimitations: [], skippedReason: null },
  } as unknown as ProductionComparisonResult;
}

describe("comparison runner engine threading (#4276)", () => {
  beforeEach(() => {
    mockRunProductionComparison.mockReset();
    mockRunProductionComparison.mockImplementation(async (deps: { runId?: string }) =>
      cannedComparisonResult(deps.runId),
    );
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: makeChain("NVDA", 260) });
  });

  it("a comparison run with engine stores creates a comparison engine job with a durable record", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const runner = createComparisonRunner({
      client: undefined,
      env: {},
      ledgerSql: {} as never,
    });
    const outcome = await runner.run({
      request: COMPARISON_REQUEST,
      riskProfile: "balanced",
      engineStores,
    } as never);
    expect(outcome.ok).toBe(true);
    expect(outcome.ledgerPersisted).toBe(true);
    expect(mockRunProductionComparison).toHaveBeenCalledTimes(1);

    // The core ran under the minted run id — the same id the engine
    // job carries, so the artifact and the job record are one run.
    const coreArgs = mockRunProductionComparison.mock.calls[0][0] as { runId?: string };
    expect(coreArgs.runId).toMatch(/^cmp-/);
    expect(outcome.result?.artifact.runId).toBe(coreArgs.runId);

    const definitions = await engineStores.stores.definitions.listDefinitions();
    const comparisonJobs = definitions.filter(
      (definition) => (definition.root as { kind?: string }).kind === "comparison",
    );
    expect(comparisonJobs).toHaveLength(1);
    const jobId = comparisonJobs[0]!.jobId;
    expect(jobId).toBe(`comparison:${coreArgs.runId}`);
    const latest = await engineStores.runRecorder.latestRun(jobId);
    expect(latest).toBeDefined();
    expect(latest?.jobId).toBe(jobId);
    expect(latest?.outcome).toBe("success");

    // The dispatch request rides the definition, so control can
    // decode the run's shape from the stored record.
    const rawConfig = comparisonJobs[0]!.rawConfig as {
      request?: { classInput?: { comparisonRequest?: { request?: { symbol?: string } } } };
    };
    expect(rawConfig.request?.classInput?.comparisonRequest?.request?.symbol).toBe("NVDA");
  });

  it("a comparison run without engine stores executes directly (accepted-absent, #4069)", async () => {
    const runner = createComparisonRunner({ client: undefined, env: {} });
    const outcome = await runner.run({
      request: COMPARISON_REQUEST,
      riskProfile: "balanced",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ledgerPersisted).toBe(false);
    expect(mockRunProductionComparison).toHaveBeenCalledTimes(1);
    const coreArgs = mockRunProductionComparison.mock.calls[0][0] as { runId?: string };
    expect(coreArgs.runId).toBeUndefined();
    expect(outcome.result?.artifact.runId).toBe("cmp-direct");
  });

  it("the engine path preserves the comparison core's inputs (same inputs, same artifact modulo the run id)", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const runner = createComparisonRunner({ client: undefined, env: {} });
    const direct = await runner.run({ request: COMPARISON_REQUEST, riskProfile: "balanced" });
    const directArgs = mockRunProductionComparison.mock.calls[0][0] as Record<string, unknown>;
    const viaEngine = await runner.run({
      request: COMPARISON_REQUEST,
      riskProfile: "balanced",
      engineStores,
    } as never);
    const engineArgs = mockRunProductionComparison.mock.calls[1][0] as Record<string, unknown>;
    const { runId: _directRunId, ...directRest } = directArgs;
    const { runId: engineRunId, ...engineRest } = engineArgs;
    expect(engineRunId).toMatch(/^cmp-/);
    // The snapshot's scannedAt is a per-run wall-clock stamp, so it
    // is normalized before comparing; the build/rank/screen fns are
    // fresh closures per run, so they are compared by presence, not
    // by reference. The pin is that the core's DATA inputs are
    // identical across the two paths.
    const normalize = (args: Record<string, unknown>) => {
      const { buildFn, rankFn, screenFn, ...rest } = args;
      expect(buildFn).toEqual(expect.any(Function));
      expect(rankFn).toEqual(expect.any(Function));
      expect(screenFn).toEqual(expect.any(Function));
      const snapshot = rest.snapshot as { screen?: Record<string, unknown> };
      return {
        ...rest,
        snapshot: { ...snapshot, screen: { ...snapshot.screen, scannedAt: "normalized" } },
      };
    };
    expect(normalize(engineRest)).toEqual(normalize(directRest));
    expect({ ...viaEngine.result?.artifact, runId: "normalized" }).toEqual({
      ...direct.result?.artifact,
      runId: "normalized",
    });
  });

  it("the NLQ comparison leg threads engine stores from engineSql, and omits them when absent", async () => {
    const sql = new SqliteTestStorage();
    const runWithSql = vi.fn(async () => ({
      ok: true as const,
      result: cannedComparisonResult("cmp-test-1"),
      ledgerPersisted: true,
    }));
    await runOptionsStrategyAction(
      etradeStub,
      "options_comparison",
      { request: COMPARISON_REQUEST, riskProfile: "balanced" } as never,
      {
        comparisonRunner: { run: runWithSql } as never,
        engineSql: sql as unknown as SqlStorage,
      },
    );
    expect(runWithSql).toHaveBeenCalledTimes(1);
    const threaded = runWithSql.mock.calls[0][0] as { engineStores?: OptionsEngineStores };
    expect(threaded.engineStores).toBeDefined();
    expect(threaded.engineStores?.stores).toBeDefined();
    expect(threaded.engineStores?.runRecorder).toBeDefined();

    const runWithoutSql = vi.fn(async () => ({
      ok: true as const,
      result: cannedComparisonResult("cmp-test-1"),
      ledgerPersisted: true,
    }));
    await runOptionsStrategyAction(
      etradeStub,
      "options_comparison",
      { request: COMPARISON_REQUEST, riskProfile: "balanced" } as never,
      { comparisonRunner: { run: runWithoutSql } as never },
    );
    expect(runWithoutSql).toHaveBeenCalledTimes(1);
    const unthreaded = runWithoutSql.mock.calls[0][0] as { engineStores?: OptionsEngineStores };
    expect(unthreaded.engineStores).toBeUndefined();
  });
});

describe("comparison engine dispatch (#4276)", () => {
  function comparisonDispatchRequest(runId: string) {
    return {
      assetClass: "options",
      runIdentity: { runId },
      trigger: "manual",
      classInput: {
        comparisonRequest: {
          request: COMPARISON_REQUEST,
          riskProfile: "balanced",
        },
      },
    };
  }

  it("dispatches the thunk as a single-step comparison job and returns its result verbatim", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const canned = cannedComparisonResult("cmp-wrapper-1");
    const execute = vi.fn(async () => canned);
    const result = await runComparisonViaEngine(
      {
        runId: "cmp-wrapper-1",
        request: comparisonDispatchRequest("cmp-wrapper-1"),
        engineStores,
      },
      execute,
    );
    expect(result).toBe(canned);
    expect(execute).toHaveBeenCalledTimes(1);

    const definitions = await engineStores.stores.definitions.listDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.jobId).toBe(comparisonJobId("cmp-wrapper-1"));
    expect((definitions[0]!.root as { kind?: string }).kind).toBe("comparison");
    expect(definitions[0]!.rawConfig).toEqual(
      expect.objectContaining({ request: comparisonDispatchRequest("cmp-wrapper-1") }),
    );
    const latest = await engineStores.runRecorder.latestRun(comparisonJobId("cmp-wrapper-1"));
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("success");
  });

  it("a thunk failure rethrows the original error and records a failed run", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const boom = new Error("core exploded");
    const execute = vi.fn(async () => {
      throw boom;
    });
    await expect(
      runComparisonViaEngine(
        {
          runId: "cmp-wrapper-fail",
          request: comparisonDispatchRequest("cmp-wrapper-fail"),
          engineStores,
        },
        execute,
      ),
    ).rejects.toBe(boom);
    const latest = await engineStores.runRecorder.latestRun(comparisonJobId("cmp-wrapper-fail"));
    expect(latest).toBeDefined();
    expect(latest?.jobId).toBe(comparisonJobId("cmp-wrapper-fail"));
    // The recorder's outcome vocabulary: "success" / "failure" /
    // "skipped" (the engine's "failed" state maps to "failure").
    expect(latest?.outcome).toBe("failure");
  });

  it("without engine stores the dispatch completes over in-memory stores (accepted-absent, #4069)", async () => {
    const canned = cannedComparisonResult("cmp-wrapper-mem");
    const result = await runComparisonViaEngine(
      {
        runId: "cmp-wrapper-mem",
        request: comparisonDispatchRequest("cmp-wrapper-mem"),
      },
      async () => canned,
    );
    expect(result).toBe(canned);
  });
});

describe("comparison control (#4276)", () => {
  it("an execution op on a comparison run refuses stage_port_unavailable by name", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    await runComparisonViaEngine(
      {
        runId: "cmp-control-1",
        request: {
          assetClass: "options",
          runIdentity: { runId: "cmp-control-1" },
          trigger: "manual",
          classInput: { comparisonRequest: { request: COMPARISON_REQUEST } },
        },
        engineStores,
      },
      async () => cannedComparisonResult("cmp-control-1"),
    );
    const refused = await expectControlError(
      controlOptionsStage({
        sql: sql as unknown as SqlStorage,
        storage: { ...memoryStageStorage(), sql: sql as unknown as SqlStorage },
        runId: "cmp-control-1",
        stage: "screen",
        operation: "run",
        userLogin: USER,
      }),
      "stage_port_unavailable",
    );
    expect(refused.message).toContain("cmp-control-1");
    expect(refused.message).toContain("comparison");
  });

  it("stop on a comparison run refuses stage_vocabulary_unknown (no stage node in a single-step job)", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    await runComparisonViaEngine(
      {
        runId: "cmp-control-2",
        request: {
          assetClass: "options",
          runIdentity: { runId: "cmp-control-2" },
          trigger: "manual",
          classInput: { comparisonRequest: { request: COMPARISON_REQUEST } },
        },
        engineStores,
      },
      async () => cannedComparisonResult("cmp-control-2"),
    );
    const refused = await expectControlError(
      controlOptionsStage({
        sql: sql as unknown as SqlStorage,
        storage: { ...memoryStageStorage(), sql: sql as unknown as SqlStorage },
        runId: "cmp-control-2",
        stage: "screen",
        operation: "stop",
        userLogin: USER,
      }),
      "stage_vocabulary_unknown",
    );
    expect(refused.message).toContain("cmp-control-2");
  });
});
