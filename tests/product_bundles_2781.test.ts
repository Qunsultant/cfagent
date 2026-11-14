/**
 * Issue #2781 (Monetization Phase 2.15) — product bundles port
 * + adapters.
 *
 * TDD: the port and adapters were written first as the storage
 * contract; the route/selling/UI tests in the sibling files were
 * written red-first (failing) and turned green by the
 * implementation. This file pins the contract: validation,
 * approval, and the atomic purchase (no partial entitlement).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1ProductBundleDb,
  D1ProductBundleAdapter,
  ensureProductBundleSchema,
} from "../src/data/d1ProductBundleAdapter";
import { InMemoryProductBundleAdapter } from "../src/data/inMemoryProductBundleAdapter";
import {
  assertBundle,
  bundleMemberFamily,
  isBundleMemberProductId,
  isBundlePriceApproved,
} from "../src/data/productBundles";
import { BusinessError } from "../src/outcomes/outcomeAspects";

/** Minimal D1Database stand-in over node:sqlite, with batch(). */
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

const NOW = Date.now();
const START = NOW - 1000;
const END = NOW + 30 * 24 * 3600 * 1000;

function validBundleInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "bnd-test-1",
    name: "Stock + Options",
    memberProductIds: ["stock:PayPerUse", "options:PayPerUse"],
    priceUSD: 0.06,
    periodDays: 30,
    includedRunsPerMember: 10,
    ...overrides,
  };
}

describe("assertBundle (pure validation)", () => {
  it("accepts a valid bundle and rounds the price to cents", () => {
    const b = assertBundle({ ...validBundleInput(), priceUSD: 0.065 });
    expect(b.priceUSD).toBe(0.07);
    expect(b.memberProductIds).toEqual(["stock:PayPerUse", "options:PayPerUse"]);
  });

  it("refuses fewer than two members", () => {
    expect(() =>
      assertBundle(validBundleInput({ memberProductIds: ["stock:PayPerUse"] })),
    ).toThrowError(BusinessError);
    try {
      assertBundle(validBundleInput({ memberProductIds: ["stock:PayPerUse"] }));
    } catch (err) {
      expect((err as BusinessError).code).toBe("FAILURE_BUNDLE_MEMBERS_INVALID");
    }
  });

  it("refuses duplicate members", () => {
    expect(() =>
      assertBundle(
        validBundleInput({ memberProductIds: ["stock:PayPerUse", "stock:PayPerUse"] }),
      ),
    ).toThrowError(BusinessError);
  });

  it("refuses unknown families and non-PayPerUse members", () => {
    expect(() =>
      assertBundle(validBundleInput({ memberProductIds: ["stock:PayPerUse", "nope:PayPerUse"] })),
    ).toThrowError(BusinessError);
    expect(() =>
      assertBundle(validBundleInput({ memberProductIds: ["stock:PayPerUse", "stock:Free"] })),
    ).toThrowError(BusinessError);
    expect(() =>
      assertBundle(validBundleInput({ memberProductIds: ["stock:PayPerUse", "options:Subscribed"] })),
    ).toThrowError(BusinessError);
  });

  it("refuses a missing name, a non-positive price, a bad period, and negative runs", () => {
    for (const bad of [
      validBundleInput({ name: "  " }),
      validBundleInput({ priceUSD: 0 }),
      validBundleInput({ priceUSD: -1 }),
      validBundleInput({ periodDays: 0 }),
      validBundleInput({ periodDays: 1.5 }),
      validBundleInput({ includedRunsPerMember: -1 }),
    ]) {
      try {
        assertBundle(bad);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as BusinessError).code).toBe("FAILURE_BUNDLE_INVALID");
      }
    }
  });

  it("isBundleMemberProductId accepts family:PayPerUse only", () => {
    expect(isBundleMemberProductId("stock:PayPerUse")).toBe(true);
    expect(isBundleMemberProductId("strategy:PayPerUse")).toBe(true);
    expect(isBundleMemberProductId("stock:Free")).toBe(false);
    expect(isBundleMemberProductId("stock")).toBe(false);
    expect(isBundleMemberProductId(42)).toBe(false);
    expect(bundleMemberFamily("options:PayPerUse")).toBe("options");
    expect(bundleMemberFamily("nope:PayPerUse")).toBe(null);
  });

  it("isBundlePriceApproved is true only for approved", () => {
    expect(isBundlePriceApproved({ approvalStatus: "approved" })).toBe(true);
    expect(isBundlePriceApproved({ approvalStatus: "proposed" })).toBe(false);
  });
});

