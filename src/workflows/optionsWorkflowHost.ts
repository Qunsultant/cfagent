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
