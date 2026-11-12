/**
 * Issue #1737 — workflow port, collation, adapters, command
 * envelope. TDD: written against the port contract before
 * the routes land on it.
 *
 * #4192: the child-workflow flows are retired — screens run
 * through the one engine now, and the flow-direct describes
 * below drive the in-memory adapter (the engine path with
 * canned runners) instead of runShardFlow/runParentFlow.
 * The fake step executes do() immediately; there is no
 * virtual clock and no poll loop — the engine owns pacing,
 * retries, and fan-out.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { CfWorkflowAdapter, type WorkflowBindingLike } from "../src/workflows/cfWorkflowAdapter";
import { createWorkflowPorts } from "../src/workflows/createWorkflowPorts";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  collateShards,
  finalizeScreenerCollation,
  shardSummaryFromResult,
  asShardScreenResult,
  stageTransitionsForShard,
  type ScreenerWorkflowDeps,
  type ShardOutcome,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  fromWorkflowCommandEnvelope,
  toWorkflowCommandEnvelope,
} from "../src/workflows/workflowCommandEnvelope";
import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  WorkflowError,
  type ParentScreenReportInput,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function makeClock(startMs = 1_000_000) {
  const now = startMs;
  return { nowMs: () => now };
}

function parentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-1",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [
      { shardId: "TECH", universe: "TECH" },
      { shardId: "HEALTH", universe: "HEALTH" },
    ],
    deliver: true,
    ...overrides,
  };
}

function okResult(overrides: Partial<ShardScreenResult> = {}): ShardScreenResult {
  return {
    success: true,
    timestamp: "2026-10-26T12:00:00.000Z",
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    ...overrides,
  };
}

interface DepsBundle {
  store: InMemoryShardJobAdapter;
  /** Opaque payloads the child store/deliver steps received. */
  stored: unknown[];
  delivered: unknown[];
  /** Parent canonical rows the finalize stored (the parent door). */
  parentStored: ParentScreenReportInput[];
  clock: ReturnType<typeof makeClock>;
  deps: ScreenerWorkflowDeps;
}

function makeDeps(runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"]): DepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const clock = makeClock();
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      // Production runners attach `full` (the opaque full agent
      // result); the child's store/deliver steps consume it.
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
    nowMs: clock.nowMs,
  };
  return { store, stored, delivered, parentStored, clock, deps };
}

async function latestParentRow(store: ShardJobStore, jobId: string) {
  return store.latestJob("tenant-1", jobId, jobId);
}

