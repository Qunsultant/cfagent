/**
 * Issue #4116 — the D1 read seam for the three surfaces
 * (ReportsPanel /api/runs, Workflow Runs, RunDetailView).
 *
 * Issue #6103 — the seam is now the ONLY read path: the runs +
 * reports routes read the projected ledgers from D1 alone, no DO
 * read in the path, no mode switch. Projected reports via
 * listReports (owner-scoped by userLogin, exactly like the DO
 * read), projected async jobs via listAsyncJobs (session-scoped,
 * exactly like the DO read), the engine's D1 jobRunRecords
 * (already D1), and the outcomes list via listD1JobOutcomes (the
 * #6006 folded facts on D1 job_run_records). Linked twins are
 * absorbed: a jobRunRecord named by a projected report's
 * linkedJobRunId is dropped, so one run is one row.
 *
 * Boundaries, stated plainly: scans / discovery / the screener
 * feed are NOT projected (options via #4069, the feed is
 * in-memory, not a DO ledger) — those lists are empty and the
 * caller names them in storeErrors. Stage transitions are likewise
 * not projected — empty + named, permanently (user ruling 2026-11-25,
 * "no more projections"). Pointer bodies resolve from R2,
 * read-only (never the DO backfill, which would write to the DO
 * in a read path).
 *
 * What the reads rest on (stated, not hidden): the D1 rows arrive
 * via the grandfathered #6099 projector, which keeps copying new
 * DO rows into D1 at write time until #6101 retires it. A run is
 * visible only if it has a D1 row.
 */
import { createAuditReportAdapter } from "../data/createAuditReportPorts";
import { ensureAuditReportSchema } from "../data/d1AuditReportAdapter";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../data/createRunLedgerPorts";
import type { CanonicalReportRow } from "../data/auditReportPorts";
import type { ProjectedAsyncJobRow } from "../data/runLedgerPorts";
import { resolveCanonicalReportBody } from "./scheduledReports";
import type { ScheduledReportHit } from "./scheduledReports";
import { runSummaryFromReport, type RunSummary } from "./runSummaries";
import type { WorkflowRunJobRow, WorkflowRunOutcomeRow } from "./workflowRuns";
import { listD1JobRunRecords } from "./jobRunRecordReads";
import type { JobRunRecord } from "./jobRunRecords";
import type { Env } from "../types";

/** A projected D1 report row as the DO read's hit shape. */
export function projectedReportHit(row: CanonicalReportRow): ScheduledReportHit {
  return {
    id: row.reportId,
    runId: row.runId,
    title: row.title,
    source: row.source,
    summary: row.summary,
    body: row.body,
    createdAt: new Date(row.createdAtMs).toISOString(),
    generationId: row.generationId,
    userLogin: row.userLogin ?? null,
    bodyR2Key: row.bodyR2Key ?? null,
    fanoutOutcome: null,
  };
}

export interface ProjectedReportList {
  /** Hits with pointer bodies resolved (read-only R2 fetch). */
  hits: ScheduledReportHit[];
  summaries: RunSummary[];
  /** The job-run-record ids absorbed by the projected reports' twin links. */
  linkedJobRunIds: Set<string>;
  /** The twin link per report (for the detail lookup's twin-id redirect). */
  links: Array<{ reportId: string; jobRunId: string }>;
}

/**
 * The D1-only reports read. Throws when AGENT_DB is unbound so
 * the caller names it in storeErrors — never a silent empty list.
 */
