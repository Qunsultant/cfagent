/**
 * Issue #4360 — the DO-SQLite JobStageEventStore.
 *
 * The ScheduledAgent's DO owns the pipeline, so its SQLite is the stage
 * event store's home (same residency rule as the instance checkpoint).
 * The table is ensured lazily on every operation, `event_key` is
 * UNIQUE so a re-delivered publication is
 * ignored rather than duplicated, and `listByRun` reads a run's events
 * in the order they were recorded. Every sql.exec site lives here,
 * inside src/data/ (the global D-D census rule).
 */
import type { SqlStorage } from "../orm";
import {
  JOB_STAGE_EVENTS_TABLE,
  type JobStageEventRecord,
  type JobStageEventStore,
} from "./jobStageEventPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

function ensureTable(sql: SqlStorage): void {
  sql.exec(doTableSql("job_stage_events"));
  sql.exec(
    doIndexSql("idx_job_stage_events_run"),
  );
}

function rowToRecord(row: Record<string, unknown>): JobStageEventRecord {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value !== "" ? value : null;
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
  };
}

export function createDoSqliteJobStageEventStore(sql: SqlStorage): JobStageEventStore {
  return {
    record: async (event): Promise<boolean> => {
      ensureTable(sql);
      const existing = Array.from(
        sql.exec(
          `SELECT 1 AS present FROM ${JOB_STAGE_EVENTS_TABLE} WHERE event_key = ?`,
          event.eventKey,
        ),
      ) as Array<{ present?: unknown }>;
      if (existing.length > 0) return false;
      sql.exec(
        `INSERT INTO ${JOB_STAGE_EVENTS_TABLE} (event_key, claim_key, run_id, job_id, stage_id, unit_id, action, at, started_at, ended_at, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      return true;
    },
    listByRun: async (runId): Promise<JobStageEventRecord[]> => {
      ensureTable(sql);
      const rows = Array.from(
        sql.exec(
          `SELECT event_key, claim_key, run_id, job_id, stage_id, unit_id, action, at, started_at, ended_at, detail
             FROM ${JOB_STAGE_EVENTS_TABLE} WHERE run_id = ? ORDER BY id ASC`,
          runId,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.map(rowToRecord);
    },
  };
}
