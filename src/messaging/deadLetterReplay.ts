/**
 * Phase 5 Slice 1 (issue #2000) — DLQ replay.
 *
 * Working default (not a ruling): replay reads from the
 * dead-letter store, never from the platform DLQ queues
 * (consumer-less by design, unpeekable from a Worker). No
 * new consumer binding is added by this slice — a binding
 * change would be a COO readiness gate, not a silent build.
 *
 * Replay re-sends the identical envelope object, so the
 * envelope id — the idempotency key per ADR 0003 M4 — is
 * intact by construction: downstream id-based dedup treats
 * the redelivery as the same work, not new work. For a
 * no_handler original nothing was ever processed, so replay
 * is the FIRST processing, not a double-apply.
 *
 * Replayable set: no_handler records carrying an envelope.
 * Refused with a coded reason (the refusal code IS the reason
 * vocabulary, plus unknown_record / already_replayed /
 * no_envelope / unknown_queue / send_failed):
 * - undecodable: no decodable envelope exists to re-drive.
 * - denied: the identity rules would deny again; re-driving
 *   past them would be a security hole, not a recovery.
 * - invalid_envelope: the stored envelope fails the shape
 *   check; re-driving it would drop again.
 * The senders map contains ONLY source queues — a record
 * naming a DLQ queue can never be re-driven into a DLQ.
 * A failed send leaves the record un-replayed (operator-
 * retryable). No catalog entries are added for refusal codes
 * here: catalog rendering is Slice 9's domain.
 */
import { assertMessageEnvelope, type MessageEnvelope } from "./messagingPorts";
import type { DeadLetterStore, DeadLetterStoreRecord } from "./deadLetterStorePorts";

export interface ReplaySender {
  send(body: unknown): Promise<void>;
}

export type ReplayRefusalCode =
  | "unknown_record"
  | "already_replayed"
  | "undecodable"
  | "denied"
  | "invalid_envelope"
  | "no_envelope"
  | "unknown_queue"
  | "send_failed";

export type ReplayResult =
  | { ok: true; record: DeadLetterStoreRecord }
  | { ok: false; code: ReplayRefusalCode };

export interface ReplayDeps {
  store: DeadLetterStore;
  /** Source queues only — never the DLQ queues. */
  senders: Record<string, ReplaySender>;
  nowMs?: number;
}

const REFUSAL_REASONS = new Set(["undecodable", "denied", "invalid_envelope"]);

/** Re-drive one dead-letter record to its source queue. */
export async function replayDeadLetter(deps: ReplayDeps, recordId: string): Promise<ReplayResult> {
  const record = await deps.store.getById(recordId);
  if (!record) return { ok: false, code: "unknown_record" };
  if (record.replayedAtMs !== null) return { ok: false, code: "already_replayed" };
  if (REFUSAL_REASONS.has(record.reason)) {
    return { ok: false, code: record.reason as ReplayRefusalCode };
  }
  if (!record.envelopeJson) return { ok: false, code: "no_envelope" };
  let envelope: MessageEnvelope;
  try {
    envelope = JSON.parse(record.envelopeJson) as MessageEnvelope;
    assertMessageEnvelope(envelope);
  } catch {
    return { ok: false, code: "invalid_envelope" };
  }
  const sender = deps.senders[record.queue];
  if (!sender) return { ok: false, code: "unknown_queue" };
  try {
    // Identical envelope object: identical id, the idempotency key.
    await sender.send(envelope);
  } catch {
    return { ok: false, code: "send_failed" };
  }
  const nowMs = deps.nowMs ?? Date.now();
  const claimed = await deps.store.markReplayed({
    id: record.id,
    outcome: "replayed",
    atMs: nowMs,
    token: `replay-${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
  });
  if (!claimed) return { ok: false, code: "already_replayed" };
  const marked = (await deps.store.getById(record.id))!;
  return { ok: true, record: marked };
}
