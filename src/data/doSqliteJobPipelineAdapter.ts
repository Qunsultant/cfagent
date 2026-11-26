/**
 * Issue #3534 (Pipeline J1), ORM conformance #3548 — the
 * DO-SQLite implementation of the job-pipeline stores
 * (agent-hosted residency), built on the CDO data foundation:
 * the tables are the foundation's (declared in
 * src/data/drizzleSchema.ts, DDL authority migration 0046 in
 * src/data/migrationRunner.ts — the same shapes in every
 * residency), the repositories ride the foundation's Repository
 * core (src/data/ormRepositoryCore.ts), and the schema is
 * ensured through the foundation's DO migration discipline —
 * one DDL home, applied directly in legacy mode or through
 * applyDoSchemaMigrations in managed mode (the
 * doSqliteScreenRunLockAdapter pattern). All sql.exec sites
 * live here, inside src/data/ — never above the layer (global
 * D-D census surface 1).
 */
import type { SqlStorage } from "../orm";
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { Repository } from "./ormRepositoryCore";
import type {
  jobPipelineArtifacts,
  jobPipelineDefinitionVersions,
  jobPipelineDefinitions,
  jobPipelineInstances,
} from "./drizzleSchema";
import {
  JOB_PIPELINE_ARTIFACTS_TABLE,
  JOB_PIPELINE_DEFINITIONS_TABLE,
  JOB_PIPELINE_INSTANCES_TABLE,
  jobPipelineArtifactId,
  jobPipelineRunInstanceId,
  parseJobPipelineInstanceId,
  parseRunProvenance,
  type JobDefinition,
  type JobInstanceRecord,
  type JobPipelineStores,
} from "./jobPipelinePorts";
import { remainderAlterSql, remainderFrozenTableSql } from "./schemaComponent/remainderCatalogue";

type JobDefinitionRow = typeof jobPipelineDefinitions.$inferSelect;
type JobDefinitionVersionRow = typeof jobPipelineDefinitionVersions.$inferSelect;
type JobInstanceRow = typeof jobPipelineInstances.$inferSelect;
type JobArtifactRow = typeof jobPipelineArtifacts.$inferSelect;

export const JOB_PIPELINE_DEFINITION_COLUMNS: Record<keyof JobDefinitionRow & string, string> = {
  jobId: "job_id",
  name: "name",
  definitionJson: "definition_json",
  version: "version",
  updatedAt: "updated_at",
};

/** Issue #5865 — the append-only definition history's column map. */
export const JOB_PIPELINE_DEFINITION_VERSION_COLUMNS: Record<
  keyof JobDefinitionVersionRow & string,
  string
> = {
  id: "id",
  jobId: "job_id",
  version: "version",
  definitionJson: "definition_json",
  updatedAt: "updated_at",
};

export const JOB_PIPELINE_INSTANCE_COLUMNS: Record<keyof JobInstanceRow & string, string> = {
  jobId: "job_id",
  state: "state",
  desiredState: "desired_state",
  currentRunId: "current_run_id",
  runStartedAt: "run_started_at",
  runTrigger: "run_trigger",
  runKind: "run_kind",
  runOriginId: "run_origin_id",
  runScheduleId: "run_schedule_id",
  runAsyncJobId: "run_async_job_id",
  runWorkflowInstanceId: "run_workflow_instance_id",
  runDefinitionVersion: "run_definition_version",
  // Issue #6557 â€” the provenance carrier (#6557).
  runProvenanceJson: "run_provenance_json",
  checkpointJson: "checkpoint_json",
  stageCheckpointJson: "stage_checkpoint_json",
  stageDesiredJson: "stage_desired_json",
  lastError: "last_error",
  updatedAt: "updated_at",
};

export const JOB_PIPELINE_ARTIFACT_COLUMNS: Record<keyof JobArtifactRow & string, string> = {
  id: "id",
  runId: "run_id",
  artifactKey: "artifact_key",
  valueJson: "value_json",
};

/**
 * The pipeline tables' DDL, its ONE home for the DO residency:
 * both the legacy ensureSchema branch and the managed migration
 * below run these exact statements, and migration 0046 declares
 * the same shapes for D1 — the two modes and the two residencies
 * can never drift apart.
 */
export const JOB_PIPELINE_DEFINITIONS_DDL = doTableSql("job_pipeline_definitions");

export const JOB_PIPELINE_INSTANCES_DDL = doTableSql("job_pipeline_instances");

export const JOB_PIPELINE_ARTIFACTS_DDL = doTableSql("job_pipeline_artifacts");

export const JOB_PIPELINE_ARTIFACTS_INDEX_DDL = doIndexSql("idx_job_pipeline_artifacts_run");

