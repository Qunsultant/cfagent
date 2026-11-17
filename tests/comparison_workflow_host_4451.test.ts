/**
 * Issue #4451 — the comparison job through the workflow residency:
 * the comparison leg over the durable workflow host #4289 composed.
 *
 * #4289/#4291/#4290 composed the options/strategy/goal shapes into
 * the residency, but the comparison job (`comparison:<runId>`, #4276)
 * ran only through the sync engine path: no resolving registration
 * rebuilt the comparison step's ports, and no host seam started a
 * comparison run through `workflow.create`. This slice adds both,
 * following the #4291 strategy-host pattern (dispatch surface +
 * tests only; no leg moves).
 *
 * These tests prove the comparison seam (define + create,
 * dispatch-time refusals that define nothing, unconfigured
 * refusal), the resolving `comparison.run` step (shape + request +
 * env refusals at the throw level, the honest empty-snapshot
 * failure), the chained start → flow → read-back for a comparison
 * run through the seam (the real core, the real gateway port, a
 * stubbed binding — the #4402 idiom), the comparison-aware
 * read-back (one comparison stage, no shapeReport), and the await
 * helper over a comparison run. No production leg dispatches
 * through the host yet: the comparison leg's cutover is not filed
 * separately (see the #4451 report), and every leg stays blocked by
 * the named gaps (#3960 broker selection, #4473 universe deps).
 *
 * The residency comparison run writes no ledger rows: the residency
 * has no comparison-ledger sink (no D1 ledger adapter exists), so
 * the step runs with ledgerSql null — the accepted-absent
 * discipline, recorded as a limitation, not a silent gap.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
import { runIdBody } from "../src/services/executionTreeIds";
import {
  buildComparisonQuestion,
  kernelSnapshotFromDataSnapshot,
} from "../src/services/comparisonRunner";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  COMPARISON_STEP,
  comparisonJobDefinition,
  comparisonJobId,
  optionsScreenJobDefinition,
} from "../src/workflows/optionsScreenEngine";
import { OptionsStepPortsError } from "../src/workflows/optionsStepPorts";
import {
  awaitOptionsWorkflowRun,
  readOptionsWorkflowRun,
  startComparisonWorkflow,
} from "../src/workflows/optionsWorkflowHost";
import {
  createJobPipelineWorkflowDeps,
  optionsStepDepsForWorkflow,
} from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";

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

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "comparison-host-panel" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
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
  },
};

const GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "comparison-host-goal" },
  trigger: "manual",
  classInput: { goalPlan: { goal: "screen AAPL" } },
};

const MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "comparison-host-manual" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const UNRECOGNIZED_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "comparison-host-unknown" },
  trigger: "manual",
  classInput: { somethingElse: true },
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

function stepCtx(overrides: { jobId: string; runId?: string; params?: Record<string, unknown>; input?: unknown }) {
  return {
    jobId: overrides.jobId,
    runId: overrides.runId ?? "engine-run-1",
    nodePath: "0",
    kind: "comparison",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: overrides.params ?? {},
    input: overrides.input ?? null,
    now: new Date().toISOString(),
  };
}

describe("comparison workflow host (#4451)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network disabled in tests");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("the comparison seam defines the comparison job and creates the workflow instance", async () => {
    const { stores, runRecorder } = fakeStores();
    const created: Array<{ jobId: string; trigger: string }> = [];
    const started = await startComparisonWorkflow(
      {} as Env,
      { runId: "comparison-seam:1", request: COMPARISON_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, trigger: params.trigger });
          return { instanceId: "wf-comparison-1" };
        },
      },
    );
    expect(started.jobId).toBe("comparison:comparison-seam:1");
    expect(started.instanceId).toBe("wf-comparison-1");
    expect(created).toEqual([{ jobId: "comparison:comparison-seam:1", trigger: "manual" }]);
    const definition = await stores.definitions.getDefinition("comparison:comparison-seam:1");
    expect(definition).not.toBeNull();
    expect((definition?.rawConfig as { userLogin?: unknown } | null)?.userLogin).toBe("tester");
    expect((definition?.rawConfig as { request?: unknown } | null)?.request).toEqual(COMPARISON_REQUEST);
  });

  it("the comparison seam refuses panel, goal, and manual shapes by name and defines nothing", async () => {
    for (const [name, request, hint] of [
      ["panel", PANEL_REQUEST, /strategy/],
      ["goal", GOAL_REQUEST, /goal/],
      ["manual", MANUAL_REQUEST, /manual/],
    ] as const) {
      const { stores, runRecorder } = fakeStores();
      const runId = `comparison-seam:${name}`;
      let created = 0;
      const failure = await startComparisonWorkflow(
        {} as Env,
        { runId, request },
        {
          stores,
          runRecorder,
          startWorkflow: async () => {
            created += 1;
            return { instanceId: "never" };
          },
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OptionsStepPortsError);
      expect((failure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((failure as Error).message).toMatch(hint);
      expect(created).toBe(0);
      expect(await stores.definitions.getDefinition(comparisonJobId(runId))).toBeNull();
    }
  });

  it("the comparison seam refuses an unrecognized shape by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const failure = await startComparisonWorkflow(
      {} as Env,
      { runId: "comparison-seam:unknown", request: UNRECOGNIZED_REQUEST },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    expect(await stores.definitions.getDefinition("comparison:comparison-seam:unknown")).toBeNull();
  });

  it("the comparison seam refuses by name when the workflow residency is not configured", async () => {
    await expect(
      startComparisonWorkflow({} as Env, {
        runId: "comparison-seam:unconfigured",
        request: COMPARISON_REQUEST,
      }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("the comparison definition carries the acting login only when supplied (byte-identical otherwise)", () => {
    const without = comparisonJobDefinition("comparison:byte:1", COMPARISON_REQUEST);
    expect(without).not.toHaveProperty("userLogin");
    expect(without).toEqual({
      jobId: "comparison:byte:1",
      name: "Comparison comparison:byte:1",
      request: COMPARISON_REQUEST,
      root: {
        kind: "comparison",
        steps: [{ step: COMPARISON_STEP }],
        executionMode: {
          concurrency: "sequential",
          pacing: "batch",
          delivery: "sync",
          shape: "monolith",
        },
      },
    });
    const withLogin = comparisonJobDefinition("comparison:byte:2", COMPARISON_REQUEST, "tester");
    expect(withLogin.userLogin).toBe("tester");
  });

  it("composes comparison.run into the workflow residency's registry (no new wiring)", () => {
    const stores = createInMemoryJobPipelineStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    expect(registry.has(COMPARISON_STEP)).toBe(true);
    expect(createBuiltinStepRegistry().has(COMPARISON_STEP)).toBe(false);
    // The production composition carries it: optionsStepDepsForWorkflow
    // is the only wiring, and it already flows through the same
    // registration — jobPipelineWorkflow.ts needs no change.
    const env = { AGENT_DB: {} } as unknown as Env;
    const deps = createJobPipelineWorkflowDeps(env);
    expect(deps.steps.has(COMPARISON_STEP)).toBe(true);
    expect(deps.invocation).toBe("workflow-shard");
    const stepDeps = optionsStepDepsForWorkflow({} as Env, stores);
    expect(stepDeps.definitions).toBe(stores.definitions);
    expect(stepDeps.artifacts).toBe(stores.artifacts);
  });

  it("the resolving comparison step refuses non-comparison shapes by name, before any execution", async () => {
    const { stores, runRecorder } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const panelJobId = comparisonJobId("comparison-host:codes:panel");
    await control.defineJob(comparisonJobDefinition(panelJobId, PANEL_REQUEST));
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId: panelJobId })),
    ).rejects.toThrowError(expect.objectContaining({ code: "stage_port_unavailable" }));
  });

  it("the resolving comparison step refuses a missing definition, a missing request, and a requestless comparison by name", async () => {
    const { stores, runRecorder } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId: "comparison:missing" })),
    ).rejects.toThrowError(expect.objectContaining({ code: "job_not_found" }));
    const noRequestJobId = comparisonJobId("comparison-host:codes:norequest");
    await control.defineJob(comparisonJobDefinition(noRequestJobId));
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId: noRequestJobId })),
    ).rejects.toThrowError(expect.objectContaining({ code: "stage_request_missing" }));
    const noComparisonRequestJobId = comparisonJobId("comparison-host:codes:empty");
    await control.defineJob(
      comparisonJobDefinition(noComparisonRequestJobId, {
        classInput: { comparisonRequest: {} },
      }),
    );
    const failure = await registry
      .resolve(COMPARISON_STEP)(stepCtx({ jobId: noComparisonRequestJobId }))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    expect((failure as Error).message).toMatch(/comparisonRequest/);
  });

  it("the resolving comparison step refuses by name when no env is bound (the LLM arms cannot run)", async () => {
    const { stores, runRecorder } = fakeStores();
    // No env on the step deps: the comparison core needs the gateway,
    // and a quant-only comparison would misrepresent itself.
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const jobId = comparisonJobId("comparison-host:codes:noenv");
    await control.defineJob(comparisonJobDefinition(jobId, COMPARISON_REQUEST));
    const failure = await registry
      .resolve(COMPARISON_STEP)(stepCtx({ jobId }))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
    expect((failure as Error).message).toMatch(/environment|env/);
  });

  it("the resolving comparison step fails honestly on an empty snapshot", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL", []) });
    const calls: BindingCall[] = [];
    const { stores, runRecorder } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores, { env: stubGatewayEnv(calls) as unknown as Env }),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const jobId = comparisonJobId("comparison-host:codes:empty-snapshot");
    await control.defineJob(comparisonJobDefinition(jobId, COMPARISON_REQUEST));
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId })),
    ).rejects.toThrow(/no screened contracts/);
    expect(calls).toEqual([]);
  });

  it("start → flow → read-back: a comparison run through the seam end to end", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls) as unknown as Env;
    const { stores, runRecorder } = fakeStores();
    const runId = "comparison-host:chained:1";
    const started = await startComparisonWorkflow(
      {} as Env,
      { runId, request: COMPARISON_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-chained-comparison-1" }),
      },
    );
    expect(started.jobId).toBe(comparisonJobId(runId));
    const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores, { env }));
    const journal = recordingJournal();
    const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
      jobId: started.jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("completed");
    expect(journal.names.length).toBeGreaterThanOrEqual(1);
    for (const name of journal.names) {
      expect(name.startsWith(`step:${runIdBody(outcome.runId)}:`)).toBe(true);
    }
    // The real core ran through the real gateway port: generation
    // fired (the snapshot has contracts), and the recorded prompt
    // carries the question built from the stored request.
    const kinds = calls.map((call) => call.kind);
    expect(kinds).toContain("generation");
    const generation = calls.find((call) => call.kind === "generation");
    expect(JSON.stringify(generation?.inputs ?? {})).toMatch(/What bullish option strategies on AAPL/);
    // The durable record: one run, success, under the comparison job.
    const latest = await runRecorder.latestRun(started.jobId);
    expect(latest?.outcome).toBe("success");
    // The read-back: state + the single comparison stage, no
    // shapeReport (a comparison run writes none).
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, started.jobId);
    expect(readBack.jobId).toBe(started.jobId);
    expect(readBack.runId).toBe(runId);
    expect(readBack.state).toBe("completed");
    expect(readBack.engineRunId).toBe(outcome.runId);
    expect(readBack.stages).toEqual([{ stageId: "comparison", status: "completed" }]);
    expect(readBack.shapeReport).toBeUndefined();
    expect("shapeReport" in readBack).toBe(false);
  });

  it("await over real stores returns the completed comparison run immediately (default wiring)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls) as unknown as Env;
    const { stores, runRecorder } = fakeStores();
    const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores, { env }));
    const runId = "comparison-host:await:1";
    const jobId = comparisonJobId(runId);
    const control = new JobPipelineControl(deps);
    await control.defineJob(comparisonJobDefinition(jobId, COMPARISON_REQUEST, "tester"));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("completed");
    const view = await awaitOptionsWorkflowRun(
      { stores, runRecorder },
      jobId,
      { intervalMs: 10, timeoutMs: 5000 },
    );
    expect(view.state).toBe("completed");
    expect(view.engineRunId).toBe(outcome.runId);
    expect(view.stages).toEqual([{ stageId: "comparison", status: "completed" }]);
    expect(view.shapeReport).toBeUndefined();
  });

  it("the screen host's read-back is unchanged for an options-shape run (regression)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const { stores, runRecorder } = fakeStores();
    const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores));
    const runId = "comparison-host:regression:1";
    const jobId = "options-screen:comparison-host:regression:1";
    const control = new JobPipelineControl(deps);
    await control.defineJob(optionsScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("completed");
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, jobId);
    expect(readBack.state).toBe("completed");
    expect(readBack.stages.length).toBe(8);
    expect(readBack.shapeReport).toBeDefined();
  });

  it("the shared snapshot mapping and question builder match the NLQ/route contract", () => {
    const dataSnapshot: OptionsDataSnapshot = {
      symbol: "AAPL",
      contracts: [
        {
          symbol: "AAPL260314C100",
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          impliedVolatility: 0.3,
          volume: 100,
          openInterest: 500,
          underlyingPrice: 100,
        } as OptionsDataSnapshot["contracts"][number],
      ],
      dataSource: "live",
      screen: { underlyingsScanned: 1, contractsEvaluated: 1, contractsMatched: 1 },
      rejections: [],
    };
    const snapshot = kernelSnapshotFromDataSnapshot(dataSnapshot);
    expect(snapshot.symbol).toBe("AAPL");
    expect(snapshot.contracts).toBe(dataSnapshot.contracts);
    expect(snapshot.dataSource).toBe("live");
    expect(snapshot.chainProvenance).toBe("live");
    expect(snapshot.underlyingPrice).toBe(100);
    expect(snapshot.screen).toBe(dataSnapshot.screen);
    expect(snapshot.rejections).toBe(dataSnapshot.rejections);
    expect(snapshot.quotes).toEqual({
      AAPL260314C100: { bid: 1.0, ask: 1.2, iv: 0.3, volume: 100, openInterest: 500 },
    });
    const demo = kernelSnapshotFromDataSnapshot({ ...dataSnapshot, dataSource: "calibrated-demo" });
    expect(demo.chainProvenance).toBe("calibrated");
    expect(buildComparisonQuestion({
      symbol: "AAPL",
      thesis: "bullish",
      targetDate: "2026-12-14",
      maxPlannedLoss: 5_000,
    } as Parameters<typeof buildComparisonQuestion>[0])).toBe(
      "What bullish option strategies on AAPL look best for a 2026-12-14 horizon with max planned loss 5000?",
    );
    expect(buildComparisonQuestion({ symbol: "MSFT" } as Parameters<typeof buildComparisonQuestion>[0])).toBe(
      "What directional option strategies on MSFT look best for a near-term horizon with max planned loss the stated limit?",
    );
  });
});
