/**
 * Issue #2601 seam C — pins for the workflow parent's fan-out moving onto
 * the stage-runner contract.
 *
 * #4192: the child-workflow flow is retired — screens run through the
 * one engine now, and the tests below drive the in-memory adapter
 * (the engine path with a canned runner) instead of runParentFlow /
 * ChildWorkflowOps / a fake step clock. There is no virtual clock,
 * no poll loop, and no batch-step ledger: the engine owns pacing,
 * retries, and fan-out, so `maxParallelShards` no longer partitions
 * the run into `fan-out-batch-*` steps — it is carried on the
 * command and validated, and every shard runs exactly once
 * regardless of the cap. What this file pins now is the seam
 * itself: the six screener stages (feed/gather/analysis/store/
 * serve/deliver) run in order per unit, the stage ledger records
 * each stage (readable via the collation's stageTransitions and
 * the shard rows), and a failure is attributed to its stage.
 */
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  type ParentScreenReportInput,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/** The six engine stages, in the order they run per unit. */
const SIX_STAGES = ["feed", "gather", "analysis", "store", "serve", "deliver"];

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
  seen: string[];
  stored: unknown[];
  delivered: unknown[];
  /** Parent canonical rows the finalize stored (the parent door). */
  parentStored: ParentScreenReportInput[];
  deps: ScreenerWorkflowDeps;
}

