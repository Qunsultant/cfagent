// @vitest-environment node
/**
 * Issue #6551 — a durable wait is bounded by configuration, never by the
 * platform's 24-hour maximum.
 *
 * #3955 chose "no declared bound ⇒ the host's maximum". The cost direction
 * (2026-11-25) rules that shape out: an unbounded wait is a live instance
 * with nothing pulling it down, which is the same residency class #6547 and
 * #6546 exist to remove. The bound now comes from the one policy resolver
 * (`pipeline.waitDefaultTimeoutMs`, settings beat env), and expiry stays the
 * declared outcome #3955 defined — the job branches on it, nothing hangs.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  WAIT_EVENT_STEP,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobEventWaitOutcome,
  type JobEventWaitRequest,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { DEFAULT_PIPELINE_POLICY, resolvePipelinePolicy } from "../src/services/pipelinePolicy";

function makeControl(opts: {
  seen: JobEventWaitRequest[];
  settings?: Record<string, string>;
  env?: Record<string, unknown>;
}) {
  const stores = createInMemoryJobPipelineStores();
  let runs = 0;
  return createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
    waitForEvent: async (request) => {
      opts.seen.push(request);
      return { outcome: "timeout" } satisfies JobEventWaitOutcome;
    },
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
}

async function runWaitJob(
  control: ReturnType<typeof makeControl>,
  params: Record<string, unknown>,
): Promise<void> {
  await control.defineJob({
    jobId: "approval",
    root: {
      kind: "dummy",
      steps: [{ step: WAIT_EVENT_STEP, params }],
      executionMode: { delivery: "sync" },
    },
  });
  const dispatch = await control.runJob("approval");
  expect(dispatch.state).toBe("completed");
}

describe("durable waits are bounded by configuration (#6551)", () => {
  it("passes the configured default when the job declares no bound", async () => {
    const seen: JobEventWaitRequest[] = [];
    await runWaitJob(makeControl({ seen }), { event: "approval.decided" });
    expect(seen[0].timeoutMs).toBe(DEFAULT_PIPELINE_POLICY.waitDefaultTimeoutMs);
    // The default is a bound, not the platform's 24h maximum.
    expect(seen[0].timeoutMs).toBeLessThan(86_400_000);
  });

  it("lets the tenant settings bound it, beating the default", async () => {
    const seen: JobEventWaitRequest[] = [];
    await runWaitJob(
      makeControl({ seen, settings: { "pipeline.waitDefaultTimeoutMs": "5000" } }),
      { event: "approval.decided" },
    );
    expect(seen[0].timeoutMs).toBe(5_000);
  });

  it("keeps a declared bound, whatever the configured default says", async () => {
    const seen: JobEventWaitRequest[] = [];
    await runWaitJob(
      makeControl({ seen, settings: { "pipeline.waitDefaultTimeoutMs": "9000" } }),
      { event: "approval.decided", timeoutMs: 2_500 },
    );
    expect(seen[0].timeoutMs).toBe(2_500);
  });

  it("resolves the bound from env, clamps above the platform ceiling, and settings win", () => {
    expect(
      resolvePipelinePolicy({ PIPELINE_WAIT_DEFAULT_TIMEOUT_MS: "7200000" }).waitDefaultTimeoutMs,
    ).toBe(7_200_000);
    expect(
      resolvePipelinePolicy({ PIPELINE_WAIT_DEFAULT_TIMEOUT_MS: "999999999" }).waitDefaultTimeoutMs,
    ).toBe(86_400_000);
    expect(
      resolvePipelinePolicy(
        { PIPELINE_WAIT_DEFAULT_TIMEOUT_MS: "7200000" },
        { "pipeline.waitDefaultTimeoutMs": "60000" },
      ).waitDefaultTimeoutMs,
    ).toBe(60_000);
  });
});
