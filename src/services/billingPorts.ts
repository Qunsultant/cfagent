/**
 * Issue #2202 (sub-issue of #2020, implementation of design
 * #2145) — the Billing port.
 *
 * ADR 0002 R1 boundary: this module is types only. It imports
 * no store client, no gateway SDK, and reads no env. The
 * provider lives in the adapters (StripeBillingAdapter,
 * InMemoryBillingAdapter); the billing service
 * (src/services/billingService.ts) depends only on this port.
 *
 * Type-only note: ProrationBehavior is imported as a TYPE from the
 * billing policy port (no runtime import, no store client, no env).
 * Stripe API surface used (verified against the Stripe API
 * reference at build time, not from memory):
 * - POST /v1/subscriptions — create; required: customer,
 *   items[0][price]. collection_method defaults to
 *   charge_automatically.
 * - GET /v1/subscriptions/{id} — retrieve.
 * - POST /v1/subscriptions/{id} — update, including
 *   cancel_at_period_end and proration_behavior
 *   (none / create_prorations / always_invoice).
 * - DELETE /v1/subscriptions/{id} — cancel immediately.
 * Webhook event types handled by the service (not this port):
 * customer.subscription.created / .updated / .deleted,
 * invoice.paid, invoice.payment_failed. Signature
 * verification is NOT this port's job: the caller verifies
 * with PaymentGatewayService.verifyWebhookSignature (Stripe
 * HMAC-SHA256) and only then calls the service's webhook
 * applier with verified=true. An unverified event is never
 * applied — the applier throws before touching any store.
 *
 * Provider status values are passed through as strings:
 * Stripe's known set is active, trialing, past_due, unpaid,
 * canceled, incomplete, incomplete_expired, paused. The
 * service maps them to access; an unknown future status is
 * recorded verbatim and confers no access (fail closed).
 */

import type { ProrationBehavior } from "../data/billingPolicyPorts";

/** A provider-managed recurring subscription, as the port reports it. Periods are epoch-ms (converted from Stripe epoch-seconds by the adapter). */
export interface ProviderSubscription {
  /** Provider id, e.g. sub_*. */
  providerSubscriptionId: string;
  /** Provider status string (see header for the known set). */
  status: string;
  currentPeriodStartMs: number | null;
  currentPeriodEndMs: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAtMs: number | null;
  customerId: string | null;
  priceId: string | null;
}

export interface CreateProviderSubscriptionInput {
  /** Stripe customer id (cus_*). The caller owns customer creation/mapping; this slice never invents one. */
  customerId: string;
  /** Stripe Price id (price_*), from the operator-mapped policy — never invented here. */
  priceId: string;
  /** Default payment method id (pm_*), when the caller has one. Omit when the provider should use the customer's default. */
  defaultPaymentMethodId?: string;
  /** Free-form traceability metadata (tenant/user/plan/billing period); stored on the provider object, never a payment proof. */
  metadata?: Record<string, string>;
}

/** The provider surface the billing service consumes. One port, one provider today (Stripe Billing); a second provider would be a second adapter, not a port change. */
export interface BillingPort {
  createProviderSubscription(input: CreateProviderSubscriptionInput): Promise<ProviderSubscription>;
  retrieveProviderSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  /** Provider cancel-at-period-end: POST update with cancel_at_period_end=true. Access continues to period end. */
  cancelProviderAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscription>;
  /** Provider immediate cancel: DELETE. The service truncates local access per policy (immediate) or keeps period end (period_end). */
  cancelProviderImmediately(providerSubscriptionId: string): Promise<ProviderSubscription>;
  /**
   * Issue #2662 — provider subscription price update (plan change). POST
   * update with the subscription item's price replaced and the OPERATOR
   * billing policy's proration_behavior applied (none /
   * create_prorations / always_invoice). The caller reads the behavior
   * from policy; this port never defaults it.
   */
  updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
    prorationBehavior: ProrationBehavior,
  ): Promise<ProviderSubscription>;
}

/** The client shape the Stripe adapter delegates to (PaymentGatewayService satisfies this; tests inject a fake). */
export interface StripeBillingClient {
  createProviderSubscription(input: CreateProviderSubscriptionInput): Promise<ProviderSubscription>;
  retrieveProviderSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  cancelProviderAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscription>;
  cancelProviderImmediately(providerSubscriptionId: string): Promise<ProviderSubscription>;
  updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
    prorationBehavior: ProrationBehavior,
  ): Promise<ProviderSubscription>;
}
