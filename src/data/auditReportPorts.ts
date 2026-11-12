/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports projection) —
 * port module (R1). Domain code depends ONLY on these interfaces.
 *
 * This module is deliberately free of any store client, any
 * binding reference, and any query language: no adapter import,
 * no store-specific type. The composition root
 * (src/data/createAuditReportPorts.ts) wires a store adapter to
 * these ports; domain code never sees the adapter.
 *
 * Grain: agent_chain_audit is one row per lifecycle event
 * (append-only; replaying the same event id is a no-op under
 * the primary-key conflict). agent_reports is one row per
 * (tenant, report, version); canonical rows are written only
 * by the projection path, and deletion happens ONLY via
 * deleteCanonicalReport (in auditReportProjection) — no other
 * module may delete report rows.
 *
 * Read contract: listAuditForChain / listAuditForTenant /
 * latestReport / listReports answer from the projection only,
 * newest first. A projection read may lag one transition (R5);
 * any consumer that cannot tolerate lag reads the durable
 * object directly and says so.
 *
 * Tenancy (R7): every method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in
 * this module; adapters inject the tenant predicate into every
 * query.
 *
 * Scope note: this slice covers audit and report rows only.
 * No row type here carries auth material of any kind — a
 * writer accepting such a row is a defect, pinned by test.
 * Report bodies are capped by the projector (see
 * auditReportProjection), never by the database; the durable
 * object remains the authoritative full copy.
 */

/** Lifecycle events the projection records, one row each. */
export type AuditEventKind =
  | "synthesize"
  | "approve"
  | "kill"
  | "project"
  | "reconcile"
  | "seed";

/** What an audit event is about. */
export type AuditSubjectType = "chain" | "schedule" | "job" | "report";

/** One append-only row of the audit projection. */
export interface AuditEventRow {
  /** Deterministic replay key: `<tenantId>:<eventId>`. */
  id: string;
  tenantId: string;
  workspaceId: string;
  /** Null for tenant-wide events (reconcile, seed). */
  chainId: string | null;
  eventKind: AuditEventKind;
  subjectType: AuditSubjectType;
  subjectId: string;
  /** Who/what caused the event: a writer name or operator login. */
  actor: string;
  /** Capped JSON detail (counts, statuses — never payloads). */
  detailJson: string;
  /** Epoch milliseconds the event occurred. */
  occurredAtMs: number;
  /** Epoch milliseconds this row was written. */
  createdAtMs: number;
  /** Epoch milliseconds this row was written (same as created: append-only). */
  updatedAtMs: number;
  /** Row-shape version (1 in slice 3; audit rows are not versioned per subject). */
  version: number;
  /** Writer provenance: which component wrote the row. */
  provenanceWriter: string;
  /** Source durable object that owns the authoritative state. */
  provenanceSourceDo: string;
  /** Row-shape version of the mapping (1 in slice 3). */
  provenanceSourceVersion: string;
}

/** Tenant-scoped reads over the audit trail. */

/** A draft audit event, before the row id is assigned. */
export interface AuditEventDraft {
  tenantId: string;
  workspaceId: string;
  chainId: string | null;
  eventKind: AuditEventKind;
  subjectType: AuditSubjectType;
  subjectId: string;
  actor: string;
  detailJson: string;
  occurredAtMs: number;
  provenanceWriter: string;
  provenanceSourceDo: string;
  provenanceSourceVersion: string;
}

/** Tenant-scoped reads over the audit projection. */
export interface AuditReader {
  /** Events for one chain, newest first. */
  listAuditForChain(
    tenantId: string,
    chainId: string,
  ): Promise<AuditEventRow[]>;
  /** All events for one tenant, newest first (incl. tenant-wide events). */
  listAuditForTenant(tenantId: string): Promise<AuditEventRow[]>;
}

/** Idempotent append-only writes over the audit projection. */
export interface AuditWriter {
  recordAuditEvent(row: AuditEventRow): Promise<void>;
}

/** The slice-3 audit store surface. */
export interface AuditStore extends AuditReader, AuditWriter {}

/** One versioned row of a canonical report's projection. */
export interface CanonicalReportRow {
  tenantId: string;
  workspaceId: string;
  /** The canonical report id (the mas_reports id it mirrors). */
  reportId: string;
  runId: string;
  generationId: string | null;
  title: string;
  source: string;
  summary: string;
  /** Capped body (the durable object holds the full copy). */
  body: string;
  /** Epoch milliseconds the canonical row was created. */
  createdAtMs: number;
  /** Epoch milliseconds this projection row was written. */
  updatedAtMs: number;
  /** Projection version: one higher per projected change. */
  version: number;
  /** Writer provenance: which component wrote the row. */
  provenanceWriter: string;
  /** Source durable object that owns the authoritative state. */
  provenanceSourceDo: string;
  /** Row-shape version of the mapping (1 in slice 3). */
  provenanceSourceVersion: string;
  /**
   * Issue #4116 — the D1 job run record this projected report is
   * the twin of (the #3946 twin-rows link, resolved at projection
   * time, only when unambiguous). Null when unlinked.
   */
  linkedJobRunId: string | null;
  /**
   * Issue #4116 (migration 0060) — the projected report's owning
   * login (the DO row's user_login). D1-only reads filter by it
   * exactly like the DO read filters by userLogin. Null for rows
   * projected before this column landed.
   */
  userLogin: string | null;
  /**
   * Issue #4116 (migration 0060) — the R2 pointer for pointer
   * rows (the DO row's body_r2_key). Null when the body is
   * inline. The D1-only read resolves it from R2, read-only.
   */
  bodyR2Key: string | null;
}

/** Tenant-scoped reads over the report projection. */
export interface ReportReader {
  latestReport(
    tenantId: string,
    reportId: string,
  ): Promise<CanonicalReportRow | null>;
  /** Latest row per report for one tenant, newest first. */
  listReports(
    tenantId: string,
    opts?: { userLogin?: string; limit?: number },
  ): Promise<CanonicalReportRow[]>;
}

/** Idempotent versioned writes over the report projection. */
export interface ReportWriter {
  recordReport(row: CanonicalReportRow): Promise<void>;
}

/**
 * The single deletion surface for report rows. Only
 * deleteCanonicalReport may call it; no other module deletes.
 */
export interface ReportDeleter {
  deleteReport(tenantId: string, reportId: string): Promise<void>;
}

/** The slice-3 report store surface. */
export interface ReportStore
  extends ReportReader,
    ReportWriter,
    ReportDeleter {}

/** The combined slice-3 store surface. */
export interface AuditReportStore extends AuditStore, ReportStore {}
