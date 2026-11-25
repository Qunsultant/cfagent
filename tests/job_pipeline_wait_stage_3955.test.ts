// @vitest-environment node
/**
 * Issue #3955 — the durable event-wait / approval-wait stage.
 *
 * The engine had no wait primitive at all: a job could only finish
 * its steps and settle. Every approval in the repo lived in a bespoke
 * workflow outside the engine, and the "wait" shape inside the engine
 * was a poll loop. This pins the new stage:
 *
 * - a `wait.event` step waits for ONE named event and continues on it,
 *   handing the event payload to the next step as its input;
 * - a timeout is a DECLARED OUTCOME (`{outcome: "timeout"}`), never a
 *   failed run — the platform throws on timeout, so the flow host
 *   classifies that throw instead of letting it fail the instance;
 * - the wait is never wrapped in the step journal: Rules of Workflows
 *   forbid `waitForEvent` inside `step.do`, and a journaled wait would
 *   replay as a completed step instead of re-arming;
 * - `sendEvent` is the delivery half, addressed to the run's durable
 *   host through the same seam that starts instances;
 * - a host with no channel refuses BY NAME (`stage_port_unavailable`),
 *   never silently pretending the wait happened.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  WAIT_EVENT_STEP,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobEventSendRequest,
  type JobEventWaitOutcome,
  type JobEventWaitRequest,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { waitChannelFromStep } from "../src/workflows/workflowEventWait";

interface Harness {
  control: ReturnType<typeof createJobPipelineControl>;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
}

function makeHarness(opts: {
  wait?: (request: JobEventWaitRequest) => Promise<JobEventWaitOutcome>;
  send?: (request: JobEventSendRequest) => Promise<void>;
  journal?: { do: <T>(name: string, fn: () => Promise<T>) => Promise<T> };
} = {}): Harness {
  const stores = createInMemoryJobPipelineStores();
  let runCounter = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
    ...(opts.wait ? { waitForEvent: opts.wait } : {}),
    ...(opts.send ? { sendEvent: opts.send } : {}),
    ...(opts.journal ? { journal: opts.journal } : {}),
  });
  return { control, stores };
}

/** An approval job: wait for the decision, then record what arrived. */
async function defineApprovalJob(
  control: Harness["control"],
  params: Record<string, unknown> = { event: "approval.decided" },
): Promise<void> {
  await control.defineJob({
    jobId: "approval",
    root: {
      kind: "dummy",
      steps: [{ step: WAIT_EVENT_STEP, params }, { step: "record" }],
      executionMode: { delivery: "sync" },
    },
  });
}

