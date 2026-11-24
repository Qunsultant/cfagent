/**
 * Issue #2808 (S3, observability program #5080) — the J1–J7
 * span observers: the run-settled observer (one
 * `job.run.settled` span per terminally settled run) and the
 * stage-step journal (one `job.stage.step` span per stage
 * step), wired through the engine's EXISTING observer seams
 * — no engine internals are touched.
 *
 * These observers MIRROR the S1 logging observers
 * (otelJobPipeline.ts) and the S2 metrics observers
 * (otelJobPipelineMetrics.ts) but record SPANS through the
 * OTel tracer instead of logging or recording metrics. The
 * logging and metrics paths are untouched: the traces
 * run-settled observer is CHAINED after the metrics observer
 * and the traces journal WRAPS the metrics journal — each is
 * guarded, so one observer's failure never blocks the others.
 *
 * Both observers are best-effort (they can never fail, retry,
 * or duplicate the run's own records) and both check the
 * per-domain gate first: when the j1j7 domain is OFF they
 * no-op. The journal still runs the step when OFF (emitting
 * nothing), and the step's error is always rethrown.
 *
 * Seam honesty: the engine's journal seam carries no run
 * context (JobStepJournal.do receives only the step name) and
 * the run-settled info carries no duration or traceparent —
 * so a step span is a root span (one trace per step) and the
 * run span is a zero-duration marker at the settle moment.
 * Linking a run's steps into one trace needs a run-context
 * seam in the engine (a later slice, not S3). Nested steps DO
 * nest: the journal sets each step span as the active OTel
 * context for the step's execution, so a step that calls the
 * journal again records a child span.
 *
 * Wired on the ScheduledAgent host only in S3 (the pipeline
 * owner, createScheduledAgentPipelineControl), alongside the
 * S1 logging and S2 metrics observers. The workflow / options
 * / in-memory hosts are not yet wired — same helper, later
 * slice.
 */
import { SpanStatusCode, context, trace, type Tracer } from "@opentelemetry/api";
import {
  identityJobStepJournal,
  type JobRunSettledInfo,
  type JobStepJournal,
  type JobStepJournalMeta,
} from "../services/jobPipelineEngine";
import { OTEL_J1J7_COMPONENT } from "./otelLogs";

/** The dependencies every J1–J7 traces observer needs. */
export interface OtelJobPipelineTracesObserverDeps {
  /** The OTel tracer (from the traces composition root). */
  tracer: Tracer;
  /** The per-domain gate: true only when the j1j7 domain is ON. */
  isEnabled: () => boolean;
  /**
   * Optional flush, invoked (fire-and-forget, never awaited)
   * after a run settles so the traces batch exports promptly
   * instead of waiting for the processor's scheduled delay.
   */
  flush?: () => Promise<void>;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/** The run-settled observer signature (the engine's JobPipelineDeps seam). */
export type JobRunSettledObserver = (info: JobRunSettledInfo) => Promise<void> | void;

/**
 * The traces run-settled observer: records one
 * `job.run.settled` span per terminally settled run (OK for
 * completed, ERROR for failed with the error, UNSET for
 * cancelled). The span is a zero-duration marker at the settle
 * moment: the run-settled info carries no start time or
 * duration, so no duration is invented. Best-effort: a
 * recording failure can never fail the run.
 */
export function createOtelJobPipelineTracesRunSettledObserver(
  deps: OtelJobPipelineTracesObserverDeps,
): JobRunSettledObserver {
  const nowMs = deps.nowMs ?? (() => Date.now());
  return async (info: JobRunSettledInfo): Promise<void> => {
    try {
      if (!deps.isEnabled()) return;
      const settleMs = nowMs();
      const span = deps.tracer.startSpan(
        "job.run.settled",
        {
          attributes: {
            component: OTEL_J1J7_COMPONENT,
            jobId: info.jobId,
            runId: info.runId,
            trigger: info.trigger,
            state: info.state,
            ...(info.error ? { error: info.error } : {}),
          },
          // The settle moment is both the start and the end:
          // the info carries no start time, so no duration is
          // invented. OTel startSpan takes an HrTime; the span
          // ends at the same instant.
          startTime: [Math.floor(settleMs / 1000), (settleMs % 1000) * 1_000_000],
        },
      );
      if (info.state === "failed") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: info.error ?? "run failed",
        });
      } else if (info.state === "completed") {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      // A cancelled run keeps the default UNSET status: it did
      // not fail, and it did not complete either.
      span.end([Math.floor(settleMs / 1000), (settleMs % 1000) * 1_000_000]);
      // Flush the traces batch promptly (fire-and-forget; the
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

export interface OtelJobPipelineTracesStepJournalDeps
  extends OtelJobPipelineTracesObserverDeps {
  /** The inner journal to delegate to (defaults to the identity journal). */
  inner?: JobStepJournal;
}

/**
 * The traces stage-step journal: wraps each stage step's
 * execution in a `job.stage.step` span (attribute `step` is
 * the step name, `component` is "job-pipeline"). The span is
 * set as the active OTel context for the step's execution, so
 * a step that calls the journal again records a child span.
 * The span ends OK on success and ERROR on failure (with the
 * error message); the step's error is always rethrown (the
 * journal never swallows a step failure). When the j1j7 domain
 * is OFF the journal still runs the step, recording nothing.
 */
export function createOtelJobPipelineTracesStepJournal(
  deps: OtelJobPipelineTracesStepJournalDeps,
): JobStepJournal {
  const inner = deps.inner ?? identityJobStepJournal;
  const nowMs = deps.nowMs ?? (() => Date.now());
  return {
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
      const span = deps.tracer.startSpan("job.stage.step", {
        attributes: {
          component: OTEL_J1J7_COMPONENT,
          step: name,
          // Issue #6466 part 5 — the run id as a first-class span attribute:
          // TraceQL can select the run's spans by runId instead of regexing
          // the step name.
          ...(meta?.runId ? { runId: meta.runId } : {}),
          ...(meta?.jobId ? { jobId: meta.jobId } : {}),
        },
        startTime: [Math.floor(startMs / 1000), (startMs % 1000) * 1_000_000],
      });
      // The span is the active context for the step, so nested
      // journal calls record child spans of this step.
      const ctx = trace.setSpan(context.active(), span);
      try {
        const result = await context.with(ctx, () => inner.do(name, fn, meta));
        const endMs = nowMs();
        span.setStatus({ code: SpanStatusCode.OK });
        span.end([Math.floor(endMs / 1000), (endMs % 1000) * 1_000_000]);
        return result;
      } catch (error) {
        const endMs = nowMs();
        const message = error instanceof Error ? error.message : String(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.end([Math.floor(endMs / 1000), (endMs % 1000) * 1_000_000]);
        throw error;
      }
    },
  };
}
