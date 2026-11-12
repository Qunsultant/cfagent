// @vitest-environment node
/**
 * Issue #4272 (#3552 S2) — strategy stage vocabulary + per-stage control:
 *  - the strategy vocabulary is a named, pinned list: the same 8
 *    execution stages as the options vocabulary, BY DESIGN (the
 *    strategy pipeline IS the eight-stage options pipeline run over
 *    strategy ports, #4271) — one list, not two, so the #4067 pin
 *    stays the single source of truth;
 *  - the strategy job definition's children carry exactly those 8
 *    kinds, in pipeline order, so the engine's vocabulary walk
 *    (#3945, #4061) resolves each strategy stage to its node path
 *    under the strategy rule (#4272);
 *  - per-stage control of a strategy run works from the control
 *    plane (run / re-run / stop / resume / cancel, pinned meanings)
 *    with the same gates as an options run — the control resolves
 *    the strategy job (strategy-screen:<runId>) for a strategy run
 *    (#4271) and validates the stage against the strategy vocabulary;
 *  - the copilot surface names strategy runs: the
 *    options_copilot_stage_control tool description covers the
 *    strategy job, and the door drives a strategy run's stages.
 * "Retry" in the issue is the pinned "rerun" operation — no new
 * operation is added (the five ops are #4066's).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  optionsVocabularyStageForNodeKind,
  strategyVocabularyStageForNodeKind,
  vocabularyStageNodePath,
  type JobPipelineControl,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  OPTIONS_PIPELINE_STAGES,
  STRATEGY_ADDRESSABLE_STAGES,
  STRATEGY_PIPELINE_STAGES,
} from "../src/workflows/stageRuntimeIds";
import {
  optionsEngineStoresFromSql,
  runStrategyScreenViaEngine,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../src/workflows/optionsScreenWorkflow";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";
import {
  createStrategyScreenAgents,
  createStrategyScreenPorts,
} from "../src/workflows/strategyScreenPorts";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import { controlOptionsStageViaDoor } from "../src/agents/orchestrator/meshOptionsStageControlDoor";
import { OptionsCopilotStageControlCommand } from "../src/mcps/openaimp/meshDoorCommands";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";

const EIGHT = [
  "plan",
  "chainFetch",
  "enrich",
  "screen",
  "risk",
  "persistCanonicalResults",
  "shapeReport",
  "deliver",
] as const;

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
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          impliedVolatility: 0.25,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          impliedVolatility: 0.25,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
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

function makeDoStorage(): {
  sql: SqlStorage;
  storage: OptionsStageStorage & { sql: SqlStorage };
} {
  const sql = new SqliteTestStorage() as unknown as SqlStorage;
  const blob = memoryStageStorage();
  return { sql, storage: { ...blob, sql } };
}

function fakeEtrade() {
  return {
    client: undefined,
    fetchQuoteRemote: async () => ({ lastPrice: 100 }),
    getWatchlists: async () => [],
    screenMarketsAsync: async () => ({ stocks: [] }),
  };
}

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "control-strategy:1" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      expectedIvDirection: "unchanged",
      minDte: 21,
      maxDte: 60,
      maxPlannedLoss: 5000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
    },
    riskProfile: "balanced",
    alternatives: 3,
  },
};

async function dispatchStrategy(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
) {
  const request = { ...PANEL_REQUEST, runIdentity: { runId } };
  return runStrategyScreenViaEngine(
    { runId, userLogin: "tester", request },
    {
      stages: createStrategyScreenPorts({
        agents: createStrategyScreenAgents(undefined),
        storage,
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql),
    },
  );
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
  throw new Error(`expected a control refusal with code ${code}, but the call succeeded`);
}

function makeEngineControl(): JobPipelineControl {
  return createJobPipelineControl({
    stores: createInMemoryJobPipelineStores(),
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
  });
}

describe("strategy stage vocabulary (#4272)", () => {
  it("pins the 8 strategy stages, in pipeline order — the same 8 as the options vocabulary, by design", () => {
    expect([...STRATEGY_PIPELINE_STAGES]).toEqual([...EIGHT]);
    expect([...STRATEGY_ADDRESSABLE_STAGES]).toEqual([...STRATEGY_PIPELINE_STAGES]);
    expect([...STRATEGY_PIPELINE_STAGES]).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect([...STRATEGY_ADDRESSABLE_STAGES]).toEqual([...OPTIONS_ADDRESSABLE_STAGES]);
  });

  it("the strategy job definition's children carry exactly the 8 stage kinds, in pipeline order", () => {
    const raw = strategyScreenJobDefinition("strategy-screen:vocab:1", PANEL_REQUEST);
    const root = raw.root as { kind: string; children: Array<{ kind: string }> };
    expect(root.kind).toBe("strategy-screen");
    expect(root.children.map((c) => c.kind)).toEqual([...EIGHT]);
  });

  it("maps each of the 8 strategy stage ids onto itself; display and host kinds name no stage", () => {
    for (const stage of STRATEGY_ADDRESSABLE_STAGES) {
      expect(strategyVocabularyStageForNodeKind(stage)).toBe(stage);
      // The strategy rule coincides with the options rule by design.
      expect(optionsVocabularyStageForNodeKind(stage)).toBe(stage);
    }
    for (const kind of ["feed", "store", "serve", "gather", "analysis", "pipeline", "dummy", ""]) {
      expect(strategyVocabularyStageForNodeKind(kind)).toBeNull();
    }
  });

  it("resolves each of the 8 strategy stages of a strategy definition to its node path", async () => {
    const control = makeEngineControl();
    const definition = await control.defineJob(
      strategyScreenJobDefinition("strategy-screen:vocab:2", PANEL_REQUEST),
    );
    // The root is the strategy-screen root (not a stage); the eight
    // stages are its children 0..7 in pipeline order.
    const expected: Record<string, string> = {
      plan: "0",
      chainFetch: "1",
      enrich: "2",
      screen: "3",
      risk: "4",
      persistCanonicalResults: "5",
      shapeReport: "6",
      deliver: "7",
    };
    for (const stage of STRATEGY_ADDRESSABLE_STAGES) {
      expect(vocabularyStageNodePath(definition, stage)).toBe(expected[stage]);
    }
  });

  it("a display-only id names no control address on a strategy definition", async () => {
    const control = makeEngineControl();
    const definition = await control.defineJob(
      strategyScreenJobDefinition("strategy-screen:vocab:3", PANEL_REQUEST),
    );
    for (const stage of ["feed", "store", "serve"]) {
      expect(() => vocabularyStageNodePath(definition, stage as never)).toThrow(
        expect.objectContaining({ code: "stage_vocabulary_unknown" }),
      );
    }
  });
});

describe("strategy per-stage control (#4272)", () => {
  it("reruns a completed stage of a durable strategy run (panel shape, strategy job)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-strategy:1";
      const outcome = await dispatchStrategy(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      for (const stage of ["screen", "enrich"] as const) {
        const result = await controlOptionsStage({
          sql,
          storage,
          runId,
          stage,
          operation: "rerun",
          userLogin: "tester",
        });
        expect(result.state).toBe("completed");
        expect(result.jobId).toBe(strategyScreenJobId(runId));
        expect(result.requestShape).toBe("panel");
        expect(result.stage).toBe(stage);
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the copilot door drives a strategy run's stage (same ops, same gates)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-strategy:2";
      expect((await dispatchStrategy(sql, storage, runId)).outcome).toBe("completed");
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const result = await controlOptionsStageViaDoor(
        {
          env: {} as never,
          orm: {} as never,
          sql,
          storage: storage as never,
          createEtradeService: () => fakeEtrade() as never,
          audit: (type, _agent, payload) => {
            audits.push({ type, payload });
          },
        } as never,
        "tester",
        { runId, stage: "screen", operation: "rerun" },
      );
      expect(result.state).toBe("completed");
      expect(result.jobId).toBe(strategyScreenJobId(runId));
      expect(result.requestShape).toBe("panel");
      expect(audits.some((a) => a.type === "options_copilot.stage_control_via_door")).toBe(true);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("stop/cancel on a completed strategy run refuse with the engine's named codes", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-strategy:3";
      expect((await dispatchStrategy(sql, storage, runId)).outcome).toBe("completed");
      const stopped = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "stop",
          userLogin: "tester",
        }),
        "stage_not_stoppable",
      );
      expect(stopped.message).toContain(runId);
      await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "cancel",
          userLogin: "tester",
        }),
        "stage_not_cancellable",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an unknown stage refuses stage_vocabulary_unknown on a strategy run — display stages too", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-strategy:4";
      expect((await dispatchStrategy(sql, storage, runId)).outcome).toBe("completed");
      for (const stage of ["feed", "store", "serve", "not_a_stage"]) {
        const error = await expectControlError(
          controlOptionsStage({
            sql,
            storage,
            runId,
            stage,
            operation: "run",
            userLogin: "tester",
          }),
          "stage_vocabulary_unknown",
        );
        expect(error.message).toContain(stage);
        // The refusal names the strategy vocabulary, not only the options one.
        expect(error.message).toContain("#4272");
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an unknown run refuses job_not_found by name", async () => {
    const { sql, storage } = makeDoStorage();
    const error = await expectControlError(
      controlOptionsStage({
        sql,
        storage,
        runId: "control-strategy:never-dispatched",
        stage: "screen",
        operation: "run",
        userLogin: "tester",
      }),
      "job_not_found",
    );
    expect(error.message).toContain("control-strategy:never-dispatched");
  });

  it("a strategy run dispatched before #4066 (no stored request) refuses stage_request_missing", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-strategy:pre-4066";
      expect((await dispatchStrategy(sql, storage, runId)).outcome).toBe("completed");
      const stores = optionsEngineStoresFromSql(sql);
      const jobId = strategyScreenJobId(runId);
      const definition = await stores.stores.definitions.getDefinition(jobId);
      expect(definition).toBeDefined();
      const rawConfig = { ...(definition!.rawConfig as Record<string, unknown>) };
      delete rawConfig.request;
      await stores.stores.definitions.saveDefinition({ ...definition!, rawConfig });
      const error = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_request_missing",
      );
      expect(error.message).toContain(runId);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the stage-control tool description covers strategy runs", () => {
    const command = new OptionsCopilotStageControlCommand();
    expect(command.name).toBe("options_copilot_stage_control");
    expect(command.description).toContain("strategy-screen:<runId>");
    expect(command.description).toContain("strategy run");
    expect(command.description).toContain("#4272");
  });
});
