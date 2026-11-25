/**
 * Issue #2656 (Phase 2.1, #2405) — Billing activation: subscription-mode
 * Stripe Checkout → confirm-by-retrieve fulfillment → provider row +
 * customer mapping → webhook-driven renewal/failure → Billing-aware
 * cancel → operator policy routes.
 *
 * TDD: this file is written FIRST. It fails until the activation layer
 * lands. Harness mirrors tests/subscription_routes.test.ts (MockD1Database
 * over node:sqlite, real Drizzle adapters, fetch stubbed as Stripe REST).
 * The monetization flag stays a test env var; no value here is an owner
 * decision — plan + price mapping + policy are operator data set up in
 * the test itself.
 */
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1BillingCustomerDb,
  D1BillingCustomerAdapter,
  ensureBillingCustomerSchema,
} from "../src/data/d1BillingCustomerAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryBillingCustomerAdapter } from "../src/data/inMemoryBillingCustomerAdapter";
import { recordBillingSubscription } from "../src/services/billingService";
import type { ProviderSubscription } from "../src/services/billingPorts";
import { StripeBillingCheckoutAdapter } from "../src/services/stripeBillingCheckoutAdapter";
import { StripePaymentStrategy } from "../src/patterns/paymentStrategies";
import { DatabaseORM } from "../src/orm";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";

