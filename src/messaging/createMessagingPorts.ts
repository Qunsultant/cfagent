/**
 * Issue #1739 — the messaging composition root. This is the ONLY
 * module (besides the provider adapter) that touches provider
 * bindings: it reads the configured queue bindings out of the
 * environment and builds the provider adapter around them.
 * Domain code imports this helper and the port types, never a
 * binding.
 *
 * Bindings (all optional, all fail-open to legacy behavior):
 *  - SCREENER_EVENTS: the point-to-point work queue. Absence
 *    means no messaging ports at all (null) — callers keep
 *    their legacy behavior (the in-process bus for screener
 *    events). A provider queue must never be silently replaced
 *    by an in-memory queue in production — that would lie about
 *    durability — so the in-memory adapter is constructed
 *    explicitly by its users (tests, local development), never
 *    here.
 *  - SCREENER_EVENTS_DELIVERY: the broadcast subscriber queue
 *    for the delivery subscriber. Absence means publish fans
 *    out to zero subscribers, so callers fall back to the legacy
 *    bus (nothing received it); presence wires the delivery
 *    subscriber into the fan-out registry.
 *
 * The optional shared seen set lets a host dedup across batches
 * within one isolate (module-level state in the worker).
 */
import {
  CfQueueMessagingAdapter,
  type QueueSendBinding,
} from "./cfQueueMessagingAdapter";
import type { MessagingPorts } from "./messagingPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "messaging/createMessagingPorts",
});

export interface MessagingEnv {
  SCREENER_EVENTS?: unknown;
  SCREENER_EVENTS_DELIVERY?: unknown;
}

function asSendBinding(value: unknown): QueueSendBinding | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { send?: unknown }).send === "function"
  ) {
    return value as QueueSendBinding;
  }
  return null;
}

/**
 * Build messaging ports from the worker environment, or null when
 * no work-queue binding is configured. A malformed binding
 * (present but without a send capability) also yields null, with
 * a warning — callers fall back to legacy behavior rather than
 * crashing.
 */
export function createMessagingPorts(
  env: MessagingEnv,
  opts?: { seenIds?: Set<string> }
): MessagingPorts | null {
  const workQueue = asSendBinding(env.SCREENER_EVENTS);
  if (!workQueue) {
    if (env.SCREENER_EVENTS) {
      structuredLog.warn("messaging.ports_unavailable", {
        message:
          "[messaging] SCREENER_EVENTS binding is present but has no send capability — messaging ports unavailable.",
      });
    }
    return null;
  }
  const subscribers: Record<string, QueueSendBinding> = {};
  const delivery = asSendBinding(env.SCREENER_EVENTS_DELIVERY);
  if (delivery) {
    subscribers.delivery = delivery;
  } else if (env.SCREENER_EVENTS_DELIVERY) {
    structuredLog.warn("messaging.delivery_subscriber_not_fanned_out", {
      message:
        "[messaging] SCREENER_EVENTS_DELIVERY binding is present but has no send capability — delivery subscriber not fanned out.",
    });
  }
  const adapter = new CfQueueMessagingAdapter(workQueue, {
    subscribers,
    seenIds: opts?.seenIds,
  });
  return {
    producer: adapter,
    consumer: adapter,
    publisher: adapter,
    subscriber: adapter,
  };
}
