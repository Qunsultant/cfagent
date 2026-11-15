// @vitest-environment node
/**
 * Issue #4454 — the generic-flow replay gap: a workflow evicted
 * mid-run replays through runJobPipelineWorkflowFlow into the
 * `job_already_running` refusal, because the persisted instance
 * is still `running` and runJob refuses a new dispatch. The fix:
 * the flow stamps the dispatching workflow instance id on the
 * instance record, and a replayed flow resumes the still-running
 * instance when — and only when — the recorded id matches the
 * replaying workflow instance's own id (the replay proof). A
 * second workflow instance, an unstamped run, or a missing id
 * still meets the refusal, exactly as today.
 *
 * Eviction simulation, stated honestly: a single process cannot
 * die mid-run, so the eviction store-state is built from REAL
 * engine writes — a first flow execution pauses at a step
 * boundary (the #4289 idiom), persisting the checkpoint, the
 * stage ledger, the step artifacts, and the journal entries —
 * and the test then flips ONLY the persisted instance state
 * from `paused` back to `running`, which is exactly what an
 * eviction preempts (the pause-settle's state write; an
 * eviction writes nothing). A second variant clears the
 * checkpoint too (evicted before the first boundary). The
 * replay then runs through the real flow with a fresh control
 * over the same stores and a journal pre-loaded with the first
 * execution's entries.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";

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

const JOB_ID = "replay-dummy";

/** Three counting steps: each handler invocation is one observable effect. */
function flowDeps(
  stores: JobPipelineStores,
  runStore: InMemoryJobRunRecordStore,
  executions: Array<{ stepIndex: number }>,
  newRunId: () => string,
): JobPipelineDeps {
  const steps = createBuiltinStepRegistry();
  steps.register("count", async (ctx: JobStepContext) => {
    executions.push({ stepIndex: ctx.stepIndex });
    return { output: { counted: ctx.stepIndex } };
  });
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    newRunId,
  };
}

const JOB = {
  jobId: JOB_ID,
  name: "Replay dummy",
  root: {
    kind: "dummy",
    steps: [{ step: "count" }, { step: "count" }, { step: "count" }],
    executionMode: { delivery: "sync" },
  },
};

/**
 * Drive a first flow execution to a real mid-run persisted
 * state, then rewrite ONLY the instance state to `running` —
 * the eviction rewrite. Returns the first outcome, the journal
 * entries, and the shared fixtures. `clearCheckpoint` covers
 * an eviction before the first boundary wrote a checkpoint.
 */
async function evictedState(options: {
  workflowInstanceId?: string;
  clearCheckpoint?: boolean;
}) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const executions: Array<{ stepIndex: number }> = [];
  let runCounter = 0;
  const newRunId = () => `run-${++runCounter}`;
  const deps = flowDeps(stores, runStore, executions, newRunId);
  const control = createJobPipelineControl(deps);
  await control.defineJob(JOB);
  const firstJournal = recordingJournal();
  const pausingStep = {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const result = await firstJournal.step.do(name, fn);
      if (firstJournal.names.length === 2) {
        await control.pauseJob(JOB_ID);
      }
      return result;
    },
  };
  const first = await runJobPipelineWorkflowFlow(deps, pausingStep, {
    jobId: JOB_ID,
    trigger: "manual",
  }, options.workflowInstanceId ? { workflowInstanceId: options.workflowInstanceId } : undefined);
  expect(first.state).toBe("paused");
  const paused = await stores.instances.getInstance(JOB_ID);
  expect(paused?.state).toBe("paused");
  expect(paused?.checkpoint).not.toBeNull();
  // The eviction rewrite: the persisted state an eviction
  // leaves is the last engine write with the run still
  // `running` — the pause-settle's state write is the one
  // write an eviction preempts.
  await stores.instances.saveInstance({
    ...paused!,
    state: "running",
    ...(options.clearCheckpoint ? { checkpoint: null } : {}),
  });
  return { stores, runStore, executions, newRunId, first, firstJournal };
}

