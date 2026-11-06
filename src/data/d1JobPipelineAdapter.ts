/**
 * Issue #3534 (Pipeline J1) — the D1 implementation of the
 * job-pipeline stores (workflow-hosted residency), raw
 * prepare/bind in the d1IndexListAdapter pattern: single-line
 * statements, idempotent CREATEs, semantics identical to the
 * DO-SQLite and in-memory adapters. All prepare() sites live
 * here, inside src/data/ — never above the layer (global D-D
 * census surface 3).
 */
import {
  JOB_PIPELINE_ARTIFACTS_TABLE,
  JOB_PIPELINE_DEFINITIONS_TABLE,
  JOB_PIPELINE_INSTANCES_TABLE,
  type JobDefinition,
  type JobInstanceRecord,
  type JobPipelineStores,
} from "./jobPipelinePorts";

/** Minimal structural shape of the D1 binding this adapter needs. */
export interface JobPipelineD1Db {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
}

const CREATE_DEFINITIONS_SQL = `CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_DEFINITIONS_TABLE} (job_id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_json TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`;
const CREATE_INSTANCES_SQL = `CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_INSTANCES_TABLE} (job_id TEXT PRIMARY KEY, state TEXT NOT NULL, desired_state TEXT NOT NULL, current_run_id TEXT, run_started_at TEXT, run_trigger TEXT, checkpoint_json TEXT, last_error TEXT, updated_at TEXT NOT NULL)`;
const CREATE_ARTIFACTS_SQL = `CREATE TABLE IF NOT EXISTS ${JOB_PIPELINE_ARTIFACTS_TABLE} (run_id TEXT NOT NULL, artifact_key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (run_id, artifact_key))`;

const SAVE_DEFINITION_SQL = `INSERT INTO ${JOB_PIPELINE_DEFINITIONS_TABLE} (job_id, name, definition_json, version, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET name = excluded.name, definition_json = excluded.definition_json, version = excluded.version, updated_at = excluded.updated_at`;
const GET_DEFINITION_SQL = `SELECT definition_json FROM ${JOB_PIPELINE_DEFINITIONS_TABLE} WHERE job_id = ?`;
const LIST_DEFINITIONS_SQL = `SELECT definition_json FROM ${JOB_PIPELINE_DEFINITIONS_TABLE} ORDER BY job_id ASC`;

const SAVE_INSTANCE_SQL = `INSERT INTO ${JOB_PIPELINE_INSTANCES_TABLE} (job_id, state, desired_state, current_run_id, run_started_at, run_trigger, checkpoint_json, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, desired_state = excluded.desired_state, current_run_id = excluded.current_run_id, run_started_at = excluded.run_started_at, run_trigger = excluded.run_trigger, checkpoint_json = excluded.checkpoint_json, last_error = excluded.last_error, updated_at = excluded.updated_at`;
const GET_INSTANCE_SQL = `SELECT * FROM ${JOB_PIPELINE_INSTANCES_TABLE} WHERE job_id = ?`;

const PUT_ARTIFACT_SQL = `INSERT INTO ${JOB_PIPELINE_ARTIFACTS_TABLE} (run_id, artifact_key, value_json) VALUES (?, ?, ?) ON CONFLICT(run_id, artifact_key) DO UPDATE SET value_json = excluded.value_json`;
const GET_ARTIFACT_SQL = `SELECT value_json FROM ${JOB_PIPELINE_ARTIFACTS_TABLE} WHERE run_id = ? AND artifact_key = ?`;
const LIST_ARTIFACT_KEYS_SQL = `SELECT artifact_key FROM ${JOB_PIPELINE_ARTIFACTS_TABLE} WHERE run_id = ? ORDER BY artifact_key ASC`;

/** The D1 pipeline stores over the shared AgentDB binding. */
export class D1JobPipelineStores implements JobPipelineStores {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: JobPipelineD1Db) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = (async () => {
        await this.db.prepare(CREATE_DEFINITIONS_SQL).run();
        await this.db.prepare(CREATE_INSTANCES_SQL).run();
        await this.db.prepare(CREATE_ARTIFACTS_SQL).run();
      })();
    }
    return this.ensured;
  }

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      await this.ensure();
      await this.db
        .prepare(SAVE_DEFINITION_SQL)
        .bind(
          definition.jobId,
          definition.name,
          JSON.stringify(definition),
          definition.version,
          definition.updatedAt,
        )
        .run();
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      await this.ensure();
      const row = await this.db
        .prepare(GET_DEFINITION_SQL)
        .bind(jobId)
        .first<{ definition_json: string }>();
      return row ? (JSON.parse(row.definition_json) as JobDefinition) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      await this.ensure();
      const { results } = await this.db
        .prepare(LIST_DEFINITIONS_SQL)
        .bind()
        .all<{ definition_json: string }>();
      return results.map((r) => JSON.parse(r.definition_json) as JobDefinition);
    },
  };

  readonly instances = {
    getInstance: async (jobId: string): Promise<JobInstanceRecord | null> => {
      await this.ensure();
      const row = await this.db
        .prepare(GET_INSTANCE_SQL)
        .bind(jobId)
        .first<Record<string, unknown>>();
      if (!row) return null;
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
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      await this.ensure();
      await this.db
        .prepare(SAVE_INSTANCE_SQL)
        .bind(
          record.jobId,
          record.state,
          record.desiredState,
          record.currentRunId,
          record.runStartedAt,
          record.runTrigger,
          record.checkpoint ? JSON.stringify(record.checkpoint) : null,
          record.lastError,
          record.updatedAt,
        )
        .run();
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      await this.ensure();
      await this.db
        .prepare(PUT_ARTIFACT_SQL)
        .bind(runId, key, JSON.stringify(value ?? null))
        .run();
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      await this.ensure();
      const row = await this.db
        .prepare(GET_ARTIFACT_SQL)
        .bind(runId, key)
        .first<{ value_json: string }>();
      return row ? (JSON.parse(row.value_json) as unknown) : null;
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      await this.ensure();
      const { results } = await this.db
        .prepare(LIST_ARTIFACT_KEYS_SQL)
        .bind(runId)
        .all<{ artifact_key: string }>();
      return results.map((r) => String(r.artifact_key));
    },
  };
}
