/**
 * Issue #4896 — the comparison legs' shared host dispatch: one gate
 * + one start/await/read-back over the comparison workflow host
 * (#4451), used by both production legs (the NLQ runner and the
 * panel comparison route), following the gated-cutover pattern of
 * the earlier legs (#4854/#4855/#4856). The gate routes to the
 * host only when the leg's (broker, mode) pair derives, the acting
 * login is present, and the residency bindings are configured;
 * anything else stays on the unchanged sync dispatch, which both
 * legs retain as the gated fallback until the cutover is proven
 * by a live run.
 *
 * The host dispatch defines the comparison job with the leg's
 * broker pair stamped on the stored request, creates the workflow
 * instance, awaits settlement (the manual route's 300s bound), and
 * reads the comparison result artifact the resolving step wrote
 * to stage storage. A failed run throws the failed stage's error
 * verbatim — the sync dispatch rethrows the core's original error
 * verbatim, and the comparison run has exactly one stage, so no
 * context is lost. A run that completes without a result artifact
 * refuses to answer from nothing. The caller's engine stores do
 * not thread here: the host run records over the residency's
 * durable stores, and per-stage control over those stores awaits
 * #4859.
 *
 * The panel leg's three-way dispatch lives here too: the panel
 * route module is size-ratcheted (#359), so the route delegates
 * its dispatch block to runPanelComparison and keeps only the
 * fetch, the envelope, and the response. The sync branches are
 * the route's dispatch verbatim, moved, not rewritten.
 */
import type { Env } from "../types";
import type { SqlStorage } from "../orm";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type { JobRunRecorder } from "./jobPipelineEngine";
import { discoveryBrokerStageInput } from "./discoveryService";
import { mintComparisonRunId } from "./recommendationKernel";
import {
  runProductionComparison,
  type ProductionComparisonDeps,
  type ProductionComparisonResult,
} from "./comparisonRunner";
import type { BrokerStageInput } from "../workflows/optionsStepPorts";
import { optionsArtifactKey } from "../workflows/optionsScreenPorts";
import {
  COMPARISON_RESULT_ARTIFACT,
  optionsEngineStoresFromSql,
  optionsStageStorageFromArtifacts,
  runComparisonViaEngine,
} from "../workflows/optionsScreenEngine";
import {
  awaitOptionsWorkflowRun,
  optionsWorkflowRunDepsFromEnv,
  startComparisonWorkflow,
  type AwaitOptionsWorkflowRunOpts,
  type StartOptionsScreenWorkflowOpts,
} from "../workflows/optionsWorkflowHost";
import type { RiskProfile, StrategyRequest, StrategyScreenFilter } from "../trading";

/** The comparison legs' dispatch decision: the host, or the unchanged sync dispatch. */
export interface ComparisonHostDispatchDecision {
  route: "host" | "sync";
  reason: string;
}

/**
 * Issue #4896 — the comparison legs' dispatch gate (the #4468
 * panel gate's shape, plus the login clause). The host only when
 * the leg's (broker, mode) pair derived, the acting login is
 * present — the residency's chain factory yields no source
 * without one, so a login-less run would fail inside the step
 * instead of dispatching — and the residency bindings are
 * configured. No symbol gate: every comparison is symbol-scoped.
 * No universe gate: a single-symbol snapshot load never touches
 * universe deps. No gate decision is logged; the run's job record
 * shows which dispatch served it.
 */
export function comparisonDispatchRoute(input: {
  broker: BrokerStageInput | null;
  env: Env;
  userLogin?: string;
}): ComparisonHostDispatchDecision {
  if (!input.broker) {
    return {
      route: "sync",
      reason:
        "no broker stage input derives from the platform, so the residency could not resolve the run's own chain source",
    };
  }
  if (!input.userLogin) {
    return {
      route: "sync",
      reason:
        "no acting login is present, so the residency's chain factory would yield no source for the run",
    };
  }
  const workflow = input.env.JOB_PIPELINE_WORKFLOW;
  if (!input.env.AGENT_DB || !workflow || typeof workflow.create !== "function") {
    return {
      route: "sync",
      reason: "the workflow residency bindings are not configured in this deployment",
    };
  }
  return {
    route: "host",
    reason: "broker pair derived, acting login present, residency bindings configured",
  };
}

/**
 * Issue #4896 — derive the leg's (broker, mode) pair from its
 * platform id + the environment the platform was constructed with,
 * and take the dispatch decision. The derivation is the #4853
 * one, shared: the mode mirrors the platform's own environment
 * resolution with the same (env, overrideEnv) the platform was
 * constructed with.
 */
export function resolveComparisonHostDispatch(
  env: Env,
  brokerId: string,
  overrideEnv: "TEST" | "PROD" | undefined,
  userLogin?: string,
): { decision: ComparisonHostDispatchDecision; broker: BrokerStageInput | null } {
  const broker = discoveryBrokerStageInput(brokerId, env, overrideEnv);
  return { decision: comparisonDispatchRoute({ broker, env, userLogin }), broker };
}

/**
 * Issue #4896 — the host dispatch's injectable seams (the
 * #4291/#4450 idiom): the workflow create call, the residency
 * stores, and the await options. Tests inject fakes; production
 * passes nothing and the dispatch derives from env.
 */
export interface ComparisonHostSeams {
  startWorkflow?: StartOptionsScreenWorkflowOpts["startWorkflow"];
  stores?: JobPipelineStores;
  runRecorder?: JobRunRecorder;
  awaitOptions?: AwaitOptionsWorkflowRunOpts;
}

