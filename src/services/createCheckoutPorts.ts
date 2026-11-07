/**
 * Issue #2193 (slice 1, #2146) — composition root for the checkout
 * port. This is the ONLY module that maps Worker env to checkout
 * adapters: it is the only place that reads checkout env (Stripe
 * keys, X402_RECIPIENT_ADDRESS, X402_NETWORK,
 * X402_FACILITATOR_URL) and constructs adapters. Domain code
 * imports this helper and the port types, never a gateway SDK.
 *
 * Returns null when NOTHING is configured (neither rail): callers
 * keep their fail direction — fail-closed on money paths. A rail
 * whose configuration is present-but-invalid is treated as
 * unconfigured for that rail (loud log, null port), so a bad x402
 * recipient can never break coverage paths or fall back to
 * anything; the gate still throws when that rail is actually
 * needed for a checkout.
 *
 * Card configuration is the DIRECT REST key only
 * (STRIPE_SECRET_KEY / STRIPE_TEST_SECRET_KEY /
 * STRIPE_LIVE_SECRET_KEY via StripePaymentStrategy.resolveApiKey).
 * The Stripe MCP-remote path (STRIPE_MCP_SERVER_URL) is NOT a
 * screener configuration: the migration uses the direct REST path
 * (design §4), so an MCP-only env yields a null card port.
 *
 * x402 configuration requires X402_RECIPIENT_ADDRESS to be present
 * and valid. There is no fallback here and none in the adapter:
 * the existing x402 service's hardcoded recipient is never read on
 * this path, in any environment.
 *
 * Issue #3573 — every adapter this root builds is wrapped in the
 * checkout-port guard (src/services/checkoutPortGuard.ts): a bounded
 * timeout plus a per-rail circuit breaker (the shared src/breakers/
 * state machine), so the 2.1 Billing routes, the top-up confirm, the
 * cfpay channel, and the native gate all inherit it. Timeouts and
 * breaker thresholds resolve from Worker env (CHECKOUT_PORT_TIMEOUT_MS,
 * BREAKER_CHECKOUT_<RAIL>_*) with code defaults, never hardcoded
 * literals; a timeout is an unknown outcome, a tripped breaker fails
 * fast — both fail closed with catalog-coded 503s at the consumers.
 */
import type { Env } from "../types";
import { StripePaymentStrategy } from "../patterns/paymentStrategies";
import { PaymentGatewayService } from "./payments";
import type { CheckoutPorts } from "./checkoutPorts";
import { StripeCheckoutAdapter } from "./stripeCheckoutAdapter";
import { X402CheckoutAdapter } from "./x402CheckoutAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/createCheckoutPorts",
});
import {
  guardCheckoutPort,
  resolveCheckoutPortTimeoutMs,
  type CheckoutPortGuardOptions,
} from "./checkoutPortGuard";

export type CheckoutEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_MCP_SERVER_URL?: string;
  APP_BASE_URL?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_NETWORK?: string;
  X402_FACILITATOR_URL?: string;
  /** #3573: per-call checkout-port timeout in ms (code default 10_000). */
  CHECKOUT_PORT_TIMEOUT_MS?: string;
  /** #3573: breaker policy overrides, per rail (code defaults 3 / 30_000 / 1). */
  BREAKER_CHECKOUT_STRIPE_FAILURE_THRESHOLD?: string;
  BREAKER_CHECKOUT_STRIPE_RESET_TIMEOUT_MS?: string;
  BREAKER_CHECKOUT_STRIPE_HALF_OPEN_PROBES?: string;
  BREAKER_CHECKOUT_X402_FAILURE_THRESHOLD?: string;
  BREAKER_CHECKOUT_X402_RESET_TIMEOUT_MS?: string;
  BREAKER_CHECKOUT_X402_HALF_OPEN_PROBES?: string;
};

/** Build the checkout ports from Worker env, or null when neither rail is configured. */
export function createCheckoutPorts(
  env: CheckoutEnv,
  opts: CheckoutPortGuardOptions = {},
): CheckoutPorts | null {
  // One resolved timeout feeds both the guard's race and the x402
  // adapter's fetch abort, so there is exactly one timeout authority.
  const envRecord = env as unknown as Record<string, unknown>;
  const timeoutMs = opts.timeoutMs ?? resolveCheckoutPortTimeoutMs(envRecord, opts.settings);
  const guardOpts = { env: envRecord, ...opts, timeoutMs };
  let card: CheckoutPorts["card"] = null;
  try {
    const { apiKey } = new StripePaymentStrategy().resolveApiKey(env as unknown as Env);
    if (apiKey) {
      const service = new PaymentGatewayService(env as unknown as Env);
      card = guardCheckoutPort(
        new StripeCheckoutAdapter({
          createCheckout: (params) => service.createCheckout({ ...params, gateway: "stripe" }),
          retrieveSession: (sessionId) => service.retrieveCheckoutSession(sessionId),
        }),
        guardOpts,
      );
    }
  } catch (err) {
    structuredLog.error("checkout.card_rail_unconfigured", {
      message: `[checkout-ports] card rail unconfigured (bad Stripe configuration, failing closed for card): ${err instanceof Error ? err.message : String(err)}`,
      rail: "card",
      error: err instanceof Error ? err.message : String(err),
    });
    card = null;
  }

  let x402: CheckoutPorts["x402"] = null;
  const recipient = (env.X402_RECIPIENT_ADDRESS ?? "").trim();
  if (recipient) {
    try {
      x402 = guardCheckoutPort(
        new X402CheckoutAdapter({
          recipientAddress: recipient,
          network: env.X402_NETWORK,
          facilitatorUrl: env.X402_FACILITATOR_URL,
          timeoutMs,
        }),
        guardOpts,
      );
    } catch (err) {
      structuredLog.error("checkout.x402_rail_unconfigured", {
        message: `[checkout-ports] x402 rail unconfigured (bad recipient/network configuration, failing closed for x402): ${err instanceof Error ? err.message : String(err)}`,
        rail: "x402",
        error: err instanceof Error ? err.message : String(err),
      });
      x402 = null;
    }
  }

  if (!card && !x402) return null;
  return { card, x402 };
}

export type { CheckoutPorts };
