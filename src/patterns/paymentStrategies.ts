/**
 * GoF Strategy & Factory Patterns: Real Payment Gateway Processing
 *
 * Implements:
 * - Strategy Pattern (GoF): IPaymentGatewayStrategy encapsulates real provider checkout, refund, and capture logic.
 * - Factory Pattern (GoF): PaymentStrategyFactory resolves concrete strategies dynamically.
 * - Genuine REST & MCP Protocol Support (No Simulations or Mockups in live path):
 *   1. Stripe: Real REST /v1/checkout/sessions, /v1/payment_intents, /v1/refunds & HMAC-SHA256 webhook verification.
 *   2. PayPal: Real OAuth2 token generation, /v2/checkout/orders, /v2/checkout/orders/{id}/capture, refunds & webhooks.
 *   3. Lemon Squeezy: Real /v1/checkouts, /v1/refunds & HMAC-SHA256 webhook signatures.
 *   4. Explicit Sandbox Harness: Isolated test strategy only triggered when caller explicitly requests gateway: "sandbox".
 * - SOLID Principles:
 *   - Single Responsibility Principle (SRP): Each strategy strictly handles communication with its respective processor.
 *   - Open/Closed Principle (OCP): New gateways register without modifying existing code.
 *   - Liskov Substitution Principle (LSP): IPaymentGatewayStrategy instances can be seamlessly substituted.
 */

import type { Env } from "../types";
import type { DidAttestationProof } from "../agents/did";
import type {
  SupportedGateway,
  CreateCheckoutParams,
  CheckoutResult,
  RefundParams,
  RefundResult,
  GatewayStatus,
} from "../services/payments";
import type { IPaymentGatewayStrategy } from "./interfaces";
import type {
  CreateProviderSubscriptionInput,
  ProviderSubscription,
} from "../services/billingPorts";
import { RemoteMcpClient } from "../mcps/client/mcpClient";
import { computeHmacSha256Hex } from "../services/cryptoUtils";
import { resolveEnvironmentConfig } from "../config/environment";

/** Stripe id-or-expanded-object field → bare id, or undefined when absent/malformed. Never invented. */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return undefined;
}

/** Stripe metadata object → string record, or undefined when absent/malformed. Non-string values are dropped, never coerced. */
function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Concrete Strategy: Stripe Payments Engine (Real REST API / Remote MCP)
 */