/** Test-local in-memory SqlStorage (same pattern as tests/orm_step3a_characterization_2345.test.ts). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
  transactionSync<T>(closure: (txn: { sql: SqliteTestStorage }) => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure({ sql: this });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
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

const NOW = Date.now();
const PERIOD_START = NOW - 1000;
const PERIOD_END = NOW + 30 * 24 * 3600 * 1000;

function providerSub(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    providerSubscriptionId: "sub_prov_1",
    status: "active",
    currentPeriodStartMs: PERIOD_START,
    currentPeriodEndMs: PERIOD_END,
    cancelAtPeriodEnd: false,
    canceledAtMs: null,
    customerId: "cus_1",
    priceId: "price_pro_monthly",
    ...overrides,
  };
}

describe("recordBillingSubscription (service, no routes)", () => {
  it("creates an active provider row from a provider subscription object", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const row = await recordBillingSubscription({
      subs,
      provider: providerSub(),
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      nowMs: NOW,
    });
    expect(row.status).toBe("active");
    expect(row.provider).toBe("stripe");
    expect(row.providerSubscriptionId).toBe("sub_prov_1");
    expect(row.providerPaymentRef).toBe("sub_prov_1");
    expect(row.periodStartMs).toBe(PERIOD_START);
    expect(row.periodEndMs).toBe(PERIOD_END);
    expect(row.planId).toBe("plan-pro");
  });

  it("is idempotent on provider id: replay returns the existing row", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const first = await recordBillingSubscription({
      subs,
      provider: providerSub(),
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      nowMs: NOW,
    });
    const replay = await recordBillingSubscription({
      subs,
      provider: providerSub(),
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      nowMs: NOW + 1000,
    });
    expect(replay.id).toBe(first.id);
    expect((await subs.listSubscriptions("u1")).length).toBe(1);
  });

  it("refuses an existing row claimed by a different user or tenant", async () => {
    const subs = new InMemorySubscriptionAdapter();
    await recordBillingSubscription({
      subs,
      provider: providerSub(),
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      nowMs: NOW,
    });
    await expect(
      recordBillingSubscription({
        subs,
        provider: providerSub(),
        userId: "u2",
        tenantId: "t1",
        planId: "plan-pro",
        nowMs: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      recordBillingSubscription({
        subs,
        provider: providerSub(),
        userId: "u1",
        tenantId: "t2",
        planId: "plan-pro",
        nowMs: NOW,
      }),
    ).rejects.toThrow();
  });

  it("refuses a missing provider id and an unusable period", async () => {
    const subs = new InMemorySubscriptionAdapter();
    await expect(
      recordBillingSubscription({
        subs,
        provider: providerSub({ providerSubscriptionId: "" }),
        userId: "u1",
        tenantId: "t1",
        planId: "plan-pro",
        nowMs: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      recordBillingSubscription({
        subs,
        provider: providerSub({ currentPeriodEndMs: PERIOD_START }),
        userId: "u1",
        tenantId: "t1",
        planId: "plan-pro",
        nowMs: NOW,
      }),
    ).rejects.toThrow();
  });
});

describe("billing customer mapping (first-wins)", () => {
  it("records and looks up; a different customer id for the same user refuses", async () => {
    const customers = new InMemoryBillingCustomerAdapter();
    expect(await customers.getCustomer("u1")).toBeNull();
    const rec = await customers.recordCustomer({
      userId: "u1",
      tenantId: "t1",
      stripeCustomerId: "cus_1",
    });
    expect(rec.stripeCustomerId).toBe("cus_1");
    expect((await customers.getCustomer("u1"))?.stripeCustomerId).toBe("cus_1");
    // Same customer again is idempotent.
    await customers.recordCustomer({ userId: "u1", tenantId: "t1", stripeCustomerId: "cus_1" });
    await expect(
      customers.recordCustomer({ userId: "u1", tenantId: "t1", stripeCustomerId: "cus_2" }),
    ).rejects.toThrow();
  });
});

describe("subscription-mode checkout session (strategy, fetch stubbed)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints mode=subscription with price + reference + metadata, and maps subscription/customer on retrieve", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        seen.push({ url: String(url), body: String(init?.body ?? "") });
        if (String(url) === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "cs_test_bill_1", url: "https://checkout.stripe.com/pay/cs_test_bill_1" }),
          } as any;
        }
        if (String(url).startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "cs_test_bill_1",
              status: "complete",
              payment_status: "paid",
              client_reference_id: "bill-1",
              subscription: "sub_prov_1",
              customer: "cus_1",
            }),
          } as any;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const env = { STRIPE_SECRET_KEY: "sk_test_stub" } as any;
    const strategy = new StripePaymentStrategy();
    const created = await strategy.createSubscriptionCheckoutSession(env, {
      draftId: "bill-1",
      priceId: "price_pro_monthly",
      metadata: { userId: "u1", planId: "plan-pro", tenantId: "t1" },
    });
    expect(created.id).toBe("cs_test_bill_1");
    expect(created.url).toContain("checkout.stripe.com");
    const posted = new URLSearchParams(seen[0].body);
    expect(posted.get("mode")).toBe("subscription");
    expect(posted.get("line_items[0][price]")).toBe("price_pro_monthly");
    expect(posted.get("client_reference_id")).toBe("bill-1");
    expect(posted.get("metadata[userId]")).toBe("u1");
    expect(posted.get("metadata[planId]")).toBe("plan-pro");
    expect(posted.get("subscription_data[metadata][planId]")).toBe("plan-pro");
    expect(posted.get("customer")).toBeNull();
    const retrieved = await strategy.retrieveCheckoutSession(env, "cs_test_bill_1");
    expect(retrieved.subscriptionId).toBe("sub_prov_1");
    expect(retrieved.customerId).toBe("cus_1");
    expect(retrieved.status).toBe("complete");
    expect(retrieved.payment_status).toBe("paid");
  });

  it("passes an existing customer id through to Stripe", async () => {
    let postedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        postedBody = String(init?.body ?? "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cs_test_bill_2", url: "https://checkout.stripe.com/pay/cs_test_bill_2" }),
        } as any;
      }),
    );
    const adapter = new StripeBillingCheckoutAdapter({
      createSubscriptionCheckoutSession: async (params) => {
        const strategy = new StripePaymentStrategy();
        return strategy.createSubscriptionCheckoutSession({ STRIPE_SECRET_KEY: "sk_test_stub" } as any, params);
      },
      retrieveCheckoutSession: async (sessionId) => {
        const strategy = new StripePaymentStrategy();
        return strategy.retrieveCheckoutSession({ STRIPE_SECRET_KEY: "sk_test_stub" } as any, sessionId);
      },
    });
    await adapter.createSubscriptionCheckout({
      draftId: "bill-2",
      priceId: "price_pro_monthly",
      customerId: "cus_1",
      metadata: { userId: "u1", planId: "plan-pro", tenantId: "t1" },
    });
    expect(new URLSearchParams(postedBody).get("customer")).toBe("cus_1");
  });
});

/* ------------------------------------------------------------------ */
/* Route tests: billing checkout / purchase / webhook / policy / cancel */
/* ------------------------------------------------------------------ */

