/**
 * Issue #2544 — migration step 1: the queue-side
 * consumer for the `screener-events` work queue.
 *
 * Until this step the work queue was producer-only by config, so
 * nothing ever consumed it; the delivery subscriber queue already
 * had a consumer (see screenerQueueConsumer.ts + the delivery
 * branch in src/server.ts queue()). This module is the work
 * queue's consumer half, behind the same QueuePort — it extends
 * the consumer contract (messagingPorts.ts QueueConsumerConfig)
 * and reuses the adapter bridge (consumeCfBatch), and creates no
 * second port layer.
 *
 * Consumer rules (migration report §3.2, enforced by the port
 * core + the platform config, not per handler): at-least-once
 * delivery → handlers are idempotent on (runId, unitId) via the
 * envelope idempotency key (the port core marks processed/drop
 * ids seen, so a duplicate delivery never re-invokes the
 * handler); a handler throw becomes "retry", so the platform
 * re-delivers up to max_retries and then lands the message in
 * the DLQ with its run/unit ids intact in the body; a message
 * that can never decode is acked + logged (never poison-loop).
 *
 * options_analysis decision (decided in #2544, not silently in
 * this PR): REVIVE. The options_analysis work item is the only
 * defined work semantics for this queue, and its dispatch rules
 * (#1185/#2331 identity) are still correct, so the consumer
 * routes it to the options-analysis trigger through the
 * QueuePort. The single identity/dispatch implementation lives
 * in src/server.ts (dispatchOptionsAnalysisQueueWork); this
 * handler is a thin adapter over the injected dispatch seam, so
 * the rule is never duplicated. The legacy non-envelope
 * `taskType` shape is a deprecated wrapper in server.ts,
 * superseded by CloudEvents envelope work items routed through
 * this QueuePort consumer — never deleted, per the
 * no-deletion rule.
 */
import {
  type ConsumeOutcome,
  type MessageEnvelope,
  type MessageHandler,
  type QueueConsumerConfig,
} from "./messagingPorts";

/**
 * Report §3.2 — the screener-events consumer config, pinned
 * against wrangler.jsonc by test (gitops §7, the pin rule).
 */
export const SCREENER_EVENTS_CONSUMER_CONFIG: QueueConsumerConfig = {
  maxBatchSize: 10,
  maxBatchTimeoutSeconds: 30,
  maxRetries: 3,
  maxConcurrency: 4,
  deadLetterQueue: "screener-events-dlq",
};

/**
 * Report §3.2 — the delivery consumer config (unchanged
 * batch size/retries, plus DLQ + concurrency cap), pinned
 * against wrangler.jsonc by the same test.
 */
export const SCREENER_EVENTS_DELIVERY_CONSUMER_CONFIG: QueueConsumerConfig = {
  maxBatchSize: 10,
  maxRetries: 3,
  maxConcurrency: 2,
  deadLetterQueue: "screener-events-delivery-dlq",
};

/** One revived work item carried by an envelope. */
export interface ScreenerEventsWork {
  /** Idempotency anchor: jobid, else subject, else the envelope id. */
  runId: string;
  /** Unit within the run: shardid, else stage, else the envelope id. */
  unitId: string;
  /** Trigger payload (the envelope data's payload, else the data). */
  payload: Record<string, unknown>;
}

/**
 * Extract an options_analysis work item from an envelope, or
 * null when the envelope carries no work this consumer handles.
 * The work type is the envelope type `options_analysis`, or a
 * data-level `taskType: "options_analysis"` for producers that
 * wrap the legacy shape in an envelope. Anything else is not
 * work for this queue: the handler drops it (redelivery would
 * only loop — there is no handler that could ever process it).
 */
export function extractScreenerEventsWork(
  envelope: MessageEnvelope
): ScreenerEventsWork | null {
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : null;
  const isWork =
    envelope.type === "options_analysis" ||
    data?.taskType === "options_analysis";
  if (!isWork) return null;
  const rawPayload = data?.payload;
  const payload =
    rawPayload && typeof rawPayload === "object"
      ? (rawPayload as Record<string, unknown>)
      : (data ?? {});
  return {
    runId: envelope.jobid ?? envelope.subject ?? envelope.id,
    unitId: envelope.shardid ?? envelope.stage ?? envelope.id,
    payload,
  };
}

export interface ScreenerEventsWorkHandlerDeps {
  /**
   * The revived options_analysis dispatch (server.ts
   * dispatchOptionsAnalysisQueueWork): "dispatched" on success,
   * "denied" when the identity rules refuse the dispatch (the
   * refusal is already logged there). It THROWS when there is
   * no identity or the trigger dispatch fails — the port core
   * turns the throw into "retry", so the platform re-delivers
   * up to max_retries and then DLQs the message.
   */
  dispatchOptionsAnalysis: (
    payload: Record<string, unknown>,
    runId: string,
    unitId: string
  ) => Promise<"dispatched" | "denied">;
}

/**
 * The QueuePort work handler for screener-events envelopes.
 * Unknown envelope types are dropped with a warning (never
 * retried: no handler could ever process them). A denied
 * dispatch is likewise a drop (a re-dispatch would deny again,
 * and options analysis is time-sensitive — the #2331 rule).
 */
export function createScreenerEventsWorkHandler(
  deps: ScreenerEventsWorkHandlerDeps
): MessageHandler {
  return async (envelope): Promise<ConsumeOutcome> => {
    const work = extractScreenerEventsWork(envelope);
    if (!work) {
      console.warn(
        `[messaging] screener-events: no handler for envelope type "${envelope.type}" (run ${envelope.jobid ?? envelope.subject ?? envelope.id}) — dropping; redelivery would loop.`
      );
      return "drop";
    }
    const outcome = await deps.dispatchOptionsAnalysis(
      work.payload,
      work.runId,
      work.unitId
    );
    return outcome === "denied" ? "drop" : "processed";
  };
}
