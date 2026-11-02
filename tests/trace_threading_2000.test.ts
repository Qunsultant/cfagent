/**
 * Phase 5 Slice 3 (issue #2000) — trace threading through
 * workflow steps.
 *
 * What this slice adds to the S17 spine: the parent flow's
 * fan-out steps join the run's trace (they are workflow
 * steps, and until this slice they never emitted), and the
 * shard command's traceparent propagation is pinned at the
 * fan-out seam (the Cloudflare Workflows runtime does not
 * propagate W3C context — the command's params are the only
 * carrier, so the spread is the mechanism and it gets a pin).
 *
 * The hop contract pins below are the existing
 * recordWorkflowTraceHop behavior, restated as this slice's
 * regression set: a step emits under the run's traceparent,
 * and a step without one records nothing and never throws.
 */
import { describe, expect, it } from "vitest";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import {
  deterministicSpanId,
  recordWorkflowTraceHop,
} from "../src/observability/meshTrace";
import {
  runParentFlow,
  shardCommandFor,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";

const TRACE_ID = "a".repeat(32);
const PARENT_SPAN = "b".repeat(16);
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;

function parentCommand(): WorkflowJobCommand {
  return {
    jobId: "job-2000-trace",
    type: "run-screen",
    source: "test",
    trigger: "manual",
    userLogin: "octocat",
    shards: [{ shardId: "s1" }],
    role: "parent",
    tenantId: "tenant-test",
    traceparent: TRACEPARENT,
  };
}

describe("recordWorkflowTraceHop contract (slice 3 regression set)", () => {
  it("a step hop lands under the run's traceparent, deterministic span", async () => {
    const store = new InMemoryMeshTraceStore();
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        tenantId: "tenant-test",
        userLogin: "octocat",
      },
      { kind: "workflow-step", operation: "execute-screen" },
    );
    const hops = await store.hopsFor(TRACE_ID);
    expect(hops).toHaveLength(1);
    expect(hops[0].traceId).toBe(TRACE_ID);
    expect(hops[0].parentSpanId).toBe(PARENT_SPAN);
    expect(hops[0].spanId).toBe(deterministicSpanId("job-1:execute-screen"));
    expect(hops[0].kind).toBe("workflow-step");
    expect(hops[0].operation).toBe("execute-screen");
    expect(hops[0].caller).toBe("octocat");
    expect(hops[0].agent).toBe("ScreenerScreenWorkflow");
    expect(hops[0].jobId).toBe("job-1");
  });

  it("a step without a traceparent records nothing and never throws", async () => {
    const store = new InMemoryMeshTraceStore();
    await expect(
      recordWorkflowTraceHop(
        store,
        { jobId: "job-1", userLogin: "octocat" },
        { kind: "workflow-step", operation: "execute-screen" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      recordWorkflowTraceHop(
        store,
        { traceparent: "not-a-traceparent", jobId: "job-1", userLogin: "octocat" },
        { kind: "workflow-step", operation: "execute-screen" },
      ),
    ).resolves.toBeUndefined();
    expect(await store.hopsFor(TRACE_ID)).toHaveLength(0);
  });

  it("a hop round-trips: record → hopsFor(traceId)", async () => {
    const store = new InMemoryMeshTraceStore();
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        userLogin: "octocat",
      },
      { kind: "workflow-step", operation: "store-shard" },
    );
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        userLogin: "octocat",
      },
      { kind: "projection", operation: "project-shard" },
    );
    const hops = await store.hopsFor(TRACE_ID);
    expect(hops.map((h) => h.operation).sort()).toEqual([
      "project-shard",
      "store-shard",
    ]);
    expect(await store.hopsFor("c".repeat(32))).toHaveLength(0);
  });
});

describe("shard command traceparent propagation", () => {
  it("shardCommandFor carries the parent's traceparent to the child", () => {
    const child = shardCommandFor(parentCommand(), { shardId: "s1" });
    expect(child.traceparent).toBe(TRACEPARENT);
    expect(child.jobId).toBe("job-2000-trace:shard:s1");
    expect(child.role).toBe("shard");
    expect(child.parentJobId).toBe("job-2000-trace");
  });
});

describe("runParentFlow step emission (slice 3)", () => {
  async function runParentWithCapturedTrace() {
    const events: Array<{
      command: WorkflowJobCommand;
      event: { kind: string; operation: string };
    }> = [];
    const childCommands: WorkflowJobCommand[] = [];
    const step = {
      do: async (_name: string, fn: () => Promise<unknown>) => fn(),
      sleep: async () => {},
    } as unknown as ScreenerWorkflowStep;
    const childOps: ChildWorkflowOps = {
      createChild: async (cmd) => {
        childCommands.push(cmd);
        return { workflowId: "wf-s1" };
      },
      getChildStatus: async () => ({
        status: "complete" as const,
        output: {
          success: true,
          timestamp: "2026-11-02T00:00:00.000Z",
          totalScanned: 1,
          expectedCount: 1,
          matchedCount: 1,
        },
      }),
    };
    const deps = {
      screenRunner: {
        runScreen: async () => {
          throw new Error("parent flow must not run screens");
        },
        runGoalScreen: async () => {
          throw new Error("parent flow must not run goal screens");
        },
      },
      shardStore: null,
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: () => 1760000000000,
      traceHop: async (command: WorkflowJobCommand, event: { kind: string; operation: string }) => {
        events.push({ command, event });
      },
    } as unknown as ScreenerWorkflowDeps;
    const collation = await runParentFlow(parentCommand(), step, deps, childOps);
    return { events, childCommands, collation };
  }

  it("the fan-out batch step emits under the run's traceparent", async () => {
    const { events } = await runParentWithCapturedTrace();
    const fanOut = events.filter((e) => e.event.operation === "fan-out-batch-0");
    expect(fanOut).toHaveLength(1);
    expect(fanOut[0].event.kind).toBe("workflow-step");
    expect(fanOut[0].command.traceparent).toBe(TRACEPARENT);
    expect(fanOut[0].command.jobId).toBe("job-2000-trace");
  });

  it("the fan-out seam hands the child the parent's traceparent", async () => {
    const { childCommands } = await runParentWithCapturedTrace();
    expect(childCommands).toHaveLength(1);
    expect(childCommands[0].traceparent).toBe(TRACEPARENT);
  });

  it("existing parent emissions are untouched: announce + project-final", async () => {
    const { events, collation } = await runParentWithCapturedTrace();
    expect(events.map((e) => e.event.operation)).toEqual([
      "announce",
      "fan-out-batch-0",
      "project-final",
    ]);
    expect(collation.lifecycle).toBe("Completed");
  });
});
