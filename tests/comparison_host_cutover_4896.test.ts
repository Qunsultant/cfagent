/**
 * Issue #4896 — the comparison legs' cutover onto the comparison
 * workflow host (#4451): both production legs that dispatch via
 * the sync `runComparisonViaEngine` — the NLQ leg
 * (comparisonNlqRunner) and the panel comparison route
 * (etradeOptions) — dispatch through `startComparisonWorkflow`
 * behind the established gated-cutover gate (derivation + bindings
 * + acting login), with the verbatim sync dispatch retained as the
 * gated fallback. The residency's resolving `comparison.run` step
 * writes the comparison result to stage storage, so a host-path
 * run's result is readable after settlement; the step's output
 * contract stays `{ runId }` and the comparison read-back carries
 * no shapeReport, as #4451 pinned.
 *
 * These tests prove the shared gate + host dispatch (derivation,
 * binding, and login clauses; the comparison envelope + broker
 * stamp + login on the stored definition; verbatim failure
 * surfacing; the named await timeout; the refuse-from-nothing
 * read-back), the step's artifact write through the real flow
 * (the real core, the real gateway port, a stubbed binding — the
 * #4402 idiom), the NLQ leg's host branch (no local snapshot fetch
 * on the host path, the empty-snapshot failure shape, the
 * accepted-absent ledger report), and the panel leg's dispatch
 * (the banded request on the host envelope, the unbanded request
 * on the sync envelope, the engine and direct fallbacks). The
 * ledger contract is accepted-absent (#4896): the residency has
 * no comparison-ledger sink, so a host-path run writes no ledger
 * rows and the NLQ outcome reports ledgerPersisted false — the
 * summary surface already renders that case honestly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockD1Database } from "./mock-d1";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  buildComparisonQuestion,
  comparisonEmptySnapshotError,
  kernelSnapshotFromDataSnapshot,
  runProductionComparison,
  type ProductionComparisonDeps,
  type ProductionComparisonResult,
} from "../src/services/comparisonRunner";
import { createComparisonRunner } from "../src/services/comparisonNlqRunner";
import {
  comparisonDispatchRoute,
  resolveComparisonHostDispatch,
  runComparisonViaHost,
  runPanelComparison,
  type ComparisonHostSeams,
} from "../src/services/comparisonHostDispatch";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  COMPARISON_RESULT_ARTIFACT,
  comparisonJobDefinition,
  comparisonJobId,
  optionsEngineStoresFromSql,
  optionsStageStorageFromArtifacts,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  readOptionsWorkflowRun,
  startComparisonWorkflow,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
} from "../src/trading";
import type {
  RiskProfile,
  StrategyRequest,
  StrategyScreenFilter,
} from "../src/trading";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import type { SqlStorage } from "../src/orm";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string, strikes: number[] = [95, 100, 105]): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: strikes.map((strike) => ({
      call: {
        symbol,
        optionType: "CALL",
        strikePrice: strike,
        bid: 1.0,
        ask: 1.2,
        openInterest: 500,
        volume: 100,
      },
      put: {
        symbol,
        optionType: "PUT",
        strikePrice: strike,
        bid: 1.0,
        ask: 1.2,
        openInterest: 500,
        volume: 100,
      },
    })),
  } as unknown as ETradeOptionChain;
}

function targetDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

function strategyRequest(symbol: string): StrategyRequest {
  return {
    symbol,
    thesis: "bullish",
    targetPrice: 105,
    targetDate: targetDate(),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call"],
    minDte: 14,
    maxDte: 60,
  };
}

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "comparison-host-1" },
  trigger: "manual",
  classInput: {
    comparisonRequest: {
      request: {
        symbol: "AAPL",
        thesis: "bullish",
        targetPrice: 105,
        targetDate: targetDate(),
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        minDte: 14,
        maxDte: 60,
      },
      riskProfile: "balanced",
    },
  },
};

/** Canned generation text: one real snapshot symbol + one invented symbol (dropped, never invented). */
const GENERATION_JSON = JSON.stringify({
  answer: "Bullish AAPL structures look best.",
  contractSymbols: ["AAPL260314C100", "FAKE123"],
});

