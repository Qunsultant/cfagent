/**
 * Issue #2740 (Platform Phase 6, program #2468) — servicing.
 *
 * Pure derivation for the read-only Billing servicing view. Every field
 * is server truth carried verbatim from an existing route — this module
 * never invents a price, a balance, a tier, or a period end:
 * - subscription: GET /payments/agentic/commercial/subscription
 *   (2.1 Billing API; effective tier + current + subscriptions);
 * - receipts: GET /api/payments/receipts (slice 4);
 * - plans: GET /payments/agentic/commercial/plans (2.1);
 * - referral: GET /payments/agentic/commercial/referral/balance (2.2;
 *   this phase's panel is its first client caller).
 * Referral rule values are operator-set and remain PROPOSED seeds
 * pending owner approval (per #2657 §15) — the view labels them as
 * such and never presents them as approved policy. The panel offers
 * no purchase action (Selling owns it), no cancel action (rescoped
 * 2.14 owns it), no deactivation (2.5), no refund action (2.7).
 */

export interface BillingSubscriptionCurrent {
  periodEndMs: number;
}

export interface BillingSubscriptionInput {
  userId: string;
  effectiveTier: string;
  current: BillingSubscriptionCurrent | null;
  subscriptions: unknown[];
}

export interface BillingReceiptInput {
  id: string;
  kind: "meter" | "tier" | "transaction";
  createdAt: string;
  provenance: string;
  amountUSD: number | null;
}

export interface BillingPlanInput {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
}

export interface BillingReferralInput {
  redeemableUSD: number;
  totalEarnedUSD: number;
  attribution: { referrerUserId: string } | null;
  rules: { earnAmountUSD: number; vestingDelayMs: number; redemptionScope: string };
}

/** Bundle purchase row shape as GET /subscription returns it (additive keys, #2781). */
export interface BillingBundlePurchaseInput {
  id: string;
  bundleId: string;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
}

/** Bundle entitlement row shape as GET /subscription returns it (additive keys, #2781). */
export interface BillingBundleEntitlementInput {
  id: string;
  bundlePurchaseId: string;
  productId: string;
  includedRuns: number;
  periodStartMs: number;
  periodEndMs: number;
  status: string;
}

export interface BillingViewInput {
  identity: { userLogin: string; tier: string };
  subscription: BillingSubscriptionInput;
  receipts: BillingReceiptInput[];
  plans: BillingPlanInput[];
  referral: BillingReferralInput;
  nowMs: number;
  /** Issue #2781: bundle purchases + entitlements (GET /subscription
   *  additive keys). Optional: a caller without bundle data gets an
   *  empty bundles section, never an invented one. */
  bundles?: {
    purchases: BillingBundlePurchaseInput[];
    entitlements: BillingBundleEntitlementInput[];
  };
}

export type SubscriptionStatus = "none" | "active" | "expired";

export interface BillingView {
  tier: string;
  subscriptionStatus: SubscriptionStatus;
  periodEndISO: string | null;
  subscriptionCount: number;
  receipts: BillingReceiptInput[];
  plans: BillingPlanInput[];
  referral: {
    redeemableUSD: number;
    totalEarnedUSD: number;
    attributedReferrer: string | null;
    rulesNote: string;
  };
  /** Issue #2781: bundle purchases + entitlements carried verbatim
   *  from GET /subscription; counts are live (active + unexpired). */
  bundles: {
    purchases: BillingBundlePurchaseInput[];
    entitlements: BillingBundleEntitlementInput[];
    activePurchaseCount: number;
    liveEntitlementCount: number;
  };
  supportSnapshot: {
    login: string;
    tier: string;
    subscriptionStatus: SubscriptionStatus;
    receiptsCount: number;
  };
}

/** Referral rule values are operator data, not owner-approved policy. */
export const REFERRAL_RULES_NOTE =
  "Operator-set rule values (proposed, pending owner approval).";

export function buildBillingView(input: BillingViewInput): BillingView {
  const { subscription, nowMs } = input;
  let subscriptionStatus: SubscriptionStatus = "none";
  let periodEndISO: string | null = null;
  if (subscription.current) {
    periodEndISO = new Date(subscription.current.periodEndMs).toISOString();
    subscriptionStatus = subscription.current.periodEndMs > nowMs ? "active" : "expired";
  }
  const bundlePurchases = input.bundles?.purchases ?? [];
  const bundleEntitlements = input.bundles?.entitlements ?? [];
  return {
    tier: subscription.effectiveTier,
    subscriptionStatus,
    periodEndISO,
    subscriptionCount: subscription.subscriptions.length,
    receipts: input.receipts,
    plans: input.plans,
    referral: {
      redeemableUSD: input.referral.redeemableUSD,
      totalEarnedUSD: input.referral.totalEarnedUSD,
      attributedReferrer: input.referral.attribution ? input.referral.attribution.referrerUserId : null,
      rulesNote: REFERRAL_RULES_NOTE,
    },
    bundles: {
      purchases: bundlePurchases,
      entitlements: bundleEntitlements,
      activePurchaseCount: bundlePurchases.filter(
        (p) => p.status === "active" && p.periodEndMs > nowMs,
      ).length,
      liveEntitlementCount: bundleEntitlements.filter(
        (e) => e.status === "active" && e.periodEndMs > nowMs,
      ).length,
    },
    supportSnapshot: {
      login: input.identity.userLogin,
      tier: input.identity.tier,
      subscriptionStatus,
      receiptsCount: input.receipts.length,
    },
  };
}
