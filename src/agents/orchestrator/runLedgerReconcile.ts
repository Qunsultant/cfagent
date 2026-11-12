/**
 * Issue #4116 — the sweep carrier: a one-off backfill + repair
 * pass that projects this DO instance's mas_reports and
 * mas_async_jobs rows into D1 through the shared projector
 * (via postRunLedgerBestEffort, the ORM carrier's write helper).
 *
 * This is the backstop for rows whose ORM + queue carriers both
 * missed them (an unconfigured tenant at write time, a failed
 * publish, a lost message). It is NOT a recurring cron (Venus,
 * 2026-11-12: one-off backfill; reversing #4112's schedules-off
 * is not authorized) — the operator invokes it deliberately
 * through POST /api/ops/run-ledger-reconcile, once per instance
 * (an optional instance hint names the DO; no instance
 * enumeration exists, so the operator names the instance).
 *
 * Bounds: at most `limit` rows per ledger per call (default 100),
 * newest-first, single-shot restart-from-top — a second call
 * re-lists from the top and projects whatever is still missing
 * (idempotent upserts make re-projection safe). No durable
 * cursor in this slice (recorded limit).
 *
 * Never throws for row-level failures: each row's failure is
 * collected in `errors` with its natural key, and the sweep
 * continues. A tenant whose sweep carrier is not configured gets
 * a named `refused` instead of a silent no-op.
 */
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { listScheduledReports } from "../../services/scheduledReports";
import { readTenantProjectionCarriers } from "../../services/projectionCarriers";
import { postRunLedgerBestEffort } from "../../services/runLedgerProjectionPosting";
import { createAsyncJobPorts } from "../../data/createAsyncJobPorts";
import type { SqlStorage } from "../../orm";
import type { Env } from "../../types";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/runLedgerReconcile",
});

/** The sweep's hard per-ledger bound per call. */
export const RUN_LEDGER_RECONCILE_LIMIT = 100;

export interface RunLedgerReconcileError {
  ledger: "reports" | "async_jobs";
  naturalKey: string;
  error: string;
}

export interface ReconcileRunLedgerResult {
  checked: number;
  reconciled: number;
  alreadyCurrent: number;
  errors: RunLedgerReconcileError[];
  /** Set when the sweep refused to run (named, never silent). */
  refused?: string;
}

export async function reconcileRunLedgerProjection(args: {
  env: Partial<Env>;
  sql: SqlStorage;
  /** The instance's session key — the async-job list is session-scoped. */
  sessionId: string;
  limit?: number;
  nowMs?: number;
}): Promise<ReconcileRunLedgerResult> {
  const env = args.env;
  const tenantId = resolveIaaaTenant(env as Env);
  const nowMs = args.nowMs ?? Date.now();
  const limit = Math.min(Math.max(args.limit ?? RUN_LEDGER_RECONCILE_LIMIT, 1), RUN_LEDGER_RECONCILE_LIMIT);
  const result: ReconcileRunLedgerResult = {
    checked: 0,
    reconciled: 0,
    alreadyCurrent: 0,
    errors: [],
  };

  // The sweep carrier's own config gate: a tenant that never
  // configured the sweep carrier gets a named refusal, never a
  // silent zero-row pass that looks like a clean bill of health.
  let carriers;
  try {
    carriers = await readTenantProjectionCarriers(env);
  } catch (err) {
    result.refused = `carrier config unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (carriers.status !== "ok" || !carriers.carriers.sweep) {
    result.refused =
      carriers.status !== "ok"
        ? `no projection carriers configured for tenant ${tenantId} (${carriers.status}: ${carriers.error})`
        : `sweep carrier not configured for tenant ${tenantId}`;
    return result;
  }

  // Reports first: the DO row is the authority, so the sweep
  // projects exactly what is stored (body verbatim — inline or
  // R2 pointer, never resolved here). A row without a
  // generationId still projects; its twin link is simply null
  // (the twin survives honestly until a carrier projects it
  // with the key).
  const reports = listScheduledReports(args.sql, { limit });
  for (const hit of reports) {
    result.checked += 1;
    const createdAtMs = Date.parse(hit.createdAt);
    const posted = await postRunLedgerBestEffort(env, tenantId, {
      ledger: "reports",
      row: {
        reportId: hit.id,
        tenantId,
        workspaceId: tenantId,
        runId: hit.runId,
        generationId: hit.generationId,
        title: hit.title,
        source: hit.source,
        summary: hit.summary,
        body: hit.body,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
        updatedAtMs: Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
        userLogin: hit.userLogin,
        bodyR2Key: hit.bodyR2Key,
      },
    }, nowMs);
    if (posted.projected) {
      result.reconciled += 1;
    } else if (posted.skipped === "already-current") {
      result.alreadyCurrent += 1;
    } else {
      result.errors.push({
        ledger: "reports",
        naturalKey: hit.id,
        error: posted.skipped ?? "projection failed",
      });
    }
  }

  // Async jobs: workflowRunRows, not listRows — the list
  // projection never read payload_json or response_status, and
  // its multi-line SELECT is invisible to the shared mock; the
  // workflow projection is the single-line full row (payload
  // included). response_status is still not selected there, so
  // the sweep projects it as null — the ORM hook at transition
  // time carries the full row. Stale replays are already-current
  // by the shared ordering rule.
  const jobs = createAsyncJobPorts(args.sql as never).read.workflowRunRows(args.sessionId, limit);
  for (const row of jobs) {
    result.checked += 1;
    const posted = await postRunLedgerBestEffort(env, tenantId, {
      ledger: "async_jobs",
      row: {
        jobId: row.job_id,
        // The workflow projection does not select session_id;
        // the list is session-scoped, so this call's session is
        // the row's session by construction.
        sessionId: args.sessionId,
        tenantId,
        status: row.status,
        capability: row.capability,
        displayName: row.display_name,
        payloadJson: row.payload_json ?? "{}",
        resultJson: row.result_json,
        responseStatus: null,
        error: row.error,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        parentJobId: row.parent_job_id,
        jobKind: row.job_kind,
        channel: row.channel,
        notBefore: row.not_before,
        stage: row.stage,
        chainId: row.chain_id,
        stuckAlertedAt: row.stuck_alerted_at,
        trigger: row.trigger,
        triggeredBy: row.triggered_by,
        scheduleId: row.schedule_id,
        lastActivityAt: row.last_activity_at,
      },
    }, nowMs);
    if (posted.projected) {
      result.reconciled += 1;
    } else if (posted.skipped === "already-current") {
      result.alreadyCurrent += 1;
    } else {
      result.errors.push({
        ledger: "async_jobs",
        naturalKey: row.job_id,
        error: posted.skipped ?? "projection failed",
      });
    }
  }

  structuredLog.info("runLedger.reconcile_done", {
    message: `[run-ledger] reconcile done for tenant ${tenantId}: ${result.checked} checked, ${result.reconciled} reconciled, ${result.alreadyCurrent} already-current, ${result.errors.length} errors.`,
  });
  return result;
}
