/**
 * Phase 5 Slice 1 (issue #2000) — dead-letter store port.
 *
 * No SQL, no env binding, no store client: adapters live in
 * src/data/*, the composition root in createDeadLetterStorePorts.ts.
 *
 * Working default (not a ruling): the platform DLQ queues are
 * consumer-less by design and a Worker cannot peek queue
 * contents, so replay cannot read a queue directly. Instead,
 * every terminal drop is persisted here at drop time — the
 * full envelope when the drop carried one — and replay reads
 * from this store. A message dropped, replayed, and dropped
 * again is a NEW landing and a NEW row: one insert per sink
 * emission, never deduplicated on message id.
 *
 * Depth semantics: the DLQ-depth alert counts un-replayed
 * rows. Platform DLQ landings (max_retries exhausted) are NOT
 * in this store — worker code cannot observe them — and are
 * visible only through dashboard queue metrics; see the
 * runbook docs/operations/runbook/dlq-replay.md.
 *
 * envelopeJson is JSON TEXT: readers must JSON.parse it
 * before touching envelope fields (the mas_events.payload rule).
 * Record ids are generated per landing (dlq-<ts36>-<rand>),
 * never derived from the message id, so two landings of one
 * message stay distinct rows.
 */
import type { DeadLetterReason } from "./deadLetter";

/** One persisted terminal drop. */
export interface DeadLetterStoreRecord {
  id: string;
  queue: string;
  reason: DeadLetterReason;
  messageId: string | null;
  runId: string | null;
  unitId: string | null;
  actorLogin: string | null;
  actorKind: string | null;
  subscriber: string | null;
  detail: string | null;
  /** Full envelope as JSON text when the drop carried a decodable envelope; null otherwise. */
  envelopeJson: string | null;
  createdAtMs: number;
  replayedAtMs: number | null;
  replayOutcome: string | null;
  replayToken: string | null;
}

/** Insert input: envelope is the object; adapters stringify it. */
export interface DeadLetterStoreInsert {
  queue: string;
  reason: DeadLetterReason;
  messageId?: string | null;
  runId?: string | null;
  unitId?: string | null;
  actorLogin?: string | null;
  actorKind?: string | null;
  subscriber?: string | null;
  detail?: string | null;
  envelope?: Record<string, unknown> | null;
  createdAtMs?: number;
}

export interface DeadLetterStore {
  /** One row per call. Never deduplicates. */
  insert(input: DeadLetterStoreInsert): Promise<DeadLetterStoreRecord>;
  /** Un-replayed rows, newest first. */
  listUnreplayed(limit: number): Promise<DeadLetterStoreRecord[]>;
  getById(id: string): Promise<DeadLetterStoreRecord | null>;
  /**
   * Guarded replay claim: true iff this call marked the row
   * (replayed_at_ms was null). The token check makes the claim
   * race-safe without relying on affected-row counts, which are
   * not portable across the D1 client and the test stand-in.
   */
  markReplayed(input: { id: string; outcome: string; atMs: number; token: string }): Promise<boolean>;
  unreplayedCount(): Promise<number>;
  /**
   * Guarded depth-incident claim: true iff this call opened
   * the incident. Same token pattern as markReplayed.
   */
  claimDepthIncident(input: { depth: number; atMs: number; token: string }): Promise<boolean>;
  /** True iff an open incident was cleared by this call. */
  clearDepthIncident(): Promise<boolean>;
}

/** Per-landing record id: distinct even for one message dropped twice. */
export function newDeadLetterRecordId(createdAtMs: number): string {
  return `dlq-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
