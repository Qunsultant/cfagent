/**
 * Issue #2288 (#1976 step 0) — composition root for the
 * proposal-ledger port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProposalLedgerAdapter` returns null and callers keep
 * their legacy behaviour.
 */
import {
  createD1ProposalLedgerDb,
  D1ProposalLedgerAdapter,
  ensureProposalLedgerSchema,
  type ProposalLedgerDb,
} from "./d1ProposalLedgerAdapter";
import type { ProposalLedgerStore } from "./proposalLedgerPorts";

/** Build the proposal-ledger adapter from Worker env, or null if unbound. */
export function createProposalLedgerAdapter(env: {
  AGENT_DB?: unknown;
}): D1ProposalLedgerAdapter | null {
  if (!env.AGENT_DB) return null;
  const d1 = env.AGENT_DB as D1Database;
  return new D1ProposalLedgerAdapter(createD1ProposalLedgerDb(d1));
}

export { ensureProposalLedgerSchema };
export type { ProposalLedgerDb, ProposalLedgerStore };