async function setup(opts: { monetization?: boolean; stripe?: boolean; webhookSecret?: boolean } = {}) {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const journalDb = createD1JournalDb(mock as unknown as D1Database);
  await ensureJournalSchema(journalDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  const customerDb = createD1BillingCustomerDb(mock as unknown as D1Database);
  await ensureBillingCustomerSchema(customerDb);
  const binding = {
    create: vi.fn(async ({ id, params }: { id: string; params?: unknown }) => ({ workflowId: id })),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  // Phase 3 (#6550): the monetization flag must be set
  // EXPLICITLY in both directions now. A bare env no longer means
  // "monetization off" — environment.config.json always carries
  // FEATURE_MONETIZATION="1", so an omitted var resolves ON via the
  // file. An explicit legacy env var still beats the file default.
  env.MONETIZATION_ENABLED = opts.monetization ? "true" : "false";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  if (opts.webhookSecret) env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const subs = new D1SubscriptionAdapter(subsDb);
  const policy = new D1BillingPolicyAdapter(policyDb);
  const customers = new D1BillingCustomerAdapter(customerDb);
  return { ctx, env, subs, policy, customers, mock };
}

const req = (method: string, path: string, login: string | null, body?: unknown, extraHeaders?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const call = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body, extraHeaders), url, url.pathname, "sess-1", ctx);
};

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

function signWebhook(secret: string, payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * Stub fetch as the Stripe REST API for Billing: POST /v1/checkout/sessions
 * mints a subscription-mode session (records mode/price/reference);
 * GET /v1/checkout/sessions/{id} returns scripted session evidence;
 * GET /v1/subscriptions/{id} returns the scripted provider object;
 * POST /v1/subscriptions/{id} records the cancel call and returns the
 * provider object with cancel_at_period_end true.
 */
function stubBillingStripe(overrides: {
  session?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  sessionCreateError?: { status: number; message: string };
  /** Issue #4692: script the session-create payload itself (e.g. no url) — the mint must code that distinctly. */
  sessionCreateResult?: Record<string, unknown> | null;
} = {}) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const sessionEvidence = {
    id: "cs_test_bill_1",
    status: "complete",
    payment_status: "paid",
    client_reference_id: "bill-1",
    subscription: "sub_prov_1",
    customer: "cus_1",
    metadata: { userId: "u1", planId: "plan-pro", tenantId: "u1" },
    ...overrides.session,
  };
  const providerObject = {
    id: "sub_prov_1",
    status: "active",
    current_period_start: Math.floor(PERIOD_START / 1000),
    current_period_end: Math.floor(PERIOD_END / 1000),
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ price: { id: "price_pro_monthly" } }] },
    ...overrides.provider,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      calls.push({ url: href, method, body });
      if (href === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") {
        if (overrides.sessionCreateError) {
          return {
            ok: false,
            status: overrides.sessionCreateError.status,
            json: async () => ({ error: { message: overrides.sessionCreateError!.message } }),
          } as any;
        }
        if (overrides.sessionCreateResult !== undefined) {
          return {
            ok: true,
            status: 200,
            json: async () => overrides.sessionCreateResult,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cs_test_bill_1", url: "https://checkout.stripe.com/pay/cs_test_bill_1" }),
        } as any;
      }
      if (href.startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
        return { ok: true, status: 200, json: async () => sessionEvidence } as any;
      }
      if (href.startsWith("https://api.stripe.com/v1/subscriptions/") && method === "GET") {
        const requested = href.slice("https://api.stripe.com/v1/subscriptions/".length);
        if (requested !== "sub_prov_1") {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: { message: `No such subscription: '${requested}'` } }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => providerObject } as any;
      }
      if (href.startsWith("https://api.stripe.com/v1/subscriptions/") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...providerObject, cancel_at_period_end: true }),
        } as any;
      }
      throw new Error(`unexpected Stripe fetch ${method} ${href}`);
    }),
  );
  return { calls, sessionEvidence, providerObject };
}