describe("generic-flow eviction replay (#4454)", () => {
  it("a replayed flow resumes the same engine run id without re-executing journaled steps", async () => {
    const workflowInstanceId = "workflow-instance-1";
    const { stores, runStore, executions, newRunId, first, firstJournal } =
      await evictedState({ workflowInstanceId });
    expect(first.runId).toBe("run-1");
    // Two steps executed before the pause; the third never ran.
    expect(executions.map((e) => e.stepIndex)).toEqual([0, 1]);

    const replay = replayingJournal(firstJournal.entries);
    const resumed = await runJobPipelineWorkflowFlow(
      flowDeps(stores, runStore, executions, newRunId),
      replay.step,
      { jobId: JOB_ID, trigger: "manual" },
      { workflowInstanceId },
    );
    expect(resumed.state).toBe("completed");
    // The SAME engine run id: a fresh dispatch would have minted run-2.
    expect(resumed.runId).toBe("run-1");
    // Each step's handler ran exactly once across both executions.
    expect(executions.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
    // The engine never re-invoked a journaled step: the only
    // journal execution on replay is the pending step's.
    expect(replay.executed).toHaveLength(1);
    expect(firstJournal.names).not.toContain(replay.executed[0]);
    // Every step artifact persisted exactly once.
    const keys = await stores.artifacts.listArtifactKeys("run-1");
    expect(keys).toContain("root/step-0");
    expect(keys).toContain("root/step-1");
    expect(keys).toContain("root/step-2");
    const view = await createJobPipelineControl(
      flowDeps(stores, runStore, executions, newRunId),
    ).getJob(JOB_ID);
    expect(view.instance?.state).toBe("completed");
  });

  it("replays with no checkpoint (evicted before the first boundary)", async () => {
    const workflowInstanceId = "workflow-instance-1";
    const { stores, runStore, executions, newRunId, first } = await evictedState({
      workflowInstanceId,
      clearCheckpoint: true,
    });
    const replay = replayingJournal(new Map());
    const resumed = await runJobPipelineWorkflowFlow(
      flowDeps(stores, runStore, executions, newRunId),
      replay.step,
      { jobId: JOB_ID, trigger: "manual" },
      { workflowInstanceId },
    );
    expect(resumed.state).toBe("completed");
    expect(resumed.runId).toBe(first.runId);
  });

  it("a second workflow instance still meets the refusal", async () => {
    const { stores, runStore, executions, newRunId, firstJournal } =
      await evictedState({ workflowInstanceId: "workflow-instance-1" });
    const replay = replayingJournal(firstJournal.entries);
    await expect(
      runJobPipelineWorkflowFlow(
        flowDeps(stores, runStore, executions, newRunId),
        replay.step,
        { jobId: JOB_ID, trigger: "manual" },
        { workflowInstanceId: "workflow-instance-2" },
      ),
    ).rejects.toMatchObject({ code: "job_already_running" });
    // The run is untouched by the refused replay.
    const instance = await stores.instances.getInstance(JOB_ID);
    expect(instance?.state).toBe("running");
    expect(instance?.currentRunId).toBe("run-1");
    expect(executions.map((e) => e.stepIndex)).toEqual([0, 1]);
  });

  it("a flow without a workflow instance id still meets the refusal", async () => {
    const { stores, runStore, executions, newRunId, firstJournal } =
      await evictedState({ workflowInstanceId: "workflow-instance-1" });
    const replay = replayingJournal(firstJournal.entries);
    await expect(
      runJobPipelineWorkflowFlow(
        flowDeps(stores, runStore, executions, newRunId),
        replay.step,
        { jobId: JOB_ID, trigger: "manual" },
      ),
    ).rejects.toMatchObject({ code: "job_already_running" });
  });

  it("an unstamped run still meets the refusal", async () => {
    // No workflow instance id on the first dispatch: the run
    // carries no stamp, so no replay can prove itself.
    const { stores, runStore, executions, newRunId, firstJournal } =
      await evictedState({});
    const replay = replayingJournal(firstJournal.entries);
    await expect(
      runJobPipelineWorkflowFlow(
        flowDeps(stores, runStore, executions, newRunId),
        replay.step,
        { jobId: JOB_ID, trigger: "manual" },
        { workflowInstanceId: "workflow-instance-1" },
      ),
    ).rejects.toMatchObject({ code: "job_already_running" });
  });

  it("a paused instance is not replayed by the flow (resume owns that)", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    let runCounter = 0;
    const deps = flowDeps(stores, runStore, executions, () => `run-${++runCounter}`);
    const control = createJobPipelineControl(deps);
    await control.defineJob(JOB);
    const journal = recordingJournal();
    const pausingStep = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const result = await journal.step.do(name, fn);
        if (journal.names.length === 2) await control.pauseJob(JOB_ID);
        return result;
      },
    };
    const first = await runJobPipelineWorkflowFlow(deps, pausingStep, {
      jobId: JOB_ID,
      trigger: "manual",
    }, { workflowInstanceId: "workflow-instance-1" });
    expect(first.state).toBe("paused");
    await expect(
      runJobPipelineWorkflowFlow(
        flowDeps(stores, runStore, executions, () => `run-${++runCounter}`),
        replayingJournal(journal.entries).step,
        { jobId: JOB_ID, trigger: "manual" },
        { workflowInstanceId: "workflow-instance-1" },
      ),
    ).rejects.toMatchObject({ code: "job_already_running" });
  });
});

