/**
 * Issue #3534 (Pipeline J1) — the job-pipeline engine and control
 * plane, re-based on the platform's stage runner (#3549,
 * absorbing #3069: one engine). The control plane is the ONE
 * management surface the UX and the copilot doors consume
 * (#3514's uniformity contract): define / configure / run /
 * pause / resume / cancel / retry / status at job granularity,
 * and the uniform stage control — run / re-run / stop / resume /
 * cancel / schedule / re-schedule — at (runId, stageId)
 * granularity, with #3069's pinned meanings.
 *
 * Execution is a DRIVER over the stage-runner contract
 * (src/workflows/stageRunnerPorts.ts + stageRunnerPlan.ts), not
 * a parallel stage machine: each node of the configured job
 * tree compiles to a one-stage StageRunnerPlan (stage id
 * `job:<nodePath>`); the runner's plan decisions — planRun
 * validation, planNext, resumeUnits' rule (a completed unit is
 * never re-run), planStageFanout at stageMaxParallel, retry
 * budgets resolved from pipelinePolicy by
 * resolveStageRetryBudget, per-unit deadlines — decide what
 * executes. The run's checkpoint IS a StageRunnerCheckpoint,
 * persisted through the StageCheckpointStore port
 * (src/data/jobPipelineStageCheckpoint.ts); a unit's output is
 * persisted BEFORE its checkpoint entry completes, and the
 * transition is published after — persist → checkpoint →
 * publish, the #2869 stage contract's order, with the stage's
 * claim key (stageIdempotencyKey) carried on the event. The
 * engine retains only what the stage machine lacks: the
 * recursive job definition model, per-job externalized
 * configuration, schedule registration of configured job
 * trees, and this control surface.
 *
 * A node's own steps run as its stage's unit work (their
 * output is the node's hand-off), then its children —
 * sequentially (output chains child to child) or in parallel
 * (every child receives the node's output; outputs collect in
 * order). The execution mode comes from configuration,
 * resolved per node at dispatch:
 *  - pacing batch: a step sees the full item list in one call;
 *    online: a step is invoked per item and each item's output
 *    chains to the same item of the next step (declared on the
 *    stage plan as the contract's pacing axis).
 *  - shape monolith: one execution unit; sharded: one unit
 *    per configured shard key (a sharded node with no shard
 *    keys configured is a named refusal).
 *  - delivery sync/async shapes only the dispatch contract.
 *
 * Stop/pause are cooperative: the control plane records the
 * desired state (run-level, or per-stage in stageDesired);
 * the engine honors it at the next step boundary, records the
 * in-flight unit as stopped with its intra-unit progress on
 * its checkpoint entry, and unwinds — a stopped stage is
 * resumable and never recorded as failed. Cancel is terminal:
 * the in-flight unit and every outstanding unit are recorded
 * cancelled, and downstream stages never proceed. Resume
 * re-reads the definition (configuration is read at run
 * start) and continues under the runner's decisions: completed
 * stages/units are read back from their persisted hand-offs,
 * never re-executed; the stopped unit continues from its
 * recorded progress.
 *
 * Honest limits, stated once: in-memory processing
 * (processing.inMemory) keeps hand-offs in the run's process
 * memory, so a resume in a NEW process re-executes nodes whose
 * outputs were never persisted — that volatility is exactly
 * why persisted hand-offs are the default. A unit past its
 * stage deadline is recorded timed_out and the run fails; the
 * underlying step promise is not cancellable, so its late
 * writes may still land (the workflow substrate's deadline
 * sweep has the same shape). Stage actions (runStage and
 * friends) execute inline on the caller's dispatch; hosts
 * needing an async boundary dispatch runJob or the workflow.
 */
import type {
  JobCheckpoint,
  JobDefinition,
  JobExecutionMode,
  JobInstanceRecord,
  JobNodeConfig,
  JobPipelineStores,
  JobRunState,
  JobScheduleConfig,
} from "../data/jobPipelinePorts";
import type {
  JobRunRecord,
  JobRunRecordStore,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";
import { createJobPipelineStageCheckpointStore } from "../data/jobPipelineStageCheckpoint";
import { buildJobRunRecord } from "./jobRunRecords";
import {
  JobPipelineError,
  assertExecutionModeSupported,
  mergeJobConfigPatch,
  resolveExecutionMode,
  resolveJobDefinition,
} from "./jobPipelineConfig";
import type { JobStepContext, JobStepRegistry } from "./jobPipelineSteps";
import { publishJobStatus, publishStageAction } from "./jobPipelineEvents";
import type { MessagePublisher, StageName } from "../messaging/messagingPorts";
import {
  resolvePipelinePolicy,
  type PipelinePolicy,
} from "./pipelinePolicy";
import { computeBackoffDelayMs } from "./resilience";
import {
  DEFAULT_STAGE_TIMEOUT_MS,
  isJobStageId,
  jobStageId,
  resolveStageRetryBudget,
  stageMaxParallel,
  STAGE_RETRY_BUCKET,
  RUNNER_STAGE_FOR_PIPELINE_STAGE,
  runnerStageForPipelineStage,
  type StageCheckpointStore,
  type StageRunnerCheckpoint,
  type StageRunnerInvocation,
  type StageRunnerPlan,
  type StageRunnerStage,
  type StageUnitCheckpoint,
} from "../workflows/stageRunnerPorts";
import {
  fanoutCapExceeded,
  planNext,
  planRun,
  planStageFanout,
} from "../workflows/stageRunnerPlan";
import type { PipelineStage } from "../types";

/**
 * The async seam the engine consumes run records through. The
 * platform store (JobRunRecordStore) is synchronous because DO
 * SQLite is synchronous; this seam wraps it (and the D1 adapter)
 * without inventing a second store or record shape.
 */
export interface JobRunRecorder {
  recordRun(record: JobRunRecord): Promise<void>;
  listRuns(jobId: string, limit?: number): Promise<JobRunRecord[]>;
  latestRun(jobId: string): Promise<JobRunRecord | undefined>;
}

/** Wrap the platform's synchronous run-record store in the async seam. */
export function jobRunRecorderFromStore(store: JobRunRecordStore): JobRunRecorder {
  return {
    recordRun: async (record) => {
      store.record(record);
    },
    listRuns: async (jobId, limit) => store.listByJob(jobId, limit),
    latestRun: async (jobId) => store.latestByJob(jobId),
  };
}

/**
 * The journal seam: on the workflow substrate each step
 * invocation is wrapped in step.do (journaled, replay-safe); in
 * direct execution the journal is the identity. Checkpointing to
 * the instance store happens regardless — the journal makes
 * workflow replay cheap, the checkpoint makes any resume exact.
 */
export interface JobStepJournal {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const identityJobStepJournal: JobStepJournal = {
  do: async (_name, fn) => fn(),
};

/** Default sleep: a real timer that never holds the process open on its own. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer?.unref?.();
  });

export interface JobPipelineDeps {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
  /**
   * Optional settle observer (#3530 slice B): invoked once per
   * terminally settled run from recordTerminal — the engine's one
   * terminal-recording point — so every trigger class (manual,
   * scheduled, resume, retry, cancel) is covered by construction.
   * Best-effort by contract: the engine guards the call, so an
   * observer failure can never fail, retry, or duplicate the
   * run's own records; observers log their own failures.
   */
  runSettledObserver?: (info: JobRunSettledInfo) => Promise<void> | void;
  /** Null when the queue substrate is unconfigured: runs proceed, status publication is skipped, store state remains the truth. */
  publisher: MessagePublisher | null;
  steps: JobStepRegistry;
  journal?: JobStepJournal;
  now?: () => Date;
  newRunId?: () => string;
  /**
   * The resolved pipeline policy (retry budgets, resolved once
   * here — the stage contract's one resolution). Defaults to
   * resolvePipelinePolicy() with no env/settings overrides.
   */
  policy?: PipelinePolicy;
  /** Sleep for retry backoff and unit deadlines. Defaults to a real (unref'd) timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The stage-runner invocation this host drives (the contract's driver kind). Defaults to "sync". */
  invocation?: StageRunnerInvocation;
  /** The schedule host stage scheduling registers with. registerSchedules takes its host explicitly; scheduleStage falls back to this. */
  scheduleHost?: JobScheduleHost;
}

export interface JobDispatchResult {
  jobId: string;
  runId: string;
  /** For sync delivery: the terminal (or paused) state. For async: the state at dispatch. */
  state: JobRunState;
  /** Async delivery only: resolves with the run's outcome when it settles. */
  completion?: Promise<JobRunOutcome>;
}

export interface JobRunOutcome {
  jobId: string;
  runId: string;
  state: JobRunState;
  descriptor?: string;
  error?: string;
  artifactKeys: string[];
}

/**
 * One terminally settled run, as reported to the settle observer
 * (#3530 slice B): the run's ids, the trigger the engine recorded
 * for it, its terminal state, and its failure message when failed.
 * Emitted from recordTerminal only — a run that never dispatched
 * (or is merely paused) never produces one.
 */
export interface JobRunSettledInfo {
  jobId: string;
  runId: string;
  trigger: JobRunTrigger;
  state: "completed" | "failed" | "cancelled";
  error?: string;
}

/** One stage of the current/last run, as the status surface shows it (#3069 surfacing). */
export interface JobStageView {
  /** The stage id (job:<nodePath>) — the (runId, stageId) address's stage half. */
  stageId: string;
  nodePath: string;
  kind: string | null;
  units: Array<{
    unitId: string;
    status: StageUnitCheckpoint["status"];
    attempt: number;
    error?: string;
  }>;
}

export interface JobStatusView {
  definition: JobDefinition;
  instance: JobInstanceRecord | null;
  latestRun: JobRunRecord | undefined;
  history: JobRunRecord[];
  /** The current/last run's per-stage states from its stage-runner checkpoint. */
  stages: JobStageView[];
}

/** A schedule host: the platform scheduler's registration surface (Think scheduled tasks on an agent host). */
export interface JobScheduleHost {
  schedule(spec: {
    jobId: string;
    nodePath: string;
    cron?: string;
    interval?: string;
  }): Promise<string>;
  /**
   * Cancel one registration. Optional at the seam: a host that
   * cannot cancel cannot serve re-schedule (the control plane
   * refuses, fail-closed — never a duplicate firing).
   */
  unschedule?(registrationId: string): Promise<void>;
}

interface RunContext {
  deps: JobPipelineDeps;
  definition: JobDefinition;
  jobId: string;
  runId: string;
  rootConfig: JobDefinition["config"];
  scopePath: string;
  resuming: boolean;
  /** The run's stage-runner checkpoint — the one resume truth, persisted via checkpoints. */
  ledger: StageRunnerCheckpoint;
  checkpoints: StageCheckpointStore;
  memory: Map<string, unknown>;
  artifactKeys: string[];
  stepsSinceCheckpoint: number;
  currentGranularity: number;
  stepExecutions: number;
  /** The units currently executing, keyed `${stageId}::${unitId}` (parallel fan-out runs several at once). */
  activeUnits: Map<
    string,
    {
      stageId: string;
      nodePath: string;
      unitId: string;
      shardKey: string | null;
      shardIndex: number;
    }
  >;
  /** Run-record notes (fan-out caps, stage cancellations) appended to the terminal descriptor. */
  notes: string[];
  /** The one node path a stage action forces re-execution of (re-run), or null on a normal run. */
  forceStage: string | null;
}

class RunStopped extends Error {
  constructor(readonly reason: "paused" | "cancelled") {
    super(`run ${reason}`);
    this.name = "RunStopped";
  }
}

/** A stage-scoped cancellation (#3069): the run settles as cancelled, with the stage named. */
class StageCancelled extends RunStopped {
  constructor(readonly stageId: string) {
    super("cancelled");
    this.name = "StageCancelled";
  }
}

const TERMINAL: readonly JobRunState[] = ["completed", "failed", "cancelled"];

function pathSegments(path: string): number[] {
  return path === "" ? [] : path.split("/").map((s) => Number(s));
}

function childPath(path: string, index: number): string {
  return path === "" ? `${index}` : `${path}/${index}`;
}

function keyPart(path: string): string {
  return path === "" ? "root" : path;
}

function parentPath(path: string): string {
  const segments = pathSegments(path);
  segments.pop();
  return segments.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schedule preservation for the family ensures (#3530
 * scheduling-config): a job's schedule is OPERATOR configuration
 * (set through configureJob), not a re-derivable default — when an
 * ensure re-defines a job because some other part of its built
 * definition drifted, the incoming raw's root schedule is replaced
 * by the STORED definition's resolved root schedule, so the
 * re-definition converges every other field without silently
 * reverting a configured cadence or disable. Returns the incoming
 * raw unchanged when there is nothing to preserve (no stored
 * definition, no stored root schedule, or the incoming raw carries
 * no root record). Sub-node schedules are untouched: the root is
 * the only schedule any surface configures.
 */
export function withSchedulePreserved(
  incomingRaw: unknown,
  existing: JobDefinition | null | undefined,
): unknown {
  const storedSchedule = existing?.root.schedule;
  if (!storedSchedule) return incomingRaw;
  if (!isRecord(incomingRaw) || !isRecord(incomingRaw.root)) return incomingRaw;
  return {
    ...incomingRaw,
    root: { ...incomingRaw.root, schedule: { ...storedSchedule } },
  };
}

/**
 * Issue #3945 (#3550 prep slice) — the vocabulary in the engine:
 * a job node's kind names its vocabulary (catalog) stage. The
 * chain-row kinds ride the contract's own table
 * (RUNNER_STAGE_FOR_PIPELINE_STAGE: feed / generate / store /
 * serve / deliver); the chain's own kinds extend it (enrich is
 * the gather stage — enrichment — and analyze is the analysis
 * stage). The engine adds no second vocabulary: it reads the one
 * the contract already declares. Kinds naming no stage
 * ("pipeline", "dummy", host kinds) are not vocabulary stages
 * and are skipped, never guessed.
 */
const NODE_KIND_VOCABULARY_STAGE: Record<string, StageName> = {
  ...RUNNER_STAGE_FOR_PIPELINE_STAGE,
  enrich: "gather",
  analyze: "analysis",
};

/** The vocabulary stage a node kind names, or null when it names none. */
export function vocabularyStageForNodeKind(kind: string): StageName | null {
  return NODE_KIND_VOCABULARY_STAGE[kind] ?? null;
}

/**
 * Resolve a vocabulary stage of a job definition to its node
 * path — the (runId, stageId) address's node half. Exactly one
 * node may claim the stage: none refuses
 * `stage_vocabulary_unknown`, two or more refuse
 * `stage_vocabulary_ambiguous` (a stage split across nodes is
 * not one addressable stage). The walk is pre-order, root first
 * — a root whose kind is a vocabulary stage (the chain's feed
 * root) resolves to "".
 */
export function vocabularyStageNodePath(
  definition: JobDefinition,
  stage: StageName,
): string {
  const matches: string[] = [];
  const walk = (node: JobNodeConfig, path: string): void => {
    if (vocabularyStageForNodeKind(node.kind) === stage) matches.push(path);
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], childPath(path, i));
    }
  };
  walk(definition.root, "");
  if (matches.length === 0) {
    throw new JobPipelineError(
      "stage_vocabulary_unknown",
      `Job "${definition.jobId}" has no node for vocabulary stage "${stage}"; its nodes' kinds are not that stage.`,
    );
  }
  if (matches.length > 1) {
    throw new JobPipelineError(
      "stage_vocabulary_ambiguous",
      `Job "${definition.jobId}" has ${matches.length} nodes for vocabulary stage "${stage}" (node paths ${matches.join(", ")}); one stage must be one node to address it.`,
    );
  }
  return matches[0];
}

