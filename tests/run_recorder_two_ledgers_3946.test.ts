/**
 * Issue #3946 (Option B — two ledgers, surfaces merge): the engine's
 * D1 run records become readable on the three named surfaces —
 * Workflow Runs, ReportsPanel (/api/runs), RunDetailView
 * (/api/runs/details) — merged with the DO ledgers on the existing
 * #3121 linkage, deduplicated on exact identity.
 *
 * Pinned here:
 *  1. Identity: a D1 record's derived id is stable and unique per
 *     (jobId, started, finished); the two surfaces agree on it.
 *  2. Mapping: runSummaryFromJobRunRecord maps a D1 record to the
 *     one Runs shape with honest nulls (no pdf/xlsx/csv, no
 *     reportId, no resultCount — the record carries none).
 *  3. Mapping: runFromJobRunRecord maps a D1 record to a WorkflowRun
 *     (source job-outcome, family other, honest empty stage list,
 *     lifecycle done for terminal outcomes).
 *  4. Merge: D1 rows survive alongside DO rows; an identical D1 row
 *     listed twice appears once; a D1 row and a canonical row with
 *     no exact join both survive (no heuristic twin-dropping — the
 *     engine writer stamps no linkage today, so no exact join
 *     exists; see the §15 known limit).
 *  5. Reader: an unbound AGENT_DB is a named error, never a silent
 *     empty list.
 *  6. Routes: /api/runs includes D1 rows under kind=all only;
 *     /api/runs/details finds a D1 row by its derived id and names
 *     its store "job-pipeline"; /workflow-runs lists D1 runs;
 *     an unreadable D1 ledger is named in storeErrors and never
 *     hides the other ledgers.
 */
import { describe, it, expect } from "vitest";

import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";
import {
  d1JobRunRecordId,
  listD1JobRunRecords,
} from "../src/services/jobRunRecordReads";
import {
  listD1JobRunRecordSummaries,
  mergeRunSummaries,
  runSummaryFromJobRunRecord,
  type RunSummary,
} from "../src/services/runSummaries";
import { runFromJobRunRecord } from "../src/services/workflowRuns";
import { handleReportsRoutes, type ReportsRouteContext } from "../src/agents/routes/reports";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
} from "../src/services/scheduledReports";

function d1Record(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "job-pipeline",
    jobId: "pipeline-feed-quotes",
    operation: "job",
    started: "2026-11-11T10:00:00.000Z",
    finished: "2026-11-11T10:02:30.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    descriptor: "run run-abc123: 12 step executions, 3 artifacts",
    artifactRefs: ["feed.pull", "enrich.apply"],
    ...overrides,
  });
}

function failedRecord(): JobRunRecord {
  return d1Record({
    jobId: "pipeline-generate-screen",
    started: "2026-11-11T11:00:00.000Z",
    finished: "2026-11-11T11:00:05.000Z",
    outcome: "failure",
    error: "FEED_JOB_NOT_CONFIGURED: feed job not configured",
    descriptor: undefined,
    artifactRefs: undefined,
  });
}

function skippedRecord(): JobRunRecord {
  return d1Record({
    jobId: "pipeline-deliver",
    started: "2026-11-11T12:00:00.000Z",
    finished: "2026-11-11T12:00:01.000Z",
    outcome: "skipped",
    detail: "job_cancelled",
    descriptor: undefined,
    artifactRefs: undefined,
  });
}

describe("D1 run-record identity (#3946)", () => {
  it("derives a stable id from jobId + started + finished", () => {
    const record = d1Record();
    expect(d1JobRunRecordId(record)).toBe(
      "d1:pipeline-feed-quotes:2026-11-11T10:00:00.000Z:2026-11-11T10:02:30.000Z",
    );
    expect(d1JobRunRecordId(d1Record())).toBe(d1JobRunRecordId(record));
  });

  it("differs across jobs and across runs of the same job", () => {
    const a = d1Record();
    const otherJob = d1Record({ jobId: "pipeline-enrich" });
    const laterRun = d1Record({
      started: "2026-11-11T10:05:00.000Z",
      finished: "2026-11-11T10:06:00.000Z",
    });
    expect(d1JobRunRecordId(otherJob)).not.toBe(d1JobRunRecordId(a));
    expect(d1JobRunRecordId(laterRun)).not.toBe(d1JobRunRecordId(a));
  });
});

