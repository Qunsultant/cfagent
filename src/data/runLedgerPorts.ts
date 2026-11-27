/**
 * Issue #6101 — the port types for the FROZEN D1 agent_async_jobs
 * read. The #6099 projector is deleted with this slice, so nothing
 * writes agent_async_jobs anymore and every projection type in this
 * module died with it (carriers, read modes, projection inputs,
 * the projector interface). What remains is the row shape the
 * Workflow Runs jobs list reads back from D1 (pre-cutover
 * projected rows only, until F5 restores the list via the engine
 * run record).
 *
 * This module imports port types only — never a store client, never
 * drizzle-orm (the journalPosting structural rule).
 */

/** A mas_async_jobs row as the projector received it (the DO row's own shape). */
export interface AsyncJobProjectionInput {
  jobId: string;
  sessionId: string;
  capability: string;
  displayName: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  responseStatus: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  parentJobId: string | null;
  jobKind: string | null;
  channel: string | null;
  notBefore: string | null;
  stage: string | null;
  chainId: string | null;
  stuckAlertedAt: string | null;
  trigger: string | null;
  triggeredBy: string | null;
  scheduleId: string | null;
  lastActivityAt: string | null;
  tenantId: string;
}

/** A projected async-job row as read back from D1. */
export interface ProjectedAsyncJobRow extends AsyncJobProjectionInput {
  projectedAtMs: number;
}
