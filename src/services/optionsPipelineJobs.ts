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
 * Issue #4451 — the resolving `comparison.run` step registers here
 * too, on the same deps: the comparison job is a single engine step
 * (#4276), so its resolving step rebuilds the whole comparison per
 * invocation — the snapshot fetch through the residency's chain
 * source, the core's agent fns, the question from the stored
 * request — and executes the real core (runProductionComparison).
 * The ledger is the one seam the residency cannot rebuild: no D1
 * comparison-ledger adapter exists, so the step runs with
 * ledgerSql null (the accepted-absent discipline — the run
 * compares, and no ledger rows are written). The step's output
 * contract is the closure step's: `{ runId }` as the hand-off.
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
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type OptionChainSource,
  type RiskProfile,
  type StrategyRequest,
  type StrategyScreenFilter,
} from "../trading";
import {
  buildComparisonQuestion,
  kernelSnapshotFromDataSnapshot,
  runProductionComparison,
} from "./comparisonRunner";
import {
  COMPARISON_STEP,
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

/** The risk profiles the stored comparison request may carry (the trading RiskProfile union). */
const COMPARISON_RISK_PROFILES: readonly RiskProfile[] = ["conservative", "balanced", "aggressive"];

/**
 * Issue #4451 — decode the stored comparison request: the strategy
 * request (with a symbol), the risk profile, and the optional
 * strategy filter. Refuses by name when the stored shape cannot
 * rebuild a comparison — the run must be re-dispatched, never
 * guessed.
 */
function decodeComparisonRequest(
  request: unknown,
  runId: string,
): {
  strategyRequest: StrategyRequest;
  riskProfile: RiskProfile;
  strategyFilter?: StrategyScreenFilter;
} {
  const comparisonRequest = (
    request as { classInput?: { comparisonRequest?: unknown } } | null
  )?.classInput?.comparisonRequest;
  if (!comparisonRequest || typeof comparisonRequest !== "object") {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `comparison run ${runId}: the stored request's classInput.comparisonRequest is not an object — the comparison cannot be rebuilt; re-dispatch the comparison`,
    );
  }
  const candidate = comparisonRequest as {
    request?: unknown;
    riskProfile?: unknown;
    strategyFilter?: unknown;
  };
  const strategyRequest = candidate.request;
  if (
    !strategyRequest ||
    typeof strategyRequest !== "object" ||
    typeof (strategyRequest as { symbol?: unknown }).symbol !== "string" ||
    (strategyRequest as { symbol: string }).symbol.trim().length === 0
  ) {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `comparison run ${runId}: the stored comparisonRequest carries no strategy request with a symbol — the comparison cannot be rebuilt; re-dispatch the comparison`,
    );
  }
  const riskProfile = candidate.riskProfile ?? "balanced";
  if (
    typeof riskProfile !== "string" ||
    !(COMPARISON_RISK_PROFILES as readonly string[]).includes(riskProfile)
  ) {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `comparison run ${runId}: the stored comparisonRequest carries an unrecognized riskProfile ${JSON.stringify(candidate.riskProfile)} — the comparison cannot be rebuilt; re-dispatch the comparison`,
    );
  }
  const strategyFilter = candidate.strategyFilter;
  if (strategyFilter !== undefined && (typeof strategyFilter !== "object" || strategyFilter === null)) {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `comparison run ${runId}: the stored comparisonRequest carries a strategyFilter that is not an object — the comparison cannot be rebuilt; re-dispatch the comparison`,
    );
  }
  return {
    strategyRequest: strategyRequest as StrategyRequest,
    riskProfile: riskProfile as RiskProfile,
    ...(strategyFilter !== undefined
      ? { strategyFilter: strategyFilter as StrategyScreenFilter }
      : {}),
  };
}

/**
 * Register the resolving `options.runRoot` / `options.runStage`
 * steps on a registry. The root produces the stored dispatch
 * request as the run's hand-off (the #4066 contract: without it no
 * stage has a persisted input); each stage step resolves its deps
 * per invocation and executes the shared step body.
 *
 * Issue #4451: the resolving `comparison.run` step registers here
 * too, on the same deps — the comparison job's single step,
 * rebuilding the whole comparison per invocation (snapshot fetch,
 * core agent fns, question) and executing the real core. A
 * non-comparison shape under this step refuses by name, with its
 * own seam to dispatch through.
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
  registry.register(COMPARISON_STEP, async (ctx) => {
    const runId = optionsRunIdFromJobId(ctx.jobId);
    const { request, userLogin } = await readStoredRequest(deps, ctx.jobId, runId);
    const shape = decodeOptionsRequestShape(request, runId);
    if (shape !== "comparison") {
      const home =
        shape === "panel" || shape === "scan"
          ? "dispatch it through the strategy seam (startStrategyScreenWorkflow, #4291)"
          : shape === "goal"
            ? "dispatch it through the goal seam (startGoalOptionsLegWorkflow, #4290)"
            : "a manual-shape screen dispatches from the manual route";
      throw new OptionsStepPortsError(
        "stage_port_unavailable",
        `comparison run ${runId}: the comparison step executes comparison runs only — this request decodes as the ${shape} shape; ${home}`,
      );
    }
    const { strategyRequest, riskProfile, strategyFilter } = decodeComparisonRequest(
      request,
      runId,
    );
    // Env is REQUIRED: without it the llm arm cannot generate and
    // the hybrid arm cannot rank; a quant-only "comparison" would
    // silently equal the quant order and misrepresent itself as
    // three arms (the NLQ runner's discipline).
    if (!deps.env) {
      throw new OptionsStepPortsError(
        "stage_port_unavailable",
        `comparison run ${runId}: no environment is bound in this residency, so the llm and hybrid arms cannot run — a quant-only comparison would misrepresent itself as three arms; bind the Worker env and re-dispatch`,
      );
    }
    const dataAgent = new OptionsDataAgent(
      new DynamicOptionsScreener(deps.chainSourceFor?.(userLogin, request)),
    );
    const snapshot = kernelSnapshotFromDataSnapshot(
      await dataAgent.loadSnapshot(strategyRequest),
    );
    if ((snapshot.contracts ?? []).length === 0) {
      // The NLQ runner's discipline: an empty snapshot is a
      // failure, not an empty answer — a silent empty comparison
      // would hide a data problem.
      throw new Error(
        `Comparison snapshot for ${snapshot.symbol} has no screened contracts.`,
      );
    }
    const riskAgent = new StrategyRiskAgent();
    const recommender = new RecommendationAgent();
    await runProductionComparison({
      snapshot,
      request: strategyRequest,
      question: buildComparisonQuestion(strategyRequest),
      riskProfile,
      ...(strategyFilter !== undefined ? { strategyFilter } : {}),
      buildFn: (contracts, req) => riskAgent.buildStrategies(contracts, req as StrategyRequest),
      rankFn: (candidates, req, profile) =>
        recommender.rank(candidates, req as unknown as StrategyRequest, profile),
      screenFn: (candidates, filter) => riskAgent.screenStrategies(candidates, filter),
      env: deps.env,
      // No ledger sink in the residency: no D1 comparison-ledger
      // adapter exists, so the run compares and writes no ledger
      // rows (the accepted-absent discipline, recorded on #4451).
      ledgerSql: null,
      runId,
    });
    return {
      output: { runId },
      descriptor: `comparison run ${runId}`,
    };
  });
  return registry;
}
