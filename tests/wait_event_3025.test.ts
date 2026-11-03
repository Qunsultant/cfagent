/**
 * Issue #3025 â€” pins for the event-first shard wait.
 *
 * The loop's cost was the repeated sleep+poll per round; its value was
 * that a lost signal still resolves. These pins hold both: the parent
 * waits on an event when the step surface supports it, reconciles with
 * a single status sweep (not a poll loop) when it does not arrive, and
 * keeps the deadline-bounded sleep only for a surface that cannot wait.
 */
import { describe, expect, it } from "vitest";
import {
  runParentFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
import { notifyParentShardDone } from "../src/workflows/screenerWorkflow";
import {
  SHARD_DONE_EVENT,
  workflowIdForJob,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";
import type { Env } from "../src/types";

function command(shardCount: number, extra: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-3025",
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

/** A step surface that CAN wait: records what it did, never sleeps. */
function waitingStep(behaviour: "signal" | "timeout") {
  let now = 1_000_000;
  const names: string[] = [];
  const waits: Array<{ name: string; type: string; timeoutMs: number }> = [];
  const step: ScreenerWorkflowStep = {
    do: async (name, fn) => {
      names.push(name);
      return fn();
    },
    sleep: async (name, ms) => {
      names.push(name);
      now += ms;
    },
    waitForEvent: async (name, opts) => {
      names.push(name);
      waits.push({ name, type: opts.type, timeoutMs: opts.timeoutMs });
      if (behaviour === "signal") return { shardId: "S1" } as never;
      now += opts.timeoutMs; // the deadline passes while waiting
      throw new Error("timeout");
    },
  };
  return { step, names, waits, nowMs: () => now };
}

/** A step surface that CANNOT wait (older adapter / test double). */
function legacyStep() {
  let now = 1_000_000;
  const names: string[] = [];
  const step: ScreenerWorkflowStep = {
    do: async (name, fn) => {
      names.push(name);
      return fn();
    },
    sleep: async (name, ms) => {
      names.push(name);
      now += ms;
    },
  };
  return { step, names, nowMs: () => now };
}

function instantChildren(created: WorkflowJobCommand[]): ChildWorkflowOps {
  return {
    createChild: async (cmd) => {
      created.push(cmd);
      return { workflowId: `wf-${cmd.shards[0]!.shardId}` };
    },
    getChildStatus: async () => ({
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

describe("event-first batch wait (#3025)", () => {
  it("waits on the shard event instead of sleeping, and carries the parent id to the child", async () => {
    const c = waitingStep("signal");
    const created: WorkflowJobCommand[] = [];
    const collation = await runParentFlow(command(2), c.step, deps(c.nowMs), instantChildren(created));
    expect(collation.shards.every((s) => s.status === "completed")).toBe(true);
    expect(c.waits.length).toBeGreaterThan(0);
    expect(c.waits[0]!.type).toBe(SHARD_DONE_EVENT);
    expect(c.names.some((n) => n.startsWith("poll-wait-"))).toBe(false);
    expect(created.map((cmd) => cmd.parentWorkflowId)).toEqual([workflowIdForJob("job-3025"), workflowIdForJob("job-3025")]);
  });

  it("bounds the wait by the shard deadline", async () => {
    const c = waitingStep("signal");
    await runParentFlow(
      command(1, { shardTimeoutMs: 5_000 }),
      c.step,
      deps(c.nowMs),
      instantChildren([]),
    );
    expect(c.waits[0]!.timeoutMs).toBeGreaterThan(0);
    expect(c.waits[0]!.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("reconciles with status reads, not a poll loop, when no signal arrives", async () => {
    const c = waitingStep("timeout");
    const collation = await runParentFlow(
      command(1, { shardTimeoutMs: 1_000 }),
      c.step,
      deps(c.nowMs),
      instantChildren([]),
    );
    // One sweep, not a loop: poll-0 exists, poll-1 does not.
    expect(c.names).toContain("poll-0");
    expect(c.names).not.toContain("poll-1");
    expect(collation.shards).toHaveLength(1);
  });

  it("keeps the deadline-bounded sleep only for a surface that cannot wait", async () => {
    const c = legacyStep();
    const collation = await runParentFlow(
      command(1, { maxParallelShards: 1 }),
      c.step,
      deps(c.nowMs),
      instantChildren([]),
    );
    expect(c.names.some((n) => n.startsWith("poll-wait-"))).toBe(true);
    expect(collation.shards[0]?.status).toBe("completed");
  });
});

describe("child completion signal (#3025)", () => {
  const shardCommand = (extra: Partial<WorkflowJobCommand> = {}) =>
    ({
      ...command(1),
      role: "shard",
      parentJobId: "job-3025",
      parentWorkflowId: "wf-parent",
      shard: { shardId: "S1", universe: "TECH" },
      ...extra,
    }) as WorkflowJobCommand;

  it("sends the shard-done event to the parent instance, payload = shard id", async () => {
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const env = {
      SCREENER_WORKFLOW: {
        get: async (id: string) => ({
          sendEvent: async (event: { type: string; payload: unknown }) => {
            sent.push({ instance: id, ...event });
          },
        }),
      },
    } as unknown as Env;
    await notifyParentShardDone(env, shardCommand());
    expect(sent).toEqual([
      { instance: "wf-parent", type: SHARD_DONE_EVENT, payload: { shardId: "S1" } },
    ]);
  });

  it("does not signal when the command carries no parent instance (older parent)", async () => {
    let called = 0;
    const env = {
      SCREENER_WORKFLOW: {
        get: async () => ({
          sendEvent: async () => {
            called += 1;
          },
        }),
      },
    } as unknown as Env;
    await notifyParentShardDone(env, shardCommand({ parentWorkflowId: undefined }));
    expect(called).toBe(0);
  });

  it("swallows a failed send: the parent's deadline sweep is the backstop", async () => {
    const env = {
      SCREENER_WORKFLOW: {
        get: async () => {
          throw new Error("instance gone");
        },
      },
    } as unknown as Env;
    await expect(notifyParentShardDone(env, shardCommand())).resolves.toBeUndefined();
  });
});