describe("runSummaryFromJobRunRecord (#3946)", () => {
  it("maps a successful record with honest nulls", () => {
    const row = runSummaryFromJobRunRecord(d1Record());
    expect(row.kind).toBe("report");
    expect(row.source).toBe("job-pipeline");
    expect(row.id).toBe(d1JobRunRecordId(d1Record()));
    expect(row.runId).toBe(row.id);
    expect(row.title).toContain("pipeline-feed-quotes");
    expect(row.summary).toContain("12 step executions");
    expect(row.trigger).toBe("scheduled");
    expect(row.createdAt).toBe("2026-11-11T10:00:00.000Z");
    expect(row.status).toBe("completed");
    expect(row.resultCount).toBeNull();
    expect(row.pdfKey).toBeNull();
    expect(row.reportUrl).toBeNull();
    expect(row.reportId).toBeNull();
    expect(row.scanRunId).toBeNull();
  });

  it("maps failure to failed status with the error in the summary", () => {
    const row = runSummaryFromJobRunRecord(failedRecord());
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("FEED_JOB_NOT_CONFIGURED");
    expect(row.title).toContain("pipeline-generate-screen");
  });

  it("maps a skipped record to skipped status with the skip reason", () => {
    const row = runSummaryFromJobRunRecord(skippedRecord());
    expect(row.status).toBe("skipped");
    expect(row.summary).toContain("job_cancelled");
  });
});

describe("runFromJobRunRecord (#3946)", () => {
  it("maps a successful record to a WorkflowRun with an honest empty stage list", () => {
    const run = runFromJobRunRecord(d1Record());
    expect(run.id).toBe(d1JobRunRecordId(d1Record()));
    expect(run.runId).toBe(run.id);
    expect(run.source).toBe("job-outcome");
    expect(run.family).toBe("other");
    expect(run.workflow).toBe("Background job");
    expect(run.title).toContain("pipeline-feed-quotes");
    expect(run.trigger).toBe("scheduled");
    expect(run.status).toBe("completed");
    expect(run.lifecycle).toBe("done");
    expect(run.startedAt).toBe("2026-11-11T10:00:00.000Z");
    expect(run.finishedAt).toBe("2026-11-11T10:02:30.000Z");
    expect(run.durationMs).toBe(150000);
    expect(run.stages).toEqual([]);
    expect(run.stageCount).toBe(0);
    expect(run.error).toBeNull();
    expect(run.documents).toBeNull();
    expect(run.brokerId).toBeUndefined();
  });

  it("maps failure to failed status carrying the recorded error", () => {
    const run = runFromJobRunRecord(failedRecord());
    expect(run.status).toBe("failed");
    expect(run.lifecycle).toBe("done");
    expect(run.error).toBe("FEED_JOB_NOT_CONFIGURED: feed job not configured");
  });

  it("maps a worker-cron trigger to scheduled with the evidence named", () => {
    const run = runFromJobRunRecord(
      d1Record({ trigger: "worker-cron", triggeredBy: "scheduled" }),
    );
    expect(run.trigger).toBe("scheduled");
    expect(run.triggerDetail).toContain("Worker cron");
  });
});

