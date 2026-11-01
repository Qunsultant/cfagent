/**
 * Issue #2656 (Phase 2.1, #2405) — composition root for the
 * Billing checkout port. This is the ONLY module that maps
 * Worker env to the Billing checkout adapter: it is the only
 * place that reads Stripe keys for this port and constructs the
 * adapter. Domain code imports this helper and the port types,
 * never a gateway SDK.
 *
 * Configuration is the DIRECT REST key only
 * (STRIPE_SECRET_KEY / STRIPE_TEST_SECRET_KEY /
 * STRIPE_LIVE_SECRET_KEY via StripePaymentStrategy.resolveApiKey).
 * The Stripe MCP-remote path (STRIPE_MCP_SERVER_URL) is NOT a
 * Billing configuration: the subscription-mode session posts
 * direct REST (design §4), so an MCP-only env yields a null
 * port. Returns null when unconfigured: callers keep their fail
 * direction — fail-closed on money paths.
 */
import type { Env } from "../types";
import { StripePaymentStrategy } from "../patterns/paymentStrategies";
import { PaymentGatewayService } from "./payments";
import type { BillingCheckoutPort } from "./billingCheckoutPorts";
import { StripeBillingCheckoutAdapter } from "./stripeBillingCheckoutAdapter";

export type BillingCheckoutEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_MCP_SERVER_URL?: string;
  APP_BASE_URL?: string;
};

/** Build the Billing checkout port from Worker env, or null when unconfigured. */
export function createBillingCheckoutPorts(env: BillingCheckoutEnv): BillingCheckoutPort | null {
  try {
    const { apiKey } = new StripePaymentStrategy().resolveApiKey(env as unknown as Env);
    if (!apiKey) return null;
    const service = new PaymentGatewayService(env as unknown as Env);
    return new StripeBillingCheckoutAdapter({
      createSubscriptionCheckoutSession: (params) => service.createSubscriptionCheckoutSession(params),
      retrieveCheckoutSession: (sessionId) => service.retrieveCheckoutSession(sessionId),
    });
  } catch (err) {
    console.error(
      `[billing-checkout-ports] Billing checkout unconfigured (bad Stripe configuration, failing closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export type { BillingCheckoutPort };
