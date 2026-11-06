/**
 * Issue #148 (found during #140): `PaymentGatewayService.verifyWebhookSignature`
 * failed closed for stripe/lemonsqueezy when their secrets were missing, but
 * its fall-through returned `{ isValid: true }` for ANY OTHER gateway value.
 * The orchestrator's `/payments/webhook` route takes `provider` from a query
 * param (default "stripe") cast to the supported-gateway type — so an
 * unrecognized provider passed verification and, with a `draftId` in the
 * payload, the route marked the transaction `completed` and audited
 * `payment.settled_webhook`. A forged webhook with a nonsense provider
 * could settle a payment.
 *
 * The fix is default-deny at every layer:
 * - the service verifier normalizes the provider and rejects anything
 *   outside {stripe, paypal, lemonsqueezy} (including "sandbox", which has
 *   no webhook signature scheme);
 * - the route validates the provider against the same list before
 *   verification, and no state changes happen on rejection;
 * - gateway RESOLUTION had the identical fall-through:
 *   `PaymentStrategyFactory.getStrategy` silently substituted the sandbox
 *   harness for unknown gateways, contradicting that strategy's own
 *   documented contract ("used strictly when caller explicitly specifies
 *   gateway: sandbox"). It now throws, so charge/refund paths fail loudly
 *   instead of silently creating sandbox checkouts/refunds.
 *
 * Harnesses follow the repo patterns: agent-SDK module mocks and the
 * MockSqlStorage agent harness from tests/slack_signature_gate.test.ts /
 * tests/browser_and_slack_agents.test.ts; genuine HMAC signatures computed
 * via the repo's real crypto helper — never a stubbed verifier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/slack_signature_gate.test.ts).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import {
  PaymentGatewayService,
  isWebhookGateway,
  isSupportedGateway,
  type SupportedGateway,
} from "../src/services/payments";
import { PaymentStrategyFactory, PayPalPaymentStrategy } from "../src/patterns/paymentStrategies";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

// Source pins read via cwd-relative paths (vitest runs at the repo root) —
// the pattern used by tests/claims_batch_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const STRIPE_WH_SECRET = "whsec_unit_test_148";
const LS_WH_SECRET = "ls-whsec-unit-test-148";

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: STRIPE_WH_SECRET,
    LEMONSQUEEZY_WEBHOOK_SECRET: LS_WH_SECRET,
    PAYPAL_CLIENT_ID: "paypal-client-id-148",
    PAYPAL_CLIENT_SECRET: "paypal-client-secret-148",
    // Issue #157: PAYPAL_WEBHOOK_ID is mandatory configuration for the
    // remote-verification path — this fixture models a correctly configured
    // deployment (client credentials alone no longer suffice; the strategy
    // previously substituted the client id for the missing webhook id).
    PAYPAL_WEBHOOK_ID: "paypal-webhook-id-148",
    ...overrides,
  }) as Env;

const BODY = JSON.stringify({
  type: "checkout.session.completed",
  data: { object: { client_reference_id: "pay_unit_148" } },
});

/** Genuine Stripe webhook signature header for `body` under `secret`. */
async function stripeSignature(body: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const v1 = await computeHmacSha256Hex(secret, `${ts}.${body}`);
  return `t=${ts},v1=${v1}`;
}

