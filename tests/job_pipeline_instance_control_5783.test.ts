// @vitest-environment node
/**
 * Issue #5783 — instance control through the one seam.
 *
 * The engine's control ops lived entirely on run records: pausing paused
 * a record, cancelling set a flag, and the platform instance kept its own
 * state. This pins the slice's actual decisions:
 *
 * - the seam exposes pause / resume / terminate / restart beside the start
 *   path, and each refuses by name when the provider shape lacks it;
 * - `terminate` states its rollback choice at the call site (never a silent
 *   default), because a rollback runs handlers and currently none exist;
 * - engine cancel stops the durable host when one is stamped, and then
 *   settles the record itself — a run parked in a durable wait never reaches
 *   a step boundary, so nothing else could settle it;
 * - engine pause stays a record-only hold on purpose: the platform's pause
 *   freezes the flow body before the engine's boundary check, and the engine
 *   resumes by starting a NEW executor, so a platform-held instance would
 *   have no resumer. Pinned here so a later change is deliberate.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineTerminateRun,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  pauseManagedWorkflowInstance,
  restartManagedWorkflowInstance,
  resumeManagedWorkflowInstance,
  terminateManagedWorkflowInstance,
  type ManagedWorkflowBinding,
  type ManagedWorkflowBindingInstance,
} from "../src/workflows/workflowInstanceSeam";

function fakeBinding(instance: ManagedWorkflowBindingInstance) {
  const binding: ManagedWorkflowBinding = {
    create: async () => ({ id: "ignored" }),
    get: async () => instance,
  };
  return binding;
}

describe("instance control through the seam (#5783)", () => {
  it("pauses, resumes and restarts the addressed instance", async () => {
    const calls: string[] = [];
    const binding = fakeBinding({
      pause: async () => {
        calls.push("pause");
      },
      resume: async () => {
        calls.push("resume");
      },
      restart: async (options) => {
        calls.push(`restart:${JSON.stringify(options ?? {})}`);
      },
    });
    await pauseManagedWorkflowInstance(binding, "wf-1");
    await resumeManagedWorkflowInstance(binding, "wf-1");
    await restartManagedWorkflowInstance(binding, "wf-1", {
      from: { name: "wait:root", count: 2 },
    });
    expect(calls).toEqual([
      "pause",
      "resume",
      'restart:{"from":{"name":"wait:root","count":2}}',
    ]);
  });

  it("states the rollback choice instead of inheriting a default", async () => {
    const seen: { rollback?: boolean }[] = [];
    const binding = fakeBinding({
      terminate: async (options) => {
        seen.push(options ?? {});
      },
    });
    await terminateManagedWorkflowInstance(binding, "wf-1", { rollback: false });
    await terminateManagedWorkflowInstance(binding, "wf-1", { rollback: true });
    expect(seen).toEqual([{ rollback: false }, { rollback: true }]);
  });

  it("refuses by name when the instance shape cannot apply the control", async () => {
    const binding = fakeBinding({});
    await expect(pauseManagedWorkflowInstance(binding, "wf-1")).rejects.toMatchObject({
      code: "instance_control_unsupported",
    });
    await expect(
      terminateManagedWorkflowInstance(binding, "wf-1", { rollback: false }),
    ).rejects.toMatchObject({ code: "instance_control_unsupported" });
    await expect(restartManagedWorkflowInstance(binding, "wf-1")).rejects.toMatchObject({
      code: "instance_control_unsupported",
    });
  });
});

describe("engine cancel stops the durable host (#5783)", () => {
  interface Harness {
    control: ReturnType<typeof createJobPipelineControl>;
    stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  }

  function makeHarness(terminate?: JobPipelineTerminateRun): Harness {
    const stores = createInMemoryJobPipelineStores();
    let runs = 0;
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      now: () => new Date("2026-11-25T12:00:00.000Z"),
      newRunId: () => `run-${++runs}`,
      ...(terminate ? { terminateRun: terminate } : {}),
    });
    return { control, stores };
  }

  /** A record that looks like a live run dispatched by a workflow instance. */
  async function seedRunningJob(h: Harness): Promise<string> {
    await h.control.defineJob({
      jobId: "job",
      root: {
        kind: "dummy",
        steps: [{ step: "noop" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("job");
    const instance = (await h.control.getJob("job")).instance;
    if (!instance) throw new Error("instance missing");
    // Rewind to the shape a wedged run has: running, stamped to its host.
    await h.stores.instances.saveInstance({
      ...instance,
      state: "running",
      desiredState: "none",
      currentRunId: dispatch.runId,
      runWorkflowInstanceId: "wf-1",
    });
    return dispatch.runId;
  }

  it("terminates the stamped instance and settles the run cancelled", async () => {
    const calls: { jobId: string; runId: string; workflowInstanceId: string }[] = [];
    const h = makeHarness(async (request) => {
      calls.push(request);
    });
    const runId = await seedRunningJob(h);
    const cancelled = await h.control.cancelJob("job");
    // The platform stop fired, addressed by the run's own instance id.
    expect(calls).toEqual([{ jobId: "job", runId, workflowInstanceId: "wf-1" }]);
    // No executor remains, so the record is settled here, not by a boundary.
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.desiredState).toBe("none");
    expect((await h.control.getJob("job")).instance?.state).toBe("cancelled");
  });

  it("stays cooperative when the host has no stop channel", async () => {
    const h = makeHarness();
    await seedRunningJob(h);
    const updated = await h.control.cancelJob("job");
    expect(updated.state).toBe("running");
    expect(updated.desiredState).toBe("cancel");
  });

  it("surfaces a failed platform stop while leaving the cooperative cancel in place", async () => {
    const h = makeHarness(async () => {
      throw new Error("platform unavailable");
    });
    await seedRunningJob(h);
    await expect(h.control.cancelJob("job")).rejects.toThrow("platform unavailable");
    const after = (await h.control.getJob("job")).instance;
    expect(after?.desiredState).toBe("cancel");
    expect(after?.state).toBe("running");
  });

  it("still settles a paused run cancelled without touching any platform", async () => {
    let called = 0;
    const h = makeHarness(async () => {
      called += 1;
    });
    await seedRunningJob(h);
    const instance = (await h.control.getJob("job")).instance;
    if (!instance) throw new Error("instance missing");
    await h.stores.instances.saveInstance({ ...instance, state: "paused" });
    const cancelled = await h.control.cancelJob("job");
    expect(cancelled.state).toBe("cancelled");
    expect(called).toBe(0);
  });

  it("keeps pause a record-only hold, deliberately", async () => {
    let called = 0;
    const h = makeHarness(async () => {
      called += 1;
    });
    await seedRunningJob(h);
    const paused = await h.control.pauseJob("job");
    expect(paused.desiredState).toBe("pause");
    // The platform pause is NOT used: it would freeze the flow body before
    // the engine's boundary check, leaving a run no resumer could reach.
    expect(called).toBe(0);
  });
});
