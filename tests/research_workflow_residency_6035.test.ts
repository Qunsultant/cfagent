/**
 * Issue #6035 (b) — the OODA run dispatches through the workflow residency.
 *
 * The residency and its research stage deps already exist (#5237); this slice
 * adds the start seam and the dispatch branch. What this file pins without a
 * real D1 residency (the same seam is exercised end-to-end by the options-host
 * suites; the D1 adapter has its own):
 *
 *  R1  availability is a binding fact: no workflow binding or no AGENT_DB means
 *      "not dispatchable", and the start seam refuses BY NAME rather than
 *      silently falling back to a second scheduler;
 *  R2  a deployment without the residency keeps today's in-process sync run —
 *      `durableResidency` stays absent and the caller's execute is what runs;
 *  R3  the definition the durable path defines has exactly ONE node per stage,
 *      each with ONE step — so the workflow's node loop yields one durable step
 *      per stage, which is the point of the slice.
 *
 * Issue #6466 (R4–R8) — a run that never starts is visible, not blank `idle`:
 *
 *  R4  the dispatch stamps the workflow instance id onto the run record:
 *      after a fresh start the instance row carries `runWorkflowInstanceId`,
 *      `runStartedAt`, and state `idle` — so `getJob` returns it from the start;
 *  R5  the stamp refuses on a live instance (queued / running / paused):
 *      a `running` stamp would break the workflow's own `runJob`, which
 *      refuses `job_already_running` on those states — the stamp never
 *      weakens that guard;
 *  R6  the host stamps on a fresh start and logs the dispatch: the
 *      `job.run.dispatched` event carries jobId / runId /
 *      workflowInstanceId / trigger, and an in-flight re-dispatch attaches
 *      instead of restamping;
 *  R7  the settlement timeout error names the instance: the wait's error
 *      carries the stamped instance id and start time, so the page can show
 *      which engine run it waited on instead of a bare `idle`.
 */
import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import {
  dispatchResearchEngineRun,
  type DispatchResearchEngineInput,
} from "../src/workflows/researchScreenEngine";
import {
  researchWorkflowResidencyAvailable,
  startResearchJobWorkflow,
  awaitResearchJobSettlement,
} from "../src/workflows/researchWorkflowHost";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";
import { RESEARCH_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";

const NOW = Date.now();

function baseInput(overrides: Partial<DispatchResearchEngineInput> = {}): DispatchResearchEngineInput {
  return {
    userLogin: "owner",
    trigger: "manual",
    runId: "run-6035b",
    env: {},
    execute: async () => ({ report: "in-process" }),
    ...overrides,
  };
}

/** A bare control over in-memory stores, for the engine-level stamp pins. */
function memControl() {
  const stores = createInMemoryJobPipelineStores();
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
  });
  return { stores, control };
}

function memResidency() {
  const stores = createInMemoryJobPipelineStores();
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
  };
}

