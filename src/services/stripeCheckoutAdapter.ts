/**
 * Issue #2193 (slice 1, #2146) — the card adapter for the checkout
 * port. This is infrastructure, not domain: it wraps a Stripe
 * checkout client (in production, PaymentGatewayService via the
 * composition root) and translates its results into port evidence.
 * It holds no price, no coverage rule, and no confirm judgment —
 * the gate decides, from the retrieved session, whether a run paid.
 *
 * Per-checkout amount: createCheckout passes the run's catalogue
 * priceUSD through as the session amount, which fixes the cfpay
 * fixed-amount limitation (one deployment-wide amount for every
 * family). The session's client_reference_id is the run-request id,
 * so a later retrieve binds the session to exactly one run.
 */
import type {
  CardSessionEvidence,
  CheckoutCreation,
  CheckoutPort,
  CheckoutRail,
  CreateCheckoutInput,
  CryptoVerification,
} from "./checkoutPorts";
import { CheckoutPortUsageError, CheckoutPortValidationError } from "./checkoutPortErrors";

/** Minimal Stripe checkout surface the adapter needs. The production implementation is a thin wrapper over PaymentGatewayService (see createCheckoutPorts.ts); tests inject a fake. */
export interface StripeCheckoutClient {
  createCheckout(params: {
    draftId: string;
    amount: number;
    currency: string;
    customer: string;
    userLogin: string;
  }): Promise<{ success: boolean; checkoutUrl: string; gatewayRef: string }>;
  retrieveSession(sessionId: string): Promise<{
    id: string;
    status: string;
    payment_status: string;
    amount_total: number;
    client_reference_id: string;
    payment_intent?: string;
    url?: string;
  }>;
}

export class StripeCheckoutAdapter implements CheckoutPort {
  readonly rail: CheckoutRail = "stripe";

  constructor(private client: StripeCheckoutClient) {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutCreation> {
    if (!Number.isFinite(input.priceUSD) || input.priceUSD <= 0) {
      throw new CheckoutPortValidationError(
        "Refusing to mint a Stripe checkout without a positive per-run price.",
      );
    }
    const res = await this.client.createCheckout({
      draftId: input.runRequestId,
      amount: input.priceUSD,
      currency: "USD",
      customer: input.userId,
      userLogin: input.userId,
    });
    if (!res.success || !res.gatewayRef) {
      throw new Error("Stripe checkout could not be created.");
    }
    return {
      rail: "stripe",
      checkoutId: res.gatewayRef,
      checkoutUrl: res.checkoutUrl || undefined,
    };
  }

  async retrieveCardSession(input: { sessionId: string }): Promise<CardSessionEvidence> {
    if (!input.sessionId) {
      throw new CheckoutPortValidationError("A Stripe session id is required to retrieve a session.");
    }
    const s = await this.client.retrieveSession(input.sessionId);
    return {
      sessionId: s.id,
      status: s.status,
      paymentStatus: s.payment_status,
      amountTotalCents: s.amount_total,
      clientReferenceId: s.client_reference_id,
      paymentIntentId: s.payment_intent || undefined,
      checkoutUrl: s.url || undefined,
    };
  }

  async verifyCryptoPayment(_input: { paymentProof: string; expectedAmountUSD: number }): Promise<CryptoVerification> {
    throw new CheckoutPortUsageError("StripeCheckoutAdapter cannot verify x402 payments: use the x402 adapter.");
  }
}
