/**
 * Issue #3534 (Pipeline J1), ORM conformance #3548 — the D1
 * implementation of the EXISTING job-run-record port
 * (src/data/jobRunRecordPorts.ts, #2964/#3121): same port,
 * same table, same record shape — the workflow-hosted
 * residency, beside the DO-SQLite adapter's agent-hosted one.
 * Pipeline runs executing inside a workflow have no host
 * Durable Object to borrow SQLite from; this adapter lets
 * them record through the one run-record machinery instead of
 * inventing a second store. Built on the foundation's drizzle
 * D1 pattern: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts; DDL authority migration 0047 in
 * src/data/migrationRunner.ts), the schema is ensured through
 * the versioned migration runner, and all query-builder
 * sites live inside src/data/.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { jobRunRecords } from "./drizzleSchema";
import type { JobRunRecordProjectionInput } from "./runLedgerPorts";
import {
  applyMigrations,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
  MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
  MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
  MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
  type MigrationDb,
} from "./migrationRunner";
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  type JobRunRecord,
} from "./jobRunRecordPorts";
import { normalizeJobRunRecord } from "../services/jobRunRecords";

/** Drizzle D1 database object carrying the run-record schema. */
export type JobRunRecordDb = DrizzleD1Database<{
  jobRunRecords: typeof jobRunRecords;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1JobRunRecordDb(d1: D1Database): JobRunRecordDb {
  return createDrizzleD1Db(d1, { schema: { jobRunRecords } });
}

/** Idempotent schema-ensure: applies migrations 0047 + 0072 + 0073 + 0076 + 0081 + 0084 if unapplied. */
export async function ensureJobRunRecordsSchema(db: JobRunRecordDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0047_JOB_RUN_RECORDS,
    MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
    MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
    MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
    MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
    MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
  ]);
}

type JobRunRecordRow = typeof jobRunRecords.$inferSelect;