describe("InMemoryProductBundleAdapter", () => {
  it("creates PROPOSED, approves with the approver recorded, and lists", async () => {
    const store = new InMemoryProductBundleAdapter();
    const created = await store.createBundle(validBundleInput());
    expect(created.approvalStatus).toBe("proposed");
    expect(created.active).toBe(true);
    expect(isBundlePriceApproved(created)).toBe(false);
    const approved = await store.approveBundle(created.id, "op1");
    expect(approved.approvalStatus).toBe("approved");
    expect(approved.approvedBy).toBe("op1");
    expect(approved.approvedAtMs).not.toBeNull();
    expect((await store.listBundles(true)).map((b) => b.id)).toEqual([created.id]);
    const deactivated = await store.deactivateBundle(created.id);
    expect(deactivated.active).toBe(false);
    expect(await store.listBundles(true)).toEqual([]);
  });

  it("refuses a duplicate bundle id and a missing bundle approval", async () => {
    const store = new InMemoryProductBundleAdapter();
    await store.createBundle(validBundleInput());
    await expect(store.createBundle(validBundleInput())).rejects.toThrow(/already exists/);
    await expect(store.approveBundle("bnd-missing", "op1")).rejects.toThrowError(BusinessError);
  });

  it("writes purchase + one entitlement per member, atomically", async () => {
    const store = new InMemoryProductBundleAdapter();
    const bundle = await store.createBundle(validBundleInput());
    const { purchase, entitlements } = await store.createBundlePurchaseAtomic({
      purchase: {
        id: "bp-1",
        userId: "u1",
        tenantId: "t1",
        bundleId: bundle.id,
        providerPaymentRef: "bbnd-1",
        stripeSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        providerSubscriptionId: "sub_prov_1",
        providerStatus: "active",
        periodStartMs: START,
        periodEndMs: END,
      },
      entitlements: [
        { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
      ],
    });
    expect(purchase.status).toBe("active");
    expect(entitlements).toHaveLength(2);
    expect(entitlements.map((e) => e.productId).sort()).toEqual([
      "options:PayPerUse",
      "stock:PayPerUse",
    ]);
    expect((await store.listBundlePurchases("u1")).map((p) => p.id)).toEqual(["bp-1"]);
    expect((await store.listBundleEntitlements("u1")).map((e) => e.productId).sort()).toEqual([
      "options:PayPerUse",
      "stock:PayPerUse",
    ]);
    // Replay by provider id returns the existing purchase — never a duplicate.
    const replay = await store.createBundlePurchaseAtomic({
      purchase: {
        id: "bp-2",
        userId: "u1",
        tenantId: "t1",
        bundleId: bundle.id,
        providerPaymentRef: "bbnd-2",
        providerSubscriptionId: "sub_prov_1",
        providerStatus: "active",
        periodStartMs: START,
        periodEndMs: END,
      },
      entitlements: [
        { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
      ],
    });
    expect(replay.purchase.id).toBe("bp-1");
    expect(await store.listBundlePurchases("u1")).toHaveLength(1);
    // Payment-ref lookup finds it by draft id and by intent id.
    expect((await store.findBundlePurchaseByPaymentRef("bbnd-1"))?.id).toBe("bp-1");
    expect((await store.findBundlePurchaseByPaymentRef("pi_1"))?.id).toBe("bp-1");
    expect(await store.findBundlePurchaseByPaymentRef("nope")).toBeNull();
  });

  it("writes NOTHING when the entitlement set is partial, unknown, or unusable", async () => {
    const store = new InMemoryProductBundleAdapter();
    const bundle = await store.createBundle(validBundleInput());
    const base = {
      id: "bp-x",
      userId: "u1",
      tenantId: "t1",
      bundleId: bundle.id,
      providerPaymentRef: "bbnd-x",
      providerSubscriptionId: "sub_prov_x",
      providerStatus: "active",
      periodStartMs: START,
      periodEndMs: END,
    };
    const full = [
      { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
      { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
    ];
    // Subset (one member missing).
    await expect(
      store.createBundlePurchaseAtomic({ purchase: base, entitlements: full.slice(0, 1) }),
    ).rejects.toThrow(/exactly the bundle member products/);
    // Extra member.
    await expect(
      store.createBundlePurchaseAtomic({
        purchase: base,
        entitlements: [
          ...full,
          { productId: "goal:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        ],
      }),
    ).rejects.toThrow(/exactly the bundle member products/);
    // Unusable period.
    await expect(
      store.createBundlePurchaseAtomic({
        purchase: { ...base, periodEndMs: START },
        entitlements: full,
      }),
    ).rejects.toThrow(/periodEndMs must be after periodStartMs/);
    // Unknown bundle.
    await expect(
      store.createBundlePurchaseAtomic({
        purchase: { ...base, bundleId: "bnd-missing" },
        entitlements: full,
      }),
    ).rejects.toThrowError(BusinessError);
    expect(await store.listBundlePurchases("u1")).toEqual([]);
    expect(await store.listBundleEntitlements("u1")).toEqual([]);
  });

  it("cancel keeps periodEnd; revoke moves it to now — for purchase and entitlements", async () => {
    const store = new InMemoryProductBundleAdapter();
    const bundle = await store.createBundle(validBundleInput());
    const mk = (id: string, ref: string, prov: string) =>
      store.createBundlePurchaseAtomic({
        purchase: {
          id,
          userId: "u1",
          tenantId: "t1",
          bundleId: bundle.id,
          providerPaymentRef: ref,
          providerSubscriptionId: prov,
          providerStatus: "active",
          periodStartMs: START,
          periodEndMs: END,
        },
        entitlements: [
          { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
          { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        ],
      });
    await mk("bp-cancel", "bbnd-c", "sub_prov_c");
    const canceled = await store.cancelBundlePurchase("bp-cancel", NOW);
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.periodEndMs).toBe(END);
    expect(canceled?.canceledAtMs).toBe(NOW);
    expect((await store.listBundleEntitlements("u1")).every((e) => e.status === "canceled")).toBe(true);
    expect(await store.cancelBundlePurchase("bp-missing", NOW)).toBeNull();
    await mk("bp-revoke", "bbnd-r", "sub_prov_r");
    const revoked = await store.revokeBundlePurchase("bp-revoke", NOW);
    expect(revoked?.status).toBe("canceled");
    expect(revoked?.periodEndMs).toBe(NOW);
  });
});

describe("D1ProductBundleAdapter (real Drizzle over node:sqlite)", () => {
  async function setup() {
    const mock = new MockD1Database();
    const db = createD1ProductBundleDb(mock as unknown as D1Database);
    await ensureProductBundleSchema(db);
    return { mock, db, store: new D1ProductBundleAdapter(db, mock as unknown as D1Database) };
  }

  it("creates, approves, and reads back through D1", async () => {
    const { store } = await setup();
    const created = await store.createBundle(validBundleInput());
    expect(created.approvalStatus).toBe("proposed");
    const approved = await store.approveBundle(created.id, "op1");
    expect(approved.approvedBy).toBe("op1");
    expect((await store.getBundle(created.id))?.approvalStatus).toBe("approved");
  });

  it("writes purchase + entitlements in one batch and replays by provider id", async () => {
    const { store, mock } = await setup();
    const bundle = await store.createBundle(validBundleInput());
    let batches = 0;
    const realBatch = mock.batch.bind(mock);
    mock.batch = (async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      batches += 1;
      return realBatch(stmts);
    }) as typeof mock.batch;
    const { purchase, entitlements } = await store.createBundlePurchaseAtomic({
      purchase: {
        id: "bp-d1",
        userId: "u1",
        tenantId: "t1",
        bundleId: bundle.id,
        providerPaymentRef: "bbnd-d1",
        stripeSessionId: "cs_d1",
        stripePaymentIntentId: "pi_d1",
        providerSubscriptionId: "sub_prov_d1",
        providerStatus: "active",
        periodStartMs: START,
        periodEndMs: END,
      },
      entitlements: [
        { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
      ],
    });
    expect(purchase.id).toBe("bp-d1");
    expect(entitlements).toHaveLength(2);
    expect(batches).toBe(1);
    const replay = await store.createBundlePurchaseAtomic({
      purchase: {
        id: "bp-d1b",
        userId: "u1",
        tenantId: "t1",
        bundleId: bundle.id,
        providerPaymentRef: "bbnd-d1b",
        providerSubscriptionId: "sub_prov_d1",
        providerStatus: "active",
        periodStartMs: START,
        periodEndMs: END,
      },
      entitlements: [
        { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
      ],
    });
    expect(replay.purchase.id).toBe("bp-d1");
    expect(await store.listBundlePurchases("u1")).toHaveLength(1);
  });

  it("writes NOTHING on a partial entitlement set (D1)", async () => {
    const { store } = await setup();
    const bundle = await store.createBundle(validBundleInput());
    await expect(
      store.createBundlePurchaseAtomic({
        purchase: {
          id: "bp-d1x",
          userId: "u1",
          tenantId: "t1",
          bundleId: bundle.id,
          providerPaymentRef: "bbnd-d1x",
          providerSubscriptionId: "sub_prov_d1x",
          providerStatus: "active",
          periodStartMs: START,
          periodEndMs: END,
        },
        entitlements: [
          { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: START, periodEndMs: END },
        ],
      }),
    ).rejects.toThrow(/exactly the bundle member products/);
    expect(await store.listBundlePurchases("u1")).toEqual([]);
    expect(await store.listBundleEntitlements("u1")).toEqual([]);
  });
});
