/**
 * Issue #4116 — the ORM + queue write-site hooks for the run-ledger
 * projection. One hook per DO ledger (reports, async jobs); each
 * hook re-reads the row that JUST landed (never projects an
 * in-memory guess — a deduped store returns the pre-existing row,
 * and the projection must carry what landed), reads the tenant's
 * carrier config once, and fires the enabled carriers.
 *
 * Never throws: a hook failure must never fail the DO write, the
 * submission, or the run (ADR 0002 / #1546). Every failure is
 * logged by name; the sweep carrier is the backstop for a row
 * whose carriers all missed it.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { getScheduledReportById } from "./scheduledReports";
import type { SqlStorage } from "../orm";
import { readTenantProjectionCarriers } from "./projectionCarriers";
import { postRunLedgerBestEffort, type PostRunLedgerResult } from "./runLedgerProjectionPosting";
import { publishRunLedgerProject } from "../workflows/runLedgerQueueTransport";
import type {
  AsyncJobProjectionInput,
  ReportProjectionInput,
} from "../data/runLedgerProjection";
import type { AsyncJobStoredRow } from "../data/asyncJobPorts";
import type { Env } from "../types";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/runLedgerProjectionHooks",
});

async function fireCarriers(
  env: Partial<Env>,
  tenantId: string,
  ledger: "reports" | "async_jobs",
  naturalKey: string,
  userLogin: string | null,
  input: ReportProjectionInput | AsyncJobProjectionInput,
  nowMs: number,
  skipQueue?: boolean,
): Promise<PostRunLedgerResult | null> {
  let carriers;
  try {
    carriers = await readTenantProjectionCarriers(env);
  } catch (err) {
    structuredLog.error("runLedger.carrier_config_read_failed", {
      message: "[run-ledger] carrier config read failed; no carrier fires for this row.",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (carriers.status !== "ok") {
    // Unconfigured tenant or unavailable store: named, never silent.
    structuredLog.info("runLedger.carrier_config_unavailable", {
      message: `[run-ledger] no carrier fires for tenant ${tenantId} (${carriers.status}: ${carriers.error}); row stays DO-only until a carrier is configured.`,
    });
    return null;
  }
  const flags = carriers.carriers;
  let post: PostRunLedgerResult | null = null;
  if (flags.orm) {
    post = await postRunLedgerBestEffort(
      env,
      tenantId,
      ledger === "reports"
        ? { ledger: "reports", row: input as ReportProjectionInput }
        : { ledger: "async_jobs", row: input as AsyncJobProjectionInput },
      nowMs,
    );
  } else {
    structuredLog.info("runLedger.carrier_skipped", {
      message: `[run-ledger] ORM carrier not configured for tenant ${tenantId}; skipping.`,
    });
  }
  if (skipQueue) {
    // The queue consumer's re-projection: this call IS the queue
    // carrier's delivery — publishing again would loop the
    // message back onto the queue with a fresh id, forever.
    return post;
  }
  if (flags.queues) {
    if (!userLogin || userLogin === "default") {
      structuredLog.info("runLedger.carrier_skipped", {
        message: `[run-ledger] queue carrier skipped for ${ledger} ${naturalKey}: no real owning login to route to.`,
      });
    } else {
      await publishRunLedgerProject({
        queue: (env as { SCREENER_EVENTS?: unknown }).SCREENER_EVENTS as never,
        message: { ledger, naturalKey, tenantId, userLogin },
        at: new Date(nowMs).toISOString(),
      });
    }
  } else {
    structuredLog.info("runLedger.carrier_skipped", {
      message: `[run-ledger] queue carrier not configured for tenant ${tenantId}; skipping.`,
    });
  }
  return post;
}

/**
 * Project a mas_reports row that just landed via a reportDispatch
 * persist. Re-reads the stored row by id (the store may have
 * deduped to a pre-existing row — the projection carries what
 * landed, never the caller's in-memory guess). The DO row has no
 * updated_at column: rows are immutable once stored, so
 * updatedAtMs == createdAtMs is the honest ordering stamp.
 *
 * Returns the ORM post result, or null when nothing was
 * attempted (row missing, or no carrier configured). `skipQueue`
 * is the queue consumer's re-projection flag: the consumer IS
 * the queue carrier's delivery, so it must not publish again.
 */