/** Canned ranking text: selections over whatever candidates the core built. */
const RANKING_JSON = JSON.stringify({
  selections: [
    { candidateId: "does-not-matter", score: 90, rationale: "Better risk/reward.", risks: ["IV crush"] },
  ],
});

interface BindingCall {
  model: string;
  inputs: unknown;
  kind: "generation" | "ranking";
}

/**
 * The stubbed LLM gateway: a fake Workers AI binding (the
 * gateway_executors.test.ts / #4402 idiom). The call kind is read
 * from the prompt text, never from call order.
 */
function stubGatewayEnv(calls: BindingCall[]) {
  // The binding is an explicit run-stub on one line: the #411 pin
  // (no_live_ai_binding.test.ts) scans each `AI:` site's own line and
  // accepts only `{}`, `{ run...`, `undefined`, or `null`.
  const run = async (model: string, inputs: unknown) => {
    const kind: BindingCall["kind"] = JSON.stringify(inputs ?? {}).includes("Rank every supplied")
      ? "ranking"
      : "generation";
    calls.push({ model, inputs, kind });
    return { response: kind === "ranking" ? RANKING_JSON : GENERATION_JSON };
  };
  return { AI: { run } };
}

/** A journal that records every step name + result and executes the handler. */
function recordingJournal() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        return fn();
      },
    },
  };
}

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

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  return { stores, runRecorder };
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

/** An env carrying the residency bindings (never called — the gate checks presence only). */
function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: { create: async () => ({ id: "never-called" }) },
    ...extra,
  } as unknown as Env;
}

function runIdFromJobId(jobId: string): string {
  return jobId.slice(jobId.indexOf(":") + 1);
}

/**
 * A fake await read that seeds the comparison result artifact under
 * the run's engine id before reporting completion — the run id is
 * minted inside the dispatch, so the seeding happens lazily, on
 * the first read, from the job id the dispatch started.
 */
function seedingReadRun(stores: JobPipelineStores) {
  return async (jobId: string): Promise<OptionsWorkflowRunView> => {
    const runId = runIdFromJobId(jobId);
    const engineRunId = `engine:${runId}`;
    await optionsStageStorageFromArtifacts(stores.artifacts, engineRunId).put(
      optionsArtifactKey(runId, COMPARISON_RESULT_ARTIFACT),
      cannedComparisonResult(runId),
    );
    return {
      jobId,
      runId,
      state: "completed",
      engineRunId,
      stages: [{ stageId: "comparison", status: "completed" }],
    };
  };
}

function failingReadRun(error: string) {
  return async (jobId: string): Promise<OptionsWorkflowRunView> => ({
    jobId,
    runId: runIdFromJobId(jobId),
    state: "failed",
    engineRunId: null,
    stages: [{ stageId: "comparison", status: "failed", error }],
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
  vi.unstubAllGlobals();
});

describe("comparison host gate (#4896)", () => {
  it("routes to the host when the pair derives, the login is present, and the bindings are configured", () => {
    const { decision, broker } = resolveComparisonHostDispatch(boundEnv(), "etrade", "TEST", "tester");
    expect(broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(decision.route).toBe("host");
  });

  it("derives live mode from the PROD override", () => {
    const { broker } = resolveComparisonHostDispatch(boundEnv(), "etrade", "PROD", "tester");
    expect(broker).toEqual({ broker: "etrade", mode: "live" });
  });

  it("derives the mode from the env when no override is given (the session's own resolution)", () => {
    const sandbox = resolveComparisonHostDispatch(
      boundEnv({ ETRADE_ENVIRONMENT: "sandbox" }),
      "etrade",
      undefined,
      "tester",
    );
    expect(sandbox.broker).toEqual({ broker: "etrade", mode: "paper" });
    const live = resolveComparisonHostDispatch(
      boundEnv({ ETRADE_ENVIRONMENT: "live" }),
      "etrade",
      undefined,
      "tester",
    );
    expect(live.broker).toEqual({ broker: "etrade", mode: "live" });
  });

  it("stays on sync when no broker pair derives", () => {
    const { decision, broker } = resolveComparisonHostDispatch(
      boundEnv(),
      "unknown-broker" as never,
      "TEST",
      "tester",
    );
    expect(broker).toBeNull();
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/broker/);
  });

  it("stays on sync when no acting login is present (the chain factory yields no source without one)", () => {
    const { decision } = resolveComparisonHostDispatch(boundEnv(), "etrade", "TEST", undefined);
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/login/);
    const empty = resolveComparisonHostDispatch(boundEnv(), "etrade", "TEST", "");
    expect(empty.decision.route).toBe("sync");
  });

  it("stays on sync when the residency bindings are not configured", () => {
    const noDb = comparisonDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: {} as Env,
      userLogin: "tester",
    });
    expect(noDb.route).toBe("sync");
    expect(noDb.reason).toMatch(/bindings/);
    const noWorkflow = comparisonDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: { AGENT_DB: {} } as unknown as Env,
      userLogin: "tester",
    });
    expect(noWorkflow.route).toBe("sync");
    const noCreate = comparisonDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: { AGENT_DB: {}, JOB_PIPELINE_WORKFLOW: {} } as unknown as Env,
      userLogin: "tester",
    });
    expect(noCreate.route).toBe("sync");
  });
});

