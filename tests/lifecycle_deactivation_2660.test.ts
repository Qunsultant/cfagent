/**
 * Issue #2660 (monetization Phase 2.5) — self-service deactivation, TDD red-first.
 *
 * Two pure/port pieces of the slice, tested before the route wiring exists:
 * - hasUnexpiredSubscription: the subscription gate's rule — an unexpired
 *   ACTIVE row blocks deactivation; expired or canceled rows do not. Same
 *   rule resolveEffectiveTier uses; no new semantics.
 * - suppressMailForUser: the commercial-plane mail suppression — flips
 *   digestEnabled AND welcomeEnabled off on the user's preference row, so the
 *   scheduled digest pass (which enumerates digestEnabled=1 rows only) stops
 *   reaching a deactivated principal. No-row is a no-op returning null
 *   (defaults are already digest-OFF).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { hasUnexpiredSubscription, type SubscriptionRecord } from "../src/data/subscriptionPorts";
import { D1LifecycleAdapter, createD1LifecycleDb, ensureLifecycleSchema } from "../src/data/d1LifecycleAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import type { LifecycleStore } from "../src/data/lifecyclePorts";
import type { D1Database } from "@cloudflare/workers-types";

/** Minimal D1Database stand-in over node:sqlite (mirrors tests/billing_activation_2656.test.ts). */
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

function subRow(overrides: Partial<SubscriptionRecord>): SubscriptionRecord {
  return {
    id: "sub-1",
    userId: "u1",
    tenantId: "t1",
    planId: "plan-pro",
    provider: "stripe",
    providerPaymentRef: "sub-1",
    stripeSessionId: null,
    stripePaymentIntentId: null,
    providerSubscriptionId: null,
    providerStatus: null,
    status: "active",
    periodStartMs: NOW - 1000,
    periodEndMs: NOW + 30 * 24 * 3600 * 1000,
    canceledAtMs: null,
    createdAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    ...overrides,
  };
}

describe("hasUnexpiredSubscription (#2660)", () => {
  it("blocks on an unexpired active row", () => {
    expect(hasUnexpiredSubscription([subRow({})], NOW)).toBe(true);
  });

  it("does not block on an expired active row", () => {
    expect(hasUnexpiredSubscription([subRow({ periodEndMs: NOW - 1000 })], NOW)).toBe(false);
  });

  it("does not block on a canceled row even when unexpired", () => {
    expect(hasUnexpiredSubscription([subRow({ status: "canceled" })], NOW)).toBe(false);
  });

  it("does not block on an empty row set", () => {
    expect(hasUnexpiredSubscription([], NOW)).toBe(false);
  });

  it("blocks when any row is unexpired and active", () => {
    expect(
      hasUnexpiredSubscription(
        [subRow({ id: "sub-old", periodEndMs: NOW - 1000 }), subRow({ id: "sub-new" })],
        NOW,
      ),
    ).toBe(true);
  });
});

async function makeStores(): Promise<{ stores: Array<{ name: string; store: LifecycleStore }> }> {
  const memory = new InMemoryLifecycleAdapter();
  const mock = new MockD1Database();
  const d1db = createD1LifecycleDb(mock as unknown as D1Database);
  await ensureLifecycleSchema(d1db);
  const d1 = new D1LifecycleAdapter(d1db);
  return { stores: [{ name: "in-memory", store: memory }, { name: "d1", store: d1 }] };
}

describe("suppressMailForUser (#2660)", () => {
  it("flips digest and welcome off on the user's row, leaves others untouched", async () => {
    const { stores } = await makeStores();
    for (const { name, store } of stores) {
      await store.setPreferences({ userId: "target-user", tenantId: "primary", digestEnabled: true, welcomeEnabled: true });
      await store.setPreferences({ userId: "other-user", tenantId: "primary", digestEnabled: true, welcomeEnabled: true });
      const flipped = await store.suppressMailForUser("target-user");
      expect(flipped, name).not.toBeNull();
      expect(flipped!.digestEnabled, name).toBe(false);
      expect(flipped!.welcomeEnabled, name).toBe(false);
      const target = await store.getPreferences("target-user", "primary");
      expect(target.digestEnabled, name).toBe(false);
      expect(target.welcomeEnabled, name).toBe(false);
      const other = await store.getPreferences("other-user", "primary");
      expect(other.digestEnabled, name).toBe(true);
      expect(other.welcomeEnabled, name).toBe(true);
      // The suppressed user drops out of the scheduled pass enumeration.
      const subs = await store.listDigestSubscribers();
      expect(subs.some((s) => s.userId === "target-user"), name).toBe(false);
      expect(subs.some((s) => s.userId === "other-user"), name).toBe(true);
    }
  });

  it("is idempotent and returns null when no row exists", async () => {
    const { stores } = await makeStores();
    for (const { name, store } of stores) {
      expect(await store.suppressMailForUser("nobody"), name).toBeNull();
      await store.setPreferences({ userId: "u", tenantId: "primary", digestEnabled: true, welcomeEnabled: true });
      await store.suppressMailForUser("u");
      const again = await store.suppressMailForUser("u");
      expect(again!.digestEnabled, name).toBe(false);
      expect(again!.welcomeEnabled, name).toBe(false);
    }
  });
});
