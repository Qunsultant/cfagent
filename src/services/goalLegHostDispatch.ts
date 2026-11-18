/**
 * Issue #4858 — the goal options leg's host dispatch: one gate + one
 * start/await/read-back over the goal workflow host, following the
 * gated-cutover pattern of the earlier legs. The gate routes to the
 * host only when the leg's (broker, mode) pair derives from the
 * tenant selection, the composing goal run's id is known, the
 * residency bindings are configured, and the leg's underlyings are
 * resolvable (explicit symbols, or a universe stage input for a
 * discovery-mode leg); anything else stays on the unchanged sync
 * dispatch, which the leg retains as the gated fallback until the
 * cutover is proven by a live run.
 *
 * The host dispatch defines the options job with the leg's broker
 * pair and universe descriptor stamped on the stored request and
 * the goal run id stamped on the goal plan, creates the workflow
 * instance, awaits settlement (the manual route's 300s bound), and
 * reads the screen artifact back from the residency's stage storage
 * — the same artifact the sync path reads from the caller's storage,
 * so the leg returns the same result either way. The job definition
 * persists in the residency before the instance is created, so the
 * run is addressable after dispatch (the #4274 lesson: the goal leg
 * never persisted its job). A failed run throws the sync path's
 * failure shape; a run that completes without a screen artifact
 * refuses to answer from nothing, as the sync path does.
 *
 * The caller's engine stores do not thread here: the host run records
 * over the residency's durable stores, and per-stage control over
 * those stores awaits the control slice. The leg's delivery builders
 * are pure functions of the stamped goal run id, so the resolving
 * steps rebuild the same builders per invocation. Stage messages
 * publish through the residency's queue binding, the same queue the
 * sync dispatch publishes through.
 */
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import type { Env } from "../types";
import { discoveryBrokerStageInput } from "./discoveryService";
import type { JobRunRecorder } from "./jobPipelineEngine";
import {
  readTenantBrokerSelection,
  type TenantBrokerSelectionRead,
} from "./providerConnections";
import { optionsStageStorageFromArtifacts } from "../workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../workflows/optionsScreenPorts";
import type {
  BrokerStageInput,
  UniverseDepsStageInput,
} from "../workflows/optionsStepPorts";
import {
  awaitOptionsWorkflowRun,
  optionsWorkflowRunDepsFromEnv,
  startGoalOptionsLegWorkflow,
  type AwaitOptionsWorkflowRunOpts,
  type StartOptionsScreenWorkflowOpts,
} from "../workflows/optionsWorkflowHost";

/** The goal leg's dispatch decision: the host, or the unchanged sync dispatch. */
export interface GoalLegDispatchDecision {
  route: "host" | "sync";
  reason: string;
}

/**
 * Issue #4858 — the goal leg's dispatch gate (the goal leg's shape).
 * The host only when the leg's (broker, mode) pair derived, the
 * composing goal run's id is known, and the residency bindings are
 * configured; a discovery-mode leg additionally needs a universe
 * stage input, mirroring the seam's refusal. No login clause: the
 * leg refuses an anonymous run before dispatch, so the acting login
 * is present whenever the gate is evaluated. No gate decision is
 * logged; the run's job record shows which dispatch served it.
 */
export function goalLegDispatchRoute(input: {
  broker: BrokerStageInput | null;
  env: Env;
  goalRunId: string | null;
  hasSymbols: boolean;
  universe?: UniverseDepsStageInput;
}): GoalLegDispatchDecision {
  if (!input.broker) {
    return {
      route: "sync",
      reason:
        "no broker stage input derives from the tenant selection, so the residency could not resolve the run's own chain source",
    };
  }
  if (!input.goalRunId) {
    return {
      route: "sync",
      reason:
        "no composing goal run id is known, so the seam would refuse the leg by name",
    };
  }
  const workflow = input.env.JOB_PIPELINE_WORKFLOW;
  if (!input.env.AGENT_DB || !workflow || typeof workflow.create !== "function") {
    return {
      route: "sync",
      reason: "the workflow residency bindings are not configured in this deployment",
    };
  }
  if (!input.hasSymbols && !input.universe) {
    return {
      route: "sync",
      reason:
        "a discovery-mode goal leg needs a universe stage input to resolve its underlyings, and none travels with the run",
    };
  }
  return {
    route: "host",
    reason: "broker pair derived, goal run id known, residency bindings configured",
  };
}

