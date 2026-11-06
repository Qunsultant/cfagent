/**
 * Issue #3534 (Pipeline J1) — the job-pipeline engine and control
 * plane. The control plane is the ONE management surface the UX
 * and the copilot doors consume (#3514's uniformity contract):
 * define / configure / run / pause / resume / cancel / retry /
 * status, over the data-layer stores, with every transition
 * published through the messaging ports and every terminal run
 * recorded through the platform run-record machinery
 * (buildJobRunRecord + the job-run-record store, system
 * "job-pipeline" — #3527's machinery, no second run store).
 *
 * Execution walks the recursive node tree depth-first. A node's
 * own steps run first (their output is the node's hand-off),
 * then its children — sequentially (output chains child to
 * child) or in parallel (every child receives the node's output;
 * outputs collect in order). The execution mode comes from
 * configuration, resolved per node at dispatch:
 *  - pacing batch: a step sees the full item list in one call;
 *    online: a step is invoked per item and each item's output
 *    chains to the same item of the next step.
 *  - shape monolith: one execution unit; sharded: the node's
 *    steps run once per configured shard key (a sharded node
 *    with no shard keys configured is a named refusal).
 *  - delivery sync/async shapes only the dispatch contract.
 *
 * Pause/cancel are cooperative: the control plane records the
 * desired state on the instance record; the engine honors it at
 * the next step boundary, persists a checkpoint at configurable
 * granularity, and unwinds. Resume re-reads the definition
 * (configuration is read at run start) and continues from the
 * checkpoint: completed nodes are skipped by reading back their
 * persisted node-output artifacts; the checkpoint node resumes
 * at its recorded step/item/shard indices.
 *
 * Honest limits, stated once: in-memory processing
 * (processing.inMemory) keeps hand-offs in the run's process
 * memory, so a resume in a NEW process re-executes nodes whose
 * outputs were never persisted — that volatility is exactly why
 * persisted hand-offs are the default. Under parallel fan-out a
 * checkpoint lands at segment boundaries; an in-flight segment
 * resumes from its start (steps are idempotent at boundaries).
 */