describe("mergeRunSummaries with D1 rows (#3946)", () => {
  it("keeps a D1 row alongside a canonical row (no exact join — no heuristic drop)", () => {
    const canonical: RunSummary = {
      kind: "screener",
      id: "rep-1",
      runId: "screener:2026-11-11T09:00:00.000Z",
      title: "Market screen",
      summary: "Scanned 100 symbols, 5 matched.",
      trigger: "scheduled",
      createdAt: "2026-11-11T09:00:00.000Z",
      status: "completed",
      resultCount: 5,
      pdfKey: null,
      reportUrl: null,
      xlsxKey: null,
      xlsxUrl: null,
      csvKey: null,
      csvUrl: null,
      pdfStatus: null,
      pdfError: null,
      reportId: "rep-1",
      scanRunId: null,
      source: "screener",
    };
    const merged = mergeRunSummaries(
      [[canonical], [runSummaryFromJobRunRecord(d1Record())]],
      10,
    );
    expect(merged.map((r) => r.id)).toEqual([
      d1JobRunRecordId(d1Record()),
      "rep-1",
    ]);
  });

  it("de-duplicates an identical D1 row listed twice", () => {
    const row = runSummaryFromJobRunRecord(d1Record());
    const merged = mergeRunSummaries([[row], [row]], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(row.id);
  });
});

describe("listD1JobRunRecords (#3946)", () => {
  it("throws a named error when AGENT_DB is unbound", async () => {
    await expect(listD1JobRunRecords({}, 10)).rejects.toThrow(/AGENT_DB/);
    await expect(listD1JobRunRecords(undefined, 10)).rejects.toThrow(/AGENT_DB/);
    await expect(listD1JobRunRecordSummaries({}, 10)).rejects.toThrow(/AGENT_DB/);
  });
});

function reportsCtx(
  sql: MockSqlStorage,
  reader?: (limit: number) => Promise<JobRunRecord[]>,
): ReportsRouteContext {
  return {
    ensureTables: () => sql as any,
    env: {},
    jobRunRecordReader: reader,
    getScreenerAgent: () => ({ getHistory: async () => [] }) as any,
    getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
    getReportDispatchHitl: () => ({}) as any,
    hitlPreviewReady: () => true,
    executeApprovedSend: async () => {},
    buildResearchEmailBody: (hit: any) => hit.body,
    buildResearchWebhookBody: (hit: any) => ({ body: hit.body }),
    reportHitlActions: new Map(),
    hitlApprovedDispatches: new Map(),
    hitlDispatchHistory: new Map(),
    recordHitlDispatchHistory: () => {},
    watchdogTimerCount: () => 0,
    lastReportWatchdogSweepCount: () => 0,
    lastReportWatchdogSweepAt: () => null,
    startReportWatchdog: () => {},
    stopReportWatchdog: () => {},
    persistApproval: () => {},
    persistDispatchStatus: () => {},
  } as ReportsRouteContext;
}

function seedCanonical(sql: MockSqlStorage): string {
  ensureScheduledReportsTable(sql as any);
  return persistScheduledReportSql(sql as any, {
    runId: "screener:2026-11-11T09:00:00.000Z",
    generationId: "screener:2026-11-11T09:00:00.000Z",
    userLogin: "alice",
    title: "Market screen — NASDAQ100 (scheduled)",
    source: "screener",
    summary: "Scanned 100 symbols, 5 matched.",
    body: { trigger: "scheduled", success: true, matchedCount: 5, timestamp: "2026-11-11T09:00:00.000Z" },
    createdAt: "2026-11-11T09:00:00.000Z",
  });
}

describe("GET /api/runs merges D1 records (#3946)", () => {
  it("includes a D1 row under kind=all, newest-first", async () => {
    const sql = new MockSqlStorage();
    const canonicalId = seedCanonical(sql);
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=all", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=all"),
      "/api/runs",
      null,
      reportsCtx(sql, async () => [d1Record()]),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const ids = data.runs.map((r: any) => r.id);
    expect(ids).toContain(d1JobRunRecordId(d1Record()));
    expect(ids).toContain(canonicalId);
    expect(ids[0]).toBe(d1JobRunRecordId(d1Record()));
    const d1Row = data.runs.find((r: any) => r.id === d1JobRunRecordId(d1Record()));
    expect(d1Row.source).toBe("job-pipeline");
    expect(d1Row.reportId).toBeNull();
  });

  it("excludes D1 rows under kind=screener", async () => {
    const sql = new MockSqlStorage();
    seedCanonical(sql);
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=screener", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=screener"),
      "/api/runs",
      null,
      reportsCtx(sql, async () => [d1Record()]),
    );
    const data = (await res!.json()) as any;
    expect(data.runs.map((r: any) => r.id)).not.toContain(d1JobRunRecordId(d1Record()));
    expect(data.runs.every((r: any) => r.kind === "screener")).toBe(true);
  });

  it("names an unbound D1 ledger in storeErrors and still renders the DO ledgers", async () => {
    const sql = new MockSqlStorage();
    const canonicalId = seedCanonical(sql);
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=all", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=all"),
      "/api/runs",
      null,
      reportsCtx(sql),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.map((r: any) => r.id)).toContain(canonicalId);
    expect(data.storeErrors.jobRunRecords).toContain("AGENT_DB");
  });
});

describe("GET /api/runs/details finds a D1 row (#3946)", () => {
  it("returns a detail for the D1 row naming its store", async () => {
    const sql = new MockSqlStorage();
    seedCanonical(sql);
    const wanted = d1JobRunRecordId(d1Record());
    const res = await handleReportsRoutes(
      new Request(`https://x/api/runs/details?runId=${encodeURIComponent(wanted)}`, {
        headers: { "x-user-login": "alice" },
      }),
      new URL(`https://x/api/runs/details?runId=${encodeURIComponent(wanted)}`),
      "/api/runs/details",
      null,
      reportsCtx(sql, async () => [d1Record()]),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.detail.runId).toBe(wanted);
    expect(data.detail.store).toBe("job-pipeline");
    expect(data.detail.title).toContain("pipeline-feed-quotes");
  });
});

describe("GET /workflow-runs merges D1 records (#3946)", () => {
  it("lists a D1 run as a job-outcome run", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sql as any,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [d1Record()],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.runId === d1JobRunRecordId(d1Record()));
    expect(run).toBeDefined();
    expect(run.source).toBe("job-outcome");
    expect(run.status).toBe("completed");
    expect(run.title).toContain("pipeline-feed-quotes");
  });

  it("names an unbound D1 ledger in storeErrors and still renders the other ledgers", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      { ensureTables: () => sql as any, userLogin: "analyst", env: {} } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.jobRunRecords).toContain("AGENT_DB");
    // No D1 run appears, but the other ledgers still render — the
    // page always carries its registered binding-schedule rows.
    expect(data.runs.filter((r: any) => r.source === "job-outcome")).toEqual([]);
    expect(data.runs.length).toBeGreaterThan(0);
  });
});
