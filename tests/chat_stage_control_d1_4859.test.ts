/**
 * Issue #4859 — chat stage control over D1 stores for workflow-residency
 * runs (re-scoped from cross-DO, per the owner's 2026-11-14 challenge).
 *
 * The #4274 decided-not-to stands for runs whose job record is not
 * addressable from the chat host — but the host seam (#4290, #4858)
 * persists the goal leg's job definition in the D1 residency, and the
 * chat turn's env carries the same AGENT_DB binding the residency
 * reads. So a control variant built over createJobPipelineStoresFromD1
 * drives the SAME record the workflow instance drives — definitions,
 * instances, run records, and artifacts — with no cross-DO path.
 *
 * This file pins the D1 control slice:
 * - the door builds a D1 context without the DO's SQL handle when
 *   env.AGENT_DB is present, and refuses door_unavailable only when
 *   neither is bound;
 * - control resolves the job over the DO stores first, then the D1
 *   stores, and drives the stage over whichever holds the record;
 * - the #4274 goal guard lifts ONLY where the record resolved over
 *   the D1 bundle, and stays for DO-store goal runs (the #4274 pin
 *   file keeps pinning the DO case);
 * - a run carrying a broker stage input resolves its chain source
 *   from the descriptor (the #3960 factory), never silently through
 *   the turn's default client; without a factory it refuses by name;
 * - the engine's concurrency semantics hold over the shared stores:
 *   run/rerun refuse stage_action_conflict on a live run, stop
 *   records the stage desire the live executor honors at its next
 *   boundary;
 * - the goal persist re-run records the decided omission (#4060) and
 *   never reaches a store save — #5194's descriptor-vs-string defect
 *   is unreachable from goal-shape control.
 *
 * The D1 bundle double is the in-memory stores bundle: the control
 * keys the lift on resolution over the bundle the caller built as
 * the residency bundle (production builds it from env.AGENT_DB via
 * optionsWorkflowRunDepsFromEnv); the D1 adapter itself is tested
 * elsewhere. Dispatches run through the real workflow flow
 * (runJobPipelineWorkflowFlow + the resolving steps, the #4290
 * idiom), so the artifacts land in the artifact store exactly as a
 * host dispatch leaves them.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockD1Database } from "./mock-d1";
import type { SqlStorage } from "../src/orm";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  optionsEngineStoresFromSql,
  optionsEngineStoresInMemory,
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  runOptionsScreenViaEngine,
  type OptionsEngineStores,
} from "../src/workflows/optionsScreenEngine";
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../src/workflows/optionsScreenWorkflow";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import {
  controlOptionsStageViaDoor,
  meshOptionsStageControlDoorContextFromMcp,
} from "../src/agents/orchestrator/meshOptionsStageControlDoor";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";
import {
  createScannerScreenPorts,
  createStrategyScreenAgents,
} from "../src/workflows/strategyScreenPorts";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionChainSource } from "../src/trading/optionChainSource";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";

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

/** The goal request as the goal seam stores it: the goal run id stamped on the plan. */
function stampedGoalRequest(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      goalPlan: {
        optionsFilter: { underlyingSymbols: ["AAPL"] },
        structures: ["long_call"],
        goalRunId: `goal-screen:${runId}`,
      },
      ...overrides,
    },
  };
}

/** A journal that executes the handler (the #4290 recording-journal idiom, without recording). */
const passthroughJournal = {
  step: {
    do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  },
};

function hostStepDeps(
  stores: JobPipelineStores,
  overrides: Partial<OptionsWorkflowStepDeps> = {},
): OptionsWorkflowStepDeps {
  return {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    // No chain source: the static test-chains fixture intercepts the
    // screener's fetches (the #4271 panel-helper idiom).
    chainSourceFor: () => undefined,
    ...overrides,
  };
}

function hostFlowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  deps: OptionsWorkflowStepDeps,
): JobPipelineDeps {
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), deps),
    invocation: "workflow-shard",
  };
}

