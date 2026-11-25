// @vitest-environment node
/**
 * Issue #6552 — rewind a LIVE run to a stage's first step through the
 * platform's own restart.
 *
 * The engine's `rerunStage` is not this op and must not become it: it refuses
 * while a run is live and re-executes a stage from the engine's artifacts,
 * while the platform restart rewinds a live instance. This pins the new op's
 * whole contract — the step name it derives, and every refusal that keeps it
 * from rewinding the wrong thing.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineRestartRun,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { stepExecutionId } from "../src/services/executionTreeIds";

interface Harness {
  control: ReturnType<typeof createJobPipelineControl>;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
}

function makeHarness(restart?: JobPipelineRestartRun): Harness {
  const stores = createInMemoryJobPipelineStores();
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
    ...(restart ? { restartRun: restart } : {}),
  });
  return { control, stores };
}

/** A real instance record, rewound to the shape a live dispatched run has. */
async function seedRunning(h: Harness, jobId: string): Promise<string> {
  await h.control.defineJob({
    jobId: "seed",
    root: {
      kind: "dummy",
      steps: [{ step: "noop" }],
      executionMode: { delivery: "sync" },
    },
  });
  const dispatch = await h.control.runJob("seed");
  const template = (await h.control.getJob("seed")).instance;
  if (!template) throw new Error("instance missing");
  await h.stores.instances.saveInstance({
    ...template,
    jobId,
    state: "running",
    desiredState: "none",
    currentRunId: "run-1",
    runWorkflowInstanceId: "wf-1",
  });
  return dispatch.runId;
}

describe("restart from a stage through the platform (#6552)", () => {
  it("rewinds to the stage's first step, using the engine's own step name", async () => {
    const calls: { jobId: string; runId: string; workflowInstanceId: string; fromStep: string }[] =
      [];
    const h = makeHarness(async (request) => {
      calls.push(request);
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "sync" },
      },
    });
    await seedRunning(h, "flow");

    const dispatch = await h.control.restartFromStage("flow", "");
    expect(dispatch.state).toBe("running");
    // The exact name the engine gave step 0 of this stage in this run.
    expect(calls).toEqual([
      {
        jobId: "flow",
        runId: "run-1",
        workflowInstanceId: "wf-1",
        fromStep: stepExecutionId("run-1", "", 0, null, null),
      },
    ]);
  });

  it("refuses a sharded stage by name instead of rewinding one shard's step", async () => {
    let called = 0;
    const h = makeHarness(async () => {
      called += 1;
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        processing: { shards: ["a", "b"] },
        executionMode: { delivery: "sync" },
      },
    });
    await seedRunning(h, "flow");

    await expect(h.control.restartFromStage("flow", "")).rejects.toMatchObject({
      code: "stage_restart_unaddressable",
    });
    expect(called).toBe(0);
  });

  it("refuses per-item pacing the same way", async () => {
    let called = 0;
    const h = makeHarness(async () => {
      called += 1;
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "async", pacing: "online" },
      },
    });
    await seedRunning(h, "flow");

    await expect(h.control.restartFromStage("flow", "")).rejects.toMatchObject({
      code: "stage_restart_unaddressable",
    });
    expect(called).toBe(0);
  });

  it("refuses a run that is not live", async () => {
    let called = 0;
    const h = makeHarness(async () => {
      called += 1;
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "sync" },
      },
    });
    await h.control.runJob("flow");

    await expect(h.control.restartFromStage("flow", "")).rejects.toMatchObject({
      code: "job_not_running",
    });
    expect(called).toBe(0);
  });

  it("refuses by name when the host exposes no restart channel", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "sync" },
      },
    });
    await seedRunning(h, "flow");

    await expect(h.control.restartFromStage("flow", "")).rejects.toMatchObject({
      code: "stage_port_unavailable",
    });
  });

  it("surfaces a platform rejection as its own code", async () => {
    const h = makeHarness(async () => {
      throw new Error("no step matching from");
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "sync" },
      },
    });
    await seedRunning(h, "flow");

    await expect(h.control.restartFromStage("flow", "")).rejects.toMatchObject({
      code: "stage_restart_rejected",
    });
  });
});