export async function projectCanonicalReportBestEffort(args: {
  env: Partial<Env>;
  sql: SqlStorage;
  reportId: string;
  generationId: string | null;
  userLogin: string;
  nowMs?: number;
  skipQueue?: boolean;
}): Promise<PostRunLedgerResult | null> {
  try {
    const hit = getScheduledReportById(args.sql, args.reportId, { userLogin: args.userLogin });
    if (!hit) {
      structuredLog.warn("runLedger.report_row_missing", {
        message: `[run-ledger] stored report ${args.reportId} not readable after store; projection skipped (sweep repairs).`,
      });
      return null;
    }
    const tenantId = resolveIaaaTenant(args.env as Env);
    const createdAtMs = Date.parse(hit.createdAt);
    const input: ReportProjectionInput = {
      reportId: hit.id,
      tenantId,
      workspaceId: tenantId,
      runId: hit.runId,
      generationId: args.generationId,
      title: hit.title,
      source: hit.source,
      summary: hit.summary,
      body: hit.body,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : args.nowMs ?? Date.now(),
      updatedAtMs: Number.isFinite(createdAtMs) ? createdAtMs : args.nowMs ?? Date.now(),
      // The row's own owner wins; the call-site login is the
      // fallback for rows stored before the owner was readable.
      userLogin: hit.userLogin ?? args.userLogin,
      bodyR2Key: hit.bodyR2Key,
    };
    return await fireCarriers(
      args.env,
      tenantId,
      "reports",
      hit.id,
      args.userLogin,
      input,
      args.nowMs ?? Date.now(),
      args.skipQueue,
    );
  } catch (err) {
    structuredLog.error("runLedger.report_hook_failed", {
      message: "[run-ledger] report projection hook failed — DO write unaffected",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The owning login for a mas_async_jobs row, from its payload. */
function userLoginOfAsyncJob(row: AsyncJobStoredRow): string | null {
  try {
    const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    const login = payload && typeof payload === "object" ? (payload as Record<string, unknown>)["userLogin"] : null;
    return typeof login === "string" && login.trim() !== "" ? login : null;
  } catch {
    return null;
  }
}

/**
 * Project a mas_async_jobs row that just landed or transitioned
 * (submit, terminal insert, complete, fail). The caller passes the
 * stored row (re-read after the transition when the transition
 * changed it). The DO row carries ISO created_at/updated_at —
 * parsed to ms for the shared ordering rule.
 *
 * Returns the ORM post result, or null when nothing was
 * attempted (no carrier configured). `skipQueue` is the queue
 * consumer's re-projection flag (see the report hook).
 */
export async function projectAsyncJobBestEffort(args: {
  env: Partial<Env>;
  row: AsyncJobStoredRow;
  nowMs?: number;
  skipQueue?: boolean;
}): Promise<PostRunLedgerResult | null> {
  try {
    const tenantId = resolveIaaaTenant(args.env as Env);
    const input: AsyncJobProjectionInput = {
      jobId: args.row.job_id,
      sessionId: args.row.session_id,
      tenantId,
      status: args.row.status,
      capability: args.row.capability,
      displayName: args.row.display_name,
      payloadJson: args.row.payload_json ?? "{}",
      resultJson: args.row.result_json,
      responseStatus:
        args.row.response_status === null || args.row.response_status === undefined
          ? null
          : String(args.row.response_status),
      error: args.row.error,
      errorCode: args.row.error_code,
      createdAt: args.row.created_at,
      updatedAt: args.row.updated_at,
      startedAt: args.row.started_at,
      completedAt: args.row.completed_at,
      parentJobId: args.row.parent_job_id,
      jobKind: args.row.job_kind,
      channel: args.row.channel,
      notBefore: args.row.not_before,
      stage: args.row.stage,
      chainId: args.row.chain_id,
      stuckAlertedAt: args.row.stuck_alerted_at,
      trigger: args.row.trigger,
      triggeredBy: args.row.triggered_by,
      scheduleId: args.row.schedule_id,
      lastActivityAt: args.row.last_activity_at,
    };
    return await fireCarriers(
      args.env,
      tenantId,
      "async_jobs",
      args.row.job_id,
      userLoginOfAsyncJob(args.row),
      input,
      args.nowMs ?? Date.now(),
      args.skipQueue,
    );
  } catch (err) {
    structuredLog.error("runLedger.async_job_hook_failed", {
      message: "[run-ledger] async-job projection hook failed — DO write unaffected",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
