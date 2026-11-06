/**
 * Issues #2020/#2127 + #2198 (slice 2, #2146) — subscription
 * endpoints through handleAgenticPaymentsRoutes: plans as
 * operator data, the route-owned NATIVE Stripe checkout,
 * purchase activation on verified payment (session retrieve +
 * mandatory amount re-check), cancel-at-period-end, and the
 * effective-tier status read — plus the submit route's
 * effective-tier wiring.
 *
 * D1 is shared, so there is no canonical-instance hop: the
 * handler builds both store adapters straight from
 * ctx.env.AGENT_DB. Tests supply a MockD1Database (node:sqlite,
 * the slice0 pattern) with migrations 0007 + 0008 + 0013 applied
 * (via ensureSubscriptionSchema), so the real Drizzle adapters
 * run. Stripe is stubbed at fetch: POST /v1/checkout/sessions
 * mints a session (recording its draft id + amount), GET
 * /v1/checkout/sessions/{id} returns the test's scripted
 * session evidence.
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
import type { DatabaseORM } from "../src/orm";

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

async function setup(opts: { monetization?: boolean; stripe?: boolean } = {}) {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  let capturedParams: any = null;
  const binding = {
    create: vi.fn(async ({ id, params }: { id: string; params?: unknown }) => {
      capturedParams = params;
      return { workflowId: id };
    }),
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
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, binding, captured: () => capturedParams };
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

/**
 * Stub fetch as the Stripe REST API. POST /v1/checkout/sessions
 * mints a session id and records the draft id (client_reference_id)
 * + amount (unit_amount) the strategy sent; GET
 * /v1/checkout/sessions/{id} returns evidence for that session,
 * defaulting to complete + paid + amount-matched + reference-matched
 * + a payment intent, unless the test overrides fields via
 * setEvidence. Unknown sessions 404 (retrieve then fails closed).
 */
function stubStripe(overrides: Record<string, unknown> = {}) {
  const sessions = new Map<string, { draft: string; amount: number }>();
  let counter = 0;
  let evidenceOverrides: Record<string, unknown> = { ...overrides };
  const setEvidence = (partial: Record<string, unknown>) => {
    evidenceOverrides = { ...evidenceOverrides, ...partial };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const href = String(url);
      if (href === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
        const params = new URLSearchParams(String(init.body));
        const draft = params.get("client_reference_id") ?? "";
        const amount = Number(params.get("line_items[0][price_data][unit_amount]") ?? 0);
        counter += 1;
        const id = `cs_test_${counter}`;
        sessions.set(id, { draft, amount });
        return { ok: true, status: 200, json: async () => ({ id, url: `https://checkout.stripe.com/pay/${id}` }) };
      }
      const m = href.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^/]+)$/);
      if (m && init?.method === "GET") {
        const session = sessions.get(decodeURIComponent(m[1]));
        if (!session) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
        const evidence = {
          id: decodeURIComponent(m[1]),
          status: "complete",
          payment_status: "paid",
          amount_total: session.amount,
          client_reference_id: session.draft,
          payment_intent: "pi_test_1",
          ...evidenceOverrides,
        };
        return { ok: true, status: 200, json: async () => evidence };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  return { setEvidence };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createPlan(ctx: AgenticPaymentsRouteContext, plan: Record<string, unknown>) {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", plan);
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).plan;
}

describe("subscription plans", () => {
  it("auth matrix: anonymous cannot list, non-operator cannot create, operator can", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "GET", "/payments/agentic/commercial/plans", null))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "u1", { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 }))?.status).toBe(403);
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    expect(plan.id).toMatch(/^plan-/);
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/plans", "u1"));
    expect(listed.plans.map((p: any) => p.id)).toEqual([plan.id]);
  });

  it("validates plan input and deactivation", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", { priceUSD: 5, periodDays: 30, includedRuns: 0 }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", { name: "P", priceUSD: 0, periodDays: 30, includedRuns: 0 }))?.status).toBe(400);
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "u1", { planId: plan.id }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: "missing" }))?.status).toBe(404);
    const off = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: plan.id }));
    expect(off.plan.active).toBe(false);
    expect((await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/plans", "u1"))).plans).toEqual([]);
  });
});

