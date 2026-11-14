/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports projection) — D1
 * adapter (R2). The ONLY module that may import drizzle-orm
 * for audit/report rows, and the only module (with the
 * in-memory test double) that knows the agent_chain_audit and
 * agent_reports column names.
 *
 * Atomicity note (carried from slices 0–2): every public
 * method here is a single statement, so it is atomic on D1
 * without a transaction. recordAuditEvent is ON CONFLICT DO
 * NOTHING on the id primary key, and recordReport is ON
 * CONFLICT DO NOTHING on the (tenant, report, version)
 * primary key, so replayed writes are no-ops even under
 * at-least-once delivery.
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentChainAudit, agentReports } from "./drizzleSchema";
import type {
  AuditEventKind,
  AuditEventRow,
  AuditReportStore,
  AuditSubjectType,
  CanonicalReportRow,
} from "./auditReportPorts";
import {
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0060_RUN_LEDGER_OWNER,
  applyMigrations,
} from "./migrationRunner";

export type D1AuditReportDb = ReturnType<typeof createD1AuditReportDb>;

export function createD1AuditReportDb(d1: unknown) {
  return drizzle(d1 as never, { schema: { agentChainAudit, agentReports } });
}

/** Create audit + report tables if absent (idempotent; safe to call per request). */
export async function ensureAuditReportSchema(db: D1AuditReportDb): Promise<void> {
  // Issue #4116 (migrations 0059–0060): the adapter's report
  // reads select linked_job_run_id / user_login / body_r2_key,
  // so the ensure provides those columns too — applyMigrations
  // is _migrations-gated, so a later ensureRunLedgerTables pass
  // skips them instead of re-applying. 0059 also creates the
  // run-ledger tables (idempotent table creation); 0060 only
  // alters agent_reports (owned by 0004) and needs no 0059
  // table. The registry still owns the versions; both ensure
  // paths converge on the same gated runner.
  await applyMigrations(db, [
    MIGRATION_0004_AGENT_AUDIT_REPORTS,
    MIGRATION_0059_RUN_LEDGER,
    MIGRATION_0060_RUN_LEDGER_OWNER,
  ]);
}

function toAuditRow(record: typeof agentChainAudit.$inferSelect): AuditEventRow {
  return {
    id: record.id,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    chainId: record.chainId,
    eventKind: record.eventKind as AuditEventKind,
    subjectType: record.subjectType as AuditSubjectType,
    subjectId: record.subjectId,
    actor: record.actor,
    detailJson: record.detailJson,
    occurredAtMs: record.occurredAtMs,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    version: record.version,
    provenanceWriter: record.provenanceWriter,
    provenanceSourceDo: record.provenanceSourceDo,
    provenanceSourceVersion: record.provenanceSourceVersion,
  };
}

function toReportRow(record: typeof agentReports.$inferSelect): CanonicalReportRow {
  return {
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    reportId: record.reportId,
    runId: record.runId,
    generationId: record.generationId,
    title: record.title,
    source: record.source,
    summary: record.summary,
    body: record.body,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    version: record.version,
    provenanceWriter: record.provenanceWriter,
    provenanceSourceDo: record.provenanceSourceDo,
    provenanceSourceVersion: record.provenanceSourceVersion,
    linkedJobRunId: record.linkedJobRunId ?? null,
    userLogin: record.userLogin ?? null,
    bodyR2Key: record.bodyR2Key ?? null,
  };
}

/** Newest first, then id ascending for determinism on equal timestamps. */
function newestFirst(rows: AuditEventRow[]): AuditEventRow[] {
  return [...rows].sort(
    (a, b) => b.occurredAtMs - a.occurredAtMs || a.id.localeCompare(b.id),
  );
}

/** Latest row per report, newest first, then report id ascending. */
function latestPerReport(rows: CanonicalReportRow[]): CanonicalReportRow[] {
  const byId = new Map<string, CanonicalReportRow>();
  for (const row of rows) {
    const current = byId.get(row.reportId);
    if (!current || row.version > current.version) {
      byId.set(row.reportId, row);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || a.reportId.localeCompare(b.reportId),
  );
}

export class D1AuditReportAdapter implements AuditReportStore {
  constructor(readonly db: D1AuditReportDb) {}

  async recordAuditEvent(row: AuditEventRow): Promise<void> {
    await this.db
      .insert(agentChainAudit)
      .values({
        id: row.id,
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        chainId: row.chainId,
        eventKind: row.eventKind,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        actor: row.actor,
        detailJson: row.detailJson,
        occurredAtMs: row.occurredAtMs,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        version: row.version,
        provenanceWriter: row.provenanceWriter,
        provenanceSourceDo: row.provenanceSourceDo,
        provenanceSourceVersion: row.provenanceSourceVersion,
      })
      .onConflictDoNothing();
  }

  async listAuditForChain(
    tenantId: string,
    chainId: string,
  ): Promise<AuditEventRow[]> {
    const rows = await this.db
      .select()
      .from(agentChainAudit)
      .where(
        and(
          eq(agentChainAudit.tenantId, tenantId),
          eq(agentChainAudit.chainId, chainId),
        ),
      )
      .orderBy(desc(agentChainAudit.occurredAtMs), desc(agentChainAudit.id));
    return rows.map(toAuditRow);
  }

  async listAuditForTenant(tenantId: string): Promise<AuditEventRow[]> {
    const rows = await this.db
      .select()
      .from(agentChainAudit)
      .where(eq(agentChainAudit.tenantId, tenantId))
      .orderBy(desc(agentChainAudit.occurredAtMs), desc(agentChainAudit.id));
    return rows.map(toAuditRow);
  }

  async recordReport(row: CanonicalReportRow): Promise<void> {
    await this.db
      .insert(agentReports)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        reportId: row.reportId,
        runId: row.runId,
        generationId: row.generationId,
        title: row.title,
        source: row.source,
        summary: row.summary,
        body: row.body,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        version: row.version,
        provenanceWriter: row.provenanceWriter,
        provenanceSourceDo: row.provenanceSourceDo,
        provenanceSourceVersion: row.provenanceSourceVersion,
        linkedJobRunId: row.linkedJobRunId ?? null,
        userLogin: row.userLogin ?? null,
        bodyR2Key: row.bodyR2Key ?? null,
      })
      .onConflictDoNothing();
  }

  async latestReport(
    tenantId: string,
    reportId: string,
  ): Promise<CanonicalReportRow | null> {
    const rows = await this.db
      .select()
      .from(agentReports)
      .where(
        and(
          eq(agentReports.tenantId, tenantId),
          eq(agentReports.reportId, reportId),
        ),
      )
      .orderBy(desc(agentReports.version))
      .limit(1);
    return rows.length === 0 ? null : toReportRow(rows[0]);
  }

  async listReports(
    tenantId: string,
    opts?: { userLogin?: string; limit?: number },
  ): Promise<CanonicalReportRow[]> {
    const conditions = [eq(agentReports.tenantId, tenantId)];
    if (opts?.userLogin) {
      conditions.push(eq(agentReports.userLogin, opts.userLogin));
    }
    const rows = await this.db
      .select()
      .from(agentReports)
      .where(and(...conditions))
      .orderBy(desc(agentReports.createdAtMs), desc(agentReports.reportId))
      .limit(Math.max(1, opts?.limit ?? 100));
    return latestPerReport(rows.map(toReportRow));
  }

  async deleteReport(tenantId: string, reportId: string): Promise<void> {
    await this.db
      .delete(agentReports)
      .where(
        and(
          eq(agentReports.tenantId, tenantId),
          eq(agentReports.reportId, reportId),
        ),
      );
  }
}
