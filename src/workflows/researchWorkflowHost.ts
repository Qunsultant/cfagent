/**
 * Issue #6035 (b) — the OODA run dispatches through the job-pipeline workflow
 * residency, one durable step per stage.
 *
 * The residency already exists and already composes the research stage deps
 * (`createWorkflowResearchStepDeps`, #5237): each stage calls the owning
 * Orchestrator DO. What was missing is the start seam: `dispatchResearchEngineRun`
 * built a control with `invocation: "sync"` and ran the whole job in the
 * request's own invocation, so nothing checkpointed.
 *
 * This module is the research counterpart of `startOptionsScreenWorkflow`
 * (`optionsWorkflowHost.ts`): define the same `research:<runId>` definition over
 * the D1 residency, attach to an in-flight instance instead of defining under
 * it, then create the managed workflow instance. It adds no workflow class and
 * no second definition builder — it reuses the ones the other jobs use.
 */
import type { Env } from "../types";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import { createJobPipelineControl } from "../services/jobPipelineControlFactory";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import { createJobPipelineStoresFromD1 } from "../data/createJobPipelinePorts";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type { JobRunRecorder } from "../services/jobPipelineEngine";
import {
  attachToInFlightRun,
  jobRunRecorderFromD1,
} from "./optionsWorkflowHost";
import {
  startManagedWorkflowInstance,
  type ManagedWorkflowBinding,
} from "./workflowInstanceSeam";
import { workflowIdForJob } from "./workflowPorts";

/** The D1 residency the workflow executes against, or null when unbound. */
export interface ResearchWorkflowResidency {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
}

/** True when this deployment can dispatch the research job durably. */
export function researchWorkflowResidencyAvailable(env: Env | undefined | null): boolean {
  if (!env) return false;
  const workflow = env.JOB_PIPELINE_WORKFLOW;
  return Boolean(
    workflow &&
      typeof (workflow as { create?: unknown }).create === "function" &&
      env.AGENT_DB,
  );
}

/** Resolve the D1 residency once; null when the deployment cannot host a workflow. */
export function researchWorkflowResidency(env: Env): ResearchWorkflowResidency | null {
  if (!researchWorkflowResidencyAvailable(env)) return null;
  return {
    stores: createJobPipelineStoresFromD1(env.AGENT_DB as NonNullable<Env["AGENT_DB"]>),
    runRecorder: jobRunRecorderFromD1(env.AGENT_DB as NonNullable<Env["AGENT_DB"]>),
  };
}

export interface StartResearchJobWorkflowInput {
  env: Env;
  /** The per-run definition `buildResearchJobDefinition` produced for this job id. */
  definition: Record<string, unknown>;
  /** `research:<runId>` — the one canonical job id. */
  engineJobId: string;
  /** The research run id, carried on the dispatch event (defaults to the job id without the `research:` prefix). */
  runId?: string;
  trigger: JobRunTrigger;
  /** Test seam: the residency (in-memory stores in tests, following the existing `startWorkflow` seam pattern). */
  residency?: ResearchWorkflowResidency;
  /** Dispatch-event seam: the host logs `job.run.dispatched` through it when given (the production caller wires the structured logger). */
  dispatchLogger?: {
    info: (type: string, fields: Record<string, unknown>) => void;
  };
  /** Test seam: the workflow starter (same shape as the options host). */
  startWorkflow?: (
    jobId: string,
    opts: { trigger: JobRunTrigger },
  ) => Promise<{ instanceId: string }>;
}

export interface StartResearchJobWorkflowResult {
  instanceId: string;
  /** True when an in-flight instance was adopted instead of creating a second. */
  attached: boolean;
}

/**
 * Define the research job in the residency and start exactly one workflow
 * instance for it. A re-dispatch of an in-flight run attaches to the existing
 * instance: no second define (no version bump under a running run) and no
 * second create.
 *
 * Issue #6466 part 2 — a fresh start stamps the dispatch on the instance row
 * (the workflow instance id, the start time, state "idle") and logs the
 * dispatch event, BEFORE the settlement poller runs — so the OODA page and
 * the ledger show the run from dispatch, and a settlement timeout can name
 * the instance it waited on. An attached re-dispatch stamps nothing: the row
 * already carries the in-flight instance.
 */