async function seedPlanAndPrice(s: Awaited<ReturnType<typeof setup>>) {
  await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
  // Issue #3357: plans land PROPOSED; these tests charge the plan, so approve it — the gate working as designed.
  await s.subs.approvePlan("plan-pro", "op1");
  await s.policy.updatePolicy({ stripePriceByPlan: { "plan-pro": "price_pro_monthly" } });
}

describe("billing-checkout route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses when the monetization flag is OFF, and when Stripe is unconfigured", async () => {
    const off = await setup({ stripe: true });
    await seedPlanAndPrice(off);
    expect(
      (await call(off.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
        planId: "plan-pro",
        tenantId: "t1",
      }))?.status,
    ).toBe(403);
    const noStripe = await setup({ monetization: true });
    await seedPlanAndPrice(noStripe);
    const noStripeRes = await call(noStripe.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    expect(noStripeRes?.status).toBe(503);
    // Issue #4692: Stripe unconfigured has its own coded outcome — the
    // generic 503 code no longer stands for a known cause.
    const noStripeBody = await bodyOf(noStripeRes);
    expect(noStripeBody.code).toBe("FAILURE_BILLING_STRIPE_NOT_CONFIGURED");
    expect(noStripeBody.message).toMatch(/Stripe checkout is not configured/);
  });

  it("refuses unknown/inactive plans and a missing operator price mapping", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
        planId: "plan-nope",
        tenantId: "t1",
      }))?.status,
    ).toBe(404);
    await s.subs.createPlan({ id: "plan-old", name: "Old", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    await s.subs.deactivatePlan("plan-old");
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
        planId: "plan-old",
        tenantId: "t1",
      }))?.status,
    ).toBe(409);
    const noMap = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await noMap.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
    // Issue #3357: the missing-mapping check runs after the approval gate, so approve first.
    await noMap.subs.approvePlan("plan-pro", "op1");
    await noMap.policy.updatePolicy({ stripePriceByPlan: {} });
    const noMapRes = await call(noMap.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    expect(noMapRes?.status).toBe(503);
    // Issue #4692: the unset-mapping path has its own coded outcome —
    // the generic 503 code no longer stands for a known cause (this
    // supersedes the #4642 comment that kept the generic code here).
    const noMapBody = await bodyOf(noMapRes);
    expect(noMapBody.code).toBe("FAILURE_BILLING_PRICE_MAPPING_MISSING");
    expect(noMapBody.message).toMatch(/No Stripe Price id is mapped for this plan/);
    expect(noMapBody.message).toMatch(/Billing tab/);
  });

  it("a Stripe rejection of the mapped price returns the distinct rejection code, not the generic 503 (#4642)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe({
      sessionCreateError: {
        status: 400,
        message: "You cannot use a one-time price in a subscription mode Checkout Session.",
      },
    });
    await seedPlanAndPrice(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    const body = await bodyOf(res);
    // RED before the fix: the mint swallows the Stripe 400 into the generic 503.
    expect(res?.status).toBe(400);
    expect(body.code).toBe("FAILURE_BILLING_CHECKOUT_REJECTED");
    expect(body.code).not.toBe("FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE");
    // The raw Stripe reason never reaches the client.
    expect(JSON.stringify(body)).not.toContain("You cannot use a one-time price");
  });

  it("an identity-resolution failure returns its own coded outcome, not the generic 503 (#4692)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    // Corrupt the buyer's account row: the identity read throws while
    // mapping it (invalid tier), which is the production failure mode
    // for an account store that cannot be read.
    s.mock.sqlite
      .prepare(
        "INSERT INTO agent_commercial_accounts (id, tenant_id, tier, credits_usd, included_runs, segment, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("u1", "t1", "Bogus", 0, 0, "default", Date.now());
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    const body = await bodyOf(res);
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_BILLING_IDENTITY_UNAVAILABLE");
    expect(body.message).toMatch(/identity could not be resolved/);
    // The raw store reason never reaches the client.
    expect(JSON.stringify(body)).not.toContain("Invalid tier");
  });

  it("a session created with no checkout URL returns its own coded outcome, not the generic 503 (#4692)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe({ sessionCreateResult: { id: "cs_test_bill_1" } });
    await seedPlanAndPrice(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    const body = await bodyOf(res);
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_BILLING_CHECKOUT_SESSION_INVALID");
    expect(body.message).toMatch(/no checkout link/);
  });

  it("a plan that is not the effective version for the buyer's segment returns a coded 409, not a raw message (#4692)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    // A newer version of the same product (same name → same product id)
    // becomes effective, so plan-pro is no longer the effective version.
    await s.subs.createPlan({ id: "plan-pro2", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    const body = await bodyOf(res);
    expect(res?.status).toBe(409);
    expect(body.code).toBe("FAILURE_PLAN_NOT_EFFECTIVE_FOR_SEGMENT");
    expect(body.message).toMatch(/not the effective approved version/);
    // The raw segment-check reason never reaches the client.
    expect(JSON.stringify(body)).not.toContain("refusing to activate");
  });

  it("an unbound commercial store returns the store code, not the generic 503 (#4692)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    const ctxNoDb = { ...s.ctx, env: { ...s.env, AGENT_DB: undefined } } as unknown as AgenticPaymentsRouteContext;
    const res = await call(ctxNoDb, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    const body = await bodyOf(res);
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
    // The require* failures carry the coded message in `error` (their
    // pre-existing shape), not `message`.
    expect(body.error).toMatch(/commercial store is unavailable/);
  });

  it("mints a subscription-mode session and audits, without creating a row", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe();
    await seedPlanAndPrice(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
    });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.checkoutUrl).toContain("checkout.stripe.com");
    expect(body.checkoutSessionId).toBe("cs_test_bill_1");
    expect(typeof body.checkoutRequestId).toBe("string");
    const posted = new URLSearchParams(stripe.calls[0].body);
    expect(posted.get("mode")).toBe("subscription");
    expect(posted.get("line_items[0][price]")).toBe("price_pro_monthly");
    expect(posted.get("client_reference_id")).toBe(body.checkoutRequestId);
    // Resolved identity wins over the request body: no account row
    // exists, so the login-as-tenant fallback is namespaced under login:.
    expect(posted.get("metadata[userId]")).toBe("u1");
    expect(posted.get("metadata[tenantId]")).toBe("login:u1");
    expect(posted.get("metadata[planId]")).toBe("plan-pro");
    expect((await s.subs.listSubscriptions("login:u1")).length).toBe(0);
    expect((s.ctx.audit as any).mock.calls.some((c: any[]) => String(c[0]).includes("billing"))).toBe(true);
  });
});

