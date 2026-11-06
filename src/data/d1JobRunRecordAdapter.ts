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
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { jobRunRecords } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0047_JOB_RUN_RECORDS,
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
  return drizzle(d1, { schema: { jobRunRecords } });
}

/** Idempotent schema-ensure: applies migration 0047 if unapplied. */
export async function ensureJobRunRecordsSchema(db: JobRunRecordDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0047_JOB_RUN_RECORDS]);
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
      errorText: record.error ?? null,
      detail: record.detail ?? null,
      descriptor: record.descriptor ?? null,
      artifactRefsJson: record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
    });
    // Prune to the per-job cap: keep the newest rows by the
    // history ordering, delete the rest (the DO adapter's
    // NOT IN discipline, expressed through the query builder).
    const keep = await this.db
      .select({ id: jobRunRecords.id })
      .from(jobRunRecords)
      .where(eq(jobRunRecords.jobId, record.jobId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(JOB_RUN_RECORDS_PER_JOB_CAP);
    const keepIds = keep.map((r) => r.id);
    if (keepIds.length > 0) {
      await this.db
        .delete(jobRunRecords)
        .where(and(eq(jobRunRecords.jobId, record.jobId), notInArray(jobRunRecords.id, keepIds)));
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
