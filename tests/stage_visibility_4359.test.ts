// @vitest-environment node
/**
 * Issue #4359 ([Stage visibility] FIRST FIX) — checkpoint → Workflow Runs:
 * six engine stages with start/end/duration.
 *
 * Pins:
 *  - 4359-P01 the engine stamps per-unit start and end at checkpoint-write
 *    time; a stage's duration is the recorded difference, never inferred.
 *  - 4359-P02 the status view carries those stamps: every stage and every
 *    unit, with a stage duration computed from them.
 *  - 4359-P03 one projection: JobStageView[] → WorkflowRunStage[] — six
 *    stages in definition order, marked as engine-recorded.
 *  - 4359-P04 a grouped run uses the engine's stages when the reader has
 *    them, and falls back to the job rows when it does not (no regression).
 *  - 4359-P05 a standalone D1 record renders the engine's stages and counts
 *    them; without stages it stays an honest empty list.
 *  - 4359-P06 the /workflow-runs read asks the job-status surface for the
 *    run's engine job, and a missing checkpoint is an empty list, never a
 *    500 and never a dropped row.
 *  - 4359-P07 a checkpoint that belongs to another run is never projected
 *    under this run's id.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobStageView,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import {
  buildWorkflowRunsPage,
  runFromJobRunRecord,
  runFromJobs,
  stagesFromEngineViews,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");

/** A clock that advances one second per reading: start and end can never be equal. */
function tickingClock(startMs: number) {
  let current = startMs;
  return () => {
    const at = new Date(current);
    current += 1000;
    return at;
  };
}

function noopRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  return registry;
}

const SIX_STAGES = ["feed", "enrich", "analyze", "store", "serve", "deliver"] as const;

/** The incident's shape: one screener job with six chained stage nodes. */
function sixStageConfig(jobId: string) {
  let node: Record<string, unknown> | undefined;
  for (let i = SIX_STAGES.length - 1; i >= 0; i -= 1) {
    const next: Record<string, unknown> = {
      kind: SIX_STAGES[i],
      steps: [{ step: "noop" }],
      processing: { shards: ["shard-1"] },
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  return { jobId, name: `Screen ${jobId}`, root: node };
}

async function makeHarness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps: noopRegistry(),
    now: tickingClock(T0),
  });
  return { stores, runStore, control };
}

async function runSixStageJob(jobId = "screen-4359") {
  const harness = await makeHarness();
  await harness.control.defineJob(sixStageConfig(jobId));
  const dispatch = await harness.control.runJob(jobId, { trigger: "manual" });
  const outcome = dispatch.completion ? await dispatch.completion : null;
  const view = await harness.control.getJob(jobId);
  return { ...harness, outcome, view };
}

function jobRow(over: Partial<WorkflowRunJobRow> = {}): WorkflowRunJobRow {
  return {
    job_id: "screen-4359",
    capability: "screening",
    display_name: "Chat stock screen",
    status: "completed",
    created_at: new Date(T0).toISOString(),
    ...over,
  };
}

describe("4359-P01 the engine records per-unit start and end", () => {
  it("stamps startedAt and endedAt on every unit of a six-stage run", async () => {
    const h = await runSixStageJob();
    expect(h.outcome?.state).toBe("completed");
    const instance = await h.stores.instances.getInstance("screen-4359");
    const units = instance?.stageCheckpoint?.units ?? [];
    expect(units).toHaveLength(6);
    for (const unit of units) {
      expect(unit.startedAt, `${unit.stage} started`).toBeTruthy();
      expect(unit.endedAt, `${unit.stage} ended`).toBeTruthy();
      expect(Date.parse(unit.endedAt!)).toBeGreaterThan(Date.parse(unit.startedAt!));
    }
  });
});

describe("4359-P02 the status view carries the recorded stamps", () => {
  it("shows start, end and a duration computed from them on every stage", async () => {
    const h = await runSixStageJob();
    expect(h.view.stages).toHaveLength(6);
    for (const stage of h.view.stages) {
      expect(stage.startedAt, `${stage.kind} start`).toBeTruthy();
      expect(stage.endedAt, `${stage.kind} end`).toBeTruthy();
      expect(stage.durationMs).toBe(Date.parse(stage.endedAt!) - Date.parse(stage.startedAt!));
      expect(stage.units).toHaveLength(1);
      expect(stage.units[0].startedAt).toBeTruthy();
      expect(stage.units[0].endedAt).toBeTruthy();
    }
  });
});

