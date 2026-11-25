// @vitest-environment node
/**
 * Issue #6552 — rewind a LIVE run to a stage's first step through the
 * platform's own restart. Issue #6560 — including sharded and per-item
 * stages, whose target is derived from the same plan the executor compiles.
 *
 * The engine's `rerunStage` is not this op and must not become it: it refuses
 * while a run is live and re-executes a stage from the engine's artifacts,
 * while the platform restart rewinds a live instance.
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
async function seedRunning(h: Harness, jobId: string): Promise<void> {
  await h.control.defineJob({
    jobId: "seed",
    root: {
      kind: "dummy",
      steps: [{ step: "noop" }],
      executionMode: { delivery: "sync" },
    },
  });
  await h.control.runJob("seed");
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
}

type Call = { jobId: string; runId: string; workflowInstanceId: string; fromStep: string };

describe("restart from a stage through the platform (#6552 / #6560)", () => {
  it("rewinds an unsharded batch stage to step 0 of the stage", async () => {
    const calls: Call[] = [];
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

    expect((await h.control.restartFromStage("flow", "")).state).toBe("running");
    expect(calls).toEqual([
      {
        jobId: "flow",
        runId: "run-1",
        workflowInstanceId: "wf-1",
        fromStep: stepExecutionId("run-1", "", 0, null, null),
      },
    ]);
  });

  it("derives a sharded stage's target from the plan's first unit", async () => {
    const calls: Call[] = [];
    const h = makeHarness(async (request) => {
      calls.push(request);
    });
    await h.control.defineJob({
      jobId: "flow",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        processing: { shards: ["alpha", "beta"] },
        executionMode: { delivery: "sync", shape: "sharded" },
      },
    });
    await seedRunning(h, "flow");

    await h.control.restartFromStage("flow", "");
    // Rewinding to the first unit's step discards every later step, so the
    // whole stage re-runs — the same rule the executor's plan follows.
    expect(calls[0].fromStep).toBe(stepExecutionId("run-1", "", 0, "alpha", null));
  });

  it("derives a per-item stage's target as item 0", async () => {
    const calls: Call[] = [];
    const h = makeHarness(async (request) => {
      calls.push(request);
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

    await h.control.restartFromStage("flow", "");
    expect(calls[0].fromStep).toBe(stepExecutionId("run-1", "", 0, null, 0));
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
