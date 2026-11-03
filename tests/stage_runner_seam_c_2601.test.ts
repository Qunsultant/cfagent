/**
 * Issue #2601 seam C — pins for the workflow parent's fan-out moving onto
 * the stage-runner contract. Behaviour-preserving: the same batches, in
 * the same order, at the same cap — now partitioned by `planStageFanout`
 * instead of an inline slice loop.
 */
import { describe, expect, it } from "vitest";
import {
  runParentFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
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
    jobId: "job-5",
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

function instantChildren(created: string[]): ChildWorkflowOps {
  return {
    createChild: async (cmd) => {
      const shardId = String(cmd.shards[0]!.shardId);
      created.push(shardId);
      return { workflowId: `wf-${shardId}` };
    },
    getChildStatus: async (workflowId) => ({
      status: "complete" as const,
      output: {
        success: true,
        timestamp: "2026-11-03T00:00:00.000Z",
        totalScanned: 10,
        expectedCount: 10,
        matchedCount: 2,
      },
    }),
  };
}

describe("seam C — workflow fan-out on the stage-runner contract (#2601)", () => {
  it("keeps the exact batch plan at the command's cap (2,2,1 for five shards)", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(5, { maxParallelShards: 2 }),
      c.step,
      deps(c.nowMs),
      instantChildren(created),
    );
    expect(created).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(c.names.filter((n) => n.startsWith("fan-out-batch-"))).toEqual([
      "fan-out-batch-0",
      "fan-out-batch-1",
      "fan-out-batch-2",
    ]);
    expect(collation.shards).toHaveLength(5);
    expect(collation.shards.every((s) => s.status === "completed")).toBe(true);
  });

  it("uses the shared default cap when the command names none", async () => {
    const c = clock();
    const created: string[] = [];
    const collation = await runParentFlow(
      command(DEFAULT_MAX_PARALLEL_SHARDS + 1),
      c.step,
      deps(c.nowMs),
      instantChildren(created),
    );
    expect(created).toHaveLength(DEFAULT_MAX_PARALLEL_SHARDS + 1);
    expect(c.names.filter((n) => n.startsWith("fan-out-batch-"))).toEqual([
      "fan-out-batch-0",
      "fan-out-batch-1",
    ]);
    expect(collation.shards).toHaveLength(DEFAULT_MAX_PARALLEL_SHARDS + 1);
  });

  it("starts every shard even when the cap forces several rounds (tail is deferred, never dropped)", async () => {
    const c = clock();
    const created: string[] = [];
    await runParentFlow(
      command(7, { maxParallelShards: 3 }),
      c.step,
      deps(c.nowMs),
      instantChildren(created),
    );
    expect(created).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
    expect(c.names.filter((n) => n.startsWith("fan-out-batch-"))).toHaveLength(3);
  });
});