export class StripePaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "stripe";
  readonly name = "Stripe Payment Gateway";

  /**
   * Resolves the appropriate Stripe Secret Key based on the active environment
   * Supports both Sandbox (Testmode: sk_test_...) and Live (Production: sk_live_...)
   */
  resolveApiKey(env: Env): { apiKey?: string; mode: "sandbox" | "live" } {
    const isMcp = Boolean(env.STRIPE_MCP_SERVER_URL);
    const envConfig = resolveEnvironmentConfig(env);
    const isTestMode = envConfig.name === "TEST" || !envConfig.isLive;

    // Check environment-specific secrets first
    const testKey = (env as any).STRIPE_TEST_SECRET_KEY || (typeof process !== "undefined" ? (process?.env as any)?.STRIPE_TEST_SECRET_KEY : undefined);
    const liveKey = (env as any).STRIPE_LIVE_SECRET_KEY || (typeof process !== "undefined" ? (process?.env as any)?.STRIPE_LIVE_SECRET_KEY : undefined);
    const genericKey = env.STRIPE_SECRET_KEY || (typeof process !== "undefined" ? (process?.env as any)?.STRIPE_SECRET_KEY : undefined);

    let apiKey = genericKey;
    if (isTestMode && testKey) {
      apiKey = testKey;
    } else if (!isTestMode && liveKey) {
      apiKey = liveKey;
    }

    const mode = isMcp ? "mcp_remote" : (apiKey?.startsWith("sk_test") || isTestMode) ? "sandbox" : "live";
    return { apiKey, mode: mode === "sandbox" ? "sandbox" : "live" };
  }

  isConfigured(env: Env): boolean {
    const { apiKey } = this.resolveApiKey(env);
    return Boolean(apiKey || env.STRIPE_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.STRIPE_MCP_SERVER_URL);
    const { apiKey, mode } = this.resolveApiKey(env);
    const configured = Boolean(isMcp || apiKey);
    const protocol = isMcp ? "mcp_json_rpc" : "rest_api";

    return {
      id: "stripe",
      name: this.name,
      configured,
      mode: isMcp ? "mcp_remote" : mode,
      capabilities: isMcp
        ? ["Stripe Remote Model Context Protocol Server (JSON-RPC 2.0)", "Agentic Checkout", "PaymentIntents", "Refunds"]
        : [
            "Real Stripe Checkout Sessions (/v1/checkout/sessions)",
            "Real Stripe PaymentIntents (/v1/payment_intents)",
            "Automatic Dual-Mode Sandbox (sk_test_) & Production (sk_live_)",
            "Instant Webhook Signature Verification (HMAC-SHA256)",
            "Automated Server-Side Capture & Settle",
            "Refunds & Reversals (/v1/refunds)",
          ],
      mcpServerUrl: env.STRIPE_MCP_SERVER_URL,
      protocol,
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution (if Stripe MCP Server URL is configured)
    if (env.STRIPE_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.STRIPE_MCP_SERVER_URL,
          toolName: "create_checkout_session",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
            returnUrl: params.returnUrl,
          },
          apiKey: env.STRIPE_SECRET_KEY,
        });

        const checkoutUrl = mcpData?.url || mcpData?.checkoutUrl;
        if (checkoutUrl) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "stripe",
            checkoutUrl,
            gatewayRef: mcpData.id || mcpData.gatewayRef || `mcp_cs_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Stripe checkout session initialized via Stripe Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err: any) {
        console.warn("Stripe Remote MCP invocation error:", err);
      }
    }

    // 2. Direct Stripe REST API Execution (Real Network Call)
    const { apiKey, mode } = this.resolveApiKey(env);
    if (apiKey) {
      try {
        const returnUrl = params.returnUrl || `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=success&draft=${params.draftId}`;
        const cancelUrl = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=cancelled`;

        const body = new URLSearchParams({
          "payment_method_types[0]": "card",
          "line_items[0][price_data][currency]": params.currency.toLowerCase(),
          // Stripe requires a product name; with no caller description
          // use the neutral label "Payment", never an invented product
          // line (issue #514).
          "line_items[0][price_data][product_data][name]": params.description || "Payment",
          "line_items[0][price_data][unit_amount]": String(Math.round(params.amount * 100)),
          "line_items[0][quantity]": "1",
          mode: "payment",
          client_reference_id: params.draftId,
          success_url: returnUrl,
          cancel_url: cancelUrl,
        });

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const data = (await res.json().catch(() => ({}))) as any;
        if (res.ok && data.url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "stripe",
            checkoutUrl: data.url,
            gatewayRef: data.id || `cs_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Stripe ${mode === "sandbox" ? "Testmode" : "Live"} checkout session initialized for ${params.customer}`,
          };
        }

        const errorMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        return {
          success: false,
          draftId: params.draftId,
          gateway: "stripe",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `Stripe REST API error: ${errorMessage}`,
        };
      } catch (err: any) {
        return {
          success: false,
          draftId: params.draftId,
          gateway: "stripe",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `Stripe network error: ${err.message || String(err)}`,
        };
      }
    }

    // 3. Genuine Error - No Simulation or Mockup
    return {
      success: false,
      draftId: params.draftId,
      gateway: "stripe",
      checkoutUrl: "",
      gatewayRef: "",
      status: "pending_checkout",
      didAttestation: attestation,
      message: "Stripe error: STRIPE_SECRET_KEY or STRIPE_MCP_SERVER_URL must be configured to process real payments. STRIPE_TEST_SECRET_KEY or STRIPE_LIVE_SECRET_KEY may also be provided. Simulation and mockups are disabled.",
    };
  }

  /**
   * Issue #2193 (slice 1, #2146) — retrieve a Checkout Session by
   * id (GET /v1/checkout/sessions/{id}). This closes design §6.1:
   * no session-retrieve method existed in this file, and the
   * native gate's confirm-by-retrieve rule needs one. The strategy
   * stays the only Stripe API surface: the checkout adapter reads
   * sessions through PaymentGatewayService, never by fetching
   * Stripe itself. A retrieve is a read of provider state, so
   * transport/config failures THROW (the caller's durable step
   * retries); only a successful retrieve yields evidence, and the
   * gate — not this method — judges whether that evidence pays.
   * A success-page redirect is never consulted here.
   */
  async retrieveCheckoutSession(
    env: Env,
    sessionId: string,
  ): Promise<{
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
    const { apiKey } = this.resolveApiKey(env);
    if (!apiKey) {
      throw new Error("Stripe is not configured: a secret key is required to retrieve a checkout session.");
    }
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("A Stripe session id is required to retrieve a checkout session.");
    }
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Stripe session retrieve failed: HTTP ${res.status} (${(data.error as { message?: string } | undefined)?.message ?? res.statusText}).`);
    }
    const paymentIntent = data.payment_intent;
    return {
      id: typeof data.id === "string" ? data.id : sessionId,
      status: typeof data.status === "string" ? data.status : "",
      payment_status: typeof data.payment_status === "string" ? data.payment_status : "",
      amount_total: typeof data.amount_total === "number" ? data.amount_total : NaN,
      client_reference_id: typeof data.client_reference_id === "string" ? data.client_reference_id : "",
      // The hosted checkout URL, when Stripe still serves one (open
      // sessions). Passed through, never judged: a URL is a redirect,
      // not proof — the gate judges status/payment_status/amount/
      // reference, and the UI presents this URL only as a link.
      url: typeof data.url === "string" ? data.url : undefined,
      payment_intent:
        typeof paymentIntent === "string"
          ? paymentIntent
          : (paymentIntent as { id?: unknown } | null)?.id && typeof (paymentIntent as { id?: unknown }).id === "string"
            ? ((paymentIntent as { id: string }).id as string)
            : undefined,
      // Issue #2656 (Phase 2.1) — subscription-mode sessions carry
      // the provider subscription + customer. Both arrive as a
      // bare id or an expanded object; anything else reads as
      // absent (never invented). One-time callers ignore these
      // fields; the Billing fulfillment route requires them.
      subscriptionId: idOf(data.subscription),
      customerId: idOf(data.customer),
      metadata: toStringRecord(data.metadata),
    };
  }

  /**
   * Issue #2656 (Phase 2.1) — create a subscription-mode Checkout
   * Session over direct Stripe REST (the composition root's
   * direct-REST-key rule: no MCP path here, matching
   * createCheckoutPorts). mode=subscription + a provider price id:
   * the price is operator-mapped (billing policy), never derived
   * from a catalogue or code constant. Session metadata AND
   * subscription_data metadata both carry the fulfillment keys
   * (userId/planId/tenantId) so the provider subscription object
   * itself carries traceability, not just the session. An
   * existing customer id is passed through when the caller has
   * one (first-wins mapping); otherwise Stripe creates one and
   * fulfillment records it. Transport/config failures THROW.
   */
  async createSubscriptionCheckoutSession(
    env: Env,
    params: {
      draftId: string;
      priceId: string;
      customerId?: string | null;
      metadata: Record<string, string>;
    },
  ): Promise<{ id: string; url: string | null }> {
    const { apiKey } = this.resolveApiKey(env);
    if (!apiKey) {
      throw new Error("Stripe is not configured: a secret key is required to create a subscription checkout session.");
    }
    if (!params.draftId || typeof params.draftId !== "string") {
      throw new Error("A draft id is required to create a subscription checkout session.");
    }
    if (!params.priceId || typeof params.priceId !== "string") {
      throw new Error("A provider price id is required to create a subscription checkout session.");
    }
    const baseUrl = env.APP_BASE_URL || "https://agent.openaimp.com";
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": params.priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: params.draftId,
      success_url: `${baseUrl}/?payment=success&draft=${params.draftId}`,
      cancel_url: `${baseUrl}/?payment=cancelled`,
    });
    for (const [key, value] of Object.entries(params.metadata)) {
      body.set(`metadata[${key}]`, value);
      body.set(`subscription_data[metadata][${key}]`, value);
    }
    if (params.customerId) body.set("customer", params.customerId);
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: ["Bearer", apiKey].join(" "),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof data.id !== "string") {
      throw new Error(
        `Stripe subscription checkout creation failed: HTTP ${res.status} (${(data.error as { message?: string } | undefined)?.message ?? res.statusText}).`,
      );
    }
    return {
      id: data.id,
      url: typeof data.url === "string" ? data.url : null,
    };
  }

  /**
   * Issue #2202 (implementation of design #2145) — Stripe
   * Billing subscription calls. This strategy stays the only
   * Stripe API surface: the Billing adapter reads provider
   * subscriptions through PaymentGatewayService, never by
   * fetching Stripe itself. Endpoints verified against the
   * Stripe API reference at build time: POST
   * /v1/subscriptions (customer + items[0][price]),
   * GET /v1/subscriptions/{id}, POST
   * /v1/subscriptions/{id} (update, incl.
   * cancel_at_period_end), DELETE /v1/subscriptions/{id}
   * (cancel immediately). Transport/config failures THROW
   * (fail closed); only a successful response yields a
   * parsed provider subscription. Periods convert from
   * Stripe epoch-seconds to epoch-ms; when the top-level
   * current_period_start/end are absent, the first
   * subscription item's periods are used as a defensive
   * fallback (never invented when both are absent — then
   * null, and the service refuses to invent a period).
   */
  private parseProviderSubscription(data: Record<string, unknown>, fallbackId: string): ProviderSubscription {
    const id = typeof data.id === "string" ? data.id : fallbackId;
    const item = Array.isArray((data.items as { data?: unknown[] } | undefined)?.data)
      ? ((data.items as { data: Record<string, unknown>[] }).data[0] ?? null)
      : null;
    const toMs = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v * 1000 : null;
    const topStart = toMs(data.current_period_start);
    const topEnd = toMs(data.current_period_end);
    const customer = data.customer;
    const price = item?.price as { id?: unknown } | undefined;
    return {
      providerSubscriptionId: id,
      status: typeof data.status === "string" ? data.status : "",
      currentPeriodStartMs: topStart ?? toMs(item?.current_period_start),
      currentPeriodEndMs: topEnd ?? toMs(item?.current_period_end),
      cancelAtPeriodEnd: data.cancel_at_period_end === true,
      canceledAtMs: toMs(data.canceled_at),
      customerId: typeof customer === "string" ? customer : ((customer as { id?: unknown } | null)?.id as string | undefined) ?? null,
      priceId: typeof price?.id === "string" ? price.id : null,
    };
  }

  private async stripeBillingRequest(
    env: Env,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    const { apiKey } = this.resolveApiKey(env);
    if (!apiKey) {
      throw new Error("Stripe is not configured: a secret key is required for Stripe Billing.");
    }
    const res = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Stripe Billing request failed: HTTP ${res.status} (${(data.error as { message?: string } | undefined)?.message ?? res.statusText}).`,
      );
    }
    return data;
  }

  async createProviderSubscription(
    env: Env,
    input: CreateProviderSubscriptionInput,
  ): Promise<ProviderSubscription> {
    if (!input.customerId?.trim()) throw new Error("customerId is required.");
    if (!input.priceId?.trim()) throw new Error("priceId is required.");
    const body = new URLSearchParams({
      customer: input.customerId,
      "items[0][price]": input.priceId,
      collection_method: "charge_automatically",
    });
    if (input.defaultPaymentMethodId) body.set("default_payment_method", input.defaultPaymentMethodId);
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) body.set(`metadata[${k}]`, v);
    }
    const data = await this.stripeBillingRequest(env, "POST", "/v1/subscriptions", body);
    return this.parseProviderSubscription(data, "");
  }

  async retrieveProviderSubscription(env: Env, providerSubscriptionId: string): Promise<ProviderSubscription> {
    if (!providerSubscriptionId?.trim()) throw new Error("A provider subscription id is required.");
    const data = await this.stripeBillingRequest(
      env,
      "GET",
      `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
    );
    return this.parseProviderSubscription(data, providerSubscriptionId);
  }

  async cancelProviderAtPeriodEnd(env: Env, providerSubscriptionId: string): Promise<ProviderSubscription> {
    if (!providerSubscriptionId?.trim()) throw new Error("A provider subscription id is required.");
    const body = new URLSearchParams({ cancel_at_period_end: "true" });
    const data = await this.stripeBillingRequest(
      env,
      "POST",
      `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
      body,
    );
    return this.parseProviderSubscription(data, providerSubscriptionId);
  }

  async cancelProviderImmediately(env: Env, providerSubscriptionId: string): Promise<ProviderSubscription> {
    if (!providerSubscriptionId?.trim()) throw new Error("A provider subscription id is required.");
    const data = await this.stripeBillingRequest(
      env,
      "DELETE",
      `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
    );
    return this.parseProviderSubscription(data, providerSubscriptionId);
  }

  /**
   * Creates a native Stripe PaymentIntent for headless or mobile checkouts
   */
  async createPaymentIntent(
    env: Env,
    params: { amount: number; currency: string; customer?: string; description?: string; draftId: string }
  ): Promise<{ success: boolean; clientSecret?: string; paymentIntentId?: string; message: string }> {
    const { apiKey, mode } = this.resolveApiKey(env);
    if (!apiKey) {
      return { success: false, message: "STRIPE_SECRET_KEY is required to create a PaymentIntent." };
    }

    try {
      const body = new URLSearchParams({
        amount: String(Math.round(params.amount * 100)),
        currency: params.currency.toLowerCase(),
        description: params.description || `AI Agent Order ${params.draftId}`,
        "metadata[draftId]": params.draftId,
      });

      const res = await fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.client_secret) {
        return {
          success: true,
          clientSecret: data.client_secret,
          paymentIntentId: data.id,
          message: `Stripe ${mode === "sandbox" ? "Testmode" : "Live"} PaymentIntent created: ${data.id}`,
        };
      }
      return { success: false, message: data?.error?.message || `PaymentIntent failed: HTTP ${res.status}` };
    } catch (err: any) {
      return { success: false, message: err.message || "Stripe PaymentIntent network failure" };
    }
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    const { apiKey, mode } = this.resolveApiKey(env);
    // 1. External Service MCP Execution
    if (env.STRIPE_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.STRIPE_MCP_SERVER_URL,
          toolName: "create_refund",
          arguments: {
            paymentIntent: params.gatewayRef,
            amount: params.amount,
            reason: params.reason,
          },
          apiKey,
        });

        if (mcpData?.id || mcpData?.refundId) {
          return {
            success: true,
            gateway: "stripe",
            refundId: mcpData.id || mcpData.refundId,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "Stripe refund settled via Stripe Remote MCP Server",
          };
        }
      } catch (err) {
        console.warn("Stripe Remote MCP refund failed:", err);
      }
    }

    // 2. Direct Stripe REST API
    if (apiKey && params.gatewayRef) {
      try {
        const res = await fetch("https://api.stripe.com/v1/refunds", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            payment_intent: params.gatewayRef,
            ...(params.amount ? { amount: String(Math.round(params.amount * 100)) } : {}),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as any;
        if (res.ok && data.id) {
          return {
            success: true,
            gateway: "stripe",
            refundId: data.id,
            amountRefunded: (data.amount || 0) / 100,
            status: "refunded",
            didAttestation: attestation,
            message: `Stripe ${mode === "sandbox" ? "Testmode" : "Live"} refund settled successfully via real API`,
          };
        }

        return {
          success: false,
          gateway: "stripe",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `Stripe Refund API error: ${data?.error?.message || res.statusText}`,
        };
      } catch (err: any) {
        return {
          success: false,
          gateway: "stripe",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `Stripe refund network error: ${err.message || String(err)}`,
        };
      }
    }

    return {
      success: false,
      gateway: "stripe",
      refundId: "",
      amountRefunded: 0,
      status: "processing",
      didAttestation: attestation,
      message: "Stripe error: STRIPE_SECRET_KEY is required to process refunds. Simulation and mockups are disabled.",
    };
  }

  /**
   * Captures an authorized PaymentIntent
   */
  async capturePayment(env: Env, paymentIntentId: string, attestation: DidAttestationProof): Promise<{ success: boolean; captureId?: string; message: string }> {
    const { apiKey } = this.resolveApiKey(env);
    if (!apiKey) {
      return { success: false, message: "STRIPE_SECRET_KEY required to capture payment" };
    }

    try {
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.id) {
        return { success: true, captureId: data.id, message: "Stripe PaymentIntent captured successfully" };
      }
      return { success: false, message: data?.error?.message || "Capture failed" };
    } catch (err: any) {
      return { success: false, message: err.message || "Stripe capture network failure" };
    }
  }

  /**
   * Verifies authentic Stripe HMAC-SHA256 webhook signature (t=...,v1=...)
   */
  async verifyWebhookSignature(rawBody: string, signatureHeader: string, webhookSecret: string): Promise<boolean> {
    if (!signatureHeader || !webhookSecret) return false;

    try {
      const items = signatureHeader.split(",");
      const timestamp = items.find((i) => i.startsWith("t="))?.replace("t=", "");
      const signatures = items.filter((i) => i.startsWith("v1=")).map((i) => i.replace("v1=", ""));

      if (!timestamp || signatures.length === 0) return false;

      const payload = `${timestamp}.${rawBody}`;
      const expected = await computeHmacSha256Hex(webhookSecret, payload);

      return signatures.some((sig) => sig.toLowerCase() === expected.toLowerCase());
    } catch {
      return false;
    }
  }
}

/**
 * Concrete Strategy: PayPal Commerce Platform (Real REST API / Remote MCP)
 */
export class PayPalPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "paypal";
  readonly name = "PayPal Commerce Platform";

  isConfigured(env: Env): boolean {
    return Boolean((env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) || env.PAYPAL_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.PAYPAL_MCP_SERVER_URL);
    const hasKeys = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
    const configured = isMcp || hasKeys;
    const mode = isMcp ? "mcp_remote" : hasKeys ? (env.PAYPAL_ENVIRONMENT === "live" ? "live" : "sandbox") : "live";
    const protocol = isMcp ? "mcp_json_rpc" : "rest_api";

    return {
      id: "paypal",
      name: this.name,
      configured,
      mode,
      capabilities: isMcp
        ? ["PayPal Remote Model Context Protocol Server (JSON-RPC 2.0)", "PayPal Orders", "Capture", "Refunds"]
        : ["PayPal Checkout v2", "Capture Orders v2", "Disputes", "Refunds", "Webhooks Verification"],
      mcpServerUrl: env.PAYPAL_MCP_SERVER_URL,
      protocol,
    };
  }

  private async getAccessToken(env: Env): Promise<string> {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
    }

    const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      throw new Error(`PayPal OAuth authentication failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution
    if (env.PAYPAL_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.PAYPAL_MCP_SERVER_URL,
          toolName: "create_order",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
          },
        });

        const approveUrl = mcpData?.approveUrl || mcpData?.checkoutUrl || mcpData?.links?.find((l: any) => l.rel === "approve")?.href;
        if (approveUrl) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "paypal",
            checkoutUrl: approveUrl,
            gatewayRef: mcpData.id || mcpData.orderId || `mcp_pp_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `PayPal checkout order created via PayPal Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err) {
        console.warn("PayPal Remote MCP invocation failed:", err);
      }
    }

    // 2. Direct PayPal REST API Execution (Real Network Call)
    if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
      try {
        const token = await this.getAccessToken(env);
        const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

        const res = await fetch(`${base}/v2/checkout/orders`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: params.draftId,
                // PayPal's purchase-unit description is optional: omit it
                // entirely when the caller supplied none instead of
                // inventing a product line (issue #514).
                ...(params.description ? { description: params.description } : {}),
                amount: {
                  currency_code: params.currency.toUpperCase(),
                  value: params.amount.toFixed(2),
                },
              },
            ],
            application_context: {
              brand_name: "Multi-Agent Studio",
              return_url: `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=success&provider=paypal`,
              cancel_url: `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=cancel`,
            },
          }),
        });

        const data = (await res.json().catch(() => ({}))) as any;
        const approveLink = data.links?.find((l: any) => l.rel === "approve")?.href;

        if (res.ok && approveLink) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "paypal",
            checkoutUrl: approveLink,
            gatewayRef: data.id || `pp_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `PayPal checkout order created for ${params.customer}`,
          };
        }

        return {
          success: false,
          draftId: params.draftId,
          gateway: "paypal",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `PayPal Order API error: ${data?.message || res.statusText}`,
        };
      } catch (err: any) {
        return {
          success: false,
          draftId: params.draftId,
          gateway: "paypal",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `PayPal Order API exception: ${err.message || String(err)}`,
        };
      }
    }

    return {
      success: false,
      draftId: params.draftId,
      gateway: "paypal",
      checkoutUrl: "",
      gatewayRef: "",
      status: "pending_checkout",
      didAttestation: attestation,
      message: "PayPal error: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured. Simulation and mockups are disabled.",
    };
  }

  /**
   * Captures an authorized PayPal Order
   */
  async captureOrder(env: Env, orderId: string, attestation: DidAttestationProof): Promise<{ success: boolean; captureId?: string; amount?: number; message: string }> {
    try {
      const token = await this.getAccessToken(env);
      const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

      const res = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && (data.status === "COMPLETED" || data.status === "APPROVED")) {
        const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
        return {
          success: true,
          captureId: capture?.id || data.id,
          amount: capture?.amount?.value ? Number(capture.amount.value) : undefined,
          message: `PayPal Order ${orderId} captured successfully. Status: ${data.status}`,
        };
      }

      return {
        success: false,
        message: data?.message || `PayPal capture failed with status ${res.status}`,
      };
    } catch (err: any) {
      return { success: false, message: `PayPal capture error: ${err.message || String(err)}` };
    }
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && params.gatewayRef) {
      try {
        const token = await this.getAccessToken(env);
        const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
        const res = await fetch(`${base}/v2/payments/captures/${params.gatewayRef}/refund`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params.amount ? { amount: { value: params.amount.toFixed(2), currency_code: "USD" } } : {}),
        });
        const data = (await res.json().catch(() => ({}))) as any;
        if (res.ok && data.id) {
          return {
            success: true,
            gateway: "paypal",
            refundId: data.id,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "PayPal refund settled successfully via real API",
          };
        }

        return {
          success: false,
          gateway: "paypal",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `PayPal refund error: ${data?.message || res.statusText}`,
        };
      } catch (err: any) {
        return {
          success: false,
          gateway: "paypal",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `PayPal refund network error: ${err.message || String(err)}`,
        };
      }
    }

    return {
      success: false,
      gateway: "paypal",
      refundId: "",
      amountRefunded: 0,
      status: "processing",
      didAttestation: attestation,
      message: "PayPal error: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured. Simulation and mockups are disabled.",
    };
  }

  /**
   * Verifies PayPal Webhook Signature against PayPal API
   */
  async verifyWebhookSignature(env: Env, headers: Headers, rawBody: string, webhookId?: string): Promise<boolean> {
    // Issue #157: the webhook id must come from explicit configuration —
    // the `webhookId` argument or the dedicated PAYPAL_WEBHOOK_ID env var
    // (declared in .dev.vars.example). The client id is NOT a webhook id:
    // substituting it made PayPal's verification API reject legitimate
    // webhooks. With no webhook id configured, fail closed BEFORE any
    // remote call rather than sending a substituted identifier.
    const resolvedWebhookId = webhookId || env.PAYPAL_WEBHOOK_ID;
    if (!resolvedWebhookId) {
      return false;
    }
    try {
      const token = await this.getAccessToken(env);
      const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

      const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: headers.get("paypal-auth-algo"),
          cert_url: headers.get("paypal-cert-url"),
          transmission_id: headers.get("paypal-transmission-id"),
          transmission_sig: headers.get("paypal-transmission-sig"),
          transmission_time: headers.get("paypal-transmission-time"),
          webhook_id: resolvedWebhookId,
          webhook_event: JSON.parse(rawBody),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { verification_status?: string };
      return data.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }
}

/**
 * Concrete Strategy: Lemon Squeezy Merchant Platform (Real REST API / Remote MCP)
 */
export class LemonSqueezyPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "lemonsqueezy";
  readonly name = "Lemon Squeezy Merchant";

  isConfigured(env: Env): boolean {
    return Boolean((env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID) || env.LEMONSQUEEZY_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.LEMONSQUEEZY_MCP_SERVER_URL);
    const hasKey = Boolean(env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID);
    const configured = isMcp || hasKey;
    const mode = isMcp ? "mcp_remote" : "live";
    const protocol = isMcp ? "mcp_json_rpc" : "rest_api";

    return {
      id: "lemonsqueezy",
      name: this.name,
      configured,
      mode,
      capabilities: isMcp
        ? ["Lemon Squeezy Model Context Protocol Server (JSON-RPC 2.0)", "Hosted Checkouts", "Refunds"]
        : ["Hosted Checkouts v1", "Usage Billing", "SaaS Subscriptions", "Refunds", "HMAC-SHA256 Webhooks"],
      mcpServerUrl: env.LEMONSQUEEZY_MCP_SERVER_URL,
      protocol,
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution
    if (env.LEMONSQUEEZY_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.LEMONSQUEEZY_MCP_SERVER_URL,
          toolName: "create_checkout",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
          },
          apiKey: env.LEMONSQUEEZY_API_KEY,
        });

        const url = mcpData?.url || mcpData?.checkoutUrl;
        if (url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "lemonsqueezy",
            checkoutUrl: url,
            gatewayRef: mcpData.id || mcpData.gatewayRef || `mcp_ls_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Lemon Squeezy checkout created via Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err) {
        console.warn("Lemon Squeezy Remote MCP invocation failed:", err);
      }
    }

    // 2. Direct Lemon Squeezy REST API Execution (Real Network Call)
    if (env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID) {
      try {
        const storeId = env.LEMONSQUEEZY_STORE_ID;
        const res = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: {
              type: "checkouts",
              attributes: {
                custom_price: Math.round(params.amount * 100),
                product_options: {
                  // Lemon Squeezy requires a product name; with no caller
                  // description use the neutral label "Payment", and carry
                  // the caller's description (or "") as the product
                  // description — never an invented deposit narrative
                  // (issue #514).
                  name: params.description || "Payment",
                  description: params.description || "",
                },
                checkout_data: {
                  custom: {
                    draftId: params.draftId,
                    customer: params.customer,
                  },
                },
              },
              relationships: {
                store: {
                  data: {
                    type: "stores",
                    id: String(storeId),
                  },
                },
              },
            },
          }),
        });

        const data = (await res.json().catch(() => ({}))) as any;
        const url = data.data?.attributes?.url;
        if (res.ok && url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "lemonsqueezy",
            checkoutUrl: url,
            gatewayRef: data.data?.id || `ls_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Lemon Squeezy checkout created for ${params.customer}`,
          };
        }

        return {
          success: false,
          draftId: params.draftId,
          gateway: "lemonsqueezy",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `Lemon Squeezy Checkout API error: ${data.errors?.[0]?.detail || res.statusText}`,
        };
      } catch (err: any) {
        return {
          success: false,
          draftId: params.draftId,
          gateway: "lemonsqueezy",
          checkoutUrl: "",
          gatewayRef: "",
          status: "pending_checkout",
          didAttestation: attestation,
          message: `Lemon Squeezy network error: ${err.message || String(err)}`,
        };
      }
    }

    return {
      success: false,
      draftId: params.draftId,
      gateway: "lemonsqueezy",
      checkoutUrl: "",
      gatewayRef: "",
      status: "pending_checkout",
      didAttestation: attestation,
      message: "Lemon Squeezy error: LEMONSQUEEZY_API_KEY and LEMONSQUEEZY_STORE_ID must be configured. Simulation and mockups are disabled.",
    };
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    if (env.LEMONSQUEEZY_API_KEY && params.gatewayRef) {
      try {
        const res = await fetch("https://api.lemonsqueezy.com/v1/refunds", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: {
              type: "refunds",
              attributes: { order_id: Number(params.gatewayRef) },
            },
          }),
        });
        const data = (await res.json().catch(() => ({}))) as any;
        if (res.ok && data.data?.id) {
          return {
            success: true,
            gateway: "lemonsqueezy",
            refundId: `ls_${data.data.id}`,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "Lemon Squeezy refund settled successfully via real API",
          };
        }

        return {
          success: false,
          gateway: "lemonsqueezy",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `Lemon Squeezy refund error: ${data.errors?.[0]?.detail || res.statusText}`,
        };
      } catch (err: any) {
        return {
          success: false,
          gateway: "lemonsqueezy",
          refundId: "",
          amountRefunded: 0,
          status: "processing",
          didAttestation: attestation,
          message: `Lemon Squeezy refund network error: ${err.message || String(err)}`,
        };
      }
    }

    return {
      success: false,
      gateway: "lemonsqueezy",
      refundId: "",
      amountRefunded: 0,
      status: "processing",
      didAttestation: attestation,
      message: "Lemon Squeezy error: LEMONSQUEEZY_API_KEY is required to process refunds. Simulation and mockups are disabled.",
    };
  }

  /**
   * Verifies Lemon Squeezy HMAC-SHA256 signature
   */
  async verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
    if (!signatureHeader || !secret) return false;
    try {
      const expected = await computeHmacSha256Hex(secret, rawBody);
      return expected.toLowerCase() === signatureHeader.toLowerCase();
    } catch {
      return false;
    }
  }
}

