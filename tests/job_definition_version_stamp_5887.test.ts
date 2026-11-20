// @vitest-environment node
/**
 * Issue #5887 — the definition-version stamp that makes replay resolvable.
 *
 * Pins:
 *  - 5887-P01 a run's terminal record carries the definition version it
 *    executed;
 *  - 5887-P02 a later reconfigure starts a new version for the NEXT run and
 *    leaves the earlier run's record untouched;
 *  - 5887-P03 a row written before the column reads null (pre-retention),
 *    never a guessed number;
 *  - 5887-P04 the builder refuses a version that is not a non-negative
 *    integer — the stamp is a fact, not free text;
 *  - 5887-P05 the two D1 migrations carry one ALTER each, each in the
 *    migration its own store applies.
 */
import { describe, it, expect } from "vitest";
import { buildJobRunRecord, normalizeJobRunRecord } from "../src/services/jobRunRecords";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";

function makeHarness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (_ctx: JobStepContext) => ({ output: { tracked: true } }));
  let tick = 0;
  let runCounter = 0;
  const base = Date.parse("2026-11-20T12:00:00.000Z");
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: {
      publish: async () => {},
      subscribe: () => () => {},
    } as never,
    steps,
    now: () => new Date(base + tick++ * 1000),
    newRunId: () => `run-${++runCounter}`,
  };
  return { control: createJobPipelineControl(deps), stores, runStore };
}

const JOB = {
  jobId: "stamp-job",
  name: "Stamp job",
  root: {
    kind: "track",
    steps: [{ step: "track", params: {} }],
    executionMode: { delivery: "sync" },
  },
};

describe("5887-P01 a run records the definition version it executed", () => {
  it("stamps definitionVersion on the terminal record", async () => {
    const { control, runStore } = makeHarness();
    const definition = await control.defineJob(JOB);
    expect(definition.version).toBe(1);
    await control.runJob(JOB.jobId);

    const record = runStore.listByJob(JOB.jobId, 1)[0];
    expect(record.definitionVersion).toBe(1);
  });
});

describe("5887-P02 a reconfigure stamps the next run, not the past one", () => {
  it("keeps run 1 at v1 and stamps run 2 at v2", async () => {
    const { control, runStore } = makeHarness();
    await control.defineJob(JOB);
    await control.runJob(JOB.jobId);

    await control.configureJob(JOB.jobId, { name: "Stamp job (renamed)" });
    await control.runJob(JOB.jobId);

    const [newest, oldest] = runStore.listByJob(JOB.jobId, 2);
    expect(newest.definitionVersion).toBe(2);
    expect(oldest.definitionVersion).toBe(1);
  });
});

describe("5887-P03 a pre-retention row reads null, never a guess", () => {
  it("normalizes a missing version to null", () => {
    const legacy = buildJobRunRecord({
      system: "job-pipeline",
      jobId: "stamp-job",
      operation: "job",
      started: "2026-11-20T12:00:00.000Z",
      finished: "2026-11-20T12:00:01.000Z",
      outcome: "success",
      triggeredBy: "manual",
    });
    expect(legacy.definitionVersion).toBeNull();
    expect(normalizeJobRunRecord(legacy).definitionVersion).toBeNull();
    // A poisoned stored value is null too, not a number.
    expect(
      normalizeJobRunRecord({ ...legacy, definitionVersion: -3 as never }).definitionVersion,
    ).toBeNull();
  });
});

describe("5887-P04 the builder refuses a non-integer version", () => {
  it("throws rather than storing a guessed stamp", () => {
    expect(() =>
      buildJobRunRecord({
        system: "job-pipeline",
        jobId: "stamp-job",
        operation: "job",
        started: "2026-11-20T12:00:00.000Z",
        finished: "2026-11-20T12:00:01.000Z",
        outcome: "success",
        triggeredBy: "manual",
        definitionVersion: 1.5,
      }),
    ).toThrow(/definitionVersion/);
  });
});

describe("5887-P05 each store's migration carries its own ALTER", () => {
  it("0075 stamps the instance, 0076 the run record", () => {
    const instanceSql = d1MigrationSql(75);
    expect(instanceSql).toContain("ALTER TABLE job_pipeline_instances ADD COLUMN run_definition_version INTEGER");
    expect(instanceSql).not.toContain("job_run_records");

    const runSql = d1MigrationSql(76);
    expect(runSql).toContain("ALTER TABLE job_run_records ADD COLUMN definition_version INTEGER");
    expect(runSql).not.toContain("job_pipeline_instances");
  });
});
