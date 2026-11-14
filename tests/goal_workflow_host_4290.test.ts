/**
 * Issue #4290 — the goal-screen host: the goal leg's dispatch surface
 * over the durable workflow host #4289 composed.
 *
 * #4289 composed the options steps into the workflow residency and
 * proved a panel screen executes through the flow; #4291 added the
 * strategy-named seam and proved the scan shape. What neither
 * provided is the GOAL shape: the shared rebuild refused it for
 * every stage, and no goal-named seam existed — the goal leg's
 * engine execution ran sync over in-memory stores inside the
 * ScreenerAgent DO, with no durable job record and no workflow step
 * as its journal (the #4274 blocker, verbatim).
 *
 * This slice makes the goal shape rebuildable through the HOST
 * only: the goal leg's shapeReport/deliver are pure functions of
 * their inputs (createGoalOptionsLegDelivery), so the resolving
 * steps rebuild them per invocation from the goal run id stamped
 * on the stored request. The #4274 decided-not-to stands for CHAT
 * control — optionsStageControl.ts is untouched, its inline goal
 * guard still refuses by name, and tests/goal_shape_stage_control_4274.test.ts
 * pins that boundary. This file pins the host side: the goal seam
 * (define + create, dispatch-time refusals that define nothing,
 * unconfigured refusal), the guard change (goal rebuildable,
 * comparison and manual delivery refusals stand), the rebuild's
 * refusal of an unstamped goal request, the goal E2E through the
 * flow with the goal leg's delivery builders, and the chained
 * start → flow → read-back through the seam.
 *
 * No production leg dispatches through the host yet: the goal leg's
 * dispatch in goalDrivenScreen.ts is untouched (a comment names the
 * host path). Cutover is blocked by named gaps — #3960 (the
 * residency binds one chain source; the leg is broker-aware),
 * #4473 (discovery-mode goal legs need universe deps, which do not
 * travel as a stage input — the seam refuses them by name), and
 * binding reachability from the leg's residency. Symbol-scoped
 * goal legs are not blocked by #4473: the screener returns explicit
 * symbols without touching universe deps.
 */
import { describe, expect, it } from "vitest";
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
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  assertOptionsStageRebuildable,
  OptionsStepPortsError,
  rebuildOptionsStepDeps,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  startGoalOptionsLegWorkflow,
} from "../src/workflows/optionsWorkflowHost";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
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

const GOAL_RUN_ID = "goal-screen:goal-host-1";

const GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-goal" },
  trigger: "manual",
  classInput: {
    goalPlan: {
      optionsFilter: { underlyingSymbols: ["AAPL"] },
      structures: ["long_call"],
    },
  },
};

/** The request as the goal seam stores it: the goal run id stamped on the plan. */
function stampedGoalRequest(goalRunId: string): Record<string, unknown> {
  return {
    ...GOAL_REQUEST,
    classInput: {
      goalPlan: { ...GOAL_REQUEST.classInput.goalPlan, goalRunId },
    },
  };
}

const DISCOVERY_GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-discovery" },
  trigger: "manual",
  classInput: {
    goalPlan: {
      optionsFilter: { minDte: 21, maxDte: 60 },
      structures: ["long_call"],
    },
  },
};

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-panel" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
    },
  },
};

const SCAN_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-scan" },
  trigger: "manual",
  classInput: { scan: { template: {} } },
};

const MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-manual" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-comparison" },
  trigger: "manual",
  classInput: { comparisonRequest: { symbols: ["AAPL"] } },
};

const UNRECOGNIZED_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "goal-host-unknown" },
  trigger: "manual",
  classInput: { somethingElse: true },
};

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

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  return { stores, runRecorder };
}

