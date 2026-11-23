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
 * Issue #5270 — the start is idempotent per run id. A re-dispatch
 * of a job whose instance is still in flight attaches to that
 * instance (no re-define, no second create) instead of minting a
 * duplicate; a paused job refuses by name (resume goes through the
 * control plane). The real-binding create rides the #2989 managed
 * seam with the deterministic id `workflowIdForJob(jobId)`, so two
 * dispatches racing past the residency check converge on one
 * instance. No fallback id: the derived id is always valid for
 * these job shapes and always the actual id.
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
 * the run settles (the vehicle a sync-leg cutover awaits on).
 * Issue #4468 — the NLQ panel leg dispatches through the host,
 * gated (the gate and the unchanged sync fallback live in
 * discoveryService.ts); issue #4469 — the NLQ scan leg dispatches
 * through the host, gated (the gate and the unchanged sync
 * fallback live in nlqOptionsStrategy.ts, with host-side
 * persistence after settlement); the remaining strategy legs stay
 * on the sync dispatch until their cutover slices land (firer
 * #4470, shard #4471, evaluate #4472), and this surface is what
 * they cut over onto.
 *
 * Issue #4290 — the goal leg's dispatch surface over this host:
 * startGoalOptionsLegWorkflow validates the goal shape, the goal
 * run id, and the filter (explicit underlyingSymbols, or a
 * universe stage input, #4473) BEFORE defining anything,
 * stamps the goal run id on the stored request (the resolving steps
 * rebuild the leg's delivery builders from it), and dispatches
 * under the options job identity — the same identity the leg's sync
 * dispatch defines today. The goal leg itself stays on the sync
 * dispatch until its cutover gaps land (binding reachability;
 * broker selection travels as a stage input since #3960); this
 * surface is what it cuts over onto.
 *
 * Issue #4451 — the comparison leg's dispatch surface over this
 * host: startComparisonWorkflow validates the comparison shape
 * BEFORE defining anything and dispatches under the comparison job
 * identity (`comparison:<runId>`, #4276) — the same identity the
 * sync dispatch defines today. The resolving `comparison.run` step
 * rebuilds the whole comparison per invocation (optionsPipelineJobs.ts).
 * The read-back is comparison-aware: a comparison run has one
 * stage, not eight, and writes no shapeReport. No production
 * comparison leg dispatches through the host yet — the comparison
 * leg's cutover is not filed separately (see the #4451 report),
 * and the legs stay on the sync dispatch until the cutover slice
 * lands (broker selection travels as a stage input since #3960).
 *
 * Issue #4450 — the first production leg dispatches through the
 * host: the manual route sends gated symbol-scoped screens through
 * startOptionsScreenWorkflow and awaits settlement with
 * awaitOptionsWorkflowRun, reading the screen + report artifacts
 * back through the artifact-store adapter. The gate (the route's
 * manualScreenDispatchRoute) keeps every other manual screen on
 * the unchanged sync dispatch until the cutover slices lift it
 * (#4473 landed: universe deps travel as a stage input; #3960
 * landed: broker selection travels as a stage input).
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
  type JobStageView,
} from "../services/jobPipelineEngine";
import { createJobPipelineControl } from "../services/jobPipelineControlFactory";
import { JobPipelineError } from "../services/jobPipelineConfig";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import {
  buildOptionsChainJobDefinition,
  optionsChainJobId,
} from "../services/optionsChainJobDefinition";
import type { Env, ShardChainContext } from "../types";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import {
  COMPARISON_JOB_ID_PREFIX,
  comparisonJobDefinition,
  comparisonJobId,
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
  stampBrokerStageInput,
  stampUniverseDepsStageInput,
  validateBrokerStageInput,
  validateUniverseDepsStageInput,
  type BrokerStageInput,
  type UniverseDepsStageInput,
} from "./optionsStepPorts";
import { OPTIONS_PIPELINE_STAGES } from "./stageRuntimeIds";
import { startManagedWorkflowInstance } from "./workflowInstanceSeam";
import { workflowIdForJob } from "./workflowPorts";

/** What one durable options-screen start needs. */
export interface StartOptionsScreenWorkflowInput {
  /** The options run id — the job is `<kind>:<runId>`, one job per run. */
  runId: string;
  /** The dispatch request, stored on the job definition's raw config (#4066). */
  request: unknown;
  /** The acting login — rides the raw config beside the request. */
  userLogin?: string;
  trigger?: JobRunTrigger;
  /**
   * The universe stage input (#4473): a serializable descriptor
   * stamped on the stored request's classInput, from which the
   * resolving steps rebuild live universe deps per invocation —
   * so a discovery-mode leg resolves its underlyings through the
   * host. Absent, no key is stamped and the run dispatches
   * exactly as before. A malformed descriptor refuses by name
   * before anything is defined.
   */
  universe?: UniverseDepsStageInput;
  /**
   * The broker stage input (#3960): a serializable (broker, mode)
   * descriptor stamped on the stored request's classInput, from
   * which the residency factory resolves the chain source per
   * invocation — so a run fetches through the broker and mode it
   * names, per-stage/per-run. Absent, no key is stamped and the
   * run dispatches exactly as before. A malformed descriptor
   * refuses by name before anything is defined.
   */
  broker?: BrokerStageInput;
  /**
   * The job identity: the options job (default), the strategy job
   * (#4271), or the comparison job (#4276, #4451).
   */
  jobKind?: "options-screen" | "strategy-screen" | "comparison";
}

/** Injectable seams: the workflow create call and the residency stores (tests inject fakes). */
export interface StartOptionsScreenWorkflowOpts {
  startWorkflow?: (
    jobId: string,
    params: { trigger: JobRunTrigger },
  ) => Promise<{ instanceId: string }>;
  stores?: JobPipelineStores;
  runRecorder?: JobRunRecorder;
}

function workflowNotConfigured(reason: string): Error {
  return new Error(`job_pipeline_workflow_not_configured: ${reason}`);
}

/** The instance states a re-dispatch may attach to: the run is still in flight. */
const ATTACHABLE_WORKFLOW_RUN_STATES = new Set(["queued", "running"]);

/**
 * Issue #5270 — attach a re-dispatch to the job's in-flight run,
 * when one exists. Reads the residency record: queued/running
 * attaches, returning the recorded workflow instance id, or the
 * derived id when the instance has not stamped one yet (the
 * derived id IS the actual id — the seam creates through the
 * managed start with no fallback, so no other id is ever used);
 * paused refuses by name (the settled instance cannot be attached
 * to — resume goes through the control plane's resumeJob, which
 * never routes through this seam); absent (job_not_found), idle,
 * or terminal returns null and the caller dispatches as today. Any
 * other read failure propagates fail-closed, never silently
 * dispatching over an unreadable record.
 */
async function attachToInFlightRun(
  control: JobPipelineControl,
  jobId: string,
): Promise<{ instanceId: string; jobId: string } | null> {
  let view;
  try {
    view = await control.getJob(jobId);
  } catch (err) {
    if (err instanceof JobPipelineError && err.code === "job_not_found") return null;
    throw err;
  }
  const instance = view.instance;
  if (!instance) return null;
  if (ATTACHABLE_WORKFLOW_RUN_STATES.has(instance.state)) {
    return {
      instanceId: instance.runWorkflowInstanceId ?? workflowIdForJob(jobId),
      jobId,
    };
  }
  if (instance.state === "paused") {
    throw new Error(
      `options_workflow_paused_resume_required: job ${jobId} is paused; resume it through the control plane (resumeJob) instead of re-dispatching — the settled workflow instance cannot be attached to`,
    );
  }
  return null;
}

/** The D1-backed run recorder for the workflow residency — the same adapter the start seam builds. */
function jobRunRecorderFromD1(db: D1Database): JobRunRecorder {
  const runs = new D1JobRunRecordStore(createD1JobRunRecordDb(db));
  return {
    recordRun: (record: Parameters<JobRunRecorder["recordRun"]>[0]) =>
      runs.record(record),
    listRuns: (jobIdArg: string, limit?: number) =>
      runs.listByJob(jobIdArg, limit),
    latestRun: (jobIdArg: string) => runs.latestByJob(jobIdArg),
  };
}

/**
 * Issue #4450 — the workflow residency's stores + run recorder from
 * env, for a caller awaiting or reading back a run it dispatched
 * through the start seam (the manual route, after
 * startOptionsScreenWorkflow). Refuses by name when the AGENT_DB
 * binding the residency reads is not configured — the same refusal
 * the start seam throws, so a caller that gated on the bindings
 * never reaches it. Construction performs no I/O; the stores read
 * the durable state on use.
 */
export function optionsWorkflowRunDepsFromEnv(env: Env): {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
} {
  if (!env.AGENT_DB) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run cannot be read back.",
    );
  }
  return {
    stores: createJobPipelineStoresFromD1(env.AGENT_DB),
    runRecorder: jobRunRecorderFromD1(env.AGENT_DB),
  };
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
  // #4473 + #3960: validate + stamp the stage inputs BEFORE
  // defining anything — a malformed descriptor refuses by name
  // with no job defined, like the shape validations in the named
  // seams. The stored request carries the stamped copy; the
  // caller's request is never mutated. The two descriptors are
  // independent keys and compose on one run.
  let request = input.request;
  if (input.universe !== undefined) {
    request = stampUniverseDepsStageInput(
      request,
      validateUniverseDepsStageInput(input.universe, input.runId),
    );
  }
  if (input.broker !== undefined) {
    request = stampBrokerStageInput(
      request,
      validateBrokerStageInput(input.broker, input.runId),
    );
  }
  const jobId =
    input.jobKind === "strategy-screen"
      ? strategyScreenJobId(input.runId)
      : input.jobKind === "comparison"
        ? comparisonJobId(input.runId)
        : optionsScreenJobId(input.runId);
  const definition =
    input.jobKind === "strategy-screen"
      ? strategyScreenJobDefinition(jobId, request, input.userLogin)
      : input.jobKind === "comparison"
        ? comparisonJobDefinition(jobId, request, input.userLogin)
        : optionsScreenJobDefinition(jobId, request, input.userLogin);

  const stores = opts.stores ?? (env.AGENT_DB ? createJobPipelineStoresFromD1(env.AGENT_DB) : null);
  if (!stores) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run was not dispatched.",
    );
  }
  const runRecorder =
    opts.runRecorder ??
    (env.AGENT_DB ? jobRunRecorderFromD1(env.AGENT_DB) : null);
  if (!runRecorder) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run was not dispatched.",
    );
  }
  // Issue #6250 — the define control builds through the ONE factory,
  // with the host env (define-only: no run executes here, but the
  // wiring must not depend on that).
  const defineControl = createJobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  }, { env });
  // Issue #5270 — attach before defining: a re-dispatch of an
  // in-flight run returns the existing instance with no define
  // (no version bump under a running run) and no create.
  const attached = await attachToInFlightRun(defineControl, jobId);
  if (attached) return attached;
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
  // Issue #5270 — the create rides the #2989 managed seam with the
  // deterministic id for this job: two dispatches racing past the
  // residency check converge on one instance (the second adopts).
  // No fallback id: the derived id is always valid for these job
  // shapes and always the actual id, so attach's derived fallback
  // is never wrong.
  const started = await startManagedWorkflowInstance(workflow, {
    id: workflowIdForJob(jobId),
    params: { jobId, trigger },
    workflowName: "JOB_PIPELINE_WORKFLOW",
  });
  return { instanceId: started.workflowId, jobId };
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
          : "dispatch it through the comparison seam (startComparisonWorkflow, #4451)";
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `strategy screen ${input.runId}: the ${shape} shape is not a strategy screen — ${home}; refusing to dispatch it under the strategy job identity`,
    );
  }
  return startOptionsScreenWorkflow(env, { ...input, jobKind: "strategy-screen" }, opts);
}

