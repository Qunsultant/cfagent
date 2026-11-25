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
  type JobPipelineDeps,
  type JobRunOutcome,
} from "../services/jobPipelineEngine";
import { resolveWorkflowWaitChannel, type WorkflowEventWaitStep } from "./workflowEventWait";
import { createJobPipelineControl } from "../services/jobPipelineControlFactory";
import { JobPipelineError } from "../services/jobPipelineConfig";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import { normalizeJobRunTrigger } from "../data/jobRunRecordPorts";

export interface JobPipelineWorkflowPayload {
  jobId: string;
  trigger?: JobRunTrigger;
  scopePath?: string;
}

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface JobPipelineWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Issue #3955 — the platform's step-level event wait. Optional at the
   * seam: a step without it leaves the engine's wait stage refusing by
   * name rather than silently skipping the wait.
   */
  waitForEvent?: WorkflowEventWaitStep["waitForEvent"];
}

/**
 * Run one pipeline job dispatch to settlement inside a workflow.
 * The workflow is the async boundary: whatever the job's
 * configured delivery mode, the flow awaits the run's outcome
 * and returns it as the workflow result.
 *
 * Issue #4454 — eviction replay: when the runtime evicts a
 * workflow mid-run and replays it, this flow re-enters with the
 * persisted instance still `running`, and runJob refuses
 * `job_already_running`. When the caller passes the workflow
 * instance id, the flow answers that refusal with a replay
 * attempt: the engine resumes the run only when the recorded
 * dispatching instance id matches the caller's — the replay
 * proof. Every unproven case re-throws the ORIGINAL refusal,
 * so the concurrent-dispatch behavior is byte-identical to
 * before: only a proven replay changes the outcome.
 */
export async function runJobPipelineWorkflowFlow(
  deps: JobPipelineDeps,
  step: JobPipelineWorkflowStep,
  payload: JobPipelineWorkflowPayload,
  opts?: { workflowInstanceId?: string },
): Promise<JobRunOutcome> {
  if (!payload || typeof payload.jobId !== "string" || !payload.jobId.trim()) {
    throw new JobPipelineError(
      "job_config_invalid",
      "Job pipeline workflow payload requires a non-empty jobId (claim-check: ids only).",
    );
  }
  // Issue #6250 — the workflow flow builds through the ONE factory,
  // with the deps' env: the workflow step journal stays as the
  // journal and the factory threads it as the inner journal, so a
  // workflow-dispatched run emits `job.run.settled` and its steps
  // stay replay-safe through step.do.
  const control = createJobPipelineControl({
    ...resolveWorkflowWaitChannel(step),
    ...deps,
    journal: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => step.do(name, fn),
    },
  }, { ...(deps.env ? { env: deps.env } : {}) });
  const workflowInstanceId = opts?.workflowInstanceId;
  let dispatch;
  try {
    dispatch = await control.runJob(payload.jobId, {
      // Issue #4767 — the workflow payload's trigger, all five
      // modes, fail-closed through normalize (absent ⇒ "manual").
      trigger: normalizeJobRunTrigger(payload.trigger),
      ...(payload.scopePath ? { scopePath: payload.scopePath } : {}),
      ...(workflowInstanceId ? { workflowInstanceId } : {}),
    });
  } catch (error) {
    if (
      workflowInstanceId &&
      error instanceof JobPipelineError &&
      error.code === "job_already_running"
    ) {
      try {
        dispatch = await control.replayJob(payload.jobId, {
          workflowInstanceId,
          ...(payload.scopePath ? { scopePath: payload.scopePath } : {}),
        });
      } catch (replayError) {
        // Unproven: the original refusal stands, exactly as
        // before. Only a coded refusal is swallowed — an
        // infrastructure failure surfaces as itself.
        if (replayError instanceof JobPipelineError) throw error;
        throw replayError;
      }
    } else {
      throw error;
    }
  }
  if (dispatch.completion) return dispatch.completion;
  const view = await control.getJob(payload.jobId);
  return {
    jobId: payload.jobId,
    runId: dispatch.runId,
    state: dispatch.state,
    artifactKeys: view.instance?.checkpoint?.artifactKeys ?? [],
  };
}
