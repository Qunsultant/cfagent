/**
 * Issue #6028 / #6202 — the D1 mirror of the stage rows the engine writes on
 * the DO plane.
 *
 * Same port (`JobStageEventStore`) as the DO adapter, so the engine writes
 * one store and mirrors to the other without a second shape. The table is
 * migration 0083's, declared in the foundation's `drizzleSchema.ts`; this
 * adapter goes through drizzle (the D1 family's one query path — no raw DML
 * and no `.prepare(` in a `d1*.ts` file, per the #4384 pin).
 *
 * The write is an upsert on `(run_id, stage_id)`: the mirror is idempotent,
 * so a re-delivered settle can never duplicate a stage row. Reads return the
 * same record shape the DO adapter returns, which is what lets the stage read
 * answer from D1 alone when the DO is unreachable.
 */
import { and, asc, eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { jobStageEvents } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0083_JOB_STAGE_EVENTS,
  type MigrationDb,
} from "./migrationRunner";
import type { JobStageEventRecord, JobStageEventStore } from "./jobStageEventPorts";

/** Drizzle D1 database carrying the stage-event table. */
export type JobStageEventDb = DrizzleD1Database<{
  jobStageEvents: typeof jobStageEvents;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1JobStageEventDb(d1: D1Database): JobStageEventDb {
  return createDrizzleD1Db(d1, { schema: { jobStageEvents } });
}

/** Idempotent schema ensure: applies migration 0083 if unapplied. */
export async function ensureJobStageEventsSchema(db: JobStageEventDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0083_JOB_STAGE_EVENTS]);
}

function rowToRecord(row: typeof jobStageEvents.$inferSelect): JobStageEventRecord {
  return {
    eventKey: row.eventKey,
    claimKey: row.claimKey,
    runId: row.runId,
    jobId: row.jobId,
    stageId: row.stageId,
    unitId: row.unitId,
    action: row.action,
    at: row.at,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    detail: row.detail,
    stageStatus: row.stageStatus ?? undefined,
    durationMs: row.durationMs,
    unitCount: row.unitCount ?? undefined,
    failedUnitCount: row.failedUnitCount ?? undefined,
    resultRef: row.resultRef,
    definitionVersion: row.definitionVersion,
  };
}

export function createD1JobStageEventStore(d1: D1Database): JobStageEventStore {
  const db = createD1JobStageEventDb(d1);
  // One ensure per store instance: the schema is settled before the first
  // write or read, and never re-applied per row.
  let ready: Promise<unknown> | null = null;
  const ensureOnce = (): Promise<unknown> => (ready ??= ensureJobStageEventsSchema(db));

  return {
    record: async (event: JobStageEventRecord): Promise<boolean> => {
      await ensureOnce();
      // Issue #6101 (step 7) — the port contract is dedup on the
      // event key: a re-delivered publication is a no-op returning
      // false, like the DO and in-memory stores did. One row per
      // (run, stage), latest wins, so the check reads the current
      // row's event key: same key ⇒ already recorded, no write.
      const existing = await db
        .select({ eventKey: jobStageEvents.eventKey })
        .from(jobStageEvents)
        .where(
          and(
            eq(jobStageEvents.runId, event.runId),
            eq(jobStageEvents.stageId, event.stageId),
          ),
        )
        .limit(1);
      if (existing.length > 0 && existing[0].eventKey === event.eventKey) {
        return false;
      }
      const values = {
        eventKey: event.eventKey,
        claimKey: event.claimKey,
        runId: event.runId,
        jobId: event.jobId,
        stageId: event.stageId,
        unitId: event.unitId,
        action: event.action,
        at: event.at,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        detail: event.detail,
        stageStatus: event.stageStatus ?? null,
        durationMs: event.durationMs ?? null,
        unitCount: event.unitCount ?? null,
        failedUnitCount: event.failedUnitCount ?? null,
        resultRef: event.resultRef ?? null,
        definitionVersion: event.definitionVersion ?? null,
        // The mirror's tenant stamp is the caller's to fill; an
        // engine-written row carries null, never an invented tenant.
        tenantId: null,
      };
      await db
        .insert(jobStageEvents)
        .values(values)
        .onConflictDoUpdate({
          target: [jobStageEvents.runId, jobStageEvents.stageId],
          set: {
            eventKey: values.eventKey,
            claimKey: values.claimKey,
            jobId: values.jobId,
            unitId: values.unitId,
            action: values.action,
            at: values.at,
            startedAt: values.startedAt,
            endedAt: values.endedAt,
            detail: values.detail,
            stageStatus: values.stageStatus,
            durationMs: values.durationMs,
            unitCount: values.unitCount,
            failedUnitCount: values.failedUnitCount,
            resultRef: values.resultRef,
            definitionVersion: values.definitionVersion,
          },
        });
      return true;
    },
    listByRun: async (runId: string): Promise<JobStageEventRecord[]> => {
      await ensureOnce();
      const rows = await db
        .select()
        .from(jobStageEvents)
        .where(eq(jobStageEvents.runId, runId))
        .orderBy(asc(jobStageEvents.id));
      return rows.map(rowToRecord);
    },
  };
}
