/**
 * Issue #2548 — composition root for the proof redemption port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProofRedemptionAdapter` returns null and the caller
 * keeps its fail direction — the payment workflow wires the
 * store into the gate when AGENT_DB is bound, and the gate's
 * durable redemption checks apply only to a wired store (the
 * in-memory guard remains the floor). A present-but-unreadable
 * store fails at the confirm call site, fail-closed.
 */
import {
  createD1ProofRedemptionDb,
  D1ProofRedemptionAdapter,
  ensureProofRedemptionSchema,
  type ProofRedemptionDb,
} from "./d1ProofRedemptionAdapter";
import type { ProofRedemptionStore } from "./proofRedemptionPorts";

/** Build the proof redemption adapter from Worker env, or null if unbound. */
export function createProofRedemptionAdapter(env: { AGENT_DB?: unknown }): D1ProofRedemptionAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ProofRedemptionAdapter(createD1ProofRedemptionDb(env.AGENT_DB as D1Database));
}

export { ensureProofRedemptionSchema };
export type { ProofRedemptionDb, ProofRedemptionStore };
