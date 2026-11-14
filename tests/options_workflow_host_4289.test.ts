/**
 * Issue #4289 — the options screen on the durable workflow host: the
 * options steps compose into the workflow residency's registry
 * (createJobPipelineWorkflowDeps) and dispatch through the existing
 * JobPipelineWorkflow, whose step object is the engine's journal.
 * No second engine, no new workflow class, no new binding.
 *
 * The resolving steps read the dispatch request back out of the
 * stored job definition and rebuild the stage ports per invocation
 * (the #4066 control rebuild, shared), over a stage storage adapter
 * backed by the engine's artifact store — so a later stage reads an
 * earlier stage's artifacts across executions, and a workflow replay
 * re-uses journaled step results instead of re-executing stages.
 *
 * These tests prove the composition, the per-invocation rebuild, the
 * durable storage, the named refusals (goal without a stamped goal
 * run id / comparison / manual shapeReport+deliver / missing
 * request), the start seam, and a run surviving a pause + resume
 * from the journal. (#4290 made the goal shape rebuildable through
 * the host; the goal refusal pinned here is the rebuild's refusal
 * of an unstamped goal request, not the guard's — the guard's goal
 * refusal is gone, and chat control's stands on #4274.)
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  optionsStepDepsForWorkflow,
  createJobPipelineWorkflowDeps,
} from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import {
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  strategyScreenJobDefinition,
  strategyScreenJobId,
  OPTIONS_SCREEN_ROOT_STEP,
  OPTIONS_SCREEN_STEP,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  assertOptionsStageRebuildable,
  decodeOptionsRequestShape,
  OptionsStepPortsError,
} from "../src/workflows/optionsStepPorts";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  readOptionsWorkflowRun,
  startOptionsScreenWorkflow,
} from "../src/workflows/optionsWorkflowHost";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
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
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "options-host-test" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
      // The strategy engine iterates allowedStrategies when building
      // candidates (registry.resolveMany) — an absent list throws
      // "names is not iterable" in the view-structure builder (the
      // #4271 baseStrategyRequest idiom).
      allowedStrategies: ["long_call"],
      minDte: 14,
      maxDte: 60,
    },
  },
};

const MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "options-host-manual" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "options-host-goal" },
  trigger: "manual",
  classInput: { goalPlan: { goal: "screen AAPL" } },
};

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "options-host-comparison" },
  trigger: "manual",
  classInput: { comparisonRequest: { symbols: ["AAPL"] } },
};

/** A journal that records every step name + result and executes the handler. */
function recordingJournal() {
  const entries = new Map<string, unknown>();
  const names: string[] = [];
  return {
    entries,
    names,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        const result = await fn();
        entries.set(name, result);
        return result;
      },
    },
  };
}

