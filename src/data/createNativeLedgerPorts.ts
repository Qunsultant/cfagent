/**
 * Issue #2192 — composition root for the native ledger port.
 * This is the ONLY module that maps a Worker binding to a
 * port implementation: domain code imports this helper and
 * the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createNativeLedgerAdapter` returns null and callers keep
 * their fail direction — readers degrade (no resolver), while
 * the webhook arm audits an unrecorded settlement and stays
 * received (confirm-by-retrieve in slice 1 remains the
 * source of truth; the webhook is a wake-up, not the record).
 * (The `record-native` HTTP write-through that used to fail
 * closed with 503 here was removed by #5572; the port, its
 * readers, and the webhook arm are untouched.)
 */
import {
  createD1NativeLedgerDb,
  D1NativeLedgerAdapter,
  ensureNativeLedgerSchema,
  type NativeLedgerDb,
} from "./d1NativeLedgerAdapter";
import type { NativeLedgerPort } from "./nativeLedgerPorts";

/** Build the native ledger adapter from Worker env, or null if unbound. */
export function createNativeLedgerAdapter(env: { AGENT_DB?: unknown }): D1NativeLedgerAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1NativeLedgerAdapter(createD1NativeLedgerDb(env.AGENT_DB as D1Database));
}

export { ensureNativeLedgerSchema };
export type { NativeLedgerDb, NativeLedgerPort };
