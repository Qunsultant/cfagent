/**
 * Issue #3534 (Pipeline J1) — externalized job configuration:
 * parsing, validation, and resolution. A job is defined by
 * configuration DATA alone (AOP externalized configuration,
 * #2419): this module turns the raw stored value into the
 * resolved definition the engine executes, or refuses it with a
 * coded error. Configuration is read at run start, so a
 * configure operation applies to the next run (and to a paused
 * run's resume) without any code change.
 *
 * Execution-mode honesty: the mode is resolved from
 * configuration at dispatch, and a combination the substrate
 * cannot execute is a NAMED REFUSAL
 * (`job_execution_mode_unsupported`), never a silent downgrade.
 * The one contradictory family on this substrate: `online`
 * pacing with `sync` delivery — a synchronous dispatcher cannot
 * await the terminal state of an unbounded item stream.
 */
import {
  DEFAULT_JOB_EXECUTION_MODE,
  type JobExecutionMode,
  type JobNodeConfig,
  type JobScheduleConfig,
  type ResolvedJobConfig,
} from "../data/jobPipelinePorts";

/** Coded pipeline errors (AOP coded messages): the code is the contract, the message is for humans. */
export type JobPipelineErrorCode =
  | "job_config_invalid"
  | "job_execution_mode_unsupported"
  | "job_shards_not_configured"
  | "job_not_found"
  | "job_already_running"
  | "job_not_running"
  | "job_not_pausable"
  | "job_not_resumable"
  | "job_no_checkpoint"
  | "job_not_cancellable"
  | "job_not_retirable"
  | "job_step_unknown"
  | "job_step_failed"
  | "job_stores_unavailable"
  | "job_stage_timed_out"
  | "stage_run_mismatch"
  | "stage_no_run"
  | "stage_action_conflict"
  | "stage_action_in_flight"
  | "stage_already_completed"
  | "stage_not_runnable"
  | "stage_not_rerunnable"
  | "stage_not_stoppable"
  | "stage_not_resumable"
  | "stage_not_cancellable"
  | "stage_input_missing"
  | "stage_already_scheduled"
  | "stage_not_scheduled"
  | "stage_schedule_host_unconfigured"
  | "stage_reschedule_unsupported"
  | "stage_vocabulary_unknown"
  | "stage_vocabulary_ambiguous"
  | "stage_reschedule_failed";

