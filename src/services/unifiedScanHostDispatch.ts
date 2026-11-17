/**
 * Issue #4893 — the unified opportunities action's host dispatch: one
 * gate + one start/await/read-back over the strategy workflow host,
 * following the gated-cutover pattern of the earlier legs. The gate
 * routes to the host only when the leg's (broker, mode) pair derives
 * from the tenant selection and the residency bindings are configured;
 * anything else stays on the unchanged sync dispatch, which the action
 * retains as the gated fallback until the cutover is proven by a live
 * run.
 *
 * The host dispatch defines the strategy job with the leg's broker
 * pair stamped on the stored request, creates the workflow instance,
 * awaits settlement (the manual route's 300s bound), and reads the
 * shape report back from the run view. A failed run throws the sync
 * path's failure shape; a run that completes without a report refuses
 * to answer from nothing, as the sync path does.
 *
 * Persistence after settlement: the residency binds no scan-run
 * store (decided-not-to — the family lives in the caller's store,
 * and the persist stage degrades by name), so the settled result
 * saves here, through the caller's own store, with the pair's broker
 * — the broker whose chains the run actually read — and the platform
 * run id when the run carries one, exactly as the sync persist stage
 * saves under it. The save receipt rides the returned result exactly
 * as the sync persist stage's does (scan run id + persisted on
 * success, persisted:false with the result intact on a store error,
 * no receipt fields at all when no store is bound).
 *
 * The caller's engine stores do not thread here: the host run records
 * over the residency's durable stores, and per-stage control over
 * those stores awaits the control slice. Stage messages publish
 * through the residency's queue binding, the same queue the sync
 * dispatch publishes through.
 */
import type { Env } from "../types";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type { ScanRunStore } from "../data/scanRunPorts";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import type { OpportunityScanResult } from "../trading";
import { discoveryBrokerStageInput } from "./discoveryService";
import type { JobRunRecorder } from "./jobPipelineEngine";
import {
  readTenantBrokerSelection,
  type TenantBrokerSelectionRead,
} from "./providerConnections";
import type { BrokerStageInput } from "../workflows/optionsStepPorts";
import {
  awaitOptionsWorkflowRun,
  optionsWorkflowRunDepsFromEnv,
  startStrategyScreenWorkflow,
  type AwaitOptionsWorkflowRunOpts,
  type StartOptionsScreenWorkflowOpts,
} from "../workflows/optionsWorkflowHost";

/** Issue #4893 — the module's structured logger (the #3515 ratchet pins new files at zero unstructured console.* uses). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/unifiedScanHostDispatch",
});

/** The unified scan leg's dispatch decision: the host, or the unchanged sync dispatch. */
export interface UnifiedScanDispatchDecision {
  route: "host" | "sync";
  reason: string;
}

/**
 * Issue #4893 — the unified scan leg's dispatch gate (the scan leg's
 * shape). The host only when the leg's (broker, mode) pair derived
 * and the residency bindings are configured; anything else stays on
 * the unchanged sync dispatch. No symbol gate: the action refuses an
 * empty symbol list before dispatch. No universe gate: the scan shape
 * builds its filter from the request itself, and the stored request
 * carries no universe stage input. No gate decision is logged; the
 * run's job record shows which dispatch served it.
 */
