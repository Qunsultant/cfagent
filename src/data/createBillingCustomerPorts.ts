/**
 * Issue #2656 (Phase 2.1, #2405) — composition root for the
 * Billing customer mapping port. This is the ONLY module that
 * maps a Worker binding to a mapping implementation: domain
 * code imports this helper and the port types, never a store
 * client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createBillingCustomerAdapter` returns null and callers
 * keep their fail direction — fail-closed on money paths.
 */
import {
  createD1BillingCustomerDb,
  D1BillingCustomerAdapter,
  ensureBillingCustomerSchema,
  type BillingCustomerDb,
} from "./d1BillingCustomerAdapter";
import type { BillingCustomerStore } from "./billingCustomerPorts";

/** Build the Billing customer mapping adapter from Worker env, or null if unbound. */
export function createBillingCustomerAdapter(env: { AGENT_DB?: unknown }): D1BillingCustomerAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1BillingCustomerAdapter(createD1BillingCustomerDb(env.AGENT_DB as D1Database));
}

export { ensureBillingCustomerSchema };
export type { BillingCustomerDb, BillingCustomerStore };
