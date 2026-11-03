/**
 * Issue #2786 Part 3: Docs columns in Workflow Runs + the "reports" filter.
 *
 * Pins (TDD red first):
 *  - the Docs-family predicate agrees with the Docs tab's own
 *    documentRunSource on a (kind, source, runSource) matrix;
 *  - a canonical mas_reports row yields run documents (PDF/XLSX/CSV
 *    urls + generation statuses/errors + family + report id), and
 *    non-Docs families yield nothing;
 *  - #2910-absorbed child rows are dropped, parent rows exempt;
 *  - a report-only run carries source "report", the canonical body's
 *    stages when it carries any (honest: no execution trace
 *    otherwise), and normalized trigger/status;
 *  - hasReportDocuments covers canonical documents and outcome
 *    artifacts, nothing else;
 *  - route level: a canonical twin's documents attach to its run,
 *    reports=only returns report-backed runs only, the filter applies
 *    BEFORE the 50-slice (a report run past position 50 still shows),
 *    and another user's canonical rows never leak in.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  hasReportDocuments,
  runFromReportDocument,
  type WorkflowRun,
  type WorkflowRunStage,
} from "../src/services/workflowRuns";
import {
  canonicalBodyStages,
  docsFamilyForRunSummary,
  dropAbsorbedReportSummaries,
  reportDocumentsFromCanonicalHit,
  handleWorkflowRunsRoutes,
} from "../src/agents/routes/workflowRuns";
import { documentRunSource } from "../src/client/docsAndReports";
import type { ScheduledReportHit } from "../src/services/scheduledReports";
import { recordJobOutcome } from "../src/services/jobOutcomes";
import { persistScheduledReportSql } from "../src/services/scheduledReports";
import type { RunSummary } from "../src/services/runSummaries";

const JOB_COLUMNS =
  "job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id";
const JOB_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function insertJob(sql: MockSqlStorage, jobId: string, createdAt: string): void {
  sql.exec(
    `INSERT INTO mas_async_jobs (${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS})`,
    jobId,
    "session-1",
    "http.request",
    `Job ${jobId}`,
    "completed",
    JSON.stringify({ method: "POST", pathAndQuery: "/etrade/screen", body: { trigger: "scheduled" } }),
    JSON.stringify({ success: true }),
    null,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
    null,
    "main",
    null,
    null,
    "generate",
    `chain-${jobId}`,
  );
}

function ctxFor(sql: MockSqlStorage, userLogin = "analyst") {
  return { ensureTables: () => sql, userLogin, env: {} };
}

function request(path = "/workflow-runs"): Request {
  return new Request(`https://agent.internal${path}`, { method: "GET" });
}

function hit(over: Partial<ScheduledReportHit> & { body: string }): ScheduledReportHit {
  return {
    id: "rep-1",
    runId: "run-1",
    title: "Goal report",
    source: "goal_screen",
    summary: "summary",
    createdAt: "2026-10-27T13:00:00.000Z",
    bodyR2Key: null,
    fanoutOutcome: null,
    ...over,
  };
}

describe("docsFamilyForRunSummary agrees with the Docs tab", () => {
  const cases: Array<{
    input: { kind: string; source: string; runSource?: string | null };
    expected: string | null;
  }> = [
    { input: { kind: "screener", source: "screener", runSource: null }, expected: "stock" },
    { input: { kind: "options_scanner", source: "options_scanner", runSource: null }, expected: "options" },
    { input: { kind: "goal", source: "goal_screen", runSource: null }, expected: "goal" },
    { input: { kind: "discovery", source: "discovery", runSource: null }, expected: "strategy" },
    { input: { kind: "report", source: "options_research", runSource: null }, expected: "options" },
    { input: { kind: "report", source: "research_report", runSource: null }, expected: null },
    { input: { kind: "report", source: "iv_collection", runSource: null }, expected: null },
    { input: { kind: "screener", source: "screener", runSource: "goal" }, expected: "goal" },
    { input: { kind: "options_scanner", source: "options_scanner", runSource: "strategy" }, expected: "strategy" },
  ];
  for (const { input, expected } of cases) {
    it(`kind=${input.kind} source=${input.source} runSource=${input.runSource} -> ${expected}`, () => {
      const summary = input as unknown as Pick<RunSummary, "kind" | "source" | "runSource">;
      expect(docsFamilyForRunSummary(summary)).toBe(expected);
      expect(documentRunSource(summary)).toBe(expected);
    });
  }
});

describe("reportDocumentsFromCanonicalHit", () => {
  it("yields urls, statuses, errors, family, report id, and match keys", () => {
    const out = reportDocumentsFromCanonicalHit(
      hit({
        id: "rep-9",
        runId: "goal-run-9",
        source: "goal_screen",
        body: JSON.stringify({
          pdfKey: "goal/report.pdf",
          xlsxKey: "goal/report.xlsx",
          csvKey: "goal/report.csv",
          pdfStatus: "generated",
          xlsxStatus: "failed",
          xlsxError: "workbook blew up",
          csvStatus: "generated",
          asyncJobId: "job-9",
        }),
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.documents.reportId).toBe("rep-9");
    expect(out!.documents.family).toBe("goal");
    expect(out!.documents.pdfUrl).toContain("goal%2Freport.pdf");
    expect(out!.documents.xlsxUrl).toContain("goal-screen");
    expect(out!.documents.xlsxUrl).toContain("goal%2Freport.xlsx");
    expect(out!.documents.csvUrl).toContain("goal%2Freport.csv");
    expect(out!.documents.pdfStatus).toBe("generated");
    expect(out!.documents.xlsxStatus).toBe("failed");
    expect(out!.documents.xlsxError).toBe("workbook blew up");
    expect(out!.matchKeys).toContain("goal-run-9");
    expect(out!.matchKeys).toContain("job-9");
  });

  it("yields null for non-Docs families", () => {
    expect(
      reportDocumentsFromCanonicalHit(
        hit({ source: "research_report", body: JSON.stringify({}) }),
      ),
    ).toBeNull();
  });
});

describe("dropAbsorbedReportSummaries", () => {
  it("drops #2910-absorbed children and exempts parent rows", () => {
    const parent = {
      id: "rep-parent",
      runId: "parent-run",
      kind: "goal",
      childRunIds: ["screener:t1"],
      childReportIds: ["rep-child"],
    };
    const childByRun = { id: "rep-a", runId: "screener:t1", kind: "screener" };
    const childByReport = { id: "rep-child", runId: "other-run", kind: "screener" };
    const independent = { id: "rep-free", runId: "free-run", kind: "screener" };
    const kept = dropAbsorbedReportSummaries([parent, childByRun, childByReport, independent] as never);
    expect(kept.map((r: { id: string }) => r.id).sort()).toEqual(["rep-free", "rep-parent"]);
  });
});

describe("runFromReportDocument", () => {
  it("builds a report-only run with no stages and normalized trigger/status", () => {
    const run = runFromReportDocument({
      reportId: "rep-1",
      runId: "goal-run-1",
      title: "Goal report",
      engineFamily: "goal",
      documents: {
        reportId: "rep-1",
        family: "goal",
        pdfUrl: "/api/screening/goal-screen/report.pdf?key=g.pdf",
        pdfStatus: "generated",
        pdfError: null,
        xlsxUrl: null,
        xlsxStatus: null,
        xlsxError: null,
        csvUrl: null,
        csvStatus: null,
        csvError: null,
      },
      trigger: "manual-trigger",
      status: "completed",
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    expect(run.source).toBe("report");
    expect(run.stages).toEqual([]);
    expect(run.stageCount).toBe(0);
    expect(run.trigger).toBe("manual");
    expect(run.status).toBe("completed");
    expect(run.startedAt).toBe("2026-10-27T13:00:00.000Z");
    expect(run.documents?.reportId).toBe("rep-1");
  });

  it("normalizes cron to scheduled and unknown triggers/statuses to unknown", () => {
    const run = runFromReportDocument({
      reportId: "rep-2",
      runId: "goal-run-2",
      title: "Goal report",
      engineFamily: "goal",
      documents: {
        reportId: "rep-2",
        family: "goal",
        pdfUrl: null,
        pdfStatus: null,
        pdfError: null,
        xlsxUrl: null,
        xlsxStatus: null,
        xlsxError: null,
        csvUrl: null,
        csvStatus: null,
        csvError: null,
      },
      trigger: "cron",
      status: null,
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    expect(run.trigger).toBe("scheduled");
    expect(run.status).toBe("unknown");
  });
});

describe("hasReportDocuments", () => {
  const base: WorkflowRun = {
    id: "r",
    runId: "r",
    workflow: "w",
    family: "stock",
    title: "t",
    source: "job-outcome",
    trigger: "manual",
    triggerDetail: "d",
    triggeredBy: null,
    status: "completed",
    startedAt: "2026-10-27T13:00:00.000Z",
    finishedAt: null,
    durationMs: null,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: {},
    outputs: {},
    artifacts: [],
    deliveryStates: {},
    error: null,
  };
  it("is true for canonical documents", () => {
    expect(hasReportDocuments({ ...base, documents: { reportId: "rep", family: "goal", pdfUrl: null, pdfStatus: null, pdfError: null, xlsxUrl: null, xlsxStatus: null, xlsxError: null, csvUrl: null, csvStatus: null, csvError: null } })).toBe(true);
  });
  it("is true for outcome document artifacts", () => {
    expect(hasReportDocuments({ ...base, artifacts: [{ kind: "pdf", label: "PDF report", url: "/x.pdf" }] })).toBe(true);
  });
  it("is false with neither", () => {
    expect(hasReportDocuments({ ...base, artifacts: [{ kind: "other", label: "Other", url: "/x" }] })).toBe(false);
  });
});

describe("GET /workflow-runs reports filter (route level)", () => {
  it("attaches canonical documents to a twin and filters to report runs only", async () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      id: "outcome-1",
      kind: "goal",
      trigger: "manual",
      status: "completed",
      origin: "manual",
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    insertJob(sql, "job-other", "2026-10-27T12:00:00.000Z");
    const repId = persistScheduledReportSql(sql, {
      runId: "outcome-1",
      userLogin: "analyst",
      title: "Goal report",
      source: "goal_screen",
      summary: "goal summary",
      body: {
        pdfKey: "goal/report.pdf",
        xlsxKey: "goal/report.xlsx",
        csvKey: "goal/report.csv",
        pdfStatus: "generated",
        xlsxStatus: "failed",
        xlsxError: "workbook blew up",
      },
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    expect(repId).not.toBeNull();

    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    const twin = all.runs.find((r: any) => r.runId === "outcome-1");
    expect(twin).toBeDefined();
    expect(twin.documents.reportId).toBe(repId);
    expect(twin.documents.family).toBe("goal");
    expect(twin.documents.xlsxStatus).toBe("failed");
    expect(twin.documents.xlsxError).toBe("workbook blew up");

    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    expect(filtered.runs.map((r: any) => r.runId)).toEqual(["outcome-1"]);
  });

  it("filters BEFORE the 50-slice: a report run past position 50 still shows", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 60; i++) {
      const minute = String(59 - i).padStart(2, "0");
      insertJob(sql, `job-${i}`, `2026-11-01T00:${minute}:00.000Z`);
    }
    persistScheduledReportSql(sql, {
      runId: "report-old",
      userLogin: "analyst",
      title: "Old goal report",
      source: "goal_screen",
      summary: "old summary",
      body: { pdfKey: "goal/old.pdf" },
      createdAt: "2026-10-01T00:00:00.000Z",
    });

    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    expect(all.runs.map((r: any) => r.runId)).not.toContain("report-old");

    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    expect(filtered.runs.map((r: any) => r.runId)).toContain("report-old");
  });

  it("never leaks another user's canonical rows", async () => {
    const sql = new MockSqlStorage();
    persistScheduledReportSql(sql, {
      runId: "foreign-run",
      userLogin: "someone-else",
      title: "Foreign report",
      source: "goal_screen",
      summary: "foreign",
      body: { pdfKey: "goal/foreign.pdf" },
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    expect(filtered.runs).toEqual([]);
  });
});

describe("Issue #2786 losslessness fix: preserved canonical stages", () => {
  it("parses a canonical body's stages through the shared parser", () => {
    const stages = canonicalBodyStages({
      stages: [
        { stage: "feed", status: "completed", evidence: { connector: "etrade", contractsEvaluated: 5, fetchErrorCount: 0 }, durationMs: 1200 },
        { stage: "gather", status: "failed", error: "boom" },
        { stage: "bogus" },
        "junk",
      ],
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ stage: "feed", status: "completed", durationMs: 1200 });
    expect(stages[0].detail).toContain("etrade");
    expect(stages[1]).toMatchObject({ stage: "gather", status: "failed", error: "boom" });
  });

  it("returns [] for a body without a well-formed stages array", () => {
    expect(canonicalBodyStages({})).toEqual([]);
    expect(canonicalBodyStages(null)).toEqual([]);
    expect(canonicalBodyStages({ stages: "nope" })).toEqual([]);
  });

  it("runFromReportDocument preserves provided stages and counts", () => {
    const stages: WorkflowRunStage[] = [
      { key: "canonical:feed", order: 1, stage: "feed", label: "Feed", status: "completed", recordedBy: "unified-record", startedAt: "2026-10-27T13:00:00.000Z", finishedAt: "2026-10-27T13:00:00.000Z", durationMs: 1200, detail: null, reason: null, error: null, capability: null, jobKind: null, channel: null, input: null, output: null },
      { key: "canonical:gather", order: 2, stage: "gather", label: "Gather", status: "failed", recordedBy: "unified-record", startedAt: "2026-10-27T13:00:00.000Z", finishedAt: "2026-10-27T13:00:00.000Z", durationMs: null, detail: null, reason: null, error: "boom", capability: null, jobKind: null, channel: null, input: null, output: null },
    ];
    const run = runFromReportDocument({
      reportId: "rep-1",
      runId: "goal-run-1",
      title: "Goal report",
      engineFamily: "goal",
      documents: { reportId: "rep-1", family: "goal", pdfUrl: null, pdfStatus: null, pdfError: null, xlsxUrl: null, xlsxStatus: null, xlsxError: null, csvUrl: null, csvStatus: null, csvError: null },
      trigger: "manual-trigger",
      status: "completed",
      createdAt: "2026-10-27T13:00:00.000Z",
      stages,
    });
    expect(run.stages).toEqual(stages);
    expect(run.stageCount).toBe(2);
    expect(run.completedStages).toBe(1);
    expect(run.failedStages).toBe(1);
  });

  it("reportDocumentsFromCanonicalHit returns the body's stages", () => {
    const entry = reportDocumentsFromCanonicalHit({
      id: "rep-9",
      runId: "goal-run-9",
      title: "Goal report",
      source: "goal_screen",
      summary: "summary",
      body: JSON.stringify({ stages: [{ stage: "feed", status: "completed" }] }),
      createdAt: "2026-10-27T13:00:00.000Z",
      bodyR2Key: null,
      fanoutOutcome: null,
    });
    expect(entry?.stages).toHaveLength(1);
    expect(entry?.stages[0].stage).toBe("feed");
  });

  it("route mints a report-only run carrying a staged canonical body's stages", async () => {
    const sql = new MockSqlStorage();
    persistScheduledReportSql(sql, {
      runId: "staged-goal",
      userLogin: "analyst",
      title: "Staged goal report",
      source: "goal_screen",
      summary: "summary",
      body: {
        pdfKey: "goal/staged.pdf",
        stages: [
          { stage: "feed", status: "completed", evidence: { connector: "etrade", contractsEvaluated: 5, fetchErrorCount: 0 } },
          { stage: "gather", status: "failed", error: "boom" },
        ],
      },
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(sql)))!.json()) as any;
    const run = all.runs.find((r: any) => r.runId === "staged-goal");
    expect(run).toBeDefined();
    expect(run.source).toBe("report");
    expect(run.stages.map((s: any) => s.stage)).toEqual(["feed", "gather"]);
    expect(run.stageCount).toBe(2);
    expect(run.completedStages).toBe(1);
    expect(run.failedStages).toBe(1);
  });
});
