/**
 * Issue #2202 (sub-issue of #2020, implementation of design
 * #2145) — Billing port contract + service behaviour.
 *
 * Run against BOTH billing adapters (Stripe adapter over a
 * fake client + in-memory adapter) and BOTH policy stores
 * (in-memory + real Drizzle over MockD1Database with
 * migrations 0007 + 0008 + 0013 + 0014 applied), plus the
 * Stripe strategy's REST mapping via a fetch stub, plus
 * the existing Stripe HMAC webhook verifier (good
 * signature verifies, bad signature is rejected and the
 * service never applies it).
 *
 * No live Stripe call, no flag enablement, no fund
 * movement: every provider interaction here is a fake or
 * a stubbed fetch.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createD1CommercialDb, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { createD1SubscriptionDb, D1SubscriptionAdapter, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { MS_PER_DAY, type SubscriptionStore } from "../src/data/subscriptionPorts";
import { createD1BillingPolicyDb, D1BillingPolicyAdapter, ensureBillingPolicySchema } from "../src/data/d1BillingPolicyAdapter";
import { InMemoryBillingPolicyAdapter } from "../src/data/inMemoryBillingPolicyAdapter";
import type { BillingPolicyStore } from "../src/data/billingPolicyPorts";
import { StripeBillingAdapter } from "../src/services/stripeBillingAdapter";
import { InMemoryBillingAdapter } from "../src/services/inMemoryBillingAdapter";
import { createBillingPorts } from "../src/services/createBillingPorts";
import {
  applyBillingWebhookEvent,
  billingAccessFor,
  cancelBillingAtPeriodEnd,
  cancelBillingImmediately,
  createBillingSubscription,
  isBillingManaged,
  nextDunningNoticeMs,
} from "../src/services/billingService";
import type { BillingPort, ProviderSubscription } from "../src/services/billingPorts";
import { StripePaymentStrategy } from "../src/patterns/paymentStrategies";
import { PaymentGatewayService } from "../src/services/payments";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { activateSubscription } from "../src/services/subscriptionActivation";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import type { Env } from "../src/types";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors the subscription port test). */
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

const NOW = 1_800_000_000_000;

async function policyStores(): Promise<Array<{ name: string; store: BillingPolicyStore }>> {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  return [
    { name: "in-memory-policy", store: new InMemoryBillingPolicyAdapter() },
    { name: "drizzle-policy", store: new D1BillingPolicyAdapter(policyDb) },
  ];
}

async function subscriptionStores(): Promise<Array<{ name: string; subs: SubscriptionStore }>> {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const db = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(db);
  return [
    { name: "in-memory-subs", subs: new InMemorySubscriptionAdapter() },
    { name: "drizzle-subs", subs: new D1SubscriptionAdapter(db) },
  ];
}

/** Fake Stripe client with the same shape the production service satisfies. */
function fakeClient() {
  const subs = new Map<string, ProviderSubscription>();
  let counter = 0;
  const client = {
    async createProviderSubscription(input: { customerId: string; priceId: string }) {
      const record: ProviderSubscription = {
        providerSubscriptionId: `sub_fake_${++counter}`,
        status: "active",
        currentPeriodStartMs: NOW,
        currentPeriodEndMs: NOW + 30 * MS_PER_DAY,
        cancelAtPeriodEnd: false,
        canceledAtMs: null,
        customerId: input.customerId,
        priceId: input.priceId,
      };
      subs.set(record.providerSubscriptionId, record);
      return { ...record };
    },
    async retrieveProviderSubscription(id: string) {
      const found = subs.get(id);
      if (!found) throw new Error(`No provider subscription ${id}.`);
      return { ...found };
    },
    async cancelProviderAtPeriodEnd(id: string) {
      const found = subs.get(id);
      if (!found) throw new Error(`No provider subscription ${id}.`);
      const updated = { ...found, cancelAtPeriodEnd: true };
      subs.set(id, updated);
      return { ...updated };
    },
    async cancelProviderImmediately(id: string) {
      const found = subs.get(id);
      if (!found) throw new Error(`No provider subscription ${id}.`);
      const updated = { ...found, status: "canceled", canceledAtMs: NOW, currentPeriodEndMs: NOW };
      subs.set(id, updated);
      return { ...updated };
    },
  };
  return client;
}

