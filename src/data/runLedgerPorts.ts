/**
 * Issue #4116 — one system-of-record D1: the port types for the DO
 * run-ledger projection (mas_reports, mas_async_jobs → D1).
 *
 * This module imports port types only — never a store client, never
 * drizzle-orm (the journalPosting structural rule). The D1 side
 * lives in d1RunLedgerAdapter.ts; the shared projector logic in
 * runLedgerProjection.ts; the carrier-config read in
 * services/projectionCarriers.ts.
 *
 * Grain: one D1 row per DO row, keyed on the DO row's natural key
 * (report id / async job id). The DO row stays authoritative; the
 * D1 row is its projection. A projected row carries the twin link
 * (linkedJobRunId) when the projection resolved it exactly — null
 * otherwise, never guessed.
 */
import type { JobRunRecord } from "../services/jobRunRecords";

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
