// @vitest-environment node
/**
 * Issue #5278 — resume and replay pin the definition version the run
 * started under.
 *
 * #5887 recorded the version a run executed and #4467's replayRun
 * resolved it; the *execution* half was still open: `resumeJob` and
 * the running-instance `replayJob` both re-read TODAY's definition, so
 * a reconfigure mid-flight silently changed the semantics of the run
 * that was already half-executed.
 *
 * Pins:
 *  - 5278-P01 a resume executes the run's own definition version after
 *    the job moves to a newer one (same tree shape, different step
 *    params — the surviving step sees the version the run started on);
 *  - 5278-P02 a stamped version that is no longer resolvable refuses by
 *    name (`resume_definition_version_unresolved`);
 *  - 5278-P03 an unpinned (pre-#5887) run refuses by name
 *    (`resume_pre_retention_run`) and names the recovery (a retry);
 *  - 5278-P04 the running-instance replay pins the version too;
 *  - 5278-P05 a new dispatch after the reconfigure still uses the new
 *    version — definition changes apply to new runs only.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobInstanceRecord } from "../src/data/jobPipelinePorts";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";

const JOB_ID = "resume-pin";

interface Harness {
  control: JobPipelineControl;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  runStore: InMemoryJobRunRecordStore;
  /** Every stepB invocation's `params.tag`, in order. */
  tags: string[];
  pause(): Promise<void>;
  release(): void;
}

function makeHarness(): Harness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const tags: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const steps = createBuiltinStepRegistry();
  steps.register("block", async () => {
    entered();
    await blocked;
    return { output: { blocked: true } };
  });
  steps.register("stepB", async (ctx: JobStepContext) => {
    tags.push(String(ctx.params.tag ?? ""));
    return { output: { tag: ctx.params.tag ?? null } };
  });
  let runCounter = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
  });
  return {
    control,
    stores,
    runStore,
    tags,
    pause: async () => {
      await enteredPromise;
      await control.pauseJob(JOB_ID);
      release();
    },
    release: () => release(),
  };
}

/** The v1 job: one blocking step, then the observable step with tag v1. */
function job(tag: string) {
  return {
    jobId: JOB_ID,
    name: "Resume pin job",
    root: {
      kind: "dummy",
      steps: [{ step: "block" }, { step: "stepB", params: { tag } }],
      executionMode: { delivery: "async" as const },
    },
  };
}

/** Start v1, run until the block, pause, and let the run settle paused. */
async function pausedOnV1(h: Harness): Promise<JobInstanceRecord> {
  await h.control.defineJob(job("v1"));
  const dispatch = await h.control.runJob(JOB_ID);
  await h.pause();
  const outcome = await dispatch.completion!;
  expect(outcome.state).toBe("paused");
  const instance = await h.stores.instances.getInstance(JOB_ID);
  expect(instance?.runDefinitionVersion).toBe(1);
  return instance!;
}

describe("5278-P01 a resume executes the version the run started under", () => {
  it("keeps the run on v1 after the job moves to v2", async () => {
    const h = makeHarness();
    await pausedOnV1(h);

    // The reconfigure the operator makes while the run is paused.
    const v2 = await h.control.configureJob(JOB_ID, { root: job("v2").root });
    expect(v2.version).toBe(2);

    const resumed = await h.control.resumeJob(JOB_ID);
    expect((await resumed.completion!)?.state).toBe("completed");

    // The surviving step saw v1's params: the run finished on the
    // semantics it started with, not on the reconfigure's.
    expect(h.tags).toEqual(["v1"]);
    const record = h.runStore.listByJob(JOB_ID, 1)[0];
    expect(record.definitionVersion).toBe(1);
  });
});

describe("5278-P02 an unresolvable pinned version refuses by name", () => {
  it("refuses rather than resuming under today's configuration", async () => {
    const h = makeHarness();
    const instance = await pausedOnV1(h);
    await h.control.configureJob(JOB_ID, { root: job("v2").root });
    // Simulate a version whose history row no longer exists.
    await h.stores.instances.saveInstance({
      ...instance,
      state: "paused",
      runDefinitionVersion: 99,
    });

    const failure = await h.control.resumeJob(JOB_ID).catch((error) => error);
    expect(failure).toBeInstanceOf(JobPipelineError);
    expect((failure as JobPipelineError).code).toBe(
      "resume_definition_version_unresolved",
    );
    expect((failure as Error).message).toContain("99");
    expect(h.tags).toEqual([]);
  });
});

describe("5278-P03 an unpinned (pre-retention) run refuses by name", () => {
  it("refuses and names the retry as the recovery", async () => {
    const h = makeHarness();
    const instance = await pausedOnV1(h);
    await h.stores.instances.saveInstance({
      ...instance,
      state: "paused",
      runDefinitionVersion: null,
    });

    const failure = await h.control.resumeJob(JOB_ID).catch((error) => error);
    expect(failure).toBeInstanceOf(JobPipelineError);
    expect((failure as JobPipelineError).code).toBe("resume_pre_retention_run");
    expect((failure as Error).message).toMatch(/retry/i);
    expect(h.tags).toEqual([]);
  });
});

describe("5278-P04 the running-instance replay pins the version too", () => {
  it("re-enters the run on its own version after a reconfigure", async () => {
    const h = makeHarness();
    const instance = await pausedOnV1(h);
    await h.control.configureJob(JOB_ID, { root: job("v2").root });
    // A still-running instance under the workflow executor that
    // dispatched it (the #4454 replay precondition), stamped v1.
    await h.stores.instances.saveInstance({
      ...instance,
      state: "running",
      checkpoint: null,
      runWorkflowInstanceId: "wf-1",
      runDefinitionVersion: 1,
    });

    const replayed = await h.control.replayJob(JOB_ID, { workflowInstanceId: "wf-1" });
    expect((await replayed.completion!)?.state).toBe("completed");
    expect(h.tags).toEqual(["v1"]);
  });
});

describe("5278-P05 a new dispatch uses the new version", () => {
  it("applies the reconfigure to runs that start after it", async () => {
    const h = makeHarness();
    await pausedOnV1(h);
    await h.control.cancelJob(JOB_ID);
    await h.control.configureJob(JOB_ID, { root: job("v2").root });

    const fresh = await h.control.runJob(JOB_ID);
    expect((await fresh.completion!)?.state).toBe("completed");
    expect(h.tags).toEqual(["v2"]);
    expect(h.runStore.listByJob(JOB_ID, 1)[0].definitionVersion).toBe(2);
  });
});
