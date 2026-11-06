// @vitest-environment node
/**
 * Issue #3523 (2.14 follow-up): AOP coded messages + standards conformance for the
 * cancel-action outcomes (#2669 / PR #3512).
 *
 * The cancel route returns outcome-catalog codes with verbatim catalog businessMessages
 * (structural classification at the point of decision); replay returns 409; the cancel is
 * tenant-scoped to the server-resolved account tenant; the provider state is verified before
 * canceling; the audit record answers "which code, what happened, for which login" (+ tenant).
 * Messages are asserted FROM the catalog (`resolveOutcome(code).entry.businessMessage`), never
 * from a hardcoded string. No raw provider/Stripe text appears in any response body.
 *
 * Harness mirrors tests/cancel_refund_policy_2662_routes.test.ts (MockD1Database over
 * node:sqlite, real Drizzle adapters, fetch stubbed as Stripe REST).
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
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
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

/** Stripe stub: GET returns the provider object; POST cancel echoes; DELETE cancels. */
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
        throw new Error(`unexpected POST body ${body}`);
      }
      if (href === "https://api.stripe.com/v1/subscriptions/sub_prov_1" && method === "DELETE") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...providerObject, status: "canceled", canceled_at: Math.floor(NOW / 1000) }),
        } as any;
      }
      throw new Error(`unexpected Stripe fetch ${method} ${href}`);
    }),
  );
  return { calls, providerObject };
}

