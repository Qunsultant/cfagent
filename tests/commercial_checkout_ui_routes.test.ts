// @vitest-environment node
/**
 * Issue #2137: checkout UI support routes — pricing, submission
 * check-payment, goal-command — tested through
 * handleAgenticPaymentsRoutes.
 *
 * Issue #2196 (slice 3, #2146): the pricing route serves a
 * SERVER-DERIVED network marker (Stripe mode + x402 network) instead
 * of the old hardcoded testnetOnly: true, an externalized browser
 * payment scope (default card-only), and the native gate's failure
 * policy. The check-payment route is reworked from cfpay to native:
 * card verifies by Stripe session retrieve (complete + paid + amount
 * + reference, session from the caller or the checkout_created audit
 * payload) and returns the native checkoutUrl as paymentUrl when
 * unpaid; x402 verifies a supplied proof via the facilitator and
 * otherwise presents a 402 challenge flow with NO link. The cfpay
 * key alone no longer verifies anything. No network and no key are
 * involved: Stripe and facilitator HTTP are stubbed, and prices come
 * from a seeded in-memory D1 catalogue (the display seeds are never
 * used for verification).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1PriceCatalogueDb,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import { StripeCheckoutAdapter } from "../src/services/stripeCheckoutAdapter";

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const call = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
};

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice 0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function seededDb() {
  const mock = new MockD1Database();
  const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensurePriceCatalogueSchema(db);
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const commercial = new D1CommercialAdapter(commercialDb);
  await commercial.recordPaidSubmission({
    workflowId: "run-1",
    userId: "u1",
    runRequestId: "run-1",
  });
  await commercial.recordPaidSubmission({
    workflowId: "run-9",
    userId: "u1",
    runRequestId: "run-9",
  });
  return mock;
}

function ctxWith(
  env: Record<string, unknown>,
  binding?: Record<string, unknown>,
  getOrm?: () => unknown,
) {
  const ctx = {
    env: { ...env, ...(binding ? { PAYMENT_WORKFLOW: binding } : {}) },
    getOrm: getOrm ?? (() => ({}) as DatabaseORM),
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return ctx;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkout UI pricing route (#2137, native rework #2196)", () => {
  it("returns server-truth prices, a derived testnet marker, card-only scope, and the native failure policy", async () => {
    const res = await call(ctxWith({}), "GET", "/payments/agentic/commercial/pricing", "u1");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      monetizationEnabled: boolean;
      prices: Record<string, number>;
      network: { stripeMode: string; x402Network: string | null; acceptsMainnet: boolean };
      browserPaymentScope: string;
      failurePolicy: string;
    };
    expect(body.monetizationEnabled).toBe(false);
    // #5609 (G-7): the server-truth prices are the whole catalogue —
    // the four per-run families plus the three premium families.
    expect(body.prices).toEqual({
      stock: 0.02,
      goal: 0.1,
      options: 0.05,
      strategy: 0.1,
      "options-scan": 5,
      "market-research": 10,
      "stock-signals": 2,
    });
    // Nothing configured: fail-closed to the testnet presentation,
    // derived from the marker — not a hardcoded testnetOnly: true.
    expect(body.network).toEqual({ stripeMode: "unconfigured", x402Network: null, acceptsMainnet: false });
    expect(body).not.toHaveProperty("testnetOnly");
    expect(body.browserPaymentScope).toBe("card-only");
    expect(body.failurePolicy).toContain("One charge per run-request");
    expect(body.failurePolicy).toContain("replacement-run credit");
    expect(body.failurePolicy).not.toContain("cfpay");
  });

  it("reflects explicit env enablement", async () => {
    const res = await call(
      ctxWith({ MONETIZATION_ENABLED: "true" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { monetizationEnabled: boolean }).monetizationEnabled).toBe(true);
  });

  it("derives sandbox mode from a test Stripe key, still not mainnet", async () => {
    const res = await call(
      ctxWith({ STRIPE_SECRET_KEY: "sk_test_x" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    const body = (await res?.json()) as { network: { stripeMode: string; acceptsMainnet: boolean } };
    expect(body.network.stripeMode).toBe("sandbox");
    expect(body.network.acceptsMainnet).toBe(false);
  });

  it("derives live mode and mainnet acceptance from a live Stripe key", async () => {
    const res = await call(
      ctxWith({ ETRADE_ENVIRONMENT: "live", STRIPE_SECRET_KEY: "sk_live_x" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    const body = (await res?.json()) as { network: { stripeMode: string; acceptsMainnet: boolean } };
    expect(body.network.stripeMode).toBe("live");
    expect(body.network.acceptsMainnet).toBe(true);
  });

  it("derives the x402 network from the configured rail, testnet by default and mainnet on base", async () => {
    const recipient = "0x1111111111111111111111111111111111111111";
    const sepolia = await call(
      ctxWith({ X402_RECIPIENT_ADDRESS: recipient }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    const sepoliaBody = (await sepolia?.json()) as {
      network: { x402Network: string | null; acceptsMainnet: boolean };
    };
    expect(sepoliaBody.network.x402Network).toBe("Base Sepolia");
    expect(sepoliaBody.network.acceptsMainnet).toBe(false);
    const mainnet = await call(
      ctxWith({ X402_RECIPIENT_ADDRESS: recipient, X402_NETWORK: "base" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    const mainnetBody = (await mainnet?.json()) as {
      network: { x402Network: string | null; acceptsMainnet: boolean };
    };
    expect(mainnetBody.network.x402Network).toBe("Base");
    expect(mainnetBody.network.acceptsMainnet).toBe(true);
  });

  it("serves the operator browser scope and fails closed to card-only on unknown values", async () => {
    const widened = await call(
      ctxWith({ COMMERCIAL_BROWSER_PAYMENT_SCOPE: "card-and-x402" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    expect(((await widened?.json()) as { browserPaymentScope: string }).browserPaymentScope).toBe("card-and-x402");
    const bogus = await call(
      ctxWith({ COMMERCIAL_BROWSER_PAYMENT_SCOPE: "everything" }),
      "GET",
      "/payments/agentic/commercial/pricing",
      "u1",
    );
    expect(((await bogus?.json()) as { browserPaymentScope: string }).browserPaymentScope).toBe("card-only");
  });

  it("requires a verified login", async () => {
    const res = await call(ctxWith({}), "GET", "/payments/agentic/commercial/pricing", null);
    expect(res?.status).toBe(401);
  });
});

describe("checkout UI check-payment route (native rework #2196)", () => {
  const sendEvent = vi.fn(async () => {});
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({ sendEvent })),
  };

  const stripeSession = (over: Record<string, unknown> = {}) => ({
    id: "cs_test_run-1",
    status: "complete",
    payment_status: "paid",
    amount_total: 2,
    client_reference_id: "run-1",
    payment_intent: "pi_test_run-1",
    url: "https://checkout.stripe.com/pay/cs_test_run-1",
    ...over,
  });

  function stubStripe(session: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
          return { ok: true, json: async () => session };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
  }

  function stubFacilitator(isValid: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("/verify")) {
          return { ok: true, json: async () => ({ isValid }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
  }

  it("delivers payment_verified only when the native card rule holds", async () => {
    stubStripe(stripeSession());
    sendEvent.mockClear();
    const res = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { paid: boolean; delivered: boolean; state: string; rail: string };
    expect(body.paid).toBe(true);
    expect(body.delivered).toBe(true);
    expect(body.rail).toBe("stripe");
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "payment_verified",
        payload: expect.objectContaining({ sessionId: "cs_test_run-1", paymentIntentId: "pi_test_run-1" }),
      }),
    );
  });

  it("delivers nothing when amount or reference does not match, and surfaces the native checkoutUrl when unpaid", async () => {
    stubStripe(stripeSession({ status: "open", payment_status: "unpaid" }));
    sendEvent.mockClear();
    const res = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    const body = (await res?.json()) as { paid: boolean; state: string; paymentUrl: string | null; rail: string };
    expect(body.paid).toBe(false);
    expect(body.state).toBe("open");
    expect(body.paymentUrl).toBe("https://checkout.stripe.com/pay/cs_test_run-1");
    expect(body.rail).toBe("stripe");
    expect(sendEvent).not.toHaveBeenCalled();

    stubStripe(stripeSession({ amount_total: 999 }));
    const mismatch = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(((await mismatch?.json()) as { paid: boolean }).paid).toBe(false);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("resolves the session from the checkout_created audit payload when the caller supplies none", async () => {
    stubStripe(stripeSession({ id: "cs_test_run-9", client_reference_id: "run-9", payment_intent: "pi_test_run-9" }));
    sendEvent.mockClear();
    const getOrm = () => ({
      events: {
        findMany: () => [
          { payload: { runRequestId: "run-9", checkoutId: "cs_test_run-9", family: "stock" } },
        ],
      },
    });
    const res = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding, getOrm),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-9" },
    );
    const body = (await res?.json()) as { paid: boolean; delivered: boolean };
    expect(body.paid).toBe(true);
    expect(body.delivered).toBe(true);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ sessionId: "cs_test_run-9" }),
      }),
    );
  });

  it("reports checkout_not_found when no session is known, and never invents a URL", async () => {
    stubStripe(stripeSession());
    const res = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    const body = (await res?.json()) as { paid: boolean; state: string; paymentUrl: string | null };
    expect(body.paid).toBe(false);
    expect(body.state).toBe("checkout_not_found");
    expect(body.paymentUrl).toBeNull();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("verifies an x402 proof via the facilitator and delivers it, with no URL ever", async () => {
    stubFacilitator(true);
    sendEvent.mockClear();
    const payer = "0x2222222222222222222222222222222222222222";
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer })).toString("base64");
    const res = await call(
      ctxWith(
        {
          AGENT_DB: await seededDb(),
          X402_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
        },
        binding,
      ),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", family: "stock", paymentProof: proof, payer },
    );
    const body = (await res?.json()) as { paid: boolean; delivered: boolean; paymentUrl: string | null; rail: string };
    expect(body.paid).toBe(true);
    expect(body.delivered).toBe(true);
    expect(body.paymentUrl).toBeNull();
    expect(body.rail).toBe("x402");
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ paymentProof: proof, payer }),
      }),
    );
  });

  it("delivers nothing for an unverified x402 proof", async () => {
    stubFacilitator(false);
    sendEvent.mockClear();
    const payer = "0x2222222222222222222222222222222222222222";
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer })).toString("base64");
    const res = await call(
      ctxWith(
        {
          AGENT_DB: await seededDb(),
          X402_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
        },
        binding,
      ),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", family: "stock", paymentProof: proof, payer },
    );
    expect(((await res?.json()) as { paid: boolean }).paid).toBe(false);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("presents the x402 challenge flow with no link when no proof is supplied", async () => {
    const res = await call(
      ctxWith(
        {
          AGENT_DB: await seededDb(),
          X402_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
        },
        binding,
      ),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", family: "stock" },
    );
    const body = (await res?.json()) as {
      paid: boolean;
      state: string;
      paymentUrl: string | null;
      rail: string;
      challengeFlow: { network: string | null; amountUSD: number; currency: string; recipient: string; note: string };
    };
    expect(body.paid).toBe(false);
    expect(body.state).toBe("awaiting_proof");
    expect(body.paymentUrl).toBeNull();
    expect(body.rail).toBe("x402");
    expect(body.challengeFlow.network).toBe("Base Sepolia");
    expect(body.challengeFlow.amountUSD).toBe(0.02);
    expect(body.challengeFlow.currency).toBe("USDC");
    expect(body.challengeFlow.recipient).toBe("0x1111111111111111111111111111111111111111");
    expect(body.challengeFlow.note).toContain("no link");
    expect(body).not.toHaveProperty("checkoutUrl");
  });

  it("fails closed with no native port configured — a cfpay key alone no longer verifies", async () => {
    const res = await call(
      ctxWith({ CFPAY_A2A_TOKEN: "tok" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1" },
    );
    expect(res?.status).toBe(503);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("fails closed without a stored catalogue price, and validates input", async () => {
    stubStripe(stripeSession());
    const noPrice = await call(
      ctxWith({ STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(noPrice?.status).toBe(503);
    const noId = await call(
      ctxWith({ STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      {},
    );
    expect(noId?.status).toBe(400);
    const noLogin = await call(
      ctxWith({ STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      null,
      { runRequestId: "run-1" },
    );
    expect(noLogin?.status).toBe(401);
  });

  it("returns 404 FAILURE_COMMERCIAL_NOT_FOUND for an unknown submission before any Stripe or facilitator call (#4606)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => stripeSession() }));
    vi.stubGlobal("fetch", fetchMock);
    sendEvent.mockClear();
    const res = await call(
      ctxWith({ AGENT_DB: await seededDb(), STRIPE_SECRET_KEY: "sk_test_x" }, binding),
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "u1",
      { runRequestId: "run-unknown-4606", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(res?.status).toBe(404);
    const body = (await res?.json()) as { code: string; error: string };
    expect(body.code).toBe("FAILURE_COMMERCIAL_NOT_FOUND");
    expect(body.error).toBe("Submission not found.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe("card adapter passes the native checkoutUrl through to port evidence (#2196)", () => {
  it("maps a retrieved session url to evidence.checkoutUrl, and omits it when Stripe serves none", async () => {
    const withUrl = new StripeCheckoutAdapter({
      createCheckout: async () => ({ success: true, checkoutUrl: "https://checkout.example/s/1", gatewayRef: "cs_1" }),
      retrieveSession: async () => ({
        id: "cs_1",
        status: "open",
        payment_status: "unpaid",
        amount_total: 2,
        client_reference_id: "run-1",
        url: "https://checkout.example/s/1",
      }),
    });
    expect((await withUrl.retrieveCardSession({ sessionId: "cs_1" })).checkoutUrl).toBe(
      "https://checkout.example/s/1",
    );
    const withoutUrl = new StripeCheckoutAdapter({
      createCheckout: async () => ({ success: true, checkoutUrl: "https://checkout.example/s/1", gatewayRef: "cs_1" }),
      retrieveSession: async () => ({
        id: "cs_1",
        status: "complete",
        payment_status: "paid",
        amount_total: 2,
        client_reference_id: "run-1",
      }),
    });
    expect((await withoutUrl.retrieveCardSession({ sessionId: "cs_1" })).checkoutUrl).toBeUndefined();
  });
});

describe("checkout UI goal-command route (#2137)", () => {
  it("builds a goal screener command from kind and direction", async () => {
    const res = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "income", direction: "range_bound", symbols: ["AAPL"] },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { screenerCommand: { jobId: string; shards: Array<{ shardId: string }>; goalScreen: { scenario: { goalKind: string } } } };
    expect(body.screenerCommand.jobId).toBe("job-9");
    expect(body.screenerCommand.shards).toEqual([{ shardId: "goal" }]);
    expect(body.screenerCommand.goalScreen.scenario.goalKind).toBe("income");
  });

  it("rejects unknown kinds, directions, and missing identity", async () => {
    const badKind = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "nope", direction: "bullish" },
    );
    expect(badKind?.status).toBe(400);
    const badDir = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      "u1",
      { jobId: "job-9", goalKind: "income", direction: "sideways" },
    );
    expect(badDir?.status).toBe(400);
    const noLogin = await call(
      ctxWith({}),
      "POST",
      "/payments/agentic/commercial/goal-command",
      null,
      { jobId: "job-9", goalKind: "income", direction: "bullish" },
    );
    expect(noLogin?.status).toBe(401);
  });
});
