/**
 * Issue #1739 — the provider queue adapter. This module is the
 * ONLY place (besides the composition root's binding lookup)
 * that knows anything about the provider queue: it owns the
 * send call, the batch-message shape, and the mapping from the
 * port's neutral dispositions to the provider's own per-message
 * mechanics. Domain code never sees any of it.
 *
 * The binding is taken as a structural interface (anything with
 * a send method) rather than a provider type import, so the
 * adapter depends on a capability, not on a provider SDK type.
 * The real queue binding satisfies it structurally.
 *
 * Two primitives, mirroring the port:
 *  - Point-to-point: `send` puts a job/command message on the
 *    single work queue; `consume` runs the shared consumption
 *    core over explicit envelopes.
 *  - Broadcast: `publish` fans out to one queue per subscriber
 *    (the provider's queues are point-to-point, so broadcast
 *    is fan-out, never a single consumer that secretly calls
 *    everything). Each subscriber queue is later dispatched by
 *    the worker's batch entry point through the subscriber
 *    batch bridge below, which routes by subscriber name and
 *    event type with per-subscriber dedup.
 *
 * Disposition mapping for a provider batch: "processed",
 * "dropped", and "duplicate" all acknowledge the message (the
 * work is done, refused terminally, or already done); "retried"
 * asks for redelivery. An "invalid" (undecodable) message is
 * acknowledged — redelivering bytes that can never decode would
 * poison-loop the batch — and logged, so the loss is visible.
 */
import {
  assertMessageEnvelope,
  deliverEnvelopes,
  dispatchEnvelope,
  isMessageEnvelope,
  MessagingError,
  type ConsumeOutcome,
  type ConsumeReport,
  type MessageConsumer,
  type MessageEnvelope,
  type MessageHandler,
  type MessageProducer,
  type MessagePublisher,
  type MessageSubscriber,
  type PublishReport,
  type SubscriberHandlers,
} from "./messagingPorts";
import {
  createDeadLetterRecord,
  logDeadLetter,
} from "./deadLetter";

/** Minimal structural shape of a provider queue producer binding. */
export interface QueueSendBinding {
  send(body: unknown): Promise<void>;
}

/** Minimal structural shape of a provider queue batch message. */
export interface ProviderQueueMessage {
  body: unknown;
  ack: () => void;
  retry: () => void;
}

/** Minimal structural shape of a provider queue batch. */
export interface ProviderQueueBatch {
  queue: string;
  messages: ProviderQueueMessage[];
}

export interface CfQueueAdapterOpts {
  /** Subscriber name → its queue binding. Fan-out targets. */
  subscribers?: Record<string, QueueSendBinding>;
  /** Shared seen set (dedup survives across batches in one isolate). */
  seenIds?: Set<string>;
}

