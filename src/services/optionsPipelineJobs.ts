/**
 * Issue #4289 — the options steps for the workflow residency: the
 * resolving registration of `options.runRoot` / `options.runStage`.
 *
 * The closure registration (registerOptionsScreenStep, in
 * optionsScreenEngine.ts) closes over per-dispatch ports and holders
 * — it cannot survive a workflow replay, which runs in a fresh
 * process with no closures. These steps resolve everything per
 * invocation instead: the dispatch request is read back out of the
 * stored job definition (rawConfig, #4066), the shape is decoded and
 * the stage ports rebuilt from the request alone (optionsStepPorts.ts,
 * the #4066 control rebuild, shared), and the stage storage is the
 * artifact-store adapter (optionsStageStorageFromArtifacts), so a
 * resumed invocation reads the earlier stages' artifacts from the
 * durable store. The step BODY is the shared one
 * (runOptionsScreenStep) — the two registrations differ only in how
 * the deps are obtained, never in what a stage does.
 *
 * The run id is the job id's suffix (one job per run — the options
 * job `options-screen:<runId>` and the strategy job
 * `strategy-screen:<runId>` share these steps, and the run id may
 * itself contain colons, so only the first segment is stripped).
 * The acting login rides the raw config beside the request (written
 * by the start seam); absent, owner-scoped stages refuse honestly
 * at execution, exactly as the inline dispatch does without one.
 *
 * Refusals are named, by code, and thrown as JobPipelineError, so
 * the engine rethrows them with their code intact instead of
 * wrapping them job_step_failed (the run record carries the
 * message): job_not_found
 * (no stored definition in this host), stage_request_missing (a
 * definition from before #4066 persisted requests),
 * stage_request_unrecognized, stage_port_unavailable (goal /
 * comparison shapes, manual shapeReport/deliver).
 */
import type { JobArtifactStore, JobDefinitionStore } from "../data/jobPipelinePorts";
import type { ScanRunStore } from "../data/scanRunPorts";
import type { Env } from "../types";
import type { OptionChainSource } from "../trading";
import {
  OPTIONS_SCREEN_ROOT_STEP,
  OPTIONS_SCREEN_STEP,
  optionsStageStorageFromArtifacts,
  resolveOptionsStageId,
  runOptionsScreenStep,
} from "../workflows/optionsScreenEngine";
import {
  assertOptionsStageRebuildable,
  decodeOptionsRequestShape,
  rebuildOptionsStepDeps,
  OptionsStepPortsError,
} from "../workflows/optionsStepPorts";
import type { OptionsScreenWorkflowDeps } from "../workflows/optionsScreenWorkflow";
import type { JobStepRegistry } from "./jobPipelineSteps";

/**
 * What the resolving options steps need: the stores the definition
 * and artifacts are read from, and the seams the per-invocation
 * rebuild binds (the Worker env, the chain source factory, the
 * scan-run store, the stage-message queue).
 */
export interface OptionsWorkflowStepDeps {
  /** The definition store the dispatch request is read back from. */
  definitions: JobDefinitionStore;
  /** The artifact store the stage storage adapter is backed by. */
  artifacts: JobArtifactStore;
  /** The Worker env — the manual leg's canonical leg needs it. */
  env?: Env;
  /**
   * The chain source one invocation fetches through, resolved from
   * the acting login + request. Absent, or returning undefined, the
   * stages fetch through no source and fail honestly at the first
   * chain fetch (the screener's no-source error, never a crash).
   */
  chainSourceFor?: (
    userLogin: string | undefined,
    request: unknown,
  ) => OptionChainSource | undefined;
  /** The scan-run store, when the residency has one (scanner-shape persist). */
  scanRunStore?: ScanRunStore;
  /** The stage-message queue. Absent, null: the host publishes nothing. */
  queue?: OptionsScreenWorkflowDeps["queue"];
}

/** The options run id is the job id after its first segment (the run id itself may contain colons). */
function optionsRunIdFromJobId(jobId: string): string {
  const colon = jobId.indexOf(":");
  return colon >= 0 ? jobId.slice(colon + 1) : jobId;
}

/**
 * Read the dispatch request (+ acting login) back out of the stored
 * job definition. Refuses by name when the definition is missing
 * from this host or carries no request.
 */
async function readStoredRequest(
  deps: OptionsWorkflowStepDeps,
  jobId: string,
  runId: string,
): Promise<{ request: unknown; userLogin?: string }> {
  const definition = await deps.definitions.getDefinition(jobId);
  if (!definition) {
    throw new OptionsStepPortsError(
      "job_not_found",
      `options run ${runId}: no engine record for job ${jobId} in this host — the run was dispatched on another host, in-memory, or before the engine routing; re-dispatch the screen`,
    );
  }
  const rawConfig = definition.rawConfig as {
    request?: unknown;
    userLogin?: unknown;
  } | null;
  const request = rawConfig?.request;
  if (request === undefined) {
    throw new OptionsStepPortsError(
      "stage_request_missing",
      `options run ${runId}: the stored job definition carries no dispatch request — the run was dispatched before #4066 persisted requests, so no stage can be rebuilt; re-dispatch the screen`,
    );
  }
  return {
    request,
    ...(typeof rawConfig?.userLogin === "string" ? { userLogin: rawConfig.userLogin } : {}),
  };
}

/**
 * Register the resolving `options.runRoot` / `options.runStage`
 * steps on a registry. The root produces the stored dispatch
 * request as the run's hand-off (the #4066 contract: without it no
 * stage has a persisted input); each stage step resolves its deps
 * per invocation and executes the shared step body.
 */
export function registerOptionsWorkflowSteps(
  registry: JobStepRegistry,
  deps: OptionsWorkflowStepDeps,
): JobStepRegistry {
  registry.register(OPTIONS_SCREEN_ROOT_STEP, async (ctx) => {
    const runId = optionsRunIdFromJobId(ctx.jobId);
    const { request } = await readStoredRequest(deps, ctx.jobId, runId);
    return {
      output: request,
      descriptor: `options screen ${runId} input`,
    };
  });
  registry.register(OPTIONS_SCREEN_STEP, async (ctx) => {
    const stageId = resolveOptionsStageId(ctx.params);
    const runId = optionsRunIdFromJobId(ctx.jobId);
    const { request, userLogin } = await readStoredRequest(deps, ctx.jobId, runId);
    const shape = decodeOptionsRequestShape(request, runId);
    // Refuse unrebuildable shapes/stages before any execution.
    assertOptionsStageRebuildable(shape, stageId, runId);
    const stepDeps = rebuildOptionsStepDeps({
      runId,
      ...(userLogin ? { userLogin } : {}),
      request,
      shape,
      // Scoped by the ENGINE run id: a resumed run re-uses it, so
      // its artifacts stay readable across executions.
      storage: optionsStageStorageFromArtifacts(deps.artifacts, ctx.runId),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.chainSourceFor
        ? { chainSource: deps.chainSourceFor(userLogin, request) }
        : {}),
      ...(deps.scanRunStore ? { scanRunStore: deps.scanRunStore } : {}),
      ...(deps.queue !== undefined ? { queue: deps.queue } : {}),
    });
    return runOptionsScreenStep(ctx, stepDeps);
  });
  return registry;
}
