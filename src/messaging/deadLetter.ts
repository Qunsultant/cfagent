/**
 * Issue #1764 (#1717 slice: workflow + service identity) — the
 * dead-letter record for terminal queue drops.
 *
 * The F-32 gap, as it stands on current main: the screener queues
 * already have platform dead-letter queues (max_retries 3, then
 * screener-events-dlq / screener-events-delivery-dlq, pinned by
 * #2544), so a retryable handler failure IS bounded — it lands in
 * the DLQ instead of looping forever. What was NOT auditable was
 * everything that never reaches the DLQ: a dispatch denied by the
 * identity rules, an undecodable message, and an envelope no
 * handler exists for are all acked (dropped) with only a bare
 * console warning, so the loss leaves no parseable record and the
 * DLQ queues themselves have no consumer or inspection record.
 *
 * This module is that record. It changes NO ack/retry semantics:
 * a "retry" still retries into the platform DLQ path, and a "drop"
 * still acks — the record is emitted alongside the drop, on the
 * same console channel, as one JSON line a log reader can grep
 * (`[dead-letter]`) and parse. The DLQ queues stay consumer-less
 * by design in this slice: a DLQ consumer that acked would destroy
 * the evidence, and a DLQ inspection/replay consumer is named as
 * the follow-up in workflow-security.md §4, not silently built
 * here. The terminal-drop record is the auditable half; the DLQ
 * landing itself is platform-recorded (queue metrics + retention).
 *
 * Reasons are a closed vocabulary so a record can be counted:
 * "denied" (identity rules refused the dispatch), "undecodable"
 * (bytes that can never decode), "no_handler" (no handler could
 * ever process this type), "invalid_envelope" (failed the
 * CloudEvents shape check), "max_retries_exceeded" (reserved for
 * a future DLQ consumer: the platform already moved it to the DLQ).
 */
import type { ActorKind } from "../security/backgroundAttribution";

export type DeadLetterReason =
  | "denied"
  | "undecodable"
  | "no_handler"
  | "invalid_envelope"
  | "max_retries_exceeded";

export interface DeadLetterRecord {
  event: "queue.dead_letter";
  queue: string;
  reason: DeadLetterReason;
  /** Envelope/message id when one is known; null for undecodable bytes. */
  messageId: string | null;
  runId?: string;
  unitId?: string;
  actorLogin?: string;
  actorKind?: ActorKind;
  subscriber?: string;
  detail?: string;
  /** Milliseconds since epoch; defaults to Date.now() at creation. */
  atMs: number;
}

export interface DeadLetterInput {
  queue: string;
  reason: DeadLetterReason;
  messageId?: string | null;
  runId?: string;
  unitId?: string;
  actorLogin?: string;
  actorKind?: ActorKind;
  subscriber?: string;
  detail?: string;
  atMs?: number;
}

/** Build a dead-letter record. Pure: no I/O, no store, no throwing. */
export function createDeadLetterRecord(
  input: DeadLetterInput
): DeadLetterRecord {
  const record: DeadLetterRecord = {
    event: "queue.dead_letter",
    queue: input.queue,
    reason: input.reason,
    messageId: input.messageId ?? null,
    atMs: input.atMs ?? Date.now(),
  };
  if (input.runId !== undefined) record.runId = input.runId;
  if (input.unitId !== undefined) record.unitId = input.unitId;
  if (input.actorLogin !== undefined) record.actorLogin = input.actorLogin;
  if (input.actorKind !== undefined) record.actorKind = input.actorKind;
  if (input.subscriber !== undefined) record.subscriber = input.subscriber;
  if (input.detail !== undefined) record.detail = input.detail;
  return record;
}

/** One parseable log line for a record: `[dead-letter] {json}`. */
export function deadLetterLogLine(record: DeadLetterRecord): string {
  return `[dead-letter] ${JSON.stringify(record)}`;
}

/** A sink for dead-letter records; the production sink is the console. */
export interface DeadLetterSink {
  record(record: DeadLetterRecord): void;
}

/** The production sink: the structured line on the console warn channel. */
export const consoleDeadLetterSink: DeadLetterSink = {
  record(record: DeadLetterRecord): void {
    console.warn(deadLetterLogLine(record));
  },
};

/** Emit one record through the production sink. */
export function logDeadLetter(record: DeadLetterRecord): void {
  consoleDeadLetterSink.record(record);
}
