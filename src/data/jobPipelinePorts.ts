/**
 * Issue #3534 (Pipeline J1) — the job-pipeline data-layer PORT:
 * the recursive job model, the externalized per-job configuration
 * shape, and the three store surfaces every pipeline stage
 * (J2–J6) persists through. This module carries types and store
 * interfaces ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteJobPipelineAdapter.ts (DO SQLite, agent-hosted),
 * d1JobPipelineAdapter.ts (D1, workflow-hosted), and
 * inMemoryJobPipelineAdapter.ts (test double). All storage-shaped
 * calls live in those adapters — never above this layer (global
 * D-D census, #2356).
 *
 * The job model is ONE recursive shape: a job, its sub-jobs, a
 * stage, and its sub-stages are all `JobNodeConfig` — a node has a
 * kind, its own steps, and children of the same shape. There is no
 * separate stage class to keep in sync.
 *
 * Run HISTORY is deliberately not a store here: terminal run
 * records go through the platform run-record machinery
 * (src/data/jobRunRecordPorts.ts — the #2964/#3121 store #3527
 * builds on) with system "job-pipeline". This port owns only what
 * that machinery does not: definitions, live instance state,
 * checkpoints, and persisted step hand-off artifacts.
 *
 * Persisted hand-offs are the default: a step's output is written
 * to the artifact store and the next step reads it back. The
 * in-memory processing option exists in configuration
 * (`processing.inMemory`) and defaults OFF; it is the engine's
 * explicit, configured choice, never an accident of wiring.
 */

/** DO-SQLite / D1 table names for the pipeline job stores. */
export const JOB_PIPELINE_DEFINITIONS_TABLE = "job_pipeline_definitions";
export const JOB_PIPELINE_INSTANCES_TABLE = "job_pipeline_instances";
export const JOB_PIPELINE_ARTIFACTS_TABLE = "job_pipeline_artifacts";

/** How a node's children and shards fan out. */
export type JobConcurrencyMode = "sequential" | "parallel";
/** batch = all input items in one pass; online = item-by-item as a stream. */
export type JobPacingMode = "batch" | "online";
/** sync = the dispatcher awaits the terminal state; async = it returns a run handle. */
export type JobDeliveryMode = "sync" | "async";
/** monolith = one execution unit; sharded = one unit per configured shard key. */
export type JobShapeMode = "monolith" | "sharded";

/** The four execution-mode axes, resolved from configuration at dispatch. */
export interface JobExecutionMode {
  concurrency: JobConcurrencyMode;
  pacing: JobPacingMode;
  delivery: JobDeliveryMode;
  shape: JobShapeMode;
}

/** Conservative default trajectory: one unit, in order, all items, async dispatch. */
export const DEFAULT_JOB_EXECUTION_MODE: JobExecutionMode = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "async",
  shape: "monolith",
};

/** A node's own schedule. Meaningful on any node: sub-jobs are individually schedulable. */
export interface JobScheduleConfig {
  enabled: boolean;
  /** Cron expression (platform scheduler grammar). */
  cron?: string;
  /** Interval grammar string (e.g. "every 30 minutes"). */
  interval?: string;
}

export interface JobInputsConfig {
  /** Named sources to read (e.g. "nasdaq100", "yahoo-fundamentals"). */
  sources?: string[];
  /** Named persisted datasets to read. */
  datasets?: string[];
  /** Inline input items (the batch/online stream the steps process). */
  items?: unknown[];
}

export interface JobProcessingConfig {
  /** In-memory hand-offs instead of persisted artifacts. Default OFF. */
  inMemory?: boolean;
  /** Persist a checkpoint after every N steps (default 1). */
  checkpointEverySteps?: number;
  /** Shard keys for the sharded execution shape. */
  shards?: string[];
}

export interface JobOutputsConfig {
  reports?: string[];
  formats?: string[];
  channels?: string[];
}

/** One configured step invocation: a name into the platform step library plus data. */
export interface JobStepConfig {
  step: string;
  params?: Record<string, unknown>;
}