describe("durable event-wait stage (#3955)", () => {
  it("resumes on the named event and hands the payload to the next step", async () => {
    const seen: JobEventWaitRequest[] = [];
    const h = makeHarness({
      wait: async (request) => {
        seen.push(request);
        return { outcome: "event", payload: { by: "venus", decision: "approve" } };
      },
    });
    await defineApprovalJob(h.control);
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("completed");
    // One wait, named by the job's own configuration, with no invented bound.
    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe("approval.decided");
    expect(seen[0].jobId).toBe("approval");
    expect(seen[0].timeoutMs).toBeNull();
    // The wait's outcome is the step's output, and the next step's input.
    const waited = await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0");
    expect(waited).toEqual({
      outcome: "event",
      event: "approval.decided",
      payload: { by: "venus", decision: "approve" },
    });
    const recorded = (await h.stores.artifacts.getArtifact(
      dispatch.runId,
      "root/step-1",
    )) as { input: unknown };
    expect(recorded.input).toEqual(waited);
  });

  it("carries the declared timeout to the host, unchanged", async () => {
    const seen: JobEventWaitRequest[] = [];
    const h = makeHarness({
      wait: async (request) => {
        seen.push(request);
        return { outcome: "timeout" };
      },
    });
    await defineApprovalJob(h.control, { event: "approval.decided", timeoutMs: 5_000 });
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("completed");
    expect(seen[0].timeoutMs).toBe(5_000);
  });

  it("resolves a timeout as a declared outcome, not a failure", async () => {
    const h = makeHarness({ wait: async () => ({ outcome: "timeout" }) });
    await defineApprovalJob(h.control);
    const dispatch = await h.control.runJob("approval");
    // The run continues and completes: a timeout is a branch the job
    // can act on, never a failed run.
    expect(dispatch.state).toBe("completed");
    expect(await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0")).toEqual({
      outcome: "timeout",
      event: "approval.decided",
    });
  });

  it("is not cut short by the stage deadline it was never declared under", async () => {
    // A 10ms stage deadline would kill a 60ms wait if the unit deadline
    // still applied. A durable wait is bounded by its own declaration, so
    // the deadline stops applying to the stage that contains it.
    const h = makeHarness({
      wait: () =>
        new Promise<JobEventWaitOutcome>((resolve) => {
          setTimeout(() => resolve({ outcome: "event", payload: { late: true } }), 60);
        }),
    });
    await h.control.defineJob({
      jobId: "approval",
      root: {
        kind: "dummy",
        timeoutMs: 10,
        steps: [{ step: WAIT_EVENT_STEP, params: { event: "approval.decided" } }, { step: "record" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("completed");
    expect(await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0")).toEqual({
      outcome: "event",
      event: "approval.decided",
      payload: { late: true },
    });
  });

  it("never wraps the wait in the step journal (Rules of Workflows)", async () => {
    const journaled: string[] = [];
    const h = makeHarness({
      wait: async () => ({ outcome: "event", payload: null }),
      journal: {
        do: async (name, fn) => {
          journaled.push(name);
          return fn();
        },
      },
    });
    await defineApprovalJob(h.control);
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("completed");
    // Two steps ran; exactly one is journaled — the ordinary one.
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).not.toContain(WAIT_EVENT_STEP);
  });

  it("refuses by name when the host provides no wait channel", async () => {
    const h = makeHarness();
    await defineApprovalJob(h.control);
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob("approval")).instance?.lastError ?? "";
    expect(failed).toContain("no event-wait channel");
    expect(failed).toContain("approval.decided");
  });

  it("refuses an empty event name instead of waiting on nothing", async () => {
    const h = makeHarness({ wait: async () => ({ outcome: "timeout" }) });
    await defineApprovalJob(h.control, { event: "   " });
    const dispatch = await h.control.runJob("approval");
    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob("approval")).instance?.lastError ?? "";
    expect(failed).toContain("non-empty");
  });

  it("delivers an event to the running instance through the host channel", async () => {
    let entered!: () => void;
    const waitEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (outcome: JobEventWaitOutcome) => void;
    const sent: JobEventSendRequest[] = [];
    const h = makeHarness({
      wait: () => {
        entered();
        return new Promise<JobEventWaitOutcome>((resolve) => {
          release = resolve;
        });
      },
      send: async (request) => {
        sent.push(request);
      },
    });
    await defineApprovalJob(h.control);
    const running = h.control.runJob("approval", { workflowInstanceId: "wf-1" });
    await waitEntered;
    const delivered = await h.control.sendEvent("approval", "approval.decided", {
      by: "venus",
    });
    expect(delivered.runId).toBe("run-1");
    expect(delivered.workflowInstanceId).toBe("wf-1");
    expect(sent).toEqual([
      {
        jobId: "approval",
        runId: "run-1",
        workflowInstanceId: "wf-1",
        event: "approval.decided",
        payload: { by: "venus" },
      },
    ]);
    release({ outcome: "event", payload: { by: "venus" } });
    expect((await running).state).toBe("completed");
  });

  it("refuses to send to a job that is not running", async () => {
    const h = makeHarness({
      wait: async () => ({ outcome: "event", payload: null }),
      send: async () => {},
    });
    await defineApprovalJob(h.control);
    await h.control.runJob("approval");
    await expect(
      h.control.sendEvent("approval", "approval.decided"),
    ).rejects.toMatchObject({ code: "job_not_running" });
  });

  it("refuses delivery by name when the host has no send channel", async () => {
    let entered!: () => void;
    const waitEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (outcome: JobEventWaitOutcome) => void;
    const h = makeHarness({
      wait: () => {
        entered();
        return new Promise<JobEventWaitOutcome>((resolve) => {
          release = resolve;
        });
      },
    });
    await defineApprovalJob(h.control);
    const running = h.control.runJob("approval", { workflowInstanceId: "wf-1" });
    await waitEntered;
    await expect(
      h.control.sendEvent("approval", "approval.decided"),
    ).rejects.toMatchObject({ code: "stage_port_unavailable" });
    release({ outcome: "timeout" });
    await running;
  });

  it("refuses an empty event name on the delivery side too", async () => {
    const h = makeHarness({ wait: async () => ({ outcome: "timeout" }) });
    await defineApprovalJob(h.control);
    await h.control.runJob("approval");
    await expect(h.control.sendEvent("approval", "  ")).rejects.toMatchObject({
      code: "job_config_invalid",
    });
  });
});


