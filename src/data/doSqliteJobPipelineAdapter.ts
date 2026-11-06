/**
 * Issue #3534 (Pipeline J1) — the DO-SQLite implementation of the
 * job-pipeline stores (agent-hosted residency, mirroring the
 * job-run-record adapter's shape, #2964): tables are ensured
 * lazily on every operation (CREATE TABLE IF NOT EXISTS), and
 * records ride as JSON columns so the recursive job shape never
 * needs a migration to grow a field. All sql.exec sites live
 * here, inside src/data/ — never above the layer (global D-D
 * census surface 1).
 */
import type { SqlStorage } from "../orm";
import {
  JOB_PIPELINE_ARTIFACTS_TABLE,
  JOB_PIPELINE_DEFINITIONS_TABLE,
  JOB_PIPELINE_INSTANCES_TABLE,
  type JobDefinition,
  type JobInstanceRecord,
  type JobPipelineStores,
} from "./jobPipelinePorts";

function ensureTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_DEFINITIONS_TABLE} (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_INSTANCES_TABLE} (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      current_run_id TEXT,
      run_started_at TEXT,
      run_trigger TEXT,
      checkpoint_json TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_ARTIFACTS_TABLE} (
      run_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (run_id, artifact_key)
    )`);
}

function instanceToRow(record: JobInstanceRecord): Record<string, unknown> {
  return {
    job_id: record.jobId,
    state: record.state,
    desired_state: record.desiredState,
    current_run_id: record.currentRunId,
    run_started_at: record.runStartedAt,
    run_trigger: record.runTrigger,
    checkpoint_json: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
    last_error: record.lastError,
    updated_at: record.updatedAt,
  };
}

function rowToInstance(row: Record<string, unknown>): JobInstanceRecord {
  return {
    jobId: String(row.job_id),
    state: String(row.state) as JobInstanceRecord["state"],
    desiredState: String(row.desired_state) as JobInstanceRecord["desiredState"],
    currentRunId: row.current_run_id != null ? String(row.current_run_id) : null,
    runStartedAt: row.run_started_at != null ? String(row.run_started_at) : null,
    runTrigger: (row.run_trigger != null ? String(row.run_trigger) : null) as JobInstanceRecord["runTrigger"],
    checkpoint:
      row.checkpoint_json != null
        ? (JSON.parse(String(row.checkpoint_json)) as JobInstanceRecord["checkpoint"])
        : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    updatedAt: String(row.updated_at),
  };
}

/** The DO-SQLite pipeline stores over a host agent's own SQLite. */
export class DoSqliteJobPipelineStores implements JobPipelineStores {
  constructor(private readonly sql: SqlStorage) {}

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      ensureTables(this.sql);
      this.sql.exec(
        `INSERT INTO ${JOB_PIPELINE_DEFINITIONS_TABLE} (job_id, name, definition_json, version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET name = excluded.name, definition_json = excluded.definition_json, version = excluded.version, updated_at = excluded.updated_at`,
        definition.jobId,
        definition.name,
        JSON.stringify(definition),
        definition.version,
        definition.updatedAt,
      );
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      ensureTables(this.sql);
      const rows = Array.from(
        this.sql.exec(
          `SELECT definition_json FROM ${JOB_PIPELINE_DEFINITIONS_TABLE} WHERE job_id = ?`,
          jobId,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.length ? (JSON.parse(String(rows[0].definition_json)) as JobDefinition) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      ensureTables(this.sql);
      const rows = Array.from(
        this.sql.exec(
          `SELECT definition_json FROM ${JOB_PIPELINE_DEFINITIONS_TABLE} ORDER BY job_id ASC`,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => JSON.parse(String(r.definition_json)) as JobDefinition);
    },
  };

  readonly instances = {
    getInstance: async (jobId: string): Promise<JobInstanceRecord | null> => {
      ensureTables(this.sql);
      const rows = Array.from(
        this.sql.exec(
          `SELECT * FROM ${JOB_PIPELINE_INSTANCES_TABLE} WHERE job_id = ?`,
          jobId,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.length ? rowToInstance(rows[0]) : null;
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      ensureTables(this.sql);
      const row = instanceToRow(record);
      this.sql.exec(
        `INSERT INTO ${JOB_PIPELINE_INSTANCES_TABLE} (job_id, state, desired_state, current_run_id, run_started_at, run_trigger, checkpoint_json, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, desired_state = excluded.desired_state, current_run_id = excluded.current_run_id, run_started_at = excluded.run_started_at, run_trigger = excluded.run_trigger, checkpoint_json = excluded.checkpoint_json, last_error = excluded.last_error, updated_at = excluded.updated_at`,
        row.job_id,
        row.state,
        row.desired_state,
        row.current_run_id,
        row.run_started_at,
        row.run_trigger,
        row.checkpoint_json,
        row.last_error,
        row.updated_at,
      );
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      ensureTables(this.sql);
      this.sql.exec(
        `INSERT INTO ${JOB_PIPELINE_ARTIFACTS_TABLE} (run_id, artifact_key, value_json)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id, artifact_key) DO UPDATE SET value_json = excluded.value_json`,
        runId,
        key,
        JSON.stringify(value ?? null),
      );
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      ensureTables(this.sql);
      const rows = Array.from(
        this.sql.exec(
          `SELECT value_json FROM ${JOB_PIPELINE_ARTIFACTS_TABLE} WHERE run_id = ? AND artifact_key = ?`,
          runId,
          key,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.length ? (JSON.parse(String(rows[0].value_json)) as unknown) : null;
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      ensureTables(this.sql);
      const rows = Array.from(
        this.sql.exec(
          `SELECT artifact_key FROM ${JOB_PIPELINE_ARTIFACTS_TABLE} WHERE run_id = ? ORDER BY artifact_key ASC`,
          runId,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => String(r.artifact_key));
    },
  };
}
