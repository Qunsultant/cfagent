/**
 * Issue #3028 — pins for the driver wiring: the workflow parent asks
 * the stage-runner contract which units are outstanding (resume),
 * records a deferred fan-out tail by name, and a first run behaves
 * exactly as before.
 *
 * #4192: the child-workflow flow is retired — screens run through
 * the one engine now, so the flow-direct describes below drive
 * the in-memory adapter (the engine path with canned runners)
 * instead of runParentFlow + ChildWorkflowOps, and the resume /
 * fan-out decisions the parent used to ask the contract are
 * pinned where they still live: the pure stage-runner planner
 * (src/workflows/stageRunnerPlan.ts), which the engine itself
 * consults on every run (planNext / planStageFanout /
 * fanoutCapExceeded in src/services/jobPipelineEngine.ts).
 * There is no virtual clock and no poll loop — the engine owns
 * pacing, retries, and fan-out. A throwing unit fails fast
 * (single-attempt policy).
 *
 * Two retired-flow record fields have no engine equivalent on
 * the collation and are asserted absent, not silently dropped:
 * the engine records a fan-out cap as a note on the run record
 * (ctx.notes), never as collation.fanoutCapReason, and a resume
 * skip is planNext's decision, never collation.resumedSkippedUnits
 * (finalizeScreenerCollation sets neither).
 */
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  collateShards,
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  FANOUT_CAP_EXCEEDED,
  fanoutCapExceeded,
  planNext,
  planRun,
  planStageFanout,
  resumeUnits,
} from "../src/workflows/stageRunnerPlan";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  DEFAULT_SHARD_TIMEOUT_MS,
  workflowIdForJob,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";
import {
  STAGE_RETRY_BUCKET,
  type StageRunnerCheckpoint,
  type StageRunnerStage,
} from "../src/workflows/stageRunnerPorts";

/* ------------------------------------------------------------------ */
/* Adapter fakes (mirrors tests/screener_workflows.test.ts)            */
/* ------------------------------------------------------------------ */

function makeClock(startMs = 1_000_000) {
  const now = startMs;
  return { nowMs: () => now };
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
  /** Opaque payloads the engine's per-unit store/deliver steps received. */
  stored: unknown[];
  delivered: unknown[];
  /** Parent canonical rows the finalize stored (the parent door). */
  parentStored: Parameters<
    NonNullable<ScreenerWorkflowDeps["storeParentReport"]>
  >[0][];
  runs: string[];
  deps: ScreenerWorkflowDeps;
}

function makeDeps(
  runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"],
): DepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: DepsBundle["parentStored"] = [];
  const runs: string[] = [];
  const clock = makeClock();
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen:
        runScreen ??
        (async (req) => {
          runs.push(req.universe ?? "?");
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
    nowMs: clock.nowMs,
  };
  return { store, stored, delivered, parentStored, runs, deps };
}

