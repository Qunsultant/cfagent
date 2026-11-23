// @vitest-environment node
/**
 * Issue #6028 — one persisted terminal row per executed stage.
 *
 * Pins:
 *  - 6028-P10 the row builder: duration is `end − start` when both stamps
 *    exist and NULL when either is missing (never 0, never estimated);
 *  - 6028-P11 the status vocabulary is the engine's recorded status
 *    (`completed` / `failed` / `stopped`), a failed unit's error text rides
 *    the row's detail, and the unit counts are the stage's own;
 *  - 6028-P12 the result reference is the step's descriptor — joined in unit
 *    order, null when no unit produced one;
 *  - 6028-P13 the identity is `(runId, stageId)`: a re-write is an update at
 *    the store's UNIQUE event_key, not a second row;
 *  - 6028-P14 a settled run writes the rows through the engine's one
 *    terminal-recording point, and a stage that failed carries its error;
 *  - 6028-P15 a past run's stages are still readable once its checkpoint is
 *    gone — from the rows the engine wrote, not from a live derivation.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { createInMemoryJobStageEventStore } from "../src/data/inMemoryJobStageEventAdapter";
import type { JobStageEventRecord } from "../src/data/jobStageEventPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  stageTerminalRows,
  type JobInstanceRecord,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry, createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import type { JobDefinition, JobExecutionMode } from "../src/data/jobPipelinePorts";

const MODE: JobExecutionMode = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "sync",
  shape: "monolith",
};

function definition(): JobDefinition {
  return {
    jobId: "job-6028",
    name: "stage rows",
    root: {
      kind: "research",
      children: [
        { kind: "feed", steps: [{ step: "noop" }] },
        { kind: "analyze", steps: [{ step: "noop" }] },
      ],
    },
    rawConfig: {},
    config: {
      inputs: { sources: [], datasets: [], items: [] },
      processing: { inMemory: true, checkpointEverySteps: 1, shards: [] },
      outputs: { reports: [], formats: [], channels: [] },
      executionMode: MODE,
      schedule: { enabled: false },
    },
    version: 3,
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

function instance(units: Array<Record<string, unknown>>): JobInstanceRecord {
  return {
    jobId: "job-6028",
    state: "completed",
    desiredState: "none",
    currentRunId: "run-6028",
    runStartedAt: "2026-11-22T00:00:00.000Z",
    runTrigger: "manual",
    stageCheckpoint: { runId: "run-6028", units: units as never },
  } as JobInstanceRecord;
}

describe("6028-P10 the row builder keeps duration honest", () => {
  it("is the exact difference when both stamps exist", () => {
    const rows = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z", endedAt: "2026-11-22T00:00:01.500Z" },
      ]),
      at: "2026-11-22T00:00:02.000Z",
      definitionVersion: 3,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMs).toBe(1500);
  });

  it("is null — never 0 — when a stamp is missing", () => {
    const [noEnd] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z" },
      ]),
      at: "2026-11-22T00:00:02.000Z",
      definitionVersion: 3,
    });
    expect(noEnd.durationMs).toBeNull();
    expect(noEnd.startedAt).toBe("2026-11-22T00:00:00.000Z");
    expect(noEnd.endedAt).toBeNull();

    const [noStart] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, endedAt: "2026-11-22T00:00:01.000Z" },
      ]),
      at: "2026-11-22T00:00:02.000Z",
      definitionVersion: 3,
    });
    expect(noStart.durationMs).toBeNull();
  });
});

describe("6028-P11 the recorded status and counts ride the row", () => {
  it("a failed unit makes the stage failed and its error is the detail", () => {
    const [row] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:1", unitId: "u1", status: "completed", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z", endedAt: "2026-11-22T00:00:01.000Z" },
        { stage: "job:1", unitId: "u2", status: "failed", attempt: 2, error: "chain unavailable", startedAt: "2026-11-22T00:00:01.000Z", endedAt: "2026-11-22T00:00:02.000Z" },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(row.stageStatus).toBe("failed");
    expect(row.failedUnitCount).toBe(1);
    expect(row.unitCount).toBe(2);
    expect(row.detail).toBe("chain unavailable");
    expect(row.durationMs).toBe(2000);
  });

  it("a stopped unit makes the stage stopped, and every terminal unit completed", () => {
    const [stopped] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "stopped", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z" },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(stopped.stageStatus).toBe("stopped");

    const [completed] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z", endedAt: "2026-11-22T00:00:01.000Z" },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(completed.stageStatus).toBe("completed");
    expect(completed.failedUnitCount).toBe(0);
  });
});

describe("6028-P12 the result reference is the step's descriptor", () => {
  it("joins the units' descriptors in unit order", () => {
    const [row] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, resultRef: "research/run-6028/feed", startedAt: "2026-11-22T00:00:00.000Z", endedAt: "2026-11-22T00:00:01.000Z" },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(row.resultRef).toBe("research/run-6028/feed");
  });

  it("is null when no unit produced one — never a fabricated summary", () => {
    const [row] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1, startedAt: "2026-11-22T00:00:00.000Z", endedAt: "2026-11-22T00:00:01.000Z" },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(row.resultRef).toBeNull();
  });
});

describe("6028-P13 identity is (runId, stageId)", () => {
  it("names the addressable stage kind, keeps the engine id in the claim key", () => {
    const [row] = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:1", unitId: "u1", status: "completed", attempt: 1 },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(row.stageId).toBe("analyze");
    expect(row.claimKey).toBe("run-6028::job:1");
    expect(row.eventKey).toBe("run-6028:job:1:terminal");
  });

  it("writes once per stage when the same run settles twice", async () => {
    const store = createInMemoryJobStageEventStore();
    const rows = stageTerminalRows({
      runId: "run-6028",
      jobId: "job-6028",
      definition: definition(),
      instance: instance([
        { stage: "job:0", unitId: "u1", status: "completed", attempt: 1 },
      ]),
      at: "2026-11-22T00:00:03.000Z",
      definitionVersion: 3,
    });
    expect(await store.record(rows[0])).toBe(true);
    expect(await store.record(rows[0])).toBe(false);
    expect((await store.listByRun("run-6028")).length).toBe(1);
  });
});

describe("6028-P14 the engine writes the rows when a run settles", () => {
  it("writes one terminal row per executed stage, with the failure's error", async () => {
    const stores = createInMemoryJobPipelineStores();
    const store = createInMemoryJobStageEventStore();
    const steps = new JobStepRegistry();
    steps.register("ok", async () => ({ descriptor: "result/ok" }));
    steps.register("boom", async () => {
      throw new Error("analyze exploded");
    });
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      invocation: "sync",
      stageEvents: store,
    });
    await control.defineJob({
      jobId: "job-6028",
      name: "stage rows",
      root: {
        kind: "research",
        executionMode: MODE,
        children: [
          { kind: "feed", steps: [{ step: "ok" }] },
          { kind: "analyze", steps: [{ step: "boom" }] },
        ],
      },
    });
    const dispatch = await control.runJob("job-6028", { trigger: "manual" });
    const rows = (await store.listByRun(dispatch.runId)).filter((r) => r.action === "terminal");
    expect(rows.map((r) => r.stageId)).toEqual(["feed", "analyze"]);
    expect(rows[0].stageStatus).toBe("completed");
    expect(rows[0].resultRef).toBe("result/ok");
    expect(rows[1].stageStatus).toBe("failed");
    expect(rows[1].detail).toContain("analyze exploded");
    expect(rows[1].failedUnitCount).toBe(1);
    expect(rows[0].definitionVersion).toBe(1);
  });
});

describe("6028-P15 a past run's stages survive its checkpoint", () => {
  it("returns the persisted rows when the live view has none", async () => {
    const { readResearchStages } = await import("../src/workflows/researchScreenEngine");
    const rows: JobStageEventRecord[] = [
      {
        eventKey: "r-past:job:0:terminal",
        claimKey: "r-past::job:0",
        runId: "r-past",
        jobId: "research:r-past",
        stageId: "feed",
        unitId: null,
        action: "terminal",
        at: "2026-11-22T00:00:05.000Z",
        startedAt: "2026-11-22T00:00:00.000Z",
        endedAt: "2026-11-22T00:00:05.000Z",
        detail: null,
        stageStatus: "completed",
        durationMs: 5000,
        unitCount: 1,
        failedUnitCount: 0,
        resultRef: "research/r-past/feed",
        definitionVersion: 1,
      },
    ];
    const sql = fakeSql(rows);
    const read = await readResearchStages({
      runId: "r-past",
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      sql: sql as never,
    });
    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.durationMs).toBe(5000);
    expect(feed.startedAt).toBe("2026-11-22T00:00:00.000Z");
    expect(feed.endedAt).toBe("2026-11-22T00:00:05.000Z");
    // A stage with no persisted row is still pending, never invented.
    expect(read.stages.find((stage) => stage.stageId === "deliver")!.status).toBe("pending");
  });
});

/**
 * The smallest SqlStorage double the stage store needs: the catalogue's
 * CREATE/ALTER/INDEX statements are accepted and ignored, the two reads the
 * adapter issues (PRAGMA table_info + the run's rows) answer.
 */