/**
 * Explicit Test Harness Strategy: Used strictly when caller explicitly specifies gateway: "sandbox".
 * Never used as a silent fallback for Stripe, PayPal, or Lemon Squeezy.
 */
export class SandboxPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "sandbox";
  readonly name = "Explicit Sandbox Test Harness";

  isConfigured(_env: Env): boolean {
    return true;
  }

  getStatus(_env: Env): GatewayStatus {
    return {
      id: "sandbox",
      name: this.name,
      configured: true,
      mode: "sandbox",
      capabilities: ["Explicit Test Harness", "DID Cryptographic Verification", "Multi-Currency Testbed"],
      protocol: "sandbox_simulated",
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    const baseUrl = env.APP_BASE_URL || "https://agent.openaimp.com";
    const sandboxUrl = `${baseUrl}/checkout/sandbox?provider=sandbox&id=${params.draftId}&amt=${params.amount}&curr=${params.currency}&cust=${encodeURIComponent(params.customer)}&sig=${attestation.signature.slice(0, 16)}`;
    const gatewayRef = `sandbox_${params.draftId.replace("pay_", "")}`;

    return {
      success: true,
      draftId: params.draftId,
      gateway: "sandbox",
      checkoutUrl: sandboxUrl,
      gatewayRef,
      status: "pending_checkout",
      didAttestation: attestation,
      message: `Explicit test harness checkout draft created with Agent DID ${attestation.proposerDid}`,
    };
  }

  async executeRefund(_env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    const refundId = `ref_sandbox_${crypto.randomUUID().slice(0, 8)}`;
    return {
      success: true,
      gateway: "sandbox",
      refundId,
      amountRefunded: params.amount || 0,
      status: "refunded",
      didAttestation: attestation,
      message: `Test harness refund of $${params.amount?.toFixed(2) || "0.00"} authorized and signed by ${attestation.authorizerDid}`,
    };
  }
}