/** The collation the parent row carries (the door's read-back). */
async function collationFor(store: ShardJobStore, jobId: string) {
  const row = await latestParentRow(store, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Port: command validation + instance ids                             */
/* ------------------------------------------------------------------ */

describe("workflow command validation", () => {
  it("accepts a well-formed parent command", () => {
    expect(assertWorkflowJobCommand(parentCommand())).toBeDefined();
  });

  it("rejects a missing jobId", () => {
    const cmd = parentCommand();
    delete (cmd as Partial<WorkflowJobCommand>).jobId;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a missing userLogin (fail closed, #1185)", () => {
    const cmd = parentCommand();
    delete (cmd as Partial<WorkflowJobCommand>).userLogin;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects an unknown command type", () => {
    const cmd = { ...parentCommand(), type: "explode" } as unknown as WorkflowJobCommand;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects an empty shard list", () => {
    expect(() => assertWorkflowJobCommand(parentCommand({ shards: [] }))).toThrow(WorkflowError);
  });

  it("rejects a symbol list over the claim-check cap", () => {
    const symbols = Array.from({ length: 201 }, (_, i) => `SYM${i}`);
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({ shards: [{ shardId: "symbols", symbols }] }),
      ),
    ).toThrow(WorkflowError);
  });

  it("rejects a shard command without parentJobId/shard", () => {
    const cmd = parentCommand({ role: "shard" });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });
});

describe("workflowIdForJob", () => {
  it("is deterministic and sanitizes ':'", () => {
    expect(workflowIdForJob("screener:scheduled:TECH:ALL:2026-10-26T12:00")).toBe(
      "screen-screener-scheduled-TECH-ALL-2026-10-26T12-00",
    );
    expect(workflowIdForJob("job-1")).toBe(workflowIdForJob("job-1"));
  });

  it("keeps the readable short form at exactly 100 chars", () => {
    const jobId = "j".repeat(93); // screen- (7) + 93 = 100
    expect(workflowIdForJob(jobId)).toBe(`screen-${jobId}`);
  });

  it("hashes long ids instead of refusing or truncating (#2065)", () => {
    const longA = `goal-screen:manual:${"u".repeat(64)}:income:2026-10-27T23:12:16.000Z`;
    const longB = `${longA}X`;
    const idA = workflowIdForJob(longA);
    const idB = workflowIdForJob(longB);
    expect(idA).toMatch(/^screen-h-[0-9a-f]{32}$/);
    expect(idA.length).toBeLessThanOrEqual(100);
    expect(workflowIdForJob(longA)).toBe(idA); // deterministic
    expect(idB).not.toBe(idA); // distinct jobs stay distinct
    expect(idA).not.toBe(workflowIdForJob("job-1"));
  });
});

/* ------------------------------------------------------------------ */
/* Collation (pure)                                                    */
/* ------------------------------------------------------------------ */

describe("collateShards", () => {
  it("all completed → Completed, unqualified, full coverage", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, matchedCount: 1 },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, matchedCount: 0 },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.qualified).toBe(false);
    expect(c.coverage).toEqual({ evaluated: 15, considered: 15, ratio: 1 });
  });

  it("one failed → Completed but qualified (partial, not failure)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10 },
      { shardId: "B", status: "failed", error: "boom", expectedCount: 10 },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.qualified).toBe(true);
    expect(c.coverage.ratio).toBe(10 / 20);
  });

  it("all failed → Failed with an error", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "failed", error: "boom" },
    ], [], []);
    expect(c.lifecycle).toBe("Failed");
    expect(c.error).toBe("boom");
  });

  it("zero considered → null ratio (never NaN)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 0, expectedCount: 0 },
    ], [], []);
    expect(c.coverage.ratio).toBeNull();
  });

  it("all completed + all stored → ReportGenerated (flags come from children)", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, stored: true, delivered: true },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, stored: true, delivered: true },
    ], [], []);
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.storedShards).toEqual(["A", "B"]);
    expect(c.deliveredShards).toEqual(["A", "B"]);
  });

  it("one completed-but-unstored shard → Completed + storeErrors map", () => {
    const c = collateShards("job-1", "screen-job-1", [
      { shardId: "A", status: "completed", totalScanned: 10, expectedCount: 10, stored: false, storeError: "R2 down" },
      { shardId: "B", status: "completed", totalScanned: 5, expectedCount: 5, stored: true },
    ], [], []);
    expect(c.lifecycle).toBe("Completed");
    expect(c.storeErrors).toEqual({ A: "R2 down" });
  });
});

describe("stageTransitionsForShard", () => {
  it("completed shard records feed+gather+analysis completed", () => {
    expect(stageTransitionsForShard({ shardId: "A", status: "completed" }, 5)).toEqual([
      { stage: "feed", outcome: "completed", atMs: 5 },
      { stage: "gather", outcome: "completed", atMs: 5 },
      { stage: "analysis", outcome: "completed", atMs: 5 },
    ]);
  });

  it("failed shard records only analysis.failed (feed/gather unobserved, not claimed)", () => {
    expect(stageTransitionsForShard({ shardId: "A", status: "failed" }, 5)).toEqual([
      { stage: "analysis", outcome: "failed", atMs: 5 },
    ]);
  });
});

