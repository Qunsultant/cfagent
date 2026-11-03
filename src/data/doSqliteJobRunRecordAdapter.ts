/**
 * Issue #2964 — the DO-SQLite implementation of the job-run-record
 * port (orchestrator-schedule runs). Mirrors the paused-schedule
 * adapter's shape (issue #2337): the table is ensured lazily on
 * every operation (CREATE TABLE IF NOT EXISTS), rows map through
 * rowToRecord, and record() inserts then prunes that job to the
 * per-job cap so the table cannot grow without bound on the
 * free tier. All sql.exec sites live here, inside src/data/ —
 * never above the layer (global D-D census surface 1).
 */
import type { SqlStorage } from "../orm";
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  JOB_RUN_RECORDS_TABLE,
  type JobRunRecord,
  type JobRunRecordStore,
} from "./jobRunRecordPorts";

function ensureTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${JOB_RUN_RECORDS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system TEXT NOT NULL,
      job_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      started TEXT NOT NULL,
      finished TEXT NOT NULL,
      outcome TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      error_text TEXT,
      detail TEXT,
      descriptor TEXT,
      artifact_refs_json TEXT
    )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${JOB_RUN_RECORDS_TABLE}_job_idx ON ${JOB_RUN_RECORDS_TABLE} (job_id, started DESC, id DESC)`);
}

function rowToRecord(row: Record<string, unknown>): JobRunRecord {
  let artifactRefs: string[] | undefined;
  if (row.artifact_refs_json != null) {
    try {
      const parsed: unknown = JSON.parse(String(row.artifact_refs_json));
      artifactRefs = Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      artifactRefs = undefined;
    }
  }
  return {
    system: String(row.system) as JobRunRecord["system"],
    jobId: String(row.job_id),
    operation: String(row.operation),
    started: String(row.started),
    finished: String(row.finished),
    outcome: String(row.outcome) as JobRunRecord["outcome"],
    triggeredBy: String(row.triggered_by) as JobRunRecord["triggeredBy"],
    ...(row.error_text != null ? { error: String(row.error_text) } : {}),
    ...(row.detail != null ? { detail: String(row.detail) } : {}),
    ...(row.descriptor != null ? { descriptor: String(row.descriptor) } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  };
}

function recordSync(sql: SqlStorage, record: JobRunRecord): void {
  ensureTable(sql);
  sql.exec(
    `INSERT INTO ${JOB_RUN_RECORDS_TABLE}
         (system, job_id, operation, started, finished, outcome, triggered_by, error_text, detail, descriptor, artifact_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.system,
    record.jobId,
    record.operation,
    record.started,
    record.finished,
    record.outcome,
    record.triggeredBy,
    record.error ?? null,
    record.detail ?? null,
    record.descriptor ?? null,
    record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
  );
  // Prune this job to the cap: delete every row outside the newest
  // cap rows (started desc, id desc breaks same-millisecond ties).
  sql.exec(
    `DELETE FROM ${JOB_RUN_RECORDS_TABLE}
      WHERE job_id = ?
        AND id NOT IN (
          SELECT id FROM ${JOB_RUN_RECORDS_TABLE}
           WHERE job_id = ?
           ORDER BY started DESC, id DESC
           LIMIT ?
        )`,
    record.jobId,
    record.jobId,
    JOB_RUN_RECORDS_PER_JOB_CAP,
  );
}

function listByJobSync(sql: SqlStorage, jobId: string, limit: number): JobRunRecord[] {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${JOB_RUN_RECORDS_TABLE}
        WHERE job_id = ?
        ORDER BY started DESC, id DESC
        LIMIT ?`,
      jobId,
      limit,
    ),
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

function listRecentSync(sql: SqlStorage, limit: number): JobRunRecord[] {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${JOB_RUN_RECORDS_TABLE}
        ORDER BY started DESC, id DESC
        LIMIT ?`,
      limit,
    ),
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/** The DO-SQLite job-run-record store over the agent's own SQLite. */
export class SqlJobRunRecordStore implements JobRunRecordStore {
  constructor(private sql: SqlStorage) {}

  record(record: JobRunRecord): void {
    recordSync(this.sql, record);
  }

  listByJob(jobId: string, limit = 50): JobRunRecord[] {
    return listByJobSync(this.sql, jobId, Math.max(1, limit));
  }

  latestByJob(jobId: string): JobRunRecord | undefined {
    return listByJobSync(this.sql, jobId, 1)[0];
  }

  listRecent(limit = 50): JobRunRecord[] {
    return listRecentSync(this.sql, Math.max(1, limit));
  }
}
