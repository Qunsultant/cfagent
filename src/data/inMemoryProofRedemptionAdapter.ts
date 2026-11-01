/**
 * Issue #2548 — in-memory proof redemption store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store: durability across instances is
 * exactly what the D1 adapter provides and this one cannot.
 * Sharing ONE instance between two gates in a test models the
 * shared durable store those gates would see in production.
 */
import {
  validateRedemptionInput,
  type ProofRedemptionRecord,
  type ProofRedemptionStore,
} from "./proofRedemptionPorts";

export class InMemoryProofRedemptionAdapter implements ProofRedemptionStore {
  private records = new Map<string, ProofRedemptionRecord>();

  async findRedemption(redemptionKey: string): Promise<ProofRedemptionRecord | null> {
    const record = this.records.get(redemptionKey.trim().toLowerCase());
    return record ? { ...record } : null;
  }

  async recordRedemption(input: {
    redemptionKey: string;
    runRequestId: string;
    rail: "stripe" | "x402";
    payer?: string | null;
  }): Promise<{ record: ProofRedemptionRecord; duplicate: boolean }> {
    validateRedemptionInput(input);
    const key = input.redemptionKey.trim().toLowerCase();
    const existing = this.records.get(key);
    if (existing) return { record: { ...existing }, duplicate: true };
    const record: ProofRedemptionRecord = {
      redemptionKey: key,
      runRequestId: input.runRequestId,
      rail: input.rail,
      payer: input.payer ?? null,
      redeemedAtMs: Date.now(),
    };
    this.records.set(key, record);
    return { record: { ...record }, duplicate: false };
  }
}