export async function startResearchJobWorkflow(
  input: StartResearchJobWorkflowInput,
): Promise<StartResearchJobWorkflowResult> {
  const residency = input.residency ?? researchWorkflowResidency(input.env);
  if (!residency) {
    throw new Error(
      "job_pipeline_workflow_not_configured: the JOB_PIPELINE_WORKFLOW binding (or the AGENT_DB it reads) is not configured in this deployment; the run was not dispatched.",
    );
  }
  const defineControl = createJobPipelineControl(
    {
      stores: residency.stores,
      runRecorder: residency.runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "workflow-shard",
    },
    { env: input.env },
  );
  const attached = await attachToInFlightRun(defineControl, input.engineJobId);
  if (attached) {
    return { instanceId: attached.instanceId, attached: true };
  }
  await defineControl.defineJob(input.definition as never);
  const stampDispatch = async (instanceId: string): Promise<void> => {
    await defineControl.stampWorkflowDispatch(input.engineJobId, {
      workflowInstanceId: instanceId,
      startedAt: new Date().toISOString(),
    });
    input.dispatchLogger?.info("job.run.dispatched", {
      jobId: input.engineJobId,
      runId: input.runId ?? input.engineJobId.replace(/^research:/, ""),
      workflowInstanceId: instanceId,
      trigger: input.trigger,
    });
  };
  if (input.startWorkflow) {
    const started = await input.startWorkflow(input.engineJobId, {
      trigger: input.trigger,
    });
    await stampDispatch(started.instanceId);
    return { instanceId: started.instanceId, attached: false };
  }
  const workflow = input.env.JOB_PIPELINE_WORKFLOW as unknown as ManagedWorkflowBinding;
  const started = await startManagedWorkflowInstance(workflow, {
    id: workflowIdForJob(input.engineJobId),
    params: { jobId: input.engineJobId, trigger: input.trigger },
    workflowName: "JOB_PIPELINE_WORKFLOW",
  });
  await stampDispatch(started.workflowId);
  return { instanceId: started.workflowId, attached: false };
}
/** The terminal instance states: any other state is still in flight. */
const TERMINAL_RESEARCH_RUN_STATES = new Set(["completed", "failed", "cancelled"]);

export interface AwaitResearchJobSettlementInput {
  env: Env;
  engineJobId: string;
  /** Poll cadence; default 1000 ms. */
  intervalMs?: number;
  /**
   * Bound; default 120 000 ms — the run's own budget is the stage timeouts'.
   * Issue #6466 part 3 — the bound is externalized: the dispatch passes the
   * effective settlement wait (stored research config over the
   * `RESEARCH_SETTLEMENT_WAIT_MS` deployment carrier over this default).
   */
  timeoutMs?: number;
  /** Test seams. */
  readJob?: (engineJobId: string) => Promise<
    {
      instance: {
        state: string;
        runWorkflowInstanceId?: string | null;
        runStartedAt?: string | null;
      } | null;
    } & Record<string, unknown>
  >;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Await the hosted run's settlement and return its job view (the same shape the
 * in-process control returns, so the caller's stage mapping is unchanged). A
 * failed run returns its view; the caller decides how a failure surfaces. A run
 * that never settles throws a named timeout carrying the job id and last state.
 */
export async function awaitResearchJobSettlement(
  input: AwaitResearchJobSettlementInput,
): Promise<{ state: string; view: Record<string, unknown> }> {
  const residency = researchWorkflowResidency(input.env);
  if (!residency) {
    throw new Error(
      "job_pipeline_workflow_not_configured: the JOB_PIPELINE_WORKFLOW binding (or the AGENT_DB it reads) is not configured in this deployment; the run cannot be read back.",
    );
  }
  const control = createJobPipelineControl({
    stores: residency.stores,
    runRecorder: residency.runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  });
  const readJob =
    input.readJob ??
    ((jobId: string) => control.getJob(jobId) as unknown as Promise<
      {
        instance: {
          state: string;
          runWorkflowInstanceId?: string | null;
          runStartedAt?: string | null;
        } | null;
      } & Record<string, unknown>
    >);
  const intervalMs = input.intervalMs ?? 1000;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const startedAt = now();
  let view = await readJob(input.engineJobId);
  let state = view.instance?.state ?? "idle";
  while (!TERMINAL_RESEARCH_RUN_STATES.has(state)) {
    await sleep(intervalMs);
    if (now() - startedAt >= timeoutMs) {
      // Issue #6466 part 2 — the timeout names the stamped workflow instance
      // and its start time when the row carries one, so the page can show
      // which engine run the wait gave up on (the 2026-11-24 run sat idle
      // past the wait with no instance recorded at all).
      const instanceId = view.instance?.runWorkflowInstanceId;
      const runStartedAt = view.instance?.runStartedAt;
      const stamped = instanceId
        ? ` (workflow instance ${instanceId}${runStartedAt ? `, started ${runStartedAt}` : ""})`
        : "";
      throw new Error(
        `research_workflow_run_timeout: run ${input.engineJobId} did not reach a terminal state within ${timeoutMs}ms (last state: ${state}); the run may still be in flight — read it back instead of re-dispatching.${stamped}`,
      );
    }
    view = await readJob(input.engineJobId);
    state = view.instance?.state ?? "idle";
  }
  return { state, view: view as Record<string, unknown> };
}