/**
 * Dispatch a goal run through the real workflow flow over the given
 * bundle, exactly as the host seam leaves it: the definition in the
 * bundle's definition store, the artifacts in the bundle's artifact
 * store scoped by the engine run id. Returns the engine run id.
 */
async function dispatchGoalOverBundle(
  bundle: OptionsEngineStores,
  runId: string,
  request: Record<string, unknown>,
): Promise<string> {
  const jobId = optionsScreenJobId(runId);
  const deps = hostFlowDeps(bundle.stores, bundle.runRecorder, hostStepDeps(bundle.stores));
  const control = new JobPipelineControl(deps);
  await control.defineJob(optionsScreenJobDefinition(jobId, request, "tester"));
  const outcome = await runJobPipelineWorkflowFlow(deps, passthroughJournal.step, {
    jobId,
    trigger: "manual",
  });
  expect(outcome.state).toBe("completed");
  return outcome.runId;
}

/** The real goal leg over DO SQL stores (the #4274 dispatch idiom). */
async function dispatchGoalOverSql(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
  d1?: MockD1Database,
) {
  const request = {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      goalPlan: {
        optionsFilter: { underlyingSymbols: ["AAPL"] },
        structures: ["long_call"],
      },
    },
  };
  return runOptionsScreenViaEngine(
    { runId, userLogin: "tester", request },
    {
      stages: createOptionsScreenPorts({
        screener: new DynamicOptionsScreener(undefined),
        storage,
        ...createGoalOptionsLegDelivery({ goalRunId: `goal-screen:${runId}` }),
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql, d1 ? { AGENT_DB: d1 } : undefined),
    },
  );
}