describe("comparison host dispatch (#4896)", () => {
  it("starts through the seam, awaits settlement, and reads the result artifact back", async () => {
    const { stores, runRecorder } = fakeStores();
    const starts: Array<{ jobId: string; params: unknown }> = [];
    const seams: ComparisonHostSeams = {
      startWorkflow: async (jobId, params) => {
        starts.push({ jobId, params });
        return { instanceId: "wf-4896-1" };
      },
      stores,
      runRecorder,
      awaitOptions: { readRun: seedingReadRun(stores) },
    };
    const request = strategyRequest("AAPL");
    const result = await runComparisonViaHost({
      env: boundEnv(),
      request,
      riskProfile: "balanced",
      runId: "cmp-host-1",
      userLogin: "tester",
      broker: { broker: "etrade", mode: "paper" },
      seams,
    });
    expect(result).toEqual(cannedComparisonResult("cmp-host-1"));
    expect(starts).toHaveLength(1);
    expect(starts[0]!.jobId).toBe(comparisonJobId("cmp-host-1"));

    // The stored definition carries the comparison envelope, the
    // broker stamp, and the acting login — the resolving step
    // rebuilds the run from it.
    const definition = await stores.definitions.getDefinition(comparisonJobId("cmp-host-1"));
    const rawConfig = definition?.rawConfig as {
      request?: { classInput?: Record<string, unknown> };
      userLogin?: unknown;
    };
    expect(rawConfig?.userLogin).toBe("tester");
    const classInput = rawConfig?.request?.classInput as {
      comparisonRequest?: { request?: unknown; riskProfile?: unknown };
      broker?: unknown;
    };
    expect(classInput?.comparisonRequest?.request).toEqual(request);
    expect(classInput?.comparisonRequest?.riskProfile).toBe("balanced");
    expect(classInput?.broker).toEqual({ broker: "etrade", mode: "paper" });
  });

  it("carries the strategy filter and the banded request on the stored envelope", async () => {
    const { stores, runRecorder } = fakeStores();
    const filter: StrategyScreenFilter = { allowedStrategies: ["long_call"] } as StrategyScreenFilter;
    const banded = {
      ...strategyRequest("AAPL"),
      expirationDteBands: [{ minDte: 60, maxDte: 365 }],
    } as StrategyRequest;
    await runComparisonViaHost({
      env: boundEnv(),
      request: banded,
      riskProfile: "aggressive",
      strategyFilter: filter,
      runId: "cmp-host-banded",
      userLogin: "tester",
      broker: { broker: "etrade", mode: "paper" },
      seams: {
        startWorkflow: async () => ({ instanceId: "wf-4896-banded" }),
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    const definition = await stores.definitions.getDefinition(comparisonJobId("cmp-host-banded"));
    const stored = (
      definition?.rawConfig as {
        request?: { classInput?: { comparisonRequest?: { request?: Record<string, unknown>; strategyFilter?: unknown } } };
      }
    )?.request?.classInput?.comparisonRequest;
    expect(stored?.request).toEqual(banded);
    expect(stored?.strategyFilter).toEqual(filter);
  });

  it("throws the failed run's stage error verbatim (the sync dispatch rethrows the original error)", async () => {
    const { stores, runRecorder } = fakeStores();
    const stageError = "Comparison snapshot for AAPL has no screened contracts.";
    await expect(
      runComparisonViaHost({
        env: boundEnv(),
        request: strategyRequest("AAPL"),
        riskProfile: "balanced",
        runId: "cmp-host-failed",
        userLogin: "tester",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          startWorkflow: async () => ({ instanceId: "wf-4896-failed" }),
          stores,
          runRecorder,
          awaitOptions: { readRun: failingReadRun(stageError) },
        },
      }),
    ).rejects.toThrow(stageError);
  });

  it("refuses to answer from nothing when the run completes without a result artifact", async () => {
    const { stores, runRecorder } = fakeStores();
    const readRun = async (jobId: string): Promise<OptionsWorkflowRunView> => ({
      jobId,
      runId: runIdFromJobId(jobId),
      state: "completed",
      engineRunId: "engine:no-artifact",
      stages: [{ stageId: "comparison", status: "completed" }],
    });
    await expect(
      runComparisonViaHost({
        env: boundEnv(),
        request: strategyRequest("AAPL"),
        riskProfile: "balanced",
        runId: "cmp-host-no-artifact",
        userLogin: "tester",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          startWorkflow: async () => ({ instanceId: "wf-4896-no-artifact" }),
          stores,
          runRecorder,
          awaitOptions: { readRun },
        },
      }),
    ).rejects.toThrow(/without a result artifact|refusing to answer from nothing/);
  });

  it("surfaces the named await timeout when the run never settles", async () => {
    const { stores, runRecorder } = fakeStores();
    let now = 0;
    const readRun = async (jobId: string): Promise<OptionsWorkflowRunView> => ({
      jobId,
      runId: runIdFromJobId(jobId),
      state: "running",
      engineRunId: null,
      stages: [],
    });
    await expect(
      runComparisonViaHost({
        env: boundEnv(),
        request: strategyRequest("AAPL"),
        riskProfile: "balanced",
        runId: "cmp-host-timeout",
        userLogin: "tester",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          startWorkflow: async () => ({ instanceId: "wf-4896-timeout" }),
          stores,
          runRecorder,
          awaitOptions: {
            readRun,
            sleep: async () => {
              now += 200;
            },
            now: () => now,
            timeoutMs: 100,
            intervalMs: 1,
          },
        },
      }),
    ).rejects.toThrow(/options_workflow_run_timeout/);
  });
});

