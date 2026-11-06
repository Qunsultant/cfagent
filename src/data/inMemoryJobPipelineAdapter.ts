/**
 * Issue #3534 (Pipeline J1), ORM conformance #3548 — the
 * in-memory implementation of the job-pipeline stores: the
 * test double every engine/control test runs against, built
 * on the foundation's InMemoryRepository (the conformance
 * twin of the DO Repository core — same create/update/upsert
 * semantics, same ordering rules). Definitions, instances,
 * and artifacts persist as the same flat row shapes the SQL
 * residencies store (JSON in text columns), so a value read
 * back is a fresh parse in every residency — the incumbent
 * adapters' deep-clone semantics, by construction.
 * Constructed explicitly by its users (tests, local
 * development) — never as a silent production fallback.
 */
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import type {
  jobPipelineArtifacts,
  jobPipelineDefinitions,
  jobPipelineInstances,
} from "./drizzleSchema";
import {
  JOB_PIPELINE_ARTIFACTS_TABLE,
  JOB_PIPELINE_DEFINITIONS_TABLE,
  JOB_PIPELINE_INSTANCES_TABLE,
  jobPipelineArtifactId,
  type JobDefinition,
  type JobInstanceRecord,
  type JobPipelineStores,
} from "./jobPipelinePorts";

type JobDefinitionRow = typeof jobPipelineDefinitions.$inferSelect;
type JobInstanceRow = typeof jobPipelineInstances.$inferSelect;
type JobArtifactRow = typeof jobPipelineArtifacts.$inferSelect;

class JobDefinitionMemoryRepository extends InMemoryRepository<JobDefinitionRow> {
  constructor() {
    super(JOB_PIPELINE_DEFINITIONS_TABLE, "jobId");
  }

  save(row: JobDefinitionRow): void {
    if (this.findById(row.jobId)) this.update(row.jobId, row);
    else this.create(row);
  }
}

class JobInstanceMemoryRepository extends InMemoryRepository<JobInstanceRow> {
  constructor() {
    super(JOB_PIPELINE_INSTANCES_TABLE, "jobId");
  }

  save(row: JobInstanceRow): void {
    if (this.findById(row.jobId)) this.update(row.jobId, row);
    else this.create(row);
  }
}

class JobArtifactMemoryRepository extends InMemoryRepository<JobArtifactRow> {
  constructor() {
    super(JOB_PIPELINE_ARTIFACTS_TABLE, "id");
  }
}

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

export class InMemoryJobPipelineStores implements JobPipelineStores {
  private readonly definitionsRepo = new JobDefinitionMemoryRepository();
  private readonly instancesRepo = new JobInstanceMemoryRepository();
  private readonly artifactsRepo = new JobArtifactMemoryRepository();

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      this.definitionsRepo.save({
        jobId: definition.jobId,
        name: definition.name,
        definitionJson: JSON.stringify(definition),
        version: definition.version,
        updatedAt: definition.updatedAt,
      });
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      const row = this.definitionsRepo.findById(jobId);
      return row ? (JSON.parse(row.definitionJson) as JobDefinition) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      return this.definitionsRepo
        .findMany({ orderBy: "job_id ASC" })
        .map((row) => JSON.parse(row.definitionJson) as JobDefinition);
    },
  };

  readonly instances = {
    getInstance: async (jobId: string): Promise<JobInstanceRecord | null> => {
      const row = this.instancesRepo.findById(jobId);
      return row ? rowToInstance(row) : null;
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      this.instancesRepo.save(instanceToRow(record));
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      this.artifactsRepo.upsert({
        id: jobPipelineArtifactId(runId, key),
        runId,
        artifactKey: key,
        valueJson: JSON.stringify(value ?? null),
      });
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      const row = this.artifactsRepo.findOne({ runId, artifactKey: key });
      return row ? (JSON.parse(row.valueJson) as unknown) : null;
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      return this.artifactsRepo
        .findMany({ where: { runId }, orderBy: "artifact_key ASC" })
        .map((row) => row.artifactKey);
    },
  };
}

/** Build a fresh in-memory store triple (one per test / host). */
export function createInMemoryJobPipelineStores(): JobPipelineStores {
  const stores = new InMemoryJobPipelineStores();
  return {
    definitions: stores.definitions,
    instances: stores.instances,
    artifacts: stores.artifacts,
  };
}
