/**
 * Issue #2656 (Phase 2.1, #2405) — Billing customer mapping port
 * (types only, no implementation, no env read, no SQL). One row
 * per user: the provider customer id Stripe created (or the
 * operator mapped) for that user's Billing checkouts.
 *
 * First-wins contract: recordCustomer with a DIFFERENT customer
 * id for a user that already has one THROWS (fail closed —
 * possible account confusion, operator resolves; never a silent
 * overwrite, never a merge). Recording the SAME id again is
 * idempotent. The mapping is how a second Billing checkout
 * reuses the same provider customer instead of fragmenting
 * customers across checkouts. It holds no payment instrument
 * and no plan: plans live in the subscription store, prices in
 * the billing policy.
 */

/** One user's provider customer mapping. */
export interface BillingCustomerRecord {
  userId: string;
  tenantId: string;
  stripeCustomerId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Billing customer mapping store. */
export interface BillingCustomerStore {
  getCustomer(userId: string): Promise<BillingCustomerRecord | null>;
  recordCustomer(input: {
    userId: string;
    tenantId: string;
    stripeCustomerId: string;
  }): Promise<BillingCustomerRecord>;
}