describe("resolving comparison step artifact write (#4896)", () => {
  it("start → flow: the step writes the comparison result to stage storage, readable after settlement", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls) as unknown as Env;
    const { stores, runRecorder } = fakeStores();
    const runId = "comparison-host:artifact:1";
    const started = await startComparisonWorkflow(
      {} as Env,
      { runId, request: COMPARISON_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-artifact-1" }),
      },
    );
    const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores, { env }));
    const journal = recordingJournal();
    const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
      jobId: started.jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("completed");
    // The real core ran through the real gateway port.
    expect(calls.map((call) => call.kind)).toContain("generation");

    // The artifact is readable through the adapter under the
    // engine run id, keyed by the comparison run id.
    const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
    const result = await storage.get<ProductionComparisonResult>(
      optionsArtifactKey(runId, COMPARISON_RESULT_ARTIFACT),
    );
    expect(result).toBeDefined();
    expect(result!.artifact.runId).toBe(runId);
    expect(Object.keys(result!.artifact.arms).sort()).toEqual(["hybrid", "llm", "quant"]);
    expect(result!.generationNotes).toBeDefined();

    // The read-back is unchanged: one comparison stage, no
    // shapeReport (the #4451 pin — the artifact is a leg-side
    // read, not a view field).
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, started.jobId);
    expect(readBack.stages).toEqual([{ stageId: "comparison", status: "completed" }]);
    expect("shapeReport" in readBack).toBe(false);
    expect(readBack.engineRunId).toBe(outcome.runId);
  });

  it("start → flow: an empty snapshot fails the run with the shared empty-snapshot message", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL", []) });
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls) as unknown as Env;
    const { stores, runRecorder } = fakeStores();
    const runId = "comparison-host:artifact:empty";
    const started = await startComparisonWorkflow(
      {} as Env,
      { runId, request: COMPARISON_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-artifact-empty" }),
      },
    );
    const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores, { env }));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId: started.jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("failed");
    expect(calls).toEqual([]);
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, started.jobId);
    expect(readBack.stages).toHaveLength(1);
    expect(readBack.stages[0]!.status).toBe("failed");
    // The engine records the step's error wrapped with the step
    // context; the shared message survives inside it, so the
    // host path reports the same failure the sync path does.
    expect(readBack.stages[0]!.error).toContain(comparisonEmptySnapshotError("AAPL").message);
  });
});