/**
 * The pipeline store's first framework migration: v1 is the
 * tables exactly as migration 0046 declares them — IF NOT
 * EXISTS, so an instance converges on first managed ensure.
 * v1's `up` is FROZEN at the 0046 shape (inline, never the
 * live DDL consts above): the consts are the CURRENT shape
 * and change with the schema, while a migration's `up` is
 * history and must never change.
 *
 * Later columns do NOT ride as a v2 framework migration:
 * the framework's `up` is raw SQL only, and SQLite has no
 * `ADD COLUMN IF NOT EXISTS` — a v2 ALTER would fail on any
 * table the live const (or a legacy ensure) already created
 * with the column. Columns arrive via the probed
 * additive-column pattern in ensureSchema below (the
 * doSqliteJobRunRecordAdapter §4 precedent): PRAGMA
 * table_info, ALTER only when missing, in BOTH modes, so
 * every residency and every legacy→managed switch converges.
 */
export const JOB_PIPELINE_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_job_pipeline",
  up: [
    remainderFrozenTableSql("job_pipeline_definitions"),
    remainderFrozenTableSql("job_pipeline_instances"),
    JOB_PIPELINE_ARTIFACTS_DDL,
    JOB_PIPELINE_ARTIFACTS_INDEX_DDL,
  ],
  down: [
    `DROP TABLE IF EXISTS ${JOB_PIPELINE_ARTIFACTS_TABLE}`,
    `DROP TABLE IF EXISTS ${JOB_PIPELINE_INSTANCES_TABLE}`,
    `DROP TABLE IF EXISTS ${JOB_PIPELINE_DEFINITIONS_TABLE}`,
  ],
};

/**
 * Issue #5865 — the append-only definition history. `job_pipeline_definitions`
 * keeps one row per job (the current definition); this table keeps every
 * version ever saved, so a past run's configuration survives a reconfigure
 * and historical replay (#4467) can resolve it. Migration-only on purpose:
 * the base catalogue pins the 0046 schema byte-for-byte and must not grow.
 */
export const JOB_PIPELINE_DEFINITION_VERSIONS_TABLE = "job_pipeline_definition_versions";

export const JOB_PIPELINE_DEFINITION_VERSIONS_DDL = doTableSql(
  "job_pipeline_definition_versions",
);

/** Every existing job's current definition becomes its first history row. */
export const JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL =
  `INSERT OR IGNORE INTO job_pipeline_definition_versions (id, job_id, version, definition_json, updated_at) ` +
  `SELECT job_id || ':' || version, job_id, version, definition_json, updated_at FROM job_pipeline_definitions`;

export const JOB_PIPELINE_DEFINITION_VERSIONS_MIGRATION: DoSchemaMigration = {
  version: 2,
  name: "0002_job_pipeline_definition_versions",
  up: [JOB_PIPELINE_DEFINITION_VERSIONS_DDL, JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL],
  down: [`DROP TABLE IF EXISTS ${JOB_PIPELINE_DEFINITION_VERSIONS_TABLE}`],
};

/** Options for the DO migration-framework wiring; unset = legacy. */
export interface DoSqliteJobPipelineOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

/**
 * Definitions repository. The Repository core's idField is the
 * literal column name ("job_id"); its upsert reads the id from
 * the row by that same name, so saves here compose findById +
 * create/update explicitly (the row's id property is `jobId`).
 */
class JobDefinitionRepository extends Repository<JobDefinitionRow> {
  constructor(sql: SqlStorage) {
    super(sql, JOB_PIPELINE_DEFINITIONS_TABLE, "job_id", JOB_PIPELINE_DEFINITION_COLUMNS);
  }

  save(row: JobDefinitionRow): void {
    if (this.findById(row.jobId)) this.update(row.jobId, row);
    else this.create(row);
  }
}

/** Issue #5865 — append-only: rows are created, never updated or deleted. */
class JobDefinitionVersionRepository extends Repository<JobDefinitionVersionRow> {
  constructor(sql: SqlStorage) {
    super(
      sql,
      JOB_PIPELINE_DEFINITION_VERSIONS_TABLE,
      "id",
      JOB_PIPELINE_DEFINITION_VERSION_COLUMNS,
    );
  }
}

class JobInstanceRepository extends Repository<JobInstanceRow> {
  constructor(sql: SqlStorage) {
    super(sql, JOB_PIPELINE_INSTANCES_TABLE, "job_id", JOB_PIPELINE_INSTANCE_COLUMNS);
  }

  save(row: JobInstanceRow): void {
    if (this.findById(row.jobId)) this.update(row.jobId, row);
    else this.create(row);
  }
}