export class CfQueueMessagingAdapter
  implements
    MessageProducer,
    MessageConsumer,
    MessagePublisher,
    MessageSubscriber
{
  private seen: Set<string>;
  private subSeen: Set<string>;
  private handlers: SubscriberHandlers = new Map();
  private subscribers: Record<string, QueueSendBinding>;

  constructor(
    private queue: QueueSendBinding,
    opts?: CfQueueAdapterOpts
  ) {
    this.seen = opts?.seenIds ?? new Set<string>();
    // Broadcast dedup is per subscriber, a different scope from
    // point-to-point dedup: a work-queue message and a broadcast
    // event that happen to share an id are different
    // deliveries, so they must not share a seen set.
    this.subSeen = new Set<string>();
    this.subscribers = opts?.subscribers ?? {};
  }

  async send(envelope: MessageEnvelope): Promise<void> {
    const valid = assertMessageEnvelope(envelope);
    try {
      await this.queue.send(valid);
    } catch {
      // Never leak the provider error shape: neutral code only.
      throw new MessagingError("send_failed", "Provider queue send failed.");
    }
  }

  async sendBatch(envelopes: readonly MessageEnvelope[]): Promise<void> {
    const valid = envelopes.map((e) => assertMessageEnvelope(e));
    for (const item of valid) {
      try {
        await this.queue.send(item);
      } catch {
        // Sequential send means an earlier item may already be
        // queued; the throw aborts the remainder, and the caller
        // sees a neutral failure, not a partial-batch provider state.
        throw new MessagingError(
          "send_failed",
          "Provider queue send failed partway through a batch."
        );
      }
    }
  }

  async consume(
    envelopes: readonly unknown[],
    handler: MessageHandler
  ): Promise<ConsumeReport> {
    return deliverEnvelopes(envelopes, this.seen, handler);
  }

  async publish(envelope: MessageEnvelope): Promise<PublishReport> {
    const valid = assertMessageEnvelope(envelope);
    const deliveredTo: string[] = [];
    const failedTo: string[] = [];
    for (const [name, binding] of Object.entries(this.subscribers)) {
      try {
        await binding.send(valid);
        deliveredTo.push(name);
      } catch {
        failedTo.push(name);
      }
    }
    return { deliveredTo, failedTo };
  }

  subscribe(
    subscriber: string,
    type: string,
    handler: MessageHandler
  ): () => void {
    let byType = this.handlers.get(subscriber);
    if (!byType) {
      byType = new Map();
      this.handlers.set(subscriber, byType);
    }
    byType.set(type, handler);
    return () => {
      const current = this.handlers.get(subscriber)?.get(type);
      if (current === handler) {
        this.handlers.get(subscriber)?.delete(type);
      }
    };
  }

  async dispatch(
    subscriber: string,
    envelope: MessageEnvelope
  ): Promise<ConsumeOutcome> {
    return dispatchEnvelope(this.handlers, this.subSeen, subscriber, envelope);
  }
}

/**
 * Bridge a provider batch through the port's consumer core, then
 * translate each result back into the provider's per-message
 * mechanics. Results align 1:1 with input order.
 */
export async function consumeCfBatch(
  batch: ProviderQueueBatch,
  consumer: MessageConsumer,
  handler: MessageHandler
): Promise<void> {
  const bodies = batch.messages.map((m) => m.body);
  const report = await consumer.consume(bodies, handler);
  report.results.forEach((result, i) => {
    const msg = batch.messages[i];
    if (!msg) return;
    if (result.disposition === "invalid") {
      // Issue #1764 — the drop keeps its ack (redelivering bytes
      // that can never decode would poison-loop), but it now
      // leaves a structured dead-letter record, not a bare warning.
      logDeadLetter(
        createDeadLetterRecord({
          queue: batch.queue,
          reason: "undecodable",
          detail:
            "Dropping undecodable queue message (no valid envelope) (#1764).",
        })
      );
    }
    if (result.disposition === "retried") {
      msg.retry();
    } else {
      msg.ack();
    }
  });
}

/**
 * Bridge a provider subscriber batch through the broadcast core.
 * The worker's batch entry point builds the handler map per
 * batch (handlers need per-batch environment) and passes a
 * module-level seen set so dedup survives across batches in one
 * isolate. Undecodable messages are acknowledged with a warning
 * (they can never decode); a "retry" outcome asks for
 * redelivery; anything else acknowledges.
 */
export async function dispatchSubscriberBatch(
  batch: ProviderQueueBatch,
  subscriber: string,
  handlers: SubscriberHandlers,
  seen: Set<string>
): Promise<void> {
  for (const msg of batch.messages) {
    if (!isMessageEnvelope(msg.body)) {
      // Issue #1764 — acked as before (undecodable bytes can never
      // decode), now with a structured dead-letter record.
      logDeadLetter(
        createDeadLetterRecord({
          queue: batch.queue,
          reason: "undecodable",
          subscriber,
          detail:
            "Dropping undecodable subscriber message (no valid envelope) (#1764).",
        })
      );
      msg.ack();
      continue;
    }
    const outcome = await dispatchEnvelope(handlers, seen, subscriber, msg.body);
    if (outcome === "retry") {
      msg.retry();
    } else {
      msg.ack();
    }
  }
}