/** What one durable comparison start needs: the options-screen start, minus the job kind (pinned to comparison). */
export type StartComparisonWorkflowInput = Omit<
  StartOptionsScreenWorkflowInput,
  "jobKind"
>;

/**
 * Issue #4451 — the comparison run's start seam: the
 * comparison-named entry point over startOptionsScreenWorkflow,
 * pinning the comparison job identity (`comparison:<runId>`) and
 * validating the request's shape BEFORE defining anything. A
 * comparison run is a comparison shape; any other shape is refused
 * synchronously by name — the caller learns at dispatch time, with
 * no job defined and no workflow instance created, instead of
 * watching a workflow instance fail inside. The shape decode is
 * the shared one (optionsStepPorts.ts); the resolving step
 * re-checks per invocation, so the two can never drift.
 */
export async function startComparisonWorkflow(
  env: Env,
  input: StartComparisonWorkflowInput,
  opts: StartOptionsScreenWorkflowOpts = {},
): Promise<{ instanceId: string; jobId: string }> {
  const shape = decodeOptionsRequestShape(input.request, input.runId);
  if (shape !== "comparison") {
    const home =
      shape === "panel" || shape === "scan"
        ? "dispatch it through the strategy seam (startStrategyScreenWorkflow, #4291)"
        : shape === "goal"
          ? "dispatch it through the goal seam (startGoalOptionsLegWorkflow, #4290)"
          : "a manual-shape screen dispatches from the manual route";
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `comparison run ${input.runId}: the comparison seam dispatches comparison runs only — this request decodes as the ${shape} shape; ${home}`,
    );
  }
  return startOptionsScreenWorkflow(env, { ...input, jobKind: "comparison" }, opts);
}