/**
 * Issue #4858 — derive the leg's (broker, mode) pair from the tenant
 * broker selection through the shared derivation, and take the
 * dispatch decision. The selection names the broker whose chains the
 * run reads; the mode mirrors the platform's own environment
 * resolution with the same (env, overrideEnv) the leg's service was
 * constructed with. A failed read, or a selection the derivation
 * does not know, yields no pair — the run stays on sync, where the
 * leg runs exactly as before. The selection reader is injectable:
 * tests pass a fake, production passes nothing and the read runs
 * against the tenant store.
 */
export async function resolveGoalLegHostDispatch(
  env: Env,
  requestedEnv: "TEST" | "PROD" | undefined,
  gate: {
    goalRunId: string | null;
    hasSymbols: boolean;
    universe?: UniverseDepsStageInput;
  },
  readSelection: (env: Env) => Promise<TenantBrokerSelectionRead> = readTenantBrokerSelection,
): Promise<{ decision: GoalLegDispatchDecision; broker: BrokerStageInput | null }> {
  const read = await readSelection(env);
  const broker =
    read.status === "ok"
      ? discoveryBrokerStageInput(read.brokerId, env, requestedEnv)
      : null;
  return { decision: goalLegDispatchRoute({ broker, env, ...gate }), broker };
}

/**
 * Issue #4858 — the host dispatch's injectable seams (the
 * #4291/#4450/#4468 idiom): the workflow create call, the residency
 * stores, the await options, and the tenant selection reader. Tests
 * inject fakes; production passes nothing and the dispatch derives
 * from env.
 */
export interface GoalLegHostSeams {
  startWorkflow?: StartOptionsScreenWorkflowOpts["startWorkflow"];
  stores?: JobPipelineStores;
  runRecorder?: JobRunRecorder;
  awaitOptions?: AwaitOptionsWorkflowRunOpts;
  readSelection?: (env: Env) => Promise<TenantBrokerSelectionRead>;
}

/**
 * Issue #4858 — what the production caller threads so the leg can
 * reach the host: the Worker's env (the residency bindings live on
 * it), the requested environment the leg's service was constructed
 * with, and the universe descriptor when the caller built live
 * universe deps for the run. Absent, the leg stays on sync.
 */
export interface GoalLegHostInput {
  env: Env;
  requestedEnv?: "TEST" | "PROD";
  universe?: UniverseDepsStageInput;
  seams?: GoalLegHostSeams;
}

/**
 * Issue #4858 — one goal options leg through the goal workflow host:
 * define the options job with the leg's broker pair stamped on the
 * stored request (the seam stamps the descriptor, so the resolving
 * step decodes a pair, never a bare broker id), the universe
 * descriptor when the run carries one, and the goal run id stamped
 * on the goal plan; create the workflow instance, await settlement,
 * and return the screen artifact's result from the residency's stage
 * storage. The envelope is the sync dispatch's envelope verbatim;
 * the await bound is the manual route's (300s): a screen over live
 * chains is the same shape of work. A failed run throws the sync
 * path's failure shape; a run that completes without a screen
 * artifact refuses to answer from nothing, as the sync path does.
 */
export async function runGoalLegViaHost(args: {
  env: Env;
  request: unknown;
  runId: string;
  goalRunId: string;
  userLogin: string;
  trigger: JobRunTrigger;
  broker: BrokerStageInput;
  universe?: UniverseDepsStageInput;
  seams?: GoalLegHostSeams;
}): Promise<unknown> {
  const deps =
    args.seams?.stores && args.seams?.runRecorder
      ? { stores: args.seams.stores, runRecorder: args.seams.runRecorder }
      : optionsWorkflowRunDepsFromEnv(args.env);
  const started = await startGoalOptionsLegWorkflow(
    args.env,
    {
      runId: args.runId,
      request: args.request,
      goalRunId: args.goalRunId,
      userLogin: args.userLogin,
      trigger: args.trigger,
      broker: args.broker,
      ...(args.universe ? { universe: args.universe } : {}),
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
      `options leg failed at ${failed?.stageId ?? "unknown"}: ${failed?.error ?? "unknown reason"}`,
    );
  }
  if (view.state !== "completed") {
    throw new Error(`options leg run ${args.runId} ended ${view.state} without a result`);
  }
  if (!view.engineRunId) {
    throw new Error(
      `options leg completed but its screen artifact is missing for run ${args.runId}`,
    );
  }
  const stageStorage = optionsStageStorageFromArtifacts(deps.stores.artifacts, view.engineRunId);
  const screened = await stageStorage.get<{ result: unknown }>(
    optionsArtifactKey(args.runId, "screen"),
  );
  if (!screened || screened.result === undefined) {
    throw new Error(
      `options leg completed but its screen artifact is missing for run ${args.runId}`,
    );
  }
  return screened.result;
}
