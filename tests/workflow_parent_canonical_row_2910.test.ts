/**
 * Issue #2910 (G3) — workflow parent canonical row: one
 * Docs/Reports row per parent run, shard rows absorbed.
 *
 * #4192: the child-workflow flows are retired — screens run
 * through the one engine now, and the parent canonical row
 * lands through the engine path's finalize
 * (`finalizeScreenerCollation` in screenerCollation.ts),
 * driven here through the in-memory adapter (the engine
 * path with canned runners) with a recording
 * storeParentReport fake (the parent door). There is no
 * child-workflow machinery, no poll loop, no virtual clock.
 *
 * Pins (intents carried over from the retired flow):
 * - The finalize stores one parent row (via the injected
 *   storeParentReport seam) carrying the collation, the
 *   qualified-partial marking, per-format keys, and the
 *   child linkage (market childRunIds from shard
 *   timestamps, childReportIds from child doors), and the
 *   projected parent row carries the same collation.
 * - A throwing parent store is recorded, never fatal.
 * - Without the seam the collation still stands, with no
 *   parentReport outcome (older fakes keep working).
 * - A failed run still stores the parent canonical row
 *   (Failed collation) plus the announce + failed-leg rows.
 * - A duplicate start adopts the run: the parent row is
 *   stored exactly once.
 * - mergeRunSummaries absorbs shard rows (canonical and
 *   feed) into the parent row on both joins, and never
 *   absorbs the parent row itself.
 * - persistParentScreenReportCanonical writes exactly one
 *   mas_reports row keyed generationId = jobId, with the
 *   collation + linkage in the body, and a second write
 *   under the same job id adopts (never duplicates) it.
 *
 * Engine note on childRunIds: the retired flow derived one
 * distinct timestamp per child run; the engine derives each
 * shard's timestamp from the run's feed stage, so all
 * shards of one run share the run's feed timestamp and the
 * linkage is one `screener:<timestamp>` entry per shard.
 * The distinct-timestamp derivation itself is pinned at
 * the finalize level below, where outcomes carry their
 * own timestamps.
 */
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { MockSqlStorage } from "./mock-sql";
import type { ReportDispatchContext } from "../src/agents/orchestrator/reportDispatch";
import { persistParentScreenReportCanonical } from "../src/agents/orchestrator/reportDispatch";
import {
  getCanonicalReport,
  listScheduledReports,
} from "../src/services/scheduledReports";
import {
  mergeRunSummaries,
  runSummaryFromReport,
  type RunSummary,
} from "../src/services/runSummaries";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  asShardScreenResult,
  finalizeScreenerCollation,
  type ScreenerWorkflowDeps,
  type ShardOutcome,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  type ParentScreenReportInput,
  type WorkflowCollation,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/* ------------------------------------------------------------------ */
/* Adapter fakes (mirrors tests/screener_workflows.test.ts)           */
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
  /** Opaque payloads the store/deliver steps received. */
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
      return { stored: true, reportId: "parent-report-1" };
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

/** The engine feed timestamp every shard of this run shares. */
const FEED_TIMESTAMP = new Date(1_000_000).toISOString();

/* ------------------------------------------------------------------ */
/* Parent canonical row, via the engine (adapter)                      */
/* ------------------------------------------------------------------ */