/** What one durable options-chain start needs: the chain itself (the job id IS the chain id). */
export interface StartOptionsChainWorkflowInput {
  /** The chain — job id `options-chain:<chainId>`, one job per chain. */
  chain: ShardChainContext;
  /** The acting login — rides the raw config beside the chain. */
  userLogin?: string;
  trigger?: JobRunTrigger;
}

/**
 * Issue #4780 — the options sharded chain's start seam: define the
 * chain job (`options-chain:<chainId>`, buildOptionsChainJobDefinition)
 * on the D1 residency and create the workflow instance that executes
 * it. The chain is validated BEFORE defining anything — a chain with
 * no id or no symbols refuses by name with no job defined, like the
 * shape validations in the named seams. Refuses by name when the
 * JOB_PIPELINE_WORKFLOW binding or the AGENT_DB binding the residency
 * reads is not configured. The injectable seams (startWorkflow /
 * stores / runRecorder) are the start seam's shape, shared with
 * startOptionsScreenWorkflow, so tests inject fakes at the same seam.
 */
export async function startOptionsChainWorkflow(
  env: Env,
  input: StartOptionsChainWorkflowInput,
  opts: StartOptionsScreenWorkflowOpts = {},
): Promise<{ instanceId: string; jobId: string }> {
  const trigger = input.trigger ?? "scheduled";
  const definition = buildOptionsChainJobDefinition(input.chain);
  const jobId = optionsChainJobId(input.chain.chainId);

  const stores = opts.stores ?? (env.AGENT_DB ? createJobPipelineStoresFromD1(env.AGENT_DB) : null);
  if (!stores) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the chain was not dispatched.",
    );
  }
  const runRecorder =
    opts.runRecorder ?? (env.AGENT_DB ? jobRunRecorderFromD1(env.AGENT_DB) : null);
  if (!runRecorder) {
    throw workflowNotConfigured(
      "the AGENT_DB binding the workflow residency reads is not configured in this deployment; the chain was not dispatched.",
    );
  }
  // Issue #6250 — the chain define control builds through the ONE
  // factory, with the host env (define-only, as the screen one).
  const defineControl = createJobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  }, { env });
  // Issue #5270 — attach before defining, as in
  // startOptionsScreenWorkflow: a re-dispatch of an in-flight
  // chain returns the existing instance with no define and no
  // create.
  const attached = await attachToInFlightRun(defineControl, jobId);
  if (attached) return attached;
  await defineControl.defineJob(definition);

  if (opts.startWorkflow) {
    const started = await opts.startWorkflow(jobId, { trigger });
    return { instanceId: started.instanceId, jobId };
  }
  const workflow = env.JOB_PIPELINE_WORKFLOW;
  if (!workflow || typeof workflow.create !== "function") {
    throw workflowNotConfigured(
      "the JOB_PIPELINE_WORKFLOW binding is not configured in this deployment; the chain was not dispatched.",
    );
  }
  // Issue #5270 — the create rides the #2989 managed seam with the
  // deterministic id for this chain, as in startOptionsScreenWorkflow.
  const started = await startManagedWorkflowInstance(workflow, {
    id: workflowIdForJob(jobId),
    params: { jobId, trigger },
    workflowName: "JOB_PIPELINE_WORKFLOW",
  });
  return { instanceId: started.workflowId, jobId };
}

