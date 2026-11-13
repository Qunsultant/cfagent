/**
 * Issue #4289 — the options screen's durable start seam: define the
 * per-run job in the workflow residency (D1) and create the
 * JobPipelineWorkflow instance that executes it, with the workflow
 * step as the engine's journal. The mirror of the scheduled
 * pipeline jobs' start seam (scheduledTasksPipeline.ts) for the
 * options family — the same claim-check discipline (the payload carries the job id + trigger
 * only; the definition, request, and login ride the stored
 * definition, never the payload), the same refuse-by-name when the
 * residency is not configured, and the same injectable seams for
 * tests.
 *
 * The job is defined by the start call itself (one job per run —
 * the options job `options-screen:<runId>`, or the strategy job
 * `strategy-screen:<runId>` when jobKind asks for it): unlike the
 * scheduled pipeline jobs, there is no host-side definition to
 * mirror. defineJob upserts, so re-starting a run id re-defines
 * (bumping the version) rather than failing.
 *
 * The acting login rides the raw config beside the request, so the
 * resolving steps can rebuild owner-scoped ports per invocation
 * (see optionsPipelineJobs.ts). The read-back (readOptionsWorkflowRun)
 * surfaces the run's state, per-stage statuses, and the shapeReport
 * artifact through the artifact-store adapter — a caller awaiting
 * completion reads the report from the durable store, with no
 * in-memory state.
 *
 * Issue #4291 — the strategy-discovery dispatch surface over this
 * host: startStrategyScreenWorkflow pins the strategy job identity
 * and validates the request's shape before defining anything (a
 * non-strategy shape is refused synchronously by name, with no job
 * defined), and awaitOptionsWorkflowRun polls the read-back until
 * the run settles (the vehicle a future sync-leg cutover awaits on).
 * No production leg dispatches through the host yet — every strategy
 * leg is blocked by a named gap (#3960 broker selection, #4453
 * scan-run store + stage queue in the residency, universe deps that
 * do not travel); the legs stay on the sync dispatch until those
 * land, and this surface is what they cut over onto.
 */
import {
  createJobPipelineStoresFromD1,
  type JobPipelineStores,
} from "../data/createJobPipelinePorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import {
  JobPipelineControl,
  type JobRunRecorder,
} from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import type { Env } from "../types";
import {
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "./optionsScreenEngine";
import { optionsArtifactKey } from "./optionsScreenPorts";
import {
  decodeOptionsRequestShape,
  OptionsStepPortsError,
} from "./optionsStepPorts";
import { OPTIONS_PIPELINE_STAGES } from "./stageRuntimeIds";

/** What one durable options-screen start needs. */
export interface StartOptionsScreenWorkflowInput {
  /** The options run id — the job is `<kind>:<runId>`, one job per run. */
  runId: string;
  /** The dispatch request, stored on the job definition's raw config (#4066). */
  request: unknown;
  /** The acting login — rides the raw config beside the request. */
  userLogin?: string;
  trigger?: "manual" | "scheduled";
  /** The job identity: the options job (default) or the strategy job (#4271). */
  jobKind?: "options-screen" | "strategy-screen";
}

/** Injectable seams: the workflow create call and the residency stores (tests inject fakes). */
export interface StartOptionsScreenWorkflowOpts {
  startWorkflow?: (
    jobId: string,
    params: { trigger: "manual" | "scheduled" },
  ) => Promise<{ instanceId: string }>;
  stores?: JobPipelineStores;
  runRecorder?: JobRunRecorder;
}

function workflowNotConfigured(reason: string): Error {
  return new Error(`job_pipeline_workflow_not_configured: ${reason}`);
}

/**
 * Define the per-run job in the workflow residency and create the
 * workflow instance that executes it. Refuses by name when the
 * JOB_PIPELINE_WORKFLOW binding or the AGENT_DB binding the
 * residency reads is not configured.
 */
export async function startOptionsScreenWorkflow(
  env: Env,
  input: StartOptionsScreenWorkflowInput,
  opts: StartOptionsScreenWorkflowOpts = {},
): Promise<{ instanceId: string; jobId: string }> {
  const trigger = input.trigger ?? "manual";
  const jobId =
    input.jobKind === "strategy-screen"
      ? strategyScreenJobId(input.runId)
      : optionsScreenJobId(input.runId);
  const definition =
    input.jobKind === "strategy-screen"
      ? strategyScreenJobDefinition(jobId, input.request, input.userLogin)
      : optionsScreenJobDefinition(jobId, input.request, input.userLogin);

  const stores = opts.stores ?? (env.AGENT_DB ? createJobPipelineStoresFromD1(env.AGENT_DB) : null);
  if (!stores) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run was not dispatched.",
    );
  }
  const runRecorder =
    opts.runRecorder ??
    (env.AGENT_DB
      ? (() => {
          const runs = new D1JobRunRecordStore(createD1JobRunRecordDb(env.AGENT_DB));
          return {
            recordRun: (record: Parameters<JobRunRecorder["recordRun"]>[0]) =>
              runs.record(record),
            listRuns: (jobIdArg: string, limit?: number) =>
              runs.listByJob(jobIdArg, limit),
            latestRun: (jobIdArg: string) => runs.latestByJob(jobIdArg),
          };
        })()
      : null);
  if (!runRecorder) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run was not dispatched.",
    );
  }
  const defineControl = new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  });
  await defineControl.defineJob(definition);

  if (opts.startWorkflow) {
    const started = await opts.startWorkflow(jobId, { trigger });
    return { instanceId: started.instanceId, jobId };
  }
  const workflow = env.JOB_PIPELINE_WORKFLOW;
  if (!workflow || typeof workflow.create !== "function") {
    throw workflowNotConfigured(
      "the JOB_PIPELINE_WORKFLOW binding is not configured in this deployment; the run was not dispatched.",
    );
  }
  const created = await workflow.create({
    params: { jobId, trigger },
  });
  return { instanceId: created.id, jobId };
}