describe("replayJob — the engine's replay-resume path (#4454)", () => {
  it("stamps the dispatching workflow instance id on the run", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => "run-1"),
    );
    await control.defineJob(JOB);
    await control.runJob(JOB_ID, { workflowInstanceId: "workflow-instance-1" });
    const instance = await stores.instances.getInstance(JOB_ID);
    expect(instance?.runWorkflowInstanceId).toBe("workflow-instance-1");
  });

  it("leaves the stamp null for a dispatch without a workflow instance id", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => "run-1"),
    );
    await control.defineJob(JOB);
    await control.runJob(JOB_ID);
    const instance = await stores.instances.getInstance(JOB_ID);
    expect(instance?.runWorkflowInstanceId).toBeNull();
  });

  it("resumes a proven replay directly, and refuses an unproven one by name", async () => {
    const { stores, runStore, executions, newRunId } = await evictedState({
      workflowInstanceId: "workflow-instance-1",
    });
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, newRunId),
    );
    await expect(
      control.replayJob(JOB_ID, { workflowInstanceId: "workflow-instance-2" }),
    ).rejects.toMatchObject({ code: "job_already_running" });
    const resumed = await control.replayJob(JOB_ID, {
      workflowInstanceId: "workflow-instance-1",
    });
    expect(resumed.state).toBe("completed");
    expect(resumed.runId).toBe("run-1");
    expect(executions.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
  });

  it("refuses a non-running instance by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => "run-1"),
    );
    await control.defineJob(JOB);
    await expect(
      control.replayJob(JOB_ID, { workflowInstanceId: "workflow-instance-1" }),
    ).rejects.toMatchObject({ code: "job_not_resumable" });
  });

  it("refuses a running instance with no run id by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => "run-1"),
    );
    await control.defineJob(JOB);
    const fresh = await stores.instances.getInstance(JOB_ID);
    await stores.instances.saveInstance({ ...fresh!, state: "running" });
    await expect(
      control.replayJob(JOB_ID, { workflowInstanceId: "workflow-instance-1" }),
    ).rejects.toMatchObject({ code: "job_no_checkpoint" });
  });

  it("a retry clears the stamp", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    let runCounter = 0;
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => `run-${++runCounter}`),
    );
    await control.defineJob(JOB);
    await control.runJob(JOB_ID, { workflowInstanceId: "workflow-instance-1" });
    await control.retryJob(JOB_ID);
    const instance = await stores.instances.getInstance(JOB_ID);
    expect(instance?.runWorkflowInstanceId).toBeNull();
  });

  it("a resume through resumeJob clears the stamp (a new executor)", async () => {
    const { stores, runStore, executions, newRunId } = await evictedState({
      workflowInstanceId: "workflow-instance-1",
    });
    // Back to paused: resumeJob owns the paused state.
    const instance = await stores.instances.getInstance(JOB_ID);
    await stores.instances.saveInstance({ ...instance!, state: "paused" });
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, newRunId),
    );
    const resumed = await control.resumeJob(JOB_ID);
    expect(resumed.state).toBe("completed");
    const after = await stores.instances.getInstance(JOB_ID);
    expect(after?.runWorkflowInstanceId).toBeNull();
  });

  it("replayJob is a JobPipelineError refusal, never an untyped throw", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const executions: Array<{ stepIndex: number }> = [];
    const control = createJobPipelineControl(
      flowDeps(stores, runStore, executions, () => "run-1"),
    );
    await control.defineJob(JOB);
    const failure = await control
      .replayJob(JOB_ID, { workflowInstanceId: "workflow-instance-1" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(JobPipelineError);
  });
});
