/**
 * Issue #2548 — Drizzle D1 adapter for the proof redemption
 * port. This module is the ONLY place proof-redemption code
 * touches a store client (ADR 0002 R2).
 *
 * The replay guard is read-before-write on the redemption key,
 * backed by the table's PRIMARY KEY (migration 0029): a replayed
 * record returns the existing row without writing, and a racing
 * second write is swallowed by onConflictDoNothing and re-read —
 * the same shape as the native ledger adapter (#2192). Single
 * statements only, for the transaction reason recorded in
 * migrationRunner.ts.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentPaymentProofRedemptions } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0029_PROOF_REDEMPTIONS,
  type MigrationDb,
} from "./migrationRunner";
import {
  validateRedemptionInput,
  type ProofRedemptionRecord,
  type ProofRedemptionStore,
} from "./proofRedemptionPorts";

/** Drizzle D1 database object carrying the proof redemption schema. */
export type ProofRedemptionDb = DrizzleD1Database<{
  agentPaymentProofRedemptions: typeof agentPaymentProofRedemptions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProofRedemptionDb(d1: D1Database): ProofRedemptionDb {
  return drizzle(d1, {
    schema: {
      agentPaymentProofRedemptions,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0029 if unapplied. Money paths ensure before confirming. */
export async function ensureProofRedemptionSchema(db: ProofRedemptionDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0029_PROOF_REDEMPTIONS]);
}

function toRecord(raw: typeof agentPaymentProofRedemptions.$inferSelect): ProofRedemptionRecord {
  return {
    redemptionKey: raw.redemptionKey,
    runRequestId: raw.runRequestId,
    rail: raw.rail as "stripe" | "x402",
    payer: raw.payer ?? null,
    redeemedAtMs: raw.redeemedAtMs,
  };
}

/** Proof redemption store over D1 via Drizzle. */
export class D1ProofRedemptionAdapter implements ProofRedemptionStore {
  constructor(readonly db: ProofRedemptionDb) {}

  async findRedemption(redemptionKey: string): Promise<ProofRedemptionRecord | null> {
    const key = redemptionKey.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(agentPaymentProofRedemptions)
      .where(eq(agentPaymentProofRedemptions.redemptionKey, key))
      .limit(1);
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async recordRedemption(input: {
    redemptionKey: string;
    runRequestId: string;
    rail: "stripe" | "x402";
    payer?: string | null;
  }): Promise<{ record: ProofRedemptionRecord; duplicate: boolean }> {
    validateRedemptionInput(input);
    const key = input.redemptionKey.trim().toLowerCase();
    const existing = await this.findRedemption(key);
    if (existing) return { record: existing, duplicate: true };
    const record: ProofRedemptionRecord = {
      redemptionKey: key,
      runRequestId: input.runRequestId,
      rail: input.rail,
      payer: input.payer ?? null,
      redeemedAtMs: Date.now(),
    };
    await this.db
      .insert(agentPaymentProofRedemptions)
      .values({
        redemptionKey: record.redemptionKey,
        runRequestId: record.runRequestId,
        rail: record.rail,
        payer: record.payer,
        redeemedAtMs: record.redeemedAtMs,
      })
      .onConflictDoNothing();
    // Re-read: if a racing write won the key, its record is the
    // truth and this call is the duplicate.
    const stored = await this.findRedemption(key);
    if (!stored) throw new Error("proof redemption: record write did not persist (store error).");
    return { record: stored, duplicate: stored.runRequestId !== input.runRequestId };
  }
}
