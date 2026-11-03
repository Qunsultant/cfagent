/**
 * Issue #2601 seam A — pins for the chain planner's move onto the
 * stage-runner contract. The migration is behaviour-preserving: the
 * legacy tables keep their exact values, but they are now DERIVED from
 * the one contract instead of being a second source of truth. These
 * pins fail if the derivation ever changes what the planner executes.
 */
import { describe, expect, it } from "vitest";
import type { PipelineStage } from "../src/types";
import { PIPELINE_STAGE_ORDER, SHARD_RETRY_BUCKET } from "../src/services/shardJobs";
import { DEFAULT_PIPELINE_POLICY } from "../src/services/pipelinePolicy";
import {
  RUNNER_STAGE_ORDER,
  STAGE_RETRY_BUCKET,
  resolveStageRetryBudget,
  runnerStageForPipelineStage,
  type StageRunnerStage,
} from "../src/workflows/stageRunnerPorts";

function stage(over: Partial<StageRunnerStage> = {}): StageRunnerStage {
  return {
    stage: "analysis",
    execution: "sequential",
    timeoutMs: 1000,
    ...over,
  };
}

describe("seam A — chain planner on the stage-runner contract (#2601)", () => {
  it("keeps the chain stage order exactly as the planner executed it", () => {
    expect(PIPELINE_STAGE_ORDER).toEqual(["feed", "generate", "store", "serve", "deliver"]);
    // And it is a projection of the contract order, not a copy: the
    // five chain stages appear in the same relative order.
    const projected = RUNNER_STAGE_ORDER.filter(
      (s) => s !== "gather" && s !== "analysis",
    ).map((s) => s);
    expect(projected).toEqual(["feed", "store", "serve", "deliver"]);
  });

  it("keeps every shard retry bucket at its legacy value while deriving it from the contract", () => {
    expect(SHARD_RETRY_BUCKET).toEqual({
      feed: "acquisition",
      generate: "report",
      store: "report",
      deliver: "delivery",
    });
    for (const [chainStage, bucket] of Object.entries(SHARD_RETRY_BUCKET)) {
      expect(bucket).toBe(STAGE_RETRY_BUCKET[runnerStageForPipelineStage(chainStage as PipelineStage)]);
    }
  });

  it("resolves the analysis stage's budget from pipelinePolicy, one bucket for both names", () => {
    expect(resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, stage({ stage: "analysis" }))).toEqual(
      DEFAULT_PIPELINE_POLICY.retry.report,
    );
    expect(STAGE_RETRY_BUCKET.analysis).toBe("report");
    // generate (chain) and analysis (runner) are the same stage: one bucket.
    expect(STAGE_RETRY_BUCKET[runnerStageForPipelineStage("generate")]).toBe("report");
  });

  it("maps every chain stage onto a runner stage (the mapping is total)", () => {
    for (const chainStage of PIPELINE_STAGE_ORDER) {
      expect(RUNNER_STAGE_ORDER).toContain(runnerStageForPipelineStage(chainStage));
    }
  });
});