async function seedBillingRow(s: Awaited<ReturnType<typeof setup>>) {
  await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
  await s.policy.updatePolicy({
    stripePriceByPlan: { "plan-pro": "price_pro_monthly" },
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

/** The message for a code, from the catalog — never a hardcoded string. */
function catalogMessage(code: string): string {
  const entry = resolveOutcome(code).entry;
  expect(entry, `catalog entry for ${code}`).toBeDefined();
  return entry!.businessMessage;
}

describe("cancel outcomes are catalog-coded (#3523)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("period_end success returns the catalog code + verbatim catalog message, and the audit carries code + login + tenant", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END");
    expect(body.message).toBe(catalogMessage(body.code));
    expect(body.canceled).toHaveLength(1);
    expect(body.remaining).toEqual([]);
    expect(body.accessThroughMs).toBe(PERIOD_END);
    const auditCall = (s.ctx.audit as any).mock.calls.find(
      ([t]: [string]) => t === "commercial.subscription.canceled",
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall[2];
    expect(payload.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END");
    expect(payload.message).toBe(catalogMessage(payload.code));
    expect(payload.userId).toBe("u1");
    expect(payload.tenantId).toBe("t1");
    expect(payload.subscriptionIds).toEqual(["sub-row-bill"]);
  });

  it("immediate success returns the immediate catalog code + verbatim catalog message", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    await s.policy.updatePolicy({ downgradeTiming: "immediate" });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_IMMEDIATE");
    expect(body.message).toBe(catalogMessage(body.code));
    expect(body.canceled).toHaveLength(1);
    expect(body.downgradeTiming).toBe("immediate");
  });

  it("a replay (second cancel) returns 409 with the none-active catalog code, no raw text", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    const first = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(first?.status).toBe(200);
    const again = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(again?.status).toBe(409);
    const body = await bodyOf(again);
    expect(body.code).toBe("FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE");
    expect(body.message).toBe(catalogMessage(body.code));
    expect(body.retryable).toBe(false);
    expect(body.canceled).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Stripe");
  });

  it("provider failure returns 503 with the coded failure, no raw Stripe text, and a cancel_failed audit", async () => {
    const s = await setup({ monetization: true, stripe: true });
    // GET returns an active provider subscription; the cancel POST fails at Stripe.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        if (href === "https://api.stripe.com/v1/subscriptions/sub_prov_1" && method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "sub_prov_1",
              status: "active",
              current_period_start: Math.floor(PERIOD_START / 1000),
              current_period_end: Math.floor(PERIOD_END / 1000),
              cancel_at_period_end: false,
              canceled_at: null,
              items: { data: [{ id: "si_1", price: { id: "price_pro_monthly" } }] },
            }),
          } as any;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "Stripe boom: card_declined_internal_xyz" } }),
        } as any;
      }),
    );
    await seedBillingRow(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_SUBSCRIPTION_CANCEL_FAILED");
    expect(body.message).toBe(catalogMessage(body.code));
    expect(body.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Stripe boom");
    expect(JSON.stringify(body)).not.toContain("card_declined_internal_xyz");
    const failedAudit = (s.ctx.audit as any).mock.calls.find(
      ([t]: [string]) => t === "commercial.subscription.cancel_failed",
    );
    expect(failedAudit).toBeDefined();
    expect(failedAudit[2].code).toBe("FAILURE_SUBSCRIPTION_CANCEL_FAILED");
    expect(failedAudit[2].userId).toBe("u1");
    expect(failedAudit[2].tenantId).toBe("t1");
    // The provider failure changed nothing locally: the row is still active.
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows[0].status).toBe("active");
  });

  it("Billing cancel not configured returns 503 with the not-configured catalog code", async () => {
    const s = await setup({ monetization: true });
    await seedBillingRow(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_SUBSCRIPTION_CANCEL_NOT_CONFIGURED");
    expect(body.message).toBe(catalogMessage(body.code));
    expect(JSON.stringify(body)).not.toContain("not configured (Stripe)");
  });

  it("tenant negative: a row in another tenant survives the cancel and is reported in remaining", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await seedBillingRow(s);
    // Same user, other tenant: a repurchase row the resolved tenant (t1) must not touch.
    await s.subs.createSubscription({
      id: "sub-row-other-tenant",
      userId: "u1",
      tenantId: "t2",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "cs_test_other",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END");
    expect(body.canceled.map((r: any) => r.id)).toEqual(["sub-row-bill"]);
    expect(body.remaining.map((r: any) => r.id)).toEqual(["sub-row-other-tenant"]);
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows.find((r) => r.id === "sub-row-other-tenant")?.status).toBe("active");
    expect(rows.find((r) => r.id === "sub-row-bill")?.status).toBe("canceled");
  });

  it("provider already canceled: no provider cancel call, local row still marked canceled from verified state", async () => {
    const s = await setup({ monetization: true, stripe: true });
    const stripe = stubBillingStripe({
      provider: { status: "canceled", canceled_at: Math.floor(NOW / 1000) },
    });
    await seedBillingRow(s);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END");
    expect(body.canceled).toHaveLength(1);
    // Only the verification GET reached Stripe — no POST/DELETE cancel call.
    expect(stripe.calls.every((c) => c.method === "GET")).toBe(true);
    const rows = await s.subs.listSubscriptions("u1");
    expect(rows[0].status).toBe("canceled");
    expect(rows[0].providerStatus).toBe("canceled");
  });

  it("no account row: cancel stays user-scoped (cancel stops money; never blocked by a missing account)", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBillingStripe();
    await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
    await s.policy.updatePolicy({ stripePriceByPlan: { "plan-pro": "price_pro_monthly" } });
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
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END");
    const auditCall = (s.ctx.audit as any).mock.calls.find(
      ([t]: [string]) => t === "commercial.subscription.canceled",
    );
    expect(auditCall[2].tenantId).toBeNull();
    expect(auditCall[2].tenantScope).toBe("unresolved");
  });

  it("every new cancel code resolves in the outcome catalog", async () => {
    for (const code of [
      "SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END",
      "SUCCESS_SUBSCRIPTION_CANCELED_IMMEDIATE",
      "FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE",
      "FAILURE_SUBSCRIPTION_CANCEL_NOT_CONFIGURED",
      "FAILURE_SUBSCRIPTION_CANCEL_FAILED",
    ]) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved, code).toBe(true);
      expect(resolved.entry?.category).toBe("commercial");
    }
  });
});