describe("4359-P03 one projection into the Workflow Runs stage shape", () => {
  it("maps six views to six engine-recorded stages in definition order", async () => {
    const h = await runSixStageJob();
    const stages = stagesFromEngineViews(h.view.stages);
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.stage)).toEqual([...SIX_STAGES]);
    expect(stages.every((s) => s.recordedBy === "engine-checkpoint")).toBe(true);
    expect(stages.every((s) => s.status === "completed")).toBe(true);
    expect(stages[0].startedAt).toBe(h.view.stages[0].startedAt);
    expect(stages[0].finishedAt).toBe(h.view.stages[0].endedAt);
    expect(stages[0].durationMs).toBe(h.view.stages[0].durationMs);
  });

  it("orders the rows and numbers them from one", async () => {
    const h = await runSixStageJob();
    const stages = stagesFromEngineViews(h.view.stages);
    expect(stages.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("4359-P04 a grouped run prefers the engine's stages", () => {
  it("counts six stages instead of the one job row", async () => {
    const h = await runSixStageJob();
    const withEngine = runFromJobs([jobRow()], [], undefined, T0, h.view.stages);
    expect(withEngine.stageCount).toBe(6);
    expect(withEngine.completedStages).toBe(6);
    expect(withEngine.stages.map((s) => s.recordedBy)).toEqual(Array(6).fill("engine-checkpoint"));
  });

  it("keeps today's job-row projection when the engine has no stages", async () => {
    const withoutEngine = runFromJobs([jobRow()], [], undefined, T0);
    expect(withoutEngine.stageCount).toBe(1);
    expect(withoutEngine.stages[0].recordedBy).toBe("job");
  });

  it("reads the stages by any job id in the group", async () => {
    const h = await runSixStageJob();
    const engineStages = new Map<string, JobStageView[]>([["screen-4359", h.view.stages]]);
    const page = buildWorkflowRunsPage({
      jobs: [jobRow({ parent_job_id: "wrapper-1" }), jobRow({ job_id: "wrapper-1", job_kind: "main" })],
      outcomes: [],
      transitions: [],
      limit: 10,
      offset: 0,
      includeTraces: false,
      nowMs: T0,
      extraRuns: [],
      engineStages,
    } as never);
    const run = page.runs.find((r) => r.stages.some((s) => s.recordedBy === "engine-checkpoint"));
    expect(run).toBeTruthy();
    expect(run!.stageCount).toBe(6);
  });
});

describe("4359-P05 a standalone D1 record renders the engine's stages", () => {
  const record = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screen-4359",
    operation: "feed",
    started: new Date(T0).toISOString(),
    finished: new Date(T0 + 60_000).toISOString(),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "run-1",
    asyncJobId: "screen-4359",
  });

  it("counts and carries them", async () => {
    const h = await runSixStageJob();
    const run = runFromJobRunRecord(record, h.view.stages);
    expect(run.stageCount).toBe(6);
    expect(run.completedStages).toBe(6);
    expect(run.stages[0].recordedBy).toBe("engine-checkpoint");
  });

  it("stays an honest empty list without stages", () => {
    const run = runFromJobRunRecord(record);
    expect(run.stageCount).toBe(0);
    expect(run.stages).toEqual([]);
  });
});

describe("4359-P06 the runs read asks the job-status surface", () => {
  function sqlDouble() {
    return {
      exec: () => [],
    } as never;
  }

  const record = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screen-4359",
    operation: "feed",
    started: new Date(T0).toISOString(),
    finished: new Date(T0 + 60_000).toISOString(),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "run-1",
    asyncJobId: "screen-4359",
  });

  it("projects the six stages onto the run", async () => {
    const h = await runSixStageJob();
    const asked: string[][] = [];
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async (jobIds: string[]) => {
          asked.push(jobIds);
          return new Map([["screen-4359", { stages: h.view.stages, checkpointRunId: "run-1" }]]);
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    expect(asked.flat()).toContain("screen-4359");
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.workflow === "Other" || r.id);
    expect(run).toBeTruthy();
    expect(run.stageCount).toBe(6);
  });

  it("renders the row with an empty stage list when no checkpoint is returned", async () => {
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () => new Map(),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.length).toBeGreaterThan(0);
    expect(data.runs.every((r: any) => Array.isArray(r.stages))).toBe(true);
  });

  it("names a failing stage read in storeErrors and still renders", async () => {
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () => {
          throw new Error("stage read unavailable");
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.jobStages).toContain("stage read unavailable");
  });
});

describe("4359-P07 another run's checkpoint is never projected", () => {
  it("drops stages whose checkpoint belongs to a different run", async () => {
    const h = await runSixStageJob();
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: "screen-4359",
      operation: "feed",
      started: new Date(T0).toISOString(),
      finished: new Date(T0 + 60_000).toISOString(),
      outcome: "success",
      triggeredBy: "manual",
      workflowId: "run-1",
      asyncJobId: "screen-4359",
    });
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => ({ exec: () => [] }) as never,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () =>
          new Map([["screen-4359", { stages: h.view.stages, checkpointRunId: "run-OTHER" }]]),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.every((r: any) => r.stageCount === 0)).toBe(true);
  });
});
