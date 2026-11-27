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
 *
 * The adapters are the CDO data foundation's ORM families
 * (#3548): the pipeline tables are declared in the foundation's
 * Drizzle schema (src/data/drizzleSchema.ts) with versioned
 * migrations, the DO adapter rides the foundation's Repository
 * core, the D1 adapter the foundation's drizzle D1 pattern, and
 * the in-memory adapter the foundation's InMemoryRepository.
 */

import type { StageRetryBucket, StageRunnerCheckpoint } from "../workflows/stageRunnerPorts";
import type {
  JobRunKind,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";

/** DO-SQLite / D1 table names for the pipeline job stores. */
export const JOB_PIPELINE_DEFINITIONS_TABLE = "job_pipeline_definitions";
export const JOB_PIPELINE_INSTANCES_TABLE = "job_pipeline_instances";
export const JOB_PIPELINE_ARTIFACTS_TABLE = "job_pipeline_artifacts";

/**
 * The artifacts table's surrogate primary key for one (run,
 * artifact key) pair — the single-column id the foundation's
 * Repository core addresses, shared by every residency's
 * adapter so the row shape is identical everywhere. The
 * separator is a control character that cannot appear in run
 * ids or artifact keys the engine composes.
 */
export function jobPipelineArtifactId(runId: string, artifactKey: string): string {
  return `${runId}\u0001${artifactKey}`;
}

/**
 * Issue #6555 — what a job's live instance row is scoped to.
 * "job" is the job's single management row (the historical
 * shape: one run per jobId). "run" is one run's own row in
 * run-per-row mode, keyed by (jobId, runKey).
 */
export type JobInstanceScope = "job" | "run";

/**
 * Issue #6555 — the store key of one run's own instance row:
 * the job id, the run marker, and the run's dedup key, joined
 * by the unit separator (the same composite-key precedent as
 * `jobPipelineArtifactId`). Job ids and run keys never contain
 * U+0001, so the key parses back unambiguously.
 */
export function jobPipelineRunInstanceId(jobId: string, runKey: string): string {
  return `${jobId}\u0001run\u0001${runKey}`;
}

/** Parse a stored instance key back into its job, scope, and run key. */
export function parseJobPipelineInstanceId(key: string): {
  jobId: string;
  instanceScope: JobInstanceScope;
  runKey: string | null;
} {
  const marker = "\u0001run\u0001";
  const idx = key.indexOf(marker);
  if (idx === -1) return { jobId: key, instanceScope: "job", runKey: null };
  return {
    jobId: key.slice(0, idx),
    instanceScope: "run",
    runKey: key.slice(idx + marker.length),
  };
}

/** How a node's children and shards fan out. */
export type JobConcurrencyMode = "sequential" | "parallel";
/** batch = all input items in one pass; online = item-by-item as a stream. */
export type JobPacingMode = "batch" | "online";
/** sync = the dispatcher awaits the terminal state; async = it returns a run handle. */
export type JobDeliveryMode = "sync" | "async";
/** monolith = one execution unit; sharded = one unit per configured shard key. */
export type JobShapeMode = "monolith" | "sharded";
/** durable = persistent DO/D1 checkpoints (default); in-memory = explicit opt-in ephemeral execution (#5282). */
export type JobDurabilityMode = "durable" | "in-memory";

/** Named ephemeral guarantee contract for opt-in in-memory stage execution (#5282). */
export const EPHEMERAL_GUARANTEE_CONTRACT = {
  durability: "in-memory",
  durable: false,
  resumable: false,
  checkpointSurvivesRestart: false,
  journalReuse: false,
  optInOnly: true,
} as const;

/** The execution-mode axes, resolved from configuration at dispatch. */
export interface JobExecutionMode {
  concurrency: JobConcurrencyMode;
  pacing: JobPacingMode;
  delivery: JobDeliveryMode;
  shape: JobShapeMode;
  durability?: JobDurabilityMode;
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
  /**
   * The schedule mechanism's registration identity, recorded when
   * the stage is scheduled through the control plane (#3069
   * schedule: identity + reason are recorded at creation and
   * surfaced on the run). Absent = declared in configuration but
   * not registered through the control plane.
   */
  registrationId?: string;
  /** Why the stage was scheduled (operator/agent-supplied, recorded at creation). */
  reason?: string;
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
  /**
   * Issue #6396 — the step's own retry bucket, when its retry economics differ
   * from its stage's. A bucket name into the ONE pipeline policy
   * (`RETRY_BUCKET_NAMES`), never a second list; absent ⇒ the stage's bucket,
   * exactly as before. The analyze step is the case that proves it: retrying
   * one cheap fetch and retrying a whole awaited agent turn are opposite
   * economics inside one stage.
   */
  retry?: { bucket?: string };
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
  /**
   * Per-node stage deadline, in milliseconds (#4775 S1). Wins over
   * the env-resolved global stage default (resolveStageTimeoutMs);
   * absent, the default applies, clamped to the run deadline
   * whenever one applies (feed jobs). Must be a positive finite
   * number — anything else is refused by name at resolve time.
   */
  timeoutMs?: number;
  /**
   * Per-node fan-out cap for a parallel stage (#4781 S2). Wins
   * over DEFAULT_MAX_PARALLEL_SHARDS (4); absent, the default
   * applies. Sequential stages ignore it. Must be a positive
   * integer — anything else is refused by name at resolve time.
   */
  maxParallel?: number;
  /**
   * Per-node retry bucket (#4781 S2). Wins over the per-kind
   * table (STAGE_RETRY_BUCKET) for chain kinds and over
   * "report" for job stages. Must be one of the pipelinePolicy
   * retry keys — anything else is refused by name at resolve
   * time, because an unknown bucket would throw a TypeError
   * mid-run on budget.maxAttempts.
   */
  retryBucket?: StageRetryBucket;
  schedule?: JobScheduleConfig;
  /**
   * Retired (#3944): the stage never executes again in any run
   * of this job. Set only by the retire operation (persisted on
   * the definition, versioned like a schedule change); a new
   * dispatch of a job carrying a retired stage refuses by name,
   * and a live run reaching the stage settles cancelled with the
   * stage named — downstream never proceeds.
   */
  retired?: boolean;
}

/** The fully-defaulted configuration a run executes under (resolved at define/configure time, re-read at run start). */
export interface ResolvedJobConfig {
  inputs: { sources: string[]; datasets: string[]; items: unknown[] };
  processing: { inMemory: boolean; checkpointEverySteps: number; shards: string[] };
  outputs: { reports: string[]; formats: string[]; channels: string[] };
  executionMode: JobExecutionMode;
  schedule: JobScheduleConfig;
  /**
   * Issue #6555 — what the live instance row is scoped to.
   * "job" (default): one run per jobId, the historical guard.
   * "run": run-per-row mode — concurrent submissions of the
   * definition each get their own run and instance row.
   * Resolved from the definition's top-level `instanceScope`
   * field; not an execution-mode axis (#4772 pins exactly
   * four axes), it is a dispatch property of the definition.
   */
  instanceScope: JobInstanceScope;
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

/**
 * Issue #6557 — the four provenance facts one run's terminal record
 * carries (#3655): which broker, which data provider, which mode, and
 * which resolver leg decided the mode. Every field is nullable and an
 * explicit null is a recorded fact ("the firing payload named none"),
 * never an absent column — the same "never backfilled, never guessed"
 * rule the #3655 fields state.
 */
export interface JobRunProvenance {
  brokerId: string | null;
  dataProviderId: string | null;
  mode: "live" | "paper" | null;
  modeSource: "pin" | "selection" | "inference" | null;
}

/**
 * Issue #6584 — the ONE field rule for a provenance carrier, whichever
 * shape it arrives in: a workflow payload object (#6584) or the
 * instance's stored JSON (#6557). A non-object reads as null; an object
 * reads as all four fields, with an explicit null for every fact it did
 * not name. Never a half-parsed object, never an inferred value.
 */
export function normalizeRunProvenance(
  value: unknown,
): JobRunProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const carrier = value as Record<string, unknown>;
  const text = (field: unknown): string | null =>
    typeof field === "string" && field.length > 0 ? field : null;
  const mode =
    carrier.mode === "live" || carrier.mode === "paper" ? carrier.mode : null;
  const modeSource =
    carrier.modeSource === "pin" ||
    carrier.modeSource === "selection" ||
    carrier.modeSource === "inference"
      ? carrier.modeSource
      : null;
  return {
    brokerId: text(carrier.brokerId),
    dataProviderId: text(carrier.dataProviderId),
    mode,
    modeSource,
  };
}

/**
 * Issue #6557 — parse the instance's provenance carrier. Unknown or
 * malformed values read as null (an explicit "the payload named none"),
 * never as an inferred fact: the carrier is written by this module's own
 * serializer and read by three residencies, so a shape drift must fail
 * closed rather than leak a half-parsed object into a run record.
 */
export function parseRunProvenance(
  raw: string | null | undefined,
): JobRunProvenance | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeRunProvenance(parsed);
}

/** One job's live instance record (management state + checkpoint). */
export interface JobInstanceRecord {
  jobId: string;
  /**
   * Issue #6555 — the row's scope. "job" (or absent, the
   * historical shape) is the job's single management row;
   * "run" is one run's own row in run-per-row mode, keyed by
   * (jobId, runKey) and stored under the composite key.
   */
  instanceScope?: JobInstanceScope;
  /**
   * Issue #6555 — the run this row belongs to, in run-per-row
   * mode: the submission's dedup key (the dispatching async
   * job id when one dispatched the run, else the run id).
   * Null/absent on management rows.
   */
  runKey?: string | null;
  state: JobRunState;
  desiredState: JobDesiredState;
  currentRunId: string | null;
  runStartedAt: string | null;
  /** How the live/last run was triggered (stamped onto its terminal run record). */
  runTrigger: "scheduled" | "manual" | "triggered" | "copilot" | "autopilot" | null;
  /**
   * The schedule id that dispatched the live/last run (stamped onto
   * its terminal run record, #3310). Null when the run was not
   * dispatched by a schedule — an explicit null, never a laundered
   * id. Persisted on the instance (same class of fact as
   * `runTrigger`): cancel/settle paths stamp the id of the run
   * they settle, so it must survive the dispatching process.
   */
  runScheduleId: string | null;
  /**
   * The async job id that dispatched the live/last run (stamped onto
   * its terminal run record, #4357 — the join key that links the
   * engine D1 record to the bridge row that dispatched it). Null
   * when no async job dispatched the run — an explicit null, never
   * a laundered id. Persisted on the instance (same class of fact
   * as `runScheduleId`): cancel/settle paths stamp the id of the
   * run they settle, so it must survive the dispatching process.
   */
  runAsyncJobId: string | null;
  /**
   * The workflow instance id that dispatched the live/last run
   * (#4454 — the replay proof: a replayed workflow flow resumes
   * a still-`running` instance only when the recorded id matches
   * the replaying workflow instance's own id). Null when no
   * workflow instance dispatched the run — an explicit null,
   * never a laundered id. Persisted on the instance (same class
   * of fact as `runAsyncJobId`): the replay runs in a new
   * process, so the proof must survive the dispatching process.
   */
  runWorkflowInstanceId: string | null;
  /**
   * Issue #4767 — the kind of the live/last run (what this
   * execution IS relative to the original: original / re-run /
   * resume / replay), stamped onto its terminal run record.
   * Required but nullable, like `runTrigger`: a run whose kind
   * cannot be proven is null, never an invented kind.
   */
  runKind: JobRunKind | null;
  /**
   * Issue #4767 — the run this execution retried (re-run) or the
   * run itself (resume/replay, same run id). Null for a first
   * dispatch — an explicit null, never an invented link.
   * Persisted on the instance (same class of fact as
   * `runScheduleId`): cancel/settle paths stamp the id of the
   * run they settle, so it must survive the dispatching process.
   */
  runOriginId: string | null;
  /**
   * Issue #5887 — the definition version this run was dispatched with,
   * captured at dispatch (never re-read at settle: a reconfigure during
   * the run must not change what the run records it used). Null on a
   * row written before the column existed.
   */
  runDefinitionVersion?: number | null;
  /**
   * Issue #6557 — the broker/provider/mode provenance this run executed
   * under, captured at dispatch from the firing schedule payload (owner
   * decision 2026-11-25: the payload is the ONLY source). Null on every
   * other dispatch — manual, retried, replayed, re-run — never an
   * inferred value. Persisted on the instance (same class of fact as
   * `runScheduleId`): the settle path can be a different process, and
   * the terminal record's #3655 fields must survive it.
   */
  runProvenance?: JobRunProvenance | null;
  checkpoint: JobCheckpoint | null;
  /**
   * The run's stage-runner checkpoint (#3549): one entry per
   * (stage, unit) the current run has planned, in the stage
   * contract's own shape — the ledger the runner's plan decisions
   * (planNext / resumeUnits / fan-out) read, persisted through
   * the StageCheckpointStore adapter
   * (src/data/jobPipelineStageCheckpoint.ts). Survives terminal
   * run states so stage control can address the last run's
   * stages; a new dispatch replaces it with the new run's ledger.
   */
  stageCheckpoint: StageRunnerCheckpoint | null;
  /**
   * Per-stage control requests the engine honors at that stage's
   * next boundary (#3069 stop/cancel, #3944 retire, addressed by
   * stage id): stage id → requested action. Cleared when honored
   * or when a new run dispatches.
   */
  stageDesired: Record<string, "pause" | "cancel" | "retire"> | null;
  lastError: string | null;
  updatedAt: string;
}

/** Job definitions as data: save / read / list. */
export interface JobDefinitionStore {
  saveDefinition(definition: JobDefinition): Promise<void>;
  getDefinition(jobId: string): Promise<JobDefinition | null>;
  /**
   * Issue #5865 — one historical version of a job's definition, or null.
   * Append-only history: a version is never rewritten, so a resolved
   * version is exactly what a run dispatched with it used.
   */
  getDefinitionVersion(jobId: string, version: number): Promise<JobDefinition | null>;
  listDefinitions(): Promise<JobDefinition[]>;
}

/** Live instance state and checkpoints. */
export interface JobInstanceStore {
  /**
   * The job's management row (runKey absent), or one run's own
   * row in run-per-row mode (runKey = the run's dedup key,
   * #6555). A runKey lookup that finds no row reads as null —
   * the honest "no such run" state.
   */
  getInstance(jobId: string, runKey?: string | null): Promise<JobInstanceRecord | null>;
  saveInstance(record: JobInstanceRecord): Promise<void>;
  /**
   * Issue #3992 — atomically claim the instance row for a fresh
   * dispatch: write `record` iff no live run holds the row
   * (absent row, or a state outside queued/running/paused).
   * Returns true iff this caller claimed. The dispatch guard's
   * check-then-write across awaits let concurrent dispatches
   * both pass; the claim is the single conditional write that
   * closes that window in every residency.
   */
  claimInstance(record: JobInstanceRecord): Promise<boolean>;
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
