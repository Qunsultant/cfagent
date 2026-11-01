/**
 * Multi-Gateway Payment Execution Engine
 * Integrates Stripe, PayPal, and Lemon Squeezy with verifiable Agent DIDs.
 *
 * Implements SOLID Principles & GoF Strategy Pattern:
 * - Strategy Pattern (GoF): IPaymentGatewayStrategy encapsulates processor logic.
 * - Factory Pattern (GoF): PaymentStrategyFactory resolves concrete strategies.
 * - Single Responsibility Principle (SRP): Payment orchestration is decoupled from gateway API specifics.
 * - Open/Closed Principle (OCP): New gateways register without altering PaymentGatewayService.
 * - Real API Execution: Direct communication with Stripe, PayPal, and Lemon Squeezy (No Simulation/Mockups in live path).
 */

import type { Env } from "../types";
import type { CreateProviderSubscriptionInput, ProviderSubscription } from "./billingPorts";
import { AGENT_DIDS, createDidAttestation, type DidAttestationProof } from "../agents/did";
import {
  PaymentStrategyFactory,
  StripePaymentStrategy,
  PayPalPaymentStrategy,
  LemonSqueezyPaymentStrategy,
} from "../patterns/paymentStrategies";

export type SupportedGateway = "stripe" | "paypal" | "lemonsqueezy" | "sandbox";

/**
 * Every gateway the payment service can resolve. "sandbox" is the explicit
 * test harness: available only when a caller names it directly, never as a
 * silent substitute for an unrecognized gateway (issue #148).
 */
export const SUPPORTED_GATEWAYS: readonly SupportedGateway[] = ["stripe", "paypal", "lemonsqueezy", "sandbox"];

/**
 * Gateways with a real webhook signature scheme. Webhook verification is
 * default-deny: any provider outside this list (including "sandbox", which
 * has no signature scheme) is rejected, never assumed valid (issue #148).
 */
export const WEBHOOK_GATEWAYS: readonly SupportedGateway[] = ["stripe", "paypal", "lemonsqueezy"];

/** Normalizes a gateway identifier arriving from untrusted input (query params, JSON bodies, stored rows). */
export function normalizeGateway(gateway: string): string {
  return gateway.trim().toLowerCase();
}

export function isSupportedGateway(gateway: string): gateway is SupportedGateway {
  return (SUPPORTED_GATEWAYS as readonly string[]).includes(normalizeGateway(gateway));
}

export function isWebhookGateway(gateway: string): gateway is SupportedGateway {
  return (WEBHOOK_GATEWAYS as readonly string[]).includes(normalizeGateway(gateway));
}

export interface CreateCheckoutParams {
  draftId: string;
  amount: number;
  currency: string;
  customer: string;
  description?: string;
  gateway?: SupportedGateway;
  returnUrl?: string;
  userLogin: string;
}

export interface CheckoutResult {
  success: boolean;
  draftId?: string;
  gateway: SupportedGateway;
  checkoutUrl: string;
  gatewayRef: string;
  status: "pending_checkout" | "authorized" | "completed";
  didAttestation: DidAttestationProof;
  message: string;
}

export interface RefundParams {
  transactionId: string;
  amount?: number;
  gatewayRef?: string;
  gateway: SupportedGateway;
  reason?: string;
  userLogin: string;
}

export interface RefundResult {
  success: boolean;
  gateway: SupportedGateway;
  refundId: string;
  amountRefunded: number;
  status: "refunded" | "processing";
  didAttestation: DidAttestationProof;
  message: string;
}

export interface GatewayStatus {
  id: SupportedGateway;
  name: string;
  configured: boolean;
  mode: "live" | "sandbox" | "simulated" | "mcp_remote";
  capabilities: string[];
  mcpServerUrl?: string;
  protocol: "mcp_json_rpc" | "rest_api" | "sandbox_simulated";
}

export class PaymentGatewayService {
  constructor(private env: Env) {}

  /**
   * Returns active status and configuration state for payment gateways
   */
  getGatewayStatuses(): GatewayStatus[] {
    const strategies = PaymentStrategyFactory.getAllStrategies();
    return strategies
      .filter((s) => ["stripe", "paypal", "lemonsqueezy"].includes(s.gatewayId))
      .map((s) => s.getStatus(this.env));
  }

  /**
   * Creates a checkout session or order across Stripe, PayPal, Lemon Squeezy, or Sandbox
   */
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    const gateway = normalizeGateway(params.gateway || "stripe") as SupportedGateway;

