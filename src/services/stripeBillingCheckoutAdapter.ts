/**
 * Issue #2656 (Phase 2.1, #2405) — the Stripe adapter for the
 * Billing checkout port. Infrastructure, not domain: it wraps a
 * Stripe checkout client (in production, PaymentGatewayService
 * via the composition root) and translates its results into
 * port evidence. It holds no price, no plan, and no confirm
 * judgment — the route decides, from the retrieved session,
 * whether a Billing subscription activated.
 *
 * Mirrors StripeCheckoutAdapter (one-time path) deliberately:
 * same client-injection shape, so tests inject a fake and the
 * production client is a thin wrapper over PaymentGatewayService.
 */
import type {
  BillingCheckoutPort,
  SubscriptionCheckoutCreation,
  SubscriptionSessionEvidence,
} from "./billingCheckoutPorts";

/** Minimal Stripe checkout surface the adapter needs. Tests inject a fake. */
export interface StripeBillingCheckoutClient {
  createSubscriptionCheckoutSession(params: {
    draftId: string;
    priceId: string;
    customerId?: string | null;
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(sessionId: string): Promise<{
    id: string;
    status: string;
    payment_status: string;
    client_reference_id: string;
    subscriptionId?: string;
    customerId?: string;
    metadata?: Record<string, string>;
    url?: string;
  }>;
}

export class StripeBillingCheckoutAdapter implements BillingCheckoutPort {
  constructor(private client: StripeBillingCheckoutClient) {}

  async createSubscriptionCheckout(input: SubscriptionCheckoutCreation): Promise<{ id: string; url: string | null }> {
    if (!input.draftId || typeof input.draftId !== "string") {
      throw new Error("Refusing to mint a Billing checkout without a draft id.");
    }
    if (!input.priceId || typeof input.priceId !== "string") {
      throw new Error("Refusing to mint a Billing checkout without an operator-mapped provider price id.");
    }
    return this.client.createSubscriptionCheckoutSession({
      draftId: input.draftId,
      priceId: input.priceId,
      customerId: input.customerId ?? null,
      metadata: input.metadata,
    });
  }

  async retrieveSubscriptionSession(sessionId: string): Promise<SubscriptionSessionEvidence> {
    if (!sessionId) throw new Error("A Stripe session id is required to retrieve a session.");
    const s = await this.client.retrieveCheckoutSession(sessionId);
    return {
      id: s.id,
      status: s.status,
      paymentStatus: s.payment_status,
      clientReferenceId: s.client_reference_id,
      subscriptionId: s.subscriptionId ?? null,
      customerId: s.customerId ?? null,
      metadata: s.metadata,
      checkoutUrl: s.url || undefined,
    };
  }
}
