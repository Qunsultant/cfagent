/**
 * Issue #2680 — composition root for the store operator list
 * port. This is the ONLY module that maps a Worker binding to
 * a port implementation: domain code imports this helper and
 * the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state: the
 * helper returns null and callers fall back to env-only
 * operator checks — exactly today's behavior, no lockout.
 * A present-but-unreadable store fails at the call site,
 * where the caller decides the direction.
 */
import {
  createD1StoreOperatorsDb,
  D1StoreOperatorsAdapter,
  ensureStoreOperatorsSchema,
  type StoreOperatorsDb,
} from "./d1StoreOperatorsAdapter";
import type { StoreOperators } from "./storeOperatorsPorts";

/** Build the store operator list adapter from Worker env, or null if unbound. */
export function createStoreOperatorsAdapter(env: { AGENT_DB?: unknown }): D1StoreOperatorsAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1StoreOperatorsAdapter(createD1StoreOperatorsDb(env.AGENT_DB as D1Database));
}

export { ensureStoreOperatorsSchema };
export type { StoreOperators, StoreOperatorsDb };
