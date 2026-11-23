// @vitest-environment node
/**
 * Issue #6355 — the stage read surfaces the step output's status
 * (`not_configured` vs real) and the unit attempt count, so a future
 * no-op can never again read as a healthy 0 ms completion.
 *
 * Pins:
 *  - 6355-P01 a stage whose step returned { status: "not_configured" }
 *    reads stepStatus "not_configured";
 *  - 6355-P02 a stage whose step returned a real output (no status
 *    field) reads stepStatus null — never a fabricated status;
 *  - 6355-P03 the live read carries the unit attempt count (1 on a
 *    first attempt);
 *  - 6355-P04 the persisted-rows fallback (checkpoint gone) reads
 *    stepStatus null and attempt null — the terminal rows carry
 *    neither, so both stay honestly absent.
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

const RUN = "r-6355";

async function runOnce() {
  const stores = createInMemoryJobPipelineStores();
  const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
  const stageEvents = createInMemoryJobStageEventStore();
  const steps = new JobStepRegistry();
  steps.register("notcfg", async () => ({
    output: { stage: "feed", runId: RUN, status: "not_configured" },
    descriptor: `research/${RUN}/feed`,
  }));
  steps.register("real", async () => ({
    output: { runId: RUN, quotesRetrieved: 3, universeSize: 3 },
    descriptor: `research/${RUN}/enrich (3 symbols)`,
  }));
  steps.register("bare", async () => ({ output: { value: 2 } }));
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
    name: "OODA (6355 fixture)",
    root: {
      kind: "research",
      executionMode: MODE,
      children: [
        { kind: "feed", steps: [{ step: "notcfg" }] },
        { kind: "enrich", steps: [{ step: "real" }] },
        { kind: "analyze", steps: [{ step: "bare" }] },
        { kind: "generate", steps: [{ step: "bare" }] },
        { kind: "deliver", steps: [{ step: "bare" }] },
        { kind: "evaluate", steps: [{ step: "bare" }] },
      ],
    },
  });
  await control.runJob(`research:${RUN}`, { trigger: "manual" });
  return { stores, runRecorder, stageEvents };
}

describe("6355 the stage read surfaces the step status and the attempt count", () => {
  it("P01/P02/P03 — live: not_configured is named, real outputs carry no status, attempt is 1", async () => {
    const { stores, runRecorder } = await runOnce();
    const read = await readResearchStages({ runId: RUN, stores, runRecorder });

    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.stepStatus).toBe("not_configured");
    expect(feed.attempt).toBe(1);

    const enrich = read.stages.find((stage) => stage.stageId === "enrich")!;
    expect(enrich.status).toBe("completed");
    expect(enrich.stepStatus).toBeNull();
    expect(enrich.attempt).toBe(1);

    const analyze = read.stages.find((stage) => stage.stageId === "analyze")!;
    expect(analyze.status).toBe("completed");
    expect(analyze.result).toBeNull();
    expect(analyze.resultReason).toBe("no_artifact");
    expect(analyze.stepStatus).toBeNull();
    expect(analyze.attempt).toBe(1);
  });

  it("P04 — the persisted rows serve neither, so both stay null", async () => {
    const { stageEvents } = await runOnce();
    // A second, empty store set: the checkpoint (and its artifacts) are
    // gone, the ledger is not.
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(
      new InMemoryJobRunRecordStore(),
    );
    const rows = await stageEvents.listByRun(RUN);

    const read = await readResearchStages({
      runId: RUN,
      stores,
      runRecorder,
      sql: fakeSql(rows) as never,
    });
    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.result).toEqual({ descriptor: `research/${RUN}/feed` });
    expect(feed.stepStatus).toBeNull();
    expect(feed.attempt).toBeNull();
  });
});

/**
 * The smallest SqlStorage double the stage store needs: catalogue DDL is
 * accepted and ignored, `PRAGMA table_info` reports the full column set, and
 * the run read answers the given rows.
 */
function fakeSql(
  rows: Awaited<
    ReturnType<ReturnType<typeof createInMemoryJobStageEventStore>["listByRun"]>
  >,
) {
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
