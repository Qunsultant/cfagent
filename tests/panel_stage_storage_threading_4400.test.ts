// @vitest-environment node
/**
 * Issue #4400 — stage storage threaded through the panel path.
 *
 * runOptionsPanelViaEngine built per-call in-memory stage storage, so
 * a discovery panel run's artifacts evaporated with the call. The
 * panel path now writes stage artifacts to the engine stores'
 * artifact store (scoped by the engine run id, the #4289 residency
 * pattern), and a control rerun with no caller-supplied storage
 * reads them back from the same stores. A rerun whose run never
 * threaded its artifacts refuses by name
 * (stage_storage_unavailable) instead of reporting a completion it
 * did not execute.
 *
 * The rerun assertions use the fixture-change idiom (the #4066
 * stale → refetch discipline): merely asserting "completed" proves
 * nothing, because the engine's retry replays a recorded step
 * output when the step throws (jobPipelineEngine retry +
 * deriveResumePosition). Changing the fixture between dispatch and
 * rerun and asserting the re-run artifact reflects the NEW fixture
 * proves the stage genuinely re-executed against threaded storage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type StrategyRequest,
} from "../src/trading";
import { JobPipelineControl } from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  createStrategyScreenAgents,
  createStrategyScreenPorts,
} from "../src/workflows/strategyScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../src/workflows/optionsScreenWorkflow";
import {
  optionsEngineStoresFromSql,
  runOptionsPanelViaEngineWithAgents,
  runStrategyScreenViaEngine,
  strategyScreenJobId,
  type OptionsEngineStores,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";

const USER = "storage_tester";

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

const PANEL_REQUEST: StrategyRequest = {
  symbol: "TREND",
  thesis: "bullish",
  targetPrice: 130,
  targetDate: "2026-11-20",
  expectedIvDirection: "unchanged",
  allowedStrategies: ["long_call"],
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 7,
  maxDte: 90,
};

function panelAgents() {
  return {
    data: new OptionsDataAgent(new DynamicOptionsScreener(undefined)),
    risk: new StrategyRiskAgent(),
    recommender: new RecommendationAgent(),
  };
}

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
  throw new Error(`expected control refusal ${code}, got success`);
}

/** The run's engine run id, from the instance record over the same stores. */
async function engineRunIdFor(
  engineStores: OptionsEngineStores,
  runId: string,
): Promise<string> {
  const reader = new JobPipelineControl({
    stores: engineStores.stores,
    runRecorder: engineStores.runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
  });
  const view = await reader.getJob(strategyScreenJobId(runId));
  const engineRunId = view.instance?.currentRunId;
  expect(engineRunId).toBeDefined();
  return engineRunId!;
}

async function artifactSpot(
  engineStores: OptionsEngineStores,
  engineRunId: string,
  runId: string,
): Promise<number | null> {
  const artifact = (await engineStores.stores.artifacts.getArtifact(
    engineRunId,
    optionsArtifactKey(runId, "chainFetch"),
  )) as { contracts?: Array<{ underlyingPrice?: number }> } | null;
  if (!artifact) return null;
  return artifact.contracts?.[0]?.underlyingPrice ?? null;
}

