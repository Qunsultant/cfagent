// @vitest-environment node
/**
 * Issue #3967 — a poison run lands in the DLQ an operator already inspects.
 *
 * The engine retries a step's processing failure (`job_step_failed`) and
 * dead-letters a CODED error immediately — it can never succeed on a retry —
 * but "dead-letter" only meant "do not retry": the run was marked terminal
 * failed and nothing else happened. The operator had the failure, not the
 * material to act on it.
 *
 * The platform's dead-letter store already exists (#2000): an operator lists
 * un-replayed rows and re-drives them through the retry route. This slice
 * makes a poison run land there, without inventing a second DLQ:
 *
 *  - 3967-P01 a coded, non-retryable step failure lands ONE dead-letter row,
 *    naming the job, run, stage, unit and code;
 *  - 3967-P02 a retryable failure that exhausts its budget does NOT land one
 *    (it is retryable work, not poison — the retry route is its remedy);
 *  - 3967-P03 a host with no sink keeps exactly the old behaviour;
 *  - 3967-P04 a sink failure never changes the run's outcome (the record is
 *    evidence, not the failure);
 *  - 3967-P05 the landing maps to the store's insert shape: the job-pipeline
 *    source, the poison reason, no envelope (a run is not a queue message, so
 *    queue replay must not pretend to re-drive it).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPoisonLanding,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { poisonLandingToDeadLetter } from "../src/services/jobPipelineDeadLetter";

const JOB_ID = "poison-job";

function makeControl(opts: {
  landings?: JobPoisonLanding[];
  sink?: (landing: JobPoisonLanding) => Promise<void>;
  throwsWith?: { code: string; message: string };
  attempts?: number;
} = {}) {
  const stores = createInMemoryJobPipelineStores();
  const steps = createBuiltinStepRegistry();
  steps.register("boom", async () => {
    const error = opts.throwsWith ?? {
      code: "job_config_invalid",
      message: "the step names a shard that is not configured",
    };
    throw new JobPipelineError(error.code as never, error.message);
  });
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
    ...(opts.sink
      ? { deadLetterRun: opts.sink }
      : opts.landings
        ? {
            deadLetterRun: async (landing) => {
              opts.landings!.push(landing);
            },
          }
        : {}),
  });
  return { control, stores };
}

async function runPoisonJob(control: ReturnType<typeof makeControl>["control"]) {
  await control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      steps: [{ step: "boom" }],
      executionMode: { delivery: "sync" },
    },
  });
  return control.runJob(JOB_ID, { trigger: "manual" });
}

describe("3967-P01 a poison run lands one dead-letter row", () => {
  it("names the job, run, stage, unit and code", async () => {
    const landings: JobPoisonLanding[] = [];
    const h = makeControl({ landings });

    const dispatch = await runPoisonJob(h.control);

    expect(dispatch.state).toBe("failed");
    expect(landings).toHaveLength(1);
    expect(landings[0].jobId).toBe(JOB_ID);
    expect(landings[0].runId).toBe(dispatch.runId);
    expect(landings[0].stageId).toContain("job:");
    expect(landings[0].unitId).toBe(dispatch.runId);
    expect(landings[0].code).toBe("job_config_invalid");
    expect(landings[0].message).toContain("shard");
  });
});

describe("3967-P02 retryable work is not poisoned", () => {
  it("records nothing when a step's budget is exhausted", async () => {
    const landings: JobPoisonLanding[] = [];
    const h = makeControl({
      landings,
      throwsWith: { code: "job_step_failed", message: "upstream said try again" },
    });

    const dispatch = await runPoisonJob(h.control);

    expect(dispatch.state).toBe("failed");
    expect(landings).toEqual([]);
  });
});

describe("3967-P03 a host with no sink keeps the old behaviour", () => {
  it("fails the run with no sink and no throw beyond it", async () => {
    const h = makeControl({});

    const dispatch = await runPoisonJob(h.control);

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(JOB_ID)).instance?.lastError ?? "";
    expect(failed).toContain("shard");
  });
});

describe("3967-P04 a sink failure never changes the outcome", () => {
  it("keeps the run's own coded failure", async () => {
    const h = makeControl({
      sink: async () => {
        throw new Error("the DLQ store is down");
      },
    });

    const dispatch = await runPoisonJob(h.control);

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(JOB_ID)).instance?.lastError ?? "";
    expect(failed).toContain("shard");
    expect(failed).not.toContain("DLQ store");
  });
});

describe("3967-P05 the landing maps to the store's insert shape", () => {
  it("names the job-pipeline source and the poison reason, with no envelope", () => {
    const insert = poisonLandingToDeadLetter(
      {
        jobId: "options-chain:abc",
        runId: "run-1",
        nodePath: "feed",
        stageId: "job:feed",
        unitId: "AAPL",
        code: "job_shards_not_configured",
        message: "Stage \"feed\" names no shard keys.",
        at: "2026-11-26T12:00:00.000Z",
      },
      1_765_000_000_000,
    );

    expect(insert.queue).toBe("job-pipeline");
    expect(insert.reason).toBe("poison_run");
    expect(insert.runId).toBe("run-1");
    expect(insert.unitId).toBe("AAPL");
    expect(insert.detail).toContain("job=options-chain:abc");
    expect(insert.detail).toContain("stage=job:feed");
    expect(insert.detail).toContain("code=job_shards_not_configured");
    // A run is not a queue message: queue replay must not pretend to
    // re-drive it, and the record's re-drive path is the retry route.
    expect(insert.envelope ?? null).toBeNull();
    expect(insert.createdAtMs).toBe(1_765_000_000_000);
  });
});