class JobArtifactRepository extends Repository<JobArtifactRow> {
  constructor(sql: SqlStorage) {
    super(sql, JOB_PIPELINE_ARTIFACTS_TABLE, "id", JOB_PIPELINE_ARTIFACT_COLUMNS);
  }
}

function instanceToRow(record: JobInstanceRecord): JobInstanceRow {
  return {
    // Issue #6555 — a run-scoped row is stored under its
    // composite key (job + run marker + run key); a management
    // row keeps the plain job id. No DDL change: the key column
    // already holds text.
    jobId:
      record.instanceScope === "run" && record.runKey
        ? jobPipelineRunInstanceId(record.jobId, record.runKey)
        : record.jobId,
    state: record.state,
    desiredState: record.desiredState,
    currentRunId: record.currentRunId,
    runStartedAt: record.runStartedAt,
    runTrigger: record.runTrigger,
    runKind: record.runKind,
    runOriginId: record.runOriginId,
    runScheduleId: record.runScheduleId,
    runAsyncJobId: record.runAsyncJobId,
    runWorkflowInstanceId: record.runWorkflowInstanceId,
    runDefinitionVersion: record.runDefinitionVersion ?? null,
    runProvenanceJson: record.runProvenance
      ? JSON.stringify(record.runProvenance)
      : null,
    checkpointJson: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
    stageCheckpointJson: record.stageCheckpoint ? JSON.stringify(record.stageCheckpoint) : null,
    stageDesiredJson: record.stageDesired ? JSON.stringify(record.stageDesired) : null,
    lastError: record.lastError,
    updatedAt: record.updatedAt,
  };
}

