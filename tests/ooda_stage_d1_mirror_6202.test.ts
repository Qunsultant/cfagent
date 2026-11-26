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
 *  - 6202-P03 the engine writes every terminal row to the D1 writer
 *    best-effort — a writer failure is logged, never fatal to the run;
 *  - 6202-P04 a read served from D1 alone answers the same stage shape.
 * (#6101 step 7: the mirror IS the writer now — the DO leg and the
 * `stageEventsMirror` dep are deleted. P03's tests now drive the D1
 * writer directly; P04's test is unchanged, it already read D1 alone.)
 */
import { describe, expect, it, vi } from "vitest";
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
    // The same event again is a deduped no-op, not a second row.
    expect(await store.record(row())).toBe(false);
    // A newer publication of the same stage is an update, not a second row.
    expect(
      await store.record(
        row({ eventKey: "r-1:job:0:terminal:2", stageStatus: "failed", failedUnitCount: 1 }),
      ),
    ).toBe(true);

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

describe("6202-P03 the engine writes every terminal row to the D1 writer", () => {
  it("writes the same rows to the D1 writer", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
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
      stageEvents: createD1JobStageEventStore(d1 as never),
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

    const written = await createD1JobStageEventStore(d1 as never).listByRun("r-6202");
    expect(written.map((r) => r.stageId).sort()).toEqual(["enrich", "feed"]);
    expect(written.every((r) => r.action === "terminal")).toBe(true);
  });

  it("logs a writer failure and still settles the run", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const steps = new JobStepRegistry();
    steps.register("ok", async () => ({ output: { v: 1 } }));
    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps,
      invocation: "sync",
      newRunId: () => "r-6202b",
      stageEvents: {
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
    // #3515 S3 batch 7: the warn is a structured event on the
    // console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const settled = await control.runJob("research:r-6202b", { trigger: "manual" });
      expect(settled.runId).toBe("r-6202b");
      const failed = infoSpy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return null;
          }
        })
        .filter((e) => e !== null && e.operation === "jobPipeline.stage_row_write_failed");
      expect(failed.length).toBeGreaterThan(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("6202-P04 a D1-only read answers the same shape", () => {
  it("reads the D1 rows for the run", async () => {
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
