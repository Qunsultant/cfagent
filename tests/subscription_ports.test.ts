/**
 * Issues #2020/#2127 — subscription port contract, run against
 * BOTH adapters (in-memory + real Drizzle over MockD1Database
 * with migration 0008 applied). The two implementations must
 * not drift: plan validation, replay guard, cancel semantics,
 * stacking, and the effective-tier matrix are asserted identically.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1CommercialDb, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { createD1SubscriptionDb, D1SubscriptionAdapter, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  MS_PER_DAY,
  nextPeriodStartMs,
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../src/data/subscriptionPorts";
import { activateSubscription } from "../src/services/subscriptionActivation";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";

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

async function adapters(): Promise<Array<{ name: string; subs: SubscriptionStore }>> {
  const mock = new MockD1Database();
  // Migration 0008 alters the accounts table, so it applies
  // after 0007 — the same order the money routes ensure at
  // runtime. (0008 alone on a fresh DB fails its ALTER.)
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const db = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(db);
  return [
    { name: "in-memory", subs: new InMemorySubscriptionAdapter() },
    { name: "drizzle", subs: new D1SubscriptionAdapter(db) },
  ];
}

const NOW = 1_800_000_000_000;

describe("subscription port contract", () => {
  it("rejects invalid plans", async () => {
    for (const { subs } of await adapters()) {
      await expect(subs.createPlan({ name: "", priceUSD: 10, periodDays: 30, includedRuns: 0 })).rejects.toThrow(/name/);
      await expect(subs.createPlan({ name: "P", priceUSD: 0, periodDays: 30, includedRuns: 0 })).rejects.toThrow(/priceUSD/);
      await expect(subs.createPlan({ name: "P", priceUSD: 10, periodDays: 0, includedRuns: 0 })).rejects.toThrow(/periodDays/);
      await expect(subs.createPlan({ name: "P", priceUSD: 10, periodDays: 30, includedRuns: -1 })).rejects.toThrow(/includedRuns/);
    }
  });

  it("creates, reads, lists active-only, and deactivates plans", async () => {
    for (const { subs } of await adapters()) {
      const plan = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
      expect(plan.active).toBe(true);
      expect(plan.priceUSD).toBe(20);
      expect((await subs.getPlan("pro"))?.name).toBe("Pro");
      await expect(subs.createPlan({ id: "pro", name: "Dup", priceUSD: 5, periodDays: 7, includedRuns: 0 })).rejects.toThrow(/already exists/);
      await subs.createPlan({ id: "basic", name: "Basic", priceUSD: 5, periodDays: 30, includedRuns: 0 });
      expect((await subs.listPlans(true)).map((p) => p.id).sort()).toEqual(["basic", "pro"]);
      const off = await subs.deactivatePlan("basic");
      expect(off.active).toBe(false);
      expect((await subs.listPlans(true)).map((p) => p.id)).toEqual(["pro"]);
      expect((await subs.listPlans(false)).map((p) => p.id).sort()).toEqual(["basic", "pro"]);
      await expect(subs.deactivatePlan("missing")).rejects.toThrow(/No plan/);
    }
  });

  it("creates subscriptions, enforces the payment-reference replay guard, and cancels unexpired rows only", async () => {
    for (const { subs } of await adapters()) {
      const active = await subs.createSubscription({
        id: "s1", userId: "u1", tenantId: "t1", planId: "pro", provider: "cfpay",
        providerPaymentRef: "sub-ref-1", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
      });
      expect(active.status).toBe("active");
      expect(active.canceledAtMs).toBeNull();
      await expect(
        subs.createSubscription({
          id: "s2", userId: "u1", tenantId: "t1", planId: "pro", provider: "cfpay",
          providerPaymentRef: "sub-ref-1", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
        }),
      ).rejects.toThrow(/already activated/);
      expect((await subs.findByPaymentRef("sub-ref-1"))?.id).toBe("s1");
      await subs.createSubscription({
        id: "s3", userId: "u1", tenantId: "t1", planId: "pro", provider: "cfpay",
        providerPaymentRef: "sub-ref-2", periodStartMs: NOW - 60 * MS_PER_DAY, periodEndMs: NOW - 30 * MS_PER_DAY,
      });
      const canceled = await subs.cancelUnexpiredSubscriptions("u1", NOW);
      expect(canceled.map((s) => s.id)).toEqual(["s1"]);
      expect(canceled[0].status).toBe("canceled");
      expect(canceled[0].canceledAtMs).toBe(NOW);
      expect(canceled[0].periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
      expect(await subs.cancelUnexpiredSubscriptions("u1", NOW)).toEqual([]);
      const rows = await subs.listSubscriptions("u1");
      expect(rows.find((s) => s.id === "s3")?.status).toBe("active");
    }
  });

  it("stores native Stripe session + payment-intent ids, null when absent (#2198)", async () => {
    for (const { subs } of await adapters()) {
      const native = await subs.createSubscription({
        id: "s-native", userId: "u9", tenantId: "t9", planId: "pro", provider: "stripe",
        providerPaymentRef: "sub-native-1", stripeSessionId: "cs_test_1", stripePaymentIntentId: "pi_test_1",
        periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
      });
      expect(native.stripeSessionId).toBe("cs_test_1");
      expect(native.stripePaymentIntentId).toBe("pi_test_1");
      expect((await subs.getSubscription("s-native"))?.stripeSessionId).toBe("cs_test_1");
      expect((await subs.getSubscription("s-native"))?.stripePaymentIntentId).toBe("pi_test_1");
      const legacy = await subs.createSubscription({
        id: "s-legacy", userId: "u9", tenantId: "t9", planId: "pro", provider: "cfpay",
        providerPaymentRef: "sub-legacy-1", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
      });
      expect(legacy.stripeSessionId).toBeNull();
      expect(legacy.stripePaymentIntentId).toBeNull();
    }
  });
});

describe("resolveEffectiveTier", () => {
  const sub = (end: number) => ({ periodEndMs: end });
  it("active subscription confers Subscribed over any stored tier", () => {
    expect(resolveEffectiveTier({ tier: "Free" }, [sub(NOW + 1)], NOW)).toBe("Subscribed");
    expect(resolveEffectiveTier({ tier: "PayPerUse" }, [sub(NOW + 1)], NOW)).toBe("Subscribed");
    expect(resolveEffectiveTier(null, [sub(NOW + 1)], NOW)).toBe("Subscribed");
  });
  it("canceled-before-periodEnd still confers Subscribed (cancel-at-period-end)", () => {
    expect(resolveEffectiveTier({ tier: "Free" }, [sub(NOW + 30 * MS_PER_DAY)], NOW)).toBe("Subscribed");
  });
  it("expired subscription stops conferring; the stored baseline returns", () => {
    expect(resolveEffectiveTier({ tier: "Free" }, [sub(NOW - 1)], NOW)).toBe("Free");
    expect(resolveEffectiveTier({ tier: "PayPerUse" }, [sub(NOW - 1)], NOW)).toBe("PayPerUse");
    expect(resolveEffectiveTier(null, [sub(NOW - 1)], NOW)).toBe("Free");
  });
  it("a subscription-granted stored tier lapses to Free, an operator grant survives", () => {
    expect(resolveEffectiveTier({ tier: "Subscribed", tierSource: "subscription" }, [sub(NOW - 1)], NOW)).toBe("Free");
    expect(resolveEffectiveTier({ tier: "Subscribed", tierSource: "subscription" }, [], NOW)).toBe("Free");
    expect(resolveEffectiveTier({ tier: "Subscribed", tierSource: "operator" }, [sub(NOW - 1)], NOW)).toBe("Subscribed");
    expect(resolveEffectiveTier({ tier: "Subscribed", tierSource: null }, [sub(NOW - 1)], NOW)).toBe("Subscribed");
  });
});

describe("nextPeriodStartMs", () => {
  it("stacks from the latest paid-through instant, never earlier", () => {
    expect(nextPeriodStartMs([], NOW)).toBe(NOW);
    expect(nextPeriodStartMs([NOW - 1000], NOW)).toBe(NOW);
    expect(nextPeriodStartMs([NOW + 5 * MS_PER_DAY], NOW)).toBe(NOW + 5 * MS_PER_DAY);
    expect(nextPeriodStartMs([NOW + 5 * MS_PER_DAY, NOW + 2 * MS_PER_DAY], NOW)).toBe(NOW + 5 * MS_PER_DAY);
  });
});

describe("activateSubscription", () => {
  it("activates, stacks, credits included runs, and preserves the baseline tier", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "PayPerUse", creditsUSD: 3, includedRuns: 2 });
    const created = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    // Issue #3289: activation is fail-closed on approval — the
    // fixture plan must be approved, as the operator path would.
    const plan = await subs.approvePlan(created.id, "op");
    const first = await activateSubscription({
      subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-a", nowMs: NOW,
    });
    expect(first.subscription.periodStartMs).toBe(NOW);
    expect(first.subscription.periodEndMs).toBe(NOW + 30 * MS_PER_DAY);
    expect(first.account.tier).toBe("PayPerUse");
    expect(first.account.tierSource).toBe("subscription");
    expect(first.account.includedRuns).toBe(12);
    expect(first.account.creditsUSD).toBe(3);
    const second = await activateSubscription({
      subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-b", nowMs: NOW + 5 * MS_PER_DAY,
    });
    expect(second.subscription.periodStartMs).toBe(NOW + 30 * MS_PER_DAY);
    expect(second.subscription.periodEndMs).toBe(NOW + 60 * MS_PER_DAY);
    expect(second.account.includedRuns).toBe(22);
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-a", nowMs: NOW }),
    ).rejects.toThrow(/already activated/);
  });

  it("refuses inactive plans, tenant mismatch, and creates missing accounts", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const plan = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 5 });
    await subs.deactivatePlan("pro");
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: { ...plan, active: false }, providerPaymentRef: "sub-x", nowMs: NOW }),
    ).rejects.toThrow(/not active/);
    const createdLive = await subs.createPlan({ id: "live", name: "Live", priceUSD: 5, periodDays: 7, includedRuns: 0 });
    // Issue #3289: approve the fixture plan so the tenant-mismatch
    // check below is reached (approval runs first, fail-closed).
    const live = await subs.approvePlan(createdLive.id, "op");
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Free" });
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t2", plan: live, providerPaymentRef: "sub-y", nowMs: NOW }),
    ).rejects.toThrow(/Tenant mismatch/);
    const fresh = await activateSubscription({ subs, store, userId: "u2", tenantId: "t9", plan: live, providerPaymentRef: "sub-z", nowMs: NOW });
    expect(fresh.account.id).toBe("u2");
    expect(fresh.account.tenantId).toBe("t9");
    expect(fresh.account.tier).toBe("Free");
    expect(fresh.account.tierSource).toBe("subscription");
  });
});