describe("billing port contract (Stripe fake + in-memory)", () => {
  it("creates, retrieves, cancels at period end, and cancels immediately", async () => {
    const adapters: Array<{ name: string; billing: BillingPort }> = [
      { name: "stripe-fake", billing: new StripeBillingAdapter(fakeClient()) },
      { name: "in-memory", billing: new InMemoryBillingAdapter(() => NOW) },
    ];
    for (const { billing } of adapters) {
      await expect(billing.createProviderSubscription({ customerId: "", priceId: "price_1" })).rejects.toThrow(/customerId/);
      await expect(billing.createProviderSubscription({ customerId: "cus_1", priceId: "" })).rejects.toThrow(/priceId/);
      const created = await billing.createProviderSubscription({ customerId: "cus_1", priceId: "price_1" });
      expect(created.status).toBe("active");
      expect(created.currentPeriodEndMs).toBeGreaterThan(created.currentPeriodStartMs as number);
      expect((await billing.retrieveProviderSubscription(created.providerSubscriptionId)).status).toBe("active");
      const atEnd = await billing.cancelProviderAtPeriodEnd(created.providerSubscriptionId);
      expect(atEnd.cancelAtPeriodEnd).toBe(true);
      const gone = await billing.cancelProviderImmediately(created.providerSubscriptionId);
      expect(gone.status).toBe("canceled");
      await expect(billing.retrieveProviderSubscription("sub_missing")).rejects.toThrow(/No provider subscription/);
    }
  });
});

describe("billing policy store contract (in-memory + Drizzle)", () => {
  it("seeds the proposed defaults, persists operator edits, and never overwrites edits on re-ensure", async () => {
    for (const { store } of await policyStores()) {
      const seeded = await store.getPolicy();
      expect(seeded.billingPeriodDefault).toBe("monthly");
      expect(seeded.billingPeriodsAllowed).toEqual(["monthly", "annual"]);
      expect(seeded.dunningRetryDelayDays).toEqual([1, 3, 7]);
      expect(seeded.gracePeriodDays).toBe(7);
      expect(seeded.downgradeTiming).toBe("period_end");
      expect(seeded.prorationBehavior).toBe("create_prorations");
      expect(seeded.repurchaseMigration).toBe("grandfather");
      expect(seeded.stripePriceByPlan).toEqual({});
      // Issue #3262: top-up limits are operator data with PROPOSED
      // seeds (owner-decided 2026-11-06: min $1, max $500).
      expect(seeded.topUpMinUSD).toBe(1);
      expect(seeded.topUpMaxUSD).toBe(500);
      const updated = await store.updatePolicy({ gracePeriodDays: 3, downgradeTiming: "immediate" });
      expect(updated.gracePeriodDays).toBe(3);
      expect(updated.downgradeTiming).toBe("immediate");
      expect((await store.getPolicy()).gracePeriodDays).toBe(3);
      await expect(store.updatePolicy({ gracePeriodDays: -1 } as never)).rejects.toThrow(/gracePeriodDays/);
      await expect(store.updatePolicy({ downgradeTiming: "someday" } as never)).rejects.toThrow(/downgradeTiming/);
      const limits = await store.updatePolicy({ topUpMinUSD: 5, topUpMaxUSD: 100 });
      expect(limits.topUpMinUSD).toBe(5);
      expect(limits.topUpMaxUSD).toBe(100);
      await expect(store.updatePolicy({ topUpMinUSD: 0 } as never)).rejects.toThrow(/topUpMinUSD/);
      await expect(store.updatePolicy({ topUpMaxUSD: -1 } as never)).rejects.toThrow(/topUpMaxUSD/);
      await expect(store.updatePolicy({ topUpMinUSD: 200, topUpMaxUSD: 100 } as never)).rejects.toThrow(
        /topUpMinUSD.*topUpMaxUSD|min.*max/,
      );
    }
    // D1-only: re-ensure after an operator edit keeps the edit (INSERT OR IGNORE seeding).
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subDb);
    const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
    await ensureBillingPolicySchema(policyDb);
    const adapter = new D1BillingPolicyAdapter(policyDb);
    await adapter.updatePolicy({ gracePeriodDays: 14 });
    await ensureBillingPolicySchema(policyDb);
    expect((await adapter.getPolicy()).gracePeriodDays).toBe(14);
  });
});

