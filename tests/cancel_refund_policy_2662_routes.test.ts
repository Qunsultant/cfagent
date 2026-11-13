
// @vitest-environment node
/**
 * Issue #2662 route tests (part 2 of cancel_refund_policy_2662.test.ts):
 * refund-policy approve route, cancel immediate mode, plan change with
 * policy proration. Harness mirrors tests/billing_activation_2656.test.ts
 * (MockD1Database over node:sqlite, real Drizzle adapters, fetch stubbed
 * as Stripe REST).
 */
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
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import type { DatabaseORM } from "../src/orm";

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

async function setup(opts: {
  monetization?: boolean;
  stripe?: boolean;
  ensureBillingPolicy?: boolean;
} = {}) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  if (opts.ensureBillingPolicy !== false) await ensureBillingPolicySchema(policyDb);
  await ensureBillingCustomerSchema(createD1BillingCustomerDb(mock as unknown as D1Database));
  const refundDb = createD1RefundDb(mock as unknown as D1Database);
  await ensureRefundSchema(refundDb);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const subs = new D1SubscriptionAdapter(subsDb);
  const policy = new D1BillingPolicyAdapter(policyDb);
  const refunds = new D1RefundAdapter(refundDb);
  const commercial = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
  return { ctx, env, subs, policy, refunds, commercial, mock };
}

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

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

/** Stripe stub: GET subscription returns a priced item; POST update echoes the new price. */
function stubBillingStripe(overrides: { provider?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const providerObject = {
    id: "sub_prov_1",
    status: "active",
    current_period_start: Math.floor(PERIOD_START / 1000),
    current_period_end: Math.floor(PERIOD_END / 1000),
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ id: "si_1", price: { id: "price_pro_monthly" } }] },
    ...overrides.provider,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      calls.push({ url: href, method, body });
      if (href === "https://api.stripe.com/v1/subscriptions/sub_prov_1" && method === "GET") {
        return { ok: true, status: 200, json: async () => providerObject } as any;
      }
      if (href === "https://api.stripe.com/v1/subscriptions/sub_prov_1" && method === "POST") {
        const posted = new URLSearchParams(body);
        if (posted.get("cancel_at_period_end") === "true") {
          return { ok: true, status: 200, json: async () => ({ ...providerObject, cancel_at_period_end: true }) } as any;
        }
        const newPrice = posted.get("items[0][price]");
        if (newPrice) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ...providerObject,
              items: { data: [{ id: "si_1", price: { id: newPrice } }] },
            }),
          } as any;
        }
        throw new Error(`unexpected POST body ${body}`);
      }
      if (href === "https://api.stripe.com/v1/subscriptions/sub_prov_1" && method === "DELETE") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...providerObject, status: "canceled", canceled_at: Math.floor(NOW / 1000) }),
        } as any;
      }
      if (href === "https://api.stripe.com/v1/refunds" && method === "POST") {
        const params = new URLSearchParams(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "re_route_1", amount: Number(params.get("amount") ?? 0) }),
        } as any;
      }
      throw new Error(`unexpected Stripe fetch ${method} ${href}`);
    }),
  );
  return { calls, providerObject };
}

async function seedBillingRow(s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
  await s.subs.createPlan({ id: "plan-pro-annual", name: "Pro Annual", priceUSD: 200, periodDays: 365, includedRuns: 0 });
  // Issue #3357: plans land PROPOSED; the plan-change tests charge the target plan, so approve both.
  await s.subs.approvePlan("plan-pro", "op1");
  await s.subs.approvePlan("plan-pro-annual", "op1");
  await s.policy.updatePolicy({
    stripePriceByPlan: { "plan-pro": "price_pro_monthly", "plan-pro-annual": "price_pro_annual" },
  });
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
    ...extra,
  });
  await s.commercial.upsertAccount({
    userId: "u1",
    tenantId: "t1",
    tier: "Subscribed",
    tierSource: "subscription",
    creditsUSD: 0,
    includedRuns: 0,
  });
}

