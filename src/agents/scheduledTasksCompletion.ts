/**
 * Issue #4425 â€” firing completion-triggered schedules on the pipeline host.
 *
 * The host owns the job definitions, so the host is where a completion can be
 * matched against every target's binding and dispatched through the same
 * control plane every other run uses (`runJob`, with `scopePath` when the
 * binding names a target stage). The function takes the control as an
 * argument rather than building one, so the pure firing rule is testable
 * without an environment, and the agent's RPC stays a two-line adapter.
 *
 * Failure discipline: one target that cannot fire never stops the others and
 * never fails the queue message â€” it is reported by job id with its reason,
 * because a completion that silently skipped its chained schedule is the
 * defect this issue exists to end.
 */
import type { JobPipelineControl } from "../services/jobPipelineEngine";
import {
  completionMatchesTrigger,
  parseCompletionTrigger,
  type CompletionEvent,
} from "../services/completionTrigger";

export interface CompletionFiringResult {
  /** Target job ids this completion fired, in definition order. */
  fired: string[];
  /** Targets that carry a binding but could not fire, with the reason. */
  skipped: Array<{ jobId: string; reason: string }>;
  /** Targets whose stored binding is malformed â€” reported, never ignored. */
  invalid: Array<{ jobId: string; reason: string }>;
}

/**
 * Fire every target whose binding matches this completion.
 *
 * A target already running refuses (the engine's own gate) and is reported as
 * skipped with that reason; it is not retried here, because the completion is
 * a fact, not a queue of intents â€” the owner can re-run the target by hand if
 * the overlap mattered.
 */
export async function dispatchCompletionSchedules(
  control: JobPipelineControl,
  event: CompletionEvent,
  dispatchJob?: (
    jobId: string,
    opts: { trigger: "scheduled"; scopePath?: string },
  ) => Promise<unknown>,
): Promise<CompletionFiringResult> {
  const result: CompletionFiringResult = { fired: [], skipped: [], invalid: [] };
  const jobs = await control.listJobs();
  for (const job of jobs) {
    const parsed = parseCompletionTrigger(job.rawConfig);
    if (parsed.error) {
      result.invalid.push({ jobId: job.jobId, reason: parsed.error });
      continue;
    }
    if (!parsed.binding) continue;
    // A job cannot fire itself on its own completion: the target would run,
    // complete, and fire again â€” an unbounded loop the owner never asked for.
    // Refused by name, deterministically, rather than left as a footgun.
    if (parsed.binding.sourceJobId === job.jobId) {
      result.skipped.push({
        jobId: job.jobId,
        reason: `self-trigger refused: ${job.jobId} cannot be fired by its own completion.`,
      });
      continue;
    }
    if (!completionMatchesTrigger(parsed.binding, event)) continue;
    try {
      // Issue #4171 — the host may route a target's dispatch
      // (feed targets start workflow residency); absent a
      // router, the control plane dispatch stands.
      const dispatchOpts = {
        trigger: "scheduled" as const,
        ...(parsed.binding.targetStage ? { scopePath: parsed.binding.targetStage } : {}),
      };
      if (dispatchJob) {
        await dispatchJob(job.jobId, dispatchOpts);
      } else {
        await control.runJob(job.jobId, dispatchOpts);
      }
      result.fired.push(job.jobId);
    } catch (error) {
      result.skipped.push({
        jobId: job.jobId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

