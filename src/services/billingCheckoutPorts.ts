/**
 * Issue #2656 (Phase 2.1, #2405) — Billing checkout port (types
 * only, no implementation, no env read, no fetch). The activation
 * layer's boundary to subscription-mode Stripe Checkout: the
 * route mints through this port and fulfills from a retrieved
 * session, exactly like the one-time CheckoutPort — but a
 * SEPARATE port, so the one-time path (amount-based, mode
 * "payment") is never touched by subscription-mode changes.
 *
 * A session is evidence, never proof: the route judges status,
 * payment_status, client_reference_id, subscription id, customer
 * id, metadata, and the provider price id before any row is
 * written. This port holds no price, no plan, and no confirm
 * judgment.
 */

/** Inputs to mint a subscription-mode Checkout Session. */
export interface SubscriptionCheckoutCreation {
  /** Minted draft id, carried as client_reference_id (bill-… namespace). */
  draftId: string;
  /** Operator-mapped provider price id (billing policy), never derived. */
  priceId: string;
  /** Existing provider customer id when mapped, else null (Stripe creates one). */
  customerId?: string | null;
  /** Fulfillment keys, written to session + subscription_data metadata. */
  metadata: Record<string, string>;
}

/** Raw retrieved session evidence, unjudged. */
export interface SubscriptionSessionEvidence {
  id: string;
  status: string;
  paymentStatus: string;
  clientReferenceId: string;
  /** Provider subscription id (subscription-mode sessions only). */
  subscriptionId: string | null;
  /** Provider customer id. */
  customerId: string | null;
  /** Session metadata, when Stripe returns it (fulfillment binding keys). */
  metadata?: Record<string, string>;
  checkoutUrl?: string;
}

/** Subscription-mode checkout boundary. */
export interface BillingCheckoutPort {
  createSubscriptionCheckout(input: SubscriptionCheckoutCreation): Promise<{ id: string; url: string | null }>;
  retrieveSubscriptionSession(sessionId: string): Promise<SubscriptionSessionEvidence>;
}
