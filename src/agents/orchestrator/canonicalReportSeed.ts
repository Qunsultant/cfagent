/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports projection) —
 * the canonical mas_reports seed's execution, extracted from
 * OrchestratorAgent following the #992 decomposition pattern
 * (thin delegating wrapper on the class, execution here).
 * This keeps orchestrator.ts within its standing size budget.
 *
 * This function must run on the Orchestrator instance's
 * storage: the seed reads that instance's mas_reports rows
 * (the canonical copy the Reports view and AI Search read)
 * and mirrors them into AgentDB agent_reports. It never
 * writes the DO table, and a second run is a no-op.
 * Scope is exactly the current mas_reports rows at invoke
 * time — bounded, no historical backfill beyond that
 * approved set. Throws when AGENT_DB is unbound — the
 * caller surfaces the error, never a fabricated result.
 */
import { createAuditReportAdapter } from "../../data/createAuditReportPorts";
import { ensureAuditReportSchema } from "../../data/d1AuditReportAdapter";
import {
  seedCanonicalReports,
  type SeedCanonicalReportsResult,
} from "../../data/auditReportProjection";

export type { SeedCanonicalReportsResult };

/** Structural subset of ScheduledReportRecord that the seed needs. */
export interface CanonicalSourceReport {
  id: string;
  runId: string;
  generationId?: string;
  title: string;
  source: string;
  summary: string;
  body: string;
  createdAt: string;
  /** Issue #4116 (migration 0060) — the owning login, when the DO row carries one. */
  userLogin?: string;
  /** Issue #4116 (migration 0060) — the R2 body pointer, when the DO row is a pointer row. */
  bodyR2Key?: string | null;
}

export interface CanonicalReportSeedContext {
  env: { AGENT_DB?: unknown };
  listCanonicalReports: () => CanonicalSourceReport[];
  tenantId: string;
  setBy: string;
  nowMs: number;
}

export async function runCanonicalReportSeed(
  ctx: CanonicalReportSeedContext,
): Promise<SeedCanonicalReportsResult> {
  const adapter = createAuditReportAdapter(ctx.env);
  if (!adapter) {
    throw new Error(
      "[data-foundation] AGENT_DB is not bound; cannot seed canonical reports",
    );
  }
  await ensureAuditReportSchema(adapter.db);
  const reports = ctx.listCanonicalReports().map((report) => ({
    reportId: report.id,
    runId: report.runId,
    generationId: report.generationId ?? null,
    title: report.title,
    source: report.source,
    summary: report.summary,
    body: report.body,
    createdAtMs: Number.isNaN(Date.parse(report.createdAt))
      ? ctx.nowMs
      : Date.parse(report.createdAt),
    userLogin: report.userLogin ?? null,
    bodyR2Key: report.bodyR2Key ?? null,
  }));
  return seedCanonicalReports({
    store: adapter,
    auditStore: adapter,
    tenantId: ctx.tenantId,
    workspaceId: "primary",
    reports,
    nowMs: ctx.nowMs,
    writer: "orchestrator:seedCanonicalReports",
    actor: ctx.setBy,
  });
}
