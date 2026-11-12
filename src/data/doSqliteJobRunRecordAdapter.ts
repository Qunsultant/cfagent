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
import { normalizeJobRunRecord } from "../services/jobRunRecords";
import { ensureJobRunRecordIndexes } from "./jobRunRecordIndexSchema";

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
      trigger_text TEXT,
      schedule_id TEXT,
      async_job_id TEXT,
      workflow_id TEXT,
      error_text TEXT,
      detail TEXT,
      descriptor TEXT,
      artifact_refs_json TEXT,
      broker_id TEXT,
      data_provider_id TEXT,
      mode TEXT,
      mode_source TEXT
    )`);
  // Issue #3121 S1 — the §4 consolidated-ledger columns, added when
  // missing so existing DO tables upgrade in place (the probed
  // additive-column pattern from doSqliteAsyncJobAdapter). `trigger`
  // is stored as trigger_text (`trigger` reads as a keyword in some
  // SQLite contexts; the column name stays unambiguous).
  const cols = Array.from(
    sql.exec(`PRAGMA table_info(${JOB_RUN_RECORDS_TABLE})`),
  ) as Array<{ name?: unknown }>;
  const names = new Set(cols.map((c) => String(c?.name ?? "")));
  if (!names.has("trigger_text")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN trigger_text TEXT`);
  }
  if (!names.has("schedule_id")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN schedule_id TEXT`);
  }
  if (!names.has("async_job_id")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN async_job_id TEXT`);
  }
  if (!names.has("workflow_id")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN workflow_id TEXT`);
  }
  // Issue #3655 — broker + data-provider + mode provenance columns,
  // added when missing so existing DO tables upgrade in place.
  if (!names.has("broker_id")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN broker_id TEXT`);
  }
  if (!names.has("data_provider_id")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN data_provider_id TEXT`);
  }
  if (!names.has("mode")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN mode TEXT`);
  }
  // Issue #3655 (effective mode): the resolver source rides the row
  // with the mode, so a pinned-live run is visible as such.
  if (!names.has("mode_source")) {
    sql.exec(`ALTER TABLE ${JOB_RUN_RECORDS_TABLE} ADD COLUMN mode_source TEXT`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS ${JOB_RUN_RECORDS_TABLE}_job_idx ON ${JOB_RUN_RECORDS_TABLE} (job_id, started DESC, id DESC)`);
  // Issue #3121 Phase 2 (#3124) — the recent-read ordering index
  // (src/data/jobRunRecordIndexSchema.ts, #2280 pattern).
  ensureJobRunRecordIndexes(sql);
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
  // Issue #3121 S1 — a row stored before the §4 columns existed reads
  // back normalized: trigger "unknown", ids null (legacy rows only;
  // no silent backfill — the read value is normalized, the stored
  // row is untouched).
  return normalizeJobRunRecord({
    system: String(row.system) as JobRunRecord["system"],
    jobId: String(row.job_id),
    operation: String(row.operation),
    started: String(row.started),
    finished: String(row.finished),
    outcome: String(row.outcome) as JobRunRecord["outcome"],
    triggeredBy: String(row.triggered_by) as JobRunRecord["triggeredBy"],
    ...(row.trigger_text != null
      ? { trigger: String(row.trigger_text) as JobRunRecord["trigger"] }
      : {}),
    ...(row.schedule_id != null ? { scheduleId: String(row.schedule_id) } : {}),
    ...(row.async_job_id != null ? { asyncJobId: String(row.async_job_id) } : {}),
    ...(row.workflow_id != null ? { workflowId: String(row.workflow_id) } : {}),
    ...(row.error_text != null ? { error: String(row.error_text) } : {}),
    ...(row.detail != null ? { detail: String(row.detail) } : {}),
    ...(row.descriptor != null ? { descriptor: String(row.descriptor) } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
    ...(row.broker_id != null ? { brokerId: String(row.broker_id) } : {}),
    ...(row.data_provider_id != null ? { dataProviderId: String(row.data_provider_id) } : {}),
    ...(row.mode != null ? { mode: String(row.mode) as JobRunRecord["mode"] } : {}),
    ...(row.mode_source != null ? { modeSource: String(row.mode_source) as JobRunRecord["modeSource"] } : {}),
  });
}

function recordSync(sql: SqlStorage, record: JobRunRecord): void {
  ensureTable(sql);
  sql.exec(
    `INSERT INTO ${JOB_RUN_RECORDS_TABLE}
         (system, job_id, operation, started, finished, outcome, triggered_by, trigger_text, schedule_id, async_job_id, workflow_id, error_text, detail, descriptor, artifact_refs_json, broker_id, data_provider_id, mode, mode_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.system,
    record.jobId,
    record.operation,
    record.started,
    record.finished,
    record.outcome,
    record.triggeredBy,
    record.trigger ?? null,
    record.scheduleId ?? null,
    record.asyncJobId ?? null,
    record.workflowId ?? null,
    record.error ?? null,
    record.detail ?? null,
    record.descriptor ?? null,
    record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
    record.brokerId ?? null,
    record.dataProviderId ?? null,
    record.mode ?? null,
    record.modeSource ?? null,
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
