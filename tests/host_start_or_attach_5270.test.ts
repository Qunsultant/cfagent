/**
 * Issue #5270 — idempotent start-or-attach at the options host seam.
 *
 * Re-dispatching a run id whose workflow instance is still in flight
 * must never mint a second instance: the seam attaches to the
 * in-flight instance (or refuses by name when attachment is
 * impossible) instead of creating. Two layers, both reusing existing
 * machinery:
 *
 * - Residency pre-check (sequential re-dispatch, the reported
 *   defect): the job's instance record already answers whether a
 *   run is in flight — queued/running attaches with no define and
 *   no create; paused refuses by name (the settled instance cannot
 *   be attached to; resume goes through the control plane's
 *   resumeJob, which never routes through this seam); absent /
 *   idle / terminal dispatches as today.
 * - Managed create (#2989, `startManagedWorkflowInstance`): the
 *   real-binding create carries the deterministic id
 *   `workflowIdForJob(jobId)`, so two dispatches racing past the
 *   pre-check converge — the second create reports the id taken
 *   and adopts the existing instance. No fallback id: the derived
 *   id is always valid for these job shapes and always the actual
 *   id, so attach's derived fallback is never wrong.
 *
 * These tests prove the duplicate exists first (RED before the
 * fix: the attach cases create a second instance, the paused case
 * dispatches, the race case creates twice).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type {
  JobInstanceRecord,
  JobPipelineStores,
} from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { runGoalLegViaHost } from "../src/services/goalLegHostDispatch";
import {
  comparisonJobDefinition,
  comparisonJobId,
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  buildOptionsChainJobDefinition,
  optionsChainJobId,
} from "../src/services/optionsChainJobDefinition";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  readOptionsWorkflowRun,
  startComparisonWorkflow,
  startGoalOptionsLegWorkflow,
  startOptionsChainWorkflow,
  startOptionsScreenWorkflow,
  startStrategyScreenWorkflow,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { workflowIdForJob } from "../src/workflows/workflowPorts";
import type { BrokerStageInput, Env } from "../src/types";

const USER = "owner@example.com";
const RUN_ID = "attach:run-5270";
const GOAL_RUN_ID = "goal-screen:attach-5270";
const PAPER_PAIR: BrokerStageInput = { broker: "etrade", mode: "paper" };

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: RUN_ID },
  trigger: "manual",
  classInput: { strategyRequest: { symbol: "AAPL", thesis: "bullish" } },
};

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: RUN_ID },
  trigger: "manual",
  classInput: { comparisonRequest: { left: "A", right: "B" } },
};

function goalEnvelope(runId: string, optionsFilter: Record<string, unknown>) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    provenanceTrigger: "goal",
    classInput: { goalPlan: { optionsFilter, structures: ["long_call"] } },
  };
}

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
  return { stores, runRecorder };
}

function controlFor(stores: JobPipelineStores, runRecorder: JobRunRecorder) {
  return new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  });
}

/**
 * A fake workflow binding modeling the Cloudflare semantics the
 * #2989 seam relies on: create with an already-taken id throws,
 * get returns the instance (with a status() that resolves) when
 * the id exists and throws when it does not.
 */
class FakeWorkflowBinding {
  readonly creates: Array<{ id: string | undefined; params: unknown }> = [];
  private readonly instances = new Map<string, { status: string }>();

  /** Instances actually created (adoptions do not add one). */
  get instanceCount(): number {
    return this.instances.size;
  }

  async create(options: { id?: string; params?: unknown }): Promise<{ id: string }> {
    this.creates.push({ id: options.id, params: options.params });
    if (options.id !== undefined && this.instances.has(options.id)) {
      throw new Error(`workflow id taken: ${options.id}`);
    }
    const id = options.id ?? `wf-auto-${this.creates.length}`;
    this.instances.set(id, { status: "running" });
    return { id };
  }