beforeEach(() => {
  DynamicOptionsScreener.setTestChainsFixture({ TREND: makeChain("TREND", 130) });
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("panel stage-storage threading (#4400)", () => {
  it("a stage rerun of a discovery panel run reads its artifacts from threaded stage storage", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const runId = "panel-storage:threaded";
    const result = await runOptionsPanelViaEngineWithAgents(panelAgents(), PANEL_REQUEST, {
      runId,
      userLogin: USER,
      engineStores,
    });
    expect(result.bestTrade).toBeDefined();

    // The dispatch wrote the stage artifacts into the engine stores'
    // artifact store, scoped by the engine run id.
    const engineRunId = await engineRunIdFor(engineStores, runId);
    expect(await artifactSpot(engineStores, engineRunId, runId)).toBe(130);

    // The fixture moves: a genuine re-execution refetches at the new
    // spot; a replay would leave the dispatch-time artifact (130).
    DynamicOptionsScreener.setTestChainsFixture({ TREND: makeChain("TREND", 150) });
    const rerun = await controlOptionsStage({
      sql: sql as unknown as SqlStorage,
      runId,
      stage: "chainFetch",
      operation: "rerun",
      userLogin: USER,
    });
    expect(rerun.state).toBe("completed");
    expect(rerun.jobId).toBe(`strategy-screen:${runId}`);
    expect(rerun.stageUnits[0]?.status).toBe("completed");
    expect(await artifactSpot(engineStores, engineRunId, runId)).toBe(150);
  });

  it("a rerun with no threaded storage refuses by name instead of reporting an unexecuted completion", async () => {
    const sql = new SqliteTestStorage();
    const engineStores: OptionsEngineStores = optionsEngineStoresFromSql(
      sql as unknown as SqlStorage,
    );
    const runId = "panel-storage:unthreaded";
    // The pre-#4400 panel shape: SQL engine stores, but per-call
    // in-memory stage storage — the artifacts evaporate with the call.
    const outcome = await runStrategyScreenViaEngine(
      {
        runId,
        userLogin: USER,
        trigger: "manual",
        request: {
          assetClass: "options",
          runIdentity: { runId },
          trigger: "manual",
          classInput: {
            strategyRequest: PANEL_REQUEST,
            alternatives: 3,
          },
        },
      },
      {
        stages: createStrategyScreenPorts({
          agents: createStrategyScreenAgents(undefined),
          storage: memoryStageStorage(),
        }),
        claims: memoryStageClaims(),
        queue: null,
        engineStores,
      },
    );
    expect(outcome.outcome).toBe("completed");

    const error = await expectControlError(
      controlOptionsStage({
        sql: sql as unknown as SqlStorage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: USER,
      }),
      "stage_storage_unavailable",
    );
    expect(error.message).toContain(runId);
    expect(error.message).toContain("screen");
  });

  it("a first-stage rerun needs no threaded storage: plan re-executes from the request", async () => {
    const sql = new SqliteTestStorage();
    const engineStores: OptionsEngineStores = optionsEngineStoresFromSql(
      sql as unknown as SqlStorage,
    );
    const runId = "panel-storage:plan";
    const outcome = await runStrategyScreenViaEngine(
      {
        runId,
        userLogin: USER,
        trigger: "manual",
        request: {
          assetClass: "options",
          runIdentity: { runId },
          trigger: "manual",
          classInput: {
            strategyRequest: PANEL_REQUEST,
            alternatives: 3,
          },
        },
      },
      {
        stages: createStrategyScreenPorts({
          agents: createStrategyScreenAgents(undefined),
          storage: memoryStageStorage(),
        }),
        claims: memoryStageClaims(),
        queue: null,
        engineStores,
      },
    );
    expect(outcome.outcome).toBe("completed");

    // Plan reads no earlier artifact: the rerun proceeds even though
    // nothing was threaded — it must NOT refuse stage_storage_unavailable.
    const rerun = await controlOptionsStage({
      sql: sql as unknown as SqlStorage,
      runId,
      stage: "plan",
      operation: "rerun",
      userLogin: USER,
    });
    expect(rerun.state).toBe("completed");
    expect(rerun.stageUnits[0]?.status).toBe("completed");
  });

  it("caller-supplied storage still wins: a rerun reads and writes the storage it is given", async () => {
    const sql = new SqliteTestStorage();
    const engineStores: OptionsEngineStores = optionsEngineStoresFromSql(
      sql as unknown as SqlStorage,
    );
    const runId = "panel-storage:supplied";
    const shared = memoryStageStorage();
    const outcome = await runStrategyScreenViaEngine(
      {
        runId,
        userLogin: USER,
        trigger: "manual",
        request: {
          assetClass: "options",
          runIdentity: { runId },
          trigger: "manual",
          classInput: {
            strategyRequest: PANEL_REQUEST,
            alternatives: 3,
          },
        },
      },
      {
        stages: createStrategyScreenPorts({
          agents: createStrategyScreenAgents(undefined),
          storage: shared,
        }),
        claims: memoryStageClaims(),
        queue: null,
        engineStores,
      },
    );
    expect(outcome.outcome).toBe("completed");
    const before = await shared.get<{ contracts?: Array<{ underlyingPrice?: number }> }>(
      `options:${runId}:chainFetch`,
    );
    expect(before?.contracts?.[0]?.underlyingPrice).toBe(130);

    // The fixture moves: the rerun reads the plan from the SUPPLIED
    // storage and writes the refetched artifact back into it.
    DynamicOptionsScreener.setTestChainsFixture({ TREND: makeChain("TREND", 150) });
    const rerun = await controlOptionsStage({
      sql: sql as unknown as SqlStorage,
      storage: shared,
      runId,
      stage: "chainFetch",
      operation: "rerun",
      userLogin: USER,
    });
    expect(rerun.state).toBe("completed");
    const after = await shared.get<{ contracts?: Array<{ underlyingPrice?: number }> }>(
      `options:${runId}:chainFetch`,
    );
    expect(after?.contracts?.[0]?.underlyingPrice).toBe(150);
  });

  it("a panel run without engine stores is unchanged: per-call storage, same result shape", async () => {
    const result = await runOptionsPanelViaEngineWithAgents(panelAgents(), PANEL_REQUEST, {
      runId: "panel-storage:memory",
      userLogin: USER,
    });
    expect(result.bestTrade).toBeDefined();
    expect(Array.isArray(result.ranked)).toBe(true);
  });
});