describe("shard result helpers", () => {
  it("shardSummaryFromResult mirrors success", () => {
    expect(shardSummaryFromResult("A", okResult())).toMatchObject({
      shardId: "A",
      status: "completed",
      totalScanned: 10,
    });
    expect(shardSummaryFromResult("A", okResult({ success: false, error: "x" }))).toMatchObject({
      status: "failed",
      error: "x",
    });
  });

  it("asShardScreenResult rejects garbage (never crashes collation)", () => {
    expect(asShardScreenResult(null)).toBeNull();
    expect(asShardScreenResult({ success: true })).toBeNull();
    expect(asShardScreenResult(okResult())).toMatchObject({ success: true });
  });

  it("asShardScreenResult strips full but keeps child store/deliver flags", () => {
    const out = asShardScreenResult({
      ...okResult(),
      full: { bulk: "must not cross" },
      stored: true,
      delivered: false,
      deliverError: "x",
    });
    expect(out).not.toBeNull();
    expect("full" in (out ?? {})).toBe(false);
    expect(out).toMatchObject({ stored: true, delivered: false, deliverError: "x" });
  });
});

/* ------------------------------------------------------------------ */
/* Adapter: one shard runs the six engine stages                     */
/* (store + deliver per unit; the collation is the door's            */
/* read-back from the parent row)                                    */
/* ------------------------------------------------------------------ */