describe("subscription record provider fields (in-memory + Drizzle)", () => {
  it("round-trips provider id/status and supports the webhook lookup + patch", async () => {
    for (const { subs } of await subscriptionStores()) {
      const repurchase = await subs.createSubscription({
        id: "r1", userId: "u1", tenantId: "t1", planId: "pro", provider: "stripe",
        providerPaymentRef: "sub-ref-1", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
      });
      expect(repurchase.providerSubscriptionId).toBeNull();
      expect(repurchase.providerStatus).toBeNull();
      expect(isBillingManaged(repurchase)).toBe(false);
      expect(await subs.findByProviderSubscriptionId("")).toBeNull();
      expect(await subs.findByProviderSubscriptionId("sub_nope")).toBeNull();
      const billing = await subs.createSubscription({
        id: "b1", userId: "u1", tenantId: "t1", planId: "pro", provider: "stripe",
        providerPaymentRef: "sub_fake_1", providerSubscriptionId: "sub_fake_1", providerStatus: "active",
        periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
      });
      expect(isBillingManaged(billing)).toBe(true);
      expect((await subs.findByProviderSubscriptionId("sub_fake_1"))?.id).toBe("b1");
      const patched = await subs.updateProviderBilling("b1", { providerStatus: "past_due" });
      expect(patched.providerStatus).toBe("past_due");
      expect(patched.status).toBe("active");
      await expect(subs.updateProviderBilling("missing", { providerStatus: "active" })).rejects.toThrow(/No subscription/);
    }
  });
});

async function freshBillingPair(kind: "memory" | "drizzle"): Promise<{ policyStore: BillingPolicyStore; subs: SubscriptionStore }> {
  if (kind === "memory") {
    return { policyStore: new InMemoryBillingPolicyAdapter(), subs: new InMemorySubscriptionAdapter() };
  }
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  return { policyStore: new D1BillingPolicyAdapter(policyDb), subs: new D1SubscriptionAdapter(subDb) };
}