/**
 * GoF Factory Pattern: Payment Strategy Resolver
 */
export class PaymentStrategyFactory {
  private static strategies: Map<SupportedGateway, IPaymentGatewayStrategy> = new Map<SupportedGateway, IPaymentGatewayStrategy>([
    ["stripe", new StripePaymentStrategy()],
    ["paypal", new PayPalPaymentStrategy()],
    ["lemonsqueezy", new LemonSqueezyPaymentStrategy()],
    ["sandbox", new SandboxPaymentStrategy()],
  ]);

  static getStrategy(gateway: SupportedGateway): IPaymentGatewayStrategy {
    const strategy = this.strategies.get(gateway);
    if (!strategy) {
      // Default-deny (issue #148): never resolve an unrecognized gateway to
      // the sandbox harness. The sandbox strategy's own contract is that it
      // is used strictly when a caller explicitly names it; silently
      // substituting it let a nonsense gateway create checkouts/refunds.
      throw new Error(`Unsupported payment gateway: ${gateway}`);
    }
    return strategy;
  }

  static registerStrategy(strategy: IPaymentGatewayStrategy): void {
    this.strategies.set(strategy.gatewayId, strategy);
  }

  static getAllStrategies(): IPaymentGatewayStrategy[] {
    return Array.from(this.strategies.values());
  }
}