describe("adapter: parent canonical row (#2910)", () => {
  it("stores one parent row with collation + child linkage, qualified on partial failure", async () => {
    // #4192: the retired flow's partial failure was a child
    // returning success:false; on the engine a market
    // failure throws at analysis and fails the whole run, so
    // the qualified-partial shape is a shard whose stage
    // output is malformed (counts missing): the composer
    // fails that shard, the usable shard still reaches
    // ReportGenerated, and the run is qualified — the same
    // intent, in engine terms.
    const b = makeDeps(async (req) => {
      if (req.universe === "HEALTH") {
        return {
          success: true,
          timestamp: "2026-10-26T12:05:00.000Z",
        } as unknown as ShardScreenResult;
      }
      return {
        ...okResult({ universe: req.universe, pdfKey: "pdf-tech", xlsxKey: "xlsx-tech" }),
        full: { marker: "full-result", universe: req.universe },
      };
    });
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]!.jobId).toBe("job-1");
    expect(b.parentStored[0]!.userLogin).toBe("alice");
    expect(b.parentStored[0]!.trigger).toBe("manual");
    // Market shards link by canonical run id derived from
    // the shard timestamp — one entry per shard. The engine
    // feed timestamp is the run's now, shared by shards.
    expect(b.parentStored[0]!.childRunIds).toEqual([
      `screener:${FEED_TIMESTAMP}`,
      `screener:${FEED_TIMESTAMP}`,
    ]);
    // Qualified partial: one shard failed, the run is not complete.
    // Lifecycle stays ReportGenerated: the one completed shard was
    // stored by its unit (lifecycle is computed from unit flags).
    expect(b.parentStored[0]!.collation.qualified).toBe(true);
    expect(b.parentStored[0]!.collation.lifecycle).toBe("ReportGenerated");
    expect(b.parentStored[0]!.collation.reportKeys).toEqual(["pdf-tech"]);
    expect(b.parentStored[0]!.collation.xlsxKeys).toEqual(["xlsx-tech"]);
    expect(b.parentStored[0]!.collation.parentReport).toEqual({
      stored: true,
      reportId: "parent-report-1",
    });
    expect(b.parentStored[0]!.collation.childRunIds).toEqual(
      b.parentStored[0]!.childRunIds,
    );
    // The projected parent row carries the same collation.
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(parentRow?.status).toBe("completed");
    const projected = await collationFor(b.store, "job-1");
    expect(projected.lifecycle).toBe("ReportGenerated");
    expect(projected.qualified).toBe(true);
    expect(projected.childRunIds).toEqual(b.parentStored[0]!.childRunIds);
  });

  it("carries child report ids from child doors into the parent linkage", async () => {
    // #4192: the retired flow read reportIds off child
    // outputs; on the engine the child's store door returns
    // the canonical report id, the store step records it on
    // the shard output, and the finalize links it.
    const b = makeDeps(async (req) => ({
      ...okResult({ universe: req.universe }),
      full: { marker: "full-result", universe: req.universe },
    }));
    b.deps.storeReport = async (payload) => {
      b.stored.push(payload);
      return (payload as { universe?: string }).universe === "TECH"
        ? "goal-child-report-1"
        : "goal-child-report-2";
    };
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]!.childReportIds).toEqual([
      "goal-child-report-1",
      "goal-child-report-2",
    ]);
    expect(b.parentStored[0]!.collation.childReportIds).toEqual([
      "goal-child-report-1",
      "goal-child-report-2",
    ]);
    const projected = await collationFor(b.store, "job-1");
    expect(projected.childReportIds).toEqual([
      "goal-child-report-1",
      "goal-child-report-2",
    ]);
    expect(asShardScreenResult(okResult({ reportId: "r-1" }))).toMatchObject({
      reportId: "r-1",
    });
  });

  it("a throwing parent store is recorded, never fatal", async () => {
    const b = makeDeps();
    // The finalize projects the parent row BEFORE the store
    // step, so the projected row is a snapshot without the
    // store outcome — the storeError is recorded on the
    // collation itself, which the door received live: the
    // fake records its input, then throws.
    b.deps.storeParentReport = async (input) => {
      b.parentStored.push(input);
      throw new Error("store exploded");
    };
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]!.collation.parentReport).toEqual({
      stored: false,
      storeError: "store exploded",
    });
    const projected = await collationFor(b.store, "job-1");
    expect(projected.lifecycle).toBe("ReportGenerated");
  });

  it("without the seam the collation still stands, with no parentReport outcome", async () => {
    const b = makeDeps();
    const depsWithoutSeam: ScreenerWorkflowDeps = { ...b.deps };
    delete depsWithoutSeam.storeParentReport;
    const adapter = new InMemoryWorkflowAdapter(depsWithoutSeam);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.parentStored).toHaveLength(0);
    const projected = await collationFor(b.store, "job-1");
    expect(projected.lifecycle).toBe("ReportGenerated");
    expect(projected.parentReport).toBeUndefined();
    expect(projected.childRunIds).toHaveLength(2);
  });

  it("a failed run still stores the parent canonical row (Failed collation)", async () => {
    // A market failure throws at analysis: the unit fails,
    // the run settles complete with a Failed collation, and
    // the parent canonical row still lands — plus the
    // announce row (submitted, keyed by job id) and the
    // failed parent leg.
    const b = makeDeps(async (req) => ({
      ...okResult({ success: false, error: "no quotes", universe: req.universe }),
      full: { marker: "full-failed" },
    }));
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h = await adapter.start(parentCommand());
    expect(h.status).toBe("complete");
    expect(b.stored).toHaveLength(0);
    expect(b.delivered).toHaveLength(0);
    expect(b.parentStored).toHaveLength(1);
    expect(b.parentStored[0]?.collation.lifecycle).toBe("Failed");
    const announceRow = await latestParentRow(b.store, "job-1");
    expect(announceRow?.status).toBe("submitted");
    const failedParent = await b.store.latestJob("tenant-1", "job-1", "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(
      /Workflow Failed: 0\/2 shards/,
    );
  });

  it("a duplicate start adopts the run and stores the parent row once", async () => {
    const b = makeDeps();
    const adapter = new InMemoryWorkflowAdapter(b.deps);
    const h1 = await adapter.start(parentCommand());
    expect(h1.existing).toBe(false);
    expect(h1.status).toBe("complete");
    expect(b.parentStored).toHaveLength(1);
    const h2 = await adapter.start(parentCommand());
    expect(h2.existing).toBe(true);
    expect(b.parentStored).toHaveLength(1);
    const parentRow = await latestParentRow(b.store, "job-1");
    expect(parentRow?.status).toBe("completed");
  });
});

