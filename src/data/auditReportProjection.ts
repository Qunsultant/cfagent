/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports projection) —
 * pure projection logic (R5). Port-only: this module knows no
 * store client, no binding, and no query language. It is the
 * single place that turns a lifecycle occurrence into an audit
 * row, a canonical source row into a report row, and a
 * deletion request into the one allowed deletion.
 *
 * DO-first: the durable object owns the authoritative state;
 * this module only mirrors what a transition, a run, a
 * reconcile pass, or an operator seed reports. A projection
 * failure never fails the originating step: recordAuditEvent
 * catches, reports, and returns, and the next reconcile pass
 * converges what it can. Audit rows are append-only, so a
 * lost audit write is a gap in the trail, never a wrong
 * state — and the gap is visible as a missing event id.
 *
 * Idempotency: an audit row's id is `<tenantId>:<eventId>`,
 * so replaying the same event is a no-op under the adapter's
 * conflict handling; a report row replays the same version
 * the same way. The seed is idempotent by the same mechanism
 * plus an explicit latest-row check: a report that already
 * has a projected row is counted, never rewritten.
 *
 * Privacy: detailJson carries counts and statuses only, never
 * payloads; report bodies are capped (the durable object
 * holds the full copy); no row here carries auth material.
 */
import type {
  AuditEventDraft,
  AuditEventRow,
  AuditReportStore,
  AuditStore,
  CanonicalReportRow,
} from "./auditReportPorts";

/** Cap on any single capped text field (chars, before the marker). */
export const AUDIT_REPORT_TEXT_MAX = 8000;

const TRUNCATION_MARKER = "[truncated]";

/** Cap a projected body to the audit-report text max (shared with the seed). */
export function capText(text: string): string {
  if (text.length <= AUDIT_REPORT_TEXT_MAX) return text;
  return text.slice(0, AUDIT_REPORT_TEXT_MAX) + TRUNCATION_MARKER;
}

let seedEventCounter = 0;

export interface RecordAuditEventResult {
  recorded: boolean;
  error?: string;
}

/** Build the full audit row for a draft + caller-supplied event id. */
export function auditRowFromDraft(
  draft: AuditEventDraft,
  eventId: string,
  nowMs: number,
): AuditEventRow {
  return {
    id: `${draft.tenantId}:${eventId}`,
    tenantId: draft.tenantId,
    workspaceId: draft.workspaceId,
    chainId: draft.chainId,
    eventKind: draft.eventKind,
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    actor: draft.actor,
    detailJson: capText(draft.detailJson),
    occurredAtMs: draft.occurredAtMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    version: 1,
    provenanceWriter: draft.provenanceWriter,
    provenanceSourceDo: draft.provenanceSourceDo,
    provenanceSourceVersion: draft.provenanceSourceVersion,
  };
}

/**
 * Record one audit event. Never throws: a store failure is
 * collected into `error` and the caller (whose transition
 * already committed) continues.
 */
export async function recordAuditEvent(
  store: AuditStore,
  draft: AuditEventDraft,
  eventId: string,
  nowMs: number,
): Promise<RecordAuditEventResult> {
  try {
    await store.recordAuditEvent(auditRowFromDraft(draft, eventId, nowMs));
    return { recorded: true };
  } catch (err) {
    return {
      recorded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One canonical source row handed to the seeder. */
export interface CanonicalSeedInput {
  reportId: string;
  runId: string;
  generationId: string | null;
  title: string;
  source: string;
  summary: string;
  body: string;
  createdAtMs: number;
  /** Issue #4116 (migration 0060) — the owning login, when the source row carries one. */
  userLogin?: string | null;
  /** Issue #4116 (migration 0060) — the R2 body pointer, when the source row is a pointer row. */
  bodyR2Key?: string | null;
}

export function canonicalReportRowFromSeed(
  input: CanonicalSeedInput,
  tenantId: string,
  workspaceId: string,
  nowMs: number,
  writer: string,
): CanonicalReportRow {
  return {
    tenantId,
    workspaceId,
    reportId: input.reportId,
    runId: input.runId,
    generationId: input.generationId,
    title: input.title,
    source: input.source,
    summary: input.summary,
    body: capText(input.body),
    createdAtMs: input.createdAtMs,
    updatedAtMs: nowMs,
    version: 1,
    provenanceWriter: writer,
    provenanceSourceDo: "Orchestrator",
    provenanceSourceVersion: "1",
    linkedJobRunId: null,
    userLogin: input.userLogin ?? null,
    bodyR2Key: input.bodyR2Key ?? null,
  };
}

export interface SeedCanonicalReportsInput {
  store: AuditReportStore;
  /** Optional: when given, one seed audit event is recorded (best-effort). */
  auditStore?: AuditStore;
  tenantId: string;
  workspaceId: string;
  reports: CanonicalSeedInput[];
  nowMs: number;
  writer: string;
  actor: string;
}

export interface SeedCanonicalReportsResult {
  /** True when at least one new row was written. */
  seeded: boolean;
  seededCount: number;
  alreadyPresent: number;
  total: number;
}

/**
 * Seed canonical rows into the projection. Idempotent: a
 * report with a projected row is counted as already present,
 * never rewritten; a second run over the same input seeds
 * zero rows. The seed audit event is best-effort — its
 * failure never fails the seed. A store failure during
 * the seed itself propagates (unlike a transition
 * projection, which must never throw): a seed is an
 * operator step whose failure the operator must see, and
 * the next run converges the missing rows.
 */
export async function seedCanonicalReports(
  input: SeedCanonicalReportsInput,
): Promise<SeedCanonicalReportsResult> {
  let seededCount = 0;
  let alreadyPresent = 0;
  for (const report of input.reports) {
    const latest = await input.store.latestReport(
      input.tenantId,
      report.reportId,
    );
    if (latest !== null) {
      alreadyPresent += 1;
      continue;
    }
    await input.store.recordReport(
      canonicalReportRowFromSeed(
        report,
        input.tenantId,
        input.workspaceId,
        input.nowMs,
        input.writer,
      ),
    );
    seededCount += 1;
  }
  if (input.auditStore) {
    const eventId = `seed:${input.nowMs}:${seedEventCounter++}`;
    await recordAuditEvent(
      input.auditStore,
      {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        chainId: null,
        eventKind: "seed",
        subjectType: "report",
        subjectId: "canonical-seed",
        actor: input.actor,
        detailJson: JSON.stringify({
          seededCount,
          alreadyPresent,
          total: input.reports.length,
        }),
        occurredAtMs: input.nowMs,
        provenanceWriter: input.writer,
        provenanceSourceDo: "Orchestrator",
        provenanceSourceVersion: "1",
      },
      eventId,
      input.nowMs,
    );
  }
  return {
    seeded: seededCount > 0,
    seededCount,
    alreadyPresent,
    total: input.reports.length,
  };
}

/**
 * The ONLY deletion path for canonical report rows. The
 * platform-admin gate is the reports rule (the chain matrix
 * in chainAuthority covers chain operations; deletion of a
 * canonical row is an operator act of the same gravity, so
 * it takes the same caller). A refused deletion writes
 * nothing and throws, so the caller surfaces the refusal.
 */
export async function deleteCanonicalReport(
  store: AuditReportStore,
  tenantId: string,
  reportId: string,
  role: string,
): Promise<{ deleted: boolean }> {
  if (role !== "platform-admin") {
    throw new Error(
      "Forbidden: canonical report deletion requires platform-admin.",
    );
  }
  await store.deleteReport(tenantId, reportId);
  return { deleted: true };
}
