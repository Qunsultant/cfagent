// @vitest-environment node
/**
 * Issue #4467 — replay a past run.
 *
 * Pins:
 *  - 4467-P01 a replay is a NEW run: new run id, kind "replay", origin = the
 *    replayed run, and the original record is untouched;
 *  - 4467-P02 the replay executes the ORIGINAL run's definition version, not
 *    today's (a reconfigure in between does not change what is replayed);
 *  - 4467-P03 an unknown run refuses by name (`job_run_not_found`);
 *  - 4467-P04 a run whose configuration was never retained refuses by name
 *    (`replay_pre_retention_run`) — never "closest version";
 *  - 4467-P05 a stamped version that is no longer resolvable refuses by name;
 *  - 4467-P06 the route maps those refusals onto 404/409, and refuses when no
 *    control door is configured.
 */
import { describe, it, expect } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { handleJobStatusRoutes } from "../src/agents/routes/jobStatus";

function makeHarness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const steps = createBuiltinStepRegistry();
  steps.register("track", async () => ({ output: { tracked: true } }));
  let tick = 0;
  let runCounter = 0;
  const base = Date.parse("2026-11-20T12:00:00.000Z");
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: { publish: async () => {}, subscribe: () => () => {} } as never,
    steps,
    now: () => new Date(base + tick++ * 1000),
    newRunId: () => `run-${++runCounter}`,
  };
  return { control: createJobPipelineControl(deps), stores, runStore };
}

const JOB = {
  jobId: "replay-job",
  name: "Replay job",
  root: {
    kind: "track",
    steps: [{ step: "track", params: {} }],
    executionMode: { delivery: "sync" },
  },
};

const legacyRecord = (jobId: string, workflowId: string, definitionVersion: number | null) =>
  buildJobRunRecord({
    system: "job-pipeline",
    jobId,
    operation: "job",
    started: "2026-11-20T00:00:00.000Z",
    finished: "2026-11-20T00:00:01.000Z",
    outcome: "success",
    triggeredBy: "manual",
    workflowId,
    definitionVersion,
  });

describe("4467-P01 a replay is a new run that names the one it replayed", () => {
  it("mints a fresh run id and leaves the original record untouched", async () => {
    const { control, runStore } = makeHarness();
    await control.defineJob(JOB);
    const first = await control.runJob(JOB.jobId);

    const replayed = await control.replayRun(JOB.jobId, first.runId);
    expect(replayed.runId).not.toBe(first.runId);

    const records = runStore.listByJob(JOB.jobId, 10);
    const original = records.find((r) => r.workflowId === first.runId)!;
    const replayedRecord = records.find((r) => r.workflowId === replayed.runId)!;
    expect(original.kind).toBe("original");
    expect(replayedRecord.kind).toBe("replay");
    expect(replayedRecord.originRunId).toBe(first.runId);
  });
});

describe("4467-P02 a replay executes the original's definition version", () => {
  it("replays v1 after the job was reconfigured to v2", async () => {
    const { control, runStore } = makeHarness();
    await control.defineJob(JOB);
    const first = await control.runJob(JOB.jobId);

    await control.configureJob(JOB.jobId, { name: "Replay job (renamed)" });

    const replayed = await control.replayRun(JOB.jobId, first.runId);
    const record = runStore.listByJob(JOB.jobId, 10).find((r) => r.workflowId === replayed.runId)!;
    // The replayed run executed the version the original used, not the
    // version the job now points at.
    expect(record.definitionVersion).toBe(1);
    expect((await control.getDefinition(JOB.jobId)).version).toBe(2);
  });
});

describe("4467-P03 an unknown run refuses by name", () => {
  it("throws job_run_not_found", async () => {
    const { control } = makeHarness();
    await control.defineJob(JOB);
    await expect(control.replayRun(JOB.jobId, "run-does-not-exist")).rejects.toThrow(
      /job_run_not_found|no run/i,
    );
  });
});

describe("4467-P04 a run with no retained configuration refuses by name", () => {
  it("throws replay_pre_retention_run, never a closest version", async () => {
    const { control, runStore } = makeHarness();
    await control.defineJob(JOB);
    runStore.record(legacyRecord(JOB.jobId, "run-legacy", null));

    await expect(control.replayRun(JOB.jobId, "run-legacy")).rejects.toThrow(
      /replay_pre_retention_run|predates/i,
    );
  });
});

describe("4467-P05 a stamped version that cannot be resolved refuses by name", () => {
  it("throws replay_definition_version_unresolved", async () => {
    const { control, runStore } = makeHarness();
    await control.defineJob(JOB);
    runStore.record(legacyRecord(JOB.jobId, "run-ghost", 42));

    await expect(control.replayRun(JOB.jobId, "run-ghost")).rejects.toThrow(
      /replay_definition_version_unresolved|no longer resolvable/i,
    );
  });
});

describe("4467-P06 the route maps refusals onto 404/409 and needs a door", () => {
  const call = (path: string, ctx: Parameters<typeof handleJobStatusRoutes>[3]) =>
    handleJobStatusRoutes(
      new Request(`https://example.test${path}`, { method: "POST" }),
      new URL(`https://example.test${path}`),
      path,
      ctx,
    );

  it("answers 200 with the new run id", async () => {
    const res = await call("/api/jobs/replay-job/runs/run-1/replay", {
      readJobStatus: async () => null,
      replayJobRun: async (jobId, runId) => ({
        jobId,
        replayedRunId: runId,
        runId: "run-2",
        state: "completed",
      }),
    });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({
      jobId: "replay-job",
      replayedRunId: "run-1",
      runId: "run-2",
      state: "completed",
    });
  });

  it("answers 409 for a pre-retention run", async () => {
    const res = await call("/api/jobs/replay-job/runs/run-1/replay", {
      readJobStatus: async () => null,
      replayJobRun: async () => {
        throw new Error("replay_pre_retention_run: its exact configuration was not retained");
      },
    });
    expect(res?.status).toBe(409);
  });

  it("answers 404 for an unknown run", async () => {
    const res = await call("/api/jobs/replay-job/runs/run-1/replay", {
      readJobStatus: async () => null,
      replayJobRun: async () => {
        throw new Error("job_run_not_found: no run run-1");
      },
    });
    expect(res?.status).toBe(404);
  });

  it("answers 503 when the surface has no control door", async () => {
    const res = await call("/api/jobs/replay-job/runs/run-1/replay", {
      readJobStatus: async () => null,
    });
    expect(res?.status).toBe(503);
  });
});