function makeDeps(
  runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"],
): DepsBundle {
  const store = new InMemoryShardJobAdapter();
  const seen: string[] = [];
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen:
        runScreen ??
        (async (req) => {
          seen.push(req.universe ?? "?");
          return {
            ...okResult({ universe: req.universe }),
            full: { marker: "full-result", universe: req.universe },
          };
        }),
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
  return { store, seen, stored, delivered, parentStored, deps };
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

/** The collation the parent row carries (the door's read-back). */
async function collationFor(store: InMemoryShardJobAdapter, jobId: string) {
  const row = await store.latestJob("tenant-1", jobId, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
}

describe("seam C — workflow fan-out on the stage-runner contract (#2601)", () => {
  it("keeps the exact batch plan at the command's cap (2,2,1 for five shards) — the engine runs all five once, no batch dropped", async () => {
    // #4192: the cap no longer partitions the run into
    // fan-out-batch-* steps — the engine owns fan-out now,
    // so this pins the intent behind the old batch plan:
    // all five shards run exactly once, each completes,
    // and each unit's six stages are recorded in order.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(5, { maxParallelShards: 2 }));
    expect(h.status).toBe("complete");
    expect(b.seen.sort()).toEqual(["U1", "U2", "U3", "U4", "U5"]);
    const collation = await collationFor(b.store, "job-5");
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect((collation.shards as { status: string }[]).every((s) => s.status === "completed")).toBe(true);
    expect((collation.shards as unknown[])).toHaveLength(5);
    const transitions = collation.stageTransitions as { stage: string; outcome: string }[];
    expect(transitions).toHaveLength(5 * SIX_STAGES.length);
    for (let i = 0; i < 5; i++) {
      expect(transitions.slice(i * 6, (i + 1) * 6).map((t) => t.stage)).toEqual(SIX_STAGES);
      expect(transitions.slice(i * 6, (i + 1) * 6).every((t) => t.outcome === "completed")).toBe(true);
    }
    const rows = await b.store.listJobsForChain("tenant-1", "job-5");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-5", "shard:S1", "shard:S2", "shard:S3", "shard:S4", "shard:S5"].sort(),
    );
    expect(rows.filter((r) => r.jobKey.startsWith("shard:")).every((r) => r.status === "completed")).toBe(true);
  });

  it("uses the shared default cap when the command names none — every shard still runs once", async () => {
    // #4192: with no cap named the command validates
    // against the port's shared default and the engine
    // runs every shard once — the default is the fallback
    // for the (retired) partitioner, never a reason to
    // drop a shard.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(DEFAULT_MAX_PARALLEL_SHARDS + 1));
    expect(h.status).toBe("complete");
    expect(b.seen).toHaveLength(DEFAULT_MAX_PARALLEL_SHARDS + 1);
    expect(b.seen.sort()).toEqual(["U1", "U2", "U3", "U4", "U5"]);
    const collation = await collationFor(b.store, "job-5");
    expect((collation.shards as unknown[])).toHaveLength(DEFAULT_MAX_PARALLEL_SHARDS + 1);
    expect((collation.shards as { status: string }[]).every((s) => s.status === "completed")).toBe(true);
  });

  it("starts every shard even when the cap forces several rounds (tail is deferred, never dropped) — all seven run once", async () => {
    // #4192: the tail shards the old partitioner deferred
    // to later batches now run through the engine with the
    // rest — a cap of 3 over 7 shards drops nothing.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(7, { maxParallelShards: 3 }));
    expect(h.status).toBe("complete");
    expect(b.seen.sort()).toEqual(["U1", "U2", "U3", "U4", "U5", "U6", "U7"]);
    const collation = await collationFor(b.store, "job-5");
    expect((collation.shards as unknown[])).toHaveLength(7);
    expect((collation.shards as { status: string }[]).every((s) => s.status === "completed")).toBe(true);
    const rows = await b.store.listJobsForChain("tenant-1", "job-5");
    expect(rows.filter((r) => r.jobKey.startsWith("shard:")).map((r) => r.jobKey).sort()).toEqual(
      ["shard:S1", "shard:S2", "shard:S3", "shard:S4", "shard:S5", "shard:S6", "shard:S7"].sort(),
    );
  });

  it("six stages run in order per unit, recorded in the collation's stage ledger", async () => {
    // The stage-runner seam itself, on the engine path:
    // feed → gather → analysis → store → serve → deliver
    // per unit, each completed, readable back from the
    // parent canonical row the finalize stored.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(2));
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    const collation = b.parentStored[0]?.collation;
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.stageTransitions).toEqual([
      ...SIX_STAGES.map((stage) => ({ stage, outcome: "completed", atMs: 1_000_000 })),
      ...SIX_STAGES.map((stage) => ({ stage, outcome: "completed", atMs: 1_000_000 })),
    ]);
    // The same ledger is what the parent row carries.
    const readBack = await collationFor(b.store, "job-5");
    expect(readBack.stageTransitions).toEqual(collation.stageTransitions);
  });

  it("a failing screen is attributed to its stage (analysis) in the ledger and the failed legs", async () => {
    // #4192: a market failure throws at analysis — the unit
    // fails fast, never stores or delivers, and the ledger
    // names the stage: the failing shard records feed +
    // gather completed and analysis failed, with no
    // store/serve/deliver entries anywhere; the other shard
    // never reaches analysis. The attempt record is the
    // failed leg rows + the Failed collation.
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(2));
    expect(h.status).toBe("complete");
    expect(b.stored).toHaveLength(0);
    expect(b.delivered).toHaveLength(0);
    expect(b.parentStored).toHaveLength(1);
    const collation = b.parentStored[0]?.collation;
    expect(collation.lifecycle).toBe("Failed");
    expect(collation.shards[0]?.status).toBe("failed");
    expect(collation.shards[0]?.error).toMatch(/screener\.analysis/);
    expect(collation.shards[0]?.error).toMatch(/no quotes/);
    expect(collation.shards[1]?.status).toBe("failed");
    expect(collation.shards[1]?.error).toMatch(/never reached analysis/i);
    const transitions = collation.stageTransitions as { stage: string; outcome: string }[];
    expect(transitions.map((t) => `${t.stage}:${t.outcome}`)).toEqual([
      "feed:completed",
      "gather:completed",
      "analysis:failed",
      "feed:completed",
      "gather:completed",
    ]);
    const rows = await b.store.listJobsForChain("tenant-1", "job-5");
    expect(rows.find((r) => r.jobKey === "leg:S1")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "leg:S2")?.status).toBe("failed");
    const failedParent = await b.store.latestJob("tenant-1", "job-5", "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/2 shards/);
  });
});
