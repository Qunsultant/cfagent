// @vitest-environment node
/**
 * Issue #6396 — a step can declare its own retry bucket.
 *
 * Retry was per-node: every step in a stage shared one bucket, so retrying a
 * cheap fetch and retrying a whole awaited agent turn had the same budget. A
 * step can now name a bucket from the ONE policy list; absent, the stage's
 * budget applies exactly as before.
 *
 * Pins:
 *  - 6396-P01 a step with an override retries under ITS bucket, not the stage's;
 *  - 6396-P02 a step without one keeps the stage's bucket, byte for byte;
 *  - 6396-P03 a bucket outside the policy list refuses at define, naming the
 *    valid names (never a silent fallback to the stage's bucket);
 *  - 6396-P04 a malformed retry field refuses by name.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { RETRY_BUCKET_NAMES } from "../src/services/pipelinePolicy";

const JOB_ID = "retry-job";

function makeControl() {
  const stores = createInMemoryJobPipelineStores();
  const steps = createBuiltinStepRegistry();
  const calls = { count: 0 };
  steps.register("flaky", async () => {
    calls.count += 1;
    throw new JobPipelineError("job_step_failed", "upstream said try again");
  });
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
  });
  return { control, calls };
}

function jobWith(step: Record<string, unknown>) {
  return {
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      // The stage's bucket is the widest one; a step override must beat it.
      retryBucket: "acquisition",
      steps: [step],
      executionMode: { delivery: "sync" as const },
    },
  };
}

describe("6396-P01 a step retries under its own bucket", () => {
  it("uses the override's attempts, not the stage's", async () => {
    const h = makeControl();
    await h.control.defineJob(jobWith({ step: "flaky", retry: { bucket: "report" } }));

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("failed");
    // acquisition = 3 attempts, report = 2: the step's bucket decides.
    expect(h.calls.count).toBe(2);
  });
});

describe("6396-P02 no override keeps the stage bucket", () => {
  it("retries under the stage's own budget", async () => {
    const h = makeControl();
    await h.control.defineJob(jobWith({ step: "flaky" }));

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("failed");
    expect(h.calls.count).toBe(3);
  });
});

describe("6396-P03 an unknown bucket refuses at define", () => {
  it("names the policy's own buckets instead of falling back", async () => {
    const h = makeControl();

    await expect(
      h.control.defineJob(jobWith({ step: "flaky", retry: { bucket: "turbo" } })),
    ).rejects.toMatchObject({ code: "job_config_invalid" });
    await expect(
      h.control.defineJob(jobWith({ step: "flaky", retry: { bucket: "turbo" } })),
    ).rejects.toThrow(RETRY_BUCKET_NAMES.join(", "));
  });
});

describe("6396-P04 a malformed retry field refuses", () => {
  it("refuses a non-object retry", async () => {
    const h = makeControl();

    await expect(
      h.control.defineJob(jobWith({ step: "flaky", retry: "report" })),
    ).rejects.toMatchObject({ code: "job_config_invalid" });
  });
});
