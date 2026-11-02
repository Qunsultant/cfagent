/**
 * Issue #2717 (Platform Phase 5, program #2468) — selling derivation.
 *
 * The product-level selling layer OVER the #2405 Phase 2 rails. Pure
 * derivation over caller-supplied data — zero reads, zero writes, zero
 * money movement, zero charging decisions:
 * - per-product selling rail: 2.1 Billing subscription vs x402
 *   pay-per-use vs none. A product is purchasable only with an
 *   approved price (pay-per-use) or an active plan (subscription);
 *   anything else is refused with a reason, never invented.
 * - subscription activation state from subscription rows + clock:
 *   none / active / past-due / canceled-at-period-end / expired.
 *   past-due is a MARK, not a gate change: grace is PROPOSED policy
 *   (slice 2.7 area), not wired into the gate — the record says so.
 * - purchase receipts from Billing rows. The price comes from the
 *   matching plan record only; a row whose plan is unknown renders
 *   with a null price and planUnknown true, never an invented price.
 * - funnel purchase/activation events (Phase 4's model) from VERIFIED
 *   Billing rows only: a row with a provider subscription id emits a
 *   purchase event and an activation event at periodStartMs (it did
 *   activate then, even if expired now). Repurchase rows carry no
 *   provider subscription id and emit nothing; no rows emit nothing.
 *   There is deliberately no sink here: Phase 4's funnel model has no
 *   sink and no dashboard, and this phase builds only the
 *   purchase→activation leg as derivation. Sink + dashboard stay
 *   deferred and are stated as such.
 * - credits redemption is ALWAYS unavailable with reason: the credits
 *   ledger is slice 2.2 (#2657), unlanded — no credits exist to redeem.
 *   This module never invents a credit balance.
 * - effectiveTier is carried verbatim from the caller (the GET
 *   /subscription response). The server is the authority on tier;
 *   this module never re-derives it from rows.
 * - the older native subscription checkout route (`sub-` drafts,
 *   #2198) is NOT a rail here: only the 2.1 Billing API
 *   (billing-checkout / billing-purchase) is. The panel calls those
 *   routes; this module only describes what they sell.
 * - no entitlement by assertion: activation is true only for a row
 *   whose period covers now (or a canceled row still inside its
 *   period). A mint alone — no row — is never activation.
 */
import { buildFunnelEvent, type FunnelEvent } from "./productMarketing";

/** Minimal display shape the selling derivation needs (a subset of the
 *  Phase 4 CatalogDisplayEntry — the panel maps full rows to this). */
export interface CatalogDisplayEntryLike {
  id: string;
  canonicalName: string;
  tier: string;
  availability: string;
  listed: boolean;
  unlistedReasons: string[];
  priceUSD: number | null;
  purchasePath: { label: string; route: string; note: string } | null;
  purchasePathReason: string | null;
}

/** Plan shape as GET /plans returns it (server truth, operator data). */
export interface SellingPlanInput {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
  includedRuns: number;
  active: boolean;
}

/** Subscription row shape as GET /subscription returns it. */
export interface SubscriptionRowInput {
  id: string;
  userId: string;
  planId: string;
  provider: string;
  providerSubscriptionId: string | null;
  providerStatus: string | null;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
}

export type SellingRail = "billing-subscription" | "x402-pay-per-use" | "none";

export type ActivationState =
  | "none"
  | "active"
  | "past-due"
  | "canceled-at-period-end"
  | "expired";

export interface SellingReceipt {
  subscriptionId: string;
  planId: string;
  planName: string | null;
  /** Null when the row's plan is unknown — never invented. */
  priceUSD: number | null;
  planUnknown: boolean;
  periodStartMs: number;
  periodEndMs: number;
  provider: string;
  providerSubscriptionId: string | null;
  providerStatus: string | null;
  status: string;
}

export interface ProductSellingEntry {
  productId: string;
  canonicalName: string;
  rail: SellingRail;
  purchasable: boolean;
  notPurchasableReason: string | null;
  /** Display price for pay-per-use rows; null for subscription rows
   *  (their price lives on the plan, not the product). */
  priceUSD: number | null;
  purchasePath: CatalogDisplayEntryLike["purchasePath"];
}

export interface ProductSelling {
  subscription: {
    activation: ActivationState;
    effectiveTier: string;
    current: SellingReceipt | null;
    receipts: SellingReceipt[];
    funnelEvents: FunnelEvent[];
    creditsRedemption: { available: false; reason: string };
  };
  products: ProductSellingEntry[];
  /** Active plans only — the panel selects from these. */
  plans: SellingPlanInput[];
}

export const CREDITS_UNAVAILABLE_REASON =
  "Referral credits redemption is not available: the credits ledger is slice 2.2 (#2657), unlanded — no credits exist to redeem.";