function rowToRecord(row: JobRunRecordRow): JobRunRecord {
  let artifactRefs: string[] | undefined;
  if (row.artifactRefsJson != null) {
    try {
      const parsed: unknown = JSON.parse(row.artifactRefsJson);
      artifactRefs = Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      artifactRefs = undefined;
    }
  }
  return normalizeJobRunRecord({
    system: row.system as JobRunRecord["system"],
    jobId: row.jobId,
    operation: row.operation,
    started: row.started,
    finished: row.finished,
    outcome: row.outcome as JobRunRecord["outcome"],
    triggeredBy: row.triggeredBy as JobRunRecord["triggeredBy"],
    ...(row.triggerText != null
      ? { trigger: row.triggerText as JobRunRecord["trigger"] }
      : {}),
    ...(row.scheduleId != null ? { scheduleId: row.scheduleId } : {}),
    ...(row.asyncJobId != null ? { asyncJobId: row.asyncJobId } : {}),
    ...(row.workflowId != null ? { workflowId: row.workflowId } : {}),
    // Issue #4767 — a row stored before the kind columns existed
    // reads back normalized (kind "original", origin null) by
    // normalizeJobRunRecord; the spread passes the stored values
    // through when present.
    ...(row.kind != null ? { kind: row.kind as JobRunRecord["kind"] } : {}),
    ...(row.originRunId != null ? { originRunId: row.originRunId } : {}),
    ...(row.definitionVersion != null
      ? { definitionVersion: row.definitionVersion }
      : {}),
    // Issue #5102 (F5 of #5094) — a row stored before migration
    // 0084 carries none of the four binding columns; the spread
    // passes the stored values through when present and the
    // normalizer fills explicit nulls otherwise.
    ...(row.accountType != null ? { accountType: row.accountType } : {}),
    ...(row.accountId != null ? { accountId: row.accountId } : {}),
    ...(row.bindingScope != null ? { bindingScope: row.bindingScope } : {}),
    ...(row.bindingSource != null ? { bindingSource: row.bindingSource } : {}),
    ...(row.errorText != null ? { error: row.errorText } : {}),
    ...(row.detail != null ? { detail: row.detail } : {}),
    ...(row.descriptor != null ? { descriptor: row.descriptor } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  });
}

/** The D1 job-run-record store (async surface over the sync-shaped port via promises). */
export class D1JobRunRecordStore {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: JobRunRecordDb) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureJobRunRecordsSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  async record(record: JobRunRecord): Promise<void> {
    await this.ensure();
    await this.db.insert(jobRunRecords).values({
      system: record.system,
      jobId: record.jobId,
      operation: record.operation,
      started: record.started,
      finished: record.finished,
      outcome: record.outcome,
      triggeredBy: record.triggeredBy,
      triggerText: record.trigger ?? null,
      scheduleId: record.scheduleId ?? null,
      asyncJobId: record.asyncJobId ?? null,
      workflowId: record.workflowId ?? null,
      kind: record.kind ?? null,
      originRunId: record.originRunId ?? null,
      definitionVersion: record.definitionVersion ?? null,
      // Issue #5102 (F5 of #5094) — the binding tuple, stamped
      // on new rows; null on rows whose call site carried none.
      accountType: record.accountType ?? null,
      accountId: record.accountId ?? null,
      bindingScope: record.bindingScope ?? null,
      bindingSource: record.bindingSource ?? null,
      errorText: record.error ?? null,
      detail: record.detail ?? null,
      descriptor: record.descriptor ?? null,
      artifactRefsJson: record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
    });
    // Prune to the per-job cap: keep the newest rows by the
    // history ordering, delete the rest (the DO adapter's
    // NOT IN discipline, expressed through the query builder).
    await this.pruneToCap(record.jobId);
  }

  /**
   * Issue #6099 — the projector's conditional upsert for one DO job
   * run record. The conflict target is the derived identity
   * (job_id, started, finished) — migration 0081's unique index.
   * Job run records are immutable once written, so there is no
   * updated_at ordering to compare: the upsert is insert-if-absent,
   * plus the null upgrade (a present row whose tenant_id is NULL —
   * an engine-written row — gets its tenant + projected_at_ms
   * filled, and nothing else; the engine row's own fields are
   * authoritative and never overwritten by the DO twin). Returns
   * true when the write landed (insert or null-upgrade) and false
   * when it was a no-op (exact replay). Same meta.changes detection
   * as the async-job adapter; same per-job cap prune as record().
   *
   * Broker provenance (brokerId / dataProviderId / mode /
   * modeSource) is NOT carried: the D1 table has no columns for it,
   * and the engine's D1 writes drop it too — the DO row keeps it.
   *
   * Issue #5102 (F5 of #5094) — the binding tuple IS carried: the
   * D1 table gained the four columns in migration 0084, so a
   * projected row keeps its DO twin's tuple. The null upgrade does
   * NOT fill a binding onto an existing engine row: the engine
   * row's own fields are authoritative, and a null binding on it
   * reads as unbound (the legacy rule), never as a cross-ledger
   * backfill.
   */
  async recordProjectedJobRunRecord(
    row: JobRunRecordProjectionInput,
    nowMs: number,
  ): Promise<boolean> {
    await this.ensure();
    const record = row.record;
    const values = {
      system: record.system,
      jobId: record.jobId,
      operation: record.operation,
      started: record.started,
      finished: record.finished,
      outcome: record.outcome,
      triggeredBy: record.triggeredBy,
      triggerText: record.trigger ?? null,
      scheduleId: record.scheduleId ?? null,
      asyncJobId: record.asyncJobId ?? null,
      workflowId: record.workflowId ?? null,
      kind: record.kind ?? null,
      originRunId: record.originRunId ?? null,
      definitionVersion: record.definitionVersion ?? null,
      // Issue #5102 (F5 of #5094) — the DO twin's binding tuple
      // rides the projection, so the D1 row is not unbound forever.
      accountType: record.accountType ?? null,
      accountId: record.accountId ?? null,
      bindingScope: record.bindingScope ?? null,
      bindingSource: record.bindingSource ?? null,
      errorText: record.error ?? null,
      detail: record.detail ?? null,
      descriptor: record.descriptor ?? null,
      artifactRefsJson: record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
      tenantId: row.tenantId,
      projectedAtMs: nowMs,
    };
    const result = (await this.db
      .insert(jobRunRecords)
      .values(values)
      .onConflictDoUpdate({
        target: [jobRunRecords.jobId, jobRunRecords.started, jobRunRecords.finished],
        set: { tenantId: row.tenantId, projectedAtMs: nowMs },
        where: isNull(jobRunRecords.tenantId),
      })) as unknown as { meta?: { changes?: number } };
    const changes = result?.meta?.changes;
    const written = typeof changes === "number" ? changes > 0 : true;
    if (written) {
      await this.pruneToCap(record.jobId);
    }
    return written;
  }

  /** Shared per-job cap prune (record + the projection upsert). */
  private async pruneToCap(jobId: string): Promise<void> {
    const keep = await this.db
      .select({ id: jobRunRecords.id })
      .from(jobRunRecords)
      .where(eq(jobRunRecords.jobId, jobId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(JOB_RUN_RECORDS_PER_JOB_CAP);
    const keepIds = keep.map((r) => r.id);
    if (keepIds.length > 0) {
      await this.db
        .delete(jobRunRecords)
        .where(and(eq(jobRunRecords.jobId, jobId), notInArray(jobRunRecords.id, keepIds)));
    }
  }

  async listByJob(jobId: string, limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobRunRecords)
      .where(eq(jobRunRecords.jobId, jobId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(Math.max(1, limit));
    return rows.map(rowToRecord);
  }

  async latestByJob(jobId: string): Promise<JobRunRecord | undefined> {
    return (await this.listByJob(jobId, 1))[0];
  }

  async listRecent(limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobRunRecords)
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(Math.max(1, limit));
    return rows.map(rowToRecord);
  }
}

/**
 * Note on surfaces: the port (JobRunRecordStore) is synchronous
 * because DO SQLite is synchronous, so this async D1 class does
 * not pretend to implement it directly. The pipeline engine
 * consumes run records through the async seam in
 * src/services/jobPipelineEngine.ts (JobRunRecorder), which this
 * class satisfies structurally — one record shape, one table,
 * two residencies.
 */