describe("billing-purchase route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fulfills on verified evidence, confers Subscribed, and replays as 409", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    const ok = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
      checkoutRequestId: "bill-1",
      checkoutSessionId: "cs_test_bill_1",
    });
    expect(ok?.status).toBe(200);
    const body = await bodyOf(ok);
    expect(body.subscription.providerSubscriptionId).toBe("sub_prov_1");
    expect(body.subscription.status).toBe("active");
    expect(body.effectiveTier).toBe("Subscribed");
    const mapping = await s.customers.getCustomer("u1");
    expect(mapping?.stripeCustomerId).toBe("cus_1");
    const replay = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
      checkoutRequestId: "bill-1",
      checkoutSessionId: "cs_test_bill_1",
    });
    expect(replay?.status).toBe(409);
  });

  it("writes a best-effort subscription receipt row visible to the revenue summary (#5235)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    const storage = new SqliteTestStorage();
    const orm = new DatabaseORM(storage);
    orm.initializeSchema("sess-5235");
    (s.ctx as unknown as { getOrm: () => DatabaseORM }).getOrm = () => orm;
    const ok = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
      planId: "plan-pro",
      tenantId: "t1",
      checkoutRequestId: "bill-1",
      checkoutSessionId: "cs_test_bill_1",
    });
    expect(ok?.status).toBe(200);
    const rows = orm.transactions.findMany({ where: { id: "tx_bill-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "agentic_payment",
      gateway: "stripe",
      amount: 20,
      status: "completed",
    });
    expect(rows[0].note).toMatch(/^Subscription purchase plan plan-pro/);
    const summary = orm.getRevenueSummary();
    expect(summary.subscriptionRevenue).toBeCloseTo(20);
    expect(summary.subscriptionCount).toBe(1);
  });

  it("refuses reference mismatch, unpaid sessions, and provider price mismatch with 402", async () => {
    const refMismatch = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(refMismatch);
    expect(
      (await call(refMismatch.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
        planId: "plan-pro",
        tenantId: "t1",
        checkoutRequestId: "bill-other",
        checkoutSessionId: "cs_test_bill_1",
      }))?.status,
    ).toBe(402);

    const unpaid = await setup({ monetization: true, stripe: true });
    stubBillingStripe({ session: { payment_status: "unpaid" } });
    await seedPlanAndPrice(unpaid);
    expect(
      (await call(unpaid.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
        planId: "plan-pro",
        tenantId: "t1",
        checkoutRequestId: "bill-1",
        checkoutSessionId: "cs_test_bill_1",
      }))?.status,
    ).toBe(402);

    const priceMismatch = await setup({ monetization: true, stripe: true });
    stubBillingStripe({ provider: { items: { data: [{ price: { id: "price_other" } }] } } });
    await seedPlanAndPrice(priceMismatch);
    expect(
      (await call(priceMismatch.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
        planId: "plan-pro",
        tenantId: "t1",
        checkoutRequestId: "bill-1",
        checkoutSessionId: "cs_test_bill_1",
      }))?.status,
    ).toBe(402);
  });

  it("refuses when an existing customer mapping names a different Stripe customer", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedPlanAndPrice(s);
    await s.customers.recordCustomer({ userId: "u1", tenantId: "t1", stripeCustomerId: "cus_other" });
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-purchase", "u1", {
        planId: "plan-pro",
        tenantId: "t1",
        checkoutRequestId: "bill-1",
        checkoutSessionId: "cs_test_bill_1",
      }))?.status,
    ).toBe(409);
    expect((await s.subs.listSubscriptions("u1")).length).toBe(0);
  });
});

