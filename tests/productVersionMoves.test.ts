/**
 * Bulk moves (#3289 slice 2): the bulk-move store methods, the
 * bulk-move job driver, and the slice-2 Products routes.
 *
 * Covered here, per the design §9:
 * - bulk store methods on both adapters (create/get/update/
 *   list summaries, per-bulk-move audit rows, the
 *   (bulkMoveId, userId) idempotency backstop);
 * - the driver: a new version moves no one; a bulk move moves
 *   all live holders in scope and none outside it (other
 *   products, expired rows, segments without a ready target);
 *   a retry moves nobody twice; a per-customer failure is
 *   recorded and never fatal; the row cap + resume completes
 *   a large population without double moves; a dry run
 *   writes nothing; segment scope narrows the population;
 * - the routes: operator-only (403) + verified-login (401)
 *   on every new route, validation errors, approve/deactivate
 *   semantics, catalogue version reads/writes, and the
 *   bulk-move POST + status GETs end to end.
 *
 * Nothing here approves a price for production: the approved
 * versions in these tests are test-operator fixtures.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createD1ProductDb, D1ProductAdapter, ensureProductSchema } from "../src/data/d1ProductAdapter";
import { InMemoryProductAdapter } from "../src/data/inMemoryProductAdapter";
import { createD1SubscriptionDb, D1SubscriptionAdapter, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { createD1CommercialDb, D1CommercialAdapter, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { createD1PriceCatalogueDb, D1PriceCatalogueAdapter, ensurePriceCatalogueSchema } from "../src/data/d1PriceCatalogueAdapter";
import { DEFAULT_SEGMENT } from "../src/data/productPorts";
import type { ProductStore } from "../src/data/productPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { CommercialStore } from "../src/data/commercialPorts";
import { runBulkMove } from "../src/services/versionMoves";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
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

const NOW = 1_791_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

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

async function seedHolder(
  stores: MoveStores,
  userId: string,
  planId: string,
  subscriptionId: string,
  periodEndMs: number,
  segment?: string,
  periodStartMs: number = NOW,
) {
  await stores.store.upsertAccount({ userId, tenantId: "tenant-a", tier: "Free" });
  if (segment) await stores.store.setAccountSegment(userId, segment);
  return stores.subs.createSubscription({
    id: subscriptionId,
    userId,
    tenantId: "tenant-a",
    planId,
    provider: "manual",
    providerPaymentRef: `ref-${subscriptionId}`,
    periodStartMs,
    periodEndMs,
  });
}

/**
 * Basic in two segments (default + enterprise), each with an
 * old approved version and a new approved version; a holder
 * already on the new version; an expired holder; and a holder
 * of a different product (Premium).
 */
async function seedBulkFixture(stores: MoveStores) {
  const product = await stores.products.getOrCreateProduct({ name: "Basic", kind: "subscription" });
  // Plans carry the product row's id explicitly — the same
  // contract the POST /plans route and the slice-2 version
  // route follow. (Without it, createPlan falls back to the
  // name-derived id, which matches only 0058-seeded rows.)
  const v1 = await stores.subs.createPlan({
    name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW - 1000, productId: product.id,
  });
  await stores.subs.approvePlan(v1.id, "test-operator");
  const v2 = await stores.subs.createPlan({
    name: "Basic", priceUSD: 59.99, periodDays: 30, includedRuns: 20, effectiveFromMs: NOW, productId: product.id,
  });
  await stores.subs.approvePlan(v2.id, "test-operator");
  const e1 = await stores.subs.createPlan({
    name: "Basic", priceUSD: 44.99, periodDays: 30, includedRuns: 20, segment: "enterprise", effectiveFromMs: NOW - 1000, productId: product.id,
  });
  await stores.subs.approvePlan(e1.id, "test-operator");
  const e2 = await stores.subs.createPlan({
    name: "Basic", priceUSD: 54.99, periodDays: 30, includedRuns: 20, segment: "enterprise", effectiveFromMs: NOW, productId: product.id,
  });
  await stores.subs.approvePlan(e2.id, "test-operator");
  const sub1 = await seedHolder(stores, "user-1", v1.id, "sub-1", NOW + DAY);
  const sub2 = await seedHolder(stores, "user-2", e1.id, "sub-2", NOW + DAY, "enterprise");
  const sub3 = await seedHolder(stores, "user-3", v2.id, "sub-3", NOW + DAY);
  // Expired: the period ran in the past (a valid row whose
  // periodEndMs precedes the move instant).
  const sub4 = await seedHolder(stores, "user-4", v1.id, "sub-4", NOW - 1000, undefined, NOW - 2 * DAY);
  const premium = await stores.products.getOrCreateProduct({ name: "Premium", kind: "subscription" });
  const p1 = await stores.subs.createPlan({
    name: "Premium", priceUSD: 59.99, periodDays: 30, includedRuns: 30, effectiveFromMs: NOW - 1000, productId: premium.id,
  });
  await stores.subs.approvePlan(p1.id, "test-operator");
  const sub5 = await seedHolder(stores, "user-5", p1.id, "sub-5", NOW + DAY);
  return { product, v1, v2, e1, e2, premium, p1, sub1, sub2, sub3, sub4, sub5 };
}

