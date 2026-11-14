/**
 * Issue #2781 (Monetization Phase 2.15) — bundle servicing derivation.
 *
 * Pure derivation for the Billing servicing view: bundle purchases +
 * entitlements are carried verbatim from GET /subscription (additive
 * keys); the counts are live (active + unexpired) only. A caller
 * without bundle data gets an empty bundles section, never an invented
 * one. Mirrors tests/billing_servicing_2740.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  buildBillingView,
  type BillingViewInput,
} from "../src/data/billingServicing";

const NOW = 1_800_000_000_000;

function viewInput(overrides: Partial<BillingViewInput> = {}): BillingViewInput {
  return {
    identity: { userLogin: "u1", tier: "Free" },
    subscription: { userId: "u1", effectiveTier: "Free", current: null, subscriptions: [] },
    receipts: [],
    plans: [],
    referral: {
      redeemableUSD: 0,
      totalEarnedUSD: 0,
      attribution: null,
      rules: { earnAmountUSD: 0, vestingDelayMs: 0, redemptionScope: "none" },
    },
    nowMs: NOW,
    ...overrides,
  };
}

describe("bundle servicing derivation (#2781)", () => {
  it("no bundle data derives an empty bundles section with zero counts", () => {
    const view = buildBillingView(viewInput());
    expect(view.bundles.purchases).toEqual([]);
    expect(view.bundles.entitlements).toEqual([]);
    expect(view.bundles.activePurchaseCount).toBe(0);
    expect(view.bundles.liveEntitlementCount).toBe(0);
  });

  it("carries purchases + entitlements verbatim and counts only the live ones", () => {
    const view = buildBillingView(
      viewInput({
        bundles: {
          purchases: [
            { id: "bp-1", bundleId: "bnd-1", status: "active", periodStartMs: NOW - 1000, periodEndMs: NOW + 1000, canceledAtMs: null },
            { id: "bp-2", bundleId: "bnd-1", status: "canceled", periodStartMs: NOW - 1000, periodEndMs: NOW + 1000, canceledAtMs: NOW },
            { id: "bp-3", bundleId: "bnd-2", status: "active", periodStartMs: NOW - 2000, periodEndMs: NOW - 1000, canceledAtMs: null },
          ],
          entitlements: [
            { id: "bent-1", bundlePurchaseId: "bp-1", productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: NOW - 1000, periodEndMs: NOW + 1000, status: "active" },
            { id: "bent-2", bundlePurchaseId: "bp-1", productId: "options:PayPerUse", includedRuns: 10, periodStartMs: NOW - 1000, periodEndMs: NOW + 1000, status: "active" },
            { id: "bent-3", bundlePurchaseId: "bp-2", productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: NOW - 1000, periodEndMs: NOW + 1000, status: "canceled" },
          ],
        },
      }),
    );
    expect(view.bundles.purchases).toHaveLength(3);
    expect(view.bundles.entitlements).toHaveLength(3);
    expect(view.bundles.activePurchaseCount).toBe(1);
    expect(view.bundles.liveEntitlementCount).toBe(2);
  });
});
