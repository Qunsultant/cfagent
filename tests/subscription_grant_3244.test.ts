/**
 * Issue #3244 (slice 2 of #3241) — operator subscription grant
 * per product.
 *
 * An operator grants a plan to a user: the grant creates a
 * subscription row AND bumps the target account's included runs,
 * mirroring the one-time purchase activation
 * (src/services/subscriptionActivation.ts) exactly — the gate
 * reads included runs from the account row only, so a row-only
 * grant would enable nothing (the Billing-path gap). No checkout
 * is involved and no Stripe record is created: provider is
 * "operator", the payment ref is a minted `grant-` id, and both
 * Stripe ids are null. The row's tenantId comes from the target
 * account row resolved server-side, never from the request body.
 * At expiry the effective tier falls back and the normal gate
 * resumes (resolveEffectiveTier).
 *
 * Route tests run the real Drizzle adapters over a MockD1Database
 * (node:sqlite, the slice0 pattern); service tests run the
 * in-memory adapters.
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
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { MS_PER_DAY, resolveEffectiveTier } from "../src/data/subscriptionPorts";
import { grantSubscription } from "../src/services/subscriptionActivation";
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

async function setup() {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createPlan(ctx: AgenticPaymentsRouteContext, plan: Record<string, unknown>) {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", plan);
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).plan;
}

async function createAccount(ctx: AgenticPaymentsRouteContext, userId: string, tenantId: string, tier = "Free") {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
    userId,
    tenantId,
    tier,
    creditsUSD: 0,
    includedRuns: 2,
  });
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).record;
}

const NOW = 1_800_000_000_000;

describe("grantSubscription (service)", () => {
  it("creates the row and bumps account included runs like a purchase", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "PayPerUse", creditsUSD: 3, includedRuns: 2 });
    const plan = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const granted = await grantSubscription({ subs, store, userId: "u1", plan, grantedBy: "op1", nowMs: NOW });
    expect(granted.subscription.planId).toBe("pro");
    expect(granted.subscription.userId).toBe("u1");
    // Tenant comes from the target account row.
    expect(granted.subscription.tenantId).toBe("t1");
    // No Stripe record: an operator grant is operator data.
    expect(granted.subscription.provider).toBe("operator");
    expect(granted.subscription.providerPaymentRef).toMatch(/^grant-/);
    expect(granted.subscription.stripeSessionId).toBeNull();
    expect(granted.subscription.stripePaymentIntentId).toBeNull();
    expect(granted.subscription.status).toBe("active");
    expect(granted.subscription.periodStartMs).toBe(NOW);
    expect(granted.subscription.periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
    // The purchase mirror: stored tier kept, tierSource subscription, runs added.
    expect(granted.account.tier).toBe("PayPerUse");
    expect(granted.account.tierSource).toBe("subscription");
    expect(granted.account.includedRuns).toBe(12);
    expect(granted.account.creditsUSD).toBe(3);
    // Coverage honored while unexpired, falls back at expiry.
    const rows = await subs.listSubscriptions("u1");
    expect(resolveEffectiveTier(granted.account, rows, NOW)).toBe("Subscribed");
    expect(resolveEffectiveTier(granted.account, rows, NOW + 30 * MS_PER_DAY + 1)).toBe("PayPerUse");
  });

  it("stacks a re-grant from the latest paid-through instant", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Free", includedRuns: 0 });
    const plan = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 5 });
    await grantSubscription({ subs, store, userId: "u1", plan, grantedBy: "op1", nowMs: NOW });
    const second = await grantSubscription({ subs, store, userId: "u1", plan, grantedBy: "op1", nowMs: NOW + 5 * MS_PER_DAY });
    expect(second.subscription.periodStartMs).toBe(NOW + 30 * MS_PER_DAY);
    expect(second.subscription.periodEndMs).toBe(NOW + 60 * MS_PER_DAY);
    expect(second.account.includedRuns).toBe(10);
  });

  it("refuses inactive plans and users with no account row", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const plan = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 5 });
    await subs.deactivatePlan("pro");
    await expect(
      grantSubscription({ subs, store, userId: "u1", plan: { ...plan, active: false }, grantedBy: "op1", nowMs: NOW }),
    ).rejects.toThrow(/not active/);
    const live = await subs.createPlan({ id: "live", name: "Live", priceUSD: 5, periodDays: 7, includedRuns: 0 });
    // No account row: there is no tenant to pin the row to, so the
    // grant fails closed instead of inventing one. The operator
    // creates the account first (existing Accounts UI flow).
    await expect(
      grantSubscription({ subs, store, userId: "u1", plan: live, grantedBy: "op1", nowMs: NOW }),
    ).rejects.toThrow(/No commercial account/);
    expect(await subs.listSubscriptions("u1")).toEqual([]);
  });
});

describe("POST /payments/agentic/commercial/subscription/grant (route)", () => {
  it("operator grants; non-operator and anonymous cannot", async () => {
    const { ctx } = await setup();
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    await createAccount(ctx, "u1", "t1");
    // Operator-only route: no login and non-operator both refuse (403, the same shape as the credits-adjust route).
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", null, { userId: "u1", planId: plan.id }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "u1", { userId: "u1", planId: plan.id }))?.status).toBe(403);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { userId: "u1", planId: plan.id });
    expect(res?.status).toBe(200);
    const granted = await bodyOf(res);
    expect(granted.subscription.planId).toBe(plan.id);
    expect(granted.subscription.tenantId).toBe("t1");
    expect(granted.subscription.provider).toBe("operator");
    expect(granted.subscription.providerPaymentRef).toMatch(/^grant-/);
    expect(granted.subscription.stripeSessionId).toBeNull();
    expect(granted.subscription.stripePaymentIntentId).toBeNull();
    expect(granted.subscription.periodEndMs).toBeGreaterThan(granted.subscription.periodStartMs);
    expect(granted.account.includedRuns).toBe(12);
    expect(granted.account.tierSource).toBe("subscription");
    expect(granted.effectiveTier).toBe("Subscribed");
    expect((ctx.audit as any).mock.calls.some(([t]: [string]) => t === "commercial.subscription.granted")).toBe(true);
    const auditCall = (ctx.audit as any).mock.calls.find(([t]: [string]) => t === "commercial.subscription.granted");
    expect(auditCall[2].grantedBy).toBe("op1");
    expect(auditCall[2].planId).toBe(plan.id);
    expect(auditCall[2].previousEffectiveTier).toBe("Free");
    expect(auditCall[2].newEffectiveTier).toBe("Subscribed");
  });

  it("ignores a client-supplied tenantId; the row takes the account tenant", async () => {
    const { ctx } = await setup();
    const plan = await createPlan(ctx, { name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 1 });
    await createAccount(ctx, "u1", "t-real");
    const res = await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", {
      userId: "u1",
      planId: plan.id,
      tenantId: "t-spoofed",
    });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).subscription.tenantId).toBe("t-real");
  });

  it("rejects unknown plans, inactive plans, and users with no account", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { userId: "u1", planId: "missing" }))?.status).toBe(404);
    const plan = await createPlan(ctx, { name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    await createAccount(ctx, "u1", "t1");
    const off = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/plans/deactivate", "op1", { planId: plan.id }));
    expect(off.plan.active).toBe(false);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { userId: "u1", planId: plan.id }))?.status).toBe(409);
    const live = await createPlan(ctx, { name: "Live", priceUSD: 5, periodDays: 7, includedRuns: 0 });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { userId: "u-no-account", planId: live.id }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { planId: live.id }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", { userId: "u1" }))?.status).toBe(400);
  });
});