function fakeSql(rows: JobStageEventRecord[]) {
  return {
    exec: (statement: string, ...params: unknown[]) => {
      const text = String(statement);
      if (text.startsWith("PRAGMA table_info")) {
        return [
          { name: "event_key" },
          { name: "claim_key" },
          { name: "run_id" },
          { name: "job_id" },
          { name: "stage_id" },
          { name: "unit_id" },
          { name: "action" },
          { name: "at" },
          { name: "started_at" },
          { name: "ended_at" },
          { name: "detail" },
          { name: "stage_status" },
          { name: "duration_ms" },
          { name: "unit_count" },
          { name: "failed_unit_count" },
          { name: "result_ref" },
          { name: "definition_version" },
        ];
      }
      if (text.includes("SELECT event_key")) {
        const runId = String(params[0] ?? "");
        return rows
          .filter((row) => row.runId === runId)
          .map((row) => ({
            event_key: row.eventKey,
            claim_key: row.claimKey,
            run_id: row.runId,
            job_id: row.jobId,
            stage_id: row.stageId,
            unit_id: row.unitId,
            action: row.action,
            at: row.at,
            started_at: row.startedAt,
            ended_at: row.endedAt,
            detail: row.detail,
            stage_status: row.stageStatus ?? null,
            duration_ms: row.durationMs ?? null,
            unit_count: row.unitCount ?? null,
            failed_unit_count: row.failedUnitCount ?? null,
            result_ref: row.resultRef ?? null,
            definition_version: row.definitionVersion ?? null,
          }));
      }
      return [];
    },
  };
}
