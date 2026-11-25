/**
 * Issue #5082 (S2, observability program #5080) — the J1–J7
 * metrics observers: the run-settled observer (records
 * job.runs) and the stage-step journal (records
 * job.stage.steps + job.stage.step.duration), wired through
 * the engine's EXISTING observer seams — no engine internals
 * are touched.
 *
 * These observers MIRROR the S1 logging observers
 * (otelJobPipeline.ts) but record METRICS through the one
 * recorder instead of logging. The logging path is untouched:
 * the metrics observer is CHAINED after the logging observer
 * (chainRunSettledObservers) and the metrics journal WRAPS
 * the logging journal — each is guarded, so one observer's
 * failure never blocks the others.
 *
 * Both observers are best-effort (they can never fail, retry,
 * or duplicate the run's own records) and both check the
 * per-domain gate first: when the j1j7 domain is OFF they
 * no-op. The journal still runs the step when OFF (emitting
 * nothing), and the step's error is always rethrown.
 *
 * Wired on the ScheduledAgent host only in S2 (the pipeline
 * owner, createScheduledAgentPipelineControl), alongside the
 * S1 logging observers. The workflow / options / in-memory
 * hosts are not yet wired — same helper, later slice.
 */
import type { OtelMetricsRecorder } from "./otelMetricsRecorder";
import {
  identityJobStepJournal,
  type JobRunSettledInfo,
  type JobStepJournal,
  type JobStepJournalMeta,
} from "../services/jobPipelineEngine";

/** The dependencies every J1–J7 metrics observer needs. */
export interface OtelJobPipelineMetricsObserverDeps {
  /** The one metrics recorder. */
  recorder: OtelMetricsRecorder;
  /** The per-domain gate: true only when the j1j7 domain is ON. */
  isEnabled: () => boolean;
  /**
   * Optional flush, invoked (fire-and-forget, never awaited)
   * after a run settles so the metrics batch exports promptly
   * instead of waiting for the periodic interval.
   */
  flush?: () => Promise<void>;
}

/** The run-settled observer signature (the engine's JobPipelineDeps seam). */
export type JobRunSettledObserver = (info: JobRunSettledInfo) => Promise<void> | void;

/**
 * The metrics run-settled observer: records one `job.runs`
 * metric per terminally settled run (the recorder counts it
 * toward the health evaluation). Best-effort: a recording
 * failure can never fail the run.
 */
export function createOtelJobPipelineMetricsRunSettledObserver(
  deps: OtelJobPipelineMetricsObserverDeps,
): JobRunSettledObserver {
  return async (info: JobRunSettledInfo): Promise<void> => {
    try {
      if (!deps.isEnabled()) return;
      deps.recorder.recordJobRunSettled(info);
      // Flush the metrics batch promptly (fire-and-forget; the
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

export interface OtelJobPipelineMetricsStepJournalDeps
  extends OtelJobPipelineMetricsObserverDeps {
  /** The inner journal to delegate to (defaults to the identity journal). */
  inner?: JobStepJournal;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/**
 * The metrics stage-step journal: wraps each stage step's
 * execution and records the step count and duration
 * (job.stage.steps + job.stage.step.duration). The step's
 * error is always rethrown (the journal never swallows a step
 * failure). When the j1j7 domain is OFF the journal still runs
 * the step, recording nothing.
 */
export function createOtelJobPipelineMetricsStepJournal(
  deps: OtelJobPipelineMetricsStepJournalDeps,
): JobStepJournal {
  const inner = deps.inner ?? identityJobStepJournal;
  const nowMs = deps.nowMs ?? (() => Date.now());
  return {
    // Issue #6466 part 5 — the journal forwards the run context to the inner
    // journal, but records NO new metric label: a per-run label would blow
    // the free-tier 10,000-series cardinality. Determinability by run id
    // lives on the traces span + the log event, not on metrics.
    do: async <T>(name: string, fn: () => Promise<T>, meta?: JobStepJournalMeta): Promise<T> => {
      const enabled = (() => {
        try {
          return deps.isEnabled();
        } catch {
          return false;
        }
      })();
      if (!enabled) return inner.do(name, fn, meta);
      const startMs = nowMs();
      try {
        const result = await inner.do(name, fn, meta);
        const durationMs = nowMs() - startMs;
        try {
          deps.recorder.recordJobStageStep(name, "completed", durationMs);
        } catch {
          // Best-effort recording.
        }
        return result;
      } catch (error) {
        const durationMs = nowMs() - startMs;
        try {
          deps.recorder.recordJobStageStep(name, "failed", durationMs);
        } catch {
          // Best-effort recording.
        }
        throw error;
      }
    },
  };
}
