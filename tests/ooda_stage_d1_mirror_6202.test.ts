// @vitest-environment node
/**
 * Issue #6202 — the D1 mirror of the stage rows.
 *
 * Pins:
 *  - 6202-P01 the D1 store implements the same port: `record` upserts on
 *    (run_id, stage_id), `listByRun` returns the identical record shape;
 *  - 6202-P02 both DDL statements come from the catalogue by code (no
 *    literals in the adapter);
 *  - 6202-P03 the engine mirrors every DO row best-effort — a mirror failure
 *    is logged, never fatal to the run;
 *  - 6202-P04 a read served from D1 alone answers the same stage shape when
 *    the DO has nothing for the run.
 */
import { describe, expect, it, vi } from "vitest";
import { createD1JobStageEventStore } from "../src/data/d1JobStageEventAdapter";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { createInMemoryJobStageEventStore } from "../src/data/inMemoryJobStageEventAdapter";
import { d1StatementSql } from "../src/data/schemaComponent/d1Catalogue";
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

interface FakeD1 {
  prepare(statement: string): {
    bind(...args: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> };
    run(): Promise<unknown>;
    all<T>(): Promise<{ results: T[] }>;
  };
}

/** The smallest D1 double: records statements and optional rows. */
function fakeD1(rows: Array<Record<string, unknown>> = []): { d1: FakeD1; statements: string[] } {
  const statements: string[] = [];
  const d1: FakeD1 = {
    prepare(statement: string) {
      statements.push(statement);
      const answer = async () => ({ results: rows });
      const bound = {
        run: async () => ({ meta: { changes: 1 } }),
        all: answer,
      };
      return {
        ...bound,
        bind: (...args: unknown[]) => {
          // Keep the bound values visible for the assertion that the write
          // carries the row's own fields, never a placeholder.
          (d1 as unknown as { lastBind?: unknown[] }).lastBind = args;
          return bound;
        },
      };
    },
  };
  return { d1, statements };
}

describe("6202-P01/P02 the D1 store implements the same port", () => {
  it("upserts on (run_id, stage_id) with the row's own fields", async () => {
    const { d1, statements } = fakeD1();
    const store = createD1JobStageEventStore(d1 as unknown as D1Database);
    await store.record({
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
    });
    expect(statements[0]).toBe(d1StatementSql("schema.d1.job_stage_events.create_table"));
    expect(statements[1]).toBe(
      d1StatementSql("schema.d1.job_stage_events.create_index_job_stage_events_run_stage_idx"),
    );
    const insert = statements[2];
    expect(insert).toContain("ON CONFLICT(run_id, stage_id) DO UPDATE");
    const bind = (d1 as unknown as { lastBind: unknown[] }).lastBind;
    expect(bind).toEqual([
      "r-1:job:0:terminal",
      "r-1::job:0",
      "r-1",
      "research:r-1",
      "feed",
      null,
      "terminal",
      "2026-11-22T00:00:05.000Z",
      "2026-11-22T00:00:00.000Z",
      "2026-11-22T00:00:05.000Z",
      null,
      "completed",
      5000,
      1,
      0,
      "research/r-1/feed",
      1,
      null,
    ]);
  });

  it("reads the same record shape back", async () => {
    const { d1 } = fakeD1([
      {
        event_key: "r-1:job:0:terminal",
        claim_key: "r-1::job:0",
        run_id: "r-1",
        job_id: "research:r-1",
        stage_id: "feed",
        unit_id: null,
        action: "terminal",
        at: "2026-11-22T00:00:05.000Z",
        started_at: "2026-11-22T00:00:00.000Z",
        ended_at: "2026-11-22T00:00:05.000Z",
        detail: "boom",
        stage_status: "failed",
        duration_ms: 5000,
        unit_count: 2,
        failed_unit_count: 1,
        result_ref: null,
        definition_version: 3,
      },
    ]);
    const rows = await createD1JobStageEventStore(d1 as unknown as D1Database).listByRun("r-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "r-1",
      stageId: "feed",
      action: "terminal",
      stageStatus: "failed",
      durationMs: 5000,
      unitCount: 2,
      failedUnitCount: 1,
      resultRef: null,
      definitionVersion: 3,
      detail: "boom",
    });
  });
});

describe("6202-P03 the engine mirrors every DO row", () => {
  it("writes the same rows to the mirror, and a mirror failure never fails the run", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const stageEvents = createInMemoryJobStageEventStore();
    const mirrored: string[] = [];
    const mirror = {
      record: async (row: { stageId: string }) => {
        mirrored.push(row.stageId);
        return true;
      },
      listByRun: async () => [],
    };
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
      stageEventsMirror: mirror,
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
    expect(mirrored.sort()).toEqual(["enrich", "feed"]);
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
    const { d1 } = fakeD1([
      {
        event_key: "r-d1:job:0:terminal",
        claim_key: "r-d1::job:0",
        run_id: "r-d1",
        job_id: "research:r-d1",
        stage_id: "feed",
        unit_id: null,
        action: "terminal",
        at: "2026-11-22T00:00:05.000Z",
        started_at: "2026-11-22T00:00:00.000Z",
        ended_at: "2026-11-22T00:00:05.000Z",
        detail: null,
        stage_status: "completed",
        duration_ms: 5000,
        unit_count: 1,
        failed_unit_count: 0,
        result_ref: "research/r-d1/feed",
        definition_version: 1,
      },
    ]);
    const read = await readResearchStages({
      runId: "r-d1",
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      d1: d1 as unknown as D1Database,
    });
    const feed = read.stages.find((stage) => stage.stageId === "feed")!;
    expect(feed.status).toBe("completed");
    expect(feed.durationMs).toBe(5000);
    expect(feed.result).toEqual({ descriptor: "research/r-d1/feed" });
    expect(read.stages.find((stage) => stage.stageId === "deliver")!.resultReason).toBe("not_run");
  });
});