function deriveActivation(
  rows: SubscriptionRowInput[],
  nowMs: number,
): ActivationState {
  if (rows.length === 0) return "none";
  // Same rule as GET /subscription's `current`: latest periodEnd wins.
  const current = rows.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a));
  if (current.status === "canceled" || current.canceledAtMs !== null) {
    return current.periodEndMs > nowMs ? "canceled-at-period-end" : "expired";
  }
  if (current.providerStatus === "past_due" && current.periodEndMs > nowMs) {
    // Mark only: past-due does NOT yet change gate access (grace is
    // PROPOSED policy, not wired into the gate).
    return "past-due";
  }
  return current.periodEndMs > nowMs ? "active" : "expired";
}

function deriveReceipt(
  row: SubscriptionRowInput,
  plansById: Map<string, SellingPlanInput>,
): SellingReceipt {
  const plan = plansById.get(row.planId);
  return {
    subscriptionId: row.id,
    planId: row.planId,
    planName: plan ? plan.name : null,
    priceUSD: plan ? plan.priceUSD : null,
    planUnknown: !plan,
    periodStartMs: row.periodStartMs,
    periodEndMs: row.periodEndMs,
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId,
    providerStatus: row.providerStatus,
    status: row.status,
  };
}

function deriveProduct(
  entry: CatalogDisplayEntryLike,
  activePlans: SellingPlanInput[],
): ProductSellingEntry {
  const base = {
    productId: entry.id,
    canonicalName: entry.canonicalName,
    purchasePath: entry.purchasePath,
  };
  if (!entry.listed) {
    return {
      ...base,
      rail: "none",
      purchasable: false,
      notPurchasableReason: entry.unlistedReasons.join("; ") || "not purchasable",
      priceUSD: null,
    };
  }
  if (entry.tier === "Free") {
    return {
      ...base,
      rail: "none",
      purchasable: false,
      notPurchasableReason: "free discovery — nothing to purchase",
      priceUSD: null,
    };
  }
  if (entry.tier === "Subscribed" || entry.availability === "entitlement-pending") {
    if (activePlans.length === 0) {
      return {
        ...base,
        rail: "billing-subscription",
        purchasable: false,
        notPurchasableReason: "no active subscription plan — operator data missing",
        priceUSD: null,
      };
    }
    return {
      ...base,
      rail: "billing-subscription",
      purchasable: true,
      notPurchasableReason: null,
      priceUSD: null,
    };
  }
  if (entry.tier === "PayPerUse") {
    if (entry.priceUSD === null) {
      return {
        ...base,
        rail: "x402-pay-per-use",
        purchasable: false,
        notPurchasableReason: "no approved price — refusing rather than inventing one",
        priceUSD: null,
      };
    }
    if (entry.availability !== "purchasable") {
      return {
        ...base,
        rail: "x402-pay-per-use",
        purchasable: false,
        notPurchasableReason: entry.purchasePathReason ?? "not purchasable",
        priceUSD: entry.priceUSD,
      };
    }
    return {
      ...base,
      rail: "x402-pay-per-use",
      purchasable: true,
      notPurchasableReason: null,
      priceUSD: entry.priceUSD,
    };
  }
  return {
    ...base,
    rail: "none",
    purchasable: false,
    notPurchasableReason: "unknown tier — refusing rather than inventing a rail",
    priceUSD: null,
  };
}

/**
 * Derive the selling surface from caller-supplied data. No reads, no
 * writes, no charging decisions — the caller supplies catalog rows,
 * plans, subscription state, and the clock; this function only
 * describes what may be sold and what is already activated.
 */
export function buildProductSelling(input: {
  display: CatalogDisplayEntryLike[];
  plans: SellingPlanInput[];
  effectiveTier: string;
  subscriptions: SubscriptionRowInput[];
  nowMs: number;
}): ProductSelling {
  const activePlans = input.plans.filter((p) => p.active);
  const plansById = new Map(input.plans.map((p) => [p.id, p]));
  const receipts = [...input.subscriptions]
    .sort((a, b) => b.periodStartMs - a.periodStartMs)
    .map((row) => deriveReceipt(row, plansById));
  const latest = input.subscriptions.length > 0
    ? input.subscriptions.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a))
    : null;
  const current = latest ? deriveReceipt(latest, plansById) : null;
  // Funnel purchase→activation leg, verified rows only: a Billing row
  // (provider subscription id present) emits both events at the period
  // start — it did activate then. Repurchase rows emit nothing.
  const funnelEvents: FunnelEvent[] = [];
  for (const row of [...input.subscriptions].sort((a, b) => a.periodStartMs - b.periodStartMs)) {
    if (row.providerSubscriptionId === null || row.providerSubscriptionId === "") continue;
    if (row.periodEndMs <= row.periodStartMs) continue;
    funnelEvents.push(
      buildFunnelEvent("purchase", "Subscribed", { occurredAtMs: row.periodStartMs }),
      buildFunnelEvent("activation", "Subscribed", { occurredAtMs: row.periodStartMs }),
    );
  }
  return {
    subscription: {
      activation: deriveActivation(input.subscriptions, input.nowMs),
      effectiveTier: input.effectiveTier,
      current,
      receipts,
      funnelEvents,
      creditsRedemption: { available: false as const, reason: CREDITS_UNAVAILABLE_REASON },
    },
    products: input.display.map((entry) => deriveProduct(entry, activePlans)),
    plans: activePlans,
  };
}