/** What one durable strategy-screen start needs: the options-screen start, minus the job kind (pinned to strategy). */
export type StartStrategyScreenWorkflowInput = Omit<
  StartOptionsScreenWorkflowInput,
  "jobKind"
>;

/**
 * Issue #4291 — the strategy screen's start seam: the strategy-named
 * entry point over startOptionsScreenWorkflow, pinning the strategy
 * job identity (`strategy-screen:<runId>`) and validating the
 * request's shape BEFORE defining anything. A strategy screen is a
 * panel or scan shape; a goal, manual, or comparison request is
 * refused synchronously by name — the caller learns at dispatch
 * time, with no job defined and no workflow instance created,
 * instead of watching a workflow instance fail inside. The shape
 * decode is the shared one (optionsStepPorts.ts); the resolving
 * steps re-check per invocation, so the two can never drift.
 */
export async function startStrategyScreenWorkflow(
  env: Env,
  input: StartStrategyScreenWorkflowInput,
  opts: StartOptionsScreenWorkflowOpts = {},
): Promise<{ instanceId: string; jobId: string }> {
  const shape = decodeOptionsRequestShape(input.request, input.runId);
  if (shape !== "panel" && shape !== "scan") {
    const home =
      shape === "goal"
        ? "the goal-screen host is #4290"
        : shape === "manual"
          ? "a manual-shape screen dispatches from the manual route"
          : "a comparison run is a single engine step, not a staged pipeline (#4276)";
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `strategy screen ${input.runId}: the ${shape} shape is not a strategy screen — ${home}; refusing to dispatch it under the strategy job identity`,
    );
  }
  return startOptionsScreenWorkflow(env, { ...input, jobKind: "strategy-screen" }, opts);
}

/** One stage's summary in the read-back view. */
export interface OptionsWorkflowRunStageView {
  stageId: string;
  status: string;
  error?: string;
}

/** What a caller awaiting a hosted run reads back: state, stages, and the report artifact. */
export interface OptionsWorkflowRunView {
  jobId: string;
  runId: string;
  /** The engine instance state (idle / running / paused / completed / failed / cancelled). */
  state: string;
  /** The engine run id of the latest run, when one has started. */
  engineRunId: string | null;
  stages: OptionsWorkflowRunStageView[];
  /** The shapeReport stage's artifact, when the run wrote one. */
  shapeReport?: unknown;
}