export class JobPipelineControl {
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly policy: PipelinePolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<JobRunOutcome>>();

  constructor(private readonly deps: JobPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? resolvePipelinePolicy();
    this.sleep = deps.sleep ?? defaultSleep;
    let counter = 0;
    this.newRunId =
      deps.newRunId ??
      (() => `run-${this.now().getTime().toString(36)}-${(++counter).toString(36)}`);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ---- definition management -------------------------------------------

  /** Define a job from configuration data alone. Refuses coded errors for invalid config. */
  async defineJob(rawConfig: unknown): Promise<JobDefinition> {
    const resolved = resolveJobDefinition(rawConfig);
    const existing = await this.deps.stores.definitions.getDefinition(resolved.jobId);
    const definition: JobDefinition = {
      jobId: resolved.jobId,
      name: resolved.name,
      root: resolved.root,
      rawConfig,
      config: resolved.config,
      version: (existing?.version ?? 0) + 1,
      updatedAt: this.iso(),
    };
    await this.deps.stores.definitions.saveDefinition(definition);
    if (!existing) {
      await this.deps.stores.instances.saveInstance(this.freshInstance(resolved.jobId));
    }
    return definition;
  }

  /** Reconfigure a job: the patch merges into the stored raw config and re-resolves. Applies to the next run / resume. */
  async configureJob(jobId: string, patch: unknown): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const merged = mergeJobConfigPatch(existing.rawConfig, patch);
    return this.saveResolved(jobId, merged);
  }