  async get(id: string): Promise<{ status: () => Promise<{ status: string }> }> {
    const found = this.instances.get(id);
    if (!found) throw new Error(`workflow instance not found: ${id}`);
    return { status: async () => ({ status: found.status }) };
  }
}

function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: new FakeWorkflowBinding(),
    ...extra,
  } as unknown as Env;
}

/** Seed a job definition + an instance record in the given state. */
async function seedInstance(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  jobId: string,
  state: JobInstanceRecord["state"],
  runWorkflowInstanceId: string | null,
  definition: unknown,
): Promise<void> {
  const control = controlFor(stores, runRecorder);
  await control.defineJob(definition);
  const existing = await stores.instances.getInstance(jobId);
  if (!existing) throw new Error(`seed failed: no instance for ${jobId}`);
  await stores.instances.saveInstance({
    ...existing,
    state,
    currentRunId: state === "idle" ? null : "run:seed-5270",
    runStartedAt: state === "idle" ? null : new Date().toISOString(),
    runWorkflowInstanceId,
  });
}

function completedView(overrides: Partial<OptionsWorkflowRunView> = {}): OptionsWorkflowRunView {
  return {
    jobId: `options-screen:${RUN_ID}`,
    runId: RUN_ID,
    state: "completed",
    engineRunId: "engine-run-1",
    stages: [],
    ...overrides,
  };
}

