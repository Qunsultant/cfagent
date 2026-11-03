/**
 * Issue #2601 (Options Screener programme slice 5) — pins for the
 * stage-runner CONTRACT. These pin the properties the three
 * consolidation targets must satisfy once they move onto the one
 * runner (hand-rolled shardJobs chain planner, asyncJobs DO-alarm
 * scheduler, workflow poll loop). They do NOT claim any of those
 * seams has moved: this slice lands the contract, its pure planner,
 * and its checkpoint projection, with pins. Execution wiring is the
 * follow-on seams, one PR each.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  DEFAULT_SHARD_TIMEOUT_MS,
} from "../src/workflows/workflowPorts";
import { DEFAULT_PIPELINE_POLICY } from "../src/services/pipelinePolicy";
import {
  DEFAULT_STAGE_PACING_TIER,
  RUNNER_STAGE_ORDER,
  STAGE_CANONICAL_LABEL,
  assertStageRunnerPlan,
  runnerStageForPipelineStage,
  resolveStageRetryBudget,
  type StageRunnerPlan,
  type StageRunnerStage,
} from "../src/workflows/stageRunnerPorts";
import {
  FANOUT_CAP_EXCEEDED,
  fanoutCapExceeded,
  planNext,
  planRun,
  planStageFanout,
  resumeUnits,
} from "../src/workflows/stageRunnerPlan";
import {
  checkpointFromStageRows,
  createInMemoryStageCheckpointStore,
} from "../src/workflows/stageRunnerCheckpoint";

function stage(overrides: Partial<StageRunnerStage> = {}): StageRunnerStage {
  return {
    stage: "feed",
    execution: "sequential",
    timeoutMs: DEFAULT_SHARD_TIMEOUT_MS,
    retryBucket: "acquisition",
    pacingTier: DEFAULT_STAGE_PACING_TIER,
    ...overrides,
  };
}

function plan(overrides: Partial<StageRunnerPlan> = {}): StageRunnerPlan {
  return planRun({
    runId: "run-1",
    invocation: "workflow-shard",
    stages: [
      stage({ stage: "feed", execution: "parallel", maxParallel: 2 }),
      stage({ stage: "analysis", retryBucket: "acquisition" }),
      stage({ stage: "store", retryBucket: "report" }),
      stage({ stage: "deliver", retryBucket: "delivery" }),
    ],
    units: [
      { unitId: "shard-a" },
      { unitId: "shard-b" },
      { unitId: "shard-c" },
    ],
    ...overrides,
  });
}

describe("stage-runner plan contract (#2601)", () => {
  it("keeps the canonical stage order and refuses an out-of-order plan loudly", () => {
    const p = plan();
    expect(p.stages.map((s) => s.stage)).toEqual(["feed", "analysis", "store", "deliver"]);
    expect(RUNNER_STAGE_ORDER).toEqual([
      "feed",
      "gather",
      "analysis",
      "store",
      "serve",
      "deliver",
    ]);
    expect(() =>
      planRun({
        runId: "run-2",
        invocation: "sync",
        stages: [stage({ stage: "store" }), stage({ stage: "analysis" })],
        units: [],
      }),
    ).toThrow(/order/i);
  });

  it("defaults the mode to deterministic and never carries a non-deterministic plan by accident", () => {
    expect(plan().screenMode).toBe("deterministic");
    expect(plan({ screenMode: "non-deterministic" }).screenMode).toBe("non-deterministic");
  });

  it("refuses an empty plan, a duplicate stage, and a parallel stage without a cap", () => {
    expect(() => planRun({ runId: "r", invocation: "sync", stages: [], units: [] })).toThrow(
      /at least one stage/i,
    );
    expect(() =>
      planRun({
        runId: "r",
        invocation: "sync",
        stages: [stage({ stage: "feed" }), stage({ stage: "feed" })],
        units: [],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertStageRunnerPlan({
        ...plan(),
        stages: [stage({ stage: "feed", execution: "parallel", maxParallel: 0 })],
      }),
    ).toThrow(/maxParallel/i);
  });

  it("resolves every stage's retry budget from pipelinePolicy, never from a call-site constant", () => {
    const policy = {
      ...DEFAULT_PIPELINE_POLICY,
      retry: {
        ...DEFAULT_PIPELINE_POLICY.retry,
        delivery: { ...DEFAULT_PIPELINE_POLICY.retry.delivery, maxAttempts: 7 },
      },
    };
    expect(resolveStageRetryBudget(policy, stage({ retryBucket: "delivery" })).maxAttempts).toBe(7);
    expect(resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, stage({ retryBucket: "acquisition" }))).toEqual(
      DEFAULT_PIPELINE_POLICY.retry.acquisition,
    );
    expect(resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, stage({ retryBucket: "report" }))).toEqual(
      DEFAULT_PIPELINE_POLICY.retry.report,
    );
  });

  it("states the pipeline-stage → runner-stage mapping instead of conflating the names", () => {
    expect(runnerStageForPipelineStage("feed")).toBe("feed");
    expect(runnerStageForPipelineStage("generate")).toBe("analysis");
    expect(runnerStageForPipelineStage("store")).toBe("store");
    expect(runnerStageForPipelineStage("serve")).toBe("serve");
    expect(runnerStageForPipelineStage("deliver")).toBe("deliver");
    expect(STAGE_CANONICAL_LABEL.analysis).toBe("generation");
    expect(STAGE_CANONICAL_LABEL.store).toBe("recording");
  });
});

describe("stage-runner planner (#2601)", () => {
  it("caps fan-out at the stage's maxParallel and names the deferred tail as fanout_cap_exceeded", () => {
    const p = plan();
    const feed = p.stages[0]!;
    const fanout = planStageFanout(feed, p.units);
    expect(fanout.maxParallel).toBe(2);
    expect(fanout.started.map((u) => u.unitId)).toEqual(["shard-a", "shard-b"]);
    expect(fanout.deferred.map((u) => u.unitId)).toEqual(["shard-c"]);
    const reason = fanoutCapExceeded(fanout);
    expect(reason).toContain(FANOUT_CAP_EXCEEDED);
    expect(reason).toContain("shard-c");
    const full = planStageFanout(feed, p.units.slice(0, 2));
    expect(full.deferred).toEqual([]);
    expect(fanoutCapExceeded(full)).toBeNull();
  });

  it("uses the shared fan-out default when a parallel stage names no cap", () => {
    const p = plan({ stages: [stage({ stage: "feed", execution: "parallel" })] });
    expect(planStageFanout(p.stages[0]!, p.units).maxParallel).toBe(DEFAULT_MAX_PARALLEL_SHARDS);
  });

  it("planNext advances to the first stage with unfinished units and never re-runs a completed one", () => {
    const p = plan();
    const checkpoint = {
      runId: p.runId,
      units: [
        { stage: "feed" as const, unitId: "shard-a", status: "completed" as const, attempt: 1, updatedAt: "t1" },
        { stage: "feed" as const, unitId: "shard-b", status: "completed" as const, attempt: 1, updatedAt: "t1" },
        { stage: "feed" as const, unitId: "shard-c", status: "completed" as const, attempt: 1, updatedAt: "t1" },
      ],
    };
    const next = planNext(p, checkpoint);
    expect(next?.stage.stage).toBe("analysis");
    expect(planNext(p, null)?.stage.stage).toBe("feed");
    expect(planNext(p, { ...checkpoint, units: [] })?.stage.stage).toBe("feed");
  });

  it("returns null once every planned stage has all its units terminal", () => {
    const p = plan();
    const checkpoint = {
      runId: p.runId,
      units: p.stages.flatMap((s) =>
        p.units.map((u) => ({
          stage: s.stage,
          unitId: u.unitId,
          status: "completed" as const,
          attempt: 1,
          updatedAt: "t1",
        })),
      ),
    };
    expect(planNext(p, checkpoint)).toBeNull();
  });

  it("resumes only units that did not complete — a completed unit is never re-run", () => {
    const p = plan();
    const checkpoint = {
      runId: p.runId,
      units: [
        { stage: "feed" as const, unitId: "shard-a", status: "completed" as const, attempt: 1, updatedAt: "t1" },
        { stage: "feed" as const, unitId: "shard-b", status: "failed" as const, attempt: 1, error: "provider 429", updatedAt: "t1" },
        { stage: "feed" as const, unitId: "shard-c", status: "timed_out" as const, attempt: 1, updatedAt: "t1" },
        { stage: "analysis" as const, unitId: "shard-a", status: "completed" as const, attempt: 1, updatedAt: "t1" },
      ],
    };
    const resumed = resumeUnits(p, checkpoint);
    expect(resumed.map((u) => `${u.stage.stage}:${u.unit.unitId}`)).toEqual(["feed:shard-b", "feed:shard-c"]);
    expect(resumeUnits(p, null)).toEqual([]);
  });

  it("projects mas_async_jobs stage rows onto runner checkpoints, never-attempted for stages with no row", () => {
    const p = plan();
    const checkpoint = checkpointFromStageRows(
      p.runId,
      [
        { unitId: "shard-a", stage: "feed", status: "completed", updatedAt: "t1" },
        { unitId: "shard-b", stage: "feed", status: "failed", error: "provider 429", updatedAt: "t1" },
        { unitId: "shard-a", stage: "generate", status: "completed", updatedAt: "t2" },
      ],
      p,
    );
    const byKey = new Map(checkpoint.units.map((u) => [`${u.stage}:${u.unitId}`, u]));
    expect(byKey.get("feed:shard-a")?.status).toBe("completed");
    expect(byKey.get("feed:shard-b")).toMatchObject({ status: "failed", error: "provider 429" });
    // generate → analysis (the legacy chain name is the analysis stage in this split).
    expect(byKey.get("analysis:shard-a")?.status).toBe("completed");
    // No row for store/deliver anywhere: absent is never-attempted, never "failed" and never lost.
    expect(byKey.get("store:shard-a")?.status).toBe("never-attempted");
    expect(byKey.get("deliver:shard-c")?.status).toBe("never-attempted");
    // Every planned (stage, unit) pair is present — the projection is total over the plan.
    expect(checkpoint.units).toHaveLength(p.stages.length * p.units.length);
  });

  it("round-trips a checkpoint through the in-memory store (tests only)", async () => {
    const store = createInMemoryStageCheckpointStore();
    expect(await store.read("run-1")).toBeNull();
    const checkpoint = { runId: "run-1", units: [] };
    await store.write(checkpoint);
    expect(await store.read("run-1")).toEqual(checkpoint);
  });
});