describe("billing webhook route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedBillingRow(s: Awaited<ReturnType<typeof setup>>) {
    await seedPlanAndPrice(s);
    await s.subs.createSubscription({
      id: "sub-row-1",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub_prov_1",
      providerSubscriptionId: "sub_prov_1",
      providerStatus: "active",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
  }

  it("refuses an unverified signature with 401 and applies nothing", async () => {
    const s = await setup({ monetization: true, stripe: true, webhookSecret: true });
    stubBillingStripe();
    await seedBillingRow(s);
    const payload = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_prov_1" } } });
    const manual = new Request("https://agent.internal/payments/agentic/commercial/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
      body: payload,
    });
    const url = new URL("https://agent.internal/payments/agentic/commercial/billing/webhook");
    const manualRes = await handleAgenticPaymentsRoutes(manual, url, url.pathname, "sess-1", s.ctx);
    expect(manualRes?.status).toBe(401);
    expect((await s.subs.listSubscriptions("u1"))[0].providerStatus).toBe("active");
  });

  it("applies subscription.updated and invoice.payment_failed, and ignores unknown ids", async () => {
    const s = await setup({ monetization: true, stripe: true, webhookSecret: true });
    // The service applies the RETRIEVED provider object's status, not
    // the event payload's — so the stubbed provider is past_due here.
    stubBillingStripe({ provider: { status: "past_due" } });
    await seedBillingRow(s);
    const post = async (event: unknown) => {
      const payload = JSON.stringify(event);
      const manual = new Request("https://agent.internal/payments/agentic/commercial/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": signWebhook("whsec_test", payload), "content-type": "application/json" },
        body: payload,
      });
      const url = new URL("https://agent.internal/payments/agentic/commercial/billing/webhook");
      return handleAgenticPaymentsRoutes(manual, url, url.pathname, "sess-1", s.ctx);
    };
    const updated = await post({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_prov_1", status: "past_due" } },
    });
    expect(updated?.status).toBe(200);
    expect((await bodyOf(updated)).applied).toBe(true);
    expect((await s.subs.listSubscriptions("u1"))[0].providerStatus).toBe("past_due");
    const failed = await post({
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", subscription: "sub_prov_1" } },
    });
    expect(failed?.status).toBe(200);
    expect((await bodyOf(failed)).applied).toBe(true);
    const unknown = await post({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_unknown" } },
    });
    expect(unknown?.status).toBe(200);
    expect((await bodyOf(unknown)).applied).toBe(false);
  });

  it("applies nothing while the monetization flag is OFF, but still answers 200", async () => {
    const s = await setup({ stripe: true, webhookSecret: true });
    stubBillingStripe();
    await seedBillingRow(s);
    const payload = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_prov_1", status: "canceled" } },
    });
    const manual = new Request("https://agent.internal/payments/agentic/commercial/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": signWebhook("whsec_test", payload), "content-type": "application/json" },
      body: payload,
    });
    const url = new URL("https://agent.internal/payments/agentic/commercial/billing/webhook");
    const res = await handleAgenticPaymentsRoutes(manual, url, url.pathname, "sess-1", s.ctx);
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).applied).toBe(false);
    expect((await s.subs.listSubscriptions("u1"))[0].providerStatus).toBe("active");
  });
});

