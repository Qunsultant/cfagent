// @vitest-environment node
/**
 * Issue #3954 — stuck detection as a uniform stage capability.
 *
 * A unit that starts and never progresses was invisible to the engine: the
 * per-unit `timeoutMs` race only fires for work that is still awaited, and the
 * stale-running sweep (#3907) lives on the async-jobs/screener side. A
 * pipeline stage could sit `running` forever with nothing surfacing it.
 *
 * This suite pins the engine-native capability — heartbeat, sweep, reap — with
 * the same semantics the async-jobs sweep already has, so a family does not
 * bolt one on again:
 *
 *  - 3954-P01 a unit whose recorded activity is older than the bound is
 *    reaped: marked failed with a coded error, and the run settles failed with
 *    its terminal record (never a silent hang);
 *  - 3954-P02 a unit with fresh activity is untouched;
 *  - 3954-P03 a terminal unit is never reaped;
 *  - 3954-P04 the bound is configuration (`pipeline.stuckUnitAfterMs`), not a
 *    constant in the sweep;
 *  - 3954-P05 a checkpoint written before heartbeats existed is still
 *    sweepable — the recorded `startedAt`/`updatedAt` is its activity stamp.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { createJobPipelineStageCheckpointStore } from "../src/data/jobPipelineStageCheckpoint";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";

const JOB_ID = "stuckable";
const RUN = "run-stuck";
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function makeControl(opts: { settings?: Record<string, string> } = {}) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    now: () => new Date(NOW),
    newRunId: () => RUN,
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  return { control, stores, runStore };
}

/** A running instance whose one unit has been `running` since `activityAgoMs`. */
async function stuckUnit(
  h: ReturnType<typeof makeControl>,
  opts: { activityAgoMs: number; withHeartbeat?: boolean } = { activityAgoMs: 3_600_000 },
) {
  await h.control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      steps: [{ step: "record" }],
      executionMode: { delivery: "sync" },
    },
  });
  const base = await h.stores.instances.getInstance(JOB_ID);
  const activityAt = new Date(NOW - opts.activityAgoMs).toISOString();
  await h.stores.instances.saveInstance({
    ...base!,
    state: "running",
    currentRunId: RUN,
    runStartedAt: activityAt,
    runTrigger: "manual",
    runKind: "original",
    runDefinitionVersion: 1,
  });
  await createJobPipelineStageCheckpointStore(h.stores.instances, JOB_ID).write({
    runId: RUN,
    trigger: "manual",
    kind: "original",
    units: [
      {
        stage: "job:" as never,
        unitId: RUN,
        status: "running" as never,
        attempt: 1,
        startedAt: activityAt,
        updatedAt: activityAt,
        ...(opts.withHeartbeat === false ? {} : { heartbeatAt: activityAt }),
      },
    ],
  });
}

describe("3954-P01 a stuck unit is reaped and the run settles", () => {
  it("marks the unit failed by code and records the terminal run", async () => {
    const h = makeControl();
    await stuckUnit(h, { activityAgoMs: 3_600_000 });

    const result = await h.control.sweepStuckUnits({ nowMs: NOW });

    expect(result.stuck).toHaveLength(1);
    expect(result.stuck[0].jobId).toBe(JOB_ID);
    expect(result.stuck[0].unitId).toBe(RUN);
    expect(result.settled).toEqual([JOB_ID]);

    const checkpoint = await createJobPipelineStageCheckpointStore(
      h.stores.instances,
      JOB_ID,
    ).read(RUN);
    const unit = checkpoint?.units[0];
    expect(unit?.status).toBe("failed");
    expect(unit?.error).toContain("job_unit_stuck");

    const instance = await h.stores.instances.getInstance(JOB_ID);
    expect(instance?.state).toBe("failed");
    expect(instance?.lastError).toContain("stuck");

    // The settle went through the engine's own terminal path, so the run has
    // a record rather than vanishing.
    const record = h.runStore.listByJob(JOB_ID, 1)[0];
    expect(record?.outcome).toBe("failure");
  });
});

describe("3954-P02 fresh activity is not stuck", () => {
  it("leaves a unit that is still progressing alone", async () => {
    const h = makeControl();
    await stuckUnit(h, { activityAgoMs: 1_000 });

    const result = await h.control.sweepStuckUnits({ nowMs: NOW });

    expect(result.stuck).toEqual([]);
    expect((await h.stores.instances.getInstance(JOB_ID))?.state).toBe("running");
  });
});

describe("3954-P03 a terminal unit is never reaped", () => {
  it("ignores completed units however old", async () => {
    const h = makeControl();
    await stuckUnit(h, { activityAgoMs: 3_600_000 });
    const store = createJobPipelineStageCheckpointStore(h.stores.instances, JOB_ID);
    const checkpoint = await store.read(RUN);
    await store.write({
      ...checkpoint!,
      units: [{ ...checkpoint!.units[0], status: "completed" as never }],
    });

    const result = await h.control.sweepStuckUnits({ nowMs: NOW });

    expect(result.stuck).toEqual([]);
  });
});

describe("3954-P04 the bound is configuration", () => {
  it("reaps at the configured bound, not a constant", async () => {
    // Five seconds of silence: stuck under a 1s bound, healthy under 30min.
    const tight = makeControl({ settings: { "pipeline.stuckUnitAfterMs": "1000" } });
    await stuckUnit(tight, { activityAgoMs: 5_000 });
    expect((await tight.control.sweepStuckUnits({ nowMs: NOW })).stuck).toHaveLength(1);

    const loose = makeControl();
    await stuckUnit(loose, { activityAgoMs: 5_000 });
    expect((await loose.control.sweepStuckUnits({ nowMs: NOW })).stuck).toEqual([]);
  });
});

describe("3954-P05 a pre-heartbeat checkpoint is still sweepable", () => {
  it("falls back to the recorded activity stamp", async () => {
    const h = makeControl();
    await stuckUnit(h, { activityAgoMs: 3_600_000, withHeartbeat: false });

    const result = await h.control.sweepStuckUnits({ nowMs: NOW });

    expect(result.stuck).toHaveLength(1);
  });
});