describe("host start-or-attach (#5270)", () => {
  it("a second dispatch of a running job attaches: no second create, same instance id", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-first", optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startOptionsScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-first", jobId });
    expect(created).toEqual([]);
    const definition = await stores.definitions.getDefinition(jobId);
    expect(definition?.version).toBe(1);
  });

  it("a running job with no recorded workflow instance id attaches by the derived id", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", null, optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startOptionsScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: workflowIdForJob(jobId), jobId });
    expect(created).toEqual([]);
  });

  it("a queued job attaches", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "queued", "wf-first", optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startOptionsScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-first", jobId });
    expect(created).toEqual([]);
  });

  it("a paused job refuses by name: resume through the control plane, never a new instance", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "paused", "wf-first", optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    await expect(
      startOptionsScreenWorkflow(
        boundEnv(),
        { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
        {
          stores,
          runRecorder,
          startWorkflow: async (id) => {
            created.push(id);
            return { instanceId: "wf-second" };
          },
        },
      ),
    ).rejects.toThrow("options_workflow_paused_resume_required");
    expect(created).toEqual([]);
    const definition = await stores.definitions.getDefinition(jobId);
    expect(definition?.version).toBe(1);
  });

  it("a settled job re-dispatches: a fresh instance is created", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "completed", "wf-first", optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startOptionsScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-second", jobId });
    expect(created).toEqual([jobId]);
    const definition = await stores.definitions.getDefinition(jobId);
    expect(definition?.version).toBe(2);
  });

  it("an idle job dispatches: the first create happens", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await controlFor(stores, runRecorder).defineJob(optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startOptionsScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-first" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-first", jobId });
    expect(created).toEqual([jobId]);
  });

  it("concurrent re-dispatch adopts through the managed seam: one create, same id", async () => {
    const binding = new FakeWorkflowBinding();
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    // The real-binding path (no injected startWorkflow): the first
    // dispatch creates; the second finds the instance still idle
    // (the fake binding never executes runJob) and must adopt the
    // existing instance through the managed seam, not create twice.
    const first = await startOptionsScreenWorkflow(
      boundEnv({ JOB_PIPELINE_WORKFLOW: binding }),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      { stores, runRecorder },
    );
    expect(first.instanceId).toBe(workflowIdForJob(jobId));
    expect(binding.creates).toHaveLength(1);
    expect(binding.creates[0]?.id).toBe(workflowIdForJob(jobId));
    const second = await startOptionsScreenWorkflow(
      boundEnv({ JOB_PIPELINE_WORKFLOW: binding }),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      { stores, runRecorder },
    );
    expect(second).toEqual({ instanceId: workflowIdForJob(jobId), jobId });
    // Two create ATTEMPTS (the second adopted), but one instance.
    expect(binding.creates).toHaveLength(2);
    expect(binding.instanceCount).toBe(1);
  });

  it("a read failure other than job_not_found propagates fail-closed, without creating", async () => {
    const { stores, runRecorder } = fakeStores();
    const brokenStores = {
      ...stores,
      definitions: {
        ...stores.definitions,
        getDefinition: async () => {
          throw new Error("d1 down");
        },
      },
    } as JobPipelineStores;
    const created: string[] = [];
    await expect(
      startOptionsScreenWorkflow(
        boundEnv(),
        { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
        {
          stores: brokenStores,
          runRecorder,
          startWorkflow: async (id) => {
            created.push(id);
            return { instanceId: "wf-second" };
          },
        },
      ),
    ).rejects.toThrow("d1 down");
    expect(created).toEqual([]);
  });

  it("the strategy seam attaches a running strategy job", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = strategyScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-strategy", strategyScreenJobDefinition(jobId, PANEL_REQUEST));
    const created: string[] = [];
    const started = await startStrategyScreenWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: PANEL_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-strategy", jobId });
    expect(created).toEqual([]);
  });

  it("the comparison seam attaches a running comparison job", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = comparisonJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-comparison", comparisonJobDefinition(jobId, COMPARISON_REQUEST));
    const created: string[] = [];
    const started = await startComparisonWorkflow(
      boundEnv(),
      { runId: RUN_ID, request: COMPARISON_REQUEST, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-comparison", jobId });
    expect(created).toEqual([]);
  });

  it("the goal seam attaches a running goal leg", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-goal", optionsScreenJobDefinition(jobId, goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] })));
    const created: string[] = [];
    const started = await startGoalOptionsLegWorkflow(
      boundEnv(),
      {
        runId: RUN_ID,
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        broker: PAPER_PAIR,
      },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-goal", jobId });
    expect(created).toEqual([]);
  });

  it("the chain seam attaches a running chain job", async () => {
    const { stores, runRecorder } = fakeStores();
    const chain = { chainId: "chain-5270", options: { symbols: ["AAPL"] } };
    const jobId = optionsChainJobId(chain.chainId);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-chain", buildOptionsChainJobDefinition(chain));
    const created: string[] = [];
    const started = await startOptionsChainWorkflow(
      boundEnv(),
      { chain, userLogin: USER },
      {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
      },
    );
    expect(started).toEqual({ instanceId: "wf-chain", jobId });
    expect(created).toEqual([]);
  });

  it("a resumed goal leg attaches to the in-flight instance and returns its outcome", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    const screenResult = { status: "complete", totalUnderlyingsScanned: 1, matchedCount: 2 };
    await seedInstance(
      stores,
      runRecorder,
      jobId,
      "running",
      "wf-goal-flight",
      optionsScreenJobDefinition(jobId, goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] })),
    );
    await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
      optionsArtifactKey(RUN_ID, "screen"),
      { result: screenResult },
    );
    const created: string[] = [];
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (id) => {
          created.push(id);
          return { instanceId: "wf-second" };
        },
        readRun: async () => completedView({ state: "running" }),
        awaitOptions: { readRun: async () => completedView() },
      },
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([]);
  });

  it("readOptionsWorkflowRun still reports the attached run's state", async () => {
    const { stores, runRecorder } = fakeStores();
    const jobId = optionsScreenJobId(RUN_ID);
    await seedInstance(stores, runRecorder, jobId, "running", "wf-first", optionsScreenJobDefinition(jobId, PANEL_REQUEST));
    const view = await readOptionsWorkflowRun({ stores, runRecorder }, jobId);
    expect(view.state).toBe("running");
    expect(view.engineRunId).toBe("run:seed-5270");
  });
});
