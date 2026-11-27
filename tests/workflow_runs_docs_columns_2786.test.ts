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
 *
 * Issue #6101 (D1-first) — the route-level tests seed D1 directly,
 * never the DO: the runs route reads D1 alone now, and the #6099
 * projector is deleted, so each test writes its rows straight into
 * D1 — canonical reports via D1AuditReportAdapter.recordReport,
 * async jobs straight into the frozen agent_async_jobs table.
 * There is no carrier row anymore. Outcome-carrying D1 rows are
 * seeded via the REAL fold D1JobRunRecordStore.foldJobOutcome,
 * never via buildJobRunRecord (it drops the outcome-fact fields).
 * A report's twin link (linkedJobRunId) is stamped by the test
 * from the folded record's d1 id — the D1 writer's job now that
 * no projector resolves it at write time.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
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
import type { JobOutcomeInput, JobOutcomeRow } from "../src/services/jobOutcomes";
import { d1JobRunRecordId } from "../src/services/jobRunRecordReads";
import type { JobRunRecord } from "../src/services/jobRunRecords";
import type { RunSummary } from "../src/services/runSummaries";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";
import { createAuditReportAdapter } from "../src/data/createAuditReportPorts";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";

/** Minimal D1Database stand-in over node:sqlite (the #4116 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const SESSION = "session-1";

/**
 * Issue #6101 — the D1 fixture: a MockD1Database env over the
 * frozen agent_async_jobs table + the D1 agent_reports table
 * (no carriers anymore). Reports and jobs are seeded straight
 * into D1 by seedReportD1 / insertJob below.
 */
async function d1Fixture() {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  const adapter = createRunLedgerAdapter(env)!;
  await ensureRunLedgerTables(adapter);
  return { mock, sql, env };
}

type D1Fixture = Awaited<ReturnType<typeof d1Fixture>>;

/** How many canonical rows the D1 agent_reports table holds. */
function countD1Reports(fx: D1Fixture): number {
  const row = fx.mock.sqlite
    .prepare("SELECT COUNT(*) AS n FROM agent_reports")
    .get() as { n: number };
  return row.n;
}

/** How many pre-cutover rows the frozen D1 jobs table holds for the session. */
function countD1Jobs(fx: D1Fixture, sessionId = SESSION): number {
  const row = fx.mock.sqlite
    .prepare("SELECT COUNT(*) AS n FROM agent_async_jobs WHERE session_id = ?")
    .get(sessionId) as { n: number };
  return row.n;
}

export interface SeedReportInput {
  runId: string;
  generationId?: string | null;
  userLogin: string;
  title: string;
  source: string;
  summary: string;
  body: unknown;
  createdAt: string;
  linkedJobRunId?: string | null;
}

/**
 * Issue #6101 — write one canonical report DIRECTLY into D1
 * agent_reports (the D1 writer's shape; the id is a fresh UUID,
 * exactly as the canonical write path mints it). The twin link
 * is stamped by the caller when the report twins a D1 job run
 * record — no projector resolves it anymore.
 */
async function seedReportD1(fx: D1Fixture, input: SeedReportInput): Promise<string> {
  const auditDb = createD1AuditReportDb(fx.mock as never);
  await ensureAuditReportSchema(auditDb);
  const audit = new D1AuditReportAdapter(auditDb);
  const reportId = crypto.randomUUID();
  const createdAtMs = Date.parse(input.createdAt);
  await audit.recordReport({
    tenantId: "primary",
    workspaceId: "primary",
    reportId,
    runId: input.runId,
    generationId: input.generationId ?? null,
    title: input.title,
    source: input.source,
    summary: input.summary,
    body: typeof input.body === "string" ? input.body : JSON.stringify(input.body),
    createdAtMs,
    updatedAtMs: createdAtMs,
    version: 1,
    provenanceWriter: "test-d1-seed",
    provenanceSourceDo: "test",
    provenanceSourceVersion: "1",
    linkedJobRunId: input.linkedJobRunId ?? null,
    userLogin: input.userLogin,
    bodyR2Key: null,
  });
  return reportId;
}