describe("bulk-move store methods (#3289 slice 2)", () => {
  it("create/get/update/list summaries + per-bulk-move audit rows, on both adapters", async () => {
    for (const { stores } of await makeMoveStores()) {
      const product = await stores.products.getOrCreateProduct({ name: "Basic", kind: "subscription" });
      const first = await stores.products.createBulkMove({
        id: "bulk-1",
        productId: product.id,
        segmentScope: null,
        targetVersionIdsJson: JSON.stringify({ default: "v2" }),
        movedBy: "op1",
        reason: "price rise",
        startedAtMs: NOW,
      });
      expect(first.status).toBe("running");
      expect(first.movedCount).toBe(0);
      await expect(
        stores.products.createBulkMove({
          id: "bulk-1",
          productId: product.id,
          targetVersionIdsJson: "{}",
          movedBy: "op1",
        }),
      ).rejects.toThrow(/already exists/);
      const second = await stores.products.createBulkMove({
        id: "bulk-2",
        productId: product.id,
        segmentScope: "enterprise",
        targetVersionIdsJson: "{}",
        movedBy: "op1",
        startedAtMs: NOW + 1000,
      });
      // Newest first.
      expect((await stores.products.listBulkMoves(product.id)).map((b) => b.id)).toEqual(["bulk-2", "bulk-1"]);
      expect(await stores.products.getBulkMove("bulk-missing")).toBeNull();
      await expect(stores.products.updateBulkMove("bulk-missing", { status: "complete" })).rejects.toThrow(
        /No bulk move/,
      );
      const updated = await stores.products.updateBulkMove("bulk-1", {
        status: "complete",
        movedCount: 2,
        skippedCount: 1,
        failedCount: 0,
        finishedAtMs: NOW + 2000,
      });
      expect(updated.status).toBe("complete");
      expect(updated.movedCount).toBe(2);
      expect(updated.finishedAtMs).toBe(NOW + 2000);
      expect(second.segmentScope).toBe("enterprise");
      // Audit rows: oldest first, scoped to the bulk move.
      await stores.products.recordMove({
        bulkMoveId: "bulk-1",
        userId: "user-1",
        productId: product.id,
        fromVersionId: "v1",
        toVersionId: "v2",
        segment: DEFAULT_SEGMENT,
        movedBy: "op1",
        movedAtMs: NOW + 100,
      });
      await stores.products.recordMove({
        bulkMoveId: "bulk-1",
        userId: "user-2",
        productId: product.id,
        fromVersionId: "v1",
        toVersionId: "v2",
        segment: DEFAULT_SEGMENT,
        movedBy: "op1",
        movedAtMs: NOW + 200,
      });
      // The (bulkMoveId, userId) backstop: a second row for the
      // same customer under the same bulk move returns the
      // existing row instead of duplicating it.
      const duplicate = await stores.products.recordMove({
        bulkMoveId: "bulk-1",
        userId: "user-1",
        productId: product.id,
        fromVersionId: "v1",
        toVersionId: "v2",
        segment: DEFAULT_SEGMENT,
        movedBy: "op1",
        movedAtMs: NOW + 300,
      });
      const rows = await stores.products.listMovesForBulkMove("bulk-1");
      expect(rows.map((r) => r.userId)).toEqual(["user-1", "user-2"]);
      expect(duplicate.id).toBe(rows[0].id);
      expect(await stores.products.listMovesForBulkMove("bulk-2")).toEqual([]);
    }
  });
});