/**
 * The recursive node: job / sub-job / stage / sub-stage. Every
 * field is configuration data — a job is defined by a value of
 * this shape alone, with no job code.
 */
export interface JobNodeConfig {
  /** Stage/job kind (e.g. "feed", "enrich", "analyze", "generate", "deliver", or any host kind). */
  kind: string;
  steps?: JobStepConfig[];
  children?: JobNodeConfig[];
  inputs?: JobInputsConfig;
  processing?: JobProcessingConfig;
  outputs?: JobOutputsConfig;
  /** Per-node execution-mode overrides, merged over the job's resolved mode. */
  executionMode?: Partial<JobExecutionMode>;
  schedule?: JobScheduleConfig;
}

/** The fully-defaulted configuration a run executes under (resolved at define/configure time, re-read at run start). */
export interface ResolvedJobConfig {
  inputs: { sources: string[]; datasets: string[]; items: unknown[] };
  processing: { inMemory: boolean; checkpointEverySteps: number; shards: string[] };
  outputs: { reports: string[]; formats: string[]; channels: string[] };
  executionMode: JobExecutionMode;
  schedule: JobScheduleConfig;
}

/** A stored job definition: the recursive root, its raw configuration, and its resolved form. */
export interface JobDefinition {
  jobId: string;
  name: string;
  root: JobNodeConfig;
  /** The externalized configuration exactly as supplied (patches merge into this). */
  rawConfig: unknown;
  config: ResolvedJobConfig;
  version: number;
  updatedAt: string;
}

/** Live management state of a job (the run-record store holds only terminal history). */
export type JobRunState =
  | "idle"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** A control-plane request the engine honors at the next step boundary. */
export type JobDesiredState = "none" | "pause" | "cancel";

/**
 * The persisted resume cursor. `nodePath` is the child-index path
 * of the node in progress ("" = the root, "0/2" = root → child 0 →
 * child 2); the indices say where inside that node execution
 * stopped. Under parallel fan-out a checkpoint is written at
 * segment boundaries and an in-flight segment resumes from its
 * start — steps are idempotent at their boundaries by contract.
 */
export interface JobCheckpoint {
  runId: string;
  nodePath: string;
  /** The run's scope root ("" = the whole job; a sub-path for an individually scheduled sub-job). */
  scopePath: string;
  stepIndex: number;
  itemIndex: number;
  shardIndex: number;
  childIndex: number;
  artifactKeys: string[];
  updatedAt: string;
}

/** One job's live instance record (management state + checkpoint). */
export interface JobInstanceRecord {
  jobId: string;
  state: JobRunState;
  desiredState: JobDesiredState;
  currentRunId: string | null;
  runStartedAt: string | null;
  /** How the live/last run was triggered (stamped onto its terminal run record). */
  runTrigger: "scheduled" | "manual" | null;
  checkpoint: JobCheckpoint | null;
  lastError: string | null;
  updatedAt: string;
}

/** Job definitions as data: save / read / list. */
export interface JobDefinitionStore {
  saveDefinition(definition: JobDefinition): Promise<void>;
  getDefinition(jobId: string): Promise<JobDefinition | null>;
  listDefinitions(): Promise<JobDefinition[]>;
}

/** Live instance state and checkpoints. */
export interface JobInstanceStore {
  getInstance(jobId: string): Promise<JobInstanceRecord | null>;
  saveInstance(record: JobInstanceRecord): Promise<void>;
}

/** Persisted step hand-offs, scoped by run. Values are JSON-shaped data. */
export interface JobArtifactStore {
  putArtifact(runId: string, key: string, value: unknown): Promise<void>;
  getArtifact(runId: string, key: string): Promise<unknown>;
  listArtifactKeys(runId: string): Promise<string[]>;
}

/** The three pipeline stores, always composed together. */
export interface JobPipelineStores {
  definitions: JobDefinitionStore;
  instances: JobInstanceStore;
  artifacts: JobArtifactStore;
}