const D1_JOB_COLUMNS =
  "job_id, tenant_id, session_id, capability, display_name, status, payload_json, result_json, response_status, error, error_code, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at, trigger, triggered_by, schedule_id, last_activity_at, projected_at_ms";
const D1_JOB_PLACEHOLDERS = Array.from({ length: 27 }, () => "?").join(", ");

/**
 * Issue #6101 — write one job DIRECTLY into the frozen D1
 * agent_async_jobs table (the pre-cutover projected row shape).
 */
function insertJob(fx: D1Fixture, jobId: string, createdAt: string): void {
  fx.mock.sqlite.prepare(
    `INSERT INTO agent_async_jobs (${D1_JOB_COLUMNS}) VALUES (${D1_JOB_PLACEHOLDERS})`,
  ).run(
    jobId,
    "primary",
    "session-1",
    "http.request",
    `Job ${jobId}`,
    "completed",
    JSON.stringify({ method: "POST", pathAndQuery: "/etrade/screen", body: { trigger: "scheduled" } }),
    JSON.stringify({ success: true }),
    null,
    null,
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
    null,
    null,
    null,
    null,
    null,
    Date.now(),
  );
}

/**
 * Issue #6101 — seed an outcome-carrying D1 row via the REAL fold
 * (foldJobOutcome, the entry point production uses). Never via
 * buildJobRunRecord: the builder drops the outcome-fact fields and
 * rejects the "job-outcome" system. Returns the folded record so
 * a twinned report can stamp its linkedJobRunId from the record's
 * d1 id.
 */
async function foldOutcome(fx: D1Fixture, outcome: JobOutcomeRow): Promise<JobRunRecord> {
  const jobDb = createD1JobRunRecordDb(fx.mock as never);
  await ensureJobRunRecordsSchema(jobDb);
  const store = new D1JobRunRecordStore(jobDb);
  const folded = await store.foldJobOutcome(toFoldInput(outcome), "primary", Date.now());
  expect(folded.landed).toBe(true);
  expect(folded.created).toBe(true);
  return folded.record;
}

/** A JobOutcomeRow as a fold input: null facts become absent (never wiped), never null. */
function toFoldInput(outcome: JobOutcomeRow): JobOutcomeInput {
  return {
    id: outcome.id,
    kind: outcome.kind,
    trigger: outcome.trigger,
    status: outcome.status,
    ...(outcome.scanned != null ? { scanned: outcome.scanned } : {}),
    ...(outcome.matched != null ? { matched: outcome.matched } : {}),
    ...(outcome.codedError != null ? { codedError: outcome.codedError } : {}),
    ...(outcome.reportUrl != null ? { reportUrl: outcome.reportUrl } : {}),
    ...(outcome.pdfKey != null ? { pdfKey: outcome.pdfKey } : {}),
    ...(outcome.xlsxKey != null ? { xlsxKey: outcome.xlsxKey } : {}),
    ...(outcome.csvKey != null ? { csvKey: outcome.csvKey } : {}),
    deliveryStates: outcome.deliveryStates ?? {},
    origin: outcome.origin,
    createdAt: outcome.createdAt,
  };
}

