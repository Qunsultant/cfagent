/**
 * Issue #3028 — pins for the driver wiring: the workflow parent asks
 * the stage-runner contract which units are outstanding (resume),
 * records a deferred fan-out tail by name, and a first run behaves
 * exactly as before.
 */
import { describe, expect, it } from "vitest";
import {
  runParentFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
import type { StageRunnerCheckpoint } from "../src/workflows/stageRunnerPorts";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

function clock(): { nowMs: () => number; step: ScreenerWorkflowStep; names: string[] } {
  let now = 1_000_000;
  const names: string[] = [];
  return {
    names,
    nowMs: () => now,
    step: {
      do: async (name, fn) => {
        names.push(name);
        return fn();
      },
      sleep: async (_name, ms) => {
        now += ms;
      },
    },
  };
}

function deps(nowMs: () => number): ScreenerWorkflowDeps {
  return {
    screenRunner: { runScreen: async () => ({ success: true }) as never },
    shardStore: null,
    storeReport: async () => undefined,
    deliverOutcome: async () => undefined,
    nowMs,
    ndModeEnabled: false,
  };
}

function command(shardCount: number, extra: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-3028",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: Array.from({ length: shardCount }, (_, i) => ({
      shardId: `S${i + 1}`,
      universe: `U${i + 1}`,
    })),
    deliver: false,
    ...extra,
  } as WorkflowJobCommand;
}

function children(created: string[], status: "complete" | "errored" = "complete"): ChildWorkflowOps {
  return {
    createChild: async (cmd) => {
      const shardId = String(cmd.shards[0]!.shardId);
      created.push(shardId);
      return { workflowId: `wf-${shardId}` };
    },
    getChildStatus: async () =>
      status === "complete"
        ? {
            status: "complete" as const,
            output: {
              success: true,
              timestamp: "2026-11-03T00:00:00.000Z",
              totalScanned: 10,
              expectedCount: 10,
              matchedCount: 2,
            },
          }
        : { status: "errored" as const, error: { message: "child boom" } },
  };
}

function checkpoint(
  statuses: Record<string, "completed" | "failed" | "timed_out">,
): StageRunnerCheckpoint {
  return {
    runId: "job-3028",
    units: Object.entries(statuses).map(([unitId, status]) => ({
      stage: "analysis" as const,
      unitId,
      status,
      attempt: 1,
      updatedAt: "2026-11-03T00:00:00.000Z",
    })),
  };
}

describe("workflow parent on the stage-runner contract (#3028)", () => {
  it("a first run is unchanged and records no cap reason when everything fits one round", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(3, { maxParallelShards: DEFAULT_MAX_PARALLEL_SHARDS }),
      c.step,
      deps(c.nowMs),
      children(created),
    );
    expect(created).toEqual(["S1", "S2", "S3"]);
    expect(collation.fanoutCapReason).toBeUndefined();
    expect(collation.resumedSkippedUnits).toBeUndefined();
    expect(collation.shards).toHaveLength(3);
  });

  it("names the deferred tail when the cap forces several rounds (still runs every shard)", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(5, { maxParallelShards: 2 }),
      c.step,
      deps(c.nowMs),
      children(created),
    );
    expect(created).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(collation.fanoutCapReason).toContain("fanout_cap_exceeded");
    expect(collation.fanoutCapReason).toContain("S5");
    expect(collation.shards).toHaveLength(5);
  });

  it("a resume starts only the units the checkpoint says are outstanding", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(4, { maxParallelShards: 4 }),
      c.step,
      deps(c.nowMs),
      children(created),
      checkpoint({ S1: "completed", S2: "completed", S3: "failed", S4: "completed" }),
    );
    expect(created).toEqual(["S3"]);
    expect(collation.resumedSkippedUnits).toEqual(["S1", "S2", "S4"]);
  });

  it("a resume with nothing outstanding starts no child and does not report a false failure", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(3, { maxParallelShards: 2 }),
      c.step,
      deps(c.nowMs),
      children(created),
      checkpoint({ S1: "completed", S2: "completed", S3: "completed" }),
    );
    expect(created).toEqual([]);
    expect(collation.resumedSkippedUnits).toEqual(["S1", "S2", "S3"]);
    expect(collation.shards.every((s) => s.status === "completed")).toBe(true);
    expect(collation.lifecycle).not.toBe("Failed");
  });

  it("re-runs the failed unit on resume while keeping the completed one", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(2, { maxParallelShards: 2 }),
      c.step,
      deps(c.nowMs),
      children(created),
      checkpoint({ S1: "completed", S2: "failed" }),
    );
    // A failed unit is outstanding: it runs; the completed one never does.
    expect(created).toEqual(["S2"]);
    expect(collation.resumedSkippedUnits).toEqual(["S1"]);
    expect(collation.shards.find((s) => s.shardId === "S2")?.status).toBe("completed");
    expect(collation.shards.find((s) => s.shardId === "S1")?.status).toBe("completed");
  });
});
