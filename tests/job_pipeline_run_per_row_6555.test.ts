// @vitest-environment node
/**
 * Issue #6555 — engine run-per-row mode: concurrent runs per definition
 * (instance keyed by run, not jobId).
 *
 * The engine allows one run per jobId today: dispatchResolved refuses
 * `job_already_running` when the job's instance is queued / running /
 * paused. The executor runs unbounded concurrent rows per capability.
 * This mode is opt-in per definition (`instanceScope: "run"` on the
 * definition config; default `"job"` keeps the one-run-per-jobId guard).
 * Each concurrent submission gets its own run, keyed by its own
 * instance row; a true duplicate — the same submission (same
 * asyncJobId) with a live row — is still refused.
 *
 * Duplicate semantics, defined here (not left implicit):
 * - same (jobId, asyncJobId) with a live per-run row → refused
 *   `job_already_running`;
 * - same key after the row is terminal → a new run is allowed
 *   (re-dispatch / retry);
 * - no asyncJobId → each dispatch is a new run (nothing to dedupe
 *   against).
 * Simultaneous same-key dispatches are check-then-write, not atomic:
 * the queue claim remains the atomic gate on F1's path.
 *
 * Eviction simulation, stated honestly: a single process cannot die
 * mid-run, so the replay test drives the first dispatch with one
 * control and the replay with a FRESH control over the same stores —
 * exactly the shape the workflow flow re-enters with after an
 * eviction. The first executor is still parked in-process, so the
 * resumed step executes a second time here; in production the first
 * process is gone and the step journal dedupes the re-execution.
 * The test asserts the dispatch outcome (same runId, no refusal),
 * not the step-execution count.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Starts = Array<{ runId: string; stepIndex: number }>;

function testDeps(
  stores: JobPipelineStores,
  runStore: InMemoryJobRunRecordStore,
  starts: Starts,
  gate: Promise<void>,
  newRunId: () => string,
): JobPipelineDeps {
  const steps = createBuiltinStepRegistry();
  steps.register("gate", async (ctx: JobStepContext) => {
    starts.push({ runId: ctx.runId, stepIndex: ctx.stepIndex });
    await gate;
    return { output: { gated: ctx.runId } };
  });
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    newRunId,
  };
}

function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const PER_RUN_JOB = {
  jobId: "row-capable",
  name: "Row capable",
  instanceScope: "run",
  root: {
    kind: "row-test",
    steps: [{ step: "gate" }],
    executionMode: { delivery: "async" },
  },
};

const PER_RUN_SYNC_JOB = {
  jobId: "row-capable-sync",
  name: "Row capable sync",
  instanceScope: "run",
  root: {
    kind: "row-test",
    steps: [{ step: "gate" }],
    executionMode: { delivery: "sync" },
  },
};

const SINGLE_JOB = {
  jobId: "single-guarded",
  name: "Single guarded",
  root: {
    kind: "row-test",
    steps: [{ step: "gate" }],
    executionMode: { delivery: "async" },
  },
};

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof JobPipelineError ? error.code : `non-pipeline: ${String(error)}`;
  }
}

describe("engine run-per-row mode (#6555)", () => {
  it("N concurrent submissions of one per-run definition all run concurrently", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const starts: Starts = [];
    const gate = deferred();
    const control = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, counterIds("run")),
    );
    await control.defineJob(PER_RUN_JOB);

    const d1 = await control.runJob("row-capable", { asyncJobId: "job:a" });
    const d2 = await control.runJob("row-capable", { asyncJobId: "job:b" });
    const d3 = await control.runJob("row-capable", { asyncJobId: "job:c" });
    const runIds = new Set([d1.runId, d2.runId, d3.runId]);
    expect(runIds.size).toBe(3);

    // All three started before any finished: true concurrency, not serial.
    await waitFor(() => starts.length === 3, "3 gate starts");
    expect(new Set(starts.map((s) => s.runId)).size).toBe(3);

    gate.resolve();
    await Promise.all([d1.completion, d2.completion, d3.completion]);
    const runs = await runStore.listByJob("row-capable", 10);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.outcome === "success")).toBe(true);
  });

  it("a true duplicate (same asyncJobId, live row) is refused; after terminal it re-dispatches", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const starts: Starts = [];
    const gate = deferred();
    const control = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, counterIds("run")),
    );
    await control.defineJob(PER_RUN_JOB);

    const first = await control.runJob("row-capable", { asyncJobId: "job:dup" });
    // The first dispatch's row must be live before the duplicate is
    // attempted — the gate start proves executeRun stamped the row.
    await waitFor(() => starts.length === 1, "first gate start");
    const duplicateCode = await codeOf(
      control.runJob("row-capable", { asyncJobId: "job:dup" }),
    );
    expect(duplicateCode).toBe("job_already_running");

    gate.resolve();
    await first.completion;
    const again = await control.runJob("row-capable", { asyncJobId: "job:dup" });
    expect(again.runId).not.toBe(first.runId);
    await again.completion;
    const runs = await runStore.listByJob("row-capable", 10);
    expect(runs).toHaveLength(2);
  });

  it("sync-mode submissions still return their outcome inline under concurrency", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const starts: Starts = [];
    const gate = deferred();
    const control = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, counterIds("run")),
    );
    await control.defineJob(PER_RUN_SYNC_JOB);

    const p1 = control.runJob("row-capable-sync", { asyncJobId: "job:s1" });
    const p2 = control.runJob("row-capable-sync", { asyncJobId: "job:s2" });
    await waitFor(() => starts.length === 2, "2 sync gate starts");
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.state).toBe("completed");
    expect(r2.state).toBe("completed");
    expect(r1.runId).not.toBe(r2.runId);
  });

  it("a single-mode definition (default) still refuses the second dispatch", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const starts: Starts = [];
    const gate = deferred();
    const control = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, counterIds("run")),
    );
    await control.defineJob(SINGLE_JOB);

    const first = await control.runJob("single-guarded", { asyncJobId: "job:one" });
    await waitFor(() => starts.length === 1, "first gate start");
    const secondCode = await codeOf(
      control.runJob("single-guarded", { asyncJobId: "job:two" }),
    );
    expect(secondCode).toBe("job_already_running");

    gate.resolve();
    await first.completion;
  });

  it("a proven replay (same asyncJobId + same workflow instance id) resumes the live run; an unproven one refuses", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const starts: Starts = [];
    const gate = deferred();
    const ids = counterIds("run");
    const control = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, ids),
    );
    await control.defineJob(PER_RUN_JOB);

    const first = await control.runJob("row-capable", {
      asyncJobId: "job:replay",
      workflowInstanceId: "wf-1",
    });
    await waitFor(() => starts.length === 1, "first gate start");

    // Fresh control over the same stores: the eviction re-entry shape.
    const replayControl = createJobPipelineControl(
      testDeps(stores, runStore, starts, gate.promise, ids),
    );
    const replayed = await replayControl.runJob("row-capable", {
      asyncJobId: "job:replay",
      workflowInstanceId: "wf-1",
    });
    expect(replayed.runId).toBe(first.runId);

    const unprovenCode = await codeOf(
      replayControl.runJob("row-capable", {
        asyncJobId: "job:replay",
        workflowInstanceId: "wf-2",
      }),
    );
    expect(unprovenCode).toBe("job_already_running");

    gate.resolve();
    await first.completion;
  });
});