describe("the bulk-move driver (#3289 §9)", () => {
  it("a new version moves no one; a bulk move moves all live holders in scope and none outside it", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v1, v2, e1, e2, p1, sub1, sub2, sub3, sub4, sub5 } = await seedBulkFixture(stores);
      // Before the bulk move, every holder still holds their version.
      expect((await stores.subs.getSubscription(sub1.id))?.planId).toBe(v1.id);
      expect((await stores.subs.getSubscription(sub2.id))?.planId).toBe(e1.id);
      const result = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "price rise",
        nowMs: NOW + 5000,
      });
      expect(result.bulkMove?.status).toBe("complete");
      expect(result.movedCount).toBe(2);
      expect(result.skippedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.hasMore).toBe(false);
      expect((await stores.subs.getSubscription(sub1.id))?.planId).toBe(v2.id);
      expect((await stores.subs.getSubscription(sub2.id))?.planId).toBe(e2.id);
      // Already current, expired, and other-product holders untouched.
      expect((await stores.subs.getSubscription(sub3.id))?.planId).toBe(v2.id);
      expect((await stores.subs.getSubscription(sub4.id))?.planId).toBe(v1.id);
      expect((await stores.subs.getSubscription(sub5.id))?.planId).toBe(p1.id);
      // Periods untouched by the move.
      expect((await stores.subs.getSubscription(sub1.id))?.periodEndMs).toBe(NOW + DAY);
      // The summary row carries the accumulated totals.
      const summary = await stores.products.getBulkMove(result.bulkMove!.id);
      expect(summary?.movedCount).toBe(2);
      expect(summary?.skippedCount).toBe(1);
      expect(summary?.segmentScope).toBeNull();
      // The audit rows answer who moved, from what, to what.
      // (Equal movedAtMs makes the row order unspecified, so
      // the assertion is order-insensitive.)
      const moves = await stores.products.listMovesForBulkMove(result.bulkMove!.id);
      expect(moves.map((m) => m.userId).sort()).toEqual(["user-1", "user-2"]);
      const move1 = moves.find((m) => m.userId === "user-1")!;
      expect(move1.fromVersionId).toBe(v1.id);
      expect(move1.toVersionId).toBe(v2.id);
      expect(moves.find((m) => m.userId === "user-2")!.segment).toBe("enterprise");
    }
  });

  it("a retry moves nobody twice", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v2, e2, sub1, sub2 } = await seedBulkFixture(stores);
      const first = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "first",
        nowMs: NOW + 5000,
      });
      expect(first.movedCount).toBe(2);
      const second = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "retry",
        nowMs: NOW + 6000,
      });
      expect(second.movedCount).toBe(0);
      expect(second.skippedCount).toBe(3);
      expect(second.bulkMove?.status).toBe("complete");
      expect((await stores.subs.getSubscription(sub1.id))?.planId).toBe(v2.id);
      expect((await stores.subs.getSubscription(sub2.id))?.planId).toBe(e2.id);
      // No new audit rows: the retry skipped before writing.
      const moves = await stores.products.listMovesForProduct(product.id);
      expect(moves).toHaveLength(2);
      expect(await stores.products.listMovesForBulkMove(second.bulkMove!.id)).toEqual([]);
    }
  });

  it("a dry run writes nothing and previews the same population the real run moves", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v1, v2, e2 } = await seedBulkFixture(stores);
      const preview = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "preview",
        dryRun: true,
        nowMs: NOW + 5000,
      });
      expect(preview.bulkMove).toBeNull();
      expect(await stores.products.listBulkMoves(product.id)).toEqual([]);
      expect(await stores.products.listMovesForProduct(product.id)).toEqual([]);
      expect((await stores.subs.getSubscription("sub-1"))?.planId).toBe(v1.id);
      const bySegment = new Map(preview.preview.map((s) => [s.segment, s]));
      expect(bySegment.get(DEFAULT_SEGMENT)?.targetVersionId).toBe(v2.id);
      expect(bySegment.get(DEFAULT_SEGMENT)?.targetReady).toBe(true);
      expect(bySegment.get(DEFAULT_SEGMENT)?.holderCount).toBe(2);
      expect(bySegment.get("enterprise")?.targetVersionId).toBe(e2.id);
      expect(bySegment.get("enterprise")?.holderCount).toBe(1);
    }
  });

  it("segment scope narrows the population", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v1, e2, sub1, sub2 } = await seedBulkFixture(stores);
      const result = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        segmentScope: "enterprise",
        movedBy: "op1",
        reason: "enterprise only",
        nowMs: NOW + 5000,
      });
      expect(result.movedCount).toBe(1);
      expect((await stores.subs.getSubscription(sub1.id))?.planId).toBe(v1.id);
      expect((await stores.subs.getSubscription(sub2.id))?.planId).toBe(e2.id);
      expect(result.bulkMove?.segmentScope).toBe("enterprise");
    }
  });

  it("a segment without a ready target stays put and the preview says why", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product } = await seedBulkFixture(stores);
      // A "trial" segment whose effective version is proposed,
      // never approved: its holder must not move.
      const t1 = await stores.subs.createPlan({
        name: "Basic", priceUSD: 39.99, periodDays: 30, includedRuns: 20, segment: "trial", effectiveFromMs: NOW - 1000, productId: product.id,
      });
      await stores.subs.approvePlan(t1.id, "test-operator");
      const t2 = await stores.subs.createPlan({
        name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 20, segment: "trial", effectiveFromMs: NOW, productId: product.id,
      });
      await seedHolder(stores, "user-6", t1.id, "sub-6", NOW + DAY, "trial");
      const result = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "all",
        nowMs: NOW + 5000,
      });
      expect((await stores.subs.getSubscription("sub-6"))?.planId).toBe(t1.id);
      const trial = result.preview.find((s) => s.segment === "trial");
      expect(trial?.targetVersionId).toBe(t2.id);
      expect(trial?.targetReady).toBe(false);
      expect(trial?.holderCount).toBe(1);
    }
  });

  it("a per-customer failure is recorded and never fatal", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v2 } = await seedBulkFixture(stores);
      // Fault injection: one holder's planId update throws.
      // The driver must record the failure, keep moving the
      // others, and finish complete_with_failures.
      const faultySubs = new Proxy(stores.subs, {
        get(target, prop, receiver) {
          if (prop === "moveSubscriptionToVersion") {
            return async (subscriptionId: string, toVersionId: string) => {
              if (subscriptionId === "sub-2") throw new Error("Simulated per-customer failure.");
              return target.moveSubscriptionToVersion(subscriptionId, toVersionId);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await runBulkMove({
        subs: faultySubs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "all",
        nowMs: NOW + 5000,
      });
      expect(result.bulkMove?.status).toBe("complete_with_failures");
      expect(result.movedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].userId).toBe("user-2");
      expect(result.failures[0].error).toBe("Simulated per-customer failure.");
      expect((await stores.subs.getSubscription("sub-1"))?.planId).toBe(v2.id);
    }
  });

  it("the row cap pages the job and a resume completes it without double moves", async () => {
    for (const { stores } of await makeMoveStores()) {
      const { product, v2, e2, sub1, sub2 } = await seedBulkFixture(stores);
      const first = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "paged",
        limit: 1,
        nowMs: NOW + 5000,
      });
      expect(first.hasMore).toBe(true);
      expect(first.bulkMove?.status).toBe("running");
      expect(first.movedCount).toBe(1);
      // Deterministic order: user-1 first.
      expect((await stores.subs.getSubscription(sub1.id))?.planId).toBe(v2.id);
      const resumed = await runBulkMove({
        subs: stores.subs,
        store: stores.store,
        products: stores.products,
        productId: product.id,
        movedBy: "op1",
        reason: "paged",
        resumeBulkMoveId: first.bulkMove!.id,
        nowMs: NOW + 6000,
      });
      expect(resumed.hasMore).toBe(false);
      expect(resumed.bulkMove?.status).toBe("complete");
      expect(resumed.bulkMove?.id).toBe(first.bulkMove!.id);
      expect(resumed.movedCount).toBe(1);
      expect((await stores.subs.getSubscription(sub2.id))?.planId).toBe(e2.id);
      // Accumulated totals on the one summary row.
      expect(resumed.bulkMove?.movedCount).toBe(2);
      // Exactly one audit row per moved customer.
      expect((await stores.products.listMovesForBulkMove(first.bulkMove!.id)).map((m) => m.userId)).toEqual([
        "user-1",
        "user-2",
      ]);
      // A finished bulk move refuses to resume.
      await expect(
        runBulkMove({
          subs: stores.subs,
          store: stores.store,
          products: stores.products,
          productId: product.id,
          movedBy: "op1",
          resumeBulkMoveId: first.bulkMove!.id,
          nowMs: NOW + 7000,
        }),
      ).rejects.toThrow(/only a running bulk move resumes/);
      await expect(
        runBulkMove({
          subs: stores.subs,
          store: stores.store,
          products: stores.products,
          productId: product.id,
          movedBy: "op1",
          resumeBulkMoveId: "bulk-missing",
          nowMs: NOW + 7000,
        }),
      ).rejects.toThrow(/No bulk move/);
    }
  });

  it("a bulk move on a per-run product refuses, and on a missing product 404s", async () => {
    for (const { stores } of await makeMoveStores()) {
      const perRun = await stores.products.getOrCreateProduct({ name: "Stock signals", kind: "per_run" });
      await expect(
        runBulkMove({
          subs: stores.subs,
          store: stores.store,
          products: stores.products,
          productId: perRun.id,
          movedBy: "op1",
          nowMs: NOW,
        }),
      ).rejects.toThrow(/subscription products only/);
      await expect(
        runBulkMove({
          subs: stores.subs,
          store: stores.store,
          products: stores.products,
          productId: "prod-missing",
          movedBy: "op1",
          nowMs: NOW,
        }),
      ).rejects.toThrow(/No product/);
    }
  });
});