/**
 * What one durable goal-leg start needs: the options-screen start,
 * minus the job kind (pinned to the options job — the goal leg's
 * job identity), plus the composing goal run's id.
 */
export interface StartGoalOptionsLegWorkflowInput {
  /** The options leg's run id — the job is `options-screen:<runId>`, one job per run. */
  runId: string;
  /** The dispatch request, stored on the job definition's raw config (#4066). */
  request: unknown;
  /**
   * The composing goal run's id, stamped on the stored request's
   * classInput.goalPlan.goalRunId — the resolving steps rebuild the
   * leg's delivery builders from it, and the leg's report section
   * and delivery handoff stamp it. Required: a goal leg without its
   * composing run's id cannot attribute its contribution.
   */
  goalRunId?: string;
  /** The acting login — rides the raw config beside the request. */
  userLogin?: string;
  trigger?: JobRunTrigger;
  /**
   * The universe stage input (#4473): stamped on the stored
   * request's classInput beside the goal run id, so a
   * discovery-mode goal leg resolves its underlyings through the
   * host. Without it, a discovery-mode leg is refused by name.
   */
  universe?: UniverseDepsStageInput;
  /**
   * The broker stage input (#3960): stamped on the stored
   * request's classInput beside the goal run id, so the leg
   * fetches through the broker and mode the dispatch names.
   */
  broker?: BrokerStageInput;
}

