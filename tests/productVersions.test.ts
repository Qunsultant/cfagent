/**
 * Product versions (#3289 slice 1): the version model is
 * products-are-identity + versions-are-immutable-terms-snapshots.
 *
 * Covered here, per the design §9:
 * - the pure resolver's rules (max effectiveFromMs ≤ now in the
 *   caller's segment; future / expired / deactivated versions
 *   never picked; no effective version → null; two segments
 *   resolve independently; same-start ties resolve by greatest
 *   version);
 * - store-level resolution on both adapters (catalogue + plans);
 * - held-version grandfathering (a new version moves no one)
 *   and the per-customer move primitive + set-segment primitive;
 * - the gate resolving the effective price for the holder's
 *   segment;
 * - per-charge recording (journal / native ledger / credit claim
 *   carry productId + versionId + priceUSD; legacy null rows
 *   still read);
 * - migration 0058 (registration, empty-store seed, backfill on
 *   existing plan/catalogue rows, duplicate-name versioning,
 *   account segment default, legacy null columns).
 *
 * Nothing here approves a price for production: the approved
 * versions in these tests are test-operator fixtures.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  ALL_MIGRATIONS,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0010_PAID_SUBMISSIONS,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
  MIGRATION_0014_BILLING,
  MIGRATION_0026_TENANT_AUTO_REFRESH,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0028_TENANT_PROVIDERS,
  MIGRATION_0040_UNLIMITED_FREE_GRANT,
  MIGRATION_0041_PLAN_TRIAL_DAYS,
  MIGRATION_0049_PLAN_PRICE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  assertProduct,
  assertProductRank,
  DEFAULT_SEGMENT,
  FREE_PRODUCT_ID,
  resolveEffectiveVersion,
  type VersionLike,
} from "../src/data/productPorts";
import { createD1ProductDb, D1ProductAdapter, ensureProductSchema } from "../src/data/d1ProductAdapter";
import { InMemoryProductAdapter } from "../src/data/inMemoryProductAdapter";
import { createD1SubscriptionDb, D1SubscriptionAdapter, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { createD1PriceCatalogueDb, D1PriceCatalogueAdapter, ensurePriceCatalogueSchema } from "../src/data/d1PriceCatalogueAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { createD1CommercialDb, D1CommercialAdapter, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { createD1JournalDb, D1JournalAdapter, ensureJournalSchema } from "../src/data/d1JournalAdapter";
import { InMemoryJournalAdapter } from "../src/data/inMemoryJournalAdapter";
import { createD1NativeLedgerDb, D1NativeLedgerAdapter, ensureNativeLedgerSchema } from "../src/data/d1NativeLedgerAdapter";
import { InMemoryNativeLedgerAdapter } from "../src/data/inMemoryNativeLedgerAdapter";
import { mapChargeToJournalEntries } from "../src/data/journalPorts";
import { moveSubscriptionToVersion, setAccountSegment } from "../src/services/versionMoves";
import { NativeMonetizationGate } from "../src/services/nativeMonetization";
import type { ProductStore } from "../src/data/productPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { CommercialStore } from "../src/data/commercialPorts";

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

const NOW = 1_800_000_000_000;

function version(over: Partial<VersionLike> & { id: string }): VersionLike {
  return {
    productId: "prod-per-run-goal",
    segment: DEFAULT_SEGMENT,
    version: 1,
    effectiveFromMs: 1000,
    effectiveToMs: null,
    ...over,
  };
}

describe("resolveEffectiveVersion (pure resolver, #3289 §9)", () => {
  it("picks the greatest effectiveFromMs at or before now, in the given segment", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000 }),
      version({ id: "v2", version: 2, effectiveFromMs: 2000 }),
      version({ id: "v3", version: 3, effectiveFromMs: 1500 }),
    ];
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 2500)?.id).toBe("v2");
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 1500)?.id).toBe("v3");
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 1000)?.id).toBe("v1");
  });

  it("a future version is never picked", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000 }),
      version({ id: "v2", version: 2, effectiveFromMs: 9000 }),
    ];
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 5000)?.id).toBe("v1");
    expect(resolveEffectiveVersion([versions[1]], DEFAULT_SEGMENT, 5000)).toBeNull();
  });

  it("an expired version is never picked (effectiveToMs is exclusive)", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000, effectiveToMs: 2000 }),
      version({ id: "v2", version: 2, effectiveFromMs: 2000 }),
    ];
    // At exactly effectiveToMs the old version has ended.
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 2000)?.id).toBe("v2");
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 1999)?.id).toBe("v1");
    expect(resolveEffectiveVersion([versions[0]], DEFAULT_SEGMENT, 2000)).toBeNull();
  });

  it("a deactivated version is never picked", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000, active: false }),
      version({ id: "v2", version: 2, effectiveFromMs: 500, active: true }),
    ];
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 5000)?.id).toBe("v2");
    expect(resolveEffectiveVersion([versions[0]], DEFAULT_SEGMENT, 5000)).toBeNull();
  });

  it("no effective version resolves to null (fail-closed: the gate refuses to charge)", () => {
    expect(resolveEffectiveVersion([], DEFAULT_SEGMENT, NOW)).toBeNull();
    expect(
      resolveEffectiveVersion(
        [version({ id: "v1", version: 1, effectiveFromMs: NOW + 1000 })],
        DEFAULT_SEGMENT,
        NOW,
      ),
    ).toBeNull();
  });

  it("two segments resolve independently; another segment's version is never resolved", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000, segment: DEFAULT_SEGMENT }),
      version({ id: "v2", version: 1, effectiveFromMs: 5000, segment: "eu" }),
    ];
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 9000)?.id).toBe("v1");
    expect(resolveEffectiveVersion(versions, "eu", 9000)?.id).toBe("v2");
    expect(resolveEffectiveVersion(versions, "apac", 9000)).toBeNull();
  });

  it("versions sharing a start instant resolve by greatest version (same-ms creation is a race, not an error)", () => {
    const versions = [
      version({ id: "v1", version: 1, effectiveFromMs: 1000 }),
      version({ id: "v2", version: 2, effectiveFromMs: 1000 }),
    ];
    expect(resolveEffectiveVersion(versions, DEFAULT_SEGMENT, 1000)?.id).toBe("v2");
  });
});

describe("catalogue version resolution on both adapters (#3289 §4)", () => {
  it("effective version per segment; a new version is PROPOSED until approved", async () => {
    const mock = new MockD1Database();
    const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
    await ensurePriceCatalogueSchema(db);
    const makers = [
      { name: "in-memory", catalogue: new InMemoryPriceCatalogueAdapter() },
      { name: "drizzle", catalogue: new D1PriceCatalogueAdapter(db) },
    ];
    for (const { catalogue } of makers) {
      // Seed v1 is PROPOSED: approve it so the store has a
      // chargeable baseline.
      await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
      expect((await catalogue.getEffectiveEntry("goal", DEFAULT_SEGMENT, NOW))?.priceUSD).toBe(0.1);
      // A new version in the default segment is a proposal.
      const v2 = await catalogue.createVersion({ family: "goal", priceUSD: 0.25, effectiveFromMs: NOW });
      expect(v2.version).toBe(2);
      expect(v2.approvalStatus).toBe("proposed");
      expect((await catalogue.getEffectiveEntry("goal", DEFAULT_SEGMENT, NOW))?.priceUSD).toBe(0.25);
      // The default segment is untouched by another segment's version.
      const eu = await catalogue.createVersion({ family: "goal", priceUSD: 0.2, segment: "eu", effectiveFromMs: NOW });
      expect(eu.version).toBe(1);
      expect((await catalogue.getEffectiveEntry("goal", "eu", NOW))?.priceUSD).toBe(0.2);
      expect((await catalogue.getEffectiveEntry("goal", DEFAULT_SEGMENT, NOW))?.priceUSD).toBe(0.25);
      expect(await catalogue.getEffectiveEntry("goal", "apac", NOW)).toBeNull();
      // A future version never resolves early.
      await catalogue.createVersion({ family: "stock", priceUSD: 0.03, effectiveFromMs: NOW + 100_000 });
      expect((await catalogue.getEffectiveEntry("stock", DEFAULT_SEGMENT, NOW))?.priceUSD).toBe(0.02);
    }
  });
});

interface MoveStores {
  products: ProductStore;
  subs: SubscriptionStore;
  store: CommercialStore;
}

async function makeMoveStores(): Promise<Array<{ name: string; stores: MoveStores }>> {
  const mock = new MockD1Database();
  const productDb = createD1ProductDb(mock as unknown as D1Database);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureProductSchema(productDb);
  await ensureSubscriptionSchema(subsDb);
  await ensureCommercialSchema(commercialDb);
  return [
    {
      name: "in-memory",
      stores: {
        products: new InMemoryProductAdapter(),
        subs: new InMemorySubscriptionAdapter(),
        store: new InMemoryCommercialAdapter(),
      },
    },
    {
      name: "drizzle",
      stores: {
        products: new D1ProductAdapter(productDb),
        subs: new D1SubscriptionAdapter(subsDb),
        store: new D1CommercialAdapter(commercialDb),
      },
    },
  ];
}

async function seedHolder(stores: MoveStores) {
  await stores.store.upsertAccount({ userId: "user-1", tenantId: "tenant-a", tier: "Free" });
  const v1 = await stores.subs.createPlan({ name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW - 1000 });
  await stores.subs.approvePlan(v1.id, "test-operator");
  const sub = await stores.subs.createSubscription({
    id: "sub-1",
    userId: "user-1",
    tenantId: "tenant-a",
    planId: v1.id,
    provider: "manual",
    providerPaymentRef: "ref-1",
    periodStartMs: NOW,
    periodEndMs: NOW + 30 * 24 * 60 * 60 * 1000,
  });
  return { v1, sub };
}

describe("held-version grandfathering and the move primitive (#3289 §9)", () => {
  it("a new version moves no one; a per-customer move assigns the new price from the move instant", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { v1, sub } = await seedHolder(stores);
      const v2 = await stores.subs.createPlan({ name: "Basic", priceUSD: 59.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW });
      await stores.subs.approvePlan(v2.id, "test-operator");
      // The new version exists and is effective — but the holder
      // still holds v1 until moved. Grandfathering falls out of
      // the held planId.
      const held = await stores.subs.getSubscription(sub.id);
      expect(held?.planId).toBe(v1.id);
      expect((await stores.subs.getEffectiveVersion(v1.productId, DEFAULT_SEGMENT, NOW + 5000))?.id).toBe(v2.id);
      // The move: period untouched, planId flips, audit row written.
      const moved = await moveSubscriptionToVersion({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        subscriptionId: sub.id,
        toVersionId: v2.id,
        movedBy: "test-operator",
        nowMs: NOW + 5000,
      });
      expect(moved.moved).toBe(true);
      expect(moved.fromVersionId).toBe(v1.id);
      expect(moved.subscription.planId).toBe(v2.id);
      expect(moved.subscription.periodStartMs).toBe(sub.periodStartMs);
      expect(moved.subscription.periodEndMs).toBe(sub.periodEndMs);
      const moves = await stores.products.listMovesForUser("user-1");
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ productId: v1.productId, fromVersionId: v1.id, toVersionId: v2.id, segment: DEFAULT_SEGMENT });
      // Repeating the move is a no-op success, never a second audit row.
      const again = await moveSubscriptionToVersion({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        subscriptionId: sub.id,
        toVersionId: v2.id,
        movedBy: "test-operator",
        nowMs: NOW + 6000,
      });
      expect(again.moved).toBe(false);
      expect(await stores.products.listMovesForUser("user-1")).toHaveLength(1);
    }
  });

  it("a move onto an unapproved, future, other-segment, or other-product version refuses", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { v1, sub } = await seedHolder(stores);
      // Unapproved v2.
      const unapproved = await stores.subs.createPlan({ name: "Basic", priceUSD: 59.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW });
      await expect(
        moveSubscriptionToVersion({ subs: stores.subs, store: stores.store, products: stores.products, subscriptionId: sub.id, toVersionId: unapproved.id, movedBy: "test-operator", nowMs: NOW + 5000 }),
      ).rejects.toThrow(/not approved/);
      // Approved but future v3.
      const future = await stores.subs.createPlan({ name: "Basic", priceUSD: 69.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW + 100_000 });
      await stores.subs.approvePlan(future.id, "test-operator");
      await expect(
        moveSubscriptionToVersion({ subs: stores.subs, store: stores.store, products: stores.products, subscriptionId: sub.id, toVersionId: future.id, movedBy: "test-operator", nowMs: NOW + 5000 }),
      ).rejects.toThrow(/not the effective version/);
      // Approved + effective, but in another segment.
      const eu = await stores.subs.createPlan({ name: "Basic", priceUSD: 39.99, periodDays: 30, includedRuns: 20, segment: "eu", effectiveFromMs: NOW });
      await stores.subs.approvePlan(eu.id, "test-operator");
      await expect(
        moveSubscriptionToVersion({ subs: stores.subs, store: stores.store, products: stores.products, subscriptionId: sub.id, toVersionId: eu.id, movedBy: "test-operator", nowMs: NOW + 5000 }),
      ).rejects.toThrow(/not the effective version/);
      // Approved + effective, but another product.
      const premium = await stores.subs.createPlan({ name: "Premium", priceUSD: 59.99, periodDays: 30, includedRuns: 30, effectiveFromMs: NOW });
      await stores.subs.approvePlan(premium.id, "test-operator");
      await expect(
        moveSubscriptionToVersion({ subs: stores.subs, store: stores.store, products: stores.products, subscriptionId: sub.id, toVersionId: premium.id, movedBy: "test-operator", nowMs: NOW + 5000 }),
      ).rejects.toThrow(/never the product/);
      // Nothing moved: the holder still holds v1.
      expect((await stores.subs.getSubscription(sub.id))?.planId).toBe(v1.id);
    }
  });

  it("a segment change changes what the next per-run charge resolves to", async () => {
    // The gate resolves the effective price for the holder's segment.
    const catalogue = new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" });
    // Effective in the past (relative to the real clock): the
    // version is live now, so approvePrice can approve it.
    await catalogue.createVersion({ family: "goal", priceUSD: 0.2, segment: "eu", effectiveFromMs: 1000 });
    await catalogue.approvePrice({ family: "goal", approverId: "test-operator", segment: "eu" });
    const gate = new NativeMonetizationGate({ monetizationEnabled: true, priceCatalogue: catalogue });
    expect(await gate.priceFor("goal", DEFAULT_SEGMENT)).toBe(0.1);
    expect(await gate.priceFor("goal", "eu")).toBe(0.2);
    await expect(gate.priceFor("goal", "apac")).rejects.toThrow(/no.*price|not found|fail-closed/i);

    for (const { stores } of await makeMoveStores()) {
      const { v1 } = await seedHolder(stores);
      const changed = await setAccountSegment({
        store: stores.store,
        subs: stores.subs,
        products: stores.products,
        userId: "user-1",
        segment: "eu",
        movedBy: "test-operator",
        nowMs: NOW + 5000,
      });
      expect(changed.previousSegment).toBe(DEFAULT_SEGMENT);
      expect(changed.segment).toBe("eu");
      expect((await stores.store.getAccount("user-1"))?.segment).toBe("eu");
      // The segment move is audited with the held version (from == to).
      const moves = await stores.products.listMovesForUser("user-1");
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ productId: v1.productId, fromVersionId: v1.id, toVersionId: v1.id, segment: "eu" });
    }
  });
});

describe("per-charge recording (#3289 §3.9)", () => {
  it("journal, native ledger, and credit claim carry productId + versionId + priceUSD", async () => {
    const mock = new MockD1Database();
    const journalDb = createD1JournalDb(mock as unknown as D1Database);
    const ledgerDb = createD1NativeLedgerDb(mock as unknown as D1Database);
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureJournalSchema(journalDb);
    await ensureNativeLedgerSchema(ledgerDb);
    await ensureCommercialSchema(commercialDb);
    const makers = [
      {
        name: "in-memory",
        journal: new InMemoryJournalAdapter(),
        ledger: new InMemoryNativeLedgerAdapter(),
        store: new InMemoryCommercialAdapter(),
      },
      {
        name: "drizzle",
        journal: new D1JournalAdapter(journalDb),
        ledger: new D1NativeLedgerAdapter(ledgerDb),
        store: new D1CommercialAdapter(commercialDb),
      },
    ];
    for (const { journal, ledger, store } of makers) {
      const entries = await journal.postEntries(
        mapChargeToJournalEntries({
          transactionRef: "run-1",
          tenantId: "tenant-a",
          runRequestId: "run-1",
          family: "goal",
          amountUSD: 0.1,
          productId: "prod-per-run-goal",
          versionId: "cat-goal-default-v1",
        }),
      );
      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e.productId).toBe("prod-per-run-goal");
        expect(e.versionId).toBe("cat-goal-default-v1");
        expect(e.priceUSD).toBe(0.1);
      }
      const { row } = await ledger.recordRow({
        kind: "charge",
        runRequestId: "run-1",
        tenantId: "tenant-a",
        userId: "user-1",
        family: "goal",
        priceUSD: 0.1,
        rail: "stripe",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        sessionId: "cs_test_1",
      });
      expect(row.productId).toBe("prod-per-run-goal");
      expect(row.versionId).toBe("cat-goal-default-v1");
      const claim = await store.recordCreditClaim({
        creditRunId: "credit-1",
        userId: "user-1",
        family: "goal",
        amountUSD: 0.1,
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        priceUSD: 0.1,
      });
      expect(claim.productId).toBe("prod-per-run-goal");
      expect(claim.versionId).toBe("cat-goal-default-v1");
      expect(claim.priceUSD).toBe(0.1);
      const found = await store.findUnredeemedCredit("user-1", "goal");
      expect(found).toMatchObject({
        creditRunId: "credit-1",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        priceUSD: 0.1,
      });
    }
  });

  it("legacy rows written before 0058 still read, with null product/version", async () => {
    const mock = new MockD1Database();
    const journalDb = createD1JournalDb(mock as unknown as D1Database);
    const ledgerDb = createD1NativeLedgerDb(mock as unknown as D1Database);
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    // Pre-0058 shape: the tables exist without the version columns.
    await applyMigrations(journalDb as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0009_JOURNAL,
    ]);
    await applyMigrations(ledgerDb as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0012_NATIVE_LEDGER,
    ]);
    await applyMigrations(commercialDb as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
    ]);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_journal_entries (id, transaction_ref, account_code, debit_usd, credit_usd, currency, tenant_id, run_request_id, family, created_at_ms)
         VALUES ('run-legacy:1000', 'run-legacy', '1000', 0.1, 0, 'USD', 'tenant-a', 'run-legacy', 'goal', ?)`,
      )
      .run(NOW);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_native_ledger_rows (id, session_id, action, amount_usd, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, proof_signature, note, tenant_id, family, run_request_id, created_at_ms, updated_at_ms)
         VALUES ('row-legacy', 'screener-payment-native:run-legacy', 'charge', 0.1, 'USD', 'user-1', 'card', 'cs_legacy', 'completed', '', 'did:agent:orchestrator', 'none', 'legacy', 'tenant-a', 'goal', 'run-legacy', ?, ?)`,
      )
      .run(NOW, NOW);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_credit_claims (credit_run_id, user_id, family, amount_usd, created_at_ms)
         VALUES ('credit-legacy', 'user-1', 'goal', 0.1, ?)`,
      )
      .run(NOW);
    // 0058 adds the columns (nullable); the legacy rows survive with nulls.
    await applyMigrations(journalDb as unknown as MigrationDb, [
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
      MIGRATION_0058_PRODUCT_VERSIONS,
    ]);
    const journal = new D1JournalAdapter(journalDb);
    const legacyEntries = await journal.listEntries("tenant-a");
    expect(legacyEntries).toHaveLength(1);
    expect(legacyEntries[0].productId).toBeNull();
    expect(legacyEntries[0].versionId).toBeNull();
    expect(legacyEntries[0].priceUSD).toBeNull();
    const ledger = new D1NativeLedgerAdapter(ledgerDb);
    const legacyRow = await ledger.findRow("run-legacy", "charge");
    expect(legacyRow?.productId).toBeNull();
    expect(legacyRow?.versionId).toBeNull();
    const store = new D1CommercialAdapter(commercialDb);
    const legacyClaim = await store.findUnredeemedCredit("user-1", "goal");
    expect(legacyClaim).toMatchObject({ creditRunId: "credit-legacy", productId: null, versionId: null, priceUSD: null });
  });
});

describe("migration 0058 — product versions (#3289)", () => {
  it("is registered in ALL_MIGRATIONS", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 58);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0058_product_versions");
    expect(found[0].sql).toContain("agent_products");
    expect(found[0].sql).toContain("agent_version_moves");
    expect(found[0].sql).toContain("agent_bulk_moves");
  });

  it("applies on an empty store and seeds the five products (four per-run + Free)", async () => {
    const mock = new MockD1Database();
    const db = createD1ProductDb(mock as unknown as D1Database);
    await ensureProductSchema(db);
    // The subscription adapter's SELECT reads the 0049 approval
    // columns too, so the subscription schema rides along.
    await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
    const products = new D1ProductAdapter(db);
    const listed = await products.listProducts();
    expect(listed.map((p) => p.id).sort()).toEqual([
      "prod-free",
      "prod-per-run-goal",
      "prod-per-run-options",
      "prod-per-run-stock",
      "prod-per-run-strategy",
    ]);
    expect(listed.find((p) => p.id === "prod-free")?.kind).toBe("subscription");
    expect(listed.filter((p) => p.kind === "per_run")).toHaveLength(4);
    // No versions exist yet: the Free product has no plan rows.
    const subs = new D1SubscriptionAdapter(createD1SubscriptionDb(mock as unknown as D1Database));
    expect(await subs.listPlans(false)).toHaveLength(0);
  });

  it("backfills existing plan rows as v1 of their name-derived product, approval preserved", async () => {
    const mock = new MockD1Database();
    const db = createD1SubscriptionDb(mock as unknown as D1Database);
    // 0007 first: 0008's tier_source ALTER needs the accounts table.
    // 0049 is held back: the legacy rows must exist BEFORE it
    // runs, because 0049 grandfathers pre-existing rows to
    // 'approved' (rows inserted after it get the 'proposed'
    // default instead).
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
      MIGRATION_0014_BILLING,
      MIGRATION_0041_PLAN_TRIAL_DAYS,
    ]);
    // Two plans share the name "Basic" (created at different
    // instants); one is "Premium".
    mock.sqlite
      .prepare(
        `INSERT INTO agent_subscription_plans (id, name, price_usd, period_days, included_runs, trial_days, active, created_at_ms, updated_at_ms)
         VALUES ('plan-a', 'Basic', 49.99, 30, 20, NULL, 1, ?, ?)`,
      )
      .run(NOW - 1000, NOW - 1000);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_subscription_plans (id, name, price_usd, period_days, included_runs, trial_days, active, created_at_ms, updated_at_ms)
         VALUES ('plan-b', 'Basic', 59.99, 30, 20, NULL, 1, ?, ?)`,
      )
      .run(NOW, NOW);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_subscription_plans (id, name, price_usd, period_days, included_runs, trial_days, active, created_at_ms, updated_at_ms)
         VALUES ('plan-c', 'Premium', 59.99, 30, 30, NULL, 1, ?, ?)`,
      )
      .run(NOW, NOW);
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0049_PLAN_PRICE_APPROVAL]);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0009_JOURNAL,
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0012_NATIVE_LEDGER,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
      MIGRATION_0058_PRODUCT_VERSIONS,
    ]);
    const subs = new D1SubscriptionAdapter(db);
    const a = await subs.getPlan("plan-a");
    expect(a).toMatchObject({ productId: "prod-sub-basic", segment: DEFAULT_SEGMENT, version: 1, effectiveFromMs: NOW - 1000, billingPeriod: "monthly" });
    const b = await subs.getPlan("plan-b");
    // Duplicate name: same product, version 2, effective 1ms
    // after its own creation instant (the rank stagger, so the
    // effective ordering matches creation order).
    expect(b).toMatchObject({ productId: "prod-sub-basic", segment: DEFAULT_SEGMENT, version: 2, effectiveFromMs: NOW + 1, billingPeriod: "monthly" });
    const c = await subs.getPlan("plan-c");
    expect(c).toMatchObject({ productId: "prod-sub-premium", segment: DEFAULT_SEGMENT, version: 1, effectiveFromMs: NOW, billingPeriod: "monthly" });
    // Approval preserved: the 0049 backfill approved legacy rows.
    expect(a?.approvalStatus).toBe("approved");
    // The effective version for the product is the newest one
    // (queried after the rank stagger: plan-b starts at NOW+1).
    expect((await subs.getEffectiveVersion("prod-sub-basic", DEFAULT_SEGMENT, NOW + 5000))?.id).toBe("plan-b");
    expect((await subs.getEffectiveVersion("prod-sub-premium", DEFAULT_SEGMENT, NOW + 5000))?.id).toBe("plan-c");
  });

  it("rebuilds catalogue rows as v1, approval preserved", async () => {
    const mock = new MockD1Database();
    const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    ]);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_price_catalogue (family, price_usd, updated_at_ms, approval_status, approved_by, approved_at_ms)
         VALUES ('goal', 0.10, ?, 'approved', 'owner', ?)`,
      )
      .run(NOW, NOW);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0009_JOURNAL,
      MIGRATION_0012_NATIVE_LEDGER,
      MIGRATION_0058_PRODUCT_VERSIONS,
    ]);
    const catalogue = new D1PriceCatalogueAdapter(db);
    const entry = await catalogue.getEffectiveEntry("goal", DEFAULT_SEGMENT, NOW);
    expect(entry).toMatchObject({
      id: "cat-goal-default-v1",
      productId: "prod-per-run-goal",
      segment: DEFAULT_SEGMENT,
      version: 1,
      priceUSD: 0.1,
      approvalStatus: "approved",
      effectiveFromMs: NOW,
    });
  });

  it("accounts gain segment 'default'", async () => {
    const mock = new MockD1Database();
    const db = createD1CommercialDb(mock as unknown as D1Database);
    // The commercial adapter's SELECT reads every account
    // column, so the pre-0058 state needs the full commercial
    // prerequisite set (0007 accounts, 0008 tier_source, 0040
    // grant columns) — only 0058 itself is held back.
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0010_PAID_SUBMISSIONS,
      MIGRATION_0026_TENANT_AUTO_REFRESH,
      MIGRATION_0028_TENANT_PROVIDERS,
      MIGRATION_0040_UNLIMITED_FREE_GRANT,
    ]);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_commercial_accounts (id, tenant_id, tier, credits_usd, included_runs, updated_at_ms)
         VALUES ('user-1', 'tenant-a', 'Free', 0, 0, ?)`,
      )
      .run(NOW);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0009_JOURNAL,
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0012_NATIVE_LEDGER,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
      MIGRATION_0058_PRODUCT_VERSIONS,
    ]);
    const store = new D1CommercialAdapter(db);
    expect((await store.getAccount("user-1"))?.segment).toBe(DEFAULT_SEGMENT);
  });
});

describe("explicit product rank (#3246 §3.3)", () => {
  it("assertProductRank accepts a positive whole number or null, absent reads as null", () => {
    expect(assertProductRank(1)).toBe(1);
    expect(assertProductRank(10001)).toBe(10001);
    expect(assertProductRank(null)).toBeNull();
    expect(assertProductRank(undefined)).toBeNull();
    for (const bad of [0, -1, 1.5, NaN, Infinity, "2", true, {}]) {
      expect(() => assertProductRank(bad)).toThrow(/positive whole number/);
    }
  });

  it("assertProduct validates the rank shape only; the prod-free refusal lives in the route", () => {
    expect(assertProduct({ id: "prod-basic", name: "Basic", kind: "subscription", rank: 2 }).rank).toBe(2);
    expect(assertProduct({ id: "prod-basic", name: "Basic", kind: "subscription" }).rank).toBeNull();
    expect(() => assertProduct({ id: "prod-basic", name: "Basic", kind: "subscription", rank: 0 })).toThrow();
    // No product-identity policy in the assert: prod-free's rank-1
    // floor is the migration seed + the route 409 (pinned in
    // tests/upgradeOfferRoutes.test.ts), not the port assert.
    expect(assertProduct({ id: "prod-free", name: "Free", kind: "subscription", rank: 1 }).rank).toBe(1);
  });

  it("both adapters round-trip rank at creation and through setProductRank", async () => {
    const mock = new MockD1Database();
    const db = createD1ProductDb(mock as unknown as D1Database);
    await ensureProductSchema(db);
    const stores: ProductStore[] = [new InMemoryProductAdapter(), new D1ProductAdapter(db)];
    for (const store of stores) {
      const created = await store.createProduct({ id: "prod-ranked", name: "Ranked", kind: "subscription", rank: 3 });
      expect(created.rank).toBe(3);
      expect((await store.getProduct("prod-ranked"))?.rank).toBe(3);
      const unranked = await store.createProduct({ id: "prod-plain", name: "Plain", kind: "subscription" });
      expect(unranked.rank).toBeNull();
      const updated = await store.setProductRank("prod-plain", 4);
      expect(updated.rank).toBe(4);
      expect((await store.getProduct("prod-plain"))?.rank).toBe(4);
      const cleared = await store.setProductRank("prod-plain", null);
      expect(cleared.rank).toBeNull();
      await expect(store.setProductRank("prod-missing", 2)).rejects.toThrow(/No product/);
      await expect(store.setProductRank("prod-plain", 0)).rejects.toThrow(/positive whole number/);
    }
  });

  it("the seeded prod-free row reads rank 1 after ensure (migration 0062 backfill)", async () => {
    const mock = new MockD1Database();
    const db = createD1ProductDb(mock as unknown as D1Database);
    await ensureProductSchema(db);
    const store = new D1ProductAdapter(db);
    expect((await store.getProduct(FREE_PRODUCT_ID))?.rank).toBe(1);
    // The per-run seeds stay unranked.
    expect((await store.getProduct("prod-per-run-stock"))?.rank).toBeNull();
  });
});