describe("adapter: one shard runs the six engine stages (store + deliver per unit)", () => {
  it("executes, stores + delivers its full result, projects its row, returns a stripped summary", async () => {
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    expect(h.status).toBe("complete");
    // Claim-check: bulk data never leaves the run — the
    // collation carries summaries + flags only.
    const collation = await collationFor(b.store, "job-1");
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect("full" in collation).toBe(false);
    expect(b.stored).toEqual([{ marker: "full-result", universe: "TECH", trigger: "manual" }]);
    expect(b.delivered).toEqual([{ marker: "full-result", universe: "TECH", trigger: "manual" }]);
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey)).toContain("shard:TECH");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
  });

  it("deliver=false skips the deliver step (market-data/premium shape)", async () => {
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(
      parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }], deliver: false }),
    );
    expect(h.status).toBe("complete");
    expect(b.delivered).toHaveLength(0);
    expect(b.stored).toHaveLength(1);
  });

  it("a store failure is recorded, never fatal to the screen", async () => {
    const b = makeDeps();
    b.deps.storeReport = async () => {
      throw new Error("R2 down");
    };
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    expect(h.status).toBe("complete");
    const collation = await collationFor(b.store, "job-1");
    expect(collation.lifecycle).toBe("Completed");
    expect(collation.storeErrors).toEqual({ TECH: "R2 down" });
    expect((collation.shards as { stored?: boolean }[])[0]?.stored).toBe(false);
  });

  it("a deliver failure is recorded, never fatal", async () => {
    const b = makeDeps();
    b.deps.deliverOutcome = async () => {
      throw new Error("pipeline down");
    };
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    expect(h.status).toBe("complete");
    const collation = await collationFor(b.store, "job-1");
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.deliverErrors).toEqual({ TECH: "pipeline down" });
  });

  it("a failed screen fails the run loudly (failed leg rows + Failed collation)", async () => {
    // #4192: the engine path has no child to store a failed
    // screen's payload — a market failure throws at analysis,
    // the unit fails, and the attempt record is the failed
    // leg rows + the Failed collation on the parent canonical
    // row (never a canonical report). The collation itself is
    // the dispatch return; the adapter path reads it back
    // from the parent door, the way the cutover tests do.
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    expect(h.status).toBe("complete");
    expect(b.stored).toHaveLength(0);
    expect(b.delivered).toHaveLength(0);
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    // Slice-2 rule: a failed leg keys as leg:<stepId> (no job id).
    expect(rows.find((r) => r.jobKey === "leg:TECH")?.status).toBe("failed");
    const failedParent = await b.store.latestJob("tenant-1", "job-1", "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/1 shards/);
  });

  it("a throwing runner fails the run (Failed collation; only failed legs land)", async () => {
    const b = makeDeps(async () => {
      throw new Error("provider down");
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    // The run settles (complete) with a Failed collation —
    // a throwing unit is a failed run, not an execution
    // error; only an infra failure errors the adapter.
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    expect(b.parentStored[0]?.collation.error).toMatch(/provider down/);
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.find((r) => r.jobKey === "leg:TECH")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "leg:parent")?.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ */
/* Parent flow                                                         */
/* ------------------------------------------------------------------ */

describe("adapter: parent dispatches via the engine (collates unit flags; never stores or delivers itself)", () => {
  // The runner records a pdf key per universe, the way the
  // old tests' faked child outputs did.
  function pdfDeps() {
    return makeDeps(async (req) => ({
      ...okResult({ universe: req.universe, pdfKey: `pdf-${(req.universe ?? "").toLowerCase()}` }),
      full: { marker: "full-result", universe: req.universe },
    }));
  }

  it("happy path: 2 stored shards → ReportGenerated, rows projected, doors called once per shard", async () => {
    const b = pdfDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    const c = await collationFor(b.store, "job-1");
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(false);
    expect(c.reportKeys).toEqual(["pdf-tech", "pdf-health"]);
    expect(c.storedShards).toEqual(["TECH", "HEALTH"]);
    expect(c.deliveredShards).toEqual(["TECH", "HEALTH"]);
    // The parent never calls store/deliver itself: the
    // ENGINE's per-unit store/deliver steps call the doors,
    // once per shard, with the full payloads.
    expect(b.stored).toHaveLength(2);
    expect(b.delivered).toHaveLength(2);
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(parentRow?.status).toBe("completed");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-1", "shard:HEALTH", "shard:TECH"].sort(),
    );
  });

  it("a completed-but-unstored shard → Completed (not ReportGenerated) + storeErrors", async () => {
    const b = pdfDeps();
    b.deps.storeReport = async (payload) => {
      if ((payload as { universe?: string }).universe === "TECH") {
        throw new Error("R2 down");
      }
      b.stored.push(payload);
    };
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    const c = await collationFor(b.store, "job-1");
    expect(c.lifecycle).toBe("Completed");
    expect(c.storeErrors).toEqual({ TECH: "R2 down" });
    expect(c.storedShards).toEqual(["HEALTH"]);
  });

  it("timeout: a timed_out shard → qualified partial, BudgetConstrained", async () => {
    // #4192: the engine has no poll loop — a hanging unit is
    // the engine's timeout, not the screener's. What this
    // pins is the collation's handling of a timed_out shard:
    // the usable shards still reach ReportGenerated, the run
    // is qualified, and BudgetConstrained is recorded.
    const b = makeDeps();
    const outcomes: ShardOutcome[] = [
      { shardId: "TECH", status: "completed", totalScanned: 10, expectedCount: 10, matchedCount: 2, stored: true, delivered: true },
      { shardId: "HEALTH", status: "timed_out", error: "deadline exceeded" },
    ];
    const c = await finalizeScreenerCollation(
      { shardStore: b.store, nowMs: b.clock.nowMs },
      {
        command: parentCommand(),
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
    expect(c.shards.find((s) => s.shardId === "HEALTH")?.status).toBe("timed_out");
    expect(c.lifecycleTransitions.map((t) => t.lifecycle)).toContain("BudgetConstrained");
  });

  it("all failed → Failed", async () => {
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    const failedParent = await b.store.latestJob("tenant-1", "job-1", "leg:parent");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/2 shards/);
  });

  it("malformed stage output → failed shard, never a collation crash", async () => {
    const b = makeDeps(async (req) => {
      if (req.universe === "TECH") {
        // A result missing its counts: the composer's
        // validation fails the shard, never a collation crash.
        return {
          success: true,
          timestamp: "2026-10-26T12:00:00.000Z",
        } as unknown as ShardScreenResult;
      }
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    const c = await collationFor(b.store, "job-1");
    expect((c.shards as { shardId: string; status: string }[]).find((s) => s.shardId === "TECH")?.status).toBe("failed");
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(true);
  });

  it("three shards all run once (fan-out batching is the engine's now)", async () => {
    // #4192: maxParallelShards sequenced child creation; the
    // engine owns fan-out now, so this pins that every shard
    // runs exactly once and projects its row — not the order.
    const seen: string[] = [];
    const b = makeDeps(async (req) => {
      seen.push(req.universe ?? "?");
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const shards = ["A", "B", "C"].map((s) => ({ shardId: s, universe: s }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ shards }));
    expect(h.status).toBe("complete");
    expect(seen.sort()).toEqual(["A", "B", "C"]);
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-1", "shard:A", "shard:B", "shard:C"].sort(),
    );
  });

  it("prod-shaped over-long jobId reaches announce (#2129)", async () => {
    // The 07:56 goal run's jobId shape: 115 chars, over the 100-char
    // provider ceiling. Before #2123 the parent flow threw computing
    // its workflow id before the announce step, so no row ever
    // landed. The engine path must complete and project rows for it.
    const longJobId = `goal-screen:manual:${"a".repeat(64)}:income:2026-10-28T11:56:42.466Z`;
    expect(longJobId.length).toBe(115);
    const b = pdfDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand({ jobId: longJobId }));
    expect(h.status).toBe("complete");
    const c = await collationFor(b.store, longJobId);
    expect(c.lifecycle).toBe("ReportGenerated");
    const rows = await b.store.listJobsForChain("tenant-1", longJobId);
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      [longJobId, "shard:HEALTH", "shard:TECH"].sort(),
    );
    const parentRow = await latestParentRow(b.store, longJobId);
    expect(parentRow?.status).toBe("completed");
  });

  it("an unprojected announce warns with chain + stage but does not fail the flow (#2129)", async () => {
    // projectBestEffort's silent no-op hid vanished runs: the
    // panel polled an empty history with no worker-log trace.
    const b = makeDeps();
    const deps = { ...b.deps, shardStore: null };
    // #4192: the retired flow warned with a plain
    // console.warn; the collation warns through the
    // structured logger, whose console sink writes the JSON
    // event via console.info.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const adapter = new InMemoryWorkflowAdapter(deps);
      const h = await adapter.start(parentCommand());
      expect(h.status).toBe("complete");
      const warned = info.mock.calls.map((args) => String(args[0]));
      expect(warned.some((m) => m.includes("job-1") && m.includes("feed"))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Adapters: conformance (same suite, both adapters)                   */
/* ------------------------------------------------------------------ */

function fakeBinding() {
  const instances = new Map<string, { status: WorkflowInstanceStatus; output?: unknown }>();
  let createCalls = 0;
  const binding: WorkflowBindingLike = {
    create: async ({ id }) => {
      createCalls += 1;
      if (instances.has(id)) throw new Error("already exists");
      instances.set(id, { status: "queued" });
      return { id };
    },
    get: async (id) => {
      const rec = instances.get(id);
      if (!rec) throw new Error("not found");
      return {
        id,
        status: async () => ({ status: rec.status, output: rec.output }),
      };
    },
  };
  return { binding, instances, getCreateCalls: () => createCalls };
}

describe("adapter conformance: start/status/idempotency", () => {
  it("provider adapter over a fake binding: start, duplicate adopts, unknown status null", async () => {
    const { binding, getCreateCalls } = fakeBinding();
    const adapter = new CfWorkflowAdapter(binding);
    const cmd = parentCommand();
    const h1 = await adapter.start(cmd);
    expect(h1.existing).toBe(false);
    expect(h1.statusUrl).toBe("/api/jobs/history?chainId=job-1");
    const h2 = await adapter.start(cmd);
    expect(h2.existing).toBe(true);
    expect(h2.workflowId).toBe(h1.workflowId);
    expect(getCreateCalls()).toBe(2);
    expect(await adapter.status("nope")).toBeNull();
    await expect(adapter.start(parentCommand({ jobId: "" }))).rejects.toThrow(WorkflowError);
  });

  it("in-memory adapter: start runs the engine, duplicate start never re-executes", async () => {
    let runs = 0;
    const b = makeDeps(async (req) => {
      runs += 1;
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h1 = await adapter.start(parentCommand());
    expect(h1.existing).toBe(false);
    expect(h1.status).toBe("complete");
    expect(runs).toBe(2);
    // Real units ran: each stored + delivered its own full
    // result (the parent never touches store/deliver).
    expect(b.stored).toHaveLength(2);
    expect(b.delivered).toHaveLength(2);
    const h2 = await adapter.start(parentCommand());
    expect(h2.existing).toBe(true);
    expect(runs).toBe(2);
    const st = await adapter.status(h1.workflowId);
    expect(st?.jobId).toBe("job-1");
    expect(await adapter.status("missing")).toBeNull();
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    // Real units ran: their rows exist (finalize
    // project-final dedups against them via the replay rule,
    // never duplicates).
    const rows = await b.store.listJobsForChain("tenant-1", "job-1");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-1", "shard:HEALTH", "shard:TECH"].sort(),
    );
  });

  it("composition root returns null without bindings, adapter with both", () => {
    expect(createWorkflowPorts({})).toBeNull();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: {} })).toBeNull();
    const { binding } = fakeBinding();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: binding })).toBeNull();
    expect(createWorkflowPorts({ SCREENER_WORKFLOW: binding, AGENT_DB: {} })).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Command envelope                                                    */
/* ------------------------------------------------------------------ */

describe("workflow command envelope", () => {
  it("round-trips a command", () => {
    const cmd = parentCommand();
    const env = toWorkflowCommandEnvelope(cmd, "2026-10-26T12:00:00.000Z");
    expect(env.specversion).toBe("1.0");
    expect(env.type).toBe("run-screen");
    expect(env.id).toBe("workflow-command:run-screen:job-1");
    expect(fromWorkflowCommandEnvelope(env)).toEqual(cmd);
  });

  it("rejects non-run-screen envelopes and invalid commands", () => {
    const env = toWorkflowCommandEnvelope(parentCommand());
    expect(fromWorkflowCommandEnvelope({ ...env, type: "screener.completed" })).toBeNull();
    const bad = { ...parentCommand(), userLogin: "" };
    expect(fromWorkflowCommandEnvelope({ ...env, data: bad })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Port purity (provider-neutral domain surface)                       */
/* ------------------------------------------------------------------ */

describe("port purity (provider-neutral domain surface)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");
  const noProviderConcepts = (src: string) => {
    expect(src.toLowerCase()).not.toContain("cloudflare");
    expect(src).not.toContain("Queue<");
    expect(src).not.toContain(".ack(");
    expect(src).not.toContain(".retry(");
  };

  it("port, collation, envelope, in-memory adapter, and composition root carry no provider concepts", () => {
    for (const f of [
      "src/workflows/workflowPorts.ts",
      "src/workflows/screenerCollation.ts",
      "src/workflows/screenerWorkflowFlow.deprecated.ts",
      "src/workflows/workflowCommandEnvelope.ts",
      "src/workflows/inMemoryWorkflowAdapter.ts",
      "src/workflows/createWorkflowPorts.ts",
    ]) {
      noProviderConcepts(read(f));
    }
  });
});

describe("shard artifact keys and trigger (#2080)", () => {
  it("keeps xlsx/csv keys through the summary and the child-output validation", () => {
    const result: ShardScreenResult = {
      ...okResult(),
      pdfKey: "screener:pdf:p",
      xlsxKey: "screener:xlsx:x",
      csvKey: "screener:csv:c",
      trigger: "scheduled",
    };
    const summary = shardSummaryFromResult("TECH", result);
    expect(summary.xlsxKey).toBe("screener:xlsx:x");
    expect(summary.csvKey).toBe("screener:csv:c");
    const parsed = asShardScreenResult(result);
    expect(parsed?.xlsxKey).toBe("screener:xlsx:x");
    expect(parsed?.csvKey).toBe("screener:csv:c");
    expect(parsed?.trigger).toBe("scheduled");
  });

  it("stores the trigger and artifact keys on the canonical payload", async () => {
    const b = makeDeps(async (req) => ({
      ...okResult({ universe: req.universe }),
      xlsxKey: "screener:xlsx:x",
      csvKey: "screener:csv:c",
      full: { marker: "full-result", universe: req.universe },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    await adapter.start(parentCommand({ shards: [{ shardId: "TECH", universe: "TECH" }] }));
    expect(b.stored[0]).toMatchObject({
      trigger: "manual",
      xlsxKey: "screener:xlsx:x",
      csvKey: "screener:csv:c",
      marker: "full-result",
    });
  });
});
