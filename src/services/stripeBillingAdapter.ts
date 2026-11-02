/**
 * Issue #2202 — Stripe Billing adapter for the BillingPort.
 *
 * Thin validation + delegation only: every Stripe API call
 * lives in the strategy (src/patterns/paymentStrategies.ts,
 * the only Stripe API surface, same as the checkout
 * session-retrieve precedent in slice 1) via
 * PaymentGatewayService. This adapter never fetches Stripe
 * itself and never imports a gateway SDK — the client is
 * injected, so tests use a fake and production wiring
 * passes the service (see createBillingPorts.ts).
 */
import type {
  BillingPort,
  CreateProviderSubscriptionInput,
  ProviderSubscription,
  StripeBillingClient,
} from "./billingPorts";

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value;
}

/** Stripe Billing adapter over an injected client. */
export class StripeBillingAdapter implements BillingPort {
  constructor(private readonly client: StripeBillingClient) {}

  async createProviderSubscription(input: CreateProviderSubscriptionInput): Promise<ProviderSubscription> {
    const customerId = requireId(input.customerId, "customerId");
    const priceId = requireId(input.priceId, "priceId");
    if (input.defaultPaymentMethodId !== undefined) requireId(input.defaultPaymentMethodId, "defaultPaymentMethodId");
    return this.client.createProviderSubscription({ ...input, customerId, priceId });
  }

  async retrieveProviderSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    return this.client.retrieveProviderSubscription(requireId(providerSubscriptionId, "providerSubscriptionId"));
  }

  async cancelProviderAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscription> {
    return this.client.cancelProviderAtPeriodEnd(requireId(providerSubscriptionId, "providerSubscriptionId"));
  }

  async cancelProviderImmediately(providerSubscriptionId: string): Promise<ProviderSubscription> {
    return this.client.cancelProviderImmediately(requireId(providerSubscriptionId, "providerSubscriptionId"));
  }

  async updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
    prorationBehavior: import("../data/billingPolicyPorts").ProrationBehavior,
  ): Promise<ProviderSubscription> {
    return this.client.updateProviderSubscriptionPrice(
      requireId(providerSubscriptionId, "providerSubscriptionId"),
      requireId(priceId, "priceId"),
      prorationBehavior,
    );
  }
}