export async function listProjectedReportSummaries(
  env: Partial<Env>,
  opts: { tenantId: string; userLogin?: string; limit: number },
): Promise<ProjectedReportList> {
  const audit = createAuditReportAdapter(env);
  if (!audit) {
    throw new Error("run-ledger projection unavailable: AgentDB is not bound");
  }
  await ensureAuditReportSchema(audit.db);
  const ledger = createRunLedgerAdapter(env);
  if (ledger) await ensureRunLedgerTables(ledger);
  const rows = await audit.listReports(opts.tenantId, {
    userLogin: opts.userLogin,
    limit: opts.limit,
  });
  const hits = rows.map(projectedReportHit);
  const resolved = await Promise.all(
    hits.map(async (h) => ({
      ...h,
      body: (await resolveCanonicalReportBody(env as { REPORTS_BUCKET?: R2Bucket }, h)) ?? "",
    })),
  );
  const links = rows
    .filter((r): r is CanonicalReportRow & { linkedJobRunId: string } =>
      typeof r.linkedJobRunId === "string" && r.linkedJobRunId !== "",
    )
    .map((r) => ({ reportId: r.reportId, jobRunId: r.linkedJobRunId }));
  return {
    hits: resolved,
    summaries: resolved.map(runSummaryFromReport),
    linkedJobRunIds: new Set(links.map((l) => l.jobRunId)),
    links,
  };
}

/** Drop job-run-record summaries absorbed by a projected report's twin link. */
export function dropLinkedJobRunRecords(
  summaries: RunSummary[],
  linkedJobRunIds: Set<string>,
): RunSummary[] {
  if (linkedJobRunIds.size === 0) return summaries;
  return summaries.filter((s) => !linkedJobRunIds.has(s.id));
}

/** A projected D1 async job as the Workflow Runs job-row shape. */
export function projectedJobToWorkflowRunJobRow(row: ProjectedAsyncJobRow): WorkflowRunJobRow {
  return {
    job_id: row.jobId,
    capability: row.capability,
    display_name: row.displayName,
    status: row.status,
    payload_json: row.payloadJson ?? null,
    result_json: row.resultJson ?? null,
    error: row.error ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt ?? null,
    started_at: row.startedAt ?? null,
    completed_at: row.completedAt ?? null,
    parent_job_id: row.parentJobId ?? null,
    job_kind: row.jobKind ?? null,
    channel: row.channel ?? null,
    not_before: row.notBefore ?? null,
    stage: row.stage ?? null,
    chain_id: row.chainId ?? null,
    stuck_alerted_at: row.stuckAlertedAt ?? null,
    trigger: row.trigger ?? null,
    triggered_by: row.triggeredBy ?? null,
    schedule_id: row.scheduleId ?? null,
    last_activity_at: row.lastActivityAt ?? null,
    error_code: row.errorCode ?? null,
  };
}

/**
 * The D1-only async-jobs read (Workflow Runs' `jobs` input).
 * Session-scoped exactly like the DO read. Throws when AGENT_DB
 * is unbound so the caller names it in storeErrors.
 */
export async function listProjectedWorkflowRunJobs(
  env: Partial<Env>,
  opts: { tenantId: string; sessionId: string; limit: number },
): Promise<WorkflowRunJobRow[]> {
  const adapter = createRunLedgerAdapter(env);
  if (!adapter) {
    throw new Error("run-ledger projection unavailable: AgentDB is not bound");
  }
  await ensureRunLedgerTables(adapter);
  const rows = await adapter.listAsyncJobs(opts.tenantId, opts.limit, {
    sessionId: opts.sessionId,
  });
  return rows.map(projectedJobToWorkflowRunJobRow);
}

/**
 * Issue #6103 (Q1) — does this D1 job run record carry folded
 * outcome facts? Fold-created rows (`system === "job-outcome"`)
 * always do; attached rows do when any fact column is non-null.
 * Engine rows never carry them: no engine writer sets the fact
 * fields, and the read normalizer never fills them.
 */
export function carriesOutcomeFacts(record: JobRunRecord): boolean {
  return (
    record.system === "job-outcome" ||
    record.origin != null ||
    record.scanned != null ||
    record.matched != null ||
    record.codedError != null ||
    record.deliveryStates != null ||
    record.pdfKey != null ||
    record.xlsxKey != null ||
    record.csvKey != null ||
    record.reportUrl != null
  );
}