function rowToInstance(row: JobInstanceRow): JobInstanceRecord {
  // Issue #6555 — parse the stored key back: a composite key
  // restores the job id, the run scope, and the run key. A plain
  // key is a management row, whose scope fields stay absent
  // (absent means "job") so the historical record shape is
  // unchanged for existing rows.
  const parsed = parseJobPipelineInstanceId(row.jobId);
  return {
    jobId: parsed.jobId,
    ...(parsed.instanceScope === "run"
      ? { instanceScope: parsed.instanceScope, runKey: parsed.runKey }
      : {}),
    state: row.state as JobInstanceRecord["state"],
    desiredState: row.desiredState as JobInstanceRecord["desiredState"],
    currentRunId: row.currentRunId,
    runStartedAt: row.runStartedAt,
    runTrigger: row.runTrigger as JobInstanceRecord["runTrigger"],
    runKind: row.runKind as JobInstanceRecord["runKind"],
    runOriginId: row.runOriginId ?? null,
    runScheduleId: row.runScheduleId ?? null,
    runAsyncJobId: row.runAsyncJobId ?? null,
    runWorkflowInstanceId: row.runWorkflowInstanceId ?? null,
    runDefinitionVersion: row.runDefinitionVersion ?? null,
    runProvenance: parseRunProvenance(row.runProvenanceJson),
    checkpoint: row.checkpointJson
      ? (JSON.parse(row.checkpointJson) as JobInstanceRecord["checkpoint"])
      : null,
    stageCheckpoint: row.stageCheckpointJson
      ? (JSON.parse(row.stageCheckpointJson) as JobInstanceRecord["stageCheckpoint"])
      : null,
    stageDesired: row.stageDesiredJson
      ? (JSON.parse(row.stageDesiredJson) as JobInstanceRecord["stageDesired"])
      : null,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

/** The DO-SQLite pipeline stores over a host agent's own SQLite. */
export class DoSqliteJobPipelineStores implements JobPipelineStores {
  private readonly definitionsRepo: JobDefinitionRepository;
  private readonly definitionVersionsRepo: JobDefinitionVersionRepository;
  private readonly instancesRepo: JobInstanceRepository;
  private readonly artifactsRepo: JobArtifactRepository;

  constructor(
    private readonly sql: SqlStorage,
    private readonly options: DoSqliteJobPipelineOptions = {},
  ) {
    this.definitionsRepo = new JobDefinitionRepository(sql);
    this.definitionVersionsRepo = new JobDefinitionVersionRepository(sql);
    this.instancesRepo = new JobInstanceRepository(sql);
    this.artifactsRepo = new JobArtifactRepository(sql);
  }

  private ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, "job_pipeline", [
        JOB_PIPELINE_SCHEMA_MIGRATION,
        JOB_PIPELINE_DEFINITION_VERSIONS_MIGRATION,
      ]);
    } else {
      this.sql.exec(JOB_PIPELINE_DEFINITIONS_DDL);
      this.sql.exec(JOB_PIPELINE_INSTANCES_DDL);
      this.sql.exec(JOB_PIPELINE_ARTIFACTS_DDL);
      this.sql.exec(JOB_PIPELINE_ARTIFACTS_INDEX_DDL);
      this.sql.exec(JOB_PIPELINE_DEFINITION_VERSIONS_DDL);
      this.sql.exec(JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL);
    }
    // Issue #3310 — `run_schedule_id`, added when missing so
    // existing tables upgrade in place (the probed
    // additive-column pattern from doSqliteJobRunRecordAdapter).
    // Runs in BOTH modes, after the migration / CREATE branch:
    // managed v1 is frozen at the 0046 shape (no column), legacy
    // CREATE is a no-op on existing tables, and the production
    // default is legacy (callers pass no options) — without this
    // probe an existing DO table would never gain the column and
    // instance saves would fail.
    const cols = Array.from(
      this.sql.exec(`PRAGMA table_info(${JOB_PIPELINE_INSTANCES_TABLE})`),
    ) as Array<{ name?: unknown }>;
    const names = new Set(cols.map((c) => String(c?.name ?? "")));
    if (!names.has("run_schedule_id")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_schedule_id"));
    }
    // Issue #4357 — `run_async_job_id`, the join key to the bridge
    // row that dispatched the run (same additive-column probe).
    if (!names.has("run_async_job_id")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_async_job_id"));
    }
    // Issue #4454 — `run_workflow_instance_id`, the replay proof:
    // the workflow instance that dispatched the run (same
    // additive-column probe).
    if (!names.has("run_workflow_instance_id")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_workflow_instance_id"));
    }
    // Issue #4767 — `run_kind` + `run_origin_id`, the run kind
    // and the origin run id (same additive-column probe).
    if (!names.has("run_kind")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_kind"));
    }
    if (!names.has("run_origin_id")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_origin_id"));
    }
    // Issue #5887 — `run_definition_version`, the version this run was
    // dispatched with (same additive-column probe).
    if (!names.has("run_definition_version")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_definition_version"));
    }
    // Issue #6557 — `run_provenance_json`, the broker/provider/mode facts
    // the firing schedule payload carried (same additive-column probe).
    if (!names.has("run_provenance_json")) {
      this.sql.exec(remainderAlterSql("job_pipeline_instances", "run_provenance_json"));
    }
  }

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      this.ensureSchema();
      const definitionJson = JSON.stringify(definition);
      this.definitionsRepo.save({
        jobId: definition.jobId,
        name: definition.name,
        definitionJson,
        version: definition.version,
        updatedAt: definition.updatedAt,
      });
      // Issue #5865 — append-only history: the current pointer above can be
      // overwritten, this row cannot. Same version re-saved is a no-op
      // (createOrIgnore): first write wins, so a retry never forks or rewrites it.
      this.definitionVersionsRepo.createOrIgnore({
        id: `${definition.jobId}:${definition.version}`,
        jobId: definition.jobId,
        version: definition.version,
        definitionJson,
        updatedAt: definition.updatedAt,
      });
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      this.ensureSchema();
      const row = this.definitionsRepo.findById(jobId);
      return row ? (JSON.parse(row.definitionJson) as JobDefinition) : null;
    },
    getDefinitionVersion: async (
      jobId: string,
      version: number,
    ): Promise<JobDefinition | null> => {
      this.ensureSchema();
      const row = this.definitionVersionsRepo.findById(`${jobId}:${version}`);
      return row ? (JSON.parse(row.definitionJson) as JobDefinition) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      this.ensureSchema();
      return this.definitionsRepo
        .findMany({ orderBy: "job_id ASC" })
        .map((row) => JSON.parse(row.definitionJson) as JobDefinition);
    },
  };

  readonly instances = {
    getInstance: async (
      jobId: string,
      runKey?: string | null,
    ): Promise<JobInstanceRecord | null> => {
      this.ensureSchema();
      // Issue #6555 — a run key selects one run's own row;
      // without it, the job's management row.
      const key = runKey ? jobPipelineRunInstanceId(jobId, runKey) : jobId;
      const row = this.instancesRepo.findById(key);
      return row ? rowToInstance(row) : null;
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      this.ensureSchema();
      this.instancesRepo.save(instanceToRow(record));
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      this.ensureSchema();
      this.artifactsRepo.upsert({
        id: jobPipelineArtifactId(runId, key),
        runId,
        artifactKey: key,
        valueJson: JSON.stringify(value ?? null),
      });
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      this.ensureSchema();
      const row = this.artifactsRepo.findOne({ runId, artifactKey: key });
      return row ? (JSON.parse(row.valueJson) as unknown) : null;
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      this.ensureSchema();
      return this.artifactsRepo
        .findMany({ where: { runId }, orderBy: "artifact_key ASC" })
        .map((row) => row.artifactKey);
    },
  };
}