describe("PaymentGatewayService.verifyWebhookSignature — known gateways (#148)", () => {
  it("stripe: a genuinely signed payload verifies", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const headers = new Headers({ "stripe-signature": await stripeSignature(BODY, STRIPE_WH_SECRET) });
    const result = await service.verifyWebhookSignature("stripe", BODY, headers);
    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("stripe: a tampered signature is rejected", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const headers = new Headers({ "stripe-signature": await stripeSignature(BODY, "wrong-secret") });
    const result = await service.verifyWebhookSignature("stripe", BODY, headers);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Stripe signature mismatch");
  });

  it("stripe: no signature header is rejected", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("stripe", BODY, new Headers());
    expect(result.isValid).toBe(false);
  });

  it("stripe: missing STRIPE_WEBHOOK_SECRET fails closed", async () => {
    const service = new PaymentGatewayService(makeEnv({ STRIPE_WEBHOOK_SECRET: undefined }));
    const headers = new Headers({ "stripe-signature": await stripeSignature(BODY, STRIPE_WH_SECRET) });
    const result = await service.verifyWebhookSignature("stripe", BODY, headers);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Missing STRIPE_WEBHOOK_SECRET");
  });

  it("stripe: provider casing is normalized (STRIPE still verifies genuinely)", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const headers = new Headers({ "stripe-signature": await stripeSignature(BODY, STRIPE_WH_SECRET) });
    const result = await service.verifyWebhookSignature("STRIPE" as SupportedGateway, BODY, headers);
    expect(result.isValid).toBe(true);
  });

  it("lemonsqueezy: a genuinely signed payload verifies", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const sig = await computeHmacSha256Hex(LS_WH_SECRET, BODY);
    const headers = new Headers({ "x-signature": sig });
    const result = await service.verifyWebhookSignature("lemonsqueezy", BODY, headers);
    expect(result.isValid).toBe(true);
  });

  it("lemonsqueezy: a tampered signature is rejected", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const headers = new Headers({ "x-signature": "deadbeef".repeat(8) });
    const result = await service.verifyWebhookSignature("lemonsqueezy", BODY, headers);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Lemon Squeezy signature mismatch");
  });

  it("lemonsqueezy: missing LEMONSQUEEZY_WEBHOOK_SECRET fails closed", async () => {
    const service = new PaymentGatewayService(makeEnv({ LEMONSQUEEZY_WEBHOOK_SECRET: undefined }));
    const sig = await computeHmacSha256Hex(LS_WH_SECRET, BODY);
    const headers = new Headers({ "x-signature": sig });
    const result = await service.verifyWebhookSignature("lemonsqueezy", BODY, headers);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Missing LEMONSQUEEZY_WEBHOOK_SECRET");
  });
});

describe("PaymentGatewayService.verifyWebhookSignature — PayPal via its verification API (#148)", () => {
  let verdict = "SUCCESS";

  beforeEach(() => {
    verdict = "SUCCESS";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("/v1/oauth2/token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "tok-148" }) } as any;
        }
        if (url.includes("/v1/notifications/verify-webhook-signature")) {
          return { ok: true, status: 200, json: async () => ({ verification_status: verdict }) } as any;
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const paypalHeaders = () =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.paypal.com/certs/test.pem",
      "paypal-transmission-id": "tx-148",
      "paypal-transmission-sig": "sig-148",
      "paypal-transmission-time": new Date().toISOString(),
    });

  it("paypal: provider verification SUCCESS verifies", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("paypal", BODY, paypalHeaders());
    expect(result.isValid).toBe(true);
  });

  it("paypal: provider verification FAILURE is rejected", async () => {
    verdict = "FAILURE";
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("paypal", BODY, paypalHeaders());
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("PayPal verification rejected");
  });

  it("paypal: unconfigured credentials fail closed (no network success possible)", async () => {
    const service = new PaymentGatewayService(
      makeEnv({ PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined })
    );
    const result = await service.verifyWebhookSignature("paypal", BODY, paypalHeaders());
    expect(result.isValid).toBe(false);
  });
});

