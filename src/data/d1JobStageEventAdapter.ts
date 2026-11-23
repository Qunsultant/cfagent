/**
 * Issue #6028 / #6202 — the D1 mirror of the stage rows the engine writes on
 * the DO plane.
 *
 * Same port (`JobStageEventStore`) as the DO adapter, so the engine writes
 * one store and mirrors to the other without a second shape. The table is
 * migration 0083's (`src/data/migrationRunner.ts`), catalogued in
 * `schemaComponent/d1Catalogue.ts`; this adapter owns no statement text —
 * both DDL statements come from the catalogue by code, and the DML is
 * parameterized.
 *
 * The write is an upsert on `(run_id, stage_id)`: the mirror is idempotent,
 * so a re-delivered settle can never duplicate a stage row. Reads return the
 * same record shape the DO adapter returns, which is what lets the stage read
 * answer from D1 alone when the DO is unreachable.
 */
import type { JobStageEventRecord, JobStageEventStore } from "./jobStageEventPorts";
import { d1StatementSql } from "./schemaComponent/d1Catalogue";

const TABLE = "job_stage_events";
const CREATE_CODE = "schema.d1.job_stage_events.create_table";
const INDEX_CODE = "schema.d1.job_stage_events.create_index_job_stage_events_run_stage_idx";

const COLUMNS =
  "event_key, claim_key, run_id, job_id, stage_id, unit_id, action, at, started_at, ended_at, detail, stage_status, duration_ms, unit_count, failed_unit_count, result_ref, definition_version";

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowToRecord(row: Record<string, unknown>): JobStageEventRecord {
  return {
    eventKey: String(row.event_key ?? ""),
    claimKey: String(row.claim_key ?? ""),
    runId: String(row.run_id ?? ""),
    jobId: String(row.job_id ?? ""),
    stageId: String(row.stage_id ?? ""),
    unitId: str(row.unit_id),
    action: String(row.action ?? ""),
    at: String(row.at ?? ""),
    startedAt: str(row.started_at),
    endedAt: str(row.ended_at),
    detail: str(row.detail),
    stageStatus: str(row.stage_status) ?? undefined,
    durationMs: num(row.duration_ms),
    unitCount: num(row.unit_count) ?? undefined,
    failedUnitCount: num(row.failed_unit_count) ?? undefined,
    resultRef: str(row.result_ref),
    definitionVersion: num(row.definition_version),
  };
}

/** Idempotent schema ensure: the catalogue's CREATE + unique index, then the read-back shape. */
async function ensureTable(d1: D1Database): Promise<void> {
  await d1.prepare(d1StatementSql(CREATE_CODE)).run();
  await d1.prepare(d1StatementSql(INDEX_CODE)).run();
}

export function createD1JobStageEventStore(d1: D1Database): JobStageEventStore {
  return {
    record: async (event: JobStageEventRecord): Promise<boolean> => {
      await ensureTable(d1);
      await d1
        .prepare(
          `INSERT INTO ${TABLE} (${COLUMNS}, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id, stage_id) DO UPDATE SET
               event_key = excluded.event_key,
               claim_key = excluded.claim_key,
               unit_id = excluded.unit_id,
               action = excluded.action,
               at = excluded.at,
               started_at = excluded.started_at,
               ended_at = excluded.ended_at,
               detail = excluded.detail,
               stage_status = excluded.stage_status,
               duration_ms = excluded.duration_ms,
               unit_count = excluded.unit_count,
               failed_unit_count = excluded.failed_unit_count,
               result_ref = excluded.result_ref,
               definition_version = excluded.definition_version`,
        )
        .bind(
          event.eventKey,
          event.claimKey,
          event.runId,
          event.jobId,
          event.stageId,
          event.unitId,
          event.action,
          event.at,
          event.startedAt,
          event.endedAt,
          event.detail,
          event.stageStatus ?? null,
          event.durationMs ?? null,
          event.unitCount ?? null,
          event.failedUnitCount ?? null,
          event.resultRef ?? null,
          event.definitionVersion ?? null,
          // The mirror's tenant stamp is the pipeline's own: the run id's
          // owner is stamped by the caller that has it (null here, never
          // invented — migration 0081 uses the same nullable convention).
          null,
        )
        .run();
      return true;
    },
    listByRun: async (runId: string): Promise<JobStageEventRecord[]> => {
      await ensureTable(d1);
      const result = await d1
        .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE run_id = ? ORDER BY id ASC`)
        .bind(runId)
        .all<Record<string, unknown>>();
      const rows = Array.isArray(result?.results) ? result.results : [];
      return rows.map(rowToRecord);
    },
  };
}