describe("billing-policy routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("operator-only; GET returns the policy, POST validates and stores", async () => {
    const s = await setup({ monetization: true, stripe: true });
    expect(
      (await call(s.ctx, "GET", "/payments/agentic/commercial/billing-policy", "u1"))?.status,
    ).toBe(403);
    const before = await bodyOf(await call(s.ctx, "GET", "/payments/agentic/commercial/billing-policy", "op1"));
    expect(before.policy).toBeTruthy();
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
        billingPeriodDefault: "not-a-period",
      }))?.status,
    ).toBe(400);
    const after = await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      billingPeriodDefault: "annual",
      gracePeriodDays: 3,
    });
    expect(after?.status).toBe(200);
    // Issue #3571 (residual): the generic policy_set branch — the one
    // top-up-limits edits take — audits with code + message + login,
    // like the discount and offer-rules branches.
    expect(s.ctx.audit).toHaveBeenCalledWith(
      "commercial.billing.policy_set",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_BILLING_POLICY_UPDATED",
        message: resolveOutcome("SUCCESS_BILLING_POLICY_UPDATED").businessMessage,
        login: "op1",
      }),
    );
    const stored = await bodyOf(await call(s.ctx, "GET", "/payments/agentic/commercial/billing-policy", "op1"));
    expect(stored.policy.billingPeriodDefault).toBe("annual");
    expect(stored.policy.gracePeriodDays).toBe(3);
  });
});

describe("Billing-aware cancel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provider-cancels Billing rows and locally cancels repurchase rows, atomically", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe();
    await seedPlanAndPrice(s);
    await s.subs.createSubscription({
      id: "sub-row-bill",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub_prov_1",
      providerSubscriptionId: "sub_prov_1",
      providerStatus: "active",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    await s.subs.createSubscription({
      id: "sub-row-repurchase",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "cs_test_old",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.canceled.length).toBe(2);
    expect(body.accessThroughMs).toBe(PERIOD_END);
    expect(stripe.calls.some((c) => c.url.includes("/v1/subscriptions/sub_prov_1") && c.method === "POST")).toBe(true);
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows.every((r) => r.status === "canceled")).toBe(true);
    expect(rows.every((r) => r.periodEndMs === PERIOD_END)).toBe(true);
  });

  it("repurchase-only cancel does not touch the provider", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe();
    await seedPlanAndPrice(s);
    await s.subs.createSubscription({
      id: "sub-row-repurchase",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "cs_test_old",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).canceled.length).toBe(1);
    expect(stripe.calls.some((c) => c.url.includes("/v1/subscriptions/"))).toBe(false);
  });
});
