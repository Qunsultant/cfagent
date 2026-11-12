/**
 * Issue #3025 — pins for the parent's completion semantics: the
 * parent never returns before the shards settle, and a slow or
 * failed shard does not lose the run.
 *
 * #4192: the SHARD_DONE_EVENT wait retired with the child-workflow
 * flow. There is no event anymore — notifyParentShardDone is gone,
 * nothing emits the event, and the parent completes when the engine
 * run settles. These pins now drive the engine path through
 * InMemoryWorkflowAdapter: "the parent waited for the shards"
 * becomes "start returned complete AND the collation + rows are all
 * present", asserted via adapter status + parent-row collation +
 * per-shard rows, never via a waits list. The deadline case lives
 * at the collation level (finalizeScreenerCollation with a
 * timed_out outcome), the way the anchor file does it.
 */
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  finalizeScreenerCollation,
  type ScreenerWorkflowDeps,
  type ShardOutcome,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  workflowIdForJob,
  type ParentScreenReportInput,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

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
    deliver: true,
    ...extra,
  } as WorkflowJobCommand;
}

function okResult(overrides: Partial<ShardScreenResult> = {}): ShardScreenResult {
  return {
    success: true,
    timestamp: "2026-11-03T00:00:00.000Z",
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    ...overrides,
  };
}

interface DepsBundle {
  store: InMemoryShardJobAdapter;
  stored: unknown[];
  delivered: unknown[];
  /** Parent canonical rows the finalize stored (the parent door). */
  parentStored: ParentScreenReportInput[];
  deps: ScreenerWorkflowDeps;
}

function makeDeps(runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"]): DepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen:
        runScreen ??
        (async (req) => ({
          ...okResult({ universe: req.universe }),
          full: { marker: "full-result", universe: req.universe },
        })),
    },
    shardStore: store,
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    storeParentReport: async (input) => {
      parentStored.push(input);
      return { stored: true, reportId: "parent-1" };
    },
    nowMs: () => 1_000_000,
  };
  return { store, stored, delivered, parentStored, deps };
}

async function latestParentRow(store: ShardJobStore, jobId: string) {
  return store.latestJob("tenant-1", jobId, jobId);
}

