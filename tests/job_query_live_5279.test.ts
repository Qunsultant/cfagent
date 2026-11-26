// @vitest-environment node
/**
 * Issue #5279 — the QUERY half: a running job's live state.
 *
 * `getJob` answers from stored views (definition + instance + run history +
 * stage reads), so a run in flight looks like whatever was last persisted.
 * This pins the live read: while a unit is executing in this process, a query
 * says so, which stage and unit are active, and how many steps have started;
 * once the run settles it says not-live again.
 *
 * (The SIGNAL half is not built here — see the decision recorded on the issue:
 * delivery to a parked `wait.event` already exists via `sendEvent`, while a
 * recorded, boundary-honoured signal needs semantics the owner must name.)
 *
 * Pins:
 *  - 5279-Q01 a query reports the live run, its active unit and its step count
 *    while the step is executing;
 *  - 5279-Q02 the same query reports not-live once the run settles;
 *  - 5279-Q03 an idle job reads as not-live with its stored state;
 *  - 5279-Q04 an unknown job refuses by name.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";

const JOB_ID = "queryable";

function makeControl() {
  const stores = createInMemoryJobPipelineStores();
  const steps = createBuiltinStepRegistry();
  const gate: { release?: () => void } = {};
  const entered: { promise: Promise<void>; resolve: () => void } = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  })();
  steps.register(
    "hold",
    () =>
      new Promise((resolve) => {
        entered.resolve();
        gate.release = () => resolve({ output: { released: true } });
      }),
  );
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
  });
  return { control, gate, entered };
}

async function defineHeldJob(control: ReturnType<typeof makeControl>["control"]) {
  await control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      steps: [{ step: "hold" }],
      executionMode: { delivery: "sync" },
    },
  });
}

describe("5279-Q01 a query reports the live run", () => {
  it("names the active unit and the step count while the step executes", async () => {
    const h = makeControl();
    await defineHeldJob(h.control);
    const running = h.control.runJob(JOB_ID, { trigger: "manual" });
    await h.entered.promise;

    const live = await h.control.queryJob(JOB_ID);

    expect(live.jobId).toBe(JOB_ID);
    expect(live.live).toBe(true);
    expect(live.activeUnits.length).toBeGreaterThan(0);
    expect(live.stepExecutions).toBeGreaterThanOrEqual(1);

    h.gate.release?.();
    await running;

    const after = await h.control.queryJob(JOB_ID);
    expect(after.live).toBe(false);
  });
});

describe("5279-Q02 the same query reads not-live after settlement", () => {
  it("reports the stored state once the run is done", async () => {
    const h = makeControl();
    await defineHeldJob(h.control);
    const running = h.control.runJob(JOB_ID, { trigger: "manual" });
    await h.entered.promise;
    h.gate.release?.();
    const settled = await running;
    expect(settled.state).toBe("completed");

    const after = await h.control.queryJob(JOB_ID);

    expect(after.live).toBe(false);
    expect(after.activeUnits).toEqual([]);
    expect(after.stepExecutions).toBe(0);
  });
});

describe("5279-Q03 an idle job reads as not-live", () => {
  it("answers from the stored state", async () => {
    const h = makeControl();
    await defineHeldJob(h.control);

    const view = await h.control.queryJob(JOB_ID);

    expect(view.live).toBe(false);
    expect(view.state).toBe("idle");
    expect(view.runId).toBeNull();
  });
});

describe("5279-Q04 an unknown job refuses by name", () => {
  it("refuses job_not_found", async () => {
    const h = makeControl();
    await expect(h.control.queryJob("does-not-exist")).rejects.toMatchObject({
      code: "job_not_found",
    });
  });
});