/**
 * Read a hosted run back: the instance state, one summary per
 * addressable stage, and the shapeReport artifact from the durable
 * store. Throws job_not_found (the engine's code) when no
 * definition exists in this residency.
 */
export async function readOptionsWorkflowRun(
  deps: { stores: JobPipelineStores; runRecorder: JobRunRecorder },
  jobId: string,
): Promise<OptionsWorkflowRunView> {
  const control = new JobPipelineControl({
    stores: deps.stores,
    runRecorder: deps.runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  });
  const view = await control.getJob(jobId);
  const colon = jobId.indexOf(":");
  const runId = colon >= 0 ? jobId.slice(colon + 1) : jobId;
  // The instance keeps its current run id after settlement (the
  // settle path spreads it), so the latest run's artifacts stay
  // addressable through the adapter after completion.
  const engineRunId = view.instance?.currentRunId ?? null;
  const stages: OptionsWorkflowRunStageView[] = OPTIONS_PIPELINE_STAGES.map((stageId) => {
    const stage = view.stages.find((candidate) => candidate.kind === stageId);
    const units = stage?.units ?? [];
    const failed = units.find((unit) => unit.status === "failed" || unit.error);
    const status =
      failed !== undefined
        ? "failed"
        : units.length > 0 && units.every((unit) => unit.status === "completed")
          ? "completed"
          : (units[0]?.status ?? "pending");
    return {
      stageId,
      status,
      ...(failed?.error ? { error: failed.error } : {}),
    };
  });
  let shapeReport: unknown;
  if (engineRunId) {
    const storage = optionsStageStorageFromArtifacts(deps.stores.artifacts, engineRunId);
    shapeReport = await storage.get(optionsArtifactKey(runId, "shapeReport"));
  }
  return {
    jobId,
    runId,
    state: view.instance?.state ?? "idle",
    engineRunId,
    stages,
    ...(shapeReport !== undefined ? { shapeReport } : {}),
  };
}

/** The terminal instance states: a run in any other state is still in flight. */
const TERMINAL_WORKFLOW_RUN_STATES = new Set(["completed", "failed", "cancelled"]);

/** What awaiting a hosted run needs: the poll cadence, the bound, and the injectable seams (tests inject fakes). */
export interface AwaitOptionsWorkflowRunOpts {
  /** Poll interval in ms. Default 1000. */
  intervalMs?: number;
  /** Maximum wait in ms. Default 120000. */
  timeoutMs?: number;
  /** Injectable read: defaults to readOptionsWorkflowRun over the deps. */
  readRun?: (jobId: string) => Promise<OptionsWorkflowRunView>;
  /** Injectable sleep: defaults to setTimeout (the runGoalScreenViaEngine idiom). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock: defaults to Date.now. */
  now?: () => number;
}

/**
 * Issue #4291 — await a hosted run's settlement: poll the read-back
 * until the run reaches a terminal state (completed / failed /
 * cancelled) and return the terminal view. A failed run returns its
 * view with the stage error — it does not throw — so the caller
 * decides how a failure surfaces. A run that never settles throws
 * a named timeout carrying the job id and the last observed state;
 * the run may still be in flight, and the message says how to read
 * it back. This is the vehicle a future sync-leg cutover awaits on:
 * no production caller uses it yet (every strategy leg is blocked
 * by #3960 / #4453 — see the #4291 report).
 */
export async function awaitOptionsWorkflowRun(
  deps: { stores: JobPipelineStores; runRecorder: JobRunRecorder },
  jobId: string,
  opts: AwaitOptionsWorkflowRunOpts = {},
): Promise<OptionsWorkflowRunView> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const readRun = opts.readRun ?? ((id: string) => readOptionsWorkflowRun(deps, id));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let view = await readRun(jobId);
  while (!TERMINAL_WORKFLOW_RUN_STATES.has(view.state)) {
    await sleep(intervalMs);
    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `options_workflow_run_timeout: run ${jobId} did not reach a terminal state within ${timeoutMs}ms (last state: ${view.state}); the run may still be in flight — read it back with readOptionsWorkflowRun`,
      );
    }
    view = await readRun(jobId);
  }
  return view;
}