  /** Resolve a full raw configuration and store it as the job's next definition version. */
  private async saveResolved(jobId: string, rawConfig: unknown): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const resolved = resolveJobDefinition({
      ...(rawConfig as Record<string, unknown>),
      jobId,
    });
    const definition: JobDefinition = {
      jobId,
      name: resolved.name,
      root: resolved.root,
      rawConfig,
      config: resolved.config,
      version: existing.version + 1,
      updatedAt: this.iso(),
    };
    await this.deps.stores.definitions.saveDefinition(definition);
    return definition;
  }

  // ---- management operations (job granularity) ---------------------------

  /**
   * Dispatch a run. The delivery mode comes from the job's
   * resolved configuration: sync awaits the outcome; async
   * returns the handle immediately (the run proceeds on the
   * host's behalf — the instance store is its durable truth).
   * `scopePath` runs one sub-tree (individually schedulable
   * sub-jobs); the default runs the whole job.
   */
  async runJob(
    jobId: string,
    opts?: { trigger?: JobRunTrigger; scopePath?: string },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    if (
      instance.state === "queued" ||
      instance.state === "running" ||
      instance.state === "paused"
    ) {
      throw new JobPipelineError(
        "job_already_running",
        `Job "${jobId}" is ${instance.state} (run ${instance.currentRunId ?? "unknown"}); resume or cancel it before dispatching a new run.`,
      );
    }
    assertExecutionModeSupported(definition.config.executionMode);
    const runId = this.newRunId();
    const completion = this.executeRun(definition, {
      runId,
      trigger: opts?.trigger ?? "manual",
      scopePath: opts?.scopePath ?? "",
      resuming: false,
    });
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /**
   * Stop the run (the #3069 stop at run granularity — the
   * pipeline's historical name is pause): honored at the next
   * step boundary; the run checkpoints and settles as paused,
   * its in-flight unit recorded stopped, never failed.
   */
  async pauseJob(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "running" && instance.state !== "queued") {
      throw new JobPipelineError(
        "job_not_pausable",
        `Job "${jobId}" is ${instance.state}; only a queued or running job can pause.`,
      );
    }
    const updated: JobInstanceRecord = {
      ...instance,
      desiredState: "pause",
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(updated);
    return updated;
  }

  /** Resume a stopped (paused) run from its persisted stage checkpoint, under the current configuration. */
  async resumeJob(jobId: string): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "paused") {
      throw new JobPipelineError(
        "job_not_resumable",
        `Job "${jobId}" is ${instance.state}; only a paused job can resume.`,
      );
    }
    if (!instance.checkpoint || !instance.currentRunId) {
      throw new JobPipelineError(
        "job_no_checkpoint",
        `Job "${jobId}" is paused without a checkpoint; retry it instead.`,
      );
    }
    assertExecutionModeSupported(definition.config.executionMode);
    const runId = instance.currentRunId;
    const completion = this.executeRun(definition, {
      runId,
      trigger: instance.runTrigger ?? "manual",
      scopePath: instance.checkpoint.scopePath,
      resuming: true,
    });
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /** Cancel: a running job stops at the next boundary; a paused or queued job cancels immediately. Terminal either way. */
  async cancelJob(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.requireInstance(jobId);
    if (TERMINAL.includes(instance.state) || instance.state === "idle") {
      throw new JobPipelineError(
        "job_not_cancellable",
        `Job "${jobId}" is ${instance.state}; there is no live run to cancel.`,
      );
    }
    if (instance.state === "running" || instance.state === "queued") {
      const updated: JobInstanceRecord = {
        ...instance,
        desiredState: "cancel",
        updatedAt: this.iso(),
      };
      await this.deps.stores.instances.saveInstance(updated);
      return updated;
    }
    // Paused: no engine is live to honor a desired state — settle
    // it here, sweeping the run's outstanding stage units to
    // cancelled so the cancellation is surfaced per stage,
    // never vanished (#3069).
    const settled: JobInstanceRecord = {
      ...instance,
      state: "cancelled",
      desiredState: "none",
      stageDesired: null,
      stageCheckpoint: instance.stageCheckpoint
        ? {
            ...instance.stageCheckpoint,
            units: instance.stageCheckpoint.units.map((unit) =>
              unit.status === "completed" || unit.status === "cancelled"
                ? unit
                : { ...unit, status: "cancelled" as const, updatedAt: this.iso() },
            ),
          }
        : null,
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(settled);
    await publishJobStatus(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId ?? "unknown",
      state: "cancelled",
      at: this.iso(),
    });
    await this.recordTerminal(settled, "cancelled", undefined);
    return settled;
  }

  /** Retry: a NEW run from the start (fresh run id, checkpoints cleared), from a terminal or paused state. */
  async retryJob(jobId: string): Promise<JobDispatchResult> {
    const instance = await this.requireInstance(jobId);
    if (instance.state === "running" || instance.state === "queued") {
      throw new JobPipelineError(
        "job_not_retirable",
        `Job "${jobId}" is ${instance.state}; a live run cannot be retried — cancel it first.`,
      );
    }
    const cleared: JobInstanceRecord = {
      ...instance,
      state: "idle",
      desiredState: "none",
      checkpoint: null,
      stageCheckpoint: null,
      stageDesired: null,
      currentRunId: null,
      runStartedAt: null,
      runTrigger: null,
      lastError: null,
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(cleared);
    return this.runJob(jobId, { trigger: "manual" });
  }

  /**
   * Issue #4002: settle pipeline runs orphaned by a host restart.
   * Called from the pipeline host's onStart, after the job
   * definitions are ensured. At host start no executor can still
   * be running — a live run cannot survive its host's death — so
   * every instance still marked `running` is settled as failed
   * with a named orphan error, through the engine's own failure
   * path (state + terminal run record + published transition),
   * and the job is dispatchable again. Paused, queued, idle,
   * completed, and failed instances are untouched: a paused run
   * resumes from its checkpoint, a queued run is still owed its
   * execution. Returns the settled job ids for the host's log.
   */
  async settleOrphanedRuns(): Promise<{ settled: string[] }> {
    const definitions = await this.deps.stores.definitions.listDefinitions();
    const settled: string[] = [];
    for (const definition of definitions) {
      const instance = await this.deps.stores.instances.getInstance(definition.jobId);
      if (!instance || instance.state !== "running") continue;
      const message =
        `Orphaned by a host restart: the run was still 'running' when the pipeline host started, ` +
        `so no executor can still be running it (run ${instance.currentRunId ?? "unknown"}, ` +
        `started ${instance.runStartedAt ?? "unknown"}). The run never recorded a result.`;
      const updated: JobInstanceRecord = {
        ...instance,
        state: "failed",
        desiredState: "none",
        lastError: message,
      };
      await this.setInstance(updated);
      await publishJobStatus(this.deps.publisher, {
        jobId: definition.jobId,
        runId: instance.currentRunId ?? "unknown",
        state: "failed",
        at: this.iso(),
        detail: message,
      });
      await this.recordTerminal(updated, "failed", message);
      settled.push(definition.jobId);
    }
    return { settled };
  }

  /** The status view: definition + live instance + run history from the one run-record machinery + per-stage states. */
  async getJob(jobId: string): Promise<JobStatusView> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.deps.stores.instances.getInstance(jobId);
    const history = await this.deps.runRecorder.listRuns(jobId, 50);
    return {
      definition,
      instance,
      latestRun: history[0],
      history,
      stages: this.stageViews(definition, instance),
    };
  }

  async listJobs(): Promise<JobDefinition[]> {
    return this.deps.stores.definitions.listDefinitions();
  }

  /** The async-delivery completion handle for a dispatched run, when this host dispatched it. */
  waitForRun(runId: string): Promise<JobRunOutcome> | undefined {
    return this.inflight.get(runId);
  }

  /**
   * Register every enabled schedule (the job's own and every
   * sub-node's — sub-jobs are individually schedulable) with the
   * platform schedule host. Firing a registration maps to
   * runJob(jobId, { trigger: "scheduled", scopePath }).
   */
  async registerSchedules(
    host: JobScheduleHost,
  ): Promise<Array<{ jobId: string; nodePath: string; registrationId: string }>> {
    const registrations: Array<{
      jobId: string;
      nodePath: string;
      registrationId: string;
    }> = [];
    for (const definition of await this.deps.stores.definitions.listDefinitions()) {
      const walk = async (node: JobNodeConfig, path: string): Promise<void> => {
        const schedule = path === "" ? definition.config.schedule : node.schedule;
        if (schedule?.enabled) {
          const registrationId = await host.schedule({
            jobId: definition.jobId,
            nodePath: path,
            ...(schedule.cron ? { cron: schedule.cron } : {}),
            ...(schedule.interval ? { interval: schedule.interval } : {}),
          });
          registrations.push({ jobId: definition.jobId, nodePath: path, registrationId });
        }
        const children = node.children ?? [];
        for (let i = 0; i < children.length; i++) {
          await walk(children[i], childPath(path, i));
        }
      };
      await walk(definition.root, "");
    }
    return registrations;
  }

  // ---- uniform stage control (run granularity is above; stage granularity here) ----
  //
  // The seven operations of #3069 (folded into #3549), addressed
  // by (runId, stageId) — here the job's current run and a node
  // path (stageId `job:<nodePath>`). Meanings are #3069's pinned
  // ones; the claims are the stage checkpoint's entries (the
  // runId + stageId claim of the #2869 seam, carried on every
  // published stage event as its idempotencyKey).

  /** The stage entries of one stage in the instance's current ledger. */
  private stageEntries(instance: JobInstanceRecord, stageId: string): StageUnitCheckpoint[] {
    return (instance.stageCheckpoint?.units ?? []).filter((u) => u.stage === stageId);
  }

  /** Refuse stage actions addressed to a run the job is not currently on. */
  private assertRunAddressed(instance: JobInstanceRecord, runId?: string): void {
    if (runId !== undefined && instance.currentRunId !== runId) {
      throw new JobPipelineError(
        "stage_run_mismatch",
        `Stage actions address the job's current run (${instance.currentRunId ?? "none"}); run "${runId}" is not addressable — its stage checkpoint is no longer the live one.`,
      );
    }
    if (!instance.currentRunId || !instance.stageCheckpoint) {
      throw new JobPipelineError(
        "stage_no_run",
        `Job "${instance.jobId}" has no run to address; dispatch the job before addressing its stages.`,
      );
    }
  }

  private assertStageNotLive(instance: JobInstanceRecord, action: string): void {
    if (instance.state === "running" || instance.state === "queued" || instance.state === "paused") {
      throw new JobPipelineError(
        "stage_action_conflict",
        `Cannot ${action} a stage of job "${instance.jobId}" while its run is ${instance.state}; the live run owns its stages — stop or cancel it first.`,
      );
    }
  }

  /**
   * The persisted input a stage consumes: its parent stage's
   * hand-off artifact in this run. The root stage consumes the
   * run input (null). Fail-closed (#3069): a missing hand-off
   * refuses — input is never fabricated. In-memory processing
   * keeps hand-offs in a dead run context, so stage actions on
   * such jobs refuse by name.
   */
  private async stageInput(
    definition: JobDefinition,
    runId: string,
    nodePath: string,
  ): Promise<unknown> {
    if (nodePath === "") return null;
    if (definition.config.processing.inMemory) {
      throw new JobPipelineError(
        "stage_input_missing",
        `Stage "${jobStageId(nodePath)}" of job "${definition.jobId}" cannot be addressed independently: the job processes in memory, so its stages' hand-offs were never persisted.`,
      );
    }
    const input = await this.deps.stores.artifacts.getArtifact(
      runId,
      `${keyPart(parentPath(nodePath))}/stage-output`,
    );
    if (input === null) {
      throw new JobPipelineError(
        "stage_input_missing",
        `Stage "${jobStageId(nodePath)}" of job "${definition.jobId}" has no persisted input in run ${runId}: its parent stage's hand-off is absent. Refusing rather than fabricating input.`,
      );
    }
    return input;
  }

  /**
   * Run: start a stage that has not run in the current run,
   * from its persisted input (out-of-order starts included —
   * the input is the only precondition).
   */
  async runStage(
    jobId: string,
    nodePath: string,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance, opts?.runId);
    this.assertStageNotLive(instance, "run");
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.some((e) => e.status === "completed")) {
      throw new JobPipelineError(
        "stage_already_completed",
        `Stage "${stageId}" of job "${jobId}" already completed in run ${instance.currentRunId}; re-run is the operation for a completed stage.`,
      );
    }
    if (
      entries.length > 0 &&
      entries.every((e) => e.status === "cancelled" || e.status === "skipped")
    ) {
      throw new JobPipelineError(
        "stage_not_runnable",
        `Stage "${stageId}" of job "${jobId}" is ${entries[0].status} in run ${instance.currentRunId}; a cancelled stage never silently resumes.`,
      );
    }
    await this.stageInput(definition, instance.currentRunId!, nodePath);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "run",
      at: this.iso(),
    });
    return this.executeStageAction(definition, instance, nodePath, false);
  }

  /**
   * Re-run: re-execute a completed or failed stage from its
   * persisted input. Idempotent via the runId + stageId claim:
   * the stage's entries return to queued under their existing
   * attempt counts and the re-execution overwrites the stage's
   * own hand-offs — a second re-run converges on the same
   * effects, never duplicates them. Downstream stages keep
   * their recorded outputs (re-running them is their own
   * operation).
   */
  async rerunStage(
    jobId: string,
    nodePath: string,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance, opts?.runId);
    this.assertStageNotLive(instance, "re-run");
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.some((e) => e.status === "running")) {
      throw new JobPipelineError(
        "stage_action_in_flight",
        `Stage "${stageId}" of job "${jobId}" is recorded running in run ${instance.currentRunId}; a re-run of an in-flight stage converges on the live execution, never a second one.`,
      );
    }
    if (!entries.some((e) => e.status === "completed" || e.status === "failed" || e.status === "timed_out")) {
      throw new JobPipelineError(
        "stage_not_rerunnable",
        `Stage "${stageId}" of job "${jobId}" has no completed or failed units in run ${instance.currentRunId} — run starts a stage that has not run, resume continues a stopped one.`,
      );
    }
    await this.stageInput(definition, instance.currentRunId!, nodePath);
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      jobId,
    );
    const ledger = await checkpoints.read(instance.currentRunId!);
    if (ledger) {
      await checkpoints.write({
        ...ledger,
        units: ledger.units.map((u) =>
          u.stage === stageId ? { ...u, status: "queued" as const, updatedAt: this.iso() } : u,
        ),
      });
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "rerun",
      at: this.iso(),
    });
    const fresh = await this.requireInstance(jobId);
    return this.executeStageAction(definition, fresh, nodePath, true);
  }

  /**
   * Stop: halt a running stage — non-terminal, resumable,
   * recorded and surfaced as stopped, never as failed. On a
   * live run the request is recorded per stage and honored at
   * that stage's next boundary (or when the stage is reached);
   * on a run whose engine is gone, recorded-running units are
   * marked stopped directly. Stopping an already-stopped stage
   * converges (returns the instance unchanged in effect).
   */
  async stopStage(jobId: string, nodePath: string): Promise<JobInstanceRecord> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (instance.state === "running" || instance.state === "queued") {
      if (
        entries.length > 0 &&
        entries.every(
          (e) => e.status === "completed" || e.status === "cancelled" || e.status === "skipped",
        )
      ) {
        throw new JobPipelineError(
          "stage_not_stoppable",
          `Stage "${stageId}" of job "${jobId}" is already terminal in run ${instance.currentRunId}; there is nothing left to stop.`,
        );
      }
      const stageDesired = { ...(instance.stageDesired ?? {}), [stageId]: "pause" as const };
      const updated: JobInstanceRecord = { ...instance, stageDesired, updatedAt: this.iso() };
      await this.deps.stores.instances.saveInstance(updated);
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "stop",
        at: this.iso(),
      });
      return updated;
    }
    if (entries.some((e) => e.status === "stopped")) return instance;
    if (entries.some((e) => e.status === "running" || e.status === "queued")) {
      const checkpoints = createJobPipelineStageCheckpointStore(
        this.deps.stores.instances,
        jobId,
      );
      const ledger = await checkpoints.read(instance.currentRunId!);
      if (ledger) {
        await checkpoints.write({
          ...ledger,
          units: ledger.units.map((u) =>
            u.stage === stageId && (u.status === "running" || u.status === "queued")
              ? { ...u, status: "stopped" as const, updatedAt: this.iso() }
              : u,
          ),
        });
      }
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "stop",
        at: this.iso(),
      });
      return this.requireInstance(jobId);
    }
    throw new JobPipelineError(
      "stage_not_stoppable",
      `Stage "${stageId}" of job "${jobId}" is not running in run ${instance.currentRunId}; only a running (or recorded-running) stage can stop.`,
    );
  }

  /**
   * Resume: continue a stopped stage from its persisted
   * checkpoint via the runId + stageId claim. The run resumes
   * (its checkpoint is the stage's), and the runner's decisions
   * guarantee no completed effect re-executes.
   */
  async resumeStage(jobId: string, nodePath: string): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    if (instance.state !== "paused") {
      throw new JobPipelineError(
        "stage_not_resumable",
        `Job "${jobId}" is ${instance.state}; only a stopped (paused) run's stage can resume.`,
      );
    }
    const stoppedStages = [
      ...new Set(
        (instance.stageCheckpoint?.units ?? [])
          .filter((u) => u.status === "stopped")
          .map((u) => u.stage),
      ),
    ];
    if (!stoppedStages.includes(stageId)) {
      throw new JobPipelineError(
        "stage_not_resumable",
        `Stage "${stageId}" of job "${jobId}" is not the stopped stage of run ${instance.currentRunId} (stopped: ${stoppedStages.join(", ") || "none"}); a run resumes from its stopped stage.`,
      );
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "resume",
      at: this.iso(),
    });
    return this.resumeJob(jobId);
  }

  /**
   * Cancel a stage: terminal and surfaced as cancelled. On a
   * live run the request is honored at the stage's boundaries
   * (or when the stage is reached — it then never executes,
   * and its downstream never proceeds). On a stopped run, the
   * stopped stage's cancellation settles the run as cancelled;
   * any other stage's entries are marked cancelled in place.
   */
  async cancelStage(jobId: string, nodePath: string): Promise<JobInstanceRecord> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.length > 0 && entries.every((e) => e.status === "completed")) {
      throw new JobPipelineError(
        "stage_not_cancellable",
        `Stage "${stageId}" of job "${jobId}" already completed in run ${instance.currentRunId}; a completed stage cannot be cancelled.`,
      );
    }
    if (instance.state === "running" || instance.state === "queued") {
      const stageDesired = { ...(instance.stageDesired ?? {}), [stageId]: "cancel" as const };
      const updated: JobInstanceRecord = { ...instance, stageDesired, updatedAt: this.iso() };
      await this.deps.stores.instances.saveInstance(updated);
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "cancel",
        at: this.iso(),
      });
      return updated;
    }
    if (entries.length === 0) {
      throw new JobPipelineError(
        "stage_not_cancellable",
        `Stage "${stageId}" of job "${jobId}" has not run in run ${instance.currentRunId}; there is nothing to cancel.`,
      );
    }
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      jobId,
    );
    const ledger = await checkpoints.read(instance.currentRunId!);
    if (ledger) {
      await checkpoints.write({
        ...ledger,
        units: ledger.units.map((u) =>
          u.stage === stageId && u.status !== "completed"
            ? { ...u, status: "cancelled" as const, updatedAt: this.iso() }
            : u,
        ),
      });
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "cancel",
      at: this.iso(),
    });
    const fresh = await this.requireInstance(jobId);
    // Cancelling the stage a stopped run is stopped at settles
    // the run: it can never resume past a cancelled stage.
    if (
      fresh.state === "paused" &&
      entries.some((e) => e.status === "stopped")
    ) {
      const settled: JobInstanceRecord = {
        ...fresh,
        state: "cancelled",
        desiredState: "none",
        stageDesired: null,
        updatedAt: this.iso(),
      };
      await this.deps.stores.instances.saveInstance(settled);
      await publishJobStatus(this.deps.publisher, {
        jobId,
        runId: fresh.currentRunId ?? "unknown",
        state: "cancelled",
        at: this.iso(),
      });
      await this.recordTerminal(settled, "cancelled", undefined);
      return settled;
    }
    return fresh;
  }

  /**
   * Schedule: attach a not-yet-scheduled stage to the schedule
   * mechanism. The registration identity and the reason are
   * recorded on the stage's (externalized) schedule
   * configuration at creation and surfaced from it.
   */
  async scheduleStage(
    jobId: string,
    nodePath: string,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    const definition = await this.requireDefinition(jobId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const existing = node.schedule;
    if (existing?.registrationId) {
      throw new JobPipelineError(
        "stage_already_scheduled",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" is already scheduled (registration ${existing.registrationId}); re-schedule is the operation for changing it.`,
      );
    }
    const scheduleHost = host ?? this.deps.scheduleHost;
    if (!scheduleHost) {
      throw new JobPipelineError(
        "stage_schedule_host_unconfigured",
        `No schedule host is configured for stage scheduling of job "${jobId}"; the host wiring supplies one (or pass it to scheduleStage).`,
      );
    }
    const registrationId = await scheduleHost.schedule({
      jobId,
      nodePath,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
    });
    const schedule: JobScheduleConfig = {
      enabled: true,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
      registrationId,
      reason,
    };
    await this.applyNodeSchedule(jobId, nodePath, schedule);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: (await this.requireInstance(jobId)).currentRunId ?? "none",
      stageId: jobStageId(nodePath),
      action: "schedule",
      at: this.iso(),
      detail: registrationId,
    });
    return { registrationId, schedule };
  }

  /**
   * Re-schedule: one atomic action — the old registration is
   * cancelled and the new one created, in that order, and any
   * failure is loud (never a silent drop, never a duplicate
   * firing at both times: a host that cannot cancel cannot
   * re-schedule, fail-closed).
   */
  async rescheduleStage(
    jobId: string,
    nodePath: string,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    const definition = await this.requireDefinition(jobId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const existing = node.schedule;
    if (!existing?.registrationId) {
      throw new JobPipelineError(
        "stage_not_scheduled",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" has no control-plane registration to re-schedule; schedule is the operation for attaching one.`,
      );
    }
    const scheduleHost = host ?? this.deps.scheduleHost;
    if (!scheduleHost) {
      throw new JobPipelineError(
        "stage_schedule_host_unconfigured",
        `No schedule host is configured for stage re-scheduling of job "${jobId}".`,
      );
    }
    if (!scheduleHost.unschedule) {
      throw new JobPipelineError(
        "stage_reschedule_unsupported",
        `The schedule host cannot cancel registration ${existing.registrationId}, so re-scheduling stage "${jobStageId(nodePath)}" of job "${jobId}" would risk a duplicate firing; refusing, fail-closed.`,
      );
    }
    await scheduleHost.unschedule(existing.registrationId);
    let registrationId: string;
    try {
      registrationId = await scheduleHost.schedule({
        jobId,
        nodePath,
        ...(spec.cron ? { cron: spec.cron } : {}),
        ...(spec.interval ? { interval: spec.interval } : {}),
      });
    } catch (error) {
      throw new JobPipelineError(
        "stage_reschedule_failed",
        `Re-scheduling stage "${jobStageId(nodePath)}" of job "${jobId}": the old registration ${existing.registrationId} was cancelled, but creating the new schedule failed (${error instanceof Error ? error.message : String(error)}). The stage is now unscheduled — schedule it explicitly.`,
      );
    }
    const schedule: JobScheduleConfig = {
      enabled: true,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
      registrationId,
      reason,
    };
    await this.applyNodeSchedule(jobId, nodePath, schedule);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: (await this.requireInstance(jobId)).currentRunId ?? "none",
      stageId: jobStageId(nodePath),
      action: "reschedule",
      at: this.iso(),
      detail: registrationId,
    });
    return { registrationId, schedule };
  }

  // ---- uniform stage control addressed by vocabulary stage (#3945) ----
  //
  // The same seven operations, addressed by (runId, stageId) with
  // the stage half a vocabulary (catalog) stage name instead of a
  // node path. Each resolves the stage to its node path through
  // vocabularyStageNodePath and delegates to its (jobId, nodePath)
  // twin — the twins' meanings, claims, and refusals ARE the
  // operation, so a vocabulary address can never behave
  // differently from the node-path address of the same node. The
  // run half is the twins': the job's current run, optionally
  // pinned by opts.runId (run / re-run); schedule / re-schedule
  // need no run and address the definition's node directly.

  /** Resolve one vocabulary stage of one job to its node path. */
  private async vocabularyNodePath(jobId: string, stage: StageName): Promise<string> {
    const definition = await this.requireDefinition(jobId);
    return vocabularyStageNodePath(definition, stage);
  }

  /** Run a vocabulary stage that has not run in the current run. */
  async runStageByVocabulary(
    jobId: string,
    stage: StageName,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    return this.runStage(jobId, await this.vocabularyNodePath(jobId, stage), opts);
  }

  /** Re-run a completed or failed vocabulary stage from its persisted input. */
  async rerunStageByVocabulary(
    jobId: string,
    stage: StageName,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    return this.rerunStage(jobId, await this.vocabularyNodePath(jobId, stage), opts);
  }

  /** Stop a running vocabulary stage — non-terminal, resumable. */
  async stopStageByVocabulary(jobId: string, stage: StageName): Promise<JobInstanceRecord> {
    return this.stopStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Resume a stopped vocabulary stage from its persisted checkpoint. */
  async resumeStageByVocabulary(jobId: string, stage: StageName): Promise<JobDispatchResult> {
    return this.resumeStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Cancel a vocabulary stage — terminal, surfaced as cancelled. */
  async cancelStageByVocabulary(jobId: string, stage: StageName): Promise<JobInstanceRecord> {
    return this.cancelStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Schedule a vocabulary stage: attach it to the schedule mechanism. */
  async scheduleStageByVocabulary(
    jobId: string,
    stage: StageName,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    return this.scheduleStage(
      jobId,
      await this.vocabularyNodePath(jobId, stage),
      spec,
      reason,
      host,
    );
  }

  /** Re-schedule a vocabulary stage: one atomic action. */
  async rescheduleStageByVocabulary(
    jobId: string,
    stage: StageName,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    return this.rescheduleStage(
      jobId,
      await this.vocabularyNodePath(jobId, stage),
      spec,
      reason,
      host,
    );
  }

  /** Persist one node's schedule configuration into the job's stored raw definition (re-resolved + versioned). */
  private async applyNodeSchedule(
    jobId: string,
    nodePath: string,
    schedule: JobScheduleConfig,
  ): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const raw = JSON.parse(JSON.stringify(existing.rawConfig ?? {})) as Record<string, unknown>;
    if (!isRecord(raw.root)) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Job "${jobId}" has no stored root node to schedule a stage on.`,
      );
    }
    let node: Record<string, unknown> = raw.root;
    for (const segment of pathSegments(nodePath)) {
      const children = node.children;
      if (!Array.isArray(children) || !isRecord(children[segment])) {
        throw new JobPipelineError(
          "job_config_invalid",
          `Scope path "${nodePath}" does not resolve in job "${jobId}"'s stored configuration.`,
        );
      }
      node = children[segment] as Record<string, unknown>;
    }
    node.schedule = { ...schedule };
    return this.saveResolved(jobId, raw);
  }

  /**
   * Execute one stage action (run / re-run) inline: the stage
   * executes under the runner's decisions against the current
   * run's checkpoint; the job's instance state is restored to
   * the run's recorded state afterwards (a stage action is not
   * a new run — the run's history is untouched).
   */
  private async executeStageAction(
    definition: JobDefinition,
    instance: JobInstanceRecord,
    nodePath: string,
    force: boolean,
  ): Promise<JobDispatchResult> {
    const jobId = definition.jobId;
    const runId = instance.currentRunId!;
    const priorState = instance.state;
    const priorCheckpoint = instance.checkpoint;
    const node = this.nodeAtPath(definition.root, nodePath);
    const input = await this.stageInput(definition, runId, nodePath);
    const running: JobInstanceRecord = {
      ...instance,
      state: "running",
      desiredState: "none",
      lastError: null,
    };
    await this.setInstance(running);
    const ctx = await this.buildContext(definition, {
      runId,
      scopePath: "",
      resuming: true,
      instance: running,
      forceStage: force ? nodePath : null,
    });
    try {
      await this.execNode(ctx, node, nodePath, input);
      const settled = await this.requireInstance(jobId);
      await this.setInstance({ ...settled, state: priorState, checkpoint: priorCheckpoint });
      return { jobId, runId, state: "completed" };
    } catch (error) {
      const settled = await this.requireInstance(jobId);
      if (error instanceof RunStopped) {
        await this.setInstance({
          ...settled,
          state: error.reason === "paused" ? "paused" : priorState,
          ...(error.reason === "cancelled" ? { checkpoint: priorCheckpoint } : {}),
        });
        return { jobId, runId, state: error.reason };
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.setInstance({
        ...settled,
        state: priorState,
        checkpoint: priorCheckpoint,
        lastError: message,
      });
      return { jobId, runId, state: "failed" };
    }
  }

  /** Per-stage states for the status view, from the instance's stage checkpoint. */
  private stageViews(
    definition: JobDefinition,
    instance: JobInstanceRecord | null,
  ): JobStageView[] {
    if (!instance?.stageCheckpoint) return [];
    const kinds = new Map<string, string>();
    const walk = (node: JobNodeConfig, path: string): void => {
      kinds.set(path, node.kind);
      (node.children ?? []).forEach((child, i) => walk(child, childPath(path, i)));
    };
    walk(definition.root, "");
    const byStage = new Map<string, JobStageView>();
    for (const unit of instance.stageCheckpoint.units) {
      if (!isJobStageId(unit.stage)) continue;
      const nodePath = unit.stage === "job:root" ? "" : unit.stage.slice("job:".length);
      let view = byStage.get(unit.stage);
      if (!view) {
        view = {
          stageId: unit.stage,
          nodePath,
          kind: kinds.get(nodePath) ?? null,
          units: [],
        };
        byStage.set(unit.stage, view);
      }
      view.units.push({
        unitId: unit.unitId,
        status: unit.status,
        attempt: unit.attempt,
        ...(unit.error !== undefined ? { error: unit.error } : {}),
      });
    }
    return [...byStage.values()];
  }

  // ---- execution ----------------------------------------------------------

  private freshInstance(jobId: string): JobInstanceRecord {
    return {
      jobId,
      state: "idle",
      desiredState: "none",
      currentRunId: null,
      runStartedAt: null,
      runTrigger: null,
      checkpoint: null,
      stageCheckpoint: null,
      stageDesired: null,
      lastError: null,
      updatedAt: this.iso(),
    };
  }

  private async requireDefinition(jobId: string): Promise<JobDefinition> {
    const definition = await this.deps.stores.definitions.getDefinition(jobId);
    if (!definition) {
      throw new JobPipelineError("job_not_found", `No job defined with id "${jobId}".`);
    }
    return definition;
  }

  private async requireInstance(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.deps.stores.instances.getInstance(jobId);
    if (instance) return instance;
    await this.requireDefinition(jobId);
    const fresh = this.freshInstance(jobId);
    await this.deps.stores.instances.saveInstance(fresh);
    return fresh;
  }

  private async setInstance(instance: JobInstanceRecord): Promise<void> {
    await this.deps.stores.instances.saveInstance({ ...instance, updatedAt: this.iso() });
  }

  private async recordTerminal(
    instance: JobInstanceRecord,
    outcome: "completed" | "failed" | "cancelled",
    error: string | undefined,
    descriptor?: string,
    artifactRefs?: string[],
  ): Promise<void> {
    if (!instance.currentRunId || !instance.runStartedAt) return;
    const definition = await this.deps.stores.definitions.getDefinition(instance.jobId);
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: instance.jobId,
      operation: definition?.root.kind ?? "job",
      started: instance.runStartedAt,
      finished: this.iso(),
      outcome:
        outcome === "completed" ? "success" : outcome === "failed" ? "failure" : "skipped",
      triggeredBy: instance.runTrigger ?? "manual",
      ...(outcome === "failed" ? { error: error ?? "job run failed" } : {}),
      ...(outcome === "cancelled" ? { detail: "job_cancelled" } : {}),
      ...(descriptor !== undefined ? { descriptor } : {}),
      ...(artifactRefs !== undefined ? { artifactRefs } : {}),
    });
    await this.deps.runRecorder.recordRun(record);
    // #3530 slice B: the settle observer fires here — downstream
    // of the no-run guard above, so it observes exactly the runs
    // that settled, exactly once each. Guarded: an observer
    // failure never fails or retries the settled run.
    const observer = this.deps.runSettledObserver;
    if (observer) {
      try {
        await observer({
          jobId: instance.jobId,
          runId: instance.currentRunId,
          trigger: instance.runTrigger ?? "manual",
          state: outcome,
          ...(error ? { error } : {}),
        });
      } catch {
        // Best-effort by contract (see JobPipelineDeps): the
        // observers log their own failures with the run's ids.
      }
    }
  }

  /** Build the run context: the ledger is read through the StageCheckpointStore (resumes), or started empty. */
  private async buildContext(
    definition: JobDefinition,
    opts: {
      runId: string;
      scopePath: string;
      resuming: boolean;
      instance: JobInstanceRecord;
      forceStage: string | null;
    },
  ): Promise<RunContext> {
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      definition.jobId,
    );
    const ledger: StageRunnerCheckpoint = opts.resuming
      ? ((await checkpoints.read(opts.runId)) ?? { runId: opts.runId, units: [] })
      : { runId: opts.runId, units: [] };
    return {
      deps: this.deps,
      definition,
      jobId: definition.jobId,
      runId: opts.runId,
      rootConfig: definition.config,
      scopePath: opts.scopePath,
      resuming: opts.resuming,
      ledger,
      checkpoints,
      memory: new Map(),
      artifactKeys: opts.resuming ? [...(opts.instance.checkpoint?.artifactKeys ?? [])] : [],
      stepsSinceCheckpoint: 0,
      currentGranularity: definition.config.processing.checkpointEverySteps,
      stepExecutions: 0,
      activeUnits: new Map(),
      notes: [],
      forceStage: opts.forceStage,
    };
  }

  private async executeRun(
    definition: JobDefinition,
    opts: {
      runId: string;
      trigger: JobRunTrigger;
      scopePath: string;
      resuming: boolean;
    },
  ): Promise<JobRunOutcome> {
    const { publisher } = this.deps;
    const jobId = definition.jobId;
    const startedAt = this.iso();
    let instance = await this.requireInstance(jobId);
    instance = {
      ...instance,
      state: "queued",
      desiredState: "none",
      currentRunId: opts.runId,
      runStartedAt: opts.resuming ? (instance.runStartedAt ?? startedAt) : startedAt,
      runTrigger: opts.trigger,
      stageCheckpoint: opts.resuming
        ? instance.stageCheckpoint
        : { runId: opts.runId, units: [] },
      stageDesired: opts.resuming ? instance.stageDesired : null,
      lastError: null,
    };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "queued", at: this.iso() });
    instance = { ...instance, state: "running" };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "running", at: this.iso() });

    const ctx = await this.buildContext(definition, {
      runId: opts.runId,
      scopePath: opts.scopePath,
      resuming: opts.resuming,
      instance,
      forceStage: null,
    });
    if (!opts.resuming) await this.persistLedger(ctx);

    try {
      const scopeNode = this.nodeAtPath(definition.root, opts.scopePath);
      await this.execNode(ctx, scopeNode, opts.scopePath, null);
      instance = await this.requireInstance(jobId);
      const descriptor =
        `run ${opts.runId}: ${ctx.stepExecutions} step executions, ${ctx.artifactKeys.length} artifacts` +
        (ctx.notes.length > 0 ? `; ${ctx.notes.join("; ")}` : "");
      instance = { ...instance, state: "completed", desiredState: "none", checkpoint: null };
      await this.setInstance(instance);
      await publishJobStatus(publisher, {
        jobId,
        runId: opts.runId,
        state: "completed",
        at: this.iso(),
        artifactKeys: [...ctx.artifactKeys],
      });
      await this.recordTerminal(instance, "completed", undefined, descriptor, [
        ...ctx.artifactKeys,
      ]);
      return {
        jobId,
        runId: opts.runId,
        state: "completed",
        descriptor,
        artifactKeys: [...ctx.artifactKeys],
      };
    } catch (error) {
      instance = await this.requireInstance(jobId);
      if (error instanceof RunStopped && error.reason === "paused") {
        // The boundary that stopped already persisted the checkpoint + paused state.
        return { jobId, runId: opts.runId, state: "paused", artifactKeys: [...ctx.artifactKeys] };
      }
      if (error instanceof RunStopped && error.reason === "cancelled") {
        // Surface the cancellation per stage: every outstanding
        // unit of the run is recorded cancelled, never vanished.
        if (error instanceof StageCancelled && !ctx.notes.includes(`stage cancelled: ${error.stageId}`)) {
          ctx.notes.push(`stage cancelled: ${error.stageId}`);
        }
        for (const unit of ctx.ledger.units) {
          if (unit.status !== "completed" && unit.status !== "cancelled" && unit.status !== "skipped") {
            this.setEntry(ctx, { ...unit, status: "cancelled", updatedAt: this.iso() });
          }
        }
        await this.persistLedger(ctx);
        instance = { ...instance, state: "cancelled", desiredState: "none", stageDesired: null };
        await this.setInstance(instance);
        await publishJobStatus(publisher, {
          jobId,
          runId: opts.runId,
          state: "cancelled",
          at: this.iso(),
        });
        await this.recordTerminal(instance, "cancelled", undefined);
        return {
          jobId,
          runId: opts.runId,
          state: "cancelled",
          artifactKeys: [...ctx.artifactKeys],
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      instance = { ...instance, state: "failed", desiredState: "none", lastError: message };
      await this.setInstance(instance);
      await publishJobStatus(publisher, {
        jobId,
        runId: opts.runId,
        state: "failed",
        at: this.iso(),
        detail: message,
      });
      await this.recordTerminal(instance, "failed", message);
      return {
        jobId,
        runId: opts.runId,
        state: "failed",
        error: message,
        artifactKeys: [...ctx.artifactKeys],
      };
    }
  }

  private nodeAtPath(root: JobNodeConfig, path: string): JobNodeConfig {
    let node = root;
    for (const segment of pathSegments(path)) {
      const next = (node.children ?? [])[segment];
      if (!next) {
        throw new JobPipelineError(
          "job_config_invalid",
          `Scope path "${path}" does not resolve in the job's node tree.`,
        );
      }
      node = next;
    }
    return node;
  }

  private async readArtifact(
    ctx: RunContext,
    key: string,
    inMemory: boolean,
  ): Promise<unknown> {
    if (inMemory) return ctx.memory.has(key) ? ctx.memory.get(key) : null;
    return this.deps.stores.artifacts.getArtifact(ctx.runId, key);
  }

  private async artifactExists(
    ctx: RunContext,
    key: string,
    inMemory: boolean,
  ): Promise<boolean> {
    if (inMemory) return ctx.memory.has(key);
    const keys = await this.deps.stores.artifacts.listArtifactKeys(ctx.runId);
    return keys.includes(key);
  }

  private async writeArtifact(
    ctx: RunContext,
    key: string,
    value: unknown,
    inMemory: boolean,
  ): Promise<void> {
    if (inMemory) {
      ctx.memory.set(key, value);
      return;
    }
    await this.deps.stores.artifacts.putArtifact(ctx.runId, key, value);
    if (!ctx.artifactKeys.includes(key)) ctx.artifactKeys.push(key);
  }

  // ---- the stage-runner ledger -------------------------------------------

  private entryFor(
    ledger: StageRunnerCheckpoint,
    stageId: string,
    unitId: string,
  ): StageUnitCheckpoint | undefined {
    return ledger.units.find((u) => u.stage === stageId && u.unitId === unitId);
  }

  /** Replace-or-add one entry, mutating the ledger in place (parallel units share it safely). */
  private setEntry(ctx: RunContext, entry: StageUnitCheckpoint): void {
    const index = ctx.ledger.units.findIndex(
      (u) => u.stage === entry.stage && u.unitId === entry.unitId,
    );
    if (index >= 0) ctx.ledger.units[index] = entry;
    else ctx.ledger.units.push(entry);
  }

  /** Persist the ledger through the StageCheckpointStore (a snapshot — later mutations never alias it). */
  private async persistLedger(ctx: RunContext): Promise<void> {
    await ctx.checkpoints.write({
      runId: ctx.runId,
      units: ctx.ledger.units.map((u) => ({ ...u })),
    });
  }

  /** Compile one node to its stage-runner stage. */
  private stageForNode(
    node: JobNodeConfig,
    path: string,
    mode: JobExecutionMode,
  ): StageRunnerStage {
    const kind = node.kind as PipelineStage;
    // Kinds naming a chain stage retry under that stage's bucket
    // (the contract's own tables); any other kind takes the
    // contract's job-stage default ("report").
    const retryBucket = (
      ["feed", "generate", "store", "serve", "deliver"] as const
    ).includes(kind)
      ? STAGE_RETRY_BUCKET[runnerStageForPipelineStage(kind)]
      : undefined;
    return {
      stage: jobStageId(path),
      execution: mode.concurrency,
      timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
      pacing: mode.pacing,
      ...(retryBucket ? { retryBucket } : {}),
    };
  }

  private async clearStageDesired(jobId: string, stageId: string): Promise<void> {
    const instance = await this.requireInstance(jobId);
    if (!instance.stageDesired || !(stageId in instance.stageDesired)) return;
    const stageDesired = { ...instance.stageDesired };
    delete stageDesired[stageId];
    await this.deps.stores.instances.saveInstance({
      ...instance,
      stageDesired: Object.keys(stageDesired).length > 0 ? stageDesired : null,
      updatedAt: this.iso(),
    });
  }

  /**
   * Honor a stage control request recorded for a stage that has
   * not started yet (the driver reaching it IS the boundary):
   * stop marks its units stopped and stops the run there;
   * cancel marks them cancelled and cancels the run — the
   * stage never executes, and its downstream never proceeds.
   */
  private async honorStageControl(
    ctx: RunContext,
    plan: StageRunnerPlan,
    path: string,
  ): Promise<void> {
    const stageId = plan.stages[0].stage;
    const instance = await this.requireInstance(ctx.jobId);
    const action = instance.stageDesired?.[stageId];
    if (!action) return;
    await this.clearStageDesired(ctx.jobId, stageId);
    const units = plan.units.length > 0 ? plan.units : [{ unitId: plan.runId }];
    if (action === "cancel") {
      for (const unit of units) {
        const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
        this.setEntry(ctx, {
          stage: stageId,
          unitId: unit.unitId,
          status: "cancelled",
          attempt: prior?.attempt ?? 0,
          updatedAt: this.iso(),
        });
      }
      await this.persistLedger(ctx);
      await publishStageAction(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        stageId,
        action: "cancelled",
        at: this.iso(),
        detail: "stage cancelled before it ran",
      });
      throw new StageCancelled(stageId);
    }
    for (const unit of units) {
      const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
      this.setEntry(ctx, {
        stage: stageId,
        unitId: unit.unitId,
        status: "stopped",
        attempt: prior?.attempt ?? 0,
        updatedAt: this.iso(),
      });
    }
    await this.persistLedger(ctx);
    const fresh = await this.requireInstance(ctx.jobId);
    await this.setInstance({
      ...fresh,
      state: "paused",
      desiredState: "none",
      checkpoint: {
        runId: ctx.runId,
        nodePath: path,
        scopePath: ctx.scopePath,
        stepIndex: 0,
        itemIndex: 0,
        shardIndex: 0,
        childIndex: 0,
        artifactKeys: [...ctx.artifactKeys],
        updatedAt: this.iso(),
      },
    });
    await publishJobStatus(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      state: "paused",
      at: this.iso(),
      detail: stageId,
    });
    await publishStageAction(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      stageId,
      action: "stopped",
      at: this.iso(),
      detail: "stage stopped before it ran",
    });
    throw new RunStopped("paused");
  }

  /**
   * A step boundary: honor pause/cancel requests (run-level on
   * the instance, per-stage in stageDesired), persist the
   * ledger (with the in-flight unit's progress) and the resume
   * cursor when a checkpoint is due (every `countAsStep`
   * completions at the configured granularity, or whenever a
   * stop is honored).
   */
  private async boundary(
    ctx: RunContext,
    cursor: Omit<JobCheckpoint, "runId" | "scopePath" | "artifactKeys" | "updatedAt"> & {
      unitId?: string | null;
    },
    countAsStep: boolean,
  ): Promise<void> {
    const instance = await this.requireInstance(ctx.jobId);
    const cursorStageId = jobStageId(cursor.nodePath);
    const activeStageIds = new Set([...ctx.activeUnits.values()].map((a) => a.stageId));

    // Cancellation first: run-level, or a stage-level cancel for
    // the cursor's stage or any in-flight stage.
    const cancelStageId =
      instance.desiredState === "cancel"
        ? cursorStageId
        : [cursorStageId, ...activeStageIds].find(
            (s) => instance.stageDesired?.[s] === "cancel",
          );
    if (cancelStageId) {
      for (const active of ctx.activeUnits.values()) {
        if (active.stageId !== cancelStageId) continue;
        const prior = this.entryFor(ctx.ledger, active.stageId, active.unitId);
        if (prior) {
          this.setEntry(ctx, { ...prior, status: "cancelled", updatedAt: this.iso() });
        }
      }
      await this.persistLedger(ctx);
      if (instance.desiredState !== "cancel") {
        await this.clearStageDesired(ctx.jobId, cancelStageId);
      }
      await publishStageAction(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        stageId: cancelStageId,
        action: "cancelled",
        at: this.iso(),
      });
      throw new StageCancelled(cancelStageId);
    }

    if (countAsStep) ctx.stepsSinceCheckpoint += 1;
    const due = ctx.stepsSinceCheckpoint >= ctx.currentGranularity;
    const stagePauseId = [cursorStageId, ...activeStageIds].find(
      (s) => instance.stageDesired?.[s] === "pause",
    );
    const pausing = instance.desiredState === "pause" || stagePauseId !== undefined;
    if (!pausing && !due) return;

    // The cursor's unit records its intra-unit progress (and,
    // when stopping, its stopped state); a run-level stop marks
    // every in-flight unit stopped — stopped is recorded,
    // never failed, and a resume continues each from its
    // recorded position or its persisted step hand-offs.
    const active =
      cursor.unitId != null
        ? ctx.activeUnits.get(`${cursorStageId}::${cursor.unitId}`)
        : undefined;
    if (active) {
      const prior = this.entryFor(ctx.ledger, active.stageId, active.unitId);
      if (prior) {
        this.setEntry(ctx, {
          ...prior,
          status: pausing ? "stopped" : prior.status,
          progress: { stepIndex: cursor.stepIndex, itemIndex: cursor.itemIndex },
          updatedAt: this.iso(),
        });
      }
    }
    if (pausing) {
      for (const other of ctx.activeUnits.values()) {
        if (active && other.stageId === active.stageId && other.unitId === active.unitId) {
          continue;
        }
        const prior = this.entryFor(ctx.ledger, other.stageId, other.unitId);
        if (prior && prior.status === "running") {
          this.setEntry(ctx, { ...prior, status: "stopped", updatedAt: this.iso() });
        }
      }
    }
    await this.persistLedger(ctx);

    const checkpoint: JobCheckpoint = {
      runId: ctx.runId,
      scopePath: ctx.scopePath,
      nodePath: cursor.nodePath,
      stepIndex: cursor.stepIndex,
      itemIndex: cursor.itemIndex,
      shardIndex: cursor.shardIndex,
      childIndex: cursor.childIndex,
      artifactKeys: [...ctx.artifactKeys],
      updatedAt: this.iso(),
    };
    const fresh = await this.requireInstance(ctx.jobId);
    await this.setInstance({
      ...fresh,
      state: pausing ? "paused" : fresh.state,
      desiredState: "none",
      checkpoint,
    });
    if (stagePauseId) await this.clearStageDesired(ctx.jobId, stagePauseId);
    ctx.stepsSinceCheckpoint = 0;
    await publishJobStatus(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      state: "checkpointed",
      at: this.iso(),
      detail: cursorStageId,
      artifactKeys: [...ctx.artifactKeys],
    });
    if (pausing) {
      await publishJobStatus(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        state: "paused",
        at: this.iso(),
        ...(stagePauseId ? { detail: stagePauseId } : {}),
      });
      if (active) {
        await publishStageAction(this.deps.publisher, {
          jobId: ctx.jobId,
          runId: ctx.runId,
          stageId: active.stageId,
          unitId: active.unitId,
          action: "stopped",
          at: this.iso(),
        });
      }
      throw new RunStopped("paused");
    }
  }

  private effectiveMode(ctx: RunContext, node: JobNodeConfig): JobExecutionMode {
    const mode = resolveExecutionMode({
      ...ctx.rootConfig.executionMode,
      ...(node.executionMode ?? {}),
    });
    assertExecutionModeSupported(mode);
    return mode;
  }

  /**
   * The driver for one node = one stage of the run. The plan
   * is compiled and validated by the stage runner (planRun);
   * what executes is decided by its plan functions over the
   * run's checkpoint (planNext / planStageFanout /
   * fanoutCapExceeded) — completed units are never handed back,
   * which is what makes resume exact.
   */
  private async execNode(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    input: unknown,
  ): Promise<unknown> {
    const mode = this.effectiveMode(ctx, node);
    const inMemory = node.processing?.inMemory ?? ctx.rootConfig.processing.inMemory;
    const outputKey = `${keyPart(path)}/output`;
    const stageId = jobStageId(path);
    const previousGranularity = ctx.currentGranularity;
    ctx.currentGranularity =
      node.processing?.checkpointEverySteps ?? ctx.rootConfig.processing.checkpointEverySteps;
    try {
      const shardKeys: Array<string | null> =
        mode.shape === "sharded"
          ? (node.processing?.shards ?? ctx.rootConfig.processing.shards)
          : [null];
      if (mode.shape === "sharded" && shardKeys.length === 0) {
        throw new JobPipelineError(
          "job_shards_not_configured",
          `Node "${path || "root"}" (kind "${node.kind}") is configured for the sharded execution shape but names no shard keys (processing.shards). Refusing rather than silently running monolith.`,
        );
      }
      const stage = this.stageForNode(node, path, mode);
      const plan = planRun({
        runId: ctx.runId,
        invocation: this.deps.invocation ?? "sync",
        stages: [stage],
        units: shardKeys
          .filter((k): k is string => k !== null)
          .map((unitId) => ({ unitId })),
      });

      await this.honorStageControl(ctx, plan, path);

      const entries = ctx.ledger.units.filter((u) => u.stage === stageId);
      if (
        ctx.resuming &&
        entries.length === 0 &&
        (await this.artifactExists(ctx, outputKey, inMemory))
      ) {
        // The ledger has no entries for this stage but its
        // persisted hand-off exists: the hand-off is the
        // completion proof (the stage contract's persisted
        // input/output rule), so the stage is read back.
        return this.readArtifact(ctx, outputKey, inMemory);
      }

      let next = planNext(plan, ctx.ledger);
      if (!next) {
        if (entries.some((e) => e.status === "cancelled")) {
          throw new StageCancelled(stageId);
        }
        if (await this.artifactExists(ctx, outputKey, inMemory)) {
          return this.readArtifact(ctx, outputKey, inMemory);
        }
        // The ledger calls the stage complete but its hand-off
        // is gone (in-memory volatility): re-plan with the
        // stage's entries cleared and execute — never fabricate
        // a completion.
        ctx.ledger.units = ctx.ledger.units.filter((u) => u.stage !== stageId);
        await this.persistLedger(ctx);
        next = planNext(plan, ctx.ledger);
      }

      const items = node.inputs?.items ?? ctx.rootConfig.inputs.items;
      const unitOutputs = new Map<string, unknown>();
      while (next) {
        const fanout = planStageFanout(next.stage, next.units);
        const note = fanoutCapExceeded(fanout);
        if (note && !ctx.notes.includes(note)) ctx.notes.push(note);
        const execute = async (unit: { unitId: string }): Promise<void> => {
          const out = await this.executeUnit(ctx, plan, next!.stage, unit, node, path, input, {
            mode,
            inMemory,
            items,
            shardIndex: shardKeys.indexOf(unit.unitId),
          });
          unitOutputs.set(unit.unitId, out);
        };
        if (next.stage.execution === "parallel" && fanout.started.length > 1) {
          await Promise.all(fanout.started.map((unit) => execute(unit)));
        } else {
          for (const unit of fanout.started) await execute(unit);
        }
        next = planNext(plan, ctx.ledger);
      }

      // Compose the node's own output from its units.
      let current: unknown;
      if (mode.shape === "sharded") {
        const byShard: Record<string, unknown> = {};
        for (const key of shardKeys) {
          const shardKey = key as string;
          byShard[shardKey] = unitOutputs.has(shardKey)
            ? unitOutputs.get(shardKey)
            : await this.readArtifact(
                ctx,
                `${keyPart(path)}/shard-${encodeURIComponent(shardKey)}/output`,
                inMemory,
              );
        }
        current = byShard;
      } else {
        current = unitOutputs.has(ctx.runId)
          ? unitOutputs.get(ctx.runId)
          : await this.readArtifact(ctx, outputKey, inMemory);
      }

      // The stage's own produced artifact (its units' composed
      // output, before children chain onto it): the persisted
      // input every child stage — and any later stage action on
      // a child — reads by key, per the stage contract.
      await this.writeArtifact(ctx, `${keyPart(path)}/stage-output`, current ?? null, inMemory);

      // Children.
      const children = node.children ?? [];
      if (children.length > 0) {
        if (mode.concurrency === "parallel") {
          const cap = stageMaxParallel(stage);
          const results: unknown[] = new Array(children.length);
          let nextChild = 0;
          const workers = Array.from(
            { length: Math.min(cap, children.length) },
            async (): Promise<void> => {
              while (nextChild < children.length) {
                const index = nextChild++;
                results[index] = await this.execNode(
                  ctx,
                  children[index],
                  childPath(path, index),
                  current,
                );
              }
            },
          );
          await Promise.all(workers);
          current = results;
        } else {
          for (let i = 0; i < children.length; i++) {
            await this.boundary(
              ctx,
              {
                nodePath: path,
                stepIndex: (node.steps ?? []).length,
                itemIndex: 0,
                shardIndex: 0,
                childIndex: i,
                unitId: null,
              },
              false,
            );
            current = await this.execNode(ctx, children[i], childPath(path, i), current);
          }
        }
      }

      await this.writeArtifact(ctx, outputKey, current ?? null, inMemory);
      return current;
    } finally {
      ctx.currentGranularity = previousGranularity;
    }
  }

  /**
   * Execute one (stage, unit) under the stage contract: the
   * claim (a running entry with its attempt count) is
   * persisted BEFORE the unit acts; processing failures retry
   * within the stage's pipelinePolicy budget (poison — coded
   * configuration errors — never retries); the unit's output
   * persists before its entry completes, and the transition
   * publishes last.
   */
  private async executeUnit(
    ctx: RunContext,
    plan: StageRunnerPlan,
    stage: StageRunnerStage,
    unit: { unitId: string },
    node: JobNodeConfig,
    path: string,
    input: unknown,
    eff: {
      mode: JobExecutionMode;
      inMemory: boolean;
      items: unknown[];
      shardIndex: number;
    },
  ): Promise<unknown> {
    const stageId = stage.stage;
    const shardKey = plan.units.length > 0 ? unit.unitId : null;
    const budget = resolveStageRetryBudget(this.policy, stage);
    const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
    const force = ctx.forceStage === path;
    // The starting position: a forced re-run starts from the
    // stage's input; a stopped unit continues from its recorded
    // progress; a unit of a RESUMED run derives its position
    // from its persisted hand-offs; a fresh run starts at zero.
    // (Deriving on a fresh run would let a colliding run id's
    // artifacts skip steps — the run id is the claim scope, and
    // a fresh dispatch owns none of its predecessor's effects.)
    let resume = force
      ? { stepIndex: 0, itemIndex: 0 }
      : prior?.status === "stopped"
        ? {
            stepIndex: prior.progress?.stepIndex ?? 0,
            itemIndex: prior.progress?.itemIndex ?? 0,
          }
        : ctx.resuming
          ? await this.deriveResumePosition(
              ctx,
              node,
              path,
              shardKey,
              eff.mode,
              eff.inMemory,
              eff.items,
            )
          : { stepIndex: 0, itemIndex: 0 };

    const activeKey = `${stageId}::${unit.unitId}`;
    ctx.activeUnits.set(activeKey, {
      stageId,
      nodePath: path,
      unitId: unit.unitId,
      shardKey,
      shardIndex: eff.shardIndex,
    });
    try {
      let tries = 0;
      for (;;) {
        tries += 1;
        const claimed = this.entryFor(ctx.ledger, stageId, unit.unitId);
        this.setEntry(ctx, {
          stage: stageId,
          unitId: unit.unitId,
          status: "running",
          attempt: (claimed?.attempt ?? 0) + 1,
          updatedAt: this.iso(),
          ...(resume.stepIndex > 0 || resume.itemIndex > 0
            ? { progress: { ...resume } }
            : {}),
        });
        await this.persistLedger(ctx);
        try {
          const out = await this.withUnitDeadline(stage, () =>
            this.execSteps(ctx, node, path, input, {
              mode: eff.mode,
              inMemory: eff.inMemory,
              items: eff.items,
              shardKey,
              shardIndex: eff.shardIndex,
              resumeStep: resume.stepIndex,
              resumeItem: resume.itemIndex,
            }),
          );
          if (shardKey !== null) {
            await this.writeArtifact(
              ctx,
              `${keyPart(path)}/shard-${encodeURIComponent(shardKey)}/output`,
              out ?? null,
              eff.inMemory,
            );
          }
          const done = this.entryFor(ctx.ledger, stageId, unit.unitId);
          this.setEntry(ctx, {
            stage: stageId,
            unitId: unit.unitId,
            status: "completed",
            attempt: done?.attempt ?? tries,
            updatedAt: this.iso(),
          });
          await this.persistLedger(ctx);
          await publishStageAction(this.deps.publisher, {
            jobId: ctx.jobId,
            runId: ctx.runId,
            stageId,
            unitId: unit.unitId,
            action: "completed",
            at: this.iso(),
          });
          return out;
        } catch (error) {
          if (error instanceof RunStopped) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const attemptNow =
            this.entryFor(ctx.ledger, stageId, unit.unitId)?.attempt ?? tries;
          if (error instanceof JobPipelineError && error.code === "job_stage_timed_out") {
            this.setEntry(ctx, {
              stage: stageId,
              unitId: unit.unitId,
              status: "timed_out",
              attempt: attemptNow,
              error: message,
              updatedAt: this.iso(),
            });
            await this.persistLedger(ctx);
            await publishStageAction(this.deps.publisher, {
              jobId: ctx.jobId,
              runId: ctx.runId,
              stageId,
              unitId: unit.unitId,
              action: "timed_out",
              at: this.iso(),
              detail: message,
            });
            throw error;
          }
          // Poison (a coded configuration error — an unknown
          // step, an unconfigured shard) can never succeed on a
          // retry: dead-letter it immediately, per the stage
          // contract's failure handling. A step's processing
          // failure (job_step_failed, or an uncoded throw)
          // retries within the stage's budget.
          const retryable =
            error instanceof JobPipelineError ? error.code === "job_step_failed" : true;
          if (retryable && tries < budget.maxAttempts) {
            await this.sleep(computeBackoffDelayMs(budget, tries));
            resume = await this.deriveResumePosition(
              ctx,
              node,
              path,
              shardKey,
              eff.mode,
              eff.inMemory,
              eff.items,
            );
            continue;
          }
          this.setEntry(ctx, {
            stage: stageId,
            unitId: unit.unitId,
            status: "failed",
            attempt: attemptNow,
            error: message,
            updatedAt: this.iso(),
          });
          await this.persistLedger(ctx);
          await publishStageAction(this.deps.publisher, {
            jobId: ctx.jobId,
            runId: ctx.runId,
            stageId,
            unitId: unit.unitId,
            action: "failed",
            at: this.iso(),
            detail: message,
          });
          throw error;
        }
      }
    } finally {
      ctx.activeUnits.delete(activeKey);
    }
  }

  /** Race a unit's execution against its stage deadline; a unit past it is timed_out. */
  private async withUnitDeadline<T>(
    stage: StageRunnerStage,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeout = this.sleep(stage.timeoutMs).then(() => {
      throw new JobPipelineError(
        "job_stage_timed_out",
        `Stage "${stage.stage}" exceeded its per-unit deadline of ${stage.timeoutMs}ms.`,
      );
    });
    return Promise.race([fn(), timeout]);
  }

  /**
   * Derive a unit's resume position from its persisted step
   * hand-offs: the first step (and, online, the first item)
   * whose output artifact is absent. Steps are idempotent at
   * their boundaries, so a position derived from what actually
   * persisted can never re-execute a completed effect.
   */
  private async deriveResumePosition(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    shardKey: string | null,
    mode: JobExecutionMode,
    inMemory: boolean,
    items: unknown[],
  ): Promise<{ stepIndex: number; itemIndex: number }> {
    const steps = node.steps ?? [];
    if (mode.pacing === "online") {
      for (let s = 0; s < steps.length; s++) {
        for (let i = 0; i < items.length; i++) {
          if (
            !(await this.artifactExists(
              ctx,
              this.stepKey(path, s, shardKey, "online", i),
              inMemory,
            ))
          ) {
            return { stepIndex: s, itemIndex: i };
          }
        }
      }
      return { stepIndex: steps.length, itemIndex: 0 };
    }
    for (let s = 0; s < steps.length; s++) {
      if (
        !(await this.artifactExists(ctx, this.stepKey(path, s, shardKey, "batch", 0), inMemory))
      ) {
        return { stepIndex: s, itemIndex: 0 };
      }
    }
    return { stepIndex: steps.length, itemIndex: 0 };
  }

  private stepKey(
    path: string,
    stepIndex: number,
    shardKey: string | null,
    pacing: "batch" | "online",
    itemIndex: number,
  ): string {
    let key = `${keyPart(path)}/step-${stepIndex}`;
    if (shardKey !== null) key += `/shard-${encodeURIComponent(shardKey)}`;
    if (pacing === "online") key += `/item-${itemIndex}`;
    return key;
  }

  private async execSteps(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    input: unknown,
    eff: {
      mode: JobExecutionMode;
      inMemory: boolean;
      items: unknown[];
      shardKey: string | null;
      shardIndex: number;
      resumeStep: number;
      resumeItem: number;
    },
  ): Promise<unknown> {
    const journal = this.deps.journal ?? identityJobStepJournal;
    const steps = node.steps ?? [];
    const unitId = eff.shardKey ?? ctx.runId;
    const invoke = async (
      stepIndex: number,
      item: unknown,
      itemIndex: number | null,
      stepInput: unknown,
    ): Promise<unknown> => {
      const stepConfig = steps[stepIndex];
      const handler = this.deps.steps.resolve(stepConfig.step);
      const stepCtx: JobStepContext = {
        jobId: ctx.jobId,
        runId: ctx.runId,
        nodePath: path,
        kind: node.kind,
        stepIndex,
        item,
        itemIndex,
        items: eff.mode.pacing === "batch" ? eff.items : [],
        shardKey: eff.shardKey,
        params: stepConfig.params ?? {},
        input: stepInput,
        now: this.iso(),
      };
      let result;
      try {
        result = await journal.do(
          `job-step:${ctx.runId}:${path || "root"}:${stepIndex}:${eff.shardKey ?? "-"}:${itemIndex ?? "-"}`,
          () => handler(stepCtx),
        );
      } catch (error) {
        if (error instanceof JobPipelineError) throw error;
        throw new JobPipelineError(
          "job_step_failed",
          `Step "${stepConfig.step}" of node "${path || "root"}" (kind "${node.kind}") failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      ctx.stepExecutions += 1;
      return result.output;
    };

    if (eff.mode.pacing === "online") {
      // Per-item chaining: item i's output of step s is item i's
      // input to step s+1. On a resume, the per-item state is
      // rebuilt from the persisted artifacts of the last
      // completed step.
      let perItem: unknown[] = eff.items.map(() => input);
      if (eff.resumeStep > 0) {
        const rebuilt: unknown[] = [];
        for (let i = 0; i < eff.items.length; i++) {
          const prior = await this.readArtifact(
            ctx,
            this.stepKey(path, eff.resumeStep - 1, eff.shardKey, "online", i),
            eff.inMemory,
          );
          rebuilt.push(prior ?? input);
        }
        perItem = rebuilt;
      }
      for (let s = eff.resumeStep; s < steps.length; s++) {
        const startItem = s === eff.resumeStep ? eff.resumeItem : 0;
        const next: unknown[] = [...perItem];
        for (let i = 0; i < startItem; i++) {
          const prior = await this.readArtifact(
            ctx,
            this.stepKey(path, s, eff.shardKey, "online", i),
            eff.inMemory,
          );
          if (prior !== null && prior !== undefined) next[i] = prior;
        }
        for (let i = startItem; i < eff.items.length; i++) {
          await this.boundary(
            ctx,
            {
              nodePath: path,
              stepIndex: s,
              itemIndex: i,
              shardIndex: eff.shardIndex,
              childIndex: 0,
              unitId,
            },
            false,
          );
          const out = await invoke(s, eff.items[i], i, perItem[i]);
          await this.writeArtifact(
            ctx,
            this.stepKey(path, s, eff.shardKey, "online", i),
            out ?? null,
            eff.inMemory,
          );
          next[i] = out;
        }
        perItem = next;
        await this.boundary(
          ctx,
          {
            nodePath: path,
            stepIndex: s + 1,
            itemIndex: 0,
            shardIndex: eff.shardIndex,
            childIndex: 0,
            unitId,
          },
          true,
        );
      }
      return perItem;
    }

    // Batch pacing.
    let current = input;
    if (eff.resumeStep > 0) {
      const prior = await this.readArtifact(
        ctx,
        this.stepKey(path, eff.resumeStep - 1, eff.shardKey, "batch", 0),
        eff.inMemory,
      );
      if (prior !== null && prior !== undefined) current = prior;
    }
    for (let s = eff.resumeStep; s < steps.length; s++) {
      await this.boundary(
        ctx,
        {
          nodePath: path,
          stepIndex: s,
          itemIndex: 0,
          shardIndex: eff.shardIndex,
          childIndex: 0,
          unitId,
        },
        false,
      );
      const out = await invoke(s, null, null, current);
      await this.writeArtifact(
        ctx,
        this.stepKey(path, s, eff.shardKey, "batch", 0),
        out ?? null,
        eff.inMemory,
      );
      current = out;
      await this.boundary(
        ctx,
        {
          nodePath: path,
          stepIndex: s + 1,
          itemIndex: 0,
          shardIndex: eff.shardIndex,
          childIndex: 0,
          unitId,
        },
        true,
      );
    }
    return current;
  }
}

/** Build the control plane from explicit parts (hosts compose this). */
export function createJobPipelineControl(deps: JobPipelineDeps): JobPipelineControl {
  return new JobPipelineControl(deps);
}
