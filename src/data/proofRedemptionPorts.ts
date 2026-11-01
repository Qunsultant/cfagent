/**
 * Issue #2548 (from the #2013 review) — durable payment-proof
 * redemption port.
 *
 * The native gate's replay guard was per-instance in-memory
 * (byClaim), but the workflow builds a fresh gate per run and
 * confirm normally executes against a fresh gate after a durable
 * resume — so cross-run proof replay was unguarded, and the
 * stateless confirm had no challenge-nonce binding at all. This
 * port is the durable half of the guard: a redemption record,
 * keyed by the proof's identity, in the same D1 AgentDB store
 * family as the native ledger (#2192). A proof redeems exactly
 * once, across gate instances and process restarts; the first
 * run to record the redemption owns it.
 *
 * Redemption keys (all normalized to lowercase by the builders
 * below, mirroring the gate's in-memory byClaim keys):
 * - `claim:<id>` — a claim tx hash, Stripe payment-intent id, or
 *   Stripe session id presented with the proof.
 * - `x402:<nonce>:<payer>` — the facilitator-verified challenge
 *   nonce + payer. Making the nonce part of the durable identity
 *   is the nonce binding the stateless confirm path was missing:
 *   a proof minted against one run's challenge cannot be spent
 *   on another run, because its nonce was already redeemed.
 * - `x402-proof:<sha256>` — the proof payload itself, so a proof
 *   whose verdict carries no nonce is still replay-bound.
 *
 * Port-first (ADR 0002 R1/R2): this module carries types, key
 * builders, and validators ONLY — no store client, no env, no
 * SQL. Adapters live in d1ProofRedemptionAdapter.ts and
 * inMemoryProofRedemptionAdapter.ts; the composition root is
 * createProofRedemptionPorts.ts.
 */

export type ProofRail = "stripe" | "x402";

export interface ProofRedemptionRecord {
  redemptionKey: string;
  runRequestId: string;
  rail: ProofRail;
  payer: string | null;
  redeemedAtMs: number;
}

export interface ProofRedemptionStore {
  /** The redemption recorded under a key, or null if the key was never redeemed. */
  findRedemption(redemptionKey: string): Promise<ProofRedemptionRecord | null>;
  /**
   * Record a redemption. Idempotent per key: if the key already
   * exists, returns `{ duplicate: true }` with the EXISTING
   * record (whose runRequestId names the run that owns the
   * proof) instead of writing a second record.
   */
  recordRedemption(input: {
    redemptionKey: string;
    runRequestId: string;
    rail: ProofRail;
    payer?: string | null;
  }): Promise<{ record: ProofRedemptionRecord; duplicate: boolean }>;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function requireKeyPart(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`proof redemption: ${field} must be a non-empty string.`);
  }
  return normalizeKeyPart(value);
}

/** Key for a presented claim/session/payment-intent identifier. */
export function claimRedemptionKey(rawId: string): string {
  return `claim:${requireKeyPart(rawId, "claim id")}`;
}

/** Key binding an x402 proof to its challenge nonce + verified payer. */
export function x402NonceRedemptionKey(nonce: string, payer: string): string {
  return `x402:${requireKeyPart(nonce, "nonce")}:${requireKeyPart(payer, "payer")}`;
}

/** Key for the x402 proof payload itself (SHA-256 hex), for proofs whose verdict carries no nonce. */
export async function x402ProofRedemptionKey(paymentProof: string): Promise<string> {
  const bytes = new TextEncoder().encode(paymentProof);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `x402-proof:${hex}`;
}

/** Shared validator: every adapter runs inputs through this, so stored records cannot disagree on shape. */
export function validateRedemptionInput(input: {
  redemptionKey: string;
  runRequestId: string;
  rail: ProofRail;
}): void {
  requireKeyPart(input.redemptionKey, "redemptionKey");
  requireKeyPart(input.runRequestId, "runRequestId");
  if (input.rail !== "stripe" && input.rail !== "x402") {
    throw new Error('proof redemption: rail must be "stripe" or "x402".');
  }
}
