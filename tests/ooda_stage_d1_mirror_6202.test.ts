// @vitest-environment node
/**
 * Issue #6202 — the D1 mirror of the stage rows.
 *
 * Pins:
 *  - 6202-P01 the D1 store implements the same port: `record` upserts on
 *    (run_id, stage_id) through migration 0083's table, and `listByRun`
 *    returns the identical record shape;
 *  - 6202-P02 the migration is the table's single declaration: it creates
 *    `job_stage_events` with the DO column set plus `tenant_id`, and the
 *    unique `(run_id, stage_id)` index the upsert targets;
 *  - 6202-P03 the engine mirrors every DO row best-effort — a mirror failure
 *    is logged, never fatal to the run;
 *  - 6202-P04 a read served from D1 alone answers the same stage shape when
 *    the DO has nothing for the run.
 */
import { describe, expect, it } from "vitest";
import {
  createD1JobStageEventStore,
  ensureJobStageEventsSchema,
  createD1JobStageEventDb,
} from "../src/data/d1JobStageEventAdapter";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { createInMemoryJobStageEventStore } from "../src/data/inMemoryJobStageEventAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { readResearchStages } from "../src/workflows/researchScreenEngine";
import type { JobExecutionMode } from "../src/data/jobPipelinePorts";
import { MockD1Database } from "./mock-d1";

const MODE: JobExecutionMode = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "sync",
  shape: "monolith",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    eventKey: "r-1:job:0:terminal",
    claimKey: "r-1::job:0",
    runId: "r-1",
    jobId: "research:r-1",
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
    resultRef: "research/r-1/feed",
    definitionVersion: 1,
    ...overrides,
  };
}

describe("6202-P01 the D1 store implements the same port", () => {
  it("round-trips a row and upserts rather than duplicating", async () => {
    const d1 = new MockD1Database();
    const store = createD1JobStageEventStore(d1 as never);
    expect(await store.record(row())).toBe(true);
    // The same (run_id, stage_id) again is an update, not a second row.
    expect(await store.record(row({ stageStatus: "failed", failedUnitCount: 1 }))).toBe(true);

    const rows = await store.listByRun("r-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "r-1",
      jobId: "research:r-1",
      stageId: "feed",
      action: "terminal",
      stageStatus: "failed",
      durationMs: 5000,
      unitCount: 1,
      failedUnitCount: 1,
      resultRef: "research/r-1/feed",
      definitionVersion: 1,
    });
    // A different run is not returned.
    expect(await store.listByRun("r-other")).toEqual([]);
  });
});

describe("6202-P02 the migration is the table's single declaration", () => {
  it("creates the DO column set plus tenant_id, and the unique stage index", async () => {
    const d1 = new MockD1Database();
    const db = createD1JobStageEventDb(d1 as never);
    await ensureJobStageEventsSchema(db);
    // A second ensure is a no-op (the migration marker decides).
    await ensureJobStageEventsSchema(db);

    const columns = d1.sqlite
      .prepare("PRAGMA table_info(job_stage_events)")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    for (const column of [
      "event_key",
      "claim_key",
      "run_id",
      "job_id",
      "stage_id",
      "unit_id",
      "action",
      "at",
      "started_at",
      "ended_at",
      "detail",
      "stage_status",
      "duration_ms",
      "unit_count",
      "failed_unit_count",
      "result_ref",
      "definition_version",
      "tenant_id",
    ]) {
      expect(names).toContain(column);
    }

    const indexes = d1.sqlite
      .prepare("PRAGMA index_list(job_stage_events)")
      .all() as Array<{ name: string; unique: number }>;
    const stageIdx = indexes.find((i) => i.name === "job_stage_events_run_stage_idx");
    expect(stageIdx).toBeDefined();
    expect(stageIdx!.unique).toBe(1);
  });
});

describe("6202-P03 the engine mirrors every DO row", () => {
  it("writes the same rows to the D1 mirror", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const stageEvents = createInMemoryJobStageEventStore();
    const d1 = new MockD1Database();
    const steps = new JobStepRegistry();
    steps.register("ok", async () => ({ output: { v: 1 }, descriptor: "result/ok" }));
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps,
      invocation: "sync",
      newRunId: () => "r-6202",
      stageEvents,
      stageEventsMirror: createD1JobStageEventStore(d1 as never),
    });
    await control.defineJob({
      jobId: "research:r-6202",
      name: "mirror",
      root: {
        kind: "research",
        executionMode: MODE,
        children: [
          { kind: "feed", steps: [{ step: "ok" }] },
          { kind: "enrich", steps: [{ step: "ok" }] },
        ],
      },
    });
    await control.runJob("research:r-6202", { trigger: "manual" });

    const mirrored = await createD1JobStageEventStore(d1 as never).listByRun("r-6202");
    expect(mirrored.map((r) => r.stageId).sort()).toEqual(["enrich", "feed"]);
    expect(mirrored.every((r) => r.action === "terminal")).toBe(true);
    expect((await stageEvents.listByRun("r-6202")).length).toBe(2);
  });

  it("logs a mirror failure and still leaves the DO rows", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const stageEvents = createInMemoryJobStageEventStore();
    const steps = new JobStepRegistry();
    steps.register("ok", async () => ({ output: { v: 1 } }));
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps,
      invocation: "sync",
      newRunId: () => "r-6202b",
      stageEvents,
      stageEventsMirror: {
        record: async () => {
          throw new Error("d1 down");
        },
        listByRun: async () => [],
      },
    });
    await control.defineJob({
      jobId: "research:r-6202b",
      name: "mirror-fail",
      root: {
        kind: "research",
        executionMode: MODE,
        children: [{ kind: "feed", steps: [{ step: "ok" }] }],
      },
    });
    const settled = await control.runJob("research:r-6202b", { trigger: "manual" });
    expect(settled.runId).toBe("r-6202b");
    expect((await stageEvents.listByRun("r-6202b")).length).toBe(1);
  });
});

describe("6202-P04 a D1-only read answers the same shape", () => {
  it("falls back to the mirror when the DO has nothing for the run", async () => {
    const d1 = new MockD1Database();
    await createD1JobStageEventStore(d1 as never).record(
      row({ runId: "r-d1", eventKey: "r-d1:job:0:terminal", claimKey: "r-d1::job:0", resultRef: "research/r-d1/feed" }),
    );
    const read = await readResearchStages({
      runId: "r-d1",
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      d1: d1 as never,
    });
    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.durationMs).toBe(5000);
    expect(feed.result).toEqual({ descriptor: "research/r-d1/feed" });
    expect(read.stages.find((stage) => stage.stageId === "deliver")!.resultReason).toBe("not_run");
  });
});
