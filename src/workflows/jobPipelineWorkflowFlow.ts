/**
 * Issue #3534 (Pipeline J1) — the workflow-side flow for pipeline
 * jobs: the durable execution substrate's half of the engine.
 * Every decision lives here, behind fakeable interfaces; the
 * workflow class (jobPipelineWorkflow.ts) is the thin adapter
 * that builds deps from the environment.
 *
 * The flow dispatches the job through the SAME control plane the
 * UX and copilot doors use — a workflow run is one dispatch
 * surface, not a second engine. The workflow's step object
 * becomes the engine's journal: each step invocation is wrapped
 * in step.do, so a workflow replay re-uses journaled step
 * results while the engine's persisted checkpoints carry the
 * resume semantics.
 *
 * Claim-check discipline: the payload carries ids and the
 * trigger only — never configuration or data. The definition is
 * read from the job stores at run start (configuration is read
 * at run start, on every surface).
 */
import {
  JobPipelineControl,
  type JobPipelineDeps,
  type JobRunOutcome,
} from "../services/jobPipelineEngine";
import { JobPipelineError } from "../services/jobPipelineConfig";

export interface JobPipelineWorkflowPayload {
  jobId: string;
  trigger?: "manual" | "scheduled";
  scopePath?: string;
}

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface JobPipelineWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Run one pipeline job dispatch to settlement inside a workflow.
 * The workflow is the async boundary: whatever the job's
 * configured delivery mode, the flow awaits the run's outcome
 * and returns it as the workflow result.
 */
export async function runJobPipelineWorkflowFlow(
  deps: JobPipelineDeps,
  step: JobPipelineWorkflowStep,
  payload: JobPipelineWorkflowPayload,
): Promise<JobRunOutcome> {
  if (!payload || typeof payload.jobId !== "string" || !payload.jobId.trim()) {
    throw new JobPipelineError(
      "job_config_invalid",
      "Job pipeline workflow payload requires a non-empty jobId (claim-check: ids only).",
    );
  }
  const control = new JobPipelineControl({
    ...deps,
    journal: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => step.do(name, fn),
    },
  });
  const dispatch = await control.runJob(payload.jobId, {
    trigger: payload.trigger ?? "manual",
    ...(payload.scopePath ? { scopePath: payload.scopePath } : {}),
  });
  if (dispatch.completion) return dispatch.completion;
  const view = await control.getJob(payload.jobId);
  return {
    jobId: payload.jobId,
    runId: dispatch.runId,
    state: dispatch.state,
    artifactKeys: view.instance?.checkpoint?.artifactKeys ?? [],
  };
}
