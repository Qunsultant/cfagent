/**
 * Phase 5 Slice 1 (issue #2000) — in-memory dead-letter
 * store. Test double with exactly the port's guarded-claim
 * semantics (token-checked claims, newest-first listing).
 * Single-threaded, so the claims are trivially race-safe.
 */
import {
  newDeadLetterRecordId,
  type DeadLetterStore,
  type DeadLetterStoreInsert,
  type DeadLetterStoreRecord,
} from "../messaging/deadLetterStorePorts";

export class InMemoryDeadLetterStoreAdapter implements DeadLetterStore {
  private readonly rows = new Map<string, DeadLetterStoreRecord>();
  private depthIncident: { alertedAtMs: number; depthAtAlert: number; claimToken: string } | null = null;

  async insert(input: DeadLetterStoreInsert): Promise<DeadLetterStoreRecord> {
    const createdAtMs = input.createdAtMs ?? Date.now();
    const record: DeadLetterStoreRecord = {
      id: newDeadLetterRecordId(createdAtMs),
      queue: input.queue,
      reason: input.reason,
      messageId: input.messageId ?? null,
      runId: input.runId ?? null,
      unitId: input.unitId ?? null,
      actorLogin: input.actorLogin ?? null,
      actorKind: input.actorKind ?? null,
      subscriber: input.subscriber ?? null,
      detail: input.detail ?? null,
      envelopeJson: input.envelope ? JSON.stringify(input.envelope) : null,
      createdAtMs,
      replayedAtMs: null,
      replayOutcome: null,
      replayToken: null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async listUnreplayed(limit: number): Promise<DeadLetterStoreRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.replayedAtMs === null)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit);
  }

  async getById(id: string): Promise<DeadLetterStoreRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async markReplayed(input: { id: string; outcome: string; atMs: number; token: string }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row || row.replayedAtMs !== null) return false;
    row.replayedAtMs = input.atMs;
    row.replayOutcome = input.outcome;
    row.replayToken = input.token;
    return true;
  }

  async unreplayedCount(): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) if (row.replayedAtMs === null) n++;
    return n;
  }

  async claimDepthIncident(input: { depth: number; atMs: number; token: string }): Promise<boolean> {
    if (this.depthIncident !== null) return false;
    this.depthIncident = { alertedAtMs: input.atMs, depthAtAlert: input.depth, claimToken: input.token };
    return true;
  }

  async clearDepthIncident(): Promise<boolean> {
    if (this.depthIncident === null) return false;
    this.depthIncident = null;
    return true;
  }
}