/**
 * Issue #4290 — the goal options leg's start seam: the goal-named
 * entry point over startOptionsScreenWorkflow, dispatching under
 * the options job identity (`options-screen:<runId>`) — the same
 * identity runOptionsScreenViaEngine defines for the leg today, so
 * the host's job record IS the leg's job record (the #4274 blocker,
 * removed for the host path: the definition is persisted in the D1
 * residency, and the goal shape's ports rebuild per invocation).
 *
 * Three dispatch-time validations run BEFORE defining anything, so
 * the caller learns at dispatch time, with no job defined and no
 * workflow instance created, instead of watching a workflow
 * instance fail inside:
 * - the request must decode as the goal shape (any other shape is
 *   refused by name, with its own seam to dispatch through);
 * - the composing goal run's id must be supplied (goalRunId) — it
 *   is stamped on the stored request for the resolving steps;
 * - the goal filter must carry explicit underlyingSymbols, or the
 *   dispatch must carry a universe stage input: a discovery-mode
 *   leg needs universe deps to resolve its underlyings, and
 *   without either it cannot — refused by name (#4473).
 * The resolving steps re-check the shape and the stamped id per
 * invocation, so the two can never drift.
 */
export async function startGoalOptionsLegWorkflow(
  env: Env,
  input: StartGoalOptionsLegWorkflowInput,
  opts: StartOptionsScreenWorkflowOpts = {},
): Promise<{ instanceId: string; jobId: string }> {
  const shape = decodeOptionsRequestShape(input.request, input.runId);
  if (shape !== "goal") {
    const home =
      shape === "panel" || shape === "scan"
        ? "dispatch it through the strategy seam (startStrategyScreenWorkflow, #4291)"
        : shape === "manual"
          ? "a manual-shape screen dispatches from the manual route"
          : "dispatch it through the comparison seam (startComparisonWorkflow, #4451)";
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `goal screen ${input.runId}: the goal seam dispatches goal screens only — this request decodes as the ${shape} shape; ${home}`,
    );
  }
  const classInput = (input.request as { classInput?: Record<string, unknown> } | null)
    ?.classInput;
  const goalPlan = classInput?.goalPlan;
  if (!goalPlan || typeof goalPlan !== "object") {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `goal screen ${input.runId}: the stored request's classInput.goalPlan is not an object — the goal leg cannot be dispatched; re-dispatch the goal screen`,
    );
  }
  const goalRunId = input.goalRunId;
  if (typeof goalRunId !== "string" || goalRunId.length === 0) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `goal screen ${input.runId}: a goal leg needs the goal run id of the composing run — pass goalRunId to the goal seam, so the leg's report section and delivery handoff stamp it; refusing to dispatch without it`,
    );
  }
  const symbols = (goalPlan as { optionsFilter?: { underlyingSymbols?: unknown } })
    .optionsFilter?.underlyingSymbols;
  const hasSymbols =
    Array.isArray(symbols) &&
    symbols.some((symbol) => typeof symbol === "string" && symbol.trim().length > 0);
  if (!hasSymbols && input.universe === undefined) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `goal screen ${input.runId}: a discovery-mode goal leg (no underlyingSymbols in the goal filter) needs universe deps to resolve its underlyings — re-dispatch with explicit underlyingSymbols, or with a universe stage input (the universe input, #4473) so the resolving steps rebuild the deps per invocation`,
    );
  }
  const stampedRequest = {
    ...(input.request as Record<string, unknown>),
    classInput: { ...classInput, goalPlan: { ...goalPlan, goalRunId } },
  };
  return startOptionsScreenWorkflow(
    env,
    {
      runId: input.runId,
      request: stampedRequest,
      ...(input.userLogin ? { userLogin: input.userLogin } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.universe ? { universe: input.universe } : {}),
      ...(input.broker ? { broker: input.broker } : {}),
    },
    opts,
  );
}