/* ------------------------------------------------------------------ */
/* Parent linkage at the finalize level                                */
/* ------------------------------------------------------------------ */

describe("finalizeScreenerCollation parent linkage (#2910)", () => {
  it("derives child run ids from per-shard timestamps, qualified on partial failure", async () => {
    // The retired flow's exact linkage assertion, at the
    // engine finalize that now computes it: outcomes carry
    // their own timestamps, so distinct shard timestamps
    // give distinct child run ids.
    const store = new InMemoryShardJobAdapter();
    const captured: ParentScreenReportInput[] = [];
    const clock = makeClock();
    const outcomes: ShardOutcome[] = [
      {
        shardId: "TECH",
        status: "completed",
        timestamp: "2026-10-26T12:00:00.000Z",
        totalScanned: 10,
        expectedCount: 10,
        matchedCount: 2,
        pdfKey: "pdf-tech",
        xlsxKey: "xlsx-tech",
        stored: true,
        delivered: true,
      },
      {
        shardId: "HEALTH",
        status: "failed",
        timestamp: "2026-10-26T12:05:00.000Z",
        totalScanned: 0,
        expectedCount: 10,
        matchedCount: 0,
        error: "boom",
      },
    ];
    const collation = await finalizeScreenerCollation(
      {
        shardStore: store,
        storeParentReport: async (input) => {
          captured.push(input);
          return { stored: true, reportId: "parent-report-1" };
        },
        nowMs: clock.nowMs,
      },
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
    expect(captured).toHaveLength(1);
    expect(captured[0]!.jobId).toBe("job-1");
    expect(captured[0]!.userLogin).toBe("alice");
    expect(captured[0]!.trigger).toBe("manual");
    // Market shards link by canonical run id derived from the shard timestamp.
    expect(captured[0]!.childRunIds).toEqual([
      "screener:2026-10-26T12:00:00.000Z",
      "screener:2026-10-26T12:05:00.000Z",
    ]);
    // Qualified partial: one shard failed, the run is not complete.
    // Lifecycle stays ReportGenerated: the one completed shard was
    // stored by its unit (lifecycle is computed from unit flags).
    expect(captured[0]!.collation.qualified).toBe(true);
    expect(captured[0]!.collation.lifecycle).toBe("ReportGenerated");
    expect(captured[0]!.collation.reportKeys).toEqual(["pdf-tech"]);
    expect(captured[0]!.collation.xlsxKeys).toEqual(["xlsx-tech"]);
    expect(collation.parentReport).toEqual({ stored: true, reportId: "parent-report-1" });
    expect(collation.childRunIds).toEqual(captured[0]!.childRunIds);
    // The projected parent row carries the same collation.
    const projected = await collationFor(store, "job-1");
    expect(projected.lifecycle).toBe("ReportGenerated");
    expect(projected.childRunIds).toEqual(captured[0]!.childRunIds);
  });
});

/* ------------------------------------------------------------------ */
/* Runs merge absorption                                               */
/* ------------------------------------------------------------------ */

function screenerSummary(overrides: Partial<RunSummary>): RunSummary {
  return {
    kind: "screener",
    id: "detail-1",
    runId: "screener:2026-10-26T12:00:00.000Z",
    title: "Market screen — TECH (manual)",
    summary: "Scanned 10 symbols, 2 matched.",
    trigger: "manual",
    createdAt: "2026-10-26T12:00:00.000Z",
    status: "completed",
    resultCount: 2,
    pdfKey: "pdf-tech",
    reportUrl: "/api/screener/report.pdf?key=pdf-tech",
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: "generated",
    pdfError: null,
    xlsxStatus: null,
    xlsxError: null,
    csvStatus: null,
    csvError: null,
    reportId: null,
    scanRunId: null,
    source: "screener",
    runSource: "stock",
    ...overrides,
  };
}

describe("mergeRunSummaries parent absorption (#2910)", () => {
  it("one parent run is one top-level row: shard canonical + feed rows are absorbed, parent survives", () => {
    const parentBody = JSON.stringify({
      parentJobId: "job-1",
      trigger: "manual",
      success: true,
      lifecycle: "Completed",
      qualified: true,
      coverage: { evaluated: 10, considered: 20, ratio: 0.5 },
      shards: [{ shardId: "TECH", status: "completed" }, { shardId: "HEALTH", status: "failed" }],
      childRunIds: ["screener:2026-10-26T12:00:00.000Z", "screener:2026-10-26T12:05:00.000Z"],
      childReportIds: [],
      reportKeys: ["pdf-tech"],
      pdfKey: "pdf-tech",
      pdfStatus: "generated",
    });
    const parent = runSummaryFromReport({
      id: "parent-report-1",
      runId: "job-1",
      title: "Market screen (parent run) — manual",
      source: "screener",
      summary: "Parent screen run: 1/2 shards completed.",
      body: parentBody,
      createdAt: "2026-10-26T12:10:00.000Z",
      bodyR2Key: null,
      fanoutOutcome: null,
    });
    expect(parent.childRunIds).toEqual([
      "screener:2026-10-26T12:00:00.000Z",
      "screener:2026-10-26T12:05:00.000Z",
    ]);
    const shardCanonical = screenerSummary({
      id: "shard-report-1",
      reportId: "shard-report-1",
      createdAt: "2026-10-26T12:00:00.000Z",
    });
    const shardFeed = screenerSummary({
      id: "screener:2026-10-26T12:05:00.000Z",
      runId: "screener:2026-10-26T12:05:00.000Z",
      createdAt: "2026-10-26T12:05:00.000Z",
    });
    const merged = mergeRunSummaries([[parent, shardCanonical], [shardFeed]], 50);
    expect(merged.map((r) => r.id)).toEqual(["parent-report-1"]);
    expect(merged[0]!.childRunIds).toHaveLength(2);
  });

  it("goal join: a child row is absorbed by report id even when run ids do not derive", () => {
    const parent = screenerSummary({
      id: "parent-report-goal",
      runId: "goal-job-1",
      reportId: "parent-report-goal",
      kind: "goal",
      source: "goal_screen",
      childRunIds: null,
      childReportIds: ["goal-child-report-1"],
    });
    const child = screenerSummary({
      id: "goal-child-report-1",
      runId: "goal-screen:task-1",
      reportId: "goal-child-report-1",
      kind: "goal",
      source: "goal_screen",
    });
    const merged = mergeRunSummaries([[parent, child]], 50);
    expect(merged.map((r) => r.id)).toEqual(["parent-report-goal"]);
  });
});

/* ------------------------------------------------------------------ */
/* Parent-row writer seam                                              */
/* ------------------------------------------------------------------ */

function testCollation(): WorkflowCollation {
  return {
    jobId: "job-1",
    workflowId: "screen-job-1",
    lifecycle: "Completed",
    qualified: true,
    coverage: { evaluated: 10, considered: 20, ratio: 0.5 },
    shards: [
      { shardId: "TECH", status: "completed", totalScanned: 10, expectedCount: 10, matchedCount: 2, pdfKey: "pdf-tech", stored: true },
      { shardId: "HEALTH", status: "failed", error: "boom" },
    ],
    lifecycleTransitions: [],
    stageTransitions: [],
    reportKeys: ["pdf-tech"],
    xlsxKeys: ["xlsx-tech"],
    csvKeys: [],
    storedShards: ["TECH"],
    deliveredShards: ["TECH"],
    childRunIds: ["screener:2026-10-26T12:00:00.000Z", "screener:2026-10-26T12:05:00.000Z"],
    childReportIds: [],
  };
}

describe("persistParentScreenReportCanonical (#2910)", () => {
  it("writes one row keyed generationId = jobId, with collation + linkage, and adopts on re-write", async () => {
    const sql = new MockSqlStorage();
    const ctx = {
      ensureTables: () => sql,
      env: {},
    } as unknown as ReportDispatchContext;
    const input: ParentScreenReportInput = {
      jobId: "job-1",
      userLogin: "alice",
      trigger: "manual",
      goalScreen: false,
      collation: testCollation(),
      childRunIds: ["screener:2026-10-26T12:00:00.000Z", "screener:2026-10-26T12:05:00.000Z"],
      childReportIds: [],
      createdAt: "2026-10-26T12:10:00.000Z",
    };
    const first = await persistParentScreenReportCanonical(ctx, input);
    expect(first).not.toBeNull();
    const rows = listScheduledReports(sql, { userLogin: "alice", limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe("job-1");
    const stored = getCanonicalReport(sql, first!.reportId);
    expect(stored).not.toBeNull();
    const body = JSON.parse(stored!.body as string);
    expect(body.parentJobId).toBe("job-1");
    expect(body.qualified).toBe(true);
    expect(body.childRunIds).toEqual(input.childRunIds);
    expect(body.shards).toHaveLength(2);
    expect(body.pdfKey).toBe("pdf-tech");
    expect(body.pdfStatus).toBe("generated");
    expect(body.xlsxStatus).toBe("generated");
    expect(body.csvStatus).toBe("missing");
    // A re-write under the same job id adopts the existing row: still one row.
    const second = await persistParentScreenReportCanonical(ctx, input);
    expect(second!.reportId).toBe(first!.reportId);
    expect(listScheduledReports(sql, { userLogin: "alice", limit: 50 })).toHaveLength(1);
  });

  it("refuses a row without an owning userLogin, without throwing", async () => {
    const sql = new MockSqlStorage();
    const ctx = {
      ensureTables: () => sql,
      env: {},
    } as unknown as ReportDispatchContext;
    const out = await persistParentScreenReportCanonical(ctx, {
      jobId: "job-1",
      userLogin: "",
      trigger: "manual",
      goalScreen: false,
      collation: testCollation(),
      childRunIds: [],
      childReportIds: [],
      createdAt: "2026-10-26T12:10:00.000Z",
    });
    expect(out).toBeNull();
    expect(listScheduledReports(sql, { userLogin: undefined, limit: 50 })).toHaveLength(0);
  });
});
