/**
 * Issue #3946 (Option B — two ledgers, surfaces merge): the engine's
 * D1 run records become readable on the three named surfaces —
 * Workflow Runs, ReportsPanel (/api/runs), RunDetailView
 * (/api/runs/details) — merged with the DO ledgers on the existing
 * #3121 linkage, deduplicated on exact identity.
 *
 * Issue #6103 (D1-only): the DO side of that merge is gone — the
 * routes read the D1 ledgers alone, and the canonical rows arrive
 * via their projected D1 rows (the #4116 parity fixture's shape:
 * DO rows written through the canonical write path, projected at
 * write time, never via the sweep). The route pins below are
 * rewritten to the D1-only equivalents at the same strength; the
 * identity / mapping / merge / reader pins are unchanged.
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
 *  4. Merge: D1 rows survive alongside canonical rows; an identical D1 row
 *     listed twice appears once; a D1 row and a canonical row with
 *     no exact join both survive (no heuristic twin-dropping — the
 *     engine writer stamps no linkage today, so no exact join
 *     exists; see the §15 known limit).
 *  5. Reader: an unbound AGENT_DB is a named error, never a silent
 *     empty list.
 *  6. Routes (#6103, D1-only): /api/runs includes D1 rows under kind=all only;
 *     /api/runs/details finds a D1 row by its derived id and names
 *     its store "job-pipeline"; /workflow-runs lists D1 runs;
 *     with D1 unbound the list is EMPTY and the failure is named in
 *     storeErrors — there is no DO fallback that renders anything.
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
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { MockD1Database } from "./mock-d1";

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

/**
 * Issue #6103 — the D1-only route fixture (the #4116 parity
 * fixture's shape): the engine's D1 row is recorded in D1 for real.
 * Issue #6101 — the canonical row is seeded in D1 directly via
 * the seam (storeReportAtGeneration): the projector is deleted, so
 * there is no postRunLedgerBestEffort and no carrier row anymore.
 * The seed keeps the fixture's shape (a canonical report with no
 * exact join to the D1 job record, so the merge pin still bites).
 * No jobRunRecordReader is injected: the routes read D1 for real.
 */
async function d1Fixture() {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const jobDb = createD1JobRunRecordDb(mock as never);
  await ensureJobRunRecordsSchema(jobDb);
  await new D1JobRunRecordStore(jobDb).record(d1Record());
  // Issue #6101 — the canonical row is seeded in D1 directly via
  // the seam (the projector is deleted, and the DO mas_reports
  // table is frozen). Version 1, no twin link: the fixture's D1
  // job record and this report share no exact join, which is what
  // the merge pin below asserts.
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  const canonicalId = await seedCanonical(env);
  return { mock, sql, env, canonicalId, d1Id: d1JobRunRecordId(d1Record()) };
}

function d1ReportsCtx(fx: Awaited<ReturnType<typeof d1Fixture>>): ReportsRouteContext {
  return {
    ensureTables: () => fx.sql as any,
    env: fx.env as never,
  } as ReportsRouteContext;
}

/** The pre-#6103 ctx: env without AGENT_DB, no reader — D1 unbound. */
function unboundReportsCtx(sql: MockSqlStorage): ReportsRouteContext {
  return {
    ensureTables: () => sql as any,
    env: {},
  } as ReportsRouteContext;
}

async function seedCanonical(env: { AGENT_DB: unknown }): Promise<string> {
  const stored = await storeReportAtGeneration(
    {
      runId: "screener:2026-11-11T09:00:00.000Z",
      generationId: "screener:2026-11-11T09:00:00.000Z",
      userLogin: "alice",
      title: "Market screen — NASDAQ100 (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols, 5 matched.",
      body: { trigger: "scheduled", success: true, matchedCount: 5, timestamp: "2026-11-11T09:00:00.000Z" },
      createdAt: "2026-11-11T09:00:00.000Z",
    },
    env as never,
  );
  return stored!.reportId;
}

describe("GET /api/runs merges D1 records (#3946, D1-only #6103)", () => {
  it("includes a D1 row under kind=all, newest-first", async () => {
    const fx = await d1Fixture();
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=all", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=all"),
      "/api/runs",
      null,
      d1ReportsCtx(fx),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    // Issue #6103 (Q5) — no mode rides the response anymore.
    expect("ledgerReadMode" in data).toBe(false);
    const ids = data.runs.map((r: any) => r.id);
    expect(ids).toContain(d1JobRunRecordId(d1Record()));
    expect(ids).toContain(fx.canonicalId);
    expect(ids[0]).toBe(d1JobRunRecordId(d1Record()));
    const d1Row = data.runs.find((r: any) => r.id === d1JobRunRecordId(d1Record()));
    expect(d1Row.source).toBe("job-pipeline");
    expect(d1Row.reportId).toBeNull();
    // The canonical row arrives via its projected D1 row, not the DO.
    expect(data.storeErrors?.reports).toBeUndefined();
    expect(data.storeErrors?.jobRunRecords).toBeUndefined();
  });

  it("excludes D1 rows under kind=screener", async () => {
    const fx = await d1Fixture();
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=screener", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=screener"),
      "/api/runs",
      null,
      d1ReportsCtx(fx),
    );
    const data = (await res!.json()) as any;
    // Issue #6103: the canonical row now genuinely renders (via its
    // projected D1 row) while the D1 row stays excluded — the old
    // pin passed vacuously on an empty list.
    expect(data.runs.map((r: any) => r.id)).toEqual([fx.canonicalId]);
    expect(data.runs.map((r: any) => r.id)).not.toContain(d1JobRunRecordId(d1Record()));
    expect(data.runs.every((r: any) => r.kind === "screener")).toBe(true);
  });

  it("names an unbound D1 ledger in storeErrors and renders NOTHING — D1-only, no DO fallback (#6103)", async () => {
    const sql = new MockSqlStorage();
    const canonicalId = await seedCanonical({ AGENT_DB: new MockD1Database() as never });
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs?kind=all", { headers: { "x-user-login": "alice" } }),
      new URL("https://x/api/runs?kind=all"),
      "/api/runs",
      null,
      unboundReportsCtx(sql),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    // The old premise dies with the merged view: with D1 unbound
    // the D1 reads fail named and the list is EMPTY — no DO fallback
    // renders the canonical row (or anything else).
    expect(data.runs).toEqual([]);
    expect(data.runs.map((r: any) => r.id)).not.toContain(canonicalId);
    expect(data.storeErrors.jobRunRecords).toContain("AGENT_DB");
    expect(data.storeErrors.reports).toContain("AgentDB is not bound");
    expect(data.storeErrors?.scans).toMatch("not projected");
    expect(data.storeErrors?.discovery).toMatch("not projected");
    expect(data.storeErrors?.screener).toMatch("not projected");
  });
});

describe("GET /api/runs/details finds a D1 row (#3946, D1-only #6103)", () => {
  it("returns a detail for the D1 row naming its store", async () => {
    const fx = await d1Fixture();
    const wanted = d1JobRunRecordId(d1Record());
    const res = await handleReportsRoutes(
      new Request(`https://x/api/runs/details?runId=${encodeURIComponent(wanted)}`, {
        headers: { "x-user-login": "alice" },
      }),
      new URL(`https://x/api/runs/details?runId=${encodeURIComponent(wanted)}`),
      "/api/runs/details",
      null,
      d1ReportsCtx(fx),
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