/** The collation the parent row carries (the door's read-back). */
async function collationFor(store: ShardJobStore, jobId: string) {
  const row = await latestParentRow(store, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
}

describe("parent completion semantics (#3025)", () => {
  it("start returns only once all shards have settled, and the parent id is the job's workflow id", async () => {
    // #4192: no event, no poll loop — adapter.start() resolves
    // only when the run has settled, so "the parent waited for
    // the shards" is "start returned complete AND the collation
    // + rows are all present".
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(2));
    expect(h.status).toBe("complete");
    expect(h.workflowId).toBe(workflowIdForJob("job-3025"));
    expect((await adapter.status(h.workflowId))?.status).toBe("complete");
    const collation = await collationFor(b.store, "job-3025");
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(
      (collation.shards as { shardId: string; status: string }[]).every(
        (s) => s.status === "completed",
      ),
    ).toBe(true);
    const rows = await b.store.listJobsForChain("tenant-1", "job-3025");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-3025", "shard:S1", "shard:S2"].sort(),
    );
    expect(rows.find((r) => r.jobKey === "shard:S1")?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "shard:S2")?.status).toBe("completed");
  });

  it("bounds the wait by the shard deadline", async () => {
    // #4192: the engine has no poll loop — a hanging unit is
    // the engine's policy timeout, not the screener's. What
    // this pins is the collation's handling of a shard that
    // hit its deadline: the usable shard still reaches
    // ReportGenerated, the run is qualified, and
    // BudgetConstrained is recorded.
    const b = makeDeps();
    const outcomes: ShardOutcome[] = [
      { shardId: "S1", status: "completed", totalScanned: 10, expectedCount: 10, matchedCount: 2, stored: true, delivered: true },
      { shardId: "S2", status: "timed_out", error: "deadline exceeded" },
    ];
    const c = await finalizeScreenerCollation(
      { shardStore: b.store, nowMs: b.deps.nowMs },
      {
        command: command(2, { shardTimeoutMs: 5_000 }),
        outcomes,
        lifecycleTransitions: [
          { lifecycle: "Idle", atMs: 1_000_000 },
          { lifecycle: "Running", atMs: 1_000_000 },
        ],
        stageTransitions: [],
        screenMode: "deterministic",
        startedAtMs: 1_000_000,
      },
    );
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(true);
    expect(c.shards.find((s) => s.shardId === "S2")?.status).toBe("timed_out");
    expect(c.lifecycleTransitions.map((t) => t.lifecycle)).toContain("BudgetConstrained");
  });

  it("reconciles with status reads, not a poll loop, when no signal arrives", async () => {
    // #4192: there is no signal to wait for and no sweep to
    // run — a shard that never completes (market failure)
    // still settles the run: start returns complete, the
    // Failed collation lands on the parent canonical row, and
    // the failed legs are visible. The run is not lost.
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(1));
    expect(h.status).toBe("complete");
    expect(b.stored).toHaveLength(0);
    expect(b.delivered).toHaveLength(0);
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    const rows = await b.store.listJobsForChain("tenant-1", "job-3025");
    expect(rows.find((r) => r.jobKey === "leg:S1")?.status).toBe("failed");
    const failedParent = await b.store.latestJob("tenant-1", "job-3025", "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/1 shards/);
  });

  it("keeps the deadline-bounded sleep only for a surface that cannot wait", async () => {
    // #4192: the surface that cannot wait is gone with the
    // child flow — the engine owns pacing and fan-out now, so
    // there is no wait surface at all, bounded or otherwise.
    // What survives is the single-shard run itself: it runs
    // exactly once and settles complete, even with the old
    // maxParallelShards hint on the command.
    const seen: string[] = [];
    const b = makeDeps(async (req) => {
      seen.push(req.universe ?? "?");
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(1, { maxParallelShards: 1 }));
    expect(h.status).toBe("complete");
    expect(seen).toEqual(["U1"]);
    const collation = await collationFor(b.store, "job-3025");
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(
      (collation.shards as { shardId: string; status: string }[])[0]?.status,
    ).toBe("completed");
    const rows = await b.store.listJobsForChain("tenant-1", "job-3025");
    expect(rows.find((r) => r.jobKey === "shard:S1")?.status).toBe("completed");
  });
});

describe("shard completion reaches the parent (#3025)", () => {
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
    // #4192: the event is retired — no instance receives a
    // shard-done send anymore. What survives is the intent:
    // the parent learns exactly which shard finished, now
    // from the settled collation on its own row instead of
    // from an event payload.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(1));
    expect(h.status).toBe("complete");
    const collation = await collationFor(b.store, "job-3025");
    expect(collation.shards).toEqual([
      expect.objectContaining({ shardId: "S1", status: "completed" }),
    ]);
    const rows = await b.store.listJobsForChain("tenant-1", "job-3025");
    expect(rows.find((r) => r.jobKey === "shard:S1")?.status).toBe("completed");
  });

  it("does not signal when the command carries no parent instance (older parent)", async () => {
    // #4192: there is no shard role on the engine path at
    // all — a shard command (with or without a parent
    // instance to signal) is refused by name, settles
    // errored, and never runs a child or touches the runner.
    let runs = 0;
    const b = makeDeps(async (req) => {
      runs += 1;
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(shardCommand({ parentWorkflowId: undefined }));
    expect(h.status).toBe("errored");
    expect((await adapter.status(h.workflowId))?.status).toBe("errored");
    expect(runs).toBe(0);
    expect(b.stored).toHaveLength(0);
    expect(b.parentStored).toHaveLength(0);
  });

  it("swallows a failed send: the parent's deadline sweep is the backstop", async () => {
    // #4192: there is no send to fail and no deadline sweep —
    // the backstop is the engine settling the run. A throwing
    // shard fails fast, start still returns complete, and the
    // Failed collation + failed legs land visibly instead of
    // the run being lost.
    const b = makeDeps(async () => {
      throw new Error("provider down");
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(1));
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    expect(b.parentStored[0]?.collation.error).toMatch(/provider down/);
    const rows = await b.store.listJobsForChain("tenant-1", "job-3025");
    expect(rows.find((r) => r.jobKey === "leg:S1")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "leg:parent")?.status).toBe("failed");
  });
});
