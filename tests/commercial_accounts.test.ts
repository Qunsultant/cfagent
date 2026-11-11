/**
 * Issues #2015/#2020/#2022 — commercial store port tests.
 *
 * Part A runs the port contract against the in-memory adapter
 * (validation, floors, FIFO redemption). Part B runs the same
 * contract's D1-critical paths against the real Drizzle adapter
 * over a MockD1Database backed by node:sqlite (the pattern from
 * tests/data_foundation_slice0.test.ts) — migrations, CRUD, the
 * oldest-unredeemed join, and the redemption replay guard.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { toCommercialAccount, type CommercialStore } from "../src/data/commercialPorts";

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

async function makeD1Store(): Promise<D1CommercialAdapter> {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  // Migration 0008 alters the accounts table (tier_source), so
  // the commercial mapping requires 0008 applied after 0007 —
  // the same order the money routes ensure at runtime.
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  return new D1CommercialAdapter(db);
}

async function makeStores(): Promise<{ memory: CommercialStore; d1: CommercialStore }> {
  return { memory: new InMemoryCommercialAdapter(), d1: await makeD1Store() };
}

describe("commercial account records (#2015)", () => {
  it("upserts and reads back; rejects bad tiers and negatives", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      const record = await store.upsertAccount({
        userId: "u1",
        tenantId: "t1",
        tier: "Subscribed",
        creditsUSD: 5,
        includedRuns: 3,
      });
      expect(record.tier).toBe("Subscribed");
      expect(await store.getAccount("u1")).toEqual(record);
      await expect(
        store.upsertAccount({ userId: "u2", tenantId: "t1", tier: "Premium" }),
      ).rejects.toThrow(/Invalid tier/);
      await expect(
        store.upsertAccount({ userId: "u2", tenantId: "t1", tier: "Free", creditsUSD: -1 }),
      ).rejects.toThrow(/creditsUSD/);
      await expect(
        store.upsertAccount({ userId: "", tenantId: "t1", tier: "Free" }),
      ).rejects.toThrow(/userId and tenantId/);
    }
  });

  it("adjusts credits with a zero floor and consumes coverage", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "PayPerUse", creditsUSD: 10, includedRuns: 2 });
      expect((await store.adjustCredits("u1", 5)).creditsUSD).toBe(15);
      await expect(store.adjustCredits("u1", -20)).rejects.toThrow(/below zero/);
      expect((await store.consumeIncludedRun("u1")).includedRuns).toBe(1);
      expect((await store.consumeCredits("u1", 0.1)).creditsUSD).toBe(14.9);
      await expect(store.consumeCredits("u1", 100)).rejects.toThrow(/Insufficient credits/);
      await expect(store.adjustCredits("ghost", 1)).rejects.toThrow(/No commercial account/);
      await expect(store.consumeIncludedRun("ghost")).rejects.toThrow(/No commercial account/);
    }
  });

  it("maps a record to the gate account, or a Free default", async () => {
    const { memory } = await makeStores();
    const record = await memory.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 2,
      includedRuns: 4,
    });
    expect(toCommercialAccount("u1", record, "u1@example.com", "t1")).toEqual({
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 2,
      includedRunsRemaining: 4,
      // Issue #3245: no grant on this row reads as null.
      unlimitedFreeGrant: null,
      // Issue #3289: the gate account carries the holder's segment.
      segment: "default",
    });
    expect(toCommercialAccount("u9", null, "u9@example.com", "t9")).toEqual({
      userId: "u9",
      email: "u9@example.com",
      tenantId: "t9",
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
      segment: "default",
    });
  });
});

describe("tenant settings (#2022)", () => {
  it("defaults to ads enabled; set persists", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      expect(await store.getTenantAdsEnabled("t1")).toBe(true);
      await store.setTenantAdsEnabled("t1", false);
      expect(await store.getTenantAdsEnabled("t1")).toBe(false);
      await store.setTenantAdsEnabled("t1", true);
      expect(await store.getTenantAdsEnabled("t1")).toBe(true);
    }
  });
});

describe("tenant auto-refresh setting (#2481)", () => {
  it("defaults to OFF / 15s; set persists and preserves the ads flag", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      expect(await store.getTenantAutoRefresh("t1")).toEqual({ enabled: false, intervalS: 15 });
      await store.setTenantAdsEnabled("t1", false);
      await store.setTenantAutoRefresh("t1", { enabled: true, intervalS: 60 });
      expect(await store.getTenantAutoRefresh("t1")).toEqual({ enabled: true, intervalS: 60 });
      expect(await store.getTenantAdsEnabled("t1")).toBe(false);
      await store.setTenantAdsEnabled("t1", true);
      expect(await store.getTenantAutoRefresh("t1")).toEqual({ enabled: true, intervalS: 60 });
      expect(await store.getTenantAdsEnabled("t1")).toBe(true);
    }
  });

  it("migration 0026 adds the auto-refresh columns to the tenant settings table", async () => {
    const { MIGRATION_0026_TENANT_AUTO_REFRESH } = await import(
      "../src/data/migrationRunner"
    );
    expect(MIGRATION_0026_TENANT_AUTO_REFRESH.version).toBe(26);
    expect(MIGRATION_0026_TENANT_AUTO_REFRESH.sql).toContain("auto_refresh_enabled");
    expect(MIGRATION_0026_TENANT_AUTO_REFRESH.sql).toContain("auto_refresh_interval_s");
  });
});

describe("failure-credit claims and redemption (#2019)", () => {
  async function seed(store: CommercialStore) {
    // Two claims; the older one must win FIFO. createdAtMs differs
    // by insertion order in the D1 adapter (Date.now) and by
    // construction in the in-memory adapter — the test seeds the
    // older claim first and relies on FIFO by created, then id.
    await store.recordCreditClaim({ creditRunId: "run-8", userId: "u1", family: "goal", amountUSD: 0.1 });
    await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
    await store.recordCreditClaim({ creditRunId: "run-7", userId: "u1", family: "options", amountUSD: 0.05 });
  }

  it("finds the oldest unredeemed claim for the family", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      await seed(store);
      expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({ creditRunId: "run-8", amountUSD: 0.1, productId: null, versionId: null, priceUSD: null });
      expect(await store.findUnredeemedCredit("u1", "options")).toEqual({ creditRunId: "run-7", amountUSD: 0.05, productId: null, versionId: null, priceUSD: null });
      expect(await store.findUnredeemedCredit("u2", "goal")).toBeNull();
    }
  });

  it("skips redeemed claims; re-recording a claim is a no-op", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      await seed(store);
      await store.redeemCredit("run-8", "run-10");
      expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({ creditRunId: "run-9", amountUSD: 0.1, productId: null, versionId: null, priceUSD: null });
      await expect(store.redeemCredit("run-8", "run-11")).rejects.toThrow(/already redeemed/);
      const again = await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
      expect(again.creditRunId).toBe("run-9");
      expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({ creditRunId: "run-9", amountUSD: 0.1, productId: null, versionId: null, priceUSD: null });
    }
  });
});