export function unifiedScanDispatchRoute(input: {
  broker: BrokerStageInput | null;
  env: Env;
}): UnifiedScanDispatchDecision {
  if (!input.broker) {
    return {
      route: "sync",
      reason:
        "no broker stage input derives from the tenant selection, so the residency could not resolve the run's own chain source",
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
    reason: "broker pair derived, residency bindings configured",
  };
}

/**
 * Issue #4893 — derive the leg's (broker, mode) pair from the tenant
 * broker selection through the shared derivation, and take the
 * dispatch decision. The selection names the broker whose chains the
 * run reads; the mode mirrors the platform's own environment
 * resolution with the same (env, overrideEnv) the service was
 * constructed with. A failed read, or a selection the derivation
 * does not know, yields no pair — the run stays on sync, where the
 * engine-client resolution throws the same named error as before.
 * The selection reader is injectable: tests pass a fake, production
 * passes nothing and the read runs against the tenant store.
 */
export async function resolveUnifiedScanHostDispatch(
  env: Env,
  requestedEnv: "TEST" | "PROD" | undefined,
  readSelection: (env: Env) => Promise<TenantBrokerSelectionRead> = readTenantBrokerSelection,
): Promise<{ decision: UnifiedScanDispatchDecision; broker: BrokerStageInput | null }> {
  const read = await readSelection(env);
  const broker =
    read.status === "ok"
      ? discoveryBrokerStageInput(read.brokerId, env, requestedEnv)
      : null;
  return { decision: unifiedScanDispatchRoute({ broker, env }), broker };
}

/**
 * Issue #4893 — the host dispatch's injectable seams (the
 * #4291/#4450/#4468 idiom): the workflow create call, the residency
 * stores, and the await options. Tests inject fakes; production
 * passes nothing and the dispatch derives from env.
 */
export interface UnifiedScanHostSeams {
  startWorkflow?: StartOptionsScreenWorkflowOpts["startWorkflow"];
  stores?: JobPipelineStores;
  runRecorder?: JobRunRecorder;
  awaitOptions?: AwaitOptionsWorkflowRunOpts;
}

/**
 * Issue #4893 — one unified opportunity scan through the strategy
 * workflow host: define the strategy job with the leg's broker pair
 * stamped on the stored request (the seam stamps the descriptor, so
 * the resolving step decodes a pair, never a bare broker id), create
 * the workflow instance, await settlement, and return the shape
 * report result. The envelope is the sync dispatch's envelope
 * verbatim; the await bound is the manual route's (300s): a scan over
 * live chains is the same shape of work. A failed run throws the sync
 * path's failure shape; a run that completes without a report refuses
 * to answer from nothing, as the sync path does.
 *
 * Persistence after settlement: the settled result saves through the
 * caller's own scan-run store, with the pair's broker and the
 * platform run id when the run carries one (the sync persist stage
 * saves under the platform id when the envelope carries it; the
 * unified envelope is the one scan envelope that does).
 */
export async function runUnifiedScanViaHost(args: {
  env: Env;
  request: unknown;
  runId: string;
  userLogin: string;
  broker: BrokerStageInput;
  platformRunId?: string;
  scanRunStore?: ScanRunStore;
  seams?: UnifiedScanHostSeams;
}): Promise<OpportunityScanResult & { scanRunId?: string; persisted?: boolean }> {
  const deps =
    args.seams?.stores && args.seams?.runRecorder
      ? { stores: args.seams.stores, runRecorder: args.seams.runRecorder }
      : optionsWorkflowRunDepsFromEnv(args.env);
  const started = await startStrategyScreenWorkflow(
    args.env,
    {
      runId: args.runId,
      request: args.request,
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
      `Unified options scan failed at ${failed?.stageId ?? "unknown"}: ${failed?.error ?? "unknown reason"}`,
    );
  }
  if (view.state !== "completed") {
    throw new Error(`Unified options scan run ${args.runId} ended ${view.state} without a result`);
  }
  const report = view.shapeReport as
    | (OpportunityScanResult & { scanRunId?: string; persisted?: boolean })
    | undefined;
  if (!report) {
    throw new Error(
      "Unified options scan completed without a report artifact; refusing to answer from nothing.",
    );
  }
  if (!args.scanRunStore) {
    return report;
  }
  try {
    const saved = await args.scanRunStore.save(report, {
      userLogin: args.userLogin,
      broker: args.broker.broker,
      ...(args.platformRunId ? { id: args.platformRunId } : {}),
    });
    return { ...report, scanRunId: saved.id, persisted: true };
  } catch (err) {
    structuredLog.error("unifiedScanHostDispatch.host_save_failed", {
      message: "Failed to persist opportunity scan run (host-side save after settlement)",
      error: err instanceof Error ? err.message : String(err),
      runId: args.runId,
    });
    return { ...report, persisted: false };
  }
}
