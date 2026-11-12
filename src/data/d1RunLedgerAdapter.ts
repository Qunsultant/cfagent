/**
 * Issue #4116 — D1 adapter for the run-ledger projection (the D1
 * side of the DO → D1 projection). The ONLY module (with its
 * in-memory test double) that may import drizzle-orm for the
 * agent_async_jobs / agent_tenant_projection_carriers rows, and
 * the only module that knows their column names.
 *
 * Ordering rule (the ruling's shared rule, in its conditional-upsert
 * form — see the design doc §1.1): one row per natural key; a replay
 * is a no-op, a stale write never overwrites a newer row, a newer
 * write lands. Single statement: INSERT … ON CONFLICT DO UPDATE …
 * WHERE stored.updated_at < excluded.updated_at.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentAsyncJobs,
  agentTenantProjectionCarriers,
} from "./drizzleSchema";
import {
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0060_RUN_LEDGER_OWNER,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  AsyncJobProjectionInput,
  ProjectedAsyncJobRow,
  ProjectionCarriers,
  RunLedgerReadMode,
  TenantProjectionCarriersRow,
} from "./runLedgerPorts";

export type D1RunLedgerDb = ReturnType<typeof createD1RunLedgerDb>;

export function createD1RunLedgerDb(d1: unknown) {
  return drizzle(d1 as never, {
    schema: { agentAsyncJobs, agentTenantProjectionCarriers },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0059 if unapplied.
 * Migration 0004 rides along because 0059 ALTERs agent_reports —
 * applyMigrations sorts by version, so ordering is by version,
 * not list order.
 */
export async function ensureRunLedgerSchema(db: D1RunLedgerDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0004_AGENT_AUDIT_REPORTS,
    MIGRATION_0059_RUN_LEDGER,
    MIGRATION_0060_RUN_LEDGER_OWNER,
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

  /**
   * Conditional upsert for one projected async-job row. The adapter
   * stamps projectedAtMs from nowMs — callers never stamp projection
   * time themselves. Returns true when the write landed (insert or
   * newer-update) and false when it was a no-op (exact replay, or a
   * stale write losing to a newer stored row). The detection reads
   * the driver's meta.changes — SQLite reports 0 modified rows when
   * the upsert's WHERE refuses the update — and falls back to
   * "written" when the driver carries no meta (never misreports a
   * landed write as skipped).
   */
  async recordAsyncJob(row: AsyncJobProjectionInput, nowMs: number): Promise<boolean> {
    await this.ensure();
    const values = {
      jobId: row.jobId,
      tenantId: row.tenantId,
      sessionId: row.sessionId,
      capability: row.capability,
      displayName: row.displayName,
      status: row.status,
      payloadJson: row.payloadJson,
      resultJson: row.resultJson,
      responseStatus: row.responseStatus,
      error: row.error,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      parentJobId: row.parentJobId,
      jobKind: row.jobKind,
      channel: row.channel,
      notBefore: row.notBefore,
      stage: row.stage,
      chainId: row.chainId,
      stuckAlertedAt: row.stuckAlertedAt,
      trigger: row.trigger,
      triggeredBy: row.triggeredBy,
      scheduleId: row.scheduleId,
      lastActivityAt: row.lastActivityAt,
      projectedAtMs: nowMs,
    };
    const result = (await this.db
      .insert(agentAsyncJobs)
      .values(values)
      .onConflictDoUpdate({
        target: agentAsyncJobs.jobId,
        set: { ...values, jobId: row.jobId },
        where: sql`${agentAsyncJobs.updatedAt} < ${sql.raw("excluded.updated_at")}`,
      })) as unknown as { meta?: { changes?: number } };
    const changes = result?.meta?.changes;
    return typeof changes === "number" ? changes > 0 : true;
  }

  async getAsyncJob(tenantId: string, jobId: string): Promise<ProjectedAsyncJobRow | null> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentAsyncJobs)
      .where(
        and(
          eq(agentAsyncJobs.tenantId, tenantId),
          eq(agentAsyncJobs.jobId, jobId),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : toProjectedRow(rows[0]);
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

  /**
   * The stored carrier config for one tenant. Null when no row
   * exists — absent row = unconfigured (no default, never a
   * DEFAULT_*). Callers map null to the unconfigured refusal.
   */
  async getTenantProjectionCarriers(
    tenantId: string,
  ): Promise<TenantProjectionCarriersRow | null> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentTenantProjectionCarriers)
      .where(eq(agentTenantProjectionCarriers.tenantId, tenantId))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    const readMode = row.readMode === "d1-only" ? "d1-only" : "merged";
    return {
      tenantId: row.tenantId,
      carriers: {
        queues: row.queuesEnabled === 1,
        orm: row.ormEnabled === 1,
        sweep: row.sweepEnabled === 1,
      },
      readMode,
      updatedAtMs: row.updatedAtMs,
    };
  }

  /**
   * Operator write for the carrier config. Unconditional upsert —
   * config is set explicitly by the operator, so last write wins
   * by arrival; the no-default rule constrains READS, not this
   * write (the caller supplies every flag explicitly).
   */
  async setTenantProjectionCarriers(
    tenantId: string,
    carriers: ProjectionCarriers,
    readMode: RunLedgerReadMode,
    nowMs: number,
  ): Promise<TenantProjectionCarriersRow> {
    await this.ensure();
    const values = {
      tenantId,
      queuesEnabled: carriers.queues ? 1 : 0,
      ormEnabled: carriers.orm ? 1 : 0,
      sweepEnabled: carriers.sweep ? 1 : 0,
      readMode,
      updatedAtMs: nowMs,
    };
    await this.db
      .insert(agentTenantProjectionCarriers)
      .values(values)
      .onConflictDoUpdate({
        target: agentTenantProjectionCarriers.tenantId,
        set: {
          queuesEnabled: values.queuesEnabled,
          ormEnabled: values.ormEnabled,
          sweepEnabled: values.sweepEnabled,
          readMode: values.readMode,
          updatedAtMs: values.updatedAtMs,
        },
      });
    return { tenantId, carriers: { ...carriers }, readMode, updatedAtMs: nowMs };
  }
}