describe("subscription checkout + purchase", () => {
  it("flag OFF refuses checkout and purchase before any Stripe call", async () => {
    const { ctx } = await setup({ stripe: true });
    stubStripe();
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x", checkoutSessionId: "cs_test_1" }))?.status).toBe(403);
  });

  it("native card unconfigured fails closed with 503", async () => {
    const { ctx } = await setup({ monetization: true });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    // #2219: checkout/purchase derive the tenant from the resolved
    // account, so an account row must exist before the card port check.
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }))?.status).toBe(503);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x", checkoutSessionId: "cs_test_1" }))?.status).toBe(503);
  });

  it("checkout returns a real checkoutUrl; unpaid activates nothing (402), paid activates and stores both Stripe ids (replay 409)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const stripe = stubStripe({ status: "open", payment_status: "unpaid" });
    // #2219: checkout/purchase derive the tenant from the resolved account,
    // so the account row must exist before the mint.
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    expect(checkout.checkoutRequestId).toMatch(/^sub-/);
    expect(checkout.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(checkout.checkoutSessionId).toMatch(/^cs_test_/);
    expect(checkout.plan.priceUSD).toBe(20);
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    });
    expect(denied?.status).toBe(402);
    const empty = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1"));
    expect(empty.subscriptions).toEqual([]);
    expect(empty.effectiveTier).toBe("Free");

    stripe.setEvidence({ status: "complete", payment_status: "paid" });
    const bought = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
        planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
      }),
    );
    expect(bought.subscription.status).toBe("active");
    expect(bought.subscription.planId).toBe(plan.id);
    expect(bought.subscription.provider).toBe("stripe");
    expect(bought.subscription.providerPaymentRef).toBe(checkout.checkoutRequestId);
    expect(bought.subscription.stripeSessionId).toBe(checkout.checkoutSessionId);
    expect(bought.subscription.stripePaymentIntentId).toBe("pi_test_1");
    expect(bought.subscription.periodEndMs).toBeGreaterThan(bought.subscription.periodStartMs);
    expect(bought.account.tierSource).toBe("subscription");
    expect(bought.account.includedRuns).toBe(10);
    expect(bought.effectiveTier).toBe("Subscribed");
    expect((ctx.audit as any).mock.calls.some(([t]: [string]) => t === "commercial.subscription.activated")).toBe(true);

    const replay = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    });
    expect(replay?.status).toBe(409);
  });

  it("activation audit carries previous → new effective tier (#2522)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    stubStripe();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    const bought = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    }));
    expect(bought.effectiveTier).toBe("Subscribed");
    const activated = (ctx.audit as any).mock.calls.find(([t]: [string]) => t === "commercial.subscription.activated");
    expect(activated).toBeDefined();
    expect(activated[2].previousEffectiveTier).toBe("Free");
    expect(activated[2].newEffectiveTier).toBe("Subscribed");
    expect(activated[2].planId).toBe(plan.id);
  });

  it("purchase posts Dr 1000 / Cr 2100 deferred revenue to the journal; a refused purchase posts nothing (#2155 follow-up)", async () => {
    const { ctx, env } = await setup({ monetization: true, stripe: true });
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const stripe = stubStripe({ status: "open", payment_status: "unpaid" });
    // #2219: checkout/purchase derive the tenant from the resolved account,
    // so the account row must exist before the mint.
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    const journal = new D1JournalAdapter(createD1JournalDb(env.AGENT_DB as unknown as D1Database));
    await ensureJournalSchema(journal.db);
    // Refused (unpaid) purchase: activation nothing, journal nothing.
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    }))?.status).toBe(402);
    expect(await journal.listEntries("t1")).toEqual([]);
    // Paid purchase: activation succeeds AND the journal pair posts.
    stripe.setEvidence({ status: "complete", payment_status: "paid" });
    const bought = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
        planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
      }),
    );
    expect(bought.subscription.status).toBe("active");
    const entries = await journal.listEntries("t1");
    expect(entries.map((e: any) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 20, 0],
      ["2100", 0, 20],
    ]);
    for (const e of entries) {
      expect(e.transactionRef).toBe(checkout.checkoutRequestId);
      expect(e.runRequestId).toBe(bought.subscription.id);
      expect(e.family).toBe("subscription");
    }
    expect(entries.every((e: any) => e.accountCode !== "4000")).toBe(true);
  });

  it("purchase refuses on amount mismatch (mandatory re-check) and activates nothing", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    stubStripe({ amount_total: 1999 });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    });
    expect(denied?.status).toBe(402);
    const empty = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1"));
    expect(empty.subscriptions).toEqual([]);
  });

  it("purchase refuses on reference mismatch and on a missing payment intent, without consuming the draft", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    const stripe = stubStripe({ client_reference_id: "sub-someone-else" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    const purchaseBody = {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    };
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", purchaseBody))?.status).toBe(402);
    stripe.setEvidence({ client_reference_id: checkout.checkoutRequestId, payment_intent: undefined });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", purchaseBody))?.status).toBe(402);
    stripe.setEvidence({ payment_intent: "pi_test_9" });
    const bought = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", purchaseBody));
    expect(bought.subscription.status).toBe("active");
    expect(bought.subscription.stripePaymentIntentId).toBe("pi_test_9");
  });

  it("rejects foreign checkout ids and inactive plans; the resolved tenant wins over a mismatched client tenant (#2219)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "run-123", checkoutSessionId: "cs_test_1" }))?.status).toBe(400);
    await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: plan.id });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", { planId: plan.id, tenantId: "t1", checkoutRequestId: "sub-x", checkoutSessionId: "cs_test_1" }))?.status).toBe(409);
    const live = await createPlan(ctx, { name: "L", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: live.id, tenantId: "t1", email: "u1@example.com" }),
    );
    // #2219: the client-supplied t2 is ignored; the purchase activates
    // under the resolved account tenant t1 instead of refusing.
    const bought = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
        planId: live.id, tenantId: "t2", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
      }),
    );
    expect(bought.subscription.tenantId).toBe("t1");
  });
});

