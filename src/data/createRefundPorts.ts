/**
 * Issue #2204 (sub-issue of #2012) — composition root for the
 * refund ports. This is the ONLY module that maps a Worker binding
 * to a refund port implementation: domain code imports this helper
 * and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createRefundPorts` returns null and callers keep their fail
 * direction — fail-closed on money paths. A present-but-unreadable
 * store fails at the call site, where the caller decides the
 * direction.
 */
import {
  createD1RefundDb,
  D1RefundAdapter,
  D1RefundPolicyAdapter,
  ensureRefundSchema,
  type RefundDb,
} from "./d1RefundAdapter";
import type { RefundPolicyStore, RefundRecord, RefundStore } from "./refundPorts";

export interface RefundPorts {
  store: D1RefundAdapter;
  policy: D1RefundPolicyAdapter;
}

/** Build the refund ports from Worker env, or null if unbound. */
export function createRefundPorts(env: { AGENT_DB?: unknown }): RefundPorts | null {
  if (!env.AGENT_DB) return null;
  const db = createD1RefundDb(env.AGENT_DB as D1Database);
  return { store: new D1RefundAdapter(db), policy: new D1RefundPolicyAdapter(db) };
}

export { ensureRefundSchema };
export type { RefundDb, RefundPolicyStore, RefundRecord, RefundStore };