import type {
  JobCheckpoint,
  JobDefinition,
  JobExecutionMode,
  JobInstanceRecord,
  JobNodeConfig,
  JobPipelineStores,
  JobRunState,
} from "../data/jobPipelinePorts";
import type {
  JobRunRecord,
  JobRunRecordStore,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";
import { buildJobRunRecord } from "./jobRunRecords";
import {
  JobPipelineError,
  assertExecutionModeSupported,
  mergeJobConfigPatch,
  resolveExecutionMode,
  resolveJobDefinition,
} from "./jobPipelineConfig";
import type { JobStepContext, JobStepRegistry } from "./jobPipelineSteps";
import { publishJobStatus } from "./jobPipelineEvents";
import type { MessagePublisher } from "../messaging/messagingPorts";

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

export interface JobPipelineDeps {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
  /** Null when the queue substrate is unconfigured: runs proceed, status publication is skipped, store state remains the truth. */
  publisher: MessagePublisher | null;
  steps: JobStepRegistry;
  journal?: JobStepJournal;
  now?: () => Date;
  newRunId?: () => string;
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

export interface JobStatusView {
  definition: JobDefinition;
  instance: JobInstanceRecord | null;
  latestRun: JobRunRecord | undefined;
  history: JobRunRecord[];
}

/** A schedule host: the platform scheduler's registration surface (Think scheduled tasks on an agent host). */
export interface JobScheduleHost {
  schedule(spec: {
    jobId: string;
    nodePath: string;
    cron?: string;
    interval?: string;
  }): Promise<string>;
}

interface RunContext {
  deps: JobPipelineDeps;
  definition: JobDefinition;
  jobId: string;
  runId: string;
  rootConfig: JobDefinition["config"];
  scopePath: string;
  resuming: boolean;
  cursor: JobCheckpoint | null;
  memory: Map<string, unknown>;
  artifactKeys: string[];
  stepsSinceCheckpoint: number;
  currentGranularity: number;
  stepExecutions: number;
}

class RunStopped extends Error {
  constructor(readonly reason: "paused" | "cancelled") {
    super(`run ${reason}`);
    this.name = "RunStopped";
  }
}

const TERMINAL: readonly JobRunState[] = ["completed", "failed", "cancelled"];

function pathSegments(path: string): number[] {
  return path === "" ? [] : path.split("/").map((s) => Number(s));
}

function isAncestorOrSame(path: string, descendant: string): boolean {
  if (path === "") return true;
  return descendant === path || descendant.startsWith(`${path}/`);
}

function childPath(path: string, index: number): string {
  return path === "" ? `${index}` : `${path}/${index}`;
}

function keyPart(path: string): string {
  return path === "" ? "root" : path;
}

export class JobPipelineControl {
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly inflight = new Map<string, Promise<JobRunOutcome>>();

  constructor(private readonly deps: JobPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
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
    const resolved = resolveJobDefinition({
      ...(merged as Record<string, unknown>),
      jobId,
    });
    const definition: JobDefinition = {
      jobId,
      name: resolved.name,
      root: resolved.root,
      rawConfig: merged,
      config: resolved.config,
      version: existing.version + 1,
      updatedAt: this.iso(),
    };
    await this.deps.stores.definitions.saveDefinition(definition);
    return definition;
  }

  // ---- management operations --------------------------------------------

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
      cursor: null,
    });
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /** Request a pause: honored at the next step boundary; the run checkpoints and settles as paused. */
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

  /** Resume a paused run from its persisted checkpoint, under the current configuration. */
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
      cursor: instance.checkpoint,
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
    // Paused: no engine is live to honor a desired state — settle it here.
    const settled: JobInstanceRecord = {
      ...instance,
      state: "cancelled",
      desiredState: "none",
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

  /** Retry: a NEW run from the start (fresh run id, checkpoint cleared), from a terminal or paused state. */
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
      currentRunId: null,
      runStartedAt: null,
      runTrigger: null,
      lastError: null,
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(cleared);
    return this.runJob(jobId, { trigger: "manual" });
  }

  /** The status view: definition + live instance + run history from the one run-record machinery. */
  async getJob(jobId: string): Promise<JobStatusView> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.deps.stores.instances.getInstance(jobId);
    const history = await this.deps.runRecorder.listRuns(jobId, 50);
    return { definition, instance, latestRun: history[0], history };
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
  }

  private async executeRun(
    definition: JobDefinition,
    opts: {
      runId: string;
      trigger: JobRunTrigger;
      scopePath: string;
      resuming: boolean;
      cursor: JobCheckpoint | null;
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
      lastError: null,
    };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "queued", at: this.iso() });
    instance = { ...instance, state: "running" };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "running", at: this.iso() });

    const ctx: RunContext = {
      deps: this.deps,
      definition,
      jobId,
      runId: opts.runId,
      rootConfig: definition.config,
      scopePath: opts.scopePath,
      resuming: opts.resuming,
      cursor: opts.cursor,
      memory: new Map(),
      artifactKeys: opts.cursor ? [...opts.cursor.artifactKeys] : [],
      stepsSinceCheckpoint: 0,
      currentGranularity: definition.config.processing.checkpointEverySteps,
      stepExecutions: 0,
    };

    try {
      const scopeNode = this.nodeAtPath(definition.root, opts.scopePath);
      await this.execNode(ctx, scopeNode, opts.scopePath, null);
      instance = await this.requireInstance(jobId);
      const descriptor = `run ${opts.runId}: ${ctx.stepExecutions} step executions, ${ctx.artifactKeys.length} artifacts`;
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
        instance = { ...instance, state: "cancelled", desiredState: "none" };
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

  /**
   * A step boundary: honor pause/cancel requests recorded on the
   * instance, and persist a checkpoint when one is due (every
   * `countAsStep` completions at the configured granularity, or
   * whenever a pause is honored).
   */
  private async boundary(
    ctx: RunContext,
    cursor: Omit<JobCheckpoint, "runId" | "scopePath" | "artifactKeys" | "updatedAt">,
    countAsStep: boolean,
  ): Promise<void> {
    const instance = await this.requireInstance(ctx.jobId);
    if (instance.desiredState === "cancel") {
      throw new RunStopped("cancelled");
    }
    if (countAsStep) ctx.stepsSinceCheckpoint += 1;
    const due = ctx.stepsSinceCheckpoint >= ctx.currentGranularity;
    const pausing = instance.desiredState === "pause";
    if (!pausing && !due) return;
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
    await this.setInstance({
      ...instance,
      state: pausing ? "paused" : instance.state,
      desiredState: "none",
      checkpoint,
    });
    ctx.stepsSinceCheckpoint = 0;
    await publishJobStatus(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      state: "checkpointed",
      at: this.iso(),
      artifactKeys: [...ctx.artifactKeys],
    });
    if (pausing) {
      await publishJobStatus(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        state: "paused",
        at: this.iso(),
      });
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

  private async execNode(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    input: unknown,
  ): Promise<unknown> {
    const mode = this.effectiveMode(ctx, node);
    const inMemory = node.processing?.inMemory ?? ctx.rootConfig.processing.inMemory;
    const outputKey = `${keyPart(path)}/output`;
    const previousGranularity = ctx.currentGranularity;
    ctx.currentGranularity =
      node.processing?.checkpointEverySteps ?? ctx.rootConfig.processing.checkpointEverySteps;
    try {
      // Resume: a completed node (its output artifact exists) that
      // is not the checkpoint node or one of its ancestors is
      // skipped — its hand-off is read back, never re-executed.
      if (
        ctx.resuming &&
        ctx.cursor &&
        !isAncestorOrSame(path, ctx.cursor.nodePath) &&
        (await this.artifactExists(ctx, outputKey, inMemory))
      ) {
        return this.readArtifact(ctx, outputKey, inMemory);
      }

      const onCursor = ctx.resuming && ctx.cursor?.nodePath === path;
      const items = node.inputs?.items ?? ctx.rootConfig.inputs.items;
      let current = input;

      // The node's own steps, under its shard fan-out.
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
      const shardStart = onCursor ? (ctx.cursor?.shardIndex ?? 0) : 0;

      const execShard = async (
        shardKey: string | null,
        shardIndex: number,
      ): Promise<unknown> => {
        const shardOutputKey =
          shardKey === null ? null : `${keyPart(path)}/shard-${encodeURIComponent(shardKey)}/output`;
        if (shardIndex < shardStart && shardOutputKey) {
          // Shard completed before the checkpoint: read its output back.
          const prior = await this.readArtifact(ctx, shardOutputKey, inMemory);
          if (prior !== null && prior !== undefined) return prior;
        }
        const out = await this.execSteps(ctx, node, path, current, {
          mode,
          inMemory,
          items,
          shardKey,
          shardIndex,
          resumeStep: onCursor && shardIndex === shardStart ? (ctx.cursor?.stepIndex ?? 0) : 0,
          resumeItem: onCursor && shardIndex === shardStart ? (ctx.cursor?.itemIndex ?? 0) : 0,
        });
        if (shardOutputKey) await this.writeArtifact(ctx, shardOutputKey, out ?? null, inMemory);
        return out;
      };

      if (mode.concurrency === "parallel" && shardKeys.length > 1) {
        const results = await Promise.all(shardKeys.map((k, i) => execShard(k, i)));
        const byShard: Record<string, unknown> = {};
        shardKeys.forEach((k, i) => {
          byShard[k ?? "monolith"] = results[i];
        });
        current = byShard;
      } else {
        let last: unknown = current;
        const byShard: Record<string, unknown> = {};
        for (let i = 0; i < shardKeys.length; i++) {
          const out = await execShard(shardKeys[i], i);
          if (shardKeys[i] === null) last = out;
          else byShard[shardKeys[i] as string] = out;
        }
        current = mode.shape === "sharded" ? byShard : last;
      }

      // Children.
      const children = node.children ?? [];
      if (children.length > 0) {
        const childStart = onCursor ? (ctx.cursor?.childIndex ?? 0) : 0;
        if (mode.concurrency === "parallel") {
          const results = await Promise.all(
            children.map(async (child, i) => {
              const childKey = `${keyPart(childPath(path, i))}/output`;
              if (i < childStart && (await this.artifactExists(ctx, childKey, inMemory))) {
                return this.readArtifact(ctx, childKey, inMemory);
              }
              return this.execNode(ctx, child, childPath(path, i), current);
            }),
          );
          current = results;
        } else {
          for (let i = 0; i < children.length; i++) {
            if (i >= childStart) {
              await this.boundary(
                ctx,
                {
                  nodePath: path,
                  stepIndex: (node.steps ?? []).length,
                  itemIndex: 0,
                  shardIndex: 0,
                  childIndex: i,
                },
                false,
              );
            }
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
            { nodePath: path, stepIndex: s, itemIndex: i, shardIndex: eff.shardIndex, childIndex: 0 },
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
        { nodePath: path, stepIndex: s, itemIndex: 0, shardIndex: eff.shardIndex, childIndex: 0 },
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
