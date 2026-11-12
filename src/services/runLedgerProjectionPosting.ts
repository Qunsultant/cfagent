/**
 * Issue #4116 — best-effort D1 post for the run-ledger projection
 * (the ORM carrier's write helper, mirroring postJournalBestEffort).
 *
 * The DO ledger stays authoritative; D1 is the projection. A post
 * failure must NEVER fail the DO write, the submission, or the run:
 * this helper catches every projection error, logs it loudly, and
 * resolves. Callers pass the resolved tenant + the DO row; the
 * carrier-config read happens at the call site (once per call
 * chain), never here — this helper is flag-agnostic: the queue
 * consumer and the sweep call it through their own carrier gates.
 *
 * "posted" means the D1 row is current after this call — a fresh
 * projection OR an already-current row both count. Only unbound
 * AGENT_DB and store errors report posted:false.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { createAuditReportAdapter } from "../data/createAuditReportPorts";
import { ensureAuditReportSchema } from "../data/d1AuditReportAdapter";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../data/createRunLedgerPorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import {
  createRunLedgerProjector,
  type AsyncJobProjectionInput,
  type ReportProjectionInput,
} from "../data/runLedgerProjection";
import type { ProjectRunLedgerResult } from "../data/runLedgerPorts";
import type { Env } from "../types";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/runLedgerProjectionPosting",
});

export interface PostRunLedgerResult extends ProjectRunLedgerResult {
  posted: boolean;
}

export type RunLedgerPostInput =
  | { ledger: "reports"; row: ReportProjectionInput }
  | { ledger: "async_jobs"; row: AsyncJobProjectionInput };

export async function postRunLedgerBestEffort(
  env: Partial<Env>,
  tenantId: string,
  input: RunLedgerPostInput,
  nowMs: number,
): Promise<PostRunLedgerResult> {
  const adapter = createRunLedgerAdapter(env);
  const audit = createAuditReportAdapter(env);
  const d1 = env.AGENT_DB;
  if (!adapter || !audit || !d1) {
    structuredLog.error("runLedger.post_skipped", {
      message: "[run-ledger] projection post skipped (AGENT_DB unbound); DO write unaffected.",
    });
    return { posted: false, projected: false, skipped: "unbound", linkedJobRunId: null };
  }
  try {
    // Both ensures: 0004 creates agent_reports, 0059 adds its
    // linked_job_run_id column + the run-ledger tables. The report
    // adapter only ensures 0004 on its own — without 0059 its
    // SELECT of linked_job_run_id would fail on a fresh database.
    await ensureAuditReportSchema(audit.db);
    await ensureRunLedgerTables(adapter);
    const jobRecordStore = new D1JobRunRecordStore(createD1JobRunRecordDb(d1));
    const projector = createRunLedgerProjector({
      reportStore: audit,
      asyncJobStore: adapter,
      jobRecordStore,
    });
    const result =
      input.ledger === "reports"
        ? await projector.projectReport(input.row, nowMs)
        : await projector.projectAsyncJob(input.row, nowMs);
    return {
      ...result,
      posted: result.projected || result.skipped === "already-current",
    };
  } catch (err) {
    structuredLog.error("runLedger.post_failed", {
      message: "[run-ledger] projection post failed — DO write unaffected",
      error: err instanceof Error ? err.message : String(err),
    });
    return { posted: false, projected: false, skipped: err instanceof Error ? err.message : String(err), linkedJobRunId: null };
  }
}