export class JobPipelineError extends Error {
  readonly code: JobPipelineErrorCode;
  constructor(code: JobPipelineErrorCode, message: string) {
    super(message);
    this.name = "JobPipelineError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): JobPipelineError {
  return new JobPipelineError("job_config_invalid", message);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw invalid(`Configuration field "${field}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const CONCURRENCY = ["sequential", "parallel"] as const;
const PACING = ["batch", "online"] as const;
const DELIVERY = ["sync", "async"] as const;
const SHAPE = ["monolith", "sharded"] as const;

function modeField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(
      `Execution mode field "${field}" must be one of ${allowed.join(" | ")}; got ${JSON.stringify(value)}.`,
    );
  }
  return value as T;
}

/** Resolve a (partial) execution mode over the defaults, validating every axis. */
export function resolveExecutionMode(raw: unknown): JobExecutionMode {
  if (raw === undefined) return { ...DEFAULT_JOB_EXECUTION_MODE };
  if (!isRecord(raw)) throw invalid("Execution mode configuration must be an object.");
  return {
    concurrency: modeField(raw.concurrency, CONCURRENCY, DEFAULT_JOB_EXECUTION_MODE.concurrency, "concurrency"),
    pacing: modeField(raw.pacing, PACING, DEFAULT_JOB_EXECUTION_MODE.pacing, "pacing"),
    delivery: modeField(raw.delivery, DELIVERY, DEFAULT_JOB_EXECUTION_MODE.delivery, "delivery"),
    shape: modeField(raw.shape, SHAPE, DEFAULT_JOB_EXECUTION_MODE.shape, "shape"),
  };
}

/**
 * The substrate support rule. Throws the named refusal for the
 * contradictory family (online pacing × sync delivery). Every
 * other combination is executable on the workflow substrate:
 * concurrency and shape shape the fan-out, pacing shapes item
 * feeding, delivery shapes the dispatch contract.
 */
export function assertExecutionModeSupported(mode: JobExecutionMode): void {
  if (mode.pacing === "online" && mode.delivery === "sync") {
    throw new JobPipelineError(
      "job_execution_mode_unsupported",
      "Execution mode online+sync is unsupported: a synchronous dispatch cannot await the terminal state of an online (streaming) run. Use delivery \"async\" for online pacing.",
    );
  }
}

function resolveSchedule(raw: unknown): JobScheduleConfig {
  if (raw === undefined) return { enabled: false };
  if (!isRecord(raw)) throw invalid("Schedule configuration must be an object.");
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid('Schedule field "enabled" must be a boolean.');
  const schedule: JobScheduleConfig = { enabled };
  if (raw.cron !== undefined) {
    if (typeof raw.cron !== "string" || !raw.cron.trim()) {
      throw invalid('Schedule field "cron" must be a non-empty string.');
    }
    schedule.cron = raw.cron;
  }
  if (raw.interval !== undefined) {
    if (typeof raw.interval !== "string" || !raw.interval.trim()) {
      throw invalid('Schedule field "interval" must be a non-empty string.');
    }
    schedule.interval = raw.interval;
  }
  if (raw.registrationId !== undefined) {
    if (typeof raw.registrationId !== "string" || !raw.registrationId.trim()) {
      throw invalid('Schedule field "registrationId" must be a non-empty string.');
    }
    schedule.registrationId = raw.registrationId;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || !raw.reason.trim()) {
      throw invalid('Schedule field "reason" must be a non-empty string.');
    }
    schedule.reason = raw.reason;
  }
  if (enabled && !schedule.cron && !schedule.interval) {
    throw invalid("An enabled schedule requires a cron expression or an interval.");
  }
  return schedule;
}

function resolveNode(raw: unknown, path: string): JobNodeConfig {
  if (!isRecord(raw)) throw invalid(`Job node at ${path} must be an object.`);
  if (typeof raw.kind !== "string" || !raw.kind.trim()) {
    throw invalid(`Job node at ${path} requires a non-empty "kind".`);
  }
  const node: JobNodeConfig = { kind: raw.kind };
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw invalid(`Node ${path} "steps" must be an array.`);
    node.steps = raw.steps.map((entry, i) => {
      if (!isRecord(entry) || typeof entry.step !== "string" || !entry.step.trim()) {
        throw invalid(`Step ${i} of node ${path} requires a non-empty "step" name.`);
      }
      if (entry.params !== undefined && !isRecord(entry.params)) {
        throw invalid(`Step ${i} of node ${path} "params" must be an object.`);
      }
      return {
        step: entry.step,
        ...(entry.params !== undefined ? { params: entry.params } : {}),
      };
    });
  }
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) throw invalid(`Node ${path} "children" must be an array.`);
    node.children = raw.children.map((child, i) => resolveNode(child, `${path}/${i}`));
  }
  if (raw.inputs !== undefined) {
    if (!isRecord(raw.inputs)) throw invalid(`Node ${path} "inputs" must be an object.`);
    node.inputs = {
      ...(raw.inputs.sources !== undefined ? { sources: stringArray(raw.inputs.sources, "inputs.sources") } : {}),
      ...(raw.inputs.datasets !== undefined ? { datasets: stringArray(raw.inputs.datasets, "inputs.datasets") } : {}),
      ...(raw.inputs.items !== undefined
        ? { items: Array.isArray(raw.inputs.items) ? [...raw.inputs.items] : (() => { throw invalid(`Node ${path} "inputs.items" must be an array.`); })() }
        : {}),
    };
  }
  if (raw.processing !== undefined) {
    if (!isRecord(raw.processing)) throw invalid(`Node ${path} "processing" must be an object.`);
    const processing: NonNullable<JobNodeConfig["processing"]> = {};
    if (raw.processing.inMemory !== undefined) {
      if (typeof raw.processing.inMemory !== "boolean") {
        throw invalid(`Node ${path} "processing.inMemory" must be a boolean.`);
      }
      processing.inMemory = raw.processing.inMemory;
    }
    if (raw.processing.checkpointEverySteps !== undefined) {
      if (
        typeof raw.processing.checkpointEverySteps !== "number" ||
        !Number.isInteger(raw.processing.checkpointEverySteps) ||
        raw.processing.checkpointEverySteps < 1
      ) {
        throw invalid(`Node ${path} "processing.checkpointEverySteps" must be a positive integer.`);
      }
      processing.checkpointEverySteps = raw.processing.checkpointEverySteps;
    }
    if (raw.processing.shards !== undefined) {
      processing.shards = stringArray(raw.processing.shards, "processing.shards");
    }
    node.processing = processing;
  }
  if (raw.outputs !== undefined) {
    if (!isRecord(raw.outputs)) throw invalid(`Node ${path} "outputs" must be an object.`);
    node.outputs = {
      ...(raw.outputs.reports !== undefined ? { reports: stringArray(raw.outputs.reports, "outputs.reports") } : {}),
      ...(raw.outputs.formats !== undefined ? { formats: stringArray(raw.outputs.formats, "outputs.formats") } : {}),
      ...(raw.outputs.channels !== undefined ? { channels: stringArray(raw.outputs.channels, "outputs.channels") } : {}),
    };
  }
  if (raw.executionMode !== undefined) {
    // Validate eagerly; the merge over the job mode happens at dispatch.
    resolveExecutionMode(raw.executionMode);
    node.executionMode = raw.executionMode as JobNodeConfig["executionMode"];
  }
  if (raw.schedule !== undefined) {
    node.schedule = resolveSchedule(raw.schedule);
  }
  return node;
}

/** The raw definition shape a caller supplies: identity + name + root node + root configuration fields. */
export interface JobDefinitionInput {
  jobId: string;
  /** Always resolved (defaults to the jobId). */
  name: string;
  root: JobNodeConfig;
  config: ResolvedJobConfig;
}

/**
 * Resolve a raw externalized job definition (the value stored in
 * configuration) into its validated form. The root's own
 * inputs/processing/outputs/executionMode/schedule fields ARE the
 * job-level configuration; resolution defaults them.
 */
export function resolveJobDefinition(raw: unknown): JobDefinitionInput {
  if (!isRecord(raw)) throw invalid("A job definition must be an object.");
  if (typeof raw.jobId !== "string" || !raw.jobId.trim()) {
    throw invalid('A job definition requires a non-empty "jobId".');
  }
  if (raw.name !== undefined && typeof raw.name !== "string") {
    throw invalid('Job definition "name" must be a string.');
  }
  if (raw.root === undefined) throw invalid('A job definition requires a "root" node.');
  const root = resolveNode(raw.root, "root");
  const config: ResolvedJobConfig = {
    inputs: {
      sources: root.inputs?.sources ?? [],
      datasets: root.inputs?.datasets ?? [],
      items: root.inputs?.items ?? [],
    },
    processing: {
      // Persisted hand-offs are the default; in-memory is the explicit option.
      inMemory: root.processing?.inMemory ?? false,
      checkpointEverySteps: root.processing?.checkpointEverySteps ?? 1,
      shards: root.processing?.shards ?? [],
    },
    outputs: {
      reports: root.outputs?.reports ?? [],
      formats: root.outputs?.formats ?? [],
      channels: root.outputs?.channels ?? [],
    },
    executionMode: resolveExecutionMode(root.executionMode),
    schedule: root.schedule ?? { enabled: false },
  };
  assertExecutionModeSupported(config.executionMode);
  return {
    jobId: raw.jobId,
    name: raw.name ?? raw.jobId,
    root,
    config,
  };
}

/** Merge a configure patch into a stored raw definition (shallow at the top, deep at "root"). */
export function mergeJobConfigPatch(rawConfig: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) throw invalid("A configure patch must be an object.");
  const base = isRecord(rawConfig) ? { ...rawConfig } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "root" && isRecord(value) && isRecord(base.root)) {
      base.root = { ...(base.root as Record<string, unknown>), ...value };
    } else {
      base[key] = value;
    }
  }
  return base;
}
