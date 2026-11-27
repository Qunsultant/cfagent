// @vitest-environment node
/**
 * Issue #6557 — run provenance on the record: schedule-payload source,
 * instance carrier, D1 columns.
 *
 * The run record has carried `brokerId`, `dataProviderId`, `mode` and
 * `modeSource` since #3655, and the engine never had values to fill them:
 * the payload that fired a scheduled run never reached the engine's own
 * record. The carrier is the instance (the settle path can be a different
 * process), the source is the firing schedule payload ONLY (owner decision
 * 2026-11-25), and D1 gains the columns so both residencies agree.
 *
 * Pins:
 *  - 6557-P01 a dispatch carrying payload provenance records all four facts;
 *  - 6557-P02 a dispatch without it records explicit nulls, never a guess;
 *  - 6557-P03 a retry records nulls — it never inherits the run it retried;
 *  - 6557-P04 a resume keeps the run's own provenance (same run, same fact);
 *  - 6557-P05 the payload parser: all four, a partial payload (explicit
 *    nulls), none (null carrier), malformed;
 *  - 6557-P06 the two migrations: 0090 touches the instance, 0091 the
 *    record, one store each (the 0075/0076 split);
 *  - 6557-P07 the D1 record adapter carries all four on both the read and
 *    the write path (the defect this closes: "D1 has no columns for it"),
 *    and the DO record adapter keeps them;
 *  - 6557-P08 the schedule callback forwards the payload carrier to the
 *    door (wiring pin — the DO harness is not available in a unit run).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { parseRunProvenance, type JobRunProvenance } from "../src/data/jobPipelinePorts";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";
import { payloadRunProvenance } from "../src/agents/orchestrator/scheduleCallbackRunRecords";

const JOB_ID = "provenance-job";

const PROVENANCE: JobRunProvenance = {
  brokerId: "etrade",
  dataProviderId: "etrade",
  mode: "paper",
  modeSource: "pin",
};

interface Harness {
  control: JobPipelineControl;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  runStore: InMemoryJobRunRecordStore;
}

function makeHarness(): Harness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const steps = createBuiltinStepRegistry();
  steps.register("track", async () => ({ output: { tracked: true } }));
  let runCounter = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
  });
  return { control, stores, runStore };
}

const JOB = {
  jobId: JOB_ID,
  name: "Provenance job",
  root: {
    kind: "track",
    steps: [{ step: "track", params: {} }],
    executionMode: { delivery: "sync" as const },
  },
};

describe("6557-P01 a dispatch carrying payload provenance records all four facts", () => {
  it("stamps them on the instance and the terminal record", async () => {
    const h = makeHarness();
    await h.control.defineJob(JOB);
    await h.control.runJob(JOB_ID, { provenance: PROVENANCE });

    const record = h.runStore.listByJob(JOB_ID, 1)[0];
    expect(record.brokerId).toBe("etrade");
    expect(record.dataProviderId).toBe("etrade");
    expect(record.mode).toBe("paper");
    expect(record.modeSource).toBe("pin");

    // The instance is the durable carrier (the settle path can be another
    // process), and the in-memory adapter round-trips it as a fresh parse.
    const instance = await h.stores.instances.getInstance(JOB_ID);
    expect(instance?.runProvenance).toEqual(PROVENANCE);
  });
});

describe("6557-P02 a dispatch without payload provenance records nulls", () => {
  it("records explicit nulls, never an inferred value", async () => {
    const h = makeHarness();
    await h.control.defineJob(JOB);
    await h.control.runJob(JOB_ID);

    const record = h.runStore.listByJob(JOB_ID, 1)[0];
    expect(record.brokerId).toBeNull();
    expect(record.dataProviderId).toBeNull();
    expect(record.mode).toBeNull();
    expect(record.modeSource).toBeNull();
    const instance = await h.stores.instances.getInstance(JOB_ID);
    expect(instance?.runProvenance ?? null).toBeNull();
  });
});

describe("6557-P03 a retry never inherits the retried run's provenance", () => {
  it("records nulls on the new run", async () => {
    const h = makeHarness();
    await h.control.defineJob(JOB);
    await h.control.runJob(JOB_ID, { provenance: PROVENANCE });
    await h.control.retryJob(JOB_ID);

    const [newest, oldest] = h.runStore.listByJob(JOB_ID, 2);
    expect(oldest.modeSource).toBe("pin");
    expect(newest.modeSource).toBeNull();
    expect(newest.brokerId).toBeNull();
  });
});

describe("6557-P04 a resume keeps the run's own provenance", () => {
  it("carries the same facts onto the resumed run's settle", async () => {
    const h = makeHarness();
    // A paused instance with a checkpoint and its provenance already
    // stamped — what a paused scheduled run looks like on disk.
    await h.control.defineJob(JOB);
    const base = await h.stores.instances.getInstance(JOB_ID);
    await h.stores.instances.saveInstance({
      ...base!,
      state: "paused",
      currentRunId: "run-resume",
      runStartedAt: "2026-11-26T12:00:00.000Z",
      runTrigger: "scheduled",
      runKind: "original",
      runDefinitionVersion: 1,
      runProvenance: PROVENANCE,
      checkpoint: { runId: "run-resume", scopePath: "", unitStatuses: {} } as never,
    });

    const resumed = await h.control.resumeJob(JOB_ID);
    // The harness job is sync-delivery: resumeJob awaits the outcome.
    expect(resumed.state).toBe("completed");

    const record = h.runStore.listByJob(JOB_ID, 1)[0];
    expect(record.modeSource).toBe("pin");
    expect(record.brokerId).toBe("etrade");
  });
});

describe("6557-P05 the firing payload is the only source", () => {
  it("reads all four facts from a complete payload", () => {
    expect(
      payloadRunProvenance({
        jobId: "jobdef:x",
        brokerId: "etrade",
        dataProviderId: "etrade",
        mode: "paper",
        modeSource: "selection",
      }),
    ).toEqual({
      brokerId: "etrade",
      dataProviderId: "etrade",
      mode: "paper",
      modeSource: "selection",
    });
  });

  it("keeps an omitted fact null on an otherwise-stamped payload", () => {
    expect(payloadRunProvenance({ brokerId: "etrade", mode: "live" })).toEqual({
      brokerId: "etrade",
      dataProviderId: null,
      mode: "live",
      modeSource: null,
    });
  });

  it("returns null when the payload names none, and ignores unknown values", () => {
    expect(payloadRunProvenance({ jobId: "jobdef:x", userLogin: "a" })).toBeNull();
    expect(payloadRunProvenance(undefined)).toBeNull();
    expect(payloadRunProvenance("junk")).toBeNull();
    expect(
      payloadRunProvenance({ mode: "turbo", modeSource: "guess", brokerId: 7 }),
    ).toBeNull();
  });

  it("parses a stored carrier and fails closed on a malformed one", () => {
    expect(parseRunProvenance(JSON.stringify(PROVENANCE))).toEqual(PROVENANCE);
    expect(parseRunProvenance(null)).toBeNull();
    expect(parseRunProvenance("not json")).toBeNull();
    expect(parseRunProvenance('{"mode":"turbo","brokerId":7}')).toEqual({
      brokerId: null,
      dataProviderId: null,
      mode: null,
      modeSource: null,
    });
  });
});

describe("6557-P06 each store's migration carries its own ALTER", () => {
  it("0090 stamps the instance, 0091 the record", () => {
    const instanceSql = d1MigrationSql(90);
    expect(instanceSql).toContain(
      "ALTER TABLE job_pipeline_instances ADD COLUMN run_provenance_json TEXT",
    );
    expect(instanceSql).not.toContain("job_run_records");

    const recordSql = d1MigrationSql(91);
    expect(recordSql).toContain("ALTER TABLE job_run_records ADD COLUMN broker_id TEXT");
    expect(recordSql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN data_provider_id TEXT",
    );
    expect(recordSql).toContain("ALTER TABLE job_run_records ADD COLUMN mode TEXT");
    expect(recordSql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN mode_source TEXT",
    );
    expect(recordSql).not.toContain("job_pipeline_instances");
  });
});

describe("6557-P07 both record residencies carry the four facts", () => {
  const read = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8");

  it("the D1 adapter writes and reads all four (the defect: it had no columns)", () => {
    const source = read("src/data/d1JobRunRecordAdapter.ts");
    for (const field of ["brokerId", "dataProviderId", "mode", "modeSource"]) {
      // One write-path occurrence and one read-path occurrence at least.
      expect(source.split(`${field}: record.${field} ?? null`).length - 1).toBeGreaterThanOrEqual(1);
    }
    expect(source).toContain('row.brokerId != null ? { brokerId: row.brokerId }');
    expect(source).toContain('row.modeSource != null');
    expect(source).toContain("MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE");
  });

  it("the D1 adapter keeps its columns and the instance probe", () => {
    // Issue #6101 — the DO adapter is deleted; the provenance
    // columns live on the D1 writer now (migration 0091).
    const record = read("src/data/d1JobRunRecordAdapter.ts");
    expect(record).toContain("MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE");
    for (const mapping of [
      "brokerId: record.brokerId ?? null",
      "dataProviderId: record.dataProviderId ?? null",
      "mode: record.mode ?? null",
      "modeSource: record.modeSource ?? null",
    ]) {
      expect(record).toContain(mapping);
    }
    const pipeline = read("src/data/doSqliteJobPipelineAdapter.ts");
    expect(pipeline).toContain(
      'remainderAlterSql("job_pipeline_instances", "run_provenance_json")',
    );
  });
});

describe("6557-P08 the schedule callback forwards the payload carrier", () => {
  it("runPipelineJobSchedule parses the payload and passes it to the door", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/agents/orchestrator.ts"),
      "utf8",
    );
    const start = source.indexOf("async runPipelineJobSchedule");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 4000);
    expect(body).toContain("payloadRunProvenance(payload)");
    expect(body).toContain("provenance");
  });
});