/** One stage's summary in the read-back view. */
export interface OptionsWorkflowRunStageView {
  stageId: string;
  status: string;
  error?: string;
}

/** One stage view's summary: failed when any unit failed, completed when every unit completed, else the first unit's status. */
function toStageView(stageId: string, stage: JobStageView | undefined): OptionsWorkflowRunStageView {
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
 * store. A comparison run (#4451) has one stage — the comparison
 * node itself — and writes no shapeReport, so its view carries a
 * single `comparison` stage entry and no report. Throws
 * job_not_found (the engine's code) when no definition exists in
 * this residency.
 */
export async function readOptionsWorkflowRun(
  deps: { stores: JobPipelineStores; runRecorder: JobRunRecorder },
  jobId: string,
): Promise<OptionsWorkflowRunView> {
  // Issue #6250 — the read control builds through the ONE factory too
  // (read-only: no run executes here, so no env is passed).
  const control = createJobPipelineControl({
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
  // Issue #4451: a comparison run is one step, not an eight-stage
  // pipeline — its view carries the single comparison node, and no
  // shapeReport (a comparison run writes none). A comparison job
  // whose node is not in the view yet carries no stage entries
  // rather than eight pending ones.
  const isComparison = jobId.startsWith(`${COMPARISON_JOB_ID_PREFIX}:`);
  const stages: OptionsWorkflowRunStageView[] = isComparison
    ? (() => {
        const comparison = view.stages.find(
          (candidate) => candidate.kind === COMPARISON_JOB_ID_PREFIX,
        );
        return comparison ? [toStageView(COMPARISON_JOB_ID_PREFIX, comparison)] : [];
      })()
    : OPTIONS_PIPELINE_STAGES.map((stageId) =>
        toStageView(
          stageId,
          view.stages.find((candidate) => candidate.kind === stageId),
        ),
      );
  let shapeReport: unknown;
  if (engineRunId && !isComparison) {
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
 * it back. The manual route is its first production caller (#4450):
 * a gated manual screen awaits settlement here, then reads the
 * screen + report artifacts back through the artifact-store
 * adapter.
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