function ctxFor(sql: MockSqlStorage, env: D1Fixture["env"], userLogin = "analyst") {
  // Issue #6103 — the route reads D1 from ctx.env; the schedule
  // reader is stubbed to [] (the parity fixture's seam) so the
  // orchestrator schedule read cannot add rows here.
  return { ensureTables: () => sql, userLogin, env, scheduleReader: async () => [] };
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

describe("GET /workflow-runs reports filter (route level, D1-only #6103)", () => {
  it("attaches canonical documents to a twin and filters to report runs only (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    // The outcome is folded onto D1 FIRST, so the canonical
    // report's twin link (stamped from the folded record's d1 id)
    // absorbs the fold row into the canonical run instead of
    // rendering twice.
    const folded = await foldOutcome(fx, {
      id: "outcome-1",
      kind: "goal",
      trigger: "manual",
      status: "completed",
      scanned: null,
      matched: null,
      codedError: null,
      reportUrl: null,
      pdfKey: null,
      xlsxKey: null,
      csvKey: null,
      deliveryStates: {},
      origin: "manual",
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    insertJob(fx, "job-other", "2026-10-27T12:00:00.000Z");
    const repId = await seedReportD1(fx, {
      runId: "outcome-1",
      generationId: "outcome-1",
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
      linkedJobRunId: d1JobRunRecordId(folded),
    });
    expect(countD1Reports(fx)).toBe(1);
    expect(countD1Jobs(fx)).toBe(1);

    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(all.storeErrors?.runs).toBeUndefined();
    expect(all.storeErrors?.stages).toMatch("not projected");
    const twin = all.runs.find((r: any) => r.runId === "outcome-1");
    expect(twin).toBeDefined();
    expect(twin.documents.reportId).toBe(repId);
    expect(twin.documents.family).toBe("goal");
    expect(twin.documents.xlsxStatus).toBe("failed");
    expect(twin.documents.xlsxError).toBe("workbook blew up");
    // The fold row is the twin, not a second run: its D1 id never
    // renders alongside the canonical run.
    expect(all.runs.map((r: any) => r.runId)).not.toContain(
      "d1:outcome-1:2026-10-27T13:00:00.000Z:2026-10-27T13:00:00.000Z",
    );

    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(filtered.runs.map((r: any) => r.runId)).toEqual(["outcome-1"]);
  });

  it("filters BEFORE the 50-slice: a report run past position 50 still shows (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    for (let i = 0; i < 60; i++) {
      const minute = String(59 - i).padStart(2, "0");
      insertJob(fx, `job-${i}`, `2026-11-01T00:${minute}:00.000Z`);
    }
    await seedReportD1(fx, {
      runId: "report-old",
      userLogin: "analyst",
      title: "Old goal report",
      source: "goal_screen",
      summary: "old summary",
      body: { pdfKey: "goal/old.pdf" },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(countD1Reports(fx)).toBe(1);
    expect(countD1Jobs(fx)).toBe(60);

    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(all.runs.map((r: any) => r.runId)).not.toContain("report-old");

    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(filtered.runs.map((r: any) => r.runId)).toContain("report-old");
  });

  it("never leaks another user's canonical rows (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    await seedReportD1(fx, {
      runId: "foreign-run",
      userLogin: "someone-else",
      title: "Foreign report",
      source: "goal_screen",
      summary: "foreign",
      body: { pdfKey: "goal/foreign.pdf" },
      createdAt: "2026-10-27T13:00:00.000Z",
    });
    expect(countD1Reports(fx)).toBe(1);
    // The row IS in D1 under its owner — the route still hides it
    // from analyst, so the empty page below is a real owner-scope
    // pin, not an empty-store accident.
    const audit = createAuditReportAdapter(fx.env as never)!;
    expect(await audit.listReports("primary", { limit: 10, userLogin: "someone-else" })).toHaveLength(1);
    const filtered = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50&reports=only"), new URL("https://agent.internal/workflow-runs?limit=50&reports=only"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(filtered.runs).toEqual([]);
    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(all.runs.map((r: any) => r.runId)).not.toContain("foreign-run");
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

  it("route mints a report-only run carrying a staged canonical body's stages (D1-only, #6103)", async () => {
    const fx = await d1Fixture();
    await seedReportD1(fx, {
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
    expect(countD1Reports(fx)).toBe(1);
    const all = (await (await handleWorkflowRunsRoutes(request("/workflow-runs?limit=50"), new URL("https://agent.internal/workflow-runs?limit=50"), "/workflow-runs", "session-1", ctxFor(fx.sql, fx.env)))!.json()) as any;
    expect(all.storeErrors?.runs).toBeUndefined();
    const run = all.runs.find((r: any) => r.runId === "staged-goal");
    expect(run).toBeDefined();
    expect(run.source).toBe("report");
    expect(run.stages.map((s: any) => s.stage)).toEqual(["feed", "gather"]);
    expect(run.stageCount).toBe(2);
    expect(run.completedStages).toBe(1);
    expect(run.failedStages).toBe(1);
  });
});
