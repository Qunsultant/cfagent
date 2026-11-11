/**
 * Issue #3289 (sub-issue of #3241) — composition root for the
 * product store port. This is the ONLY module that maps a Worker
 * binding to a port implementation: domain code imports this
 * helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProductAdapter` returns null and callers keep their
 * fail direction — fail-closed on money paths. A
 * present-but-unreadable store fails at the call site, where
 * the caller decides the direction.
 */
import {
  createD1ProductDb,
  D1ProductAdapter,
  ensureProductSchema,
  type ProductDb,
} from "./d1ProductAdapter";
import type { ProductStore } from "./productPorts";

/** Build the product store adapter from Worker env, or null if unbound. */
export function createProductAdapter(env: { AGENT_DB?: unknown }): D1ProductAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ProductAdapter(createD1ProductDb(env.AGENT_DB as D1Database));
}

export { ensureProductSchema };
export type { ProductDb, ProductStore };