/**
 * Issue #6103 (Q1) — one D1 job run record as the DO outcomes
 * list's row shape (`JobOutcomeRow`, `src/data/jobOutcomePorts.ts`,
 * → `WorkflowRunOutcomeRow`). Field-for-field, with the fold's
 * losses stated, never guessed:
 * - id: fold-created rows carry the outcome id as jobId. Attached
 *   rows (facts folded onto an engine row) carry no outcome-id
 *   column; the id is recovered via the linkage the fold matched
 *   (workflowId, else asyncJobId — the same preference order as
 *   `findByLinkage`), falling back to jobId. In the corner where
 *   both linkage fields are set and the asyncJobId matched, the id
 *   reads the workflowId instead — the outcome then renders as its
 *   own run rather than attaching to the group; visible, never
 *   silently merged.
 * - kind: the fold stores the outcome kind as `operation` on the
 *   create leg. On the attach leg the operation is the engine's,
 *   not the outcome's — the kind does not survive the fold, so
 *   attached rows read "unknown" and the family falls back to the
 *   job group's capabilities (`workflowFamilyForJobs`).
 * - trigger: the fold stores the outcome trigger on the create
 *   leg; on the attach leg it reads the engine row's ledger
 *   trigger (same vocabulary family — the five dispatch modes are
 *   among the eight ledger values).
 * - status: a non-null codedError means "failed" (errors belong to
 *   failed outcomes). Otherwise, on fold-created rows, the D1
 *   outcome column is the outcome's (failure → "failed"; success
 *   + a "Partial coverage" descriptor → "partial"; else
 *   "completed"). On attached rows without a coded error the
 *   partial-ness and a codeless failure do not survive the fold,
 *   so the row reads "completed".
 * - scanned / matched / codedError / reportUrl / pdfKey / xlsxKey /
 *   csvKey / deliveryStates / origin: the folded fact columns,
 *   verbatim (null stays null; absent delivery states read as the
 *   DO shape's empty map).
 * - createdAt: the fold-created row's `started` IS the outcome's
 *   createdAt. On attached rows it reads the engine run's start.
 */
export function d1JobRunRecordToOutcomeRow(record: JobRunRecord): WorkflowRunOutcomeRow {
  const folded = record.system === "job-outcome";
  const status =
    record.codedError != null
      ? "failed"
      : folded && record.outcome === "failure"
        ? "failed"
        : folded &&
            typeof record.descriptor === "string" &&
            record.descriptor.startsWith("Partial coverage")
          ? "partial"
          : "completed";
  return {
    id: folded ? record.jobId : (record.workflowId ?? record.asyncJobId ?? record.jobId),
    kind: folded ? record.operation : "unknown",
    trigger: typeof record.trigger === "string" ? record.trigger : "unknown",
    status,
    scanned: record.scanned ?? null,
    matched: record.matched ?? null,
    codedError: record.codedError ?? null,
    reportUrl: record.reportUrl ?? null,
    pdfKey: record.pdfKey ?? null,
    xlsxKey: record.xlsxKey ?? null,
    csvKey: record.csvKey ?? null,
    deliveryStates: record.deliveryStates ?? {},
    origin: record.origin ?? null,
    createdAt: record.started,
  };
}

/**
 * Issue #6103 (Q1) — the D1 outcomes list, newest first. Reads
 * the newest D1 job run records and keeps the outcome-carrying
 * rows. The fetch overshoots 3x the requested limit because the
 * window mixes engine rows with outcome rows; a sparse window
 * returns a short list, never a guessed row. Throws when AGENT_DB
 * is unbound so the caller names it in storeErrors.
 */
export async function listD1JobOutcomes(
  env: Partial<Env>,
  opts: { limit: number },
): Promise<WorkflowRunOutcomeRow[]> {
  const limit = Math.max(1, opts.limit);
  const records = await listD1JobRunRecords(env, Math.min(600, limit * 3));
  const rows: WorkflowRunOutcomeRow[] = [];
  for (const record of records) {
    if (!carriesOutcomeFacts(record)) continue;
    rows.push(d1JobRunRecordToOutcomeRow(record));
    if (rows.length >= limit) break;
  }
  return rows;
}
