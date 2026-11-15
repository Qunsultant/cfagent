// @vitest-environment node
/**
 * Issue #4544 — engine retry must not mask a failed forced rerun
 * by replaying recorded step output.
 *
 * The defect: `executeUnit` honors the forced re-run at its
 * starting position (a forced unit starts at step 0) but the
 * retry loop re-derives the resume position unconditionally.
 * A forced re-run reuses the dispatch's run id, so the
 * dispatch's step artifacts are still in the run's artifact
 * store — the re-derivation finds them, resumes past the
 * ordered steps, and the batch path returns the recorded
 * output with zero step executions. A rerun can report
 * `completed` without re-executing.
 *
 * The fix: the retry re-derivation honors the same rule as the
 * starting position — a forced unit restarts at step 0.
 * Everything else keeps deriving: a fresh run's retry resumes
 * from what its own first try persisted, and a resumed run's
 * retry derives from the persisted hand-offs. Legitimate
 * resume-after-pause is unchanged.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";

interface StepCall {
  step: string;
  invocation: number;
  itemIndex: number | null;
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  calls: StepCall[];
  counts: Map<string, number>;
  /** Invocation numbers (per step) that throw instead of returning. */
  failOn: Map<string, Set<number>>;
}

function makeHarness(): Harness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const calls: StepCall[] = [];
  const counts = new Map<string, number>();
  const failOn = new Map<string, Set<number>>();
  const steps = createBuiltinStepRegistry();
  for (const name of ["stepA", "stepB", "block"]) {
    steps.register(name, async (ctx: JobStepContext) => {
      const invocation = (counts.get(name) ?? 0) + 1;
      counts.set(name, invocation);
      calls.push({ step: name, invocation, itemIndex: ctx.itemIndex ?? null });
      if (failOn.get(name)?.has(invocation)) {
        throw new Error(`${name} invocation ${invocation} fails by plan`);
      }
      return { output: { from: name, value: invocation } };
    });
  }
  let runCounter = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
  });
  return { control, stores, calls, counts, failOn };
}

describe("engine retry on a forced re-run (#4544)", () => {
  it("re-executes the ordered step after a mid-rerun failure instead of replaying the recorded output", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "single",
      root: { kind: "dummy", steps: [{ step: "stepA" }], executionMode: { delivery: "sync" } },
    });
    const dispatch = await h.control.runJob("single");
    expect(dispatch.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(1);
    expect(await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0")).toEqual({
      from: "stepA",
      value: 1,
    });

    // The re-run's first try throws; the retry must re-execute,
    // not resume past the dispatch's recorded step-0 artifact.
    h.failOn.set("stepA", new Set([2]));
    const rerun = await h.control.rerunStage("single", "");
    expect(rerun.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(3);
    expect(await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0")).toEqual({
      from: "stepA",
      value: 3,
    });
  });

  it("restarts the whole forced stage on retry, not just the failed step", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "two-step",
      root: {
        kind: "dummy",
        steps: [{ step: "stepA" }, { step: "stepB" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("two-step");
    expect(dispatch.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(1);
    expect(h.counts.get("stepB")).toBe(1);

    // The re-run's first try executes stepA, then stepB throws.
    // The retry restarts at step 0: stepA re-executes too, even
    // though the first try just overwrote its hand-off.
    h.failOn.set("stepB", new Set([2]));
    const rerun = await h.control.rerunStage("two-step", "");
    expect(rerun.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(3);
    expect(h.counts.get("stepB")).toBe(3);
    expect(await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0")).toEqual({
      from: "stepA",
      value: 3,
    });
  });

  it("restarts online items from the first item on a forced retry", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "online",
      root: {
        kind: "dummy",
        steps: [{ step: "stepA" }],
        inputs: { items: [1, 2] },
        executionMode: {
          concurrency: "sequential",
          pacing: "online",
          delivery: "async",
          shape: "monolith",
        },
      },
    });
    const dispatch = await h.control.runJob("online");
    expect((await dispatch.completion!)?.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(2);

    // The re-run's first try executes item 0, then throws on
    // item 1 (invocation 4). The retry restarts at item 0:
    // both items re-execute.
    h.failOn.set("stepA", new Set([4]));
    const rerun = await h.control.rerunStage("online", "");
    expect(rerun.state).toBe("completed");
    expect(h.counts.get("stepA")).toBe(6);
    expect(h.calls.filter((c) => c.itemIndex === 0)).toHaveLength(3);
    expect(h.calls.filter((c) => c.itemIndex === 1)).toHaveLength(3);
  });
});

describe("engine retry keeps deriving where the re-run is not forced (#4544)", () => {
  it("a fresh run's retry resumes from the step its own first try persisted", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "fresh",
      root: {
        kind: "dummy",
        steps: [{ step: "stepA" }, { step: "stepB" }],
        executionMode: { delivery: "sync" },
      },
    });
    h.failOn.set("stepB", new Set([1]));
    const dispatch = await h.control.runJob("fresh");
    expect(dispatch.state).toBe("completed");
    // stepA executed once: the retry derived past it from the
    // artifact the first try persisted. stepB re-executed.
    expect(h.counts.get("stepA")).toBe(1);
    expect(h.counts.get("stepB")).toBe(2);
  });

  it("a resumed run's retry derives from the persisted hand-offs and never restarts the stage", async () => {
    const h = makeHarness();
    let release!: () => void;
    const releasePromise = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const steps = createBuiltinStepRegistry();
    const counts = new Map<string, number>();
    steps.register("block", async () => {
      counts.set("block", (counts.get("block") ?? 0) + 1);
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    steps.register("stepB", async () => {
      const invocation = (counts.get("stepB") ?? 0) + 1;
      counts.set("stepB", invocation);
      if (invocation === 1) throw new Error("stepB fails once on resume");
      return { output: { from: "stepB", value: invocation } };
    });
    const control = createJobPipelineControl({
      stores: h.stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      now: () => new Date("2026-11-06T12:00:00.000Z"),
      newRunId: () => "run-pause",
    });
    await control.defineJob({
      jobId: "pauser",
      root: {
        kind: "dummy",
        steps: [{ step: "block" }, { step: "stepB" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("pauser");
    await enteredPromise;
    await control.pauseJob("pauser");
    release();
    expect((await dispatch.completion!)?.state).toBe("paused");

    const resumed = await control.resumeJob("pauser");
    expect((await resumed.completion!)?.state).toBe("completed");
    // The completed step was not re-executed, on the resume or
    // on the resume's retry; the failed step re-executed once.
    expect(counts.get("block")).toBe(1);
    expect(counts.get("stepB")).toBe(2);
  });
});