function req(method: string, path: string, login: string | null, body?: unknown) {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

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

function ctxWith(env: Record<string, unknown>) {
  return {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
}

async function bodyOf(res: Response | null): Promise<any> {
  if (!res) return null;
  return res.json().catch(() => null);
}

/** Seed Basic v1/v2 + two holders against the same mock the routes read. Real-time bounds: the routes resolve effectiveness at Date.now(), so the fixture's periods must be live now (unlike the driver tests, which inject nowMs). */
async function seedRouteFixture(mock: MockD1Database) {
  const realNow = Date.now();
  const productDb = createD1ProductDb(mock as unknown as D1Database);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  const catalogueDb = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensureProductSchema(productDb);
  await ensureSubscriptionSchema(subsDb);
  await ensureCommercialSchema(commercialDb);
  await ensurePriceCatalogueSchema(catalogueDb);
  const products = new D1ProductAdapter(productDb);
  const subs = new D1SubscriptionAdapter(subsDb);
  const store = new D1CommercialAdapter(commercialDb);
  const catalogue = new D1PriceCatalogueAdapter(catalogueDb);
  const product = await products.getOrCreateProduct({ name: "Basic", kind: "subscription" });
  const v1 = await subs.createPlan({
    name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 20, effectiveFromMs: realNow - 2000, productId: product.id,
  });
  await subs.approvePlan(v1.id, "test-operator");
  const v2 = await subs.createPlan({
    name: "Basic", priceUSD: 59.99, periodDays: 30, includedRuns: 20, effectiveFromMs: realNow - 1000, productId: product.id,
  });
  await subs.approvePlan(v2.id, "test-operator");
  await store.upsertAccount({ userId: "user-1", tenantId: "tenant-a", tier: "Free" });
  await subs.createSubscription({
    id: "sub-1", userId: "user-1", tenantId: "tenant-a", planId: v1.id,
    provider: "manual", providerPaymentRef: "ref-sub-1", periodStartMs: realNow, periodEndMs: realNow + DAY,
  });
  await store.upsertAccount({ userId: "user-2", tenantId: "tenant-a", tier: "Free" });
  await subs.createSubscription({
    id: "sub-2", userId: "user-2", tenantId: "tenant-a", planId: v1.id,
    provider: "manual", providerPaymentRef: "ref-sub-2", periodStartMs: realNow, periodEndMs: realNow + DAY,
  });
  return { products, subs, store, catalogue, product, v1, v2 };
}

describe("Products routes (#3289 slice 2)", () => {
  it("every new route requires a verified login (401) and a store operator (403)", async () => {
    const mock = new MockD1Database();
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/payments/agentic/commercial/products"],
      ["POST", "/payments/agentic/commercial/products", { name: "X", kind: "subscription" }],
      ["GET", "/payments/agentic/commercial/products/prod-free/versions"],
      ["POST", "/payments/agentic/commercial/products/prod-free/versions", {}],
      ["POST", "/payments/agentic/commercial/products/prod-free/versions/v1/approve", {}],
      ["POST", "/payments/agentic/commercial/products/prod-free/versions/v1/deactivate", {}],
      ["GET", "/payments/agentic/commercial/catalogue/versions?productId=prod-per-run-stock"],
      ["POST", "/payments/agentic/commercial/catalogue/versions", {}],
      ["POST", "/payments/agentic/commercial/products/prod-free/bulk-move", {}],
      ["GET", "/payments/agentic/commercial/products/prod-free/bulk-moves"],
      ["GET", "/payments/agentic/commercial/products/prod-free/bulk-moves/bulk-1"],
    ];
    for (const [method, path, body] of routes) {
      const unauthenticated = await call(ctx, method, path, null, body);
      expect(unauthenticated?.status).toBe(401);
      const forbidden = await call(ctx, method, path, "mallory", body);
      expect(forbidden?.status).toBe(403);
    }
  });

  it("GET /products lists seeded products with embedded chains, including the Free baseline", async () => {
    const mock = new MockD1Database();
    // Reads never ensure the schema (no writes on a read path),
    // so the test migrates first — as production deploys do.
    await ensureProductSchema(createD1ProductDb(mock as unknown as D1Database));
    await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
    await ensurePriceCatalogueSchema(createD1PriceCatalogueDb(mock as unknown as D1Database));
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const res = await call(ctx, "GET", "/payments/agentic/commercial/products", "op1");
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    const ids = (body.products as Array<{ product: { id: string } }>).map((p) => p.product.id);
    expect(ids).toContain("prod-free");
    expect(ids).toContain("prod-per-run-stock");
    const free = (body.products as Array<{ product: { id: string }; versions: unknown[] }>).find(
      (p) => p.product.id === "prod-free",
    );
    expect(free?.versions).toEqual([]);
  });

  it("product + version lifecycle: create, validate, approve, deactivate, chain read", async () => {
    const mock = new MockD1Database();
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const created = await call(ctx, "POST", "/payments/agentic/commercial/products", "op1", {
      name: "Starter",
      kind: "subscription",
      description: "Entry tier",
    });
    expect(created?.status).toBe(200);
    const productId = (await bodyOf(created)).product.id as string;
    expect(productId).toBeTruthy();
    // Product identity is the id, not the name: a second row
    // with the same name is a distinct product. A supplied id
    // that already exists is the conflict.
    const sameName = await call(ctx, "POST", "/payments/agentic/commercial/products", "op1", {
      name: "Starter",
      kind: "subscription",
    });
    expect(sameName?.status).toBe(200);
    expect((await bodyOf(sameName)).product.id).not.toBe(productId);
    const duplicateId = await call(ctx, "POST", "/payments/agentic/commercial/products", "op1", {
      id: productId,
      name: "Other",
      kind: "subscription",
    });
    expect(duplicateId?.status).toBe(409);
    // Validation: every bad field is a 400 with a named error.
    for (const bad of [
      { priceUSD: -1, periodDays: 30, includedRuns: 1 },
      { priceUSD: 10, periodDays: 0, includedRuns: 1 },
      { priceUSD: 10, periodDays: 30, includedRuns: -1 },
      { priceUSD: 10, periodDays: 30, includedRuns: 1, features: "not-an-array" },
      { priceUSD: 10, periodDays: 30, includedRuns: 1, billingPeriod: "weekly" },
      { priceUSD: 10, periodDays: 30, includedRuns: 1, effectiveFromMs: 2000, effectiveToMs: 1000 },
    ]) {
      const res = await call(ctx, "POST", `/payments/agentic/commercial/products/${productId}/versions`, "op1", bad);
      expect(res?.status).toBe(400);
    }
    // The Free baseline carries no versions; per-run products
    // version through the catalogue route.
    const freeRefused = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-free/versions", "op1", {
      priceUSD: 0, periodDays: 30, includedRuns: 0,
    });
    expect(freeRefused?.status).toBe(409);
    const perRunRefused = await call(
      ctx, "POST", "/payments/agentic/commercial/products/prod-per-run-stock/versions", "op1",
      { priceUSD: 0.02, periodDays: 30, includedRuns: 0 },
    );
    expect(perRunRefused?.status).toBe(400);
    const missing = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-missing/versions", "op1", {
      priceUSD: 10, periodDays: 30, includedRuns: 1,
    });
    expect(missing?.status).toBe(404);
    // A version lands proposed with a server-assigned number.
    const versionRes = await call(ctx, "POST", `/payments/agentic/commercial/products/${productId}/versions`, "op1", {
      priceUSD: 19.99,
      periodDays: 30,
      includedRuns: 5,
      trialDays: 7,
      segment: "default",
      features: ["Basic screening"],
      billingPeriod: "monthly",
    });
    expect(versionRes?.status).toBe(200);
    const plan = (await bodyOf(versionRes)).plan;
    expect(plan.version).toBe(1);
    expect(plan.approvalStatus).toBe("proposed");
    expect(plan.trialDays).toBe(7);
    expect(plan.featuresJson).toBe(JSON.stringify(["Basic screening"]));
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.product.version.created",
      "payments",
      expect.objectContaining({ productId, versionId: plan.id, createdBy: "op1" }),
    );
    // Approve: wrong product 404s; the right one approves with
    // the shared plan-approval audit event.
    const wrongProduct = await call(
      ctx, "POST", `/payments/agentic/commercial/products/prod-free/versions/${plan.id}/approve`, "op1", {},
    );
    expect(wrongProduct?.status).toBe(404);
    const approved = await call(
      ctx, "POST", `/payments/agentic/commercial/products/${productId}/versions/${plan.id}/approve`, "op1", {},
    );
    expect(approved?.status).toBe(200);
    expect((await bodyOf(approved)).plan.approvalStatus).toBe("approved");
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.plan.approved",
      "payments",
      expect.objectContaining({ planId: plan.id, approvedBy: "op1" }),
    );
    // Deactivate: holders ride on, new purchases stop.
    const deactivated = await call(
      ctx, "POST", `/payments/agentic/commercial/products/${productId}/versions/${plan.id}/deactivate`, "op1", {},
    );
    expect(deactivated?.status).toBe(200);
    expect((await bodyOf(deactivated)).plan.active).toBe(false);
    expect(ctx.audit).toHaveBeenCalledWith("commercial.plan.deactivated", "payments", { planId: plan.id });
    // The chain read shows the version with its final state.
    const chain = await call(ctx, "GET", `/payments/agentic/commercial/products/${productId}/versions`, "op1");
    expect(chain?.status).toBe(200);
    const chainBody = await bodyOf(chain);
    expect(chainBody.versions).toHaveLength(1);
    expect(chainBody.versions[0].approvalStatus).toBe("approved");
    expect(chainBody.versions[0].active).toBe(false);
    const chainMissing = await call(ctx, "GET", "/payments/agentic/commercial/products/prod-missing/versions", "op1");
    expect(chainMissing?.status).toBe(404);
  });

  it("catalogue versions: chain read, creation, validation", async () => {
    const mock = new MockD1Database();
    await ensureProductSchema(createD1ProductDb(mock as unknown as D1Database));
    await ensurePriceCatalogueSchema(createD1PriceCatalogueDb(mock as unknown as D1Database));
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const noProduct = await call(ctx, "GET", "/payments/agentic/commercial/catalogue/versions", "op1");
    expect(noProduct?.status).toBe(400);
    const missing = await call(
      ctx, "GET", "/payments/agentic/commercial/catalogue/versions?productId=prod-missing", "op1",
    );
    expect(missing?.status).toBe(404);
    // The seeded stock chain reads (0058 backfill + seeds).
    const chain = await call(
      ctx, "GET", "/payments/agentic/commercial/catalogue/versions?productId=prod-per-run-stock", "op1",
    );
    expect(chain?.status).toBe(200);
    expect((await bodyOf(chain)).versions.length).toBeGreaterThan(0);
    const badFamily = await call(ctx, "POST", "/payments/agentic/commercial/catalogue/versions", "op1", {
      family: "crypto", priceUSD: 1,
    });
    expect(badFamily?.status).toBe(400);
    const badPrice = await call(ctx, "POST", "/payments/agentic/commercial/catalogue/versions", "op1", {
      family: "stock", priceUSD: -0.01,
    });
    expect(badPrice?.status).toBe(400);
    const created = await call(ctx, "POST", "/payments/agentic/commercial/catalogue/versions", "op1", {
      family: "stock",
      priceUSD: 0.03,
      segment: "default",
      effectiveFromMs: NOW,
    });
    expect(created?.status).toBe(200);
    const entry = (await bodyOf(created)).entry;
    expect(entry.approvalStatus).toBe("proposed");
    expect(entry.priceUSD).toBe(0.03);
    expect(entry.productId).toBe("prod-per-run-stock");
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.price.set",
      "payments",
      expect.objectContaining({ family: "stock", priceUSD: 0.03 }),
    );
  });

  it("bulk move end to end: preview, run, status reads, resume refusal", async () => {
    const mock = new MockD1Database();
    const { product, v1, v2 } = await seedRouteFixture(mock);
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const noReason = await call(ctx, "POST", `/payments/agentic/commercial/products/${product.id}/bulk-move`, "op1", {
      dryRun: true,
    });
    expect(noReason?.status).toBe(400);
    const preview = await call(ctx, "POST", `/payments/agentic/commercial/products/${product.id}/bulk-move`, "op1", {
      reason: "preview",
      dryRun: true,
    });
    expect(preview?.status).toBe(200);
    const previewBody = await bodyOf(preview);
    expect(previewBody.bulkMove).toBeNull();
    expect(previewBody.preview).toHaveLength(1);
    expect(previewBody.preview[0].holderCount).toBe(2);
    expect(previewBody.preview[0].targetVersionId).toBe(v2.id);
    // The preview moved nobody.
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    expect((await new D1SubscriptionAdapter(subsDb).getSubscription("sub-1"))?.planId).toBe(v1.id);
    const run = await call(ctx, "POST", `/payments/agentic/commercial/products/${product.id}/bulk-move`, "op1", {
      reason: "price rise",
    });
    expect(run?.status).toBe(200);
    const runBody = await bodyOf(run);
    expect(runBody.bulkMove.status).toBe("complete");
    expect(runBody.movedCount).toBe(2);
    expect(runBody.hasMore).toBe(false);
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.product.bulk_move",
      "payments",
      expect.objectContaining({ productId: product.id, movedCount: 2, movedBy: "op1" }),
    );
    expect((await new D1SubscriptionAdapter(subsDb).getSubscription("sub-1"))?.planId).toBe(v2.id);
    const list = await call(ctx, "GET", `/payments/agentic/commercial/products/${product.id}/bulk-moves`, "op1");
    expect(list?.status).toBe(200);
    expect((await bodyOf(list)).bulkMoves).toHaveLength(1);
    const detail = await call(
      ctx, "GET", `/payments/agentic/commercial/products/${product.id}/bulk-moves/${runBody.bulkMove.id}`, "op1",
    );
    expect(detail?.status).toBe(200);
    const detailBody = await bodyOf(detail);
    expect(detailBody.moves).toHaveLength(2);
    // Equal movedAtMs makes the row order unspecified.
    expect(detailBody.moves.map((m: any) => m.userId).sort()).toEqual(["user-1", "user-2"]);
    const detailMissing = await call(
      ctx, "GET", `/payments/agentic/commercial/products/${product.id}/bulk-moves/bulk-missing`, "op1",
    );
    expect(detailMissing?.status).toBe(404);
    // Resuming a finished bulk move is a conflict.
    const resumeFinished = await call(
      ctx, "POST", `/payments/agentic/commercial/products/${product.id}/bulk-move`, "op1",
      { reason: "again", resumeBulkMoveId: runBody.bulkMove.id },
    );
    expect(resumeFinished?.status).toBe(409);
  });
});
