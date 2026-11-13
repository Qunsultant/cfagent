/**
 * Issue #4291 — the strategy-discovery host: the strategy screen's
 * dispatch surface over the durable workflow host #4289 composed.
 *
 * #4289 already composed the options steps into the workflow
 * residency and proved a panel screen executes through the flow
 * under both job identities. What #4289 did not provide is the
 * strategy-discovery dispatch surface: a strategy-named start seam
 * that fails fast on a non-strategy shape, a bounded await over the
 * read-back (the vehicle a future sync-leg cutover needs), and
 * proof that the SCAN shape — the strategy screen's other half —
 * executes through the host with scanner ports and an honest
 * no-store persist outcome.
 *
 * These tests prove the strategy seam (define + create, dispatch-time
 * refusals that define nothing, unconfigured refusal), the scan E2E
 * through the flow, the chained start → flow → read-back for a
 * panel screen through the strategy seam, and the await helper
 * (poll-to-terminal, failed view returned with its stage error,
 * named timeout with bounded reads, default wiring over real
 * stores). No production leg dispatches through the host yet: every
 * leg is blocked by a named gap (#3960 broker selection, #4453
 * scan-run store + stage queue in the residency, universe deps that
 * do not travel) — see the #4291 report.
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
  optionsStageStorageFromArtifacts,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import { OptionsStepPortsError } from "../src/workflows/optionsStepPorts";
import {
  awaitOptionsWorkflowRun,
  readOptionsWorkflowRun,
  startStrategyScreenWorkflow,
  type OptionsWorkflowRunView,
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

function targetDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-panel" },
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

const SCAN_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-scan" },
  trigger: "manual",
  classInput: {
    scan: {
      symbols: ["AAPL"],
      template: {
        thesis: "bullish",
        targetDate: targetDate(),
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
      options: { riskProfile: "balanced" },
    },
  },
};

const GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-goal" },
  trigger: "manual",
  classInput: { goalPlan: { goal: "screen AAPL" } },
};

const MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-manual" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-comparison" },
  trigger: "manual",
  classInput: { comparisonRequest: { symbols: ["AAPL"] } },
};

const UNRECOGNIZED_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-host-unknown" },
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

describe("strategy workflow host (#4291)", () => {
  it("the strategy seam defines the strategy job and creates the workflow instance", async () => {
    const { stores, runRecorder } = fakeStores();
    const created: Array<{ jobId: string; trigger: string }> = [];
    const started = await startStrategyScreenWorkflow(
      {} as Env,
      { runId: "strategy-seam:1", request: PANEL_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, trigger: params.trigger });
          return { instanceId: "wf-strategy-1" };
        },
      },
    );
    expect(started.jobId).toBe("strategy-screen:strategy-seam:1");
    expect(started.instanceId).toBe("wf-strategy-1");
    expect(created).toEqual([{ jobId: "strategy-screen:strategy-seam:1", trigger: "manual" }]);
    const definition = await stores.definitions.getDefinition("strategy-screen:strategy-seam:1");
    expect(definition).not.toBeNull();
    expect((definition?.rawConfig as { userLogin?: unknown } | null)?.userLogin).toBe("tester");
  });

  it("the strategy seam refuses a goal-shape request by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    let created = 0;
    const failure = await startStrategyScreenWorkflow(
      {} as Env,
      { runId: "strategy-seam:goal", request: GOAL_REQUEST },
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
    expect((failure as Error).message).toMatch(/goal/);
    expect((failure as Error).message).toMatch(/#4290/);
    expect(created).toBe(0);
    expect(await stores.definitions.getDefinition("strategy-screen:strategy-seam:goal")).toBeNull();
  });

  it("the strategy seam refuses manual and comparison shapes by name and defines nothing", async () => {
    for (const [name, request, hint] of [
      ["manual", MANUAL_REQUEST, /manual/],
      ["comparison", COMPARISON_REQUEST, /comparison/],
    ] as const) {
      const { stores, runRecorder } = fakeStores();
      const runId = `strategy-seam:${name}`;
      const failure = await startStrategyScreenWorkflow(
        {} as Env,
        { runId, request },
        { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OptionsStepPortsError);
      expect((failure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((failure as Error).message).toMatch(hint);
      expect(await stores.definitions.getDefinition(strategyScreenJobId(runId))).toBeNull();
    }
  });

  it("the strategy seam refuses an unrecognized shape by name and defines nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const failure = await startStrategyScreenWorkflow(
      {} as Env,
      { runId: "strategy-seam:unknown", request: UNRECOGNIZED_REQUEST },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OptionsStepPortsError);
    expect((failure as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
    expect(await stores.definitions.getDefinition("strategy-screen:strategy-seam:unknown")).toBeNull();
  });

  it("the strategy seam refuses by name when the workflow residency is not configured", async () => {
    await expect(
      startStrategyScreenWorkflow({} as Env, {
        runId: "strategy-seam:unconfigured",
        request: PANEL_REQUEST,
      }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("runs a scan screen inside the flow: the workflow step is the engine's journal", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores));
      const runId = "strategy-host:scan:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(strategyScreenJobDefinition(jobId, SCAN_REQUEST, "tester"));
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
      // The shapeReport artifact is the scan result + save receipt,
      // readable from the durable store through the adapter. No
      // scan-run store is bound in the workflow residency, so the
      // receipt carries NO persisted field at all (the #4068 fix:
      // field absent, not false) — and the persist artifact names
      // the missing store instead of failing the scan.
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      const report = await storage.get<{
        matrix?: unknown[];
        persisted?: boolean;
        scanRunId?: string;
      }>(optionsArtifactKey(runId, "shapeReport"));
      expect(report).toBeDefined();
      expect(Array.isArray(report?.matrix)).toBe(true);
      expect("persisted" in (report ?? {})).toBe(false);
      expect(report?.scanRunId).toBeUndefined();
      const persist = await storage.get<{
        saved: boolean;
        reason?: string;
      }>(optionsArtifactKey(runId, "persistCanonicalResults"));
      expect(persist?.saved).toBe(false);
      expect(persist?.reason).toMatch(/no scan run store bound/);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("start → flow → read-back: a panel screen through the strategy seam end to end", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const runId = "strategy-host:chained:1";
      const started = await startStrategyScreenWorkflow(
        {} as Env,
        { runId, request: PANEL_REQUEST, userLogin: "tester" },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-chained-1" }),
        },
      );
      expect(started.jobId).toBe(strategyScreenJobId(runId));
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
      expect(readBack.shapeReport).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("await returns the terminal view after polling through running states", async () => {
    const states: OptionsWorkflowRunView[] = ["running", "running", "completed"].map((state) => ({
      jobId: "strategy-screen:await:1",
      runId: "await:1",
      state,
      engineRunId: "engine-1",
      stages: [],
    }));
    let reads = 0;
    let slept = 0;
    const view = await awaitOptionsWorkflowRun(
      { stores: null as unknown as JobPipelineStores, runRecorder: null as unknown as JobRunRecorder },
      "strategy-screen:await:1",
      {
        intervalMs: 10,
        timeoutMs: 1000,
        readRun: async () => states[Math.min(reads++, states.length - 1)] as OptionsWorkflowRunView,
        sleep: async (ms) => {
          slept += ms;
        },
      },
    );
    expect(view.state).toBe("completed");
    expect(reads).toBe(3);
    expect(slept).toBe(20);
  });

  it("await returns a failed view with its stage error instead of throwing", async () => {
    const failed: OptionsWorkflowRunView = {
      jobId: "strategy-screen:await:2",
      runId: "await:2",
      state: "failed",
      engineRunId: "engine-2",
      stages: [{ stageId: "screen", status: "failed", error: "no chains" }],
    };
    const view = await awaitOptionsWorkflowRun(
      { stores: null as unknown as JobPipelineStores, runRecorder: null as unknown as JobRunRecorder },
      "strategy-screen:await:2",
      { readRun: async () => failed },
    );
    expect(view.state).toBe("failed");
    expect(view.stages).toEqual([{ stageId: "screen", status: "failed", error: "no chains" }]);
  });

  it("await times out by name with bounded reads when the run never settles", async () => {
    let now = 0;
    let reads = 0;
    const running: OptionsWorkflowRunView = {
      jobId: "strategy-screen:await:3",
      runId: "await:3",
      state: "running",
      engineRunId: "engine-3",
      stages: [],
    };
    const failure = await awaitOptionsWorkflowRun(
      { stores: null as unknown as JobPipelineStores, runRecorder: null as unknown as JobRunRecorder },
      "strategy-screen:await:3",
      {
        intervalMs: 1000,
        timeoutMs: 2500,
        readRun: async () => {
          reads += 1;
          return running;
        },
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/options_workflow_run_timeout/);
    expect((failure as Error).message).toMatch(/strategy-screen:await:3/);
    expect((failure as Error).message).toMatch(/running/);
    expect(reads).toBe(3);
  });

  it("await over real stores returns the completed run immediately (default wiring)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores));
      const runId = "strategy-host:await:4";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(strategyScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
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
      expect(view.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
      expect(view.shapeReport).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