describe("workflow host wiring (#3955)", () => {
  const T0 = () => new Date("2026-11-25T12:00:00.000Z");

  function makeDeps() {
    const stores = createInMemoryJobPipelineStores();
    let counter = 0;
    const deps = {
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      now: T0,
      newRunId: () => `run-${++counter}`,
    };
    return { stores, deps };
  }

  async function defineJob(deps: ReturnType<typeof makeDeps>["deps"]) {
    await createJobPipelineControl(deps).defineJob({
      jobId: "approval",
      root: {
        kind: "dummy",
        steps: [
          { step: WAIT_EVENT_STEP, params: { event: "approval.decided", timeoutMs: 1_000 } },
          { step: "record" },
        ],
        executionMode: { delivery: "sync" },
      },
    });
  }

  it("waits through the platform step, under the engine's own wait name", async () => {
    const calls: { name: string; options: { type: string; timeout?: number } }[] = [];
    const step = {
      do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      waitForEvent: async (name: string, options: { type: string; timeout?: number }) => {
        calls.push({ name, options });
        return { payload: { decision: "approve" } };
      },
    };
    const { stores, deps } = makeDeps();
    await defineJob(deps);
    const outcome = await runJobPipelineWorkflowFlow(deps, step, { jobId: "approval" });
    expect(outcome.state).toBe("completed");
    expect(calls).toHaveLength(1);
    // The engine names the wait, the job declares the event and its bound.
    expect(calls[0].name.startsWith("wait:")).toBe(true);
    expect(calls[0].options).toEqual({ type: "approval.decided", timeout: 1_000 });
    expect(await stores.artifacts.getArtifact("run-1", "root/step-0")).toEqual({
      outcome: "event",
      event: "approval.decided",
      payload: { decision: "approve" },
    });
  });

  it("turns the platform's timeout throw into a declared outcome", async () => {
    const step = {
      do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      waitForEvent: async () => {
        const timeout = new Error("waitForEvent 'wait:root' timed out after 1000ms");
        timeout.name = "TimeoutError";
        throw timeout;
      },
    };
    const { stores, deps } = makeDeps();
    await defineJob(deps);
    const outcome = await runJobPipelineWorkflowFlow(deps, step, { jobId: "approval" });
    // The workflow completes: the timeout is the step's outcome, not a failure.
    expect(outcome.state).toBe("completed");
    expect(await stores.artifacts.getArtifact("run-1", "root/step-0")).toEqual({
      outcome: "timeout",
      event: "approval.decided",
    });
  });

  it("keeps a platform error that is not a timeout failing the run", async () => {
    const step = {
      do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      waitForEvent: async () => {
        throw new Error("instance not found");
      },
    };
    const { deps } = makeDeps();
    await defineJob(deps);
    const outcome = await runJobPipelineWorkflowFlow(deps, step, { jobId: "approval" });
    expect(outcome.state).toBe("failed");
  });

  it("injects no channel when the step cannot wait", () => {
    expect(waitChannelFromStep({})).toEqual({});
  });
});