    // Validate at the service seam (issue #156): every caller of this method
    // (create/confirm routes, facade, MCP commands) gets the same explicit
    // rejection for an unsupported gateway, and no DID attestation is minted
    // for a gateway that can never resolve. An unknown gateway is never
    // silently substituted (the strategy factory throws the same error as a
    // backstop, #148).
    if (!isSupportedGateway(gateway)) {
      throw new Error(
        `Unsupported payment gateway: ${gateway}. Supported gateways: ${SUPPORTED_GATEWAYS.join(", ")}.`
      );
    }

    const authorizerDid = `did:user:github:${params.userLogin}`;

    // 1. Generate the Agent DID Attestation — a keyed, verifiable
    // proof when DID_ATTESTATION_KEY is set; otherwise an unkeyed
    // content label (the proofType says which — issue #2426).
    const didAttestation = await createDidAttestation({
      draftId: params.draftId,
      action: "charge",
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid,
    }, this.env.DID_ATTESTATION_KEY);

    // 2. Resolve Strategy via Factory (GoF Strategy + Factory Pattern)
    const strategy = PaymentStrategyFactory.getStrategy(gateway);
    return strategy.createCheckout(this.env, params, didAttestation);
  }

  /**
   * Issue #2193 (slice 1, #2146) — retrieve a Stripe Checkout
   * Session by id, via the Stripe strategy (the only Stripe API
   * surface). Used by the native gate's confirm-by-retrieve rule:
   * a session is evidence only when the gate judges it complete,
   * paid, amount-matched, and reference-matched. Throws on
   * missing configuration or transport failure (fail closed, and
   * retryable in a durable step); never consults a redirect.
   */
  async retrieveCheckoutSession(sessionId: string): Promise<{
    id: string;
    status: string;
    payment_status: string;
    amount_total: number;
    client_reference_id: string;
    payment_intent?: string;
    url?: string;
    subscriptionId?: string;
    customerId?: string;
    metadata?: Record<string, string>;
  }> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.retrieveCheckoutSession(this.env, sessionId);
  }

  /**
   * Issue #2656 (Phase 2.1) — subscription-mode Checkout Session
   * creation, via the Stripe strategy (the only Stripe API
   * surface). Thin wrapper: the Billing checkout adapter calls
   * this, never the strategy directly. Throws on missing
   * configuration or transport failure (fail closed).
   */
  async createSubscriptionCheckoutSession(params: {
    draftId: string;
    priceId: string;
    customerId?: string | null;
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string | null }> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.createSubscriptionCheckoutSession(this.env, params);
  }

  /**
   * Issue #2202 (implementation of design #2145) — Stripe
   * Billing subscription calls, via the Stripe strategy
   * (the only Stripe API surface). Used by the Billing
   * adapter: the adapter never fetches Stripe itself.
   * Throws on missing configuration or transport failure
   * (fail closed); never consults a redirect.
   */
  async createProviderSubscription(params: CreateProviderSubscriptionInput): Promise<ProviderSubscription> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.createProviderSubscription(this.env, params);
  }

  async retrieveProviderSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.retrieveProviderSubscription(this.env, providerSubscriptionId);
  }

  async cancelProviderAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.cancelProviderAtPeriodEnd(this.env, providerSubscriptionId);
  }

  async cancelProviderImmediately(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
    return stripeStrategy.cancelProviderImmediately(this.env, providerSubscriptionId);
  }

  /**
   * Captures an authorized payment order across Stripe or PayPal
   */
  async capturePayment(params: {
    gateway: SupportedGateway;
    orderId: string;
    userLogin: string;
  }): Promise<{ success: boolean; captureId?: string; message: string }> {
    const gateway = normalizeGateway(params.gateway) as SupportedGateway;
    const authorizerDid = `did:user:github:${params.userLogin}`;
    const didAttestation = await createDidAttestation({
      draftId: params.orderId,
      action: "capture",
      amount: 0,
      currency: "USD",
      customer: "settled_account",
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid,
    }, this.env.DID_ATTESTATION_KEY);

    if (gateway === "stripe") {
      const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
      return stripeStrategy.capturePayment(this.env, params.orderId, didAttestation);
    }

    if (gateway === "paypal") {
      const paypalStrategy = PaymentStrategyFactory.getStrategy("paypal") as PayPalPaymentStrategy;
      return paypalStrategy.captureOrder(this.env, params.orderId, didAttestation);
    }

    return { success: false, message: `Capture not supported or required for gateway: ${gateway}` };
  }

  /**
   * Executes a refund or returns signed attestation proof across supported gateways
   */
  async executeRefund(params: RefundParams): Promise<RefundResult> {
    // Normalize the gateway exactly like createCheckout and capturePayment
    // (issue #185). The gateway here comes from a stored transaction row,
    // and rows written before the create route validated its input (#156)
    // can carry un-normalized values (" Stripe "). Since the factory became
    // default-deny in #148, such a row threw at refund time instead of
    // refunding; normalizing first restores the refund while unknown
    // gateways still fail loudly at the factory lookup below.
    const gateway = normalizeGateway(params.gateway) as SupportedGateway;
    const authorizerDid = `did:user:github:${params.userLogin}`;

    // 1. Generate the Agent DID Attestation — keyed and verifiable
    // when DID_ATTESTATION_KEY is set; otherwise an unkeyed content
    // label (the proofType says which — issue #2426).
    const didAttestation = await createDidAttestation({
      draftId: params.transactionId,
      action: "refund",
      amount: params.amount || 0,
      currency: "USD",
      customer: "settled_account",
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid,
    }, this.env.DID_ATTESTATION_KEY);

    // 2. Resolve Strategy via Factory (GoF Strategy + Factory Pattern)
    const strategy = PaymentStrategyFactory.getStrategy(gateway);
    return strategy.executeRefund(this.env, { ...params, gateway }, didAttestation);
  }

  /**
   * Cryptographically verifies incoming webhook signatures from Stripe, PayPal, or Lemon Squeezy.
   * Default-deny: any other provider value is rejected (`isValid: false`) — verification
   * never falls through to a permissive default (issue #148).
   */
  async verifyWebhookSignature(
    gateway: SupportedGateway,
    rawBody: string,
    headers: Headers
  ): Promise<{ isValid: boolean; reason?: string }> {
    const normalized = normalizeGateway(gateway || "");

    if (normalized === "stripe") {
      const sig = headers.get("stripe-signature") || "";
      const secret = this.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return { isValid: false, reason: "Missing STRIPE_WEBHOOK_SECRET in environment" };
      const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe") as StripePaymentStrategy;
      const valid = await stripeStrategy.verifyWebhookSignature(rawBody, sig, secret);
      return { isValid: valid, reason: valid ? undefined : "Stripe signature mismatch" };
    }

    if (normalized === "lemonsqueezy") {
      const sig = headers.get("x-signature") || "";
      const secret = this.env.LEMONSQUEEZY_WEBHOOK_SECRET;
      if (!secret) return { isValid: false, reason: "Missing LEMONSQUEEZY_WEBHOOK_SECRET in environment" };
      const lsStrategy = PaymentStrategyFactory.getStrategy("lemonsqueezy") as LemonSqueezyPaymentStrategy;
      const valid = await lsStrategy.verifyWebhookSignature(rawBody, sig, secret);
      return { isValid: valid, reason: valid ? undefined : "Lemon Squeezy signature mismatch" };
    }

    if (normalized === "paypal") {
      // Issue #157: PayPal's verify-webhook-signature API requires the id
      // of the webhook registered for this app (PAYPAL_WEBHOOK_ID, declared
      // in .dev.vars.example) — it cannot be derived from the client
      // credentials, and the strategy previously substituted the client id,
      // which made PayPal reject legitimate webhooks. Fail closed with an
      // explicit configuration reason when it is not set.
      const webhookId = this.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) {
        return {
          isValid: false,
          reason: "PayPal webhook id is not configured: PAYPAL_WEBHOOK_ID is missing from the environment",
        };
      }
      const paypalStrategy = PaymentStrategyFactory.getStrategy("paypal") as PayPalPaymentStrategy;
      const valid = await paypalStrategy.verifyWebhookSignature(this.env, headers, rawBody, webhookId);
      return { isValid: valid, reason: valid ? undefined : "PayPal verification rejected" };
    }

    // Default-deny (issue #148): an unrecognized provider — including the
    // sandbox harness, which has no webhook signature scheme — must never
    // be treated as verified. This previously fell through to
    // `{ isValid: true }`, so a forged webhook carrying a nonsense
    // `provider` (and a draftId) settled a real transaction downstream.
    return {
      isValid: false,
      reason: `Unsupported webhook provider: "${gateway}". Supported providers: ${WEBHOOK_GATEWAYS.join(", ")}.`,
    };
  }
}
