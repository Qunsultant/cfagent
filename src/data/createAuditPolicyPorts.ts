/**
 * Issue #2183 — composition root for the audit-policy port. This
 * is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createAuditPolicyAdapter` returns null and callers keep their
 * fail direction. NOTE (#3156, owner directive 2026-11-04): the
 * gate helper in src/services/auditGate.ts now FAILS CLOSED on a
 * null adapter or an unreadable store — audit-only is OFF for
 * live money paths. A present-but-unreadable store fails at the
 * call site, where the helper decides the direction (block).
 */
import {
  createD1AuditPolicyDb,
  D1AuditPolicyAdapter,
  ensureAuditPolicySchema,
  type AuditPolicyDb,
} from "./d1AuditPolicyAdapter";
import type { AuditPolicyPort } from "./auditPolicyPorts";

/** Build the audit-policy adapter from Worker env, or null if unbound. */
export function createAuditPolicyAdapter(env: {
  AGENT_DB?: unknown;
}): D1AuditPolicyAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1AuditPolicyAdapter(createD1AuditPolicyDb(env.AGENT_DB as D1Database));
}

/**
 * #3156: build the adapter AND ensure its schema (idempotent —
 * re-ensure never overwrites operator edits, proven by test), so
 * a money-path gate never fails closed merely because migration
 * 0016 was never applied to this D1. Returns null if unbound
 * (the gate helper then fails closed on its own).
 */
export async function createEnsuredAuditPolicyAdapter(env: {
  AGENT_DB?: unknown;
}): Promise<D1AuditPolicyAdapter | null> {
  if (!env.AGENT_DB) return null;
  const db = createD1AuditPolicyDb(env.AGENT_DB as D1Database);
  await ensureAuditPolicySchema(db);
  return new D1AuditPolicyAdapter(db);
}

export { ensureAuditPolicySchema };
export type { AuditPolicyDb, AuditPolicyPort };