describe("chat stage control over D1 stores (#4859)", () => {
  it("the door builds a D1 context without the DO SQL handle when env.AGENT_DB is present", () => {
    const context = meshOptionsStageControlDoorContextFromMcp({
      env: { AGENT_DB: {} } as unknown as Env,
      orm: {} as never,
      sessionId: "session-1",
      audit: () => {},
    } as never);
    expect(context.sql).toBeUndefined();
    expect(context.d1Stores).toBeDefined();
    expect(context.env).toBeDefined();
  });

  it("the door refuses door_unavailable when neither SQL nor AGENT_DB is bound", () => {
    expect(() =>
      meshOptionsStageControlDoorContextFromMcp({
        env: {} as Env,
        orm: {} as never,
        sessionId: "session-1",
        audit: () => {},
      } as never),
    ).toThrowError(expect.objectContaining({ code: "door_unavailable" }));
  });

  it("the door keeps the SQL handle and builds D1 stores when both are present", () => {
    const { sql, storage } = makeDoStorage();
    const context = meshOptionsStageControlDoorContextFromMcp({
      env: { AGENT_DB: {} } as unknown as Env,
      orm: {} as never,
      sessionId: "session-1",
      storage: storage as never,
      audit: () => {},
    } as never);
    expect(context.sql).toBe(sql);
    expect(context.d1Stores).toBeDefined();
  });

  it("the door threads d1Stores + chainSourceFor to the control seam without requiring SQL", async () => {
    const bundle = optionsEngineStoresInMemory();
    const seen: Array<Record<string, unknown>> = [];
    const result = await controlOptionsStageViaDoor(
      {
        env: { AGENT_DB: {} } as unknown as Env,
        d1Stores: bundle,
        controlStage: async (input) => {
          seen.push(input as unknown as Record<string, unknown>);
          return {
            runId: input.runId,
            jobId: "options-screen:d1-door:1",
            stage: input.stage as (typeof OPTIONS_PIPELINE_STAGES)[number],
            operation: input.operation,
            state: "completed",
            requestShape: "goal",
            stageUnits: [],
          };
        },
      },
      "tester",
      { runId: "d1-door:1", stage: "screen", operation: "rerun" },
    );
    expect(result.state).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.d1Stores).toBe(bundle);
    expect(typeof seen[0]?.chainSourceFor).toBe("function");
    expect(seen[0]?.sql).toBeUndefined();
  });

  it("a rerun of a D1 goal run's stage succeeds — the #4274 guard lifts where the record is D1-addressable", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:1";
      const engineRunId = await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      const result = await controlOptionsStage({
        d1Stores: bundle,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(result.state).toBe("completed");
      expect(result.requestShape).toBe("goal");
      expect(result.stageUnits.map((unit) => unit.status)).toEqual(["completed"]);
      // The re-run wrote through the residency's artifact store: the
      // screen artifact reads back from the threaded storage.
      const storage = optionsStageStorageFromArtifacts(bundle.stores.artifacts, engineRunId);
      const screened = await storage.get<{ result?: unknown }>(optionsArtifactKey(runId, "screen"));
      expect(screened?.result).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("run/resume on a D1 goal run reach the engine (engine codes, never the goal guard)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:2";
      await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      // Every stage completed: "run" refuses stage_already_completed
      // (re-run is the operation for a completed stage).
      const runError = await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "run",
          userLogin: "tester",
        }),
        "stage_already_completed",
      );
      expect(runError.message).toContain(runId);
      // The run is completed, not paused: "resume" refuses
      // stage_not_resumable.
      await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "resume",
          userLogin: "tester",
        }),
        "stage_not_resumable",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("stop/cancel on a D1 goal run reach the engine (engine codes, never the goal guard)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:3";
      await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "stop",
          userLogin: "tester",
        }),
        "stage_not_stoppable",
      );
      await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
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

  it("resolves over D1 when the DO stores hold no record (dual resolution, DO first)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const { sql } = makeDoStorage();
      const runId = "d1-goal:4";
      await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      const result = await controlOptionsStage({
        sql,
        d1Stores: bundle,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(result.state).toBe("completed");
      expect(result.requestShape).toBe("goal");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("a run in neither store set refuses job_not_found naming both residencies", async () => {
    const bundle = optionsEngineStoresInMemory();
    const { sql } = makeDoStorage();
    const error = await expectControlError(
      controlOptionsStage({
        sql,
        d1Stores: bundle,
        runId: "d1-goal:missing",
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      }),
      "job_not_found",
    );
    expect(error.message).toContain("d1-goal:missing");
  });

  it("the #4274 guard REMAINS for a goal run whose record lives in the DO stores, even with D1 stores passed", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:5";
      const d1 = new MockD1Database();
      expect((await dispatchGoalOverSql(sql, storage, runId, d1)).outcome).toBe("completed");
      const error = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_port_unavailable",
      );
      expect(error.message).toContain("#4274");
      expect(error.message).toContain(runId);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("refuses by name when neither SQL nor D1 stores are addressable", async () => {
    const error = await expectControlError(
      controlOptionsStage({
        runId: "d1-goal:6",
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      } as never),
      "stage_control_unavailable",
    );
    expect(error.message).toContain("d1-goal:6");
  });

  it("a D1 goal request without the stamped goal run id refuses by name at the rebuild", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:7";
      // Dispatched through the flow with an UNSTAMPED plan: the flow
      // itself refuses the rebuild, so define the job directly and
      // drive the control at the stored request instead.
      const jobId = optionsScreenJobId(runId);
      const deps = hostFlowDeps(bundle.stores, bundle.runRecorder, hostStepDeps(bundle.stores));
      const control = new JobPipelineControl(deps);
      const unstamped = {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: {
          goalPlan: {
            optionsFilter: { underlyingSymbols: ["AAPL"] },
            structures: ["long_call"],
          },
        },
      };
      await control.defineJob(optionsScreenJobDefinition(jobId, unstamped, "tester"));
      const error = await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_port_unavailable",
      );
      expect(error.message).toMatch(/goal run id/i);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});

describe("broker descriptor resolution + concurrency + #5194 non-reachability (#4859)", () => {
  const BROKER_DESCRIPTOR = { broker: "etrade", mode: "paper" };

  it("a broker descriptor resolves the chain source through the injected factory — the resolved source fetches, never the default client", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const bundle = optionsEngineStoresInMemory();
    const runId = "d1-goal:broker";
    const engineRunId = await dispatchGoalOverBundle(
      bundle,
      runId,
      stampedGoalRequest(runId, { broker: BROKER_DESCRIPTOR }),
    );
    DynamicOptionsScreener.clearTestChainsFixture();
    const calls: Array<[string, unknown, string]> = [];
    const markerSource: OptionChainSource = {
      async getOptionExpireDates() {
        throw new Error("marker-chain-source-invoked");
      },
      async getOptionChains() {
        throw new Error("marker-chain-source-invoked");
      },
    };
    const result = await controlOptionsStage({
      d1Stores: bundle,
      runId,
      stage: "chainFetch",
      operation: "rerun",
      userLogin: "tester",
      chainSourceFor: (userLogin, request, reRunId) => {
        calls.push([userLogin, request, reRunId]);
        return markerSource;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("tester");
    expect(calls[0]?.[2]).toBe(runId);
    expect(
      (calls[0]?.[1] as { classInput?: { broker?: unknown } })?.classInput?.broker,
    ).toEqual(BROKER_DESCRIPTOR);
    // The stage completed "partial": the marker source's error landed
    // in the chainFetch artifact's fetchErrors — the resolved source
    // was the one consulted, not the turn's default client.
    expect(result.state).toBe("completed");
    const storage = optionsStageStorageFromArtifacts(bundle.stores.artifacts, engineRunId);
    const fetched = await storage.get<{
      fetchErrors?: Array<{ reason?: string }>;
    }>(optionsArtifactKey(runId, "chainFetch"));
    expect(fetched?.fetchErrors?.some((entry) => entry.reason === "marker-chain-source-invoked")).toBe(
      true,
    );
  });

  it("a broker descriptor with no factory bound refuses by name (never the default client)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:broker-nofactory";
      await dispatchGoalOverBundle(
        bundle,
        runId,
        stampedGoalRequest(runId, { broker: BROKER_DESCRIPTOR }),
      );
      const error = await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "chainFetch",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_port_unavailable",
      );
      expect(error.message).toMatch(/broker/i);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("without a broker descriptor the factory is not consulted and the default path stands", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:nobroker";
      await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      const calls: Array<[string, unknown, string]> = [];
      const result = await controlOptionsStage({
        d1Stores: bundle,
        runId,
        stage: "chainFetch",
        operation: "rerun",
        userLogin: "tester",
        chainSourceFor: (userLogin, request, reRunId) => {
          calls.push([userLogin, request, reRunId]);
          return undefined;
        },
      });
      expect(calls).toHaveLength(0);
      expect(result.state).toBe("completed");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("a legacy string broker key keeps the default path — the factory is never consulted", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      // The pre-#3960 string key (the #5194 ambiguity) exists only on
      // the DO/sync path — the resolving steps refuse it, so a
      // host-dispatched run can never carry one. Dispatch a scan run
      // over DO SQL with the legacy key, then control it: only an
      // object broker value is a descriptor, so the factory stays
      // out and the turn's default path stands.
      const { sql, storage } = makeDoStorage();
      const runId = "d1-goal:stringbroker";
      const d1 = new MockD1Database();
      const target = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
      const template = {
        thesis: "bullish",
        targetDate: target,
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        minDte: 14,
        maxDte: 60,
        contractLimit: 500,
        candidateLimit: 10,
      };
      const outcome = await runOptionsScreenViaEngine(
        {
          runId,
          userLogin: "tester",
          request: {
            assetClass: "options",
            runIdentity: { runId },
            trigger: "manual",
            classInput: {
              scan: { symbols: ["AAPL"], template, options: {} },
              requestRecord: { symbols: ["AAPL"], targetDate: target, thesis: "bullish" },
              broker: "etrade",
            },
          },
        },
        {
          stages: createScannerScreenPorts({
            agents: createStrategyScreenAgents(undefined),
            storage,
          }),
          claims: memoryStageClaims(),
          queue: null,
          engineStores: optionsEngineStoresFromSql(sql, { AGENT_DB: d1 }),
        },
      );
      expect(outcome.outcome).toBe("completed");
      const calls: Array<[string, unknown, string]> = [];
      const result = await controlOptionsStage({
        sql,
        storage,
        env: { AGENT_DB: d1 },
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
        chainSourceFor: (userLogin, request, reRunId) => {
          calls.push([userLogin, request, reRunId]);
          return undefined;
        },
      });
      expect(calls).toHaveLength(0);
      expect(result.state).toBe("completed");
      expect(result.requestShape).toBe("scan");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("run/rerun refuse stage_action_conflict while the workflow instance is live; stop records the stage desire", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:live";
      await dispatchGoalOverBundle(bundle, runId, stampedGoalRequest(runId));
      const jobId = optionsScreenJobId(runId);
      const instance = await bundle.stores.instances.getInstance(jobId);
      expect(instance).not.toBeNull();
      // The workflow instance is mid-step: state running, the screen
      // unit in flight (the rest completed). The ledger keys stages
      // by node-path id (jobStageId), not the vocabulary id: the
      // screen stage is the 4th of the 8 pipeline stages, job:3.
      const checkpoint = instance?.stageCheckpoint;
      expect(checkpoint).not.toBeNull();
      const screenUnit = checkpoint?.units.find((unit) => unit.stage === "job:3");
      expect(screenUnit).toBeDefined();
      const units = checkpoint?.units.map((unit) =>
        unit.stage === "job:3" ? { ...unit, status: "running" as const } : unit,
      );
      await bundle.stores.instances.saveInstance({
        ...instance!,
        state: "running",
        stageCheckpoint: checkpoint ? { ...checkpoint, units: units! } : null,
      });
      await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "run",
          userLogin: "tester",
        }),
        "stage_action_conflict",
      );
      await expectControlError(
        controlOptionsStage({
          d1Stores: bundle,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_action_conflict",
      );
      // Stop does not execute: it records the desire the live
      // executor honors at its next boundary.
      await controlOptionsStage({
        d1Stores: bundle,
        runId,
        stage: "screen",
        operation: "stop",
        userLogin: "tester",
      });
      const after = await bundle.stores.instances.getInstance(jobId);
      // stageDesired is keyed by the same node-path stage id.
      expect(after?.stageDesired?.["job:3"]).toBe("pause");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the goal persist re-run records the decided omission — no store save, #5194 unreachable", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const bundle = optionsEngineStoresInMemory();
      const runId = "d1-goal:persist";
      const engineRunId = await dispatchGoalOverBundle(
        bundle,
        runId,
        stampedGoalRequest(runId, { broker: BROKER_DESCRIPTOR }),
      );
      // The descriptor is present on the stored request; the persist
      // stage needs no chain source, and the goal shape binds no
      // canonical store — the re-run records the omission without
      // touching the defective strategy persist save (#5194).
      const result = await controlOptionsStage({
        d1Stores: bundle,
        runId,
        stage: "persistCanonicalResults",
        operation: "rerun",
        userLogin: "tester",
        chainSourceFor: () => undefined,
      });
      expect(result.state).toBe("completed");
      const storage = optionsStageStorageFromArtifacts(bundle.stores.artifacts, engineRunId);
      const persist = await storage.get<{
        created: boolean;
        canonicalLeg?: { status: string; reason?: string };
      }>(optionsArtifactKey(runId, "persistCanonicalResults"));
      expect(persist?.created).toBe(false);
      expect(persist?.canonicalLeg?.status).toBe("omitted");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
