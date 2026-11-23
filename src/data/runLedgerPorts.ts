/**
 * Issue #4116 — one system-of-record D1: the port types for the DO
 * run-ledger projection (mas_reports, mas_async_jobs, and — issue
 * #6099 — job_run_records → D1; and — issue #6006 — mas_job_outcomes
 * folds into the D1 job run records).
 *
 * This module imports port types only — never a store client, never
 * drizzle-orm (the journalPosting structural rule). The D1 side
 * lives in d1RunLedgerAdapter.ts (reports/async jobs) and
 * d1JobRunRecordAdapter.ts (job run records); the shared projector
 * logic in runLedgerProjection.ts; the carrier-config read in
 * services/projectionCarriers.ts.
 *
 * Grain: one D1 row per DO row, keyed on the DO row's natural key
 * (report id / async job id / the job run record's derived
 * identity (jobId, started, finished)). The DO row stays
 * authoritative; the D1 row is its projection. A projected row
 * carries the twin link (linkedJobRunId) when the projection
 * resolved it exactly — null otherwise, never guessed. A projected
 * job run record IS the twin, so its link is always null.
 */
import type { JobRunRecord } from "../services/jobRunRecords";
import type { JobOutcomeRow } from "./jobOutcomePorts";

/** The three projection carriers (Venus ruling, #4116 comment 6798859485). */
export interface ProjectionCarriers {
  queues: boolean;
  orm: boolean;
  sweep: boolean;
}

/** Which ledger the read surfaces use. "merged" is today's Option B view. */
export type RunLedgerReadMode = "merged" | "d1-only";

/**
 * The tenant's projection configuration, in the
 * readTenantBrokerSelection shape: ok | unconfigured | store_unavailable.
 * Absent row = unconfigured (no defaults in code — a tenant with no
 * carrier configured projects nothing and says so by name).
 */
export type TenantProjectionCarriersRead =
  | { status: "ok"; carriers: ProjectionCarriers; readMode: RunLedgerReadMode }
  | { status: "unconfigured"; error: string }
  | { status: "store_unavailable"; error: string };

/** A mas_reports row as the projector receives it (the DO row's own shape). */
export interface ReportProjectionInput {
  reportId: string;
  runId: string;
  generationId: string | null;
  title: string;
  source: string;
  summary: string;
  /** The DO body's exact form (inline text or R2 pointer), never resolved here. */
  body: string;
  createdAtMs: number;
  updatedAtMs: number;
  tenantId: string;
  workspaceId: string;
  /** Issue #4116 (migration 0060) — the DO row's owning login. */
  userLogin: string | null;
  /** Issue #4116 (migration 0060) — the DO row's R2 body pointer, or null when inline. */
  bodyR2Key: string | null;
}

/** A mas_async_jobs row as the projector receives it (the DO row's own shape). */
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

/**
 * Issue #6099 — a DO job_run_records row as the projector receives
 * it: the DO row's own shape, verbatim, plus its owning tenant.
 * The record is nested, not re-declared flat: JobRunRecord already
 * exists as one type, and a second flat copy of its ~20 fields
 * would drift. The projector stamps projectedAtMs itself (the
 * adapter stamps it from nowMs — callers never stamp projection
 * time themselves).
 */
export interface JobRunRecordProjectionInput {
  record: JobRunRecord;
  tenantId: string;
}

/**
 * Issue #6006 — a mas_job_outcomes row as the projector receives
 * it: the DO sink row's own shape, verbatim, plus its owning
 * tenant. Nested like JobRunRecordProjectionInput, for the same
 * reason: JobOutcomeRow already exists as one type. The fold
 * (attach-or-create on the D1 job_run_records row) lives in the
 * D1 adapter; the projector only routes it.
 */
export interface JobOutcomeProjectionInput {
  outcome: JobOutcomeRow;
  tenantId: string;
}

/** The stored carrier-config row (one per tenant). */
export interface TenantProjectionCarriersRow {
  tenantId: string;
  carriers: ProjectionCarriers;
  readMode: RunLedgerReadMode;
  updatedAtMs: number;
}

/** What one projection attempt returns. Never throws for a best-effort caller. */
export interface ProjectRunLedgerResult {
  projected: boolean;
  /** When false: why ("already-current" | "unbound" | the store error). */
  skipped?: string;
  /** The twin link stamped on this projection (null when unlinked). */
  linkedJobRunId?: string | null;
}

/**
 * The shared projector — the ONE D1 writer for run ledgers. All three
 * carriers call this same function, so the ruling's "applied identically
 * in all three writers" is literal, not a convention.
 */
export interface RunLedgerProjector {
  projectReport(input: ReportProjectionInput, nowMs: number): Promise<ProjectRunLedgerResult>;
  projectAsyncJob(input: AsyncJobProjectionInput, nowMs: number): Promise<ProjectRunLedgerResult>;
  /** Issue #6099 — project one DO job run record into D1 (its own twin; linkedJobRunId is always null). */
  projectJobRunRecord(
    input: JobRunRecordProjectionInput,
    nowMs: number,
  ): Promise<ProjectRunLedgerResult>;
  /**
   * Issue #6006 — fold one mas_job_outcomes row into D1 (attach the
   * facts to the run's D1 row, or create the row when the run has
   * none). linkedJobRunId is the folded D1 row's derived id, so the
   * caller can name the row the facts landed on.
   */
  projectJobOutcome(
    input: JobOutcomeProjectionInput,
    nowMs: number,
  ): Promise<ProjectRunLedgerResult>;
}

/** The D1 read side the projector needs for twin-link resolution. */
export interface JobRunRecordLister {
  listByJob(jobId: string, limit?: number): Promise<JobRunRecord[]>;
}

/** The D1 read side the projector needs for the report version check. */
export interface ProjectedReportReader {
  latestReport(
    tenantId: string,
    reportId: string,
  ): Promise<{ updatedAtMs: number; version: number } | null>;
}