/** The collation the parent row carries (the door's read-back). */
async function collationFor(store: ShardJobStore, jobId: string) {
  const row = await store.latestJob("tenant-1", jobId, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
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

/* ------------------------------------------------------------------ */
/* Pure planner helpers: the retired flow's fan-out stage, as the      */
/* engine still plans it (one parallel analysis stage over the shards) */
/* ------------------------------------------------------------------ */

function fanoutStage(maxParallel: number): StageRunnerStage {
  return {
    stage: "analysis",
    execution: "parallel",
    maxParallel,
    timeoutMs: DEFAULT_SHARD_TIMEOUT_MS,
    retryBucket: STAGE_RETRY_BUCKET.analysis,
  };
}

function analysisPlan(shardIds: string[]) {
  return planRun({
    runId: "job-3028",
    invocation: "workflow-shard",
    stages: [fanoutStage(DEFAULT_MAX_PARALLEL_SHARDS)],
    units: shardIds.map((unitId) => ({ unitId })),
  });
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
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(
      command(3, { maxParallelShards: DEFAULT_MAX_PARALLEL_SHARDS }),
    );
    expect(h.status).toBe("complete");
    expect(h.existing).toBe(false);
    // Every shard ran exactly once, through the engine's six stages.
    expect(b.runs.sort()).toEqual(["U1", "U2", "U3"]);
    const collation = b.parentStored[0]?.collation;
    expect(collation).toBeDefined();
    expect(collation!.shards).toHaveLength(3);
    expect(collation!.shards.every((s) => s.status === "completed")).toBe(true);
    expect(collation!.lifecycle).toBe("ReportGenerated");
    // The engine records no cap reason and no resume skips on
    // the collation: nothing was deferred, nothing was resumed.
    expect(collation!.fanoutCapReason).toBeUndefined();
    expect(collation!.resumedSkippedUnits).toBeUndefined();
    // The parent row carries the same collation (the door's read-back).
    expect((await collationFor(b.store, "job-3028")).lifecycle).toBe("ReportGenerated");
    // Doors called once per shard by the engine's per-unit steps.
    expect(b.stored).toHaveLength(3);
    expect(b.delivered).toHaveLength(0); // deliver:false on the command
    const rows = await b.store.listJobsForChain("tenant-1", "job-3028");
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      ["job-3028", "shard:S1", "shard:S2", "shard:S3"].sort(),
    );
  });

  it("names the deferred tail when the cap forces several rounds (still runs every shard)", async () => {
    // Engine half: the cap is the engine's now — a 5-shard run
    // at maxParallelShards 2 still runs every shard exactly
    // once, never truncated; the collation carries no cap
    // reason (the engine notes the cap on the run record,
    // never on the collation).
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(5, { maxParallelShards: 2 }));
    expect(h.status).toBe("complete");
    expect(b.runs.sort()).toEqual(["U1", "U2", "U3", "U4", "U5"]);
    const collation = b.parentStored[0]?.collation;
    expect(collation!.shards).toHaveLength(5);
    expect(collation!.shards.every((s) => s.status === "completed")).toBe(true);
    expect(collation!.fanoutCapReason).toBeUndefined();
    // Planner half: the decision that names the tail still
    // lives in the stage-runner planner, which the engine
    // consults per round — the deferred tail is named, never silent.
    const plan = planRun({
      runId: "job-3028",
      invocation: "workflow-shard",
      stages: [fanoutStage(2)],
      units: ["S1", "S2", "S3", "S4", "S5"].map((unitId) => ({ unitId })),
    });
    const fanout = planStageFanout(plan.stages[0]!, plan.units);
    expect(fanout.started.map((u) => u.unitId)).toEqual(["S1", "S2"]);
    expect(fanout.deferred.map((u) => u.unitId)).toEqual(["S3", "S4", "S5"]);
    const reason = fanoutCapExceeded(fanout);
    expect(reason).toContain(FANOUT_CAP_EXCEEDED);
    expect(reason).toContain("S5");
  });

  it("a resume starts only the units the checkpoint says are outstanding", async () => {
    // Planner half: the contract's answer for this checkpoint
    // is S3 alone — completed units are never handed back.
    const plan = analysisPlan(["S1", "S2", "S3", "S4"]);
    const cp = checkpoint({ S1: "completed", S2: "completed", S3: "failed", S4: "completed" });
    expect(planNext(plan, cp)?.units.map((u) => u.unitId)).toEqual(["S3"]);
    expect(resumeUnits(plan, cp).map((r) => r.unit.unitId)).toEqual(["S3"]);
    // Engine half: the dispatch's idempotency is the same rule
    // at the run layer — a duplicate start adopts the finished
    // run and re-runs no completed unit.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h1 = await adapter.start(command(4, { maxParallelShards: 4 }));
    expect(h1.status).toBe("complete");
    expect(h1.existing).toBe(false);
    expect(b.runs).toHaveLength(4);
    const h2 = await adapter.start(command(4, { maxParallelShards: 4 }));
    expect(h2.existing).toBe(true);
    expect(h2.workflowId).toBe(h1.workflowId);
    expect(b.runs).toHaveLength(4);
    expect(b.parentStored[0]?.collation.resumedSkippedUnits).toBeUndefined();
  });

  it("a resume with nothing outstanding starts no child and does not report a false failure", async () => {
    // Planner half: every unit terminal → planNext is null,
    // and the checkpoint's own record collates completed,
    // never Failed.
    const plan = analysisPlan(["S1", "S2", "S3"]);
    const cp = checkpoint({ S1: "completed", S2: "completed", S3: "completed" });
    expect(planNext(plan, cp)).toBeNull();
    expect(resumeUnits(plan, cp)).toEqual([]);
    const recorded = collateShards(
      "job-3028",
      workflowIdForJob("job-3028"),
      ["S1", "S2", "S3"].map((shardId) => ({
        shardId,
        status: "completed" as const,
        totalScanned: 10,
        expectedCount: 10,
        matchedCount: 2,
      })),
      [],
      [],
    );
    expect(recorded.shards.every((s) => s.status === "completed")).toBe(true);
    expect(recorded.lifecycle).not.toBe("Failed");
    // Engine half: a full run settles ReportGenerated (not
    // Failed), and a duplicate start re-runs nothing.
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h1 = await adapter.start(command(3, { maxParallelShards: 2 }));
    expect(h1.status).toBe("complete");
    expect(b.parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
    expect(b.runs).toHaveLength(3);
    const h2 = await adapter.start(command(3, { maxParallelShards: 2 }));
    expect(h2.existing).toBe(true);
    expect(b.runs).toHaveLength(3);
  });

  it("re-runs the failed unit on resume while keeping the completed one", async () => {
    // Planner half: the failed unit is outstanding, the
    // completed one never is — a resume re-runs S2 only.
    const plan = analysisPlan(["S1", "S2"]);
    const cp = checkpoint({ S1: "completed", S2: "failed" });
    expect(planNext(plan, cp)?.units.map((u) => u.unitId)).toEqual(["S2"]);
    expect(resumeUnits(plan, cp).map((r) => r.unit.unitId)).toEqual(["S2"]);
    // Engine half: the engine fails fast, so a mid-run unit
    // failure takes the whole run down — the completed unit is
    // NOT kept as completed in this run's collation (the
    // analysis node's composed output is never written, so
    // the composer cannot credit S1; it fails honestly as
    // "never reached analysis"). This is the pinned engine
    // semantics (see the cutover dispatch-failure test: a
    // failed shard fails the run, the sibling is never
    // invented completed). The "keep the completed one" half
    // of this test therefore lives in the planner pin above:
    // a resume re-runs S2 only, and S1's completed record is
    // the checkpoint's, never a re-execution.
    const b = makeDeps(async (req) => {
      if (req.universe === "U2") {
        return okResult({ success: false, error: "no quotes", universe: req.universe });
      }
      return {
        ...okResult({ universe: req.universe }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(command(2, { maxParallelShards: 2 }));
    expect(h.status).toBe("complete");
    const collation = b.parentStored[0]?.collation;
    expect(collation!.lifecycle).toBe("Failed");
    expect(collation!.qualified).toBe(true);
    expect(collation!.shards.find((s) => s.shardId === "S2")?.status).toBe("failed");
    // The engine wraps the runner's error with the step/node
    // prefix (as in the cutover tests) — the cause is named.
    expect(collation!.shards.find((s) => s.shardId === "S2")?.error).toMatch(/no quotes/);
    expect(collation!.shards.find((s) => s.shardId === "S1")?.status).toBe("failed");
    expect(collation!.shards.find((s) => s.shardId === "S1")?.error).toMatch(
      /never reached analysis/i,
    );
  });
});
