/**
 * Issue #2781 (Monetization Phase 2.15) — composition root for
 * the product bundle store port. This is the ONLY module that
 * maps a Worker binding to a port implementation: domain code
 * imports this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProductBundleAdapter` returns null and callers keep
 * their fail direction — fail-closed on money paths. A
 * present-but-unreadable store fails at the call site, where
 * the caller decides the direction.
 */
import {
  createD1ProductBundleDb,
  D1ProductBundleAdapter,
  ensureProductBundleSchema,
  type ProductBundleDb,
} from "./d1ProductBundleAdapter";
import type { ProductBundleStore } from "./productBundles";

/** Build the product bundle store adapter from Worker env, or null if unbound. */
export function createProductBundleAdapter(env: { AGENT_DB?: unknown }): D1ProductBundleAdapter | null {
  if (!env.AGENT_DB) return null;
  const d1 = env.AGENT_DB as D1Database;
  return new D1ProductBundleAdapter(createD1ProductBundleDb(d1), d1);
}

export { ensureProductBundleSchema };
export type { ProductBundleDb, ProductBundleStore };