/** A journal pre-loaded with recorded entries: a replay returns the recorded result without executing. */
function replayingJournal(entries: Map<string, unknown>) {
  const replayed: string[] = [];
  const executed: string[] = [];
  return {
    replayed,
    executed,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (entries.has(name)) {
          replayed.push(name);
          return entries.get(name) as T;
        }
        executed.push(name);
        const result = await fn();
        entries.set(name, result);
        return result;
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

function hostFlowDeps(stores: JobPipelineStores, deps: OptionsWorkflowStepDeps): JobPipelineDeps {
  const registry = registerOptionsWorkflowSteps(createBuiltinStepRegistry(), deps);
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: registry,
    invocation: "workflow-shard",
  };
}

/** The eight pipeline stages of a getJob view (the view also carries the root node). */
function pipelineStages(view: {
  stages: Array<{
    kind: string;
    units: Array<{ status: string; error?: string }>;
  }>;
}) {
  return view.stages.filter((stage) =>
    (OPTIONS_PIPELINE_STAGES as readonly string[]).includes(stage.kind),
  );
}

function stepCtx(overrides: {
  jobId: string;
  runId?: string;
  params?: Record<string, unknown>;
  input?: unknown;
}) {
  return {
    jobId: overrides.jobId,
    runId: overrides.runId ?? "engine-run-1",
    nodePath: "0",
    kind: "plan",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: overrides.params ?? { stageId: "plan" },
    input: overrides.input ?? null,
    now: new Date().toISOString(),
  };
}

describe("options workflow host (#4289)", () => {
  it("composes the options steps into the workflow residency's registry", () => {
    const stores = createInMemoryJobPipelineStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    expect(registry.has(OPTIONS_SCREEN_STEP)).toBe(true);
    expect(registry.has(OPTIONS_SCREEN_ROOT_STEP)).toBe(true);
    expect(createBuiltinStepRegistry().has(OPTIONS_SCREEN_STEP)).toBe(false);
  });

  it("createJobPipelineWorkflowDeps carries the options steps (no new binding, no new class)", () => {
    const env = { AGENT_DB: {} } as unknown as Env;
    const deps = createJobPipelineWorkflowDeps(env);
    expect(deps.steps.has(OPTIONS_SCREEN_STEP)).toBe(true);
    expect(deps.steps.has(OPTIONS_SCREEN_ROOT_STEP)).toBe(true);
    expect(deps.invocation).toBe("workflow-shard");
  });

  it("optionsStepDepsForWorkflow binds the definition + artifact stores", () => {
    const stores = createInMemoryJobPipelineStores();
    const env = {} as Env;
    const deps = optionsStepDepsForWorkflow(env, stores);
    expect(deps.definitions).toBe(stores.definitions);
    expect(deps.artifacts).toBe(stores.artifacts);
    expect(deps.env).toBe(env);
    expect(deps.chainSourceFor?.(undefined, PANEL_REQUEST)).toBeUndefined();
  });

  it("decodes the stored request's shape, refusing an unrecognized shape by name", () => {
    expect(decodeOptionsRequestShape(PANEL_REQUEST, "r1")).toBe("panel");
    expect(decodeOptionsRequestShape(MANUAL_REQUEST, "r1")).toBe("manual");
    expect(
      decodeOptionsRequestShape(
        { classInput: { scan: { template: {} } } },
        "r1",
      ),
    ).toBe("scan");
    expect(decodeOptionsRequestShape(GOAL_REQUEST, "r1")).toBe("goal");
    expect(decodeOptionsRequestShape(COMPARISON_REQUEST, "r1")).toBe("comparison");
    for (const bad of [{}, { classInput: null }, { classInput: {} }, null]) {
      let caught: unknown;
      try {
        decodeOptionsRequestShape(bad, "r1");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OptionsStepPortsError);
      expect((caught as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    }
  });

  it("refuses unrebuildable shapes and manual delivery stages by name, before any execution", () => {
    for (const stage of OPTIONS_PIPELINE_STAGES) {
      // #4290: the goal shape rebuilds through the host — the guard
      // passes it, and the rebuild refuses a goal request with no
      // stamped goal run id. Chat control still refuses the goal
      // shape through its own guard (#4274).
      expect(() => assertOptionsStageRebuildable("goal", stage, "r1")).not.toThrow();
      expect(() => assertOptionsStageRebuildable("comparison", stage, "r1")).toThrowError(
        expect.objectContaining({ code: "stage_port_unavailable" }),
      );
    }
    expect(() => assertOptionsStageRebuildable("manual", "shapeReport", "r1")).toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    expect(() => assertOptionsStageRebuildable("manual", "deliver", "r1")).toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    expect(() => assertOptionsStageRebuildable("manual", "plan", "r1")).not.toThrow();
    expect(() => assertOptionsStageRebuildable("panel", "deliver", "r1")).not.toThrow();
    expect(() => assertOptionsStageRebuildable("scan", "shapeReport", "r1")).not.toThrow();
  });

  it("the artifact-backed stage storage round-trips, scoped per engine run", async () => {
    const stores = createInMemoryJobPipelineStores();
    const first = optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1");
    const second = optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-2");
    await first.put(optionsArtifactKey("opt-1", "plan"), { marker: "first" });
    expect(await first.get(optionsArtifactKey("opt-1", "plan"))).toEqual({ marker: "first" });
    // Same options key, different engine run: an independent store.
    expect(await second.get(optionsArtifactKey("opt-1", "plan"))).toBeUndefined();
    expect(await first.get(optionsArtifactKey("opt-1", "missing"))).toBeUndefined();
  });

  it("runs a panel screen inside the flow: the workflow step is the engine's journal", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stores = createInMemoryJobPipelineStores();
      const deps = hostFlowDeps(stores, hostStepDeps(stores));
      const runId = "options-host:panel:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(optionsScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
      const journal = recordingJournal();
      const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      // Every step invocation went through the journal, with the
      // engine's runId-scoped step names.
      expect(journal.names.length).toBeGreaterThanOrEqual(9);
      for (const name of journal.names) {
        expect(name.startsWith(`job-step:${outcome.runId}:`)).toBe(true);
      }
      const view = await control.getJob(jobId);
      const stages = pipelineStages(view);
      expect(stages.map((stage) => stage.kind)).toEqual([...OPTIONS_PIPELINE_STAGES]);
      for (const stage of stages) {
        expect(stage.units.map((unit) => unit.status)).toEqual(["completed"]);
      }
      // The shapeReport artifact is readable from the durable store
      // through the adapter — a later reader needs no in-memory state.
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      const report = await storage.get(optionsArtifactKey(runId, "shapeReport"));
      expect(report).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("serves the strategy job identity with the same steps", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stores = createInMemoryJobPipelineStores();
      const deps = hostFlowDeps(stores, hostStepDeps(stores));
      const runId = "options-host:strategy:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(strategyScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
      const journal = recordingJournal();
      const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      const view = await control.getJob(jobId);
      expect(pipelineStages(view).map((stage) => stage.kind)).toEqual([
        ...OPTIONS_PIPELINE_STAGES,
      ]);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("a run survives a workflow replay from the journal: pause, resume, no stage re-executes", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stores = createInMemoryJobPipelineStores();
      const runId = "options-host:replay:1";
      const jobId = optionsScreenJobId(runId);
      // Count stage persists through the artifact store: each stage's
      // persist writes exactly one options:<runId>:<stageId> key.
      const puts = new Map<string, number>();
      const artifacts = stores.artifacts;
      const countingArtifacts = {
        putArtifact: async (runIdArg: string, key: string, value: unknown) => {
          puts.set(key, (puts.get(key) ?? 0) + 1);
          return artifacts.putArtifact(runIdArg, key, value);
        },
        getArtifact: (runIdArg: string, key: string) =>
          artifacts.getArtifact(runIdArg, key),
        listArtifactKeys: (runIdArg: string) => artifacts.listArtifactKeys(runIdArg),
      };
      const countingStores: JobPipelineStores = { ...stores, artifacts: countingArtifacts };
      const countingDeps = hostFlowDeps(
        countingStores,
        hostStepDeps(countingStores),
      );
      const countingControl = new JobPipelineControl(countingDeps);
      await countingControl.defineJob(
        optionsScreenJobDefinition(jobId, PANEL_REQUEST, "tester"),
      );
      // First execution: pause the job when the third journaled step
      // is seen (the pause is honored at the next step boundary, so
      // the run settles paused with its checkpoint + journal).
      const firstJournal = recordingJournal();
      const pausingStep = {
        do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
          const result = await firstJournal.step.do(name, fn);
          if (firstJournal.names.length === 3) {
            await countingControl.pauseJob(jobId);
          }
          return result;
        },
      };
      const first = await runJobPipelineWorkflowFlow(countingDeps, pausingStep, {
        jobId,
        trigger: "manual",
      });
      expect(first.state).toBe("paused");
      const pausedView = await countingControl.getJob(jobId);
      expect(pausedView.instance?.state).toBe("paused");
      expect(pausedView.instance?.checkpoint).not.toBeNull();
      // Second execution: a fresh control + registry over the SAME
      // stores, with a journal pre-loaded with the first execution's
      // entries — the workflow runtime's replay. Resume re-uses the
      // engine run id, so journaled names match.
      const replay = replayingJournal(firstJournal.entries);
      const resumedControl = new JobPipelineControl({
        ...countingDeps,
        journal: replay.step,
      });
      const resumed = await resumedControl.resumeJob(jobId);
      expect(resumed.state).toBe("completed");
      expect(resumed.runId).toBe(first.runId);
      // No journaled step executed twice: every step the engine
      // re-invoked on resume returned its recorded result.
      expect(replay.executed.filter((name) => firstJournal.names.includes(name))).toEqual([]);
      // Every stage persisted exactly once across both executions.
      for (const stageId of OPTIONS_PIPELINE_STAGES) {
        expect(puts.get(optionsArtifactKey(runId, stageId))).toBe(1);
      }
      const view = await resumedControl.getJob(jobId);
      for (const stage of pipelineStages(view)) {
        expect(stage.units.map((unit) => unit.status)).toEqual(["completed"]);
      }
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, first.runId);
      expect(await storage.get(optionsArtifactKey(runId, "shapeReport"))).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("refuses a goal-shape run without a stamped goal run id by name through the flow", async () => {
    const stores = createInMemoryJobPipelineStores();
    const deps = hostFlowDeps(stores, hostStepDeps(stores));
    const runId = "options-host:goal:1";
    const jobId = optionsScreenJobId(runId);
    const control = new JobPipelineControl(deps);
    await control.defineJob(optionsScreenJobDefinition(jobId, GOAL_REQUEST));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("failed");
    const view = await control.getJob(jobId);
    const errors = view.stages.flatMap((stage) =>
      stage.units.map((unit) => unit.error ?? ""),
    );
    // The engine records the refusal's message on the failed unit
    // (the code is pinned at the throw level, below). #4290: the
    // goal shape rebuilds through the host, but the rebuild needs
    // the goal run id the goal seam stamps on the request — this
    // request carries none, so the first stage refuses by name.
    expect(errors.some((error) => error.includes("goalRunId"))).toBe(true);
  });

  it("refuses a comparison-shape run by name through the flow", async () => {
    const stores = createInMemoryJobPipelineStores();
    const deps = hostFlowDeps(stores, hostStepDeps(stores));
    const runId = "options-host:comparison:1";
    const jobId = optionsScreenJobId(runId);
    const control = new JobPipelineControl(deps);
    await control.defineJob(optionsScreenJobDefinition(jobId, COMPARISON_REQUEST));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("failed");
    const view = await control.getJob(jobId);
    const errors = view.stages.flatMap((stage) =>
      stage.units.map((unit) => unit.error ?? ""),
    );
    expect(errors.some((error) => error.includes("single engine step"))).toBe(true);
  });

  it("refuses a manual-shape run at shapeReport by name (the other six stages run)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stores = createInMemoryJobPipelineStores();
      const deps = hostFlowDeps(stores, hostStepDeps(stores, {}));
      const runId = "options-host:manual:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(
        optionsScreenJobDefinition(jobId, MANUAL_REQUEST, "tester"),
      );
      const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("failed");
      const view = await control.getJob(jobId);
      const shapeReport = view.stages.find((stage) => stage.kind === "shapeReport");
      expect(shapeReport?.units.map((unit) => unit.status)).toEqual(["failed"]);
      expect(shapeReport?.units[0]?.error).toContain("delivery builders");
      // The six rebuildable stages completed before the refusal.
      for (const stageId of [
        "plan",
        "chainFetch",
        "enrich",
        "screen",
        "risk",
        "persistCanonicalResults",
      ]) {
        const stage = view.stages.find((s) => s.kind === stageId);
        expect(stage?.units.map((unit) => unit.status)).toEqual(["completed"]);
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("refuses a run whose definition carries no request by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    const deps = hostFlowDeps(stores, hostStepDeps(stores));
    const runId = "options-host:norequest:1";
    const jobId = optionsScreenJobId(runId);
    const control = new JobPipelineControl(deps);
    await control.defineJob(optionsScreenJobDefinition(jobId));
    const outcome = await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
      jobId,
      trigger: "manual",
    });
    expect(outcome.state).toBe("failed");
    const view = await control.getJob(jobId);
    const errors = view.stages.flatMap((stage) =>
      stage.units.map((unit) => unit.error ?? ""),
    );
    expect(
      errors.some((error) => error.includes("carries no dispatch request")),
    ).toBe(true);
  });

  it("the resolving steps throw the named codes at the throw level", async () => {
    const stores = createInMemoryJobPipelineStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const goalJobId = optionsScreenJobId("options-host:codes:goal");
    await control.defineJob(optionsScreenJobDefinition(goalJobId, GOAL_REQUEST));
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId: goalJobId })),
    ).rejects.toThrowError(expect.objectContaining({ code: "stage_port_unavailable" }));
    const comparisonJobId = optionsScreenJobId("options-host:codes:comparison");
    await control.defineJob(
      optionsScreenJobDefinition(comparisonJobId, COMPARISON_REQUEST),
    );
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId: comparisonJobId })),
    ).rejects.toThrowError(expect.objectContaining({ code: "stage_port_unavailable" }));
    const noRequestJobId = optionsScreenJobId("options-host:codes:norequest");
    await control.defineJob(optionsScreenJobDefinition(noRequestJobId));
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId: noRequestJobId })),
    ).rejects.toThrowError(expect.objectContaining({ code: "stage_request_missing" }));
    // The root step refuses a missing definition by name too.
    await expect(
      registry.resolve(OPTIONS_SCREEN_ROOT_STEP)(
        stepCtx({ jobId: "options-screen:missing", params: {} }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "job_not_found" }));
    // And the root hands off the stored request when it exists.
    const root = await registry.resolve(OPTIONS_SCREEN_ROOT_STEP)(
      stepCtx({ jobId: goalJobId, params: {} }),
    );
    expect(root.output).toEqual(GOAL_REQUEST);
  });

  it("the start seam defines the job in the residency and creates the workflow instance", async () => {
    const stores = createInMemoryJobPipelineStores();
    const created: Array<{ jobId: string; params: unknown }> = [];
    const env = {} as Env;
    const started = await startOptionsScreenWorkflow(
      env,
      { runId: "options-host:start:1", request: PANEL_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, params });
          return { instanceId: "wf-1" };
        },
      },
    );
    expect(started).toEqual({
      instanceId: "wf-1",
      jobId: "options-screen:options-host:start:1",
    });
    expect(created).toEqual([
      { jobId: "options-screen:options-host:start:1", params: { trigger: "manual" } },
    ]);
    const definition = await stores.definitions.getDefinition(
      "options-screen:options-host:start:1",
    );
    expect(definition).not.toBeNull();
    expect((definition?.rawConfig as { request?: unknown }).request).toEqual(PANEL_REQUEST);
    // The acting login rides the raw config beside the request, so the
    // resolving steps can rebuild owner-scoped ports per invocation.
    expect((definition?.rawConfig as { userLogin?: string }).userLogin).toBe("tester");
  });

  it("the start seam defines the strategy job identity when asked", async () => {
    const stores = createInMemoryJobPipelineStores();
    const started = await startOptionsScreenWorkflow(
      {} as Env,
      {
        runId: "options-host:start:2",
        request: PANEL_REQUEST,
        jobKind: "strategy-screen",
      },
      {
        stores,
        runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
        startWorkflow: async () => ({ instanceId: "wf-2" }),
      },
    );
    expect(started.jobId).toBe("strategy-screen:options-host:start:2");
    const definition = await stores.definitions.getDefinition(started.jobId);
    expect(definition?.root.kind).toBe("strategy-screen");
  });

  it("the start seam refuses by name when the workflow residency is not configured", async () => {
    await expect(
      startOptionsScreenWorkflow({} as Env, {
        runId: "options-host:start:3",
        request: PANEL_REQUEST,
      }),
    ).rejects.toThrow("job_pipeline_workflow_not_configured");
    await expect(
      startOptionsScreenWorkflow(
        { JOB_PIPELINE_WORKFLOW: { create: async () => ({ id: "x" }) } } as unknown as Env,
        { runId: "options-host:start:4", request: PANEL_REQUEST },
      ),
    ).rejects.toThrow("job_pipeline_workflow_not_configured");
  });

  it("the read-back surfaces the run's state, stages, and shapeReport artifact", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stores = createInMemoryJobPipelineStores();
      const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
      const deps: JobPipelineDeps = {
        ...hostFlowDeps(stores, hostStepDeps(stores)),
        runRecorder,
      };
      const runId = "options-host:readback:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(optionsScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
      await runJobPipelineWorkflowFlow(deps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      const read = await readOptionsWorkflowRun({ stores, runRecorder }, jobId);
      expect(read.jobId).toBe(jobId);
      expect(read.runId).toBe(runId);
      expect(read.state).toBe("completed");
      expect(read.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
      expect(read.stages.every((stage) => stage.status === "completed")).toBe(true);
      expect(read.shapeReport).toBeDefined();
      await expect(
        readOptionsWorkflowRun({ stores, runRecorder }, "options-screen:missing"),
      ).rejects.toThrowError(expect.objectContaining({ code: "job_not_found" }));
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
