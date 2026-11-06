/**
 * Issue #3534 (Pipeline J1) — the D1 implementation of the
 * EXISTING job-run-record port (src/data/jobRunRecordPorts.ts,
 * #2964/#3121): same port, same table, same record shape — the
 * workflow-hosted residency, beside the DO-SQLite adapter's
 * agent-hosted one (the provider-capture port's D1/DO adapter
 * split is the precedent). Pipeline runs executing inside a
 * workflow have no host Durable Object to borrow SQLite from;
 * this adapter lets them record through the one run-record
 * machinery instead of inventing a second store. Raw
 * prepare/bind; all prepare() sites live inside src/data/.
 */
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  JOB_RUN_RECORDS_TABLE,
  type JobRunRecord,
  type JobRunRecordStore,
} from "./jobRunRecordPorts";
import { normalizeJobRunRecord } from "../services/jobRunRecords";

/** Minimal structural shape of the D1 binding this adapter needs. */
export interface JobRunRecordD1Db {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${JOB_RUN_RECORDS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, system TEXT NOT NULL, job_id TEXT NOT NULL, operation TEXT NOT NULL, started TEXT NOT NULL, finished TEXT NOT NULL, outcome TEXT NOT NULL, triggered_by TEXT NOT NULL, trigger_text TEXT, schedule_id TEXT, async_job_id TEXT, workflow_id TEXT, error_text TEXT, detail TEXT, descriptor TEXT, artifact_refs_json TEXT)`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${JOB_RUN_RECORDS_TABLE}_job_idx ON ${JOB_RUN_RECORDS_TABLE} (job_id, started DESC, id DESC)`;
const INSERT_SQL = `INSERT INTO ${JOB_RUN_RECORDS_TABLE} (system, job_id, operation, started, finished, outcome, triggered_by, trigger_text, schedule_id, async_job_id, workflow_id, error_text, detail, descriptor, artifact_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const PRUNE_SQL = `DELETE FROM ${JOB_RUN_RECORDS_TABLE} WHERE job_id = ? AND id NOT IN (SELECT id FROM ${JOB_RUN_RECORDS_TABLE} WHERE job_id = ? ORDER BY started DESC, id DESC LIMIT ?)`;
const LIST_BY_JOB_SQL = `SELECT * FROM ${JOB_RUN_RECORDS_TABLE} WHERE job_id = ? ORDER BY started DESC, id DESC LIMIT ?`;
const LIST_RECENT_SQL = `SELECT * FROM ${JOB_RUN_RECORDS_TABLE} ORDER BY started DESC, id DESC LIMIT ?`;

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
  });
}

/** The D1 job-run-record store (async surface over the sync-shaped port via promises). */
export class D1JobRunRecordStore {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: JobRunRecordD1Db) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = (async () => {
        await this.db.prepare(CREATE_TABLE_SQL).run();
        await this.db.prepare(CREATE_INDEX_SQL).run();
      })();
    }
    return this.ensured;
  }

  async record(record: JobRunRecord): Promise<void> {
    await this.ensure();
    await this.db
      .prepare(INSERT_SQL)
      .bind(
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
      )
      .run();
    await this.db
      .prepare(PRUNE_SQL)
      .bind(record.jobId, record.jobId, JOB_RUN_RECORDS_PER_JOB_CAP)
      .run();
  }

  async listByJob(jobId: string, limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const { results } = await this.db
      .prepare(LIST_BY_JOB_SQL)
      .bind(jobId, Math.max(1, limit))
      .all<Record<string, unknown>>();
    return results.map(rowToRecord);
  }

  async latestByJob(jobId: string): Promise<JobRunRecord | undefined> {
    return (await this.listByJob(jobId, 1))[0];
  }

  async listRecent(limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const { results } = await this.db
      .prepare(LIST_RECENT_SQL)
      .bind(Math.max(1, limit))
      .all<Record<string, unknown>>();
    return results.map(rowToRecord);
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
