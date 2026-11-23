// @vitest-environment node
/**
 * Issue #6034 — the one stage read answers "what did this stage do, how long
 * did it take, and what did it produce", live and after the fact.
 *
 * Pins:
 *  - 6034-P01 a stage that produced a descriptor returns `result.descriptor`
 *    (the step's own reference) and no reason;
 *  - 6034-P02 a stage that ran without producing one returns `result: null`
 *    with `resultReason: "no_artifact"` — never a fabricated summary;
 *  - 6034-P03 a stage that never ran returns `result: null` with
 *    `resultReason: "not_run"`, and still appears in the six-stage list;
 *  - 6034-P04 the row carries the unit counts and the recorded duration;
 *  - 6034-P05 the same shape is served from the persisted rows when the
 *    checkpoint is gone (the #6028 fallback), including the result.
 */
import { describe, expect, it } from "vitest";
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

const MODE: JobExecutionMode = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "sync",
  shape: "monolith",
};

const RUN = "r-6034";

async function runOnce() {
  const stores = createInMemoryJobPipelineStores();
  const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
  const stageEvents = createInMemoryJobStageEventStore();
  const steps = new JobStepRegistry();
  steps.register("ok", async () => ({ output: { value: 1 }, descriptor: `research/${RUN}/feed` }));
  steps.register("bare", async () => ({ output: { value: 2 } }));
  steps.register("boom", async () => {
    throw new Error("analyze exploded");
  });
  const control = new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps,
    invocation: "sync",
    newRunId: () => RUN,
    stageEvents,
  });
  await control.defineJob({
    jobId: `research:${RUN}`,
    name: "OODA (6034 fixture)",
    root: {
      kind: "research",
      executionMode: MODE,
      children: [
        { kind: "feed", steps: [{ step: "ok" }] },
        { kind: "enrich", steps: [{ step: "bare" }] },
        { kind: "analyze", steps: [{ step: "boom" }] },
        { kind: "generate", steps: [{ step: "bare" }] },
        { kind: "deliver", steps: [{ step: "bare" }] },
        { kind: "evaluate", steps: [{ step: "bare" }] },
      ],
    },
  });
  await control.runJob(`research:${RUN}`, { trigger: "manual" });
  return { stores, runRecorder, stageEvents };
}

describe("6034 the stage read answers with a result and a coded reason", () => {
  it("P01/P02/P03/P04 — live: descriptor, no_artifact, not_run, counts and duration", async () => {
    const { stores, runRecorder } = await runOnce();
    const read = await readResearchStages({ runId: RUN, stores, runRecorder });

    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.result).toEqual({ descriptor: `research/${RUN}/feed` });
    expect(feed.resultReason).toBeUndefined();
    expect(feed.unitCount).toBe(1);
    expect(feed.failedUnitCount).toBe(0);
    // The recorded window is the stage's own; a millisecond value, never negative.
    expect(typeof feed.durationMs).toBe("number");
    expect(feed.durationMs!).toBeGreaterThanOrEqual(0);

    const enrich = read.stages.find((stage) => stage.stageId === "enrich")!;
    expect(enrich.status).toBe("completed");
    expect(enrich.result).toBeNull();
    expect(enrich.resultReason).toBe("no_artifact");

    const analyze = read.stages.find((stage) => stage.stageId === "analyze")!;
    expect(analyze.status).toBe("failed");
    expect(analyze.failedUnitCount).toBe(1);
    expect(analyze.result).toBeNull();
    expect(analyze.resultReason).toBe("no_artifact");
  });

  it("P03 — a stage the run never reached is reported, not dropped", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const read = await readResearchStages({ runId: "r-unknown", stores, runRecorder });
    expect(read.stages).toHaveLength(6);
    for (const stage of read.stages) {
      expect(stage.status).toBe("pending");
      expect(stage.result).toBeNull();
      expect(stage.resultReason).toBe("not_run");
      expect(stage.unitCount).toBe(0);
    }
  });

  it("P05 — the persisted rows serve the same shape after the checkpoint is gone", async () => {
    const { stageEvents } = await runOnce();
    // A second, empty store set: the checkpoint is gone, the ledger is not.
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const rows = await stageEvents.listByRun(RUN);
    const feedRow = rows.find((row) => row.stageId === "feed")!;
    expect(feedRow.resultRef).toBe(`research/${RUN}/feed`);

    // Re-use the persisted rows through a store whose listByRun answers them.
    const read = await readResearchStages({
      runId: RUN,
      stores,
      runRecorder,
      sql: fakeSql(rows) as never,
    });
    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.result).toEqual({ descriptor: `research/${RUN}/feed` });
    expect(feed.unitCount).toBe(1);
  });
});

/**
 * The smallest SqlStorage double the stage store needs: catalogue DDL is
 * accepted and ignored, `PRAGMA table_info` reports the full column set, and
 * the run read answers the given rows.
 */
function fakeSql(rows: Awaited<ReturnType<ReturnType<typeof createInMemoryJobStageEventStore>["listByRun"]>>) {
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
