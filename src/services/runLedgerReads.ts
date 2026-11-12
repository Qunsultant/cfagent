/**
 * Issue #4116 — the D1-only read seam for the three surfaces
 * (ReportsPanel /api/runs, Workflow Runs, RunDetailView).
 *
 * When the tenant's readMode is "d1-only", the surfaces read the
 * projected ledgers from D1 alone — no DO read in the path:
 * projected reports via listReports (owner-scoped by userLogin,
 * exactly like the DO read), projected async jobs via
 * listAsyncJobs (session-scoped, exactly like the DO read), and
 * the engine's D1 jobRunRecords (already D1). Linked twins are
 * absorbed: a jobRunRecord named by a projected report's
 * linkedJobRunId is dropped, so one run is one row.
 *
 * When the readMode is "merged" (the default — an absent config
 * row, an unreadable store, or an explicit merged setting), the
 * caller keeps the Option B merged view; this module is not
 * consulted. The response carries the resolved ledgerReadMode so
 * the mode is visible, never silent.
 *
 * Boundaries, stated plainly: scans / discovery / the screener
 * feed are NOT projected (options via #4069, the feed is
 * in-memory, not a DO ledger) — in D1-only mode those lists are
 * empty and the caller names them in storeErrors. Outcomes and
 * stage transitions are likewise not projected — empty + named.
 * Pointer bodies resolve from R2, read-only (never the DO
 * backfill, which would write to the DO in a read path).
 */
import { createAuditReportAdapter } from "../data/createAuditReportPorts";
import { ensureAuditReportSchema } from "../data/d1AuditReportAdapter";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../data/createRunLedgerPorts";
import type { CanonicalReportRow } from "../data/auditReportPorts";
import type { ProjectedAsyncJobRow, RunLedgerReadMode } from "../data/runLedgerPorts";
import { readTenantProjectionCarriers } from "./projectionCarriers";
import { resolveCanonicalReportBody } from "./scheduledReports";
import type { ScheduledReportHit } from "./scheduledReports";
import { runSummaryFromReport, type RunSummary } from "./runSummaries";
import type { WorkflowRunJobRow } from "./workflowRuns";
import type { Env } from "../types";

/** The tenant's read mode; anything unreadable or absent reads "merged". */
export async function resolveLedgerReadMode(env: Partial<Env>): Promise<RunLedgerReadMode> {
  try {
    const res = await readTenantProjectionCarriers(env);
    return res.status === "ok" ? res.readMode : "merged";
  } catch {
    return "merged";
  }
}

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
 * the caller names it in storeErrors (and the merged view stays
 * the fallback) — never a silent empty list.
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
