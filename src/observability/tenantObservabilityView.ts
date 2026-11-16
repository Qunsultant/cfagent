/**
 * Per-Tenant Observability View (#4619)
 *
 * Aggregates a single tenant's runs, deliveries, denials, and fallbacks into
 * one unified view over `AuditReader.listAuditForTenant(tenantId)` and the
 * #4615 uniform 5-leg `ProvenanceTuple` without manual joins.
 */

import type { AuditEventRow, AuditReader } from "../data/auditReportPorts";
import {
  buildProvenanceTuple,
  readProvenanceTuple,
  type ProvenanceRecordKind,
  type ProvenanceTuple,
} from "./provenanceTuple";

export interface TenantObservabilityEntry {
  id: string;
  tenantId: string;
  recordKind: ProvenanceRecordKind;
  eventKind: string;
  subjectType: string;
  subjectId: string;
  actor: string;
  occurredAtMs: number;
  provenance: ProvenanceTuple;
  detail: Record<string, unknown>;
}

export interface TenantObservabilityView {
  tenantId: string;
  generatedAtMs: number;
  counts: {
    total: number;
    run: number;
    delivery: number;
    denial: number;
    fallback: number;
  };
  entries: TenantObservabilityEntry[];
  runs: TenantObservabilityEntry[];
  deliveries: TenantObservabilityEntry[];
  denials: TenantObservabilityEntry[];
  fallbacks: TenantObservabilityEntry[];
}

export interface BuildTenantObservabilityViewOptions {
  recordKinds?: readonly ProvenanceRecordKind[];
  limit?: number;
}

function parseDetail(detailJson: string): Record<string, unknown> {
  if (!detailJson) return {};
  try {
    const parsed = JSON.parse(detailJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { rawDetail: parsed };
  } catch {
    return { rawDetail: detailJson };
  }
}

function resolveRecordKind(
  detail: Record<string, unknown>,
  eventKind: string,
): ProvenanceRecordKind {
  const explicit = detail.provenanceRecordKind;
  if (
    explicit === "run" ||
    explicit === "delivery" ||
    explicit === "denial" ||
    explicit === "fallback"
  ) {
    return explicit;
  }
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

function entryFromRow(row: AuditEventRow): TenantObservabilityEntry {
  const detail = parseDetail(row.detailJson);
  const recordKind = resolveRecordKind(detail, row.eventKind);
  const provenance =
    readProvenanceTuple(detail) ??
    buildProvenanceTuple({
      tenantId: row.tenantId,
      userId: row.actor,
      providerId: row.provenanceSourceDo,
      brokerId: "none",
      channel: row.subjectType,
    });
  return {
    id: row.id,
    tenantId: row.tenantId,
    recordKind,
    eventKind: row.eventKind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    actor: row.actor,
    occurredAtMs: row.occurredAtMs,
    provenance,
    detail,
  };
}

/**
 * Build the single per-tenant observability view over runs, deliveries,
 * denials, and fallbacks without manual joins.
 */
export async function buildTenantObservabilityView(
  auditReader: AuditReader,
  tenantId: string,
  options?: BuildTenantObservabilityViewOptions,
): Promise<TenantObservabilityView> {
  const normalizedTenant = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!normalizedTenant) {
    throw new Error("buildTenantObservabilityView requires a non-empty tenantId.");
  }

  const rawRows = await auditReader.listAuditForTenant(normalizedTenant);
  const kindFilter = options?.recordKinds ? new Set(options.recordKinds) : null;

  let entries = rawRows
    .filter((row) => row.tenantId === normalizedTenant)
    .map(entryFromRow)
    .filter((entry) => !kindFilter || kindFilter.has(entry.recordKind))
    .sort((a, b) => b.occurredAtMs - a.occurredAtMs);

  if (options?.limit !== undefined && options.limit >= 0) {
    entries = entries.slice(0, options.limit);
  }

  const runs = entries.filter((e) => e.recordKind === "run");
  const deliveries = entries.filter((e) => e.recordKind === "delivery");
  const denials = entries.filter((e) => e.recordKind === "denial");
  const fallbacks = entries.filter((e) => e.recordKind === "fallback");

  return {
    tenantId: normalizedTenant,
    generatedAtMs: Date.now(),
    counts: {
      total: entries.length,
      run: runs.length,
      delivery: deliveries.length,
      denial: denials.length,
      fallback: fallbacks.length,
    },
    entries,
    runs,
    deliveries,
    denials,
    fallbacks,
  };
}
