/**
 * Issue #2202 (slice for design #2145) — composition root
 * for the Billing port. This is the ONLY module that maps
 * Worker env + flag state to a Billing adapter: it is the
 * only place that reads Billing env (Stripe keys via
 * StripePaymentStrategy.resolveApiKey, the direct REST
 * path — the MCP-remote path is NOT a Billing
 * configuration, same as the checkout root) and
 * constructs the adapter.
 *
 * Returns null when the monetization flag is OFF, or
 * when Stripe is unconfigured: callers keep their fail
 * direction — fail-closed on money paths. A Billing port
 * can therefore never be obtained while the flag is OFF,
 * so no auto-charge code runs without the flag. The
 * caller supplies the flag state (Flagship "monetization"
 * port, same source as the gate); this module never reads
 * a flag store itself, so it stays unit-testable.
 */
import type { Env } from "../types";
import { StripePaymentStrategy } from "../patterns/paymentStrategies";
import { PaymentGatewayService } from "./payments";
import type { BillingPort } from "./billingPorts";
import { StripeBillingAdapter } from "./stripeBillingAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/createBillingPorts",
});

export type BillingEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_MCP_SERVER_URL?: string;
};

/** Build the Billing port from Worker env + flag state, or null when the flag is OFF or Stripe is unconfigured. */
export function createBillingPorts(env: BillingEnv, monetizationEnabled: boolean): BillingPort | null {
  if (!monetizationEnabled) return null;
  try {
    const { apiKey } = new StripePaymentStrategy().resolveApiKey(env as unknown as Env);
    if (!apiKey) return null;
    const service = new PaymentGatewayService(env as unknown as Env);
    return new StripeBillingAdapter(service);
  } catch (err) {
    structuredLog.error("billing.unconfigured", {
      message: `[billing-ports] Billing unconfigured (failing closed): ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type { BillingPort };