/**
 * Issue #4896 — one comparison through the comparison workflow
 * host: define the comparison job with the leg's broker pair
 * stamped on the stored request, create the workflow instance,
 * await settlement, and read the result artifact the resolving
 * step wrote back to stage storage. The envelope is the sync
 * dispatch's envelope (runComparisonViaEngine) plus the broker
 * pair, and the run id is the caller's minted id, so the job
 * record and the artifact carry one id. A failed run throws the
 * stage error verbatim, as the sync dispatch rethrows the core's
 * original error; a run that completes without a result artifact
 * refuses to answer from nothing.
 */
export async function runComparisonViaHost(args: {
  env: Env;
  request: StrategyRequest;
  riskProfile: RiskProfile;
  strategyFilter?: StrategyScreenFilter;
  runId: string;
  userLogin: string;
  broker: BrokerStageInput;
  seams?: ComparisonHostSeams;
}): Promise<ProductionComparisonResult> {
  const deps =
    args.seams?.stores && args.seams?.runRecorder
      ? { stores: args.seams.stores, runRecorder: args.seams.runRecorder }
      : optionsWorkflowRunDepsFromEnv(args.env);
  const started = await startComparisonWorkflow(
    args.env,
    {
      runId: args.runId,
      request: {
        assetClass: "options",
        runIdentity: { runId: args.runId },
        trigger: "manual",
        classInput: {
          comparisonRequest: {
            request: args.request,
            riskProfile: args.riskProfile,
            ...(args.strategyFilter !== undefined ? { strategyFilter: args.strategyFilter } : {}),
          },
        },
      },
      userLogin: args.userLogin,
      broker: args.broker,
    },
    {
      ...deps,
      ...(args.seams?.startWorkflow ? { startWorkflow: args.seams.startWorkflow } : {}),
    },
  );
  const view = await awaitOptionsWorkflowRun(deps, started.jobId, {
    timeoutMs: 300_000,
    ...(args.seams?.awaitOptions ?? {}),
  });
  if (view.state === "failed") {
    const failed = view.stages.find((stage) => stage.status === "failed");
    throw new Error(
      failed?.error ?? `Options comparison run ${args.runId} failed without a stage error`,
    );
  }
  if (view.state !== "completed") {
    throw new Error(`Options comparison run ${args.runId} ended ${view.state} without a result`);
  }
  if (!view.engineRunId) {
    throw new Error(
      `Options comparison run ${args.runId} completed but its engine run id is missing; refusing to answer from nothing.`,
    );
  }
  const stageStorage = optionsStageStorageFromArtifacts(deps.stores.artifacts, view.engineRunId);
  const result = await stageStorage.get<ProductionComparisonResult>(
    optionsArtifactKey(args.runId, COMPARISON_RESULT_ARTIFACT),
  );
  if (!result) {
    throw new Error(
      `Options comparison run ${args.runId} completed without a result artifact; refusing to answer from nothing.`,
    );
  }
  return result;
}

/**
 * Issue #4896 — the panel comparison leg's dispatch: the host
 * when the gate resolves to it, else the route's sync dispatch
 * verbatim. The host envelope carries the banded request — the
 * request the route fetched through — so the resolving step's
 * snapshot fetch matches the route's local fetch exactly (the
 * band is a fetch-only directive; the core never reads it). The
 * sync envelope carries coreArgs.request, the unbanded request
 * the route parsed, exactly as the route built it before the
 * cutover. The route keeps its local fetch on every path: the
 * response envelope needs the snapshot's fields, and the
 * no-candidates check stays pre-dispatch.
 */
export async function runPanelComparison(args: {
  env: Env;
  requestedEnv: "TEST" | "PROD" | undefined;
  userLogin: string;
  brokerId: string;
  request: StrategyRequest;
  riskProfile: RiskProfile;
  strategyFilter?: StrategyScreenFilter;
  coreArgs: ProductionComparisonDeps;
  storageSql?: SqlStorage;
  hostSeams?: ComparisonHostSeams;
}): Promise<ProductionComparisonResult> {
  const { decision, broker } = resolveComparisonHostDispatch(
    args.env,
    args.brokerId,
    args.requestedEnv,
    args.userLogin,
  );
  if (decision.route === "host" && broker) {
    return runComparisonViaHost({
      env: args.env,
      request: args.request,
      riskProfile: args.riskProfile,
      ...(args.strategyFilter !== undefined ? { strategyFilter: args.strategyFilter } : {}),
      runId: mintComparisonRunId(),
      userLogin: args.userLogin,
      broker,
      ...(args.hostSeams ? { seams: args.hostSeams } : {}),
    });
  }
  // The sync branches below are the panel route's dispatch
  // verbatim, moved here so the route stays under its size
  // ratchet (#359): the engine dispatch when the host's SQL
  // handle is available, the direct core call otherwise (the
  // #4069 accepted-absent discipline).
  const storageSql = args.storageSql;
  if (typeof storageSql?.exec === "function") {
    const runId = mintComparisonRunId();
    return runComparisonViaEngine(
      {
        runId,
        request: {
          assetClass: "options",
          runIdentity: { runId },
          trigger: "manual",
          classInput: {
            comparisonRequest: {
              request: args.coreArgs.request,
              riskProfile: args.riskProfile,
              strategyFilter: args.strategyFilter,
            },
          },
        },
        engineStores: optionsEngineStoresFromSql(storageSql, args.env),
      },
      () => runProductionComparison({ ...args.coreArgs, runId }),
    );
  }
  return runProductionComparison(args.coreArgs);
}