describe("goal workflow host (#4290)", () => {
  it("the goal seam defines the options job and creates the workflow instance, stamping the goal run id", async () => {
    const { stores, runRecorder } = fakeStores();
    const created: Array<{ jobId: string; trigger: string }> = [];
    const started = await startGoalOptionsLegWorkflow(
      {} as Env,
      { runId: "goal-seam:1", request: GOAL_REQUEST, goalRunId: GOAL_RUN_ID, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, trigger: params.trigger });
          return { instanceId: "wf-goal-1" };
        },
      },
    );
    // The goal leg's job identity is the options-screen job — the
    // same identity runOptionsScreenViaEngine defines for the leg
    // today — so the host's job record is the leg's job record.
    expect(started.jobId).toBe("options-screen:goal-seam:1");
    expect(started.instanceId).toBe("wf-goal-1");
    expect(created).toEqual([{ jobId: "options-screen:goal-seam:1", trigger: "manual" }]);
    const definition = await stores.definitions.getDefinition("options-screen:goal-seam:1");
    expect(definition).not.toBeNull();
    const rawConfig = definition?.rawConfig as {
      userLogin?: unknown;
      request?: { classInput?: { goalPlan?: { goalRunId?: unknown } } };
    } | null;
    expect(rawConfig?.userLogin).toBe("tester");
    expect(rawConfig?.request?.classInput?.goalPlan?.goalRunId).toBe(GOAL_RUN_ID);
  });

  it("the goal seam refuses a panel-shape request by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    let created = 0;
    const failure = await startGoalOptionsLegWorkflow(
      {} as Env,
      { runId: "goal-seam:panel", request: PANEL_REQUEST, goalRunId: GOAL_RUN_ID },
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
    expect((failure as Error).message).toMatch(/panel/);
    expect((failure as Error).message).toMatch(/goal/);
    expect(created).toBe(0);
    expect(await stores.definitions.getDefinition("options-screen:goal-seam:panel")).toBeNull();
  });

  it("the goal seam refuses manual, scan, and comparison shapes by name and defines nothing", async () => {
    for (const [name, request, hint] of [
      ["manual", MANUAL_REQUEST, /manual/],
      ["scan", SCAN_REQUEST, /scan/],
      ["comparison", COMPARISON_REQUEST, /comparison/],
    ] as const) {
      const { stores, runRecorder } = fakeStores();
      const runId = `goal-seam:${name}`;
      const failure = await startGoalOptionsLegWorkflow(
        {} as Env,
        { runId, request, goalRunId: GOAL_RUN_ID },
        { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OptionsStepPortsError);
      expect((failure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((failure as Error).message).toMatch(hint);
      expect(await stores.definitions.getDefinition(optionsScreenJobId(runId))).toBeNull();
    }
  });

  it("the goal seam refuses an unrecognized shape by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const failure = await startGoalOptionsLegWorkflow(
      {} as Env,
      { runId: "goal-seam:unknown", request: UNRECOGNIZED_REQUEST, goalRunId: GOAL_RUN_ID },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    expect(await stores.definitions.getDefinition("options-screen:goal-seam:unknown")).toBeNull();
    // A goalPlan that is present but not an object decodes as goal
    // yet cannot carry the stamped id — refused the same way.
    const malformed = await startGoalOptionsLegWorkflow(
      {} as Env,
      {
        runId: "goal-seam:malformed",
        request: {
          assetClass: "options",
          runIdentity: { runId: "goal-host-malformed" },
          trigger: "manual",
          classInput: { goalPlan: "screen AAPL" },
        },
        goalRunId: GOAL_RUN_ID,
      },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(malformed).toBeInstanceOf(OptionsStepPortsError);
    expect((malformed as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    expect(await stores.definitions.getDefinition("options-screen:goal-seam:malformed")).toBeNull();
  });

  it("the goal seam refuses a discovery-mode goal request by name (#4473) and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    let created = 0;
    const failure = await startGoalOptionsLegWorkflow(
      {} as Env,
      { runId: "goal-seam:discovery", request: DISCOVERY_GOAL_REQUEST, goalRunId: GOAL_RUN_ID },
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
    expect((failure as Error).message).toMatch(/underlyingSymbols/);
    expect((failure as Error).message).toMatch(/#4473/);
    expect(created).toBe(0);
    expect(await stores.definitions.getDefinition("options-screen:goal-seam:discovery")).toBeNull();
  });

  it("the goal seam refuses a goal request without a goal run id by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const failure = await startGoalOptionsLegWorkflow(
      {} as Env,
      { runId: "goal-seam:noid", request: GOAL_REQUEST },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
    expect((failure as Error).message).toMatch(/goal run id/i);
    expect(await stores.definitions.getDefinition("options-screen:goal-seam:noid")).toBeNull();
  });

  it("the goal seam refuses by name when the workflow residency is not configured", async () => {
    await expect(
      startGoalOptionsLegWorkflow({} as Env, {
        runId: "goal-seam:unconfigured",
        request: GOAL_REQUEST,
        goalRunId: GOAL_RUN_ID,
      }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("the guard no longer refuses the goal shape; the comparison and manual delivery refusals stand", () => {
    for (const stage of OPTIONS_PIPELINE_STAGES) {
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
    expect(() => assertOptionsStageRebuildable("panel", "deliver", "r1")).not.toThrow();
    expect(() => assertOptionsStageRebuildable("scan", "shapeReport", "r1")).not.toThrow();
  });

  it("the rebuild refuses a goal-shape request without a stamped goal run id by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    const storage = optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-goal");
    expect(() =>
      rebuildOptionsStepDeps({
        runId: "goal-rebuild:1",
        userLogin: "tester",
        request: GOAL_REQUEST,
        shape: "goal",
        storage,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    let message = "";
    try {
      rebuildOptionsStepDeps({
        runId: "goal-rebuild:1",
        userLogin: "tester",
        request: GOAL_REQUEST,
        shape: "goal",
        storage,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/goalRunId/);
    expect(message).toMatch(/#4290/);
  });

  it("runs a goal screen inside the flow: the workflow step is the engine's journal, with the goal leg's delivery builders", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores));
      const runId = "goal-host:goal:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(
        optionsScreenJobDefinition(jobId, stampedGoalRequest(GOAL_RUN_ID), "tester"),
      );
      const journal = recordingJournal();
      const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
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
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      // The persist stage records the goal leg's decided omission:
      // no canonical store is bound in the residency, so no
      // mas_reports row is written — the composing goal run's row
      // is the single canonical home (#4060, #783).
      const persist = await storage.get<{
        created: boolean;
        reportId: string | null;
        canonicalLeg?: { status: string; reason?: string };
      }>(optionsArtifactKey(runId, "persistCanonicalResults"));
      expect(persist?.created).toBe(false);
      expect(persist?.reportId).toBeNull();
      expect(persist?.canonicalLeg?.status).toBe("omitted");
      // The shapeReport artifact is the goal leg's report section:
      // leg "options", stamped with the composing goal run's id,
      // carrying the screened contracts for the goal report.
      const shapeReport = await storage.get<{
        report?: {
          leg?: string;
          goalRunId?: string;
          contracts?: unknown;
          matchedCount?: unknown;
        };
      }>(optionsArtifactKey(runId, "shapeReport"));
      expect(shapeReport?.report?.leg).toBe("options");
      expect(shapeReport?.report?.goalRunId).toBe(GOAL_RUN_ID);
      expect(Array.isArray(shapeReport?.report?.contracts)).toBe(true);
      expect(shapeReport?.report?.matchedCount).toBeDefined();
      // The deliver artifact records the handoff, not a delivery:
      // the goal run delivers; the leg defers to it.
      const deliver = await storage.get<{
        deliveryState?: { deliveryState?: string; goalRunId?: string };
      }>(optionsArtifactKey(runId, "deliver"));
      expect(deliver?.deliveryState?.deliveryState).toBe("deferred-to-goal-run");
      expect(deliver?.deliveryState?.goalRunId).toBe(GOAL_RUN_ID);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("start → flow → read-back: a goal screen through the goal seam end to end", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const runId = "goal-host:chained:1";
      const started = await startGoalOptionsLegWorkflow(
        {} as Env,
        { runId, request: GOAL_REQUEST, goalRunId: GOAL_RUN_ID, userLogin: "tester" },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-chained-1" }),
        },
      );
      expect(started.jobId).toBe(optionsScreenJobId(runId));
      const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores));
      const journal = recordingJournal();
      const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
        jobId: started.jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, started.jobId);
      expect(readBack.jobId).toBe(started.jobId);
      expect(readBack.runId).toBe(runId);
      expect(readBack.state).toBe("completed");
      expect(readBack.engineRunId).toBe(outcome.runId);
      expect(readBack.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
      for (const stage of readBack.stages) {
        expect(stage.status).toBe("completed");
      }
      const shapeReport = readBack.shapeReport as
        | { report?: { leg?: string; goalRunId?: string } }
        | undefined;
      expect(shapeReport?.report?.leg).toBe("options");
      expect(shapeReport?.report?.goalRunId).toBe(GOAL_RUN_ID);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
