/**
 * Issue #6101 — D1 adapter for the frozen agent_async_jobs read.
 * The #6099 projector is deleted: no code writes this table
 * anymore (new async-job executions get no row until F5 restores
 * the list via the engine run record). This adapter is the READ
 * side only — listAsyncJobs serves the Workflow Runs jobs list
 * (pre-cutover projected rows). The ONLY module (with its
 * in-memory test double) that may import drizzle-orm for the
 * agent_async_jobs rows, and the only module that knows their
 * column names.
 */
import { and, desc, eq } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { agentAsyncJobs } from "./drizzleSchema";
import {
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0060_RUN_LEDGER_OWNER,
  MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type { ProjectedAsyncJobRow } from "./runLedgerPorts";

export type D1RunLedgerDb = ReturnType<typeof createD1RunLedgerDb>;

export function createD1RunLedgerDb(d1: unknown) {
  return createDrizzleD1Db(d1 as never, {
    schema: { agentAsyncJobs },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0059 if unapplied.
 * Migration 0004 rides along because 0059 ALTERs agent_reports —
 * applyMigrations sorts by version, so ordering is by version,
 * not list order. Issue #6099 — migration 0047 rides along too:
 * 0081 ALTERs job_run_records, so the table must exist first.
 */
export async function ensureRunLedgerSchema(db: D1RunLedgerDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0004_AGENT_AUDIT_REPORTS,
    MIGRATION_0047_JOB_RUN_RECORDS,
    MIGRATION_0059_RUN_LEDGER,
    MIGRATION_0060_RUN_LEDGER_OWNER,
    MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  ]);
}

function toProjectedRow(
  record: typeof agentAsyncJobs.$inferSelect,
): ProjectedAsyncJobRow {
  return {
    jobId: record.jobId,
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    capability: record.capability,
    displayName: record.displayName,
    status: record.status,
    payloadJson: record.payloadJson,
    resultJson: record.resultJson,
    responseStatus: record.responseStatus,
    error: record.error,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    parentJobId: record.parentJobId,
    jobKind: record.jobKind,
    channel: record.channel,
    notBefore: record.notBefore,
    stage: record.stage,
    chainId: record.chainId,
    stuckAlertedAt: record.stuckAlertedAt,
    trigger: record.trigger,
    triggeredBy: record.triggeredBy,
    scheduleId: record.scheduleId,
    lastActivityAt: record.lastActivityAt,
    projectedAtMs: record.projectedAtMs,
  };
}

export class D1RunLedgerAdapter {
  constructor(readonly db: D1RunLedgerDb) {}

  private ensured: Promise<number[]> | null = null;
  private ensure(): Promise<number[]> {
    if (!this.ensured) this.ensured = ensureRunLedgerSchema(this.db);
    return this.ensured;
  }

  async listAsyncJobs(
    tenantId: string,
    limit: number,
    opts?: { sessionId?: string },
  ): Promise<ProjectedAsyncJobRow[]> {
    await this.ensure();
    const conditions = [eq(agentAsyncJobs.tenantId, tenantId)];
    if (opts?.sessionId) {
      conditions.push(eq(agentAsyncJobs.sessionId, opts.sessionId));
    }
    const rows = await this.db
      .select()
      .from(agentAsyncJobs)
      .where(and(...conditions))
      .orderBy(desc(agentAsyncJobs.createdAt), desc(agentAsyncJobs.jobId))
      .limit(Math.max(1, limit));
    return rows.map(toProjectedRow);
  }

}