describe("PayPal webhook id — explicit configuration only (#157)", () => {
  // Issue #157 (filed from #148): PayPalPaymentStrategy.verifyWebhookSignature
  // sent `webhook_id: webhookId || env.PAYPAL_CLIENT_ID` to PayPal's
  // verify-webhook-signature API. A client id is not a webhook id, so any
  // deployment without an explicitly passed webhook id had legitimate
  // webhooks rejected by PayPal. The webhook id now comes only from the
  // explicit argument or PAYPAL_WEBHOOK_ID (declared in .dev.vars.example);
  // with neither configured, verification fails closed with a configuration
  // reason and NO remote call is made. Fail-closed behaviour is unchanged.
  let verdict = "SUCCESS";
  let fetchCalls: { url: string; body?: any }[] = [];

  beforeEach(() => {
    verdict = "SUCCESS";
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const entry: { url: string; body?: any } = { url };
        if (typeof init?.body === "string" && init.body.startsWith("{")) {
          entry.body = JSON.parse(init.body);
        }
        fetchCalls.push(entry);
        if (url.includes("/v1/oauth2/token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "tok-157" }) } as any;
        }
        if (url.includes("/v1/notifications/verify-webhook-signature")) {
          return { ok: true, status: 200, json: async () => ({ verification_status: verdict }) } as any;
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const paypalHeaders = () =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.paypal.com/certs/test.pem",
      "paypal-transmission-id": "tx-157",
      "paypal-transmission-sig": "sig-157",
      "paypal-transmission-time": new Date().toISOString(),
    });

  const verifyCalls = () =>
    fetchCalls.filter((c) => c.url.includes("/v1/notifications/verify-webhook-signature"));

  it("service: the env-configured webhook id is sent to PayPal (never the client id)", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("paypal", BODY, paypalHeaders());
    expect(result.isValid).toBe(true);
    expect(verifyCalls()).toHaveLength(1);
    expect(verifyCalls()[0].body.webhook_id).toBe("paypal-webhook-id-148");
    expect(verifyCalls()[0].body.webhook_id).not.toBe("paypal-client-id-148");
  });

  it("service: no webhook id configured fails closed with a configuration reason and no remote call", async () => {
    const service = new PaymentGatewayService(makeEnv({ PAYPAL_WEBHOOK_ID: undefined }));
    const result = await service.verifyWebhookSignature("paypal", BODY, paypalHeaders());
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("webhook id is not configured");
    expect(result.reason).toContain("PAYPAL_WEBHOOK_ID");
    expect(verifyCalls()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("strategy: an explicitly passed webhook id wins over the env value", async () => {
    const strategy = new PayPalPaymentStrategy();
    const valid = await strategy.verifyWebhookSignature(makeEnv(), paypalHeaders(), BODY, "wh-explicit-param");
    expect(valid).toBe(true);
    expect(verifyCalls()).toHaveLength(1);
    expect(verifyCalls()[0].body.webhook_id).toBe("wh-explicit-param");
  });

  it("strategy: the env webhook id is used when no argument is passed", async () => {
    const strategy = new PayPalPaymentStrategy();
    const valid = await strategy.verifyWebhookSignature(makeEnv(), paypalHeaders(), BODY);
    expect(valid).toBe(true);
    expect(verifyCalls()).toHaveLength(1);
    expect(verifyCalls()[0].body.webhook_id).toBe("paypal-webhook-id-148");
  });

  it("strategy: a FAILURE verdict with a configured webhook id is still rejected", async () => {
    verdict = "FAILURE";
    const strategy = new PayPalPaymentStrategy();
    const valid = await strategy.verifyWebhookSignature(makeEnv(), paypalHeaders(), BODY);
    expect(valid).toBe(false);
  });

  it("strategy: no webhook id anywhere returns false with zero network calls", async () => {
    const strategy = new PayPalPaymentStrategy();
    const valid = await strategy.verifyWebhookSignature(
      makeEnv({ PAYPAL_WEBHOOK_ID: undefined }),
      paypalHeaders(),
      BODY
    );
    expect(valid).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("source pins: the client id is never substituted as the webhook id", () => {
    expect(src("patterns/paymentStrategies.ts")).not.toContain("|| env.PAYPAL_CLIENT_ID");
    expect(src("patterns/paymentStrategies.ts")).toContain("env.PAYPAL_WEBHOOK_ID");
    expect(src("services/payments.ts")).toContain("PAYPAL_WEBHOOK_ID");
  });
});

describe("PaymentGatewayService.verifyWebhookSignature — unknown providers default-deny (#148)", () => {
  it("a nonsense provider is rejected and named in the reason", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("boguspay" as SupportedGateway, BODY, new Headers());
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Unsupported webhook provider");
    expect(result.reason).toContain("boguspay");
  });

  it("the sandbox harness has no webhook scheme and is rejected", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("sandbox", BODY, new Headers());
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("Unsupported webhook provider");
  });

  it("an empty provider is rejected", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.verifyWebhookSignature("" as SupportedGateway, BODY, new Headers());
    expect(result.isValid).toBe(false);
  });

  it("gateway helpers agree with the verifier's allow-list", () => {
    expect(isWebhookGateway("stripe")).toBe(true);
    expect(isWebhookGateway(" PayPal ")).toBe(true);
    expect(isWebhookGateway("lemonsqueezy")).toBe(true);
    expect(isWebhookGateway("sandbox")).toBe(false);
    expect(isWebhookGateway("boguspay")).toBe(false);
    expect(isSupportedGateway("sandbox")).toBe(true);
    expect(isSupportedGateway("boguspay")).toBe(false);
  });
});

describe("Gateway resolution — no silent sandbox substitution (#148 sibling)", () => {
  it("the factory throws for an unrecognized gateway instead of returning the sandbox strategy", () => {
    expect(() => PaymentStrategyFactory.getStrategy("boguspay" as SupportedGateway)).toThrow(
      /Unsupported payment gateway: boguspay/
    );
  });

  it("createCheckout with an unknown gateway fails loudly and never produces a sandbox checkout", async () => {
    const service = new PaymentGatewayService(makeEnv());
    await expect(
      service.createCheckout({
        draftId: "pay_bogus_148",
        amount: 10,
        currency: "USD",
        customer: "Acme",
        gateway: "boguspay" as SupportedGateway,
        userLogin: "tester",
      })
    ).rejects.toThrow(/Unsupported payment gateway: boguspay/);
  });

  it("executeRefund with an unknown gateway fails loudly", async () => {
    const service = new PaymentGatewayService(makeEnv());
    await expect(
      service.executeRefund({
        transactionId: "pay_bogus_148",
        amount: 5,
        gateway: "boguspay" as SupportedGateway,
        userLogin: "tester",
      })
    ).rejects.toThrow(/Unsupported payment gateway: boguspay/);
  });

  it("the explicitly named sandbox harness still works for checkout", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.createCheckout({
      draftId: "pay_sandbox_148",
      amount: 10,
      currency: "USD",
      customer: "Acme",
      gateway: "sandbox",
      userLogin: "tester",
    });
    expect(result.success).toBe(true);
    expect(result.gateway).toBe("sandbox");
    expect(result.checkoutUrl).toContain("sandbox");
  });

  it("capturePayment already refuses unsupported gateways honestly (regression pin)", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.capturePayment({
      gateway: "lemonsqueezy",
      orderId: "ord_148",
      userLogin: "tester",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Capture not supported");
  });
});

describe("executeRefund — gateway normalization for stored rows (#185)", () => {
  // The refund path receives its gateway from a stored transaction row
  // (mas.ts confirmDraft passes existingTx's gateway through). Rows written
  // before the create route validated its input (#156) can carry
  // un-normalized values; createCheckout/capturePayment already normalized
  // theirs, executeRefund did not — and since the factory became
  // default-deny in #148, a legacy " Stripe " row threw instead of
  // refunding. These tests pin the normalized behaviour end to end against
  // a stubbed Stripe refunds endpoint (no real network).
  let fetchCalls: { url: string; body?: string }[] = [];

  const stripeRefundFetch = async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    fetchCalls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url === "https://api.stripe.com/v1/refunds") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "re_185_legacy", amount: 500 }),
        text: async () => JSON.stringify({ id: "re_185_legacy", amount: 500 }),
      } as Response;
    }
    throw new Error(`unexpected fetch in #185 tests: ${url}`);
  };

  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal("fetch", vi.fn(stripeRefundFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const refundParams = (gateway: string) => ({
    transactionId: "pay_legacy_185",
    amount: 5,
    gateway: gateway as SupportedGateway,
    gatewayRef: "pi_185_legacy",
    userLogin: "tester",
  });

  it("a legacy row stored as ' Stripe ' refunds through the stripe strategy", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.executeRefund(refundParams(" Stripe "));
    expect(result.success).toBe(true);
    expect(result.gateway).toBe("stripe");
    expect(result.refundId).toBe("re_185_legacy");
    expect(result.amountRefunded).toBe(5);
    expect(result.status).toBe("refunded");
    // The attestation is minted for the normalized gateway, as in createCheckout.
    expect(result.didAttestation.gateway).toBe("stripe");
    expect(fetchCalls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/refunds"]);
    expect(fetchCalls[0].body).toContain("payment_intent=pi_185_legacy");
  });

  it("an un-normalized row behaves identically to the normalized row", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const legacy = await service.executeRefund(refundParams(" Stripe "));
    const upper = await service.executeRefund(refundParams("STRIPE"));
    const normalized = await service.executeRefund(refundParams("stripe"));
    const shape = (r: typeof legacy) => ({
      success: r.success,
      gateway: r.gateway,
      refundId: r.refundId,
      amountRefunded: r.amountRefunded,
      status: r.status,
      message: r.message,
      attestedGateway: r.didAttestation.gateway,
    });
    expect(shape(legacy)).toEqual(shape(normalized));
    expect(shape(upper)).toEqual(shape(normalized));
    expect(fetchCalls).toHaveLength(3);
    expect(new Set(fetchCalls.map((c) => c.body)).size).toBe(1);
  });

  it("an unknown gateway still throws — normalization resurrects no fallback", async () => {
    const service = new PaymentGatewayService(makeEnv());
    await expect(service.executeRefund(refundParams(" BogusPay "))).rejects.toThrow(
      /Unsupported payment gateway: boguspay/
    );
    // The factory threw before any strategy ran: no gateway API was called.
    expect(fetchCalls).toHaveLength(0);
  });

  it("the explicitly named sandbox harness still refunds (normalized lookup, #148 contract)", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.executeRefund(refundParams(" Sandbox "));
    expect(result.success).toBe(true);
    expect(result.gateway).toBe("sandbox");
  });

  it("source pin: executeRefund normalizes before the factory lookup", () => {
    const payments = src("services/payments.ts");
    const body = payments.slice(payments.indexOf("async executeRefund"));
    const methodBody = body.slice(0, body.indexOf("\n  }"));
    expect(methodBody).toContain("normalizeGateway(params.gateway)");
    expect(methodBody.indexOf("normalizeGateway(params.gateway)")).toBeLessThan(
      methodBody.indexOf("PaymentStrategyFactory.getStrategy(gateway)")
    );
    expect(methodBody).not.toContain("getStrategy(params.gateway)");
  });
});