describe("NLQ comparison leg host cutover (#4896)", () => {
  it("dispatches through the host seam without a local snapshot fetch, and reports the ledger as absent", async () => {
    // No test-chains fixture: a local fetch would fail. The host
    // path must never touch the snapshot.
    const { stores, runRecorder } = fakeStores();
    const starts: string[] = [];
    const runner = createComparisonRunner({
      client: undefined,
      env: boundEnv({ ETRADE_ENVIRONMENT: "sandbox" }),
    });
    const outcome = await runner.run({
      request: strategyRequest("NVDA"),
      riskProfile: "balanced",
      userLogin: "legs_tester",
      hostSeams: {
        startWorkflow: async (jobId) => {
          starts.push(jobId);
          return { instanceId: "wf-nlq-1" };
        },
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ledgerPersisted).toBe(false);
    expect(starts).toHaveLength(1);
    const runId = runIdFromJobId(starts[0]!);
    expect(outcome.result).toEqual(cannedComparisonResult(runId));
    // The stored definition carries the broker stamp and the login.
    const definition = await stores.definitions.getDefinition(starts[0]!);
    const rawConfig = definition?.rawConfig as {
      request?: { classInput?: { broker?: unknown } };
      userLogin?: unknown;
    };
    expect(rawConfig?.userLogin).toBe("legs_tester");
    expect(rawConfig?.request?.classInput?.broker).toEqual({ broker: "etrade", mode: "paper" });
  });

  it("stays on the sync dispatch when no acting login is threaded", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: makeChain("NVDA") });
    const calls: BindingCall[] = [];
    const { stores, runRecorder } = fakeStores();
    let started = 0;
    const runner = createComparisonRunner({
      client: undefined,
      env: boundEnv(stubGatewayEnv(calls)),
    });
    const outcome = await runner.run({
      request: strategyRequest("NVDA"),
      riskProfile: "balanced",
      hostSeams: {
        startWorkflow: async () => {
          started += 1;
          return { instanceId: "wf-nlq-never" };
        },
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(started).toBe(0);
    expect(outcome.ok).toBe(true);
    expect(calls.map((call) => call.kind)).toContain("generation");
  });

  it("stays on the sync dispatch when the residency bindings are not configured", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: makeChain("NVDA") });
    const calls: BindingCall[] = [];
    const { stores, runRecorder } = fakeStores();
    let started = 0;
    const runner = createComparisonRunner({
      client: undefined,
      env: stubGatewayEnv(calls) as unknown as Env,
    });
    const outcome = await runner.run({
      request: strategyRequest("NVDA"),
      riskProfile: "balanced",
      userLogin: "legs_tester",
      hostSeams: {
        startWorkflow: async () => {
          started += 1;
          return { instanceId: "wf-nlq-never" };
        },
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(started).toBe(0);
    expect(outcome.ok).toBe(true);
  });

  it("maps a host-path empty snapshot to the runner's failure shape with the shared message", async () => {
    const { stores, runRecorder } = fakeStores();
    const runner = createComparisonRunner({ client: undefined, env: boundEnv() });
    const outcome = await runner.run({
      request: strategyRequest("AAPL"),
      riskProfile: "balanced",
      userLogin: "legs_tester",
      hostSeams: {
        startWorkflow: async () => ({ instanceId: "wf-nlq-empty" }),
        stores,
        runRecorder,
        awaitOptions: {
          readRun: failingReadRun(comparisonEmptySnapshotError("AAPL").message),
        },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ledgerPersisted).toBe(false);
    expect(outcome.error).toBe(comparisonEmptySnapshotError("AAPL").message);
  });

  it("maps any other host-path failure to the runner's failure shape with the stage error verbatim", async () => {
    const { stores, runRecorder } = fakeStores();
    const runner = createComparisonRunner({ client: undefined, env: boundEnv() });
    const outcome = await runner.run({
      request: strategyRequest("AAPL"),
      riskProfile: "balanced",
      userLogin: "legs_tester",
      hostSeams: {
        startWorkflow: async () => ({ instanceId: "wf-nlq-failed" }),
        stores,
        runRecorder,
        awaitOptions: { readRun: failingReadRun("chain fetch refused: no source") },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("chain fetch refused: no source");
  });
});

describe("panel comparison dispatch (#4896)", () => {
  async function panelCoreArgs(
    env: Env,
    request: StrategyRequest,
  ): Promise<ProductionComparisonDeps> {
    const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(undefined));
    const snapshot = kernelSnapshotFromDataSnapshot(await dataAgent.loadSnapshot(request));
    const riskAgent = new StrategyRiskAgent();
    const recommender = new RecommendationAgent();
    return {
      snapshot,
      request,
      question: buildComparisonQuestion(request),
      riskProfile: "balanced",
      buildFn: (contracts, req) => riskAgent.buildStrategies(contracts, req as StrategyRequest),
      rankFn: (candidates, req, profile) =>
        recommender.rank(candidates, req as unknown as StrategyRequest, profile),
      screenFn: (candidates, filter) => riskAgent.screenStrategies(candidates, filter),
      env,
    };
  }

  it("dispatches through the host with the banded request when the gate resolves to the host", async () => {
    const { stores, runRecorder } = fakeStores();
    const starts: string[] = [];
    const banded = {
      ...strategyRequest("AAPL"),
      expirationDteBands: [{ minDte: 60, maxDte: 365 }],
    } as StrategyRequest;
    const result = await runPanelComparison({
      env: boundEnv(),
      requestedEnv: "TEST",
      userLogin: "legs_tester",
      brokerId: "etrade",
      request: banded,
      riskProfile: "balanced",
      coreArgs: {} as unknown as ProductionComparisonDeps,
      hostSeams: {
        startWorkflow: async (jobId) => {
          starts.push(jobId);
          return { instanceId: "wf-panel-1" };
        },
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(starts).toHaveLength(1);
    expect(result).toEqual(cannedComparisonResult(runIdFromJobId(starts[0]!)));
    // The stored request carries the banded request, so the
    // step's fetch matches the route's local fetch exactly.
    const definition = await stores.definitions.getDefinition(starts[0]!);
    const stored = (
      definition?.rawConfig as {
        request?: { classInput?: { comparisonRequest?: { request?: Record<string, unknown> }; broker?: unknown } };
        userLogin?: unknown;
      }
    );
    expect(stored?.userLogin).toBe("legs_tester");
    expect(stored?.request?.classInput?.comparisonRequest?.request).toEqual(banded);
    expect(stored?.request?.classInput?.broker).toEqual({ broker: "etrade", mode: "paper" });
  });

  it("falls back to the sync engine dispatch when the gate refuses, with the unbanded request on the envelope", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const calls: BindingCall[] = [];
    const gatewayEnv = stubGatewayEnv(calls) as unknown as Env;
    const sql = new SqliteTestStorage();
    const { stores, runRecorder } = fakeStores();
    let started = 0;
    const request = strategyRequest("AAPL");
    const banded = {
      ...request,
      expirationDteBands: [{ minDte: 60, maxDte: 365 }],
    } as StrategyRequest;
    const coreArgs = await panelCoreArgs(gatewayEnv, request);
    const result = await runPanelComparison({
      env: { ...gatewayEnv, AGENT_DB: new MockD1Database() },
      requestedEnv: "TEST",
      userLogin: "legs_tester",
      brokerId: "etrade",
      request: banded,
      riskProfile: "balanced",
      coreArgs,
      storageSql: sql as unknown as SqlStorage,
      hostSeams: {
        startWorkflow: async () => {
          started += 1;
          return { instanceId: "wf-panel-never" };
        },
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(started).toBe(0);
    expect(result.artifact.runId).toMatch(/^cmp-/);
    expect(Object.keys(result.artifact.arms).sort()).toEqual(["hybrid", "llm", "quant"]);
    // The sync engine job is defined over the caller's stores,
    // carrying the unbanded request — the sync envelope is
    // unchanged by the cutover.
    const reader = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const definitions = await reader.stores.definitions.listDefinitions();
    const comparisonJobs = definitions.filter(
      (definition) => (definition.root as { kind?: string }).kind === "comparison",
    );
    expect(comparisonJobs).toHaveLength(1);
    const stored = (
      comparisonJobs[0]!.rawConfig as {
        request?: { classInput?: { comparisonRequest?: { request?: Record<string, unknown> } } };
      }
    )?.request?.classInput?.comparisonRequest?.request;
    expect(stored?.symbol).toBe("AAPL");
    expect(stored).not.toHaveProperty("expirationDteBands");
  });

  it("falls back to the direct core dispatch when the gate refuses and no SQL handle is present", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const calls: BindingCall[] = [];
    const gatewayEnv = stubGatewayEnv(calls) as unknown as Env;
    const request = strategyRequest("AAPL");
    const coreArgs = await panelCoreArgs(gatewayEnv, request);
    const result = await runPanelComparison({
      env: gatewayEnv,
      requestedEnv: "TEST",
      userLogin: "legs_tester",
      brokerId: "etrade",
      request,
      riskProfile: "balanced",
      coreArgs,
    });
    expect(result.artifact.runId).toBeDefined();
    expect(Object.keys(result.artifact.arms).sort()).toEqual(["hybrid", "llm", "quant"]);
    expect(calls.map((call) => call.kind)).toContain("generation");
  });

  it("throws a host-path failure verbatim (the route's catch maps it, as on the sync path)", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      runPanelComparison({
        env: boundEnv(),
        requestedEnv: "TEST",
        userLogin: "legs_tester",
        brokerId: "etrade",
        request: strategyRequest("AAPL"),
        riskProfile: "balanced",
        coreArgs: {} as unknown as ProductionComparisonDeps,
        hostSeams: {
          startWorkflow: async () => ({ instanceId: "wf-panel-failed" }),
          stores,
          runRecorder,
          awaitOptions: { readRun: failingReadRun("chain fetch refused: no source") },
        },
      }),
    ).rejects.toThrow("chain fetch refused: no source");
  });
});

describe("comparison ledger contract (#4896)", () => {
  it("the empty-snapshot failure message has one source, shared by the step and the runner", () => {
    expect(comparisonEmptySnapshotError("AAPL").message).toBe(
      "Comparison snapshot for AAPL has no screened contracts.",
    );
    expect(comparisonEmptySnapshotError("NVDA").message).toBe(
      "Comparison snapshot for NVDA has no screened contracts.",
    );
  });

  it("the resolving step's core call runs with no ledger sink (accepted-absent, pinned by the host outcome)", async () => {
    // The step hardcodes ledgerSql null (no D1 comparison-ledger
    // adapter exists); the observable pin is the NLQ host
    // outcome, which reports the run as not persisted. The
    // summary surface renders that case with its honest note.
    const { stores, runRecorder } = fakeStores();
    const runner = createComparisonRunner({ client: undefined, env: boundEnv() });
    const outcome = await runner.run({
      request: strategyRequest("NVDA"),
      riskProfile: "balanced",
      userLogin: "legs_tester",
      hostSeams: {
        startWorkflow: async () => ({ instanceId: "wf-ledger-1" }),
        stores,
        runRecorder,
        awaitOptions: { readRun: seedingReadRun(stores) },
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ledgerPersisted).toBe(false);
    expect(outcome.result).toBeDefined();
  });
});
