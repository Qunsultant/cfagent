/**
 * Issue #5081 (S1, observability program #5080) — the J1–J7
 * domain instrumentation: the job-pipeline observers.
 *
 * The J1–J7 stack (Epic #3533) is instrumented through the
 * engine's EXISTING observer seams — no engine internals are
 * touched:
 * - runSettledObserver (JobPipelineDeps, #3530 slice B): the
 *   engine's one terminal-recording point, invoked once per
 *   terminally settled run (completed/failed/cancelled) for every
 *   trigger class. The OTel observer emits `job.run.settled`.
 * - journal (JobStepJournal.do): wraps each stage step's
 *   execution. The OTel journal emits `job.stage.step.started` /
 *   `job.stage.step.completed` / `job.stage.step.failed` with the
 *   step duration.
 *
 * Both observers are best-effort (they can never fail, retry, or
 * duplicate the run's own records — the engine guards the
 * observer call, and the observers guard their own logging) and
 * both check the per-domain gate first: when the j1j7 domain is
 * OFF they no-op. The observers CHAIN with any existing
 * observer/journal (the ScheduledAgent host already sets
 * runSettledObserver to the feed-run observer; the workflow host
 * already sets the journal to the workflow-step journal) — they
 * never replace one.
 *
 * The observers log through the ONE structured logger
 * (createStructuredLogger), with component "job-pipeline" — the
 * component the OTel gate maps to the j1j7 domain. The OTel sink
 * (createOtelObservabilitySink) carries those events into OTel.
 * No new logger is introduced.
 *
 * Wired on the ScheduledAgent host only in S1 (the pipeline
 * owner, createScheduledAgentPipelineControl). The workflow /
 * options / in-memory hosts are not yet wired — same helper,
 * later slice.
 */

import type { StructuredLogger } from "./structuredLogger";
import {
  identityJobStepJournal,
  type JobRunSettledInfo,
  type JobStepJournal,
} from "../services/jobPipelineEngine";
import { OTEL_J1J7_COMPONENT } from "./otelLogs";

/** The dependencies every J1–J7 OTel observer needs. */
export interface OtelJobPipelineObserverDeps {
  /** The structured logger (component "job-pipeline"). */
  logger: StructuredLogger;
  /** The per-domain gate: true only when the j1j7 domain is ON. */
  isEnabled: () => boolean;
  /**
   * Optional flush, invoked (fire-and-forget, never awaited)
   * after a run settles so the OTel batch exports promptly
   * instead of waiting for the processor's scheduled delay.
   */
  flush?: () => Promise<void>;
}

/** The run-settled observer signature (the engine's JobPipelineDeps seam). */
export type JobRunSettledObserver = (info: JobRunSettledInfo) => Promise<void> | void;

/**
 * The OTel run-settled observer: emits one `job.run.settled`
 * log per terminally settled run (info for completed, warn for
 * cancelled, error for failed with the error). Best-effort: a
 * logging failure can never fail the run.
 */
export function createOtelJobPipelineRunSettledObserver(
  deps: OtelJobPipelineObserverDeps,
): JobRunSettledObserver {
  return async (info: JobRunSettledInfo): Promise<void> => {
    try {
      if (!deps.isEnabled()) return;
      const fields: Record<string, unknown> = {
        jobId: info.jobId,
        runId: info.runId,
        trigger: info.trigger,
        state: info.state,
      };
      if (info.error) fields.error = info.error;
      if (info.state === "failed") {
        deps.logger.error("job.run.settled", fields);
      } else if (info.state === "cancelled") {
        deps.logger.warn("job.run.settled", fields);
      } else {
        deps.logger.info("job.run.settled", fields);
      }
      // Flush the OTel batch promptly (fire-and-forget; the
      // observer never blocks on the export).
      if (deps.flush) {
        deps.flush().catch(() => {
          // Best-effort: a flush failure never fails the run.
        });
      }
    } catch {
      // Best-effort: the observer must never fail the run.
    }
  };
}

/**
 * Chains run-settled observers so an existing observer (e.g. the
 * feed-run observer on the ScheduledAgent host) is kept and the
 * OTel observer runs alongside it. Each observer is guarded: one
 * observer's failure never blocks the others.
 *
 * Defined in the engine (`../services/jobPipelineEngine`) and
 * re-exported here so existing importers keep working: the ONE
 * factory imports it from the engine, so the factory never imports
 * the OTel provider chain (issue #6250, CI Fast-gates build failure
 * on PR #6261).
 */
export { chainRunSettledObservers } from "../services/jobPipelineEngine";

export interface OtelJobStepJournalDeps extends OtelJobPipelineObserverDeps {
  /** The inner journal to delegate to (defaults to the identity journal). */
  inner?: JobStepJournal;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/**
 * The OTel stage-step journal: wraps each stage step's execution
 * and emits `job.stage.step.started` / `job.stage.step.completed`
 * (with durationMs) / `job.stage.step.failed` (with durationMs
 * and the error). The step's error is always rethrown (the
 * journal never swallows a step failure). When the j1j7 domain
 * is OFF the journal still runs the step, emitting nothing.
 */
export function createOtelJobStepJournal(deps: OtelJobStepJournalDeps): JobStepJournal {
  const inner = deps.inner ?? identityJobStepJournal;
  const nowMs = deps.nowMs ?? (() => Date.now());
  return {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const enabled = (() => {
        try {
          return deps.isEnabled();
        } catch {
          return false;
        }
      })();
      if (!enabled) return inner.do(name, fn);
      const startMs = nowMs();
      try {
        deps.logger.info("job.stage.step.started", { step: name });
      } catch {
        // Best-effort logging.
      }
      try {
        const result = await inner.do(name, fn);
        const durationMs = nowMs() - startMs;
        try {
          deps.logger.info("job.stage.step.completed", { step: name, durationMs });
        } catch {
          // Best-effort logging.
        }
        return result;
      } catch (error) {
        const durationMs = nowMs() - startMs;
        const message = error instanceof Error ? error.message : String(error);
        try {
          deps.logger.error("job.stage.step.failed", { step: name, durationMs, error: message });
        } catch {
          // Best-effort logging.
        }
        throw error;
      }
    },
  };
}

/** The component the J1–J7 observers log under (the OTel gate maps it to j1j7). */
export const OTEL_JOB_PIPELINE_COMPONENT = OTEL_J1J7_COMPONENT;
