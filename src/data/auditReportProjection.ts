/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports) — the pure
 * audit/report write logic (R5). Port-only: this module knows no
 * store client, no binding, and no query language. It is the
 * single place that turns a lifecycle occurrence into an audit
 * row and a deletion request into the one allowed deletion.
 *
 * D1-first since #6101 (step 8) / #6102: D1 is the authoritative
 * home for audit events (`mas_events`) and canonical reports
 * (`agent_reports`) — this module writes through the injected
 * D1 stores, it does not mirror a DO source. The old DO-first
 * projection story died with the #6099 projector: there is no
 * reconcile pass converging a DO source, and no seed — the
 * reports seed copied existing DO rows into D1 and was retired
 * in #6101 step 8 (POST /api/reports/seed-canonical answers
 * 410 Gone). A write failure never fails the originating step:
 * recordAuditEvent catches, reports, and returns. Audit rows
 * are append-only, so a lost audit write is a gap in the trail,
 * never a wrong state — and the gap is visible as a missing
 * event id.
 *
 * Idempotency: an audit row's id is `<tenantId>:<eventId>`,
 * so replaying the same event is a no-op under the adapter's
 * conflict handling; a report row replays the same version
 * the same way.
 *
 * Privacy: detailJson carries counts and statuses only, never
 * payloads; the audit detail is capped at 8000 chars (capText)
 * — report bodies are NOT capped here, the D1 writer stores
 * the full body (bound 200k by toScheduledReportRecord); no row
 * here carries auth material.
 */
import type {
  AuditEventDraft,
  AuditEventRow,
  AuditReportStore,
  AuditStore,
  CanonicalReportRow,
} from "./auditReportPorts";
import {
  readProvenanceTuple,
  withProvenanceTuple,
  type ProvenanceRecordKind,
} from "../observability/provenanceTuple";

/** Cap on any single capped text field (chars, before the marker). */
export const AUDIT_REPORT_TEXT_MAX = 8000;

const TRUNCATION_MARKER = "[truncated]";

/** Cap a projected body to the audit-report text max (shared with the seed). */
export function capText(text: string): string {
  if (text.length <= AUDIT_REPORT_TEXT_MAX) return text;
  return text.slice(0, AUDIT_REPORT_TEXT_MAX) + TRUNCATION_MARKER;
}

export interface RecordAuditEventResult {
  recorded: boolean;
  error?: string;
}

function inferProvenanceKind(eventKind: string): ProvenanceRecordKind {
  const lower = eventKind.toLowerCase();
  if (lower.includes("deliver") || lower.includes("notify") || lower.includes("send")) {
    return "delivery";
  }
  if (
    lower.includes("deny") ||
    lower.includes("denied") ||
    lower.includes("denial") ||
    lower.includes("refus") ||
    lower.includes("forbid")
  ) {
    return "denial";
  }
  if (lower.includes("fallback") || lower.includes("degrad")) {
    return "fallback";
  }
  return "run";
}

function ensureDetailJsonProvenance(draft: AuditEventDraft): string {
  let parsed: Record<string, unknown> = {};
  if (draft.detailJson) {
    try {
      const candidate = JSON.parse(draft.detailJson);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        if (readProvenanceTuple(candidate)) {
          return draft.detailJson;
        }
        parsed = candidate as Record<string, unknown>;
      } else {
        parsed = { rawDetail: candidate };
      }
    } catch {
      parsed = { rawDetail: draft.detailJson };
    }
  }
  const enriched = withProvenanceTuple(parsed, inferProvenanceKind(draft.eventKind), {
    tenantId: draft.tenantId,
    userId: typeof parsed.userId === "string" ? parsed.userId : draft.actor,
    providerId:
      typeof parsed.providerId === "string"
        ? parsed.providerId
        : typeof parsed.provider === "string"
          ? parsed.provider
          : draft.provenanceSourceDo,
    brokerId: typeof parsed.brokerId === "string" ? parsed.brokerId : "none",
    channel: typeof parsed.channel === "string" ? parsed.channel : draft.subjectType,
  });
  return JSON.stringify(enriched);
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
    detailJson: capText(ensureDetailJsonProvenance(draft)),
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
