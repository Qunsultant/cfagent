/**
 * Issue #3027 (follower of #2601) — pins for the production
 * StageCheckpointStore over mas_async_jobs. The rows are the store:
 * read projects them, write refuses with a named reason, and a stage
 * with no row is `never-attempted`, never "failed".
 */
import { describe, expect, it } from "vitest";
import type { ShardRow } from "../src/services/shardJobs";
import {
  STAGE_CHECKPOINT_WRITE_UNSUPPORTED,
  checkpointFromChainRows,
  createAsyncJobStageCheckpointStore,
} from "../src/workflows/stageRunnerCheckpointAdapter";
import { planRun } from "../src/workflows/stageRunnerPlan";
import type { StageRunnerPlan } from "../src/workflows/stageRunnerPorts";

function plan(): StageRunnerPlan {
  return planRun({
    runId: "chain-1",
    invocation: "async-alarm",
    stages: [
      { stage: "feed", execution: "parallel", maxParallel: 3, timeoutMs: 1000 },
      { stage: "analysis", execution: "sequential", timeoutMs: 1000 },
      { stage: "store", execution: "sequential", timeoutMs: 1000 },
      { stage: "deliver", execution: "sequential", timeoutMs: 1000 },
    ],
    units: [{ unitId: "TECH" }],
  });
}

function row(over: Partial<ShardRow> = {}): ShardRow {
  return {
    jobId: "job-1",
    stage: "feed",
    status: "completed",
    shardKey: "nasdaq",
    createdAt: "2026-11-03T00:00:00.000Z",
    ...over,
  };
}

describe("checkpointFromChainRows (#3027)", () => {
  it("projects one chain as one unit and marks unrecorded stages never-attempted", () => {
    const rows: ShardRow[] = [
      row({ stage: "feed", shardKey: "nasdaq", status: "completed" }),
      row({ stage: "feed", shardKey: "etrade", status: "completed" }),
      row({ stage: "feed", shardKey: "yahoo", status: "completed" }),
      row({ stage: "generate", shardKey: "assemble", status: "completed" }),
    ];
    const checkpoint = checkpointFromChainRows("chain-1", rows, plan(), "TECH");
    const byStage = new Map(checkpoint.units.map((u) => [u.stage, u]));
    expect(byStage.get("feed")).toMatchObject({ unitId: "TECH", status: "completed", attempt: 3 });
    // generate → analysis in the runner vocabulary.
    expect(byStage.get("analysis")).toMatchObject({ status: "completed", attempt: 1 });
    expect(byStage.get("store")?.status).toBe("never-attempted");
    expect(byStage.get("deliver")?.status).toBe("never-attempted");
    // Total over the plan: one entry per (stage, unit).
    expect(checkpoint.units).toHaveLength(plan().stages.length);
  });

  it("fails the stage when any leg failed, and names the error", () => {
    const rows: ShardRow[] = [
      row({ stage: "feed", shardKey: "nasdaq", status: "completed" }),
      row({ stage: "feed", shardKey: "etrade", status: "failed", error: "provider 429" }),
      row({ stage: "feed", shardKey: "yahoo", status: "queued" }),
    ];
    const checkpoint = checkpointFromChainRows("chain-1", rows, plan(), "TECH");
    const feed = checkpoint.units.find((u) => u.stage === "feed")!;
    expect(feed.status).toBe("failed");
    expect(feed.error).toBe("provider 429");
  });

  it("keeps a stage running while one leg is still running", () => {
    const rows: ShardRow[] = [
      row({ stage: "feed", shardKey: "nasdaq", status: "completed" }),
      row({ stage: "feed", shardKey: "etrade", status: "running" }),
    ];
    const feed = checkpointFromChainRows("chain-1", rows, plan(), "TECH").units.find(
      (u) => u.stage === "feed",
    )!;
    expect(feed.status).toBe("running");
  });
});

describe("createAsyncJobStageCheckpointStore (#3027)", () => {
  it("reads through the queue rows for the bound session", async () => {
    const calls: Array<[string, string]> = [];
    const store = createAsyncJobStageCheckpointStore({
      plan: plan(),
      sessionId: "alice",
      unitId: "TECH",
      readChainRows: (chainId, sessionId) => {
        calls.push([chainId, sessionId]);
        return [row({ stage: "feed", status: "completed" })];
      },
    });
    const checkpoint = await store.read("chain-1");
    expect(calls).toEqual([["chain-1", "alice"]]);
    expect(checkpoint?.units.find((u) => u.stage === "feed")?.status).toBe("completed");
  });

  it("returns null (never throws) when the store is unavailable", async () => {
    const store = createAsyncJobStageCheckpointStore({
      plan: plan(),
      sessionId: "alice",
      unitId: "TECH",
      readChainRows: () => {
        throw new Error("DO unavailable");
      },
    });
    await expect(store.read("chain-1")).resolves.toBeNull();
  });

  it("refuses to write: the rows are the store, not a second unit table", async () => {
    const store = createAsyncJobStageCheckpointStore({
      plan: plan(),
      sessionId: "alice",
      unitId: "TECH",
      readChainRows: () => [],
    });
    await expect(store.write({ runId: "chain-1", units: [] })).rejects.toThrow(
      STAGE_CHECKPOINT_WRITE_UNSUPPORTED,
    );
  });
});
