/**
 * Issue #3534 (Pipeline J1), ORM conformance #3548 — the D1
 * implementation of the job-pipeline stores (workflow-hosted
 * residency), built on the foundation's drizzle D1 pattern
 * (the d1AuditPolicyAdapter family): the tables are the
 * foundation's (src/data/drizzleSchema.ts; DDL authority
 * migration 0046 in src/data/migrationRunner.ts — the same
 * shapes in every residency), the schema is ensured through
 * the foundation's versioned migration runner, and all
 * query-builder sites live here, inside src/data/ — never
 * above the layer (global D-D census surface 3).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import {
  jobPipelineArtifacts,
  jobPipelineDefinitions,
  jobPipelineInstances,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0046_JOB_PIPELINE,
  type MigrationDb,
} from "./migrationRunner";
import {
  jobPipelineArtifactId,
  type JobDefinition,
  type JobInstanceRecord,
  type JobPipelineStores,
} from "./jobPipelinePorts";

/** Drizzle D1 database object carrying the job-pipeline schema. */
export type JobPipelineDb = DrizzleD1Database<{
  jobPipelineDefinitions: typeof jobPipelineDefinitions;
  jobPipelineInstances: typeof jobPipelineInstances;
  jobPipelineArtifacts: typeof jobPipelineArtifacts;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1JobPipelineDb(d1: D1Database): JobPipelineDb {
  return drizzle(d1, {
    schema: { jobPipelineDefinitions, jobPipelineInstances, jobPipelineArtifacts },
  });
}

/** Idempotent schema-ensure: applies migration 0046 if unapplied. */
export async function ensureJobPipelineSchema(db: JobPipelineDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0046_JOB_PIPELINE]);
}

type JobInstanceRow = typeof jobPipelineInstances.$inferSelect;

function instanceToRow(record: JobInstanceRecord): JobInstanceRow {
  return {
    jobId: record.jobId,
    state: record.state,
    desiredState: record.desiredState,
    currentRunId: record.currentRunId,
    runStartedAt: record.runStartedAt,
    runTrigger: record.runTrigger,
    checkpointJson: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
    stageCheckpointJson: record.stageCheckpoint ? JSON.stringify(record.stageCheckpoint) : null,
    stageDesiredJson: record.stageDesired ? JSON.stringify(record.stageDesired) : null,
    lastError: record.lastError,
    updatedAt: record.updatedAt,
  };
}

function rowToInstance(row: JobInstanceRow): JobInstanceRecord {
  return {
    jobId: row.jobId,
    state: row.state as JobInstanceRecord["state"],
    desiredState: row.desiredState as JobInstanceRecord["desiredState"],
    currentRunId: row.currentRunId,
    runStartedAt: row.runStartedAt,
    runTrigger: row.runTrigger as JobInstanceRecord["runTrigger"],
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

/** The D1 pipeline stores over the shared AgentDB binding. */
export class D1JobPipelineStores implements JobPipelineStores {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: JobPipelineDb) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureJobPipelineSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      await this.ensure();
      const row = {
        jobId: definition.jobId,
        name: definition.name,
        definitionJson: JSON.stringify(definition),
        version: definition.version,
        updatedAt: definition.updatedAt,
      };
      await this.db
        .insert(jobPipelineDefinitions)
        .values(row)
        .onConflictDoUpdate({
          target: jobPipelineDefinitions.jobId,
          set: {
            name: row.name,
            definitionJson: row.definitionJson,
            version: row.version,
            updatedAt: row.updatedAt,
          },
        });
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      await this.ensure();
      const rows = await this.db
        .select()
        .from(jobPipelineDefinitions)
        .where(eq(jobPipelineDefinitions.jobId, jobId))
        .limit(1);
      return rows.length ? (JSON.parse(rows[0].definitionJson) as JobDefinition) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      await this.ensure();
      const rows = await this.db
        .select()
        .from(jobPipelineDefinitions)
        .orderBy(asc(jobPipelineDefinitions.jobId));
      return rows.map((r) => JSON.parse(r.definitionJson) as JobDefinition);
    },
  };

  readonly instances = {
    getInstance: async (jobId: string): Promise<JobInstanceRecord | null> => {
      await this.ensure();
      const rows = await this.db
        .select()
        .from(jobPipelineInstances)
        .where(eq(jobPipelineInstances.jobId, jobId))
        .limit(1);
      return rows.length ? rowToInstance(rows[0]) : null;
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      await this.ensure();
      const row = instanceToRow(record);
      await this.db
        .insert(jobPipelineInstances)
        .values(row)
        .onConflictDoUpdate({
          target: jobPipelineInstances.jobId,
          set: {
            state: row.state,
            desiredState: row.desiredState,
            currentRunId: row.currentRunId,
            runStartedAt: row.runStartedAt,
            runTrigger: row.runTrigger,
            checkpointJson: row.checkpointJson,
            stageCheckpointJson: row.stageCheckpointJson,
            stageDesiredJson: row.stageDesiredJson,
            lastError: row.lastError,
            updatedAt: row.updatedAt,
          },
        });
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      await this.ensure();
      const row = {
        id: jobPipelineArtifactId(runId, key),
        runId,
        artifactKey: key,
        valueJson: JSON.stringify(value ?? null),
      };
      await this.db
        .insert(jobPipelineArtifacts)
        .values(row)
        .onConflictDoUpdate({
          target: jobPipelineArtifacts.id,
          set: { valueJson: row.valueJson },
        });
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      await this.ensure();
      const rows = await this.db
        .select()
        .from(jobPipelineArtifacts)
        .where(
          and(eq(jobPipelineArtifacts.runId, runId), eq(jobPipelineArtifacts.artifactKey, key)),
        )
        .limit(1);
      return rows.length ? (JSON.parse(rows[0].valueJson) as unknown) : null;
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      await this.ensure();
      const rows = await this.db
        .select({ artifactKey: jobPipelineArtifacts.artifactKey })
        .from(jobPipelineArtifacts)
        .where(eq(jobPipelineArtifacts.runId, runId))
        .orderBy(asc(jobPipelineArtifacts.artifactKey));
      return rows.map((r) => r.artifactKey);
    },
  };
}
