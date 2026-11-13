/**
 * Issue #3543 (Pipeline J1 host wiring, consumed by J2 #3535) —
 * the queue-side consumer for the `job-pipeline-events` queue:
 * the consumer half J1 deliberately deferred (a queue's consumer
 * arrives with its first handler, the #1739 sequencing), landing
 * with its QueueConsumerConfig pin (#2544) and the wrangler
 * consumer entry the pin test holds it to.
 *
 * The first handler routes stage/job COMPLETIONS to the pipeline
 * host's control dispatch: a terminal job event (completed /
 * failed / cancelled) is recorded on the ScheduledAgent as the
 * job's latest completion — job id, run id, state, and the run's
 * persisted artifact keys (claim-check references, never bulk
 * payloads) — the surface downstream stages (J3's enrich job)
 * consume their upstream's hand-off from, and the status
 * subscribers read. Non-terminal publications (queued / running
 * / checkpointed, stage actions) are acked as processed: they
 * are the live status stream, not completions, and this consumer
 * does not pretend to be their store (the instance store is).
 *
 * Consumer rules are the platform's (#2544): at-least-once
 * delivery → the port core dedups on the envelope id (the
 * seen-ids set the composition root threads in), so a duplicate
 * delivery never re-routes a completion; a routing failure
 * returns "retry" (redelivery up to max_retries, then the DLQ
 * with run/job ids intact in the body); a body that is not a job
 * event at all is dropped with a dead-letter record — no handler
 * could ever process it, so redelivery would only loop.
 */
import {
  type ConsumeOutcome,
  type MessageEnvelope,
  type MessageHandler,
  type QueueConsumerConfig,
} from "./messagingPorts";
import {
  consoleDeadLetterSink,
  createDeadLetterRecord,
  type DeadLetterSink,
} from "./deadLetter";
import { createStructuredLogger } from "../observability/structuredLogger";
import type { JobStageEventRecord } from "../data/jobStageEventPorts";
import { stageEventFromEnvelope } from "../services/jobStageEvents";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "messaging/jobPipelineEventsConsumer",
});

/**
 * The job-pipeline-events consumer config, pinned against
 * wrangler.jsonc by test (gitops §7, the pin rule) — the same
 * values the screener work consumer runs under, with the DLQ the
 * producer binding declares alongside it.
 */
export const JOB_PIPELINE_EVENTS_CONSUMER_CONFIG: QueueConsumerConfig = {
  // Issue #4213 (owner direction) — DO usage: one invocation at a time,
  // smaller batches, two retries (was 10 / 30s / 3 / 2). Mirrored in
  // wrangler.jsonc and held equal to it by tests/feed_pipeline_host_3543.test.ts.
  maxBatchSize: 5,
  maxBatchTimeoutSeconds: 10,
  maxRetries: 2,
  maxConcurrency: 1,
  deadLetterQueue: "job-pipeline-events-dlq",
};

/** One routed completion: the terminal event's claim-check data. */
export interface JobPipelineCompletion {
  jobId: string;
  runId: string;
  state: string;
  artifactKeys: string[];
  at: string;
}

const TERMINAL_JOB_TYPES = new Set([
  "job.completed",
  "job.failed",
  "job.cancelled",
]);

/**
 * Extract a completion from an envelope, or null when the
 * envelope is not a terminal job event. The event's data is the
 * engine's publication shape (jobPipelineEvents.ts): jobId,
 * runId, state, artifactKeys.
 */
export function extractJobPipelineCompletion(
  envelope: MessageEnvelope,
): JobPipelineCompletion | null {
  if (!TERMINAL_JOB_TYPES.has(envelope.type)) return null;
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : null;
  const jobId =
    typeof data?.jobId === "string" ? data.jobId : envelope.jobid ?? envelope.subject;
  const runId = typeof data?.runId === "string" ? data.runId : null;
  if (!jobId || !runId) return null;
  const artifactKeys = Array.isArray(data?.artifactKeys)
    ? data.artifactKeys.filter((k): k is string => typeof k === "string")
    : [];
  return {
    jobId,
    runId,
    state:
      typeof data?.state === "string"
        ? data.state
        : envelope.type.replace(/^job\./, ""),
    artifactKeys,
    at: envelope.time ?? new Date().toISOString(),
  };
}

