/**
 * Phase 5 Slice 2 (issue #2000) — breaker trip subscriber.
 *
 * Consumes the existing breaker.state_changed envelopes (no
 * new event type) and posts exactly once per open transition
 * via the injected postText channel. The claim guard is the
 * envelope id itself (provider:to:seq, the idempotency key):
 * a second delivery of the same envelope — a repeated state
 * read, a re-emission, a redelivery — claims nothing and
 * posts nothing.
 *
 * Scope, stated plainly: only open transitions alert.
 * half-open and closed transitions are acknowledgments, not
 * incidents. A failed post consumes the claim (the stuck
 * alert's trade-off): the trip stays visible in the store and
 * in snapshots, but no re-alert fires for it.
 */
import type { MessageEnvelope } from "../messaging/messagingPorts";

export interface TripSubscriberDeps {
  /** Post one alert text; resolves {ok} like postSlackText. */
  postText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Guarded claim: first caller for a transition id wins. */
  claimTripAlert: (transitionId: string, atMs: number, token: string) => Promise<boolean>;
  nowMs?: () => number;
}

export type TripSubscriberResult =
  | { posted: true }
  | { posted: false; skipped: string; error?: string };

export interface TripSubscriber {
  handleEnvelope(envelope: MessageEnvelope): Promise<TripSubscriberResult>;
}

export function createBreakerTripSubscriber(deps: TripSubscriberDeps): TripSubscriber {
  const nowMs = deps.nowMs ?? Date.now;
  let tokenCounter = 0;
  /** Fresh token per call: the token-matching claim store
   *  treats a re-used token as an idempotent re-claim (true),
   *  so a re-delivery MUST present a new token to lose. */
  const freshToken = (): string =>
    `trip-${nowMs().toString(36)}-${(tokenCounter += 1)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    async handleEnvelope(envelope: MessageEnvelope): Promise<TripSubscriberResult> {
      if (envelope.type !== "breaker.state_changed") {
        return { posted: false, skipped: "not-breaker" };
      }
      const data = envelope.data as
        | { providerId?: unknown; from?: unknown; to?: unknown; trips?: unknown; fallbacks?: unknown }
        | null
        | undefined;
      if (!data || typeof data !== "object") {
        return { posted: false, skipped: "malformed" };
      }
      if (data.to !== "open") {
        return { posted: false, skipped: "not-open" };
      }
      let claimed: boolean;
      try {
        claimed = await deps.claimTripAlert(envelope.id, nowMs(), freshToken());
      } catch (err) {
        return {
          posted: false,
          skipped: "claim-failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!claimed) {
        return { posted: false, skipped: "already-alerted" };
      }
      const providerId = typeof data.providerId === "string" ? data.providerId : "unknown";
      const from = typeof data.from === "string" ? data.from : "?";
      const trips = typeof data.trips === "number" ? data.trips : 0;
      const fallbacks = typeof data.fallbacks === "number" ? data.fallbacks : 0;
      const text =
        `🚨 Circuit breaker OPEN: ${providerId} (${from} → open, trip #${trips}, ${fallbacks} fallbacks) — ` +
        `provider calls are rejected instantly until the reset timeout elapses.\n` +
        `Diagnosis + safe intervention: docs/operations/runbook/alerting.md#breaker-trips`;
      let result: { ok: boolean; error?: string };
      try {
        result = await deps.postText(text);
      } catch (err) {
        return {
          posted: false,
          skipped: "post-failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!result.ok) {
        return { posted: false, skipped: "post-failed", error: result.error ?? "post failed" };
      }
      return { posted: true };
    },
  };
}
