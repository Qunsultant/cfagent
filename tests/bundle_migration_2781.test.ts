/**
 * Issue #2781 (Monetization Phase 2.15) — migration 0053.
 *
 * Per-feature migration test: asserts only this migration's
 * registration (position-independent containment, never "latest")
 * and its own DDL/schema parity, per the registry ownership rule
 * (tests/migration_registry.test.ts, #3189). Number 0053: 0051/0052
 * are reserved for #3263 (settled assignment, 2026-11-06).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableName, isTable } from "drizzle-orm";
import {
  MIGRATION_0053_PRODUCT_BUNDLES,
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { createD1ProductBundleDb } from "../src/data/d1ProductBundleAdapter";
import * as drizzleSchema from "../src/data/drizzleSchema";

/** Minimal D1Database stand-in over node:sqlite (mirrors tests/product_bundles_2781.test.ts). */
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
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

describe("migration 0053 — commercial product bundles (#2781)", () => {
  it("is registered in ALL_MIGRATIONS (position-independent containment, never 'latest')", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 53);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0053_product_bundles");
    expect(found[0].sql).toContain("agent_product_bundles");
    expect(found[0].sql).toContain("agent_bundle_purchases");
    expect(found[0].sql).toContain("agent_bundle_entitlements");
    expect(found[0].sql).toContain("approval_status");
    expect(found[0].sql).toContain("approved_by");
    expect(found[0].sql).toContain("approved_at_ms");
    expect(found[0].sql).toContain("provider_subscription_id");
  });

  it("creates the three bundle tables on a fresh database, and seeds nothing", async () => {
    const mock = new MockD1Database();
    const db = createD1ProductBundleDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0053_PRODUCT_BUNDLES]);
    for (const table of ["agent_product_bundles", "agent_bundle_purchases", "agent_bundle_entitlements"]) {
      const columns = mock.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.length).toBeGreaterThan(0);
      const count = mock.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(count.n).toBe(0);
    }
    const bundleColumns = (
      mock.sqlite.prepare("PRAGMA table_info(agent_product_bundles)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(bundleColumns).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "member_product_ids",
        "price_usd",
        "period_days",
        "included_runs_per_member",
        "approval_status",
        "approved_by",
        "approved_at_ms",
        "active",
      ]),
    );
    const purchaseColumns = (
      mock.sqlite.prepare("PRAGMA table_info(agent_bundle_purchases)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(purchaseColumns).toEqual(
      expect.arrayContaining(["id", "user_id", "tenant_id", "bundle_id", "provider_payment_ref", "provider_subscription_id", "status"]),
    );
    // The provider subscription id is UNIQUE — the replay guard.
    const purchaseIndexes = mock.sqlite
      .prepare("PRAGMA index_list(agent_bundle_purchases)")
      .all() as Array<{ name: string; unique: number }>;
    const uniqueIndexes = purchaseIndexes.filter((i) => i.unique === 1).map((i) => i.name);
    expect(uniqueIndexes.length).toBeGreaterThan(0);
    const entitlementColumns = (
      mock.sqlite.prepare("PRAGMA table_info(agent_bundle_entitlements)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(entitlementColumns).toEqual(
      expect.arrayContaining(["id", "bundle_purchase_id", "user_id", "tenant_id", "product_id", "included_runs", "status"]),
    );
  });

  it("drizzle schema maps the three bundle tables (DDL/schema parity)", () => {
    const tables = Object.values(drizzleSchema).filter(isTable);
    for (const name of ["agent_product_bundles", "agent_bundle_purchases", "agent_bundle_entitlements"]) {
      const found = tables.find((t) => getTableName(t) === name);
      expect(found).toBeDefined();
    }
    const bundles = tables.find((t) => getTableName(t) === "agent_product_bundles") as unknown as Record<string, { name: string }>;
    expect(bundles.approvalStatus.name).toBe("approval_status");
    expect(bundles.approvedBy.name).toBe("approved_by");
    expect(bundles.approvedAtMs.name).toBe("approved_at_ms");
    expect(bundles.memberProductIds.name).toBe("member_product_ids");
    const purchases = tables.find((t) => getTableName(t) === "agent_bundle_purchases") as unknown as Record<string, { name: string }>;
    expect(purchases.providerSubscriptionId.name).toBe("provider_subscription_id");
    expect(purchases.providerPaymentRef.name).toBe("provider_payment_ref");
  });
});