describe("billing service: create, externalized defaults, and grandfather", () => {
  it("refuses an unmapped plan, honours an operator-mapped price, and never touches repurchase rows", async () => {
    for (const kind of ["memory", "drizzle"] as const) {
      {
        const { policyStore, subs } = await freshBillingPair(kind);
        const billing = new InMemoryBillingAdapter(() => NOW);
        // A repurchase row exists first and must survive untouched.
        await subs.createSubscription({
          id: "rep1", userId: "u1", tenantId: "t1", planId: "pro", provider: "stripe",
          providerPaymentRef: "sub-old", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
        });
        await expect(
          createBillingSubscription({ billing, policyStore, subs, userId: "u1", tenantId: "t1", plan: { id: "pro" }, stripeCustomerId: "cus_1", nowMs: NOW }),
        ).rejects.toThrow(/No operator-mapped Stripe Price/);
        await policyStore.updatePolicy({ stripePriceByPlan: { pro: "price_pro_monthly" } });
        // A disallowed period refuses even with a mapped price.
        await expect(
          createBillingSubscription({ billing, policyStore, subs, userId: "u1", tenantId: "t1", plan: { id: "pro" }, stripeCustomerId: "cus_1", billingPeriod: "weekly", nowMs: NOW }),
        ).rejects.toThrow(/not in the allowed periods/);
        const { subscription, provider } = await createBillingSubscription({
          billing, policyStore, subs, userId: "u1", tenantId: "t1", plan: { id: "pro" }, stripeCustomerId: "cus_1", nowMs: NOW,
        });
        expect(subscription.providerSubscriptionId).toBe(provider.providerSubscriptionId);
        expect(subscription.providerStatus).toBe("active");
        expect(subscription.periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
        // The repurchase row is byte-for-byte untouched (same id, same period, still non-Billing).
        const repurchase = await subs.getSubscription("rep1");
        expect(repurchase?.providerSubscriptionId).toBeNull();
        expect(repurchase?.periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
        // A non-grandfather migration policy refuses instead of migrating anything.
        await policyStore.updatePolicy({ repurchaseMigration: "migrate" });
        await expect(
          createBillingSubscription({ billing, policyStore, subs, userId: "u1", tenantId: "t1", plan: { id: "pro" }, stripeCustomerId: "cus_1", nowMs: NOW }),
        ).rejects.toThrow(/only "grandfather" is implemented/);
        await policyStore.updatePolicy({ repurchaseMigration: "grandfather" });
      }
    }
  });

  it("flag-OFF composition returns null and the repurchase path is unchanged", async () => {
    expect(createBillingPorts({ STRIPE_SECRET_KEY: "sk_test_mock" }, false)).toBeNull();
    expect(createBillingPorts({}, true)).toBeNull();
    expect(createBillingPorts({ STRIPE_SECRET_KEY: "sk_test_mock" }, true)).not.toBeNull();
    // Repurchase activation (the live behaviour) still works with the new record fields present.
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const created = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    // Issue #3289: purchase activation validates approved+active.
    await subs.approvePlan(created.id, "test-operator");
    const plan = (await subs.getPlan(created.id))!;
    const { subscription } = await activateSubscription({
      subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-rep-1", nowMs: NOW,
    });
    expect(subscription.providerSubscriptionId).toBeNull();
    expect(subscription.status).toBe("active");
  });
});

describe("billing service: webhook transitions and access", () => {
  async function billingRow() {
    const subs = new InMemorySubscriptionAdapter();
    const policyStore = new InMemoryBillingPolicyAdapter();
    const billing = new InMemoryBillingAdapter(() => NOW);
    const provider = await billing.createProviderSubscription({ customerId: "cus_1", priceId: "price_1" });
    const row = await subs.createSubscription({
      id: "b1", userId: "u1", tenantId: "t1", planId: "pro", provider: "stripe",
      providerPaymentRef: provider.providerSubscriptionId, providerSubscriptionId: provider.providerSubscriptionId,
      providerStatus: "active", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
    });
    return { subs, policyStore, billing, provider, row };
  }

  it("rejects unverified webhooks without touching state", async () => {
    const { subs, policyStore, provider } = await billingRow();
    const policy = await policyStore.getPolicy();
    await expect(
      applyBillingWebhookEvent({
        verified: false,
        event: { type: "customer.subscription.deleted", providerSubscriptionId: provider.providerSubscriptionId, provider: null },
        subs, policy, nowMs: NOW,
      }),
    ).rejects.toThrow(/unverified/);
    expect((await subs.getSubscription("b1"))?.providerStatus).toBe("active");
    expect((await subs.getSubscription("b1"))?.status).toBe("active");
  });

  it("renewal, cancellation (period-end vs immediate), and failure/grace transitions", async () => {
    const { subs, policyStore, provider } = await billingRow();
    const policy = await policyStore.getPolicy();
    // Unknown provider id: not applied, no error (Stripe must not retry forever).
    const unknown = await applyBillingWebhookEvent({
      verified: true,
      event: { type: "customer.subscription.updated", providerSubscriptionId: "sub_nope", provider: null },
      subs, policy, nowMs: NOW,
    });
    expect(unknown).toEqual({ applied: false, reason: "unknown_provider_subscription" });
    // Unknown event type: ignored.
    const ignored = await applyBillingWebhookEvent({
      verified: true,
      event: { type: "charge.refunded", providerSubscriptionId: provider.providerSubscriptionId, provider: null },
      subs, policy, nowMs: NOW,
    });
    expect(ignored.applied).toBe(false);
    // Renewal: updated with a later period extends the row.
    const renewed = await applyBillingWebhookEvent({
      verified: true,
      event: {
        type: "customer.subscription.updated",
        providerSubscriptionId: provider.providerSubscriptionId,
        provider: { ...provider, currentPeriodStartMs: NOW + 30 * MS_PER_DAY, currentPeriodEndMs: NOW + 60 * MS_PER_DAY },
      },
      subs, policy, nowMs: NOW + 30 * MS_PER_DAY,
    });
    expect(renewed.applied).toBe(true);
    expect(renewed.subscription?.periodEndMs).toBe(NOW + 60 * MS_PER_DAY);
    // Failure: past_due keeps grace access, then loses it after grace.
    const failed = await applyBillingWebhookEvent({
      verified: true,
      event: { type: "invoice.payment_failed", providerSubscriptionId: provider.providerSubscriptionId, provider: null },
      subs, policy, nowMs: NOW + 60 * MS_PER_DAY,
    });
    expect(failed.subscription?.providerStatus).toBe("past_due");
    const graceRow = failed.subscription as NonNullable<typeof failed.subscription>;
    expect(billingAccessFor(graceRow, policy, NOW + 60 * MS_PER_DAY)).toBe("grace");
    expect(billingAccessFor(graceRow, policy, NOW + 60 * MS_PER_DAY + 8 * MS_PER_DAY)).toBe("none");
    // Paid again: back to active.
    const paid = await applyBillingWebhookEvent({
      verified: true,
      event: { type: "invoice.paid", providerSubscriptionId: provider.providerSubscriptionId, provider: null },
      subs, policy, nowMs: NOW + 60 * MS_PER_DAY,
    });
    expect(paid.subscription?.providerStatus).toBe("active");
    expect(billingAccessFor(paid.subscription as never, policy, NOW + 60 * MS_PER_DAY)).toBe("full");
    // Cancel at period end via updated: local canceled, access kept to period end.
    const atEnd = await applyBillingWebhookEvent({
      verified: true,
      event: {
        type: "customer.subscription.updated",
        providerSubscriptionId: provider.providerSubscriptionId,
        provider: { ...provider, cancelAtPeriodEnd: true, currentPeriodEndMs: NOW + 60 * MS_PER_DAY },
      },
      subs, policy, nowMs: NOW + 60 * MS_PER_DAY,
    });
    expect(atEnd.subscription?.status).toBe("canceled");
    expect(billingAccessFor(atEnd.subscription as never, policy, NOW + 60 * MS_PER_DAY)).toBe("full");
    // Deleted with period_end policy: period end kept.
    const deleted = await applyBillingWebhookEvent({
      verified: true,
      event: {
        type: "customer.subscription.deleted",
        providerSubscriptionId: provider.providerSubscriptionId,
        provider: { ...provider, status: "canceled", canceledAtMs: NOW + 60 * MS_PER_DAY, currentPeriodEndMs: NOW + 60 * MS_PER_DAY },
      },
      subs, policy, nowMs: NOW + 60 * MS_PER_DAY,
    });
    expect(deleted.subscription?.periodEndMs).toBe(NOW + 60 * MS_PER_DAY);
    // Deleted with immediate policy: period truncated at now.
    const second = await billingRow();
    const immediatePolicy = await second.policyStore.updatePolicy({ downgradeTiming: "immediate" });
    const deletedImmediate = await applyBillingWebhookEvent({
      verified: true,
      event: {
        type: "customer.subscription.deleted",
        providerSubscriptionId: second.provider.providerSubscriptionId,
        provider: { ...second.provider, status: "canceled", canceledAtMs: NOW + 5 * MS_PER_DAY, currentPeriodEndMs: NOW + 30 * MS_PER_DAY },
      },
      subs: second.subs, policy: immediatePolicy, nowMs: NOW + 5 * MS_PER_DAY,
    });
    expect(deletedImmediate.subscription?.periodEndMs).toBe(NOW + 5 * MS_PER_DAY);
    expect(billingAccessFor(deletedImmediate.subscription as never, immediatePolicy, NOW + 5 * MS_PER_DAY)).toBe("none");
  });

  it("cancel service paths refuse repurchase rows and honour the provider", async () => {
    const { subs, billing, provider } = await billingRow();
    await subs.createSubscription({
      id: "rep", userId: "u2", tenantId: "t1", planId: "pro", provider: "stripe",
      providerPaymentRef: "sub-rep-x", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
    });
    await expect(cancelBillingAtPeriodEnd({ billing, subs, subscriptionId: "rep" })).rejects.toThrow(/repurchase/);
    await expect(cancelBillingImmediately({ billing, subs, subscriptionId: "rep", nowMs: NOW })).rejects.toThrow(/repurchase/);
    const atEnd = await cancelBillingAtPeriodEnd({ billing, subs, subscriptionId: "b1" });
    expect(atEnd.status).toBe("canceled");
    expect(atEnd.periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
    const gone = await cancelBillingImmediately({ billing, subs, subscriptionId: "b1", nowMs: NOW + MS_PER_DAY });
    expect(gone.status).toBe("canceled");
    expect(gone.providerStatus).toBe("canceled");
  });

  it("dunning schedule follows operator data, not code", async () => {
    const policyStore = new InMemoryBillingPolicyAdapter();
    const policy = await policyStore.getPolicy();
    expect(nextDunningNoticeMs(policy, NOW, 0)).toBe(NOW + 1 * MS_PER_DAY);
    expect(nextDunningNoticeMs(policy, NOW, 2)).toBe(NOW + 7 * MS_PER_DAY);
    expect(nextDunningNoticeMs(policy, NOW, 3)).toBeNull();
    const changed = await policyStore.updatePolicy({ dunningRetryDelayDays: [2] });
    expect(nextDunningNoticeMs(changed, NOW, 0)).toBe(NOW + 2 * MS_PER_DAY);
    expect(nextDunningNoticeMs(changed, NOW, 1)).toBeNull();
  });
});

describe("stripe strategy billing REST mapping (fetch stub)", () => {
  const strategy = new StripePaymentStrategy();
  const env = { STRIPE_SECRET_KEY: "sk_test_mock" } as Env;
  const stripeSub = {
    id: "sub_123",
    status: "active",
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    cancel_at_period_end: false,
    canceled_at: null,
    customer: "cus_123",
    items: { data: [{ price: { id: "price_123" } }] },
  };

  it("maps create/retrieve/update/cancel to the verified endpoints and converts seconds to ms", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const stub = vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams }) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body ? String(init.body) : "" });
      return { ok: true, json: async () => stripeSub } as never;
    });
    vi.stubGlobal("fetch", stub);
    try {
      const created = await strategy.createProviderSubscription(env, { customerId: "cus_123", priceId: "price_123" });
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions");
      expect(calls[0].body).toContain("customer=cus_123");
      expect(calls[0].body).toContain("items%5B0%5D%5Bprice%5D=price_123");
      expect(created.providerSubscriptionId).toBe("sub_123");
      expect(created.currentPeriodStartMs).toBe(1700000000 * 1000);
      expect(created.currentPeriodEndMs).toBe(1702592000 * 1000);
      expect(created.priceId).toBe("price_123");
      await strategy.retrieveProviderSubscription(env, "sub_123");
      expect(calls[1].method).toBe("GET");
      expect(calls[1].url).toBe("https://api.stripe.com/v1/subscriptions/sub_123");
      await strategy.cancelProviderAtPeriodEnd(env, "sub_123");
      expect(calls[2].method).toBe("POST");
      expect(calls[2].body).toContain("cancel_at_period_end=true");
      await strategy.cancelProviderImmediately(env, "sub_123");
      expect(calls[3].method).toBe("DELETE");
      expect(calls[3].url).toBe("https://api.stripe.com/v1/subscriptions/sub_123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the first item period and throws on provider errors or missing config", async () => {
    const itemOnly = {
      ...stripeSub,
      current_period_start: undefined,
      current_period_end: undefined,
      items: { data: [{ price: { id: "price_123" }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => itemOnly }) as never));
    try {
      const parsed = await strategy.retrieveProviderSubscription(env, "sub_123");
      expect(parsed.currentPeriodStartMs).toBe(1700000000 * 1000);
      expect(parsed.currentPeriodEndMs).toBe(1702592000 * 1000);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 402, statusText: "Payment Required", json: async () => ({ error: { message: "card declined" } }) }) as never));
    try {
      await expect(strategy.retrieveProviderSubscription(env, "sub_123")).rejects.toThrow(/402/);
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(strategy.retrieveProviderSubscription({} as Env, "sub_123")).rejects.toThrow(/not configured/);
  });
});