export interface JobPipelineEventsHandlerDeps {
  /**
   * Route one completion into the pipeline host's control
   * dispatch (the ScheduledAgent's recordPipelineCompletion).
   * A throw becomes "retry" — the platform redelivers, then DLQs.
   */
  routeCompletion: (completion: JobPipelineCompletion) => Promise<void>;
  /**
   * Issue #4360 — persist one `job.stage.*` publication in the durable
   * stage store, deduplicated on its claim key. Absent = today's
   * pass-through behaviour; a throw becomes "retry", never a silent
   * ack-and-drop. The queue branch that delivers these envelopes is
   * #3958; this is the persistence behind it.
   */
  recordStageEvent?: (event: JobStageEventRecord) => Promise<boolean>;
  /** Dead-letter sink for terminal drops; defaults to the console sink. */
  onDeadLetter?: DeadLetterSink;
  /** Optional persistence for terminal drops (the #2000 closure). */
  persistDeadLetter?: (
    record: ReturnType<typeof createDeadLetterRecord>,
    envelope: MessageEnvelope | null,
  ) => Promise<void>;
}

/** The QueuePort handler for job-pipeline-events envelopes. */
export function createJobPipelineEventsHandler(
  deps: JobPipelineEventsHandlerDeps,
): MessageHandler {
  const sink = deps.onDeadLetter ?? consoleDeadLetterSink;
  return async (envelope): Promise<ConsumeOutcome> => {
    // Issue #4360 — a stage publication is persisted before it is acked.
    // Dedup lives in the store (the #2869 claim key + action + instant), so
    // a re-delivery is "processed" without a second row.
    if (envelope.type.startsWith("job.stage.") && deps.recordStageEvent) {
      const stageEvent = stageEventFromEnvelope(envelope);
      if (!stageEvent) {
        const record = createDeadLetterRecord({
          queue: "job-pipeline-events",
          reason: "invalid_envelope",
          messageId: envelope.id,
          runId: envelope.jobid ?? envelope.subject ?? envelope.id,
          detail: `Stage envelope "${envelope.type}" carries no run/stage identity — nothing to persist, and redelivery would loop.`,
        });
        sink.record(record);
        await deps.persistDeadLetter?.(record, envelope);
        return "drop";
      }
      try {
        await deps.recordStageEvent(stageEvent);
        return "processed";
      } catch (error) {
        structuredLog.warn("job_pipeline.stage_event_record_failed", {
          message: `[job-pipeline] persisting stage event for job "${stageEvent.jobId}" run "${stageEvent.runId}" stage "${stageEvent.stageId}" failed; the message will retry: ${error instanceof Error ? error.message : String(error)}`,
          jobId: stageEvent.jobId,
          runId: stageEvent.runId,
          stageId: stageEvent.stageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return "retry";
      }
    }
    const completion = extractJobPipelineCompletion(envelope);
    if (!completion) {
      // A job.* status publication that is not a completion is
      // the live stream passing through — processed, not routed.
      if (envelope.type.startsWith("job.")) return "processed";
      const record = createDeadLetterRecord({
        queue: "job-pipeline-events",
        reason: "no_handler",
        messageId: envelope.id,
        runId: envelope.jobid ?? envelope.subject ?? envelope.id,
        unitId: envelope.id,
        detail: `No handler for envelope type "${envelope.type}" on the job-pipeline-events queue — dropping; redelivery would loop.`,
      });
      sink.record(record);
      await deps.persistDeadLetter?.(record, envelope);
      return "drop";
    }
    try {
      await deps.routeCompletion(completion);
      return "processed";
    } catch (error) {
      structuredLog.warn("job_pipeline.completion_routing_failed", {
        message: `[job-pipeline] routing completion for job "${completion.jobId}" run "${completion.runId}" failed; the message will retry: ${error instanceof Error ? error.message : String(error)}`,
        jobId: completion.jobId,
        runId: completion.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "retry";
    }
  };
}
