/**
 * Issue #2781 (Monetization Phase 2.15) — bundle selling derivation.
 *
 * Pure derivation over caller-supplied data: a bundle is purchasable
 * only when active AND owner-approved; savings are the members'
 * approved per-run prices minus the bundle price (null when any member
 * price is unknown, never invented); `owned` follows live purchases,
 * and live entitlements list the member products actually conferred.
 */
import { describe, expect, it } from "vitest";
import {
  buildProductSelling,
  type BundleSellingInput,
  type BundlePurchaseSellingInput,
  type BundleEntitlementSellingInput,
} from "../src/data/productSelling";

const NOW = 1_800_000_000_000;

function bundle(overrides: Partial<BundleSellingInput> = {}): BundleSellingInput {
  return {
    id: "bnd-test-1",
    name: "Stock + Options",
    memberProductIds: ["stock:PayPerUse", "options:PayPerUse"],
    priceUSD: 0.06,
    periodDays: 30,
    includedRunsPerMember: 10,
    approvalStatus: "approved",
    active: true,
    ...overrides,
  };
}

function purchase(overrides: Partial<BundlePurchaseSellingInput> = {}): BundlePurchaseSellingInput {
  return {
    id: "bp-1",
    bundleId: "bnd-test-1",
    status: "active",
    periodStartMs: NOW - 86_400_000,
    periodEndMs: NOW + 29 * 86_400_000,
    ...overrides,
  };
}

function entitlement(overrides: Partial<BundleEntitlementSellingInput> = {}): BundleEntitlementSellingInput {
  return {
    id: "bent-1",
    bundlePurchaseId: "bp-1",
    productId: "stock:PayPerUse",
    status: "active",
    periodEndMs: NOW + 29 * 86_400_000,
    ...overrides,
  };
}

const BASE = {
  display: [],
  plans: [],
  effectiveTier: "Free",
  subscriptions: [],
  nowMs: NOW,
  bundleMemberPrices: { stock: 0.05, options: 0.05 },
};

describe("bundle selling derivation (#2781)", () => {
  it("no bundle data derives an empty bundles list, never an invented one", () => {
    expect(buildProductSelling(BASE).bundles).toEqual([]);
  });

  it("an approved active bundle is purchasable with savings from member prices", () => {
    const result = buildProductSelling({ ...BASE, bundles: [bundle()] });
    expect(result.bundles).toHaveLength(1);
    const entry = result.bundles[0];
    expect(entry.purchasable).toBe(true);
    expect(entry.notPurchasableReason).toBeNull();
    expect(entry.savingsUSD).toBe(0.04);
    expect(entry.owned).toBe(false);
    expect(entry.liveEntitlementProductIds).toEqual([]);
  });

  it("a proposed bundle is never purchasable — the price is not owner-approved", () => {
    const result = buildProductSelling({ ...BASE, bundles: [bundle({ approvalStatus: "proposed" })] });
    expect(result.bundles[0].purchasable).toBe(false);
    expect(result.bundles[0].notPurchasableReason).toMatch(/proposed, not owner-approved/);
  });

  it("an inactive bundle is never purchasable, even when approved", () => {
    const result = buildProductSelling({ ...BASE, bundles: [bundle({ active: false })] });
    expect(result.bundles[0].purchasable).toBe(false);
    expect(result.bundles[0].notPurchasableReason).toBe("bundle is not active");
  });

  it("savings are null when any member price is unknown — never invented", () => {
    const result = buildProductSelling({
      ...BASE,
      bundles: [bundle()],
      bundleMemberPrices: { stock: 0.05 },
    });
    expect(result.bundles[0].savingsUSD).toBeNull();
    expect(result.bundles[0].purchasable).toBe(true);
  });

  it("a live purchase marks the bundle owned with its live entitlements", () => {
    const result = buildProductSelling({
      ...BASE,
      bundles: [bundle()],
      bundlePurchases: [purchase()],
      bundleEntitlements: [
        entitlement(),
        entitlement({ id: "bent-2", bundlePurchaseId: "bp-1", productId: "options:PayPerUse" }),
      ],
    });
    expect(result.bundles[0].owned).toBe(true);
    expect(result.bundles[0].liveEntitlementProductIds.sort()).toEqual(["options:PayPerUse", "stock:PayPerUse"]);
  });

  it("an expired or canceled purchase is not owned, and its entitlements do not count", () => {
    const expired = buildProductSelling({
      ...BASE,
      bundles: [bundle()],
      bundlePurchases: [purchase({ periodEndMs: NOW - 1000 })],
      bundleEntitlements: [entitlement({ periodEndMs: NOW - 1000 })],
    });
    expect(expired.bundles[0].owned).toBe(false);
    expect(expired.bundles[0].liveEntitlementProductIds).toEqual([]);
    const canceled = buildProductSelling({
      ...BASE,
      bundles: [bundle()],
      bundlePurchases: [purchase({ status: "canceled" })],
      bundleEntitlements: [entitlement({ status: "canceled" })],
    });
    expect(canceled.bundles[0].owned).toBe(false);
    expect(canceled.bundles[0].liveEntitlementProductIds).toEqual([]);
  });

  it("an entitlement under a different purchase does not confer ownership of this bundle", () => {
    const result = buildProductSelling({
      ...BASE,
      bundles: [bundle(), bundle({ id: "bnd-test-2", name: "Other" })],
      bundlePurchases: [purchase()],
      bundleEntitlements: [entitlement()],
    });
    expect(result.bundles[0].owned).toBe(true);
    expect(result.bundles[1].owned).toBe(false);
    expect(result.bundles[1].liveEntitlementProductIds).toEqual([]);
  });
});
