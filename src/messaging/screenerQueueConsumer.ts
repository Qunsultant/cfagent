/**
 * Issue #1739 — the queue-side consumer for screener events.
 * The provider delivers envelopes; this handler turns each one
 * back into a delivery through the existing publishers. The
 * in-process bus stays as the fan-out inside the consumer: the
 * queue is the durability boundary, the bus is the local
 * fan-out, and the publishers themselves are untouched.
 *
 * Identity rule (same as every other unattended queue path):
 * dispatch under the data owner when present, else the
 * configured service identity; with neither, return the retry
 * disposition — never dispatch under a fabricated identity, and
 * never silently drop work that might succeed on redelivery.
 * The deliver seam is injectable so tests never touch real
 * delivery channels; the default builds a fresh bus and
 * registers the real publishers on it.
 */
import { getServiceUserLogin } from "../security/serviceIdentity";
import {
  ScreenerEventBus,
  type ScreenerEvent,
} from "../events/screenerEvents";
import { registerScreenerPublishers } from "../events/screenerPublishers";
import type { Env } from "../types";
import { fromScreenerEnvelope } from "./screenerEventEnvelope";
import type { ConsumeOutcome, MessageHandler } from "./messagingPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "messaging/screenerQueueConsumer",
});

export interface ScreenerQueueHandlerDeps {
  env: Env;
  resolveUserLogin?: (env: Env) => string | null;
  deliver?: (event: ScreenerEvent, userLogin: string) => Promise<void>;
}

export function createScreenerQueueHandler(
  deps: ScreenerQueueHandlerDeps
): MessageHandler {
  const resolveUserLogin =
    deps.resolveUserLogin ?? ((env: Env) => getServiceUserLogin(env));
  const deliver =
    deps.deliver ??
    (async (event: ScreenerEvent, userLogin: string) => {
      const bus = new ScreenerEventBus();
      registerScreenerPublishers(bus, {
        env: deps.env,
        orm: undefined,
        userLogin,
      });
      await bus.publish(event);
    });

  return async (envelope): Promise<ConsumeOutcome> => {
    const parsed = fromScreenerEnvelope(envelope);
    if (!parsed) {
      structuredLog.warn("messaging.queue_message_not_screener_event", {
        message: "[messaging] Dropping queue message: payload is not a screener event.",
      });
      return "drop";
    }
    const userLogin = parsed.ownerLogin ?? resolveUserLogin(deps.env);
    if (!userLogin) {
      structuredLog.warn("messaging.queue_message_no_owner", {
        message:
          "[messaging] Screener queue message has no data owner and no service identity — refusing to dispatch under a fabricated identity.",
      });
      return "retry";
    }
    try {
      await deliver(parsed.event, userLogin);
      return "processed";
    } catch (err) {
      structuredLog.warn("messaging.queue_delivery_failed", {
        message: "[messaging] Screener queue delivery failed, will retry",
        error: err instanceof Error ? err.message : String(err),
      });
      return "retry";
    }
  };
}
