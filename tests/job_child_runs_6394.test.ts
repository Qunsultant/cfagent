// @vitest-environment node
/**
 * Issue #6394 — the child-run primitive: a step starts an INDEPENDENT run.
 *
 * A fan-out was always units inside ONE run, so one unit's failure failed the
 * run. A child run has its own id, its own instance row and its own lifecycle:
 * the parent records the child's id and reacts to its outcome by a NAMED rule.
 *
 * Pins:
 *  - 6394-P01 a child run is dispatched as its own run, linked to the parent by
 *    origin, and the step's output names it;
 *  - 6394-P02 a failed child with `onFailure: "continue"` leaves the parent
 *    completed, carrying the child's outcome;
 *  - 6394-P03 a failed child with `onFailure: "fail"` fails the parent with a
 *    coded error — the child keeps its own failure;
 *  - 6394-P04 a child naming the parent's own job refuses by name (one live run
 *    per instance, so it would collide);
 *  - 6394-P05 `onFailure` is required: a parent never silently proceeds past a
 *    failed child.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  CHILD_RUN_STEP,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobChildRunOutcome,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";

const PARENT = "parent-job";
const CHILD = "child-job";

function makeControl() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const steps = createBuiltinStepRegistry();
  steps.register("ok", async () => ({ output: { ok: true } }));
  steps.register("boom", async () => {
    throw new JobPipelineError("job_config_invalid", "the child cannot run");
  });
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
  });
  return { control, stores, runStore };
}

async function definePair(
  control: ReturnType<typeof makeControl>["control"],
  opts: { childSteps?: Array<Record<string, unknown>>; parentParams: Record<string, unknown> },
) {
  await control.defineJob({
    jobId: CHILD,
    root: {
      kind: "dummy",
      steps: opts.childSteps ?? [{ step: "ok" }],
      executionMode: { delivery: "sync" },
    },
  });
  await control.defineJob({
    jobId: PARENT,
    root: {
      kind: "dummy",
      steps: [{ step: CHILD_RUN_STEP, params: opts.parentParams }],
      executionMode: { delivery: "sync" },
    },
  });
}

describe("6394-P01 a child runs as its own run, linked to the parent", () => {
  it("dispatches, awaits and records the child id", async () => {
    const h = makeControl();
    await definePair(h.control, {
      parentParams: { jobId: CHILD, onFailure: "fail" },
    });

    const dispatch = await h.control.runJob(PARENT, { trigger: "manual" });

    expect(dispatch.state).toBe("completed");
    const childOutcome = (await h.stores.artifacts.getArtifact(
      dispatch.runId,
      "root/step-0",
    )) as JobChildRunOutcome;
    expect(childOutcome.outcome).toBe("completed");
    expect(childOutcome.childJobId).toBe(CHILD);
    expect(childOutcome.childRunId).not.toBe(dispatch.runId);

    // The child is a first-class run: its own record, linked by origin.
    const childRecord = h.runStore.listByJob(CHILD, 1)[0];
    expect(childRecord?.originRunId).toBe(dispatch.runId);
    expect((await h.control.getJob(CHILD)).instance?.state).toBe("completed");
  });
});

describe("6394-P02 continue: a failed child does not fail the parent", () => {
  it("completes the parent, carrying the child's outcome", async () => {
    const h = makeControl();
    await definePair(h.control, {
      childSteps: [{ step: "boom" }],
      parentParams: { jobId: CHILD, onFailure: "continue" },
    });

    const dispatch = await h.control.runJob(PARENT, { trigger: "manual" });

    expect(dispatch.state).toBe("completed");
    const childOutcome = (await h.stores.artifacts.getArtifact(
      dispatch.runId,
      "root/step-0",
    )) as JobChildRunOutcome;
    expect(childOutcome.outcome).toBe("failed");
    // The failure stayed the child's own.
    expect((await h.control.getJob(CHILD)).instance?.state).toBe("failed");
  });
});

describe("6394-P03 fail: the parent fails, the child keeps its failure", () => {
  it("refuses by code, naming the child run", async () => {
    const h = makeControl();
    await definePair(h.control, {
      childSteps: [{ step: "boom" }],
      parentParams: { jobId: CHILD, onFailure: "fail" },
    });

    const dispatch = await h.control.runJob(PARENT, { trigger: "manual" });

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(PARENT)).instance?.lastError ?? "";
    expect(failed).toContain("child-job");
    expect(failed).toContain("onFailure");
    expect((await h.control.getJob(CHILD)).instance?.state).toBe("failed");
  });
});

describe("6394-P04 a child of the parent's own job refuses", () => {
  it("names the collision instead of dispatching", async () => {
    const h = makeControl();
    await definePair(h.control, {
      parentParams: { jobId: PARENT, onFailure: "fail" },
    });

    const dispatch = await h.control.runJob(PARENT, { trigger: "manual" });

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(PARENT)).instance?.lastError ?? "";
    expect(failed).toContain("different job");
  });
});

describe("6394-P05 onFailure is required", () => {
  it("refuses a child whose failure rule is unnamed", async () => {
    const h = makeControl();
    await definePair(h.control, { parentParams: { jobId: CHILD } });

    const dispatch = await h.control.runJob(PARENT, { trigger: "manual" });

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(PARENT)).instance?.lastError ?? "";
    expect(failed).toContain("onFailure");
    expect(failed).toContain("never silently");
  });
});
