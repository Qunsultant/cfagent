/**
 * Issue #2910 (G3) — workflow parent canonical row: one
 * Docs/Reports row per parent run, shard rows absorbed.
 *
 * Pins:
 * - runParentFlow stores one parent row (via the injected
 *   storeParentReport seam) carrying the collation, the
 *   qualified-partial marking, per-format keys, and the
 *   child linkage (market childRunIds from child
 *   timestamps, childReportIds from child doors).
 * - A throwing parent store is recorded, never fatal.
 * - Without the seam the collation still stands, with no
 *   parentReport outcome (older fakes keep working).
 * - mergeRunSummaries absorbs shard rows (canonical and
 *   feed) into the parent row on both joins, and never
 *   absorbs the parent row itself.
 * - persistParentScreenReportCanonical writes exactly one
 *   mas_reports row keyed generationId = jobId, with the
 *   collation + linkage in the body, and a second write
 *   under the same job id adopts (never duplicates) it.
 */
import { describe, expect, it } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
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
import {
  asShardScreenResult,
  runParentFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
import {
  workflowIdForJob,
  type ParentScreenReportInput,
  type WorkflowCollation,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/* ------------------------------------------------------------------ */
/* Parent-flow fakes                                                   */
/* ------------------------------------------------------------------ */

function makeClock(startMs = 1_000_000) {
  let now = startMs;
  const step: ScreenerWorkflowStep = {
    do: async (_name, fn) => fn(),
    sleep: async (_name, ms) => {
      now += ms;
    },
  };
  return { nowMs: () => now, step };
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

function childId(parentJobId: string, shardId: string): string {
  return workflowIdForJob(`${parentJobId}:shard:${shardId}`);
}

function makeChildOps(
  statuses: Record<string, { status: WorkflowInstanceStatus; output?: unknown; error?: { message: string } }>,
): ChildWorkflowOps {
  return {
    createChild: async (cmd) => ({ workflowId: workflowIdForJob(cmd.jobId) }),
    getChildStatus: async (workflowId) => {
      const s = statuses[workflowId];
      if (!s) return { status: "running" };
      return s;
    },
  };
}

function completedChildOutput(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    timestamp: "2026-10-26T12:00:00.000Z",
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    pdfKey: "pdf-tech",
    xlsxKey: "xlsx-tech",
    stored: true,
    delivered: true,
    ...overrides,
  };
}

describe("runParentFlow parent canonical row (#2910)", () => {
  it("stores one parent row with collation + child linkage, qualified on partial failure", async () => {
    const clock = makeClock();
    const captured: ParentScreenReportInput[] = [];
    const deps: ScreenerWorkflowDeps = {
      screenRunner: { runScreen: async () => { throw new Error("parent never runs a screen"); } },
      shardStore: new InMemoryShardJobAdapter(),
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: clock.nowMs,
      storeParentReport: async (input) => {
        captured.push(input);
        return { stored: true, reportId: "parent-report-1" };
      },
    };
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: completedChildOutput() },
      [childId("job-1", "HEALTH")]: {
        status: "complete",
        output: { ...completedChildOutput({ timestamp: "2026-10-26T12:05:00.000Z", pdfKey: undefined, xlsxKey: undefined, stored: false }), success: false, error: "boom" },
      },
    });
    const collation = await runParentFlow(parentCommand(), clock.step, deps, ops);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.jobId).toBe("job-1");
    expect(captured[0]!.userLogin).toBe("alice");
    expect(captured[0]!.trigger).toBe("manual");
    // Market shards link by canonical run id derived from the child timestamp.
    expect(captured[0]!.childRunIds).toEqual([
      "screener:2026-10-26T12:00:00.000Z",
      "screener:2026-10-26T12:05:00.000Z",
    ]);
    // Qualified partial: one shard failed, the run is not complete.
    // Lifecycle stays ReportGenerated: the one completed shard was
    // stored by its child (lifecycle is computed from child flags).
    expect(captured[0]!.collation.qualified).toBe(true);
    expect(captured[0]!.collation.lifecycle).toBe("ReportGenerated");
    expect(captured[0]!.collation.reportKeys).toEqual(["pdf-tech"]);
    expect(captured[0]!.collation.xlsxKeys).toEqual(["xlsx-tech"]);
    expect(collation.parentReport).toEqual({ stored: true, reportId: "parent-report-1" });
    expect(collation.childRunIds).toEqual(captured[0]!.childRunIds);
  });

  it("carries child report ids from child doors into the parent linkage", async () => {
    const clock = makeClock();
    const captured: ParentScreenReportInput[] = [];
    const deps: ScreenerWorkflowDeps = {
      screenRunner: { runScreen: async () => { throw new Error("parent never runs a screen"); } },
      shardStore: new InMemoryShardJobAdapter(),
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: clock.nowMs,
      storeParentReport: async (input) => {
        captured.push(input);
        return { stored: true, reportId: "parent-report-9" };
      },
    };
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: {
        status: "complete",
        output: completedChildOutput({ reportId: "goal-child-report-1" }),
      },
      [childId("job-1", "HEALTH")]: {
        status: "complete",
        output: completedChildOutput({ timestamp: "2026-10-26T12:05:00.000Z", reportId: "goal-child-report-2" }),
      },
    });
    const collation = await runParentFlow(parentCommand(), clock.step, deps, ops);
    expect(captured[0]!.childReportIds).toEqual(["goal-child-report-1", "goal-child-report-2"]);
    expect(collation.childReportIds).toEqual(["goal-child-report-1", "goal-child-report-2"]);
    expect(asShardScreenResult(completedChildOutput({ reportId: "r-1" }))).toMatchObject({ reportId: "r-1" });
  });

  it("a throwing parent store is recorded, never fatal", async () => {
    const clock = makeClock();
    const deps: ScreenerWorkflowDeps = {
      screenRunner: { runScreen: async () => { throw new Error("parent never runs a screen"); } },
      shardStore: new InMemoryShardJobAdapter(),
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: clock.nowMs,
      storeParentReport: async () => {
        throw new Error("store exploded");
      },
    };
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: completedChildOutput() },
      [childId("job-1", "HEALTH")]: { status: "complete", output: completedChildOutput({ timestamp: "2026-10-26T12:05:00.000Z" }) },
    });
    const collation = await runParentFlow(parentCommand(), clock.step, deps, ops);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.parentReport).toEqual({ stored: false, storeError: "store exploded" });
  });

  it("without the seam the collation still stands, with no parentReport outcome", async () => {
    const clock = makeClock();
    const deps: ScreenerWorkflowDeps = {
      screenRunner: { runScreen: async () => { throw new Error("parent never runs a screen"); } },
      shardStore: new InMemoryShardJobAdapter(),
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: clock.nowMs,
    };
    const ops = makeChildOps({
      [childId("job-1", "TECH")]: { status: "complete", output: completedChildOutput() },
      [childId("job-1", "HEALTH")]: { status: "complete", output: completedChildOutput({ timestamp: "2026-10-26T12:05:00.000Z" }) },
    });
    const collation = await runParentFlow(parentCommand(), clock.step, deps, ops);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.parentReport).toBeUndefined();
    expect(collation.childRunIds).toEqual([
      "screener:2026-10-26T12:00:00.000Z",
      "screener:2026-10-26T12:05:00.000Z",
    ]);
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