describe("refund-policy approve route (2.7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET reports real approval state, never a hardcoded proposed flag", async () => {
    const s = await setup({ monetization: true });
    const before = await bodyOf(await call(s.ctx, "GET", "/payments/agentic/commercial/refund-policy", "op1"));
    expect(before.policy.approvedKinds).toEqual([]);
    expect(before).not.toHaveProperty("proposed");
    const approved = await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "subscription",
      approved: true,
    });
    expect(approved?.status).toBe(200);
    expect((await bodyOf(approved)).policy.approvedKinds).toEqual(["subscription"]);
    const after = await bodyOf(await call(s.ctx, "GET", "/payments/agentic/commercial/refund-policy", "op1"));
    expect(after.policy.approvedKinds).toEqual(["subscription"]);
    expect(after.policy.approvedBy).toBe("op1");
  });

  it("approve is operator-only, validates kind, and is audited", async () => {
    const s = await setup({ monetization: true });
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "u1", {
        kind: "subscription",
        approved: true,
      }))?.status,
    ).toBe(403);
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
        kind: "bogus",
        approved: true,
      }))?.status,
    ).toBe(400);
    await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "pay_per_run",
      approved: true,
    });
    expect((s.ctx.audit as any).mock.calls.some((c: any[]) => String(c[0]).includes("refund.policy.approved"))).toBe(true);
  });

  it("a value edit resets approval, and requests then refuse 422", async () => {
    const s = await setup({ monetization: true });
    await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "pay_per_run",
      approved: true,
    });
    await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy", "op1", { windowDays: 14 });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "pay_per_run",
      originalPaymentRef: "run-1",
      amountUSD: 0.1,
      originalAmountUSD: 0.1,
      originalPaidAtMs: Date.now() - 1000,
      rail: "card",
      reason: "run failed",
    });
    expect(res?.status).toBe(422);
    expect((await bodyOf(res)).error).toMatch(/not owner-approved/);
  });

  it("unapproved request refuses 422 with no record; approved request succeeds", async () => {
    const s = await setup({ monetization: true });
    // Issue #3180: the succeeding request is a subscription
    // refund — its tenant comes from the resolved subscription
    // row. A route pay-per-run request has no resolved source and
    // is refused at tenant derivation (see refund_ports.test.ts).
    const plan = await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    await s.subs.createSubscription({
      id: "sub-row-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "sub-draft-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      periodStartMs: Date.now(),
      periodEndMs: Date.now() + 30 * 86_400_000,
    });
    const refused = await call(s.ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "changed mind",
    });
    expect(refused?.status).toBe(422);
    await call(s.ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "subscription",
      approved: true,
    });
    const ok = await call(s.ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "changed mind",
    });
    expect(ok?.status).toBe(200);
    expect((await bodyOf(ok)).refund.status).toBe("requested");
  });
});

describe("cancel immediate mode (2.7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downgradeTiming=immediate DELETEs the provider subscription and truncates local access", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe();
    await seedBillingRow(s);
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
    await s.policy.updatePolicy({ downgradeTiming: "immediate" });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.downgradeTiming).toBe("immediate");
    expect(body.canceled.length).toBe(2);
    expect(stripe.calls.some((c) => c.url.endsWith("/v1/subscriptions/sub_prov_1") && c.method === "DELETE")).toBe(true);
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows.every((r) => r.status === "canceled")).toBe(true);
    // Immediate truncation: local period end moves to now (within test tolerance), not PERIOD_END.
    expect(rows.every((r) => r.periodEndMs <= Date.now() && r.periodEndMs >= PERIOD_START)).toBe(true);
  });

  it("downgradeTiming=period_end keeps the existing at-period-end behavior", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.downgradeTiming).toBe("period_end");
    expect(body.accessThroughMs).toBe(PERIOD_END);
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows[0].periodEndMs).toBe(PERIOD_END);
  });

  it("an unreadable billing policy falls back to period_end, never to truncation", async () => {
    const s = await setup({ monetization: true, stripe: true, ensureBillingPolicy: false });
    stubBillingStripe();
    // Seed WITHOUT touching the billing policy store (its table was never
    // ensured): the cancel route's policy read throws and must fall back.
    await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
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
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).downgradeTiming).toBe("period_end");
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows[0].periodEndMs).toBe(PERIOD_END);
  });
});

describe("provider plan change with policy proration (2.7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("operator-only, flag-gated, and sends the policy prorationBehavior to Stripe", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe();
    await seedBillingRow(s);
    await s.policy.updatePolicy({ prorationBehavior: "always_invoice" });
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "u1", {
        subscriptionId: "sub-row-bill",
        planId: "plan-pro-annual",
      }))?.status,
    ).toBe(403);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
      subscriptionId: "sub-row-bill",
      planId: "plan-pro-annual",
    });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.subscription.planId).toBe("plan-pro-annual");
    expect(body.prorationBehavior).toBe("always_invoice");
    const posted = stripe.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/subscriptions/sub_prov_1"));
    expect(posted).toBeTruthy();
    const params = new URLSearchParams(posted!.body);
    expect(params.get("items[0][price]")).toBe("price_pro_annual");
    expect(params.get("items[0][id]")).toBe("si_1");
    expect(params.get("proration_behavior")).toBe("always_invoice");
    const row = await s.subs.getSubscription("sub-row-bill");
    expect(row?.planId).toBe("plan-pro-annual");
  });

  it("refuses flag-OFF, unmapped plans, same price, and non-Billing rows", async () => {
    const off = await setup({ stripe: true });
    stubBillingStripe();
    await seedBillingRow(off);
    expect(
      (await call(off.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
        subscriptionId: "sub-row-bill",
        planId: "plan-pro-annual",
      }))?.status,
    ).toBe(403);
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    await s.policy.updatePolicy({ stripePriceByPlan: { "plan-pro": "price_pro_monthly" } });
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
        subscriptionId: "sub-row-bill",
        planId: "plan-pro-annual",
      }))?.status,
    ).toBe(503);
    await s.policy.updatePolicy({
      stripePriceByPlan: { "plan-pro": "price_pro_monthly", "plan-pro-annual": "price_pro_annual" },
    });
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
        subscriptionId: "sub-row-bill",
        planId: "plan-pro",
      }))?.status,
    ).toBe(409);
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
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
        subscriptionId: "sub-row-repurchase",
        planId: "plan-pro-annual",
      }))?.status,
    ).toBe(400);
    expect(
      (await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
        subscriptionId: "sub-row-nope",
        planId: "plan-pro-annual",
      }))?.status,
    ).toBe(404);
  });
});