describe("subscription cancel + status", () => {
  it("cancel-at-period-end keeps access to periodEnd, then a second cancel is empty", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    // #2219: checkout/purchase derive the tenant from the resolved account.
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    const bought = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    }));
    expect(bought.subscription.status).toBe("active");
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u2", { userId: "u1" }))?.status).toBe(403);
    const canceled = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {}));
    expect(canceled.canceled).toHaveLength(1);
    expect(canceled.canceled[0].status).toBe("canceled");
    expect(canceled.accessThroughMs).toBe(canceled.canceled[0].periodEndMs);
    const againRes = await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(againRes?.status).toBe(409);
    const again = await bodyOf(againRes);
    expect(again.code).toBe("FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE");
    expect(again.canceled).toEqual([]);
    const status = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1"));
    expect(status.effectiveTier).toBe("Subscribed");
    expect(status.current.status).toBe("canceled");
    expect((ctx.audit as any).mock.calls.some(([t]: [string]) => t === "commercial.subscription.canceled")).toBe(true);
    const opCancelRes = await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "op1", { userId: "u1" });
    expect(opCancelRes?.status).toBe(409);
    const opCancel = await bodyOf(opCancelRes);
    expect(opCancel.code).toBe("FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE");
    expect(opCancel.canceled).toEqual([]);
  });

  it("cancel audit states the effective tier at cancel time, unchanged by cancel (#2522)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Free" });
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", { planId: plan.id, tenantId: "t1", email: "u1@example.com" }),
    );
    await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id, tenantId: "t1", checkoutRequestId: checkout.checkoutRequestId, checkoutSessionId: checkout.checkoutSessionId,
    });
    const canceled = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {}));
    expect(canceled.canceled).toHaveLength(1);
    const cancelAudit = (ctx.audit as any).mock.calls.find(([t]: [string]) => t === "commercial.subscription.canceled");
    expect(cancelAudit).toBeDefined();
    // Cancel-at-period-end touches no periodEndMs, so the tier at
    // cancel time is still Subscribed — the audit states it, it
    // does not claim a change.
    expect(cancelAudit[2].effectiveTier).toBe("Subscribed");
    expect(cancelAudit[2].accessThroughMs).toBe(canceled.accessThroughMs);
  });

  it("status read auth: anonymous 401, other user 403, operator 200", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", null))?.status).toBe(401);
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u2"))?.status).toBe(403);
    expect((await call(ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "op1"))?.status).toBe(200);
  });
});

describe("submit route effective tier", () => {
  it("a lapsed subscription passes Free (not stored Subscribed) to the payment workflow", async () => {
    const { ctx, captured } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", { userId: "u1", tenantId: "t1", tier: "Subscribed" });
    // The operator route grants tierSource "operator" — rewrite the
    // grant to a subscription grant via the adapters, then let it
    // lapse: direct adapter writes keep this test honest about the
    // stored row (no route can produce this state on its own).
    const mock = (ctx.env as any).AGENT_DB;
    const subs = new D1SubscriptionAdapter(createD1SubscriptionDb(mock));
    const store = new D1CommercialAdapter(createD1CommercialDb(mock));
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 0 });
    await subs.createSubscription({
      id: "s-old", userId: "u1", tenantId: "t1", planId: "pro", provider: "cfpay",
      providerPaymentRef: "sub-old", periodStartMs: 1000, periodEndMs: 2000,
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      family: "goal",
      tenantId: "t1",
      email: "u1@example.com",
      screenerCommand: { jobId: "job-1", type: "run-screen", source: "test", trigger: "manual", userLogin: "u1", shards: [{ shardId: "goal" }] },
    });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).status).toBe("payment_started");
    expect(captured().account.tier).toBe("Free");
  });
});