describe("#6035 (b) — durable residency dispatch", () => {
  it("R1: availability is a binding fact, and an unbound start refuses by name", async () => {
    expect(researchWorkflowResidencyAvailable(undefined)).toBe(false);
    expect(researchWorkflowResidencyAvailable({} as Env)).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({ JOB_PIPELINE_WORKFLOW: {} } as unknown as Env),
    ).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({ AGENT_DB: {} } as unknown as Env),
    ).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({
        JOB_PIPELINE_WORKFLOW: { create: () => Promise.resolve({ id: "x" }) },
        AGENT_DB: {},
      } as unknown as Env),
    ).toBe(true);

    await expect(
      startResearchJobWorkflow({
        env: {} as Env,
        definition: {},
        engineJobId: "research:run-6035b",
        trigger: "manual",
      }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("R2: without the residency the run keeps the in-process sync path", async () => {
    let executed = 0;
    const result = await dispatchResearchEngineRun(
      baseInput({
        durableEnv: {} as Env, // unbound deployment
        execute: async () => {
          executed += 1;
          return { report: "in-process" };
        },
      }),
    );
    expect(executed).toBe(1);
    expect(result.cutoverMode).toBe("engine");
    expect(result.durableResidency).toBeUndefined();
    expect(result.outcome).toEqual({ report: "in-process" });
    // The stage mapping is the same on both paths.
    expect(result.stageVisibility.map((stage) => stage.stageId)).toEqual([
      ...RESEARCH_PIPELINE_STAGES,
    ]);
  });

  it("R3: the definition carries one node and one step per stage", () => {
    const definition = buildResearchJobDefinition("run-6035b", {
      userLogin: "owner",
      trigger: "manual",
    }) as unknown as {
      root: { children?: Array<{ kind?: string; steps?: unknown[]; children?: unknown[] }> };
    };
    const children = definition.root.children ?? [];
    expect(children.map((child) => child.kind)).toEqual([...RESEARCH_PIPELINE_STAGES]);
    for (const child of children) {
      // One step per stage node: the workflow's node loop is the durable
      // boundary, so a restart resumes at the last completed stage.
      expect(child.steps).toHaveLength(1);
      expect(child.children).toBeUndefined();
    }
  });
});

describe("#6466 — the dispatch stamps the workflow instance id", () => {
  it("R4: a fresh stamp records the instance id, the start time, and state idle", async () => {
    const { stores, control } = memControl();
    const jobId = "research:run-6466";
    const definition = buildResearchJobDefinition("run-6466", {
      userLogin: "owner",
      trigger: "manual",
    });
    await control.defineJob(definition as never);
    const stamped = await control.stampWorkflowDispatch(jobId, {
      workflowInstanceId: "wf-6466",
      startedAt: "2026-11-24T12:24:00.000Z",
    });
    expect(stamped.runWorkflowInstanceId).toBe("wf-6466");
    expect(stamped.runStartedAt).toBe("2026-11-24T12:24:00.000Z");
    expect(stamped.state).toBe("idle");
    const view = await control.getJob(jobId);
    expect(view.instance?.runWorkflowInstanceId).toBe("wf-6466");
    expect(view.instance?.runStartedAt).toBe("2026-11-24T12:24:00.000Z");
    expect(view.instance?.state).toBe("idle");
    expect(stores).toBeDefined();
  });

  it("R5: the stamp refuses on a live instance instead of weakening the run guard", async () => {
    const { stores, control } = memControl();
    const jobId = "research:run-6466-live";
    const definition = buildResearchJobDefinition("run-6466-live", {
      userLogin: "owner",
      trigger: "manual",
    });
    await control.defineJob(definition as never);
    const before = await control.getJob(jobId);
    await stores.instances.saveInstance({
      ...before.instance!,
      state: "running",
      currentRunId: "run-live",
    });
    // The refusal is coded `job_already_running` — the same guard
    // `dispatchResolved` enforces. (The message alone does not carry the
    // code; the pin asserts the code property.)
    let code = "";
    try {
      await control.stampWorkflowDispatch(jobId, { workflowInstanceId: "wf-other" });
      expect.unreachable("the stamp should have refused a live instance");
    } catch (err) {
      code = (err as { code?: unknown }).code as string;
    }
    expect(code).toBe("job_already_running");
    const after = await control.getJob(jobId);
    expect(after.instance?.runWorkflowInstanceId).toBeNull();
  });

  it("R6: a fresh start stamps the row and logs the dispatch event", async () => {
    const residency = memResidency();
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const definition = buildResearchJobDefinition("run-6466", {
      userLogin: "owner",
      trigger: "manual",
    });
    const started = await startResearchJobWorkflow({
      env: {} as Env,
      residency,
      definition: definition as unknown as Record<string, unknown>,
      engineJobId: "research:run-6466",
      runId: "run-6466",
      trigger: "manual",
      startWorkflow: async () => ({ instanceId: "wf-6466" }),
      dispatchLogger: {
        info: (type: string, fields: Record<string, unknown>) => void events.push({ type, fields }),
      },
    });
    expect(started.instanceId).toBe("wf-6466");
    expect(started.attached).toBe(false);
    const view = await createJobPipelineControl({
      stores: residency.stores,
      runRecorder: residency.runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    }).getJob("research:run-6466");
    expect(view.instance?.runWorkflowInstanceId).toBe("wf-6466");
    expect(view.instance?.state).toBe("idle");
    expect(view.instance?.runStartedAt).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("job.run.dispatched");
    expect(events[0].fields.jobId).toBe("research:run-6466");
    expect(events[0].fields.runId).toBe("run-6466");
    expect(events[0].fields.workflowInstanceId).toBe("wf-6466");
    expect(events[0].fields.trigger).toBe("manual");
  });

  it("R6b: an in-flight re-dispatch attaches instead of restamping", async () => {
    const residency = memResidency();
    const control = createJobPipelineControl({
      stores: residency.stores,
      runRecorder: residency.runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const definition = buildResearchJobDefinition("run-6466-att", {
      userLogin: "owner",
      trigger: "manual",
    });
    await control.defineJob(definition as never);
    const before = await control.getJob("research:run-6466-att");
    await residency.stores.instances.saveInstance({
      ...before.instance!,
      state: "running",
      currentRunId: "run-att",
      runWorkflowInstanceId: "wf-original",
    });
    let startCalled = 0;
    const started = await startResearchJobWorkflow({
      env: {} as Env,
      residency,
      definition: definition as unknown as Record<string, unknown>,
      engineJobId: "research:run-6466-att",
      runId: "run-6466-att",
      trigger: "manual",
      startWorkflow: async () => {
        startCalled += 1;
        return { instanceId: "wf-new" };
      },
    });
    expect(started.attached).toBe(true);
    expect(started.instanceId).toBe("wf-original");
    expect(startCalled).toBe(0);
    const after = await control.getJob("research:run-6466-att");
    expect(after.instance?.runWorkflowInstanceId).toBe("wf-original");
  });

  it("R7: the settlement timeout error names the stamped instance and its start time", async () => {
    let t = 0;
    let message = "";
    try {
      await awaitResearchJobSettlement({
        env: {
          JOB_PIPELINE_WORKFLOW: { create: () => Promise.resolve({ id: "x" }) },
          AGENT_DB: {},
        } as unknown as Env,
        engineJobId: "research:run-6466",
        timeoutMs: 1000,
        intervalMs: 100,
        now: () => (t += 1500),
        sleep: async () => {},
        readJob: async () => ({
          instance: {
            state: "idle",
            runWorkflowInstanceId: "wf-6466",
            runStartedAt: "2026-11-24T12:24:00.000Z",
          },
        }),
      });
      expect.unreachable("the settlement should have timed out");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(
      /research_workflow_run_timeout: run research:run-6466 did not reach a terminal state within 1000ms \(last state: idle\)/,
    );
    // The message also carries the stamped instance and its start time, so
    // the page can show which engine run the wait gave up on.
    expect(message).toContain("wf-6466");
    expect(message).toContain("2026-11-24T12:24:00.000Z");
  });
});