describe("billing webhook signature verification (existing Stripe HMAC verifier)", () => {
  it("a genuinely signed payload verifies; a tampered signature is rejected and never applied", async () => {
    const secret = "whsec_test_billing";
    const body = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_123" } } });
    const ts = Math.floor(Date.now() / 1000);
    const good = `t=${ts},v1=${await computeHmacSha256Hex(secret, `${ts}.${body}`)}`;
    const service = new PaymentGatewayService({ STRIPE_WEBHOOK_SECRET: secret } as Env);
    const ok = await service.verifyWebhookSignature("stripe", body, new Headers({ "stripe-signature": good }));
    expect(ok.isValid).toBe(true);
    const bad = await service.verifyWebhookSignature("stripe", body, new Headers({ "stripe-signature": `t=${ts},v1=deadbeef` }));
    expect(bad.isValid).toBe(false);
    // The service applier is the second gate: even a caller that forgot to check must pass verified=true explicitly.
    const subs = new InMemorySubscriptionAdapter();
    const policy = await new InMemoryBillingPolicyAdapter().getPolicy();
    await expect(
      applyBillingWebhookEvent({
        verified: bad.isValid,
        event: { type: "customer.subscription.deleted", providerSubscriptionId: "sub_123", provider: null },
        subs, policy, nowMs: NOW,
      }),
    ).rejects.toThrow(/unverified/);
  });
});