describe("/payments/webhook route — an unverifiable provider cannot settle a transaction (#148)", () => {
  const DRAFT_ID = "pay_route_148";
  // Seeded with a sentinel timestamp: the settle UPDATE writes a real
  // `updated_at`, so an untouched row is provable. (MockSqlStorage's UPDATE
  // parser applies only parameterized assignments, so the route's literal
  // `status = 'completed'` assignment is asserted via the settled audit +
  // updated_at it produces, not via the status column.)
  const SENTINEL_TS = "2020-01-01T00:00:00.000Z";

  const seedAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "system_webhook_receiver" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    sql.exec(
      `INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      DRAFT_ID, "sess-148", "charge", 25, "USD", "Acme Corp", "stripe", "",
      "pending_checkout", "", "did:agent:openaimp:payments", "", "sig", "", SENTINEL_TS, SENTINEL_TS
    );
    return { agent, sql };
  };

  const txRow = (sql: MockSqlStorage) =>
    (Array.from(sql.exec("SELECT * FROM mas_transactions WHERE id = ?", DRAFT_ID)) as any[])[0];

  const txStatus = (sql: MockSqlStorage) => txRow(sql)?.status;

  const settledAudits = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", "payment.settled_webhook")) as any[];

  const postWebhook = (agent: OrchestratorAgent, query: string, body: string, headers: Record<string, string> = {}) =>
    agent.onRequest(
      new Request(`https://agent.internal/payments/webhook${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      })
    );

  it("unknown provider: 401, transaction untouched, no settled audit", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const res = await postWebhook(agent, "?provider=boguspay", JSON.stringify({ draftId: DRAFT_ID, type: "x" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toContain("Unsupported webhook provider");
    expect(txStatus(sql)).toBe("pending_checkout");
    expect(txRow(sql)?.updated_at).toBe(SENTINEL_TS);
    expect(settledAudits(sql)).toHaveLength(0);
  });

  it("sandbox provider: 401, transaction untouched, no settled audit", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const res = await postWebhook(agent, "?provider=sandbox", JSON.stringify({ draftId: DRAFT_ID }));
    expect(res.status).toBe(401);
    expect(txStatus(sql)).toBe("pending_checkout");
    expect(txRow(sql)?.updated_at).toBe(SENTINEL_TS);
    expect(settledAudits(sql)).toHaveLength(0);
  });

  // Stripe-shaped body whose extracted reference id IS the seeded draft,
  // so a genuine settlement would update exactly that row.
  const routeBody = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { client_reference_id: DRAFT_ID } },
  });

  it("stripe with an invalid signature: 401, transaction untouched, no settled audit", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const res = await postWebhook(agent, "?provider=stripe", routeBody, {
      "stripe-signature": await stripeSignature(routeBody, "wrong-secret"),
    });
    expect(res.status).toBe(401);
    expect(txStatus(sql)).toBe("pending_checkout");
    expect(txRow(sql)?.updated_at).toBe(SENTINEL_TS);
    expect(settledAudits(sql)).toHaveLength(0);
  });

  it("stripe with the webhook secret unconfigured: 401, transaction untouched", async () => {
    const { agent, sql } = seedAgent(makeEnv({ STRIPE_WEBHOOK_SECRET: undefined }));
    const res = await postWebhook(agent, "?provider=stripe", routeBody, {
      "stripe-signature": await stripeSignature(routeBody, STRIPE_WH_SECRET),
    });
    expect(res.status).toBe(401);
    expect(txStatus(sql)).toBe("pending_checkout");
    expect(txRow(sql)?.updated_at).toBe(SENTINEL_TS);
    expect(settledAudits(sql)).toHaveLength(0);
  });

  it("stripe with a genuine signature still settles the transaction and audits it", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const res = await postWebhook(agent, "?provider=stripe", routeBody, {
      "stripe-signature": await stripeSignature(routeBody, STRIPE_WH_SECRET),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.received).toBe(true);
    // The settle UPDATE targeted the seeded row (its updated_at advanced
    // past the sentinel) and the settled audit was written for this draft.
    expect(txRow(sql)?.updated_at).not.toBe(SENTINEL_TS);
    const audits = settledAudits(sql);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].payload).draftId).toBe(DRAFT_ID);
    expect(JSON.parse(audits[0].payload).provider).toBe("stripe");
  });
});

describe("Source pins (#148)", () => {
  it("the service verifier has no permissive fall-through", () => {
    const payments = src("services/payments.ts");
    expect(payments).not.toContain("return { isValid: true }");
    expect(payments).toContain("Unsupported webhook provider");
  });

  it("the strategy factory has no sandbox fallback", () => {
    const strategies = src("patterns/paymentStrategies.ts");
    expect(strategies).not.toContain('|| this.strategies.get("sandbox")');
    expect(strategies).toContain("Unsupported payment gateway");
  });

  it("the webhook route guards the provider before settling", () => {
    // Slice 07 (#370): the /payments/webhook route moved from
    // src/agents/orchestrator.ts to src/agents/routes/payments.ts — the pin
    // follows the ownership. The guard-before-settle ordering is unchanged
    // (byte-identical move).
    const routes = src("agents/routes/payments.ts");
    const webhookBlock = routes.slice(routes.indexOf('"/payments/webhook"'));
    expect(webhookBlock).toContain("isWebhookGateway(provider)");
    expect(webhookBlock.indexOf("isWebhookGateway(provider)")).toBeLessThan(
      webhookBlock.indexOf("payment.settled_webhook")
    );
  });
});
