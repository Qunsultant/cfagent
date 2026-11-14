// @vitest-environment node
/**
 * Issue #4341 ([#4280] follow-up, #1999 D5) — the goal-bridge retry + audit
 * ruling, pinned on the engine path.
 *
 * #1999 D5 pinned a DIRECT bridge submission that retried under the report
 * policy (`withRetry`, 2 attempts) and audited `followup.schedule_failed` on
 * final failure. #4280 (S5) deleted that block: a chain-mode goal screen now
 * submits through the workflow's deliver stage. The ruling recorded here is
 * (a): **the engine's stage retry + a visible failed stage IS the
 * replacement** — not a restored `withRetry`, and not a second audit shape.
 *
 * The ruling is only honest if the engine actually does those two things for
 * the deliver stage, so this pin holds both:
 *  - 4341-P01 the deliver stage retries under the `delivery` bucket, whose
 *    budget is more than one attempt (a transient bridge failure is retried).
 *  - 4341-P02 when the budget is exhausted the stage ends FAILED carrying the
 *    error text and the run is failed — the failure is visible, never a
 *    silent delivery assumption.
 *  - 4341-P03 the goal deliver door does not re-introduce a hand-rolled
 *    `withRetry` around the bridge (that would be the deleted D5 block in a
 *    new coat), and it does bridge chain-mode goal runs (`deliverViaChain`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { resolvePipelinePolicy } from "../src/services/pipelinePolicy";
import {
  resolveStageRetryBudget,
  stageRetryBucket,
  type StageRunnerStage,
} from "../src/workflows/stageRunnerPorts";

const DELIVER_STAGE = {
  stage: "deliver",
  execution: "sequential",
  timeoutMs: 60_000,
} as StageRunnerStage;

describe("4341-P01 the deliver stage retries under the delivery bucket", () => {
  it("maps deliver to the delivery bucket", () => {
    expect(stageRetryBucket(DELIVER_STAGE)).toBe("delivery");
  });

  it("gives it more than one attempt", () => {
    const budget = resolveStageRetryBudget(resolvePipelinePolicy(), DELIVER_STAGE);
    expect(budget.maxAttempts).toBeGreaterThan(1);
  });
});

describe("4341-P02 an exhausted deliver budget is a visible failed stage", () => {
  it("ends the stage failed with the bridge error on the unit, and the run failed", async () => {
    const stores = createInMemoryJobPipelineStores();
    const registry = new JobStepRegistry();
    registry.register("bridge-fails", async () => {
      throw new Error("followup bridge unreachable (synthetic)");
    });
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: registry,
      // One attempt: the point of this pin is the terminal shape once the
      // stage budget is spent, not the retry loop (P01 holds that budget).
      policy: {
        ...resolvePipelinePolicy(),
        retry: {
          acquisition: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
          report: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
          delivery: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        },
      },
    });
    await control.defineJob({
      jobId: "goal-bridge-4341",
      name: "Goal screen deliver",
      root: { kind: "deliver", steps: [{ step: "bridge-fails" }] },
    });
    const dispatch = await control.runJob("goal-bridge-4341", { trigger: "scheduled" });
    const outcome = dispatch.completion ? await dispatch.completion : null;

    expect(outcome?.state).toBe("failed");
    const view = await control.getJob("goal-bridge-4341");
    expect(view.instance?.state).toBe("failed");
    // The failure is named on the stage's unit, not swallowed into a bare
    // "failed" with no reason — that is what makes it actionable in Workflow
    // Runs without the retired audit.
    const failedUnit = view.stages
      .flatMap((stage) => stage.units)
      .find((unit) => unit.status === "failed");
    expect(failedUnit).toBeTruthy();
    expect(failedUnit?.error ?? "").toContain("followup bridge unreachable");
  });
});

describe("4341-P03 the deliver door carries the retry as the stage's, not its own", () => {
  const source = readFileSync("src/services/screenerPipelineJobs.ts", "utf8");

  it("does not hand-roll a withRetry around the goal bridge", () => {
    expect(source).not.toContain("withRetry");
  });

  it("bridges chain-mode goal runs through the deliver stage (deliverViaChain)", () => {
    expect(source).toContain("deliverViaChain: true");
    expect(source).toContain("deliverWorkflowScreenOutcome(");
  });
});
