/**
 * Issues #2020/#2127 — subscription store port.
 *
 * A subscription is a paid-through period, not a provider-managed
 * recurring billing object: cfpay is one-time-only and no provider
 * subscription API exists in-repo, so renewal is repurchase before
 * expiry (a repurchase stacks from the latest periodEnd, so no
 * paid time is lost). Provider-managed auto-renewal is NOT claimed
 * here and is a separate future slice.
 *
 * Tier model: the stored account tier is the operator-managed
 * BASELINE (Free / PayPerUse / operator-granted Subscribed). A
 * subscription is an overlay: while any subscription row is
 * unexpired, the effective tier is Subscribed regardless of the
 * stored tier. When the overlay lapses, the effective tier falls
 * back to the stored baseline — except a stored Subscribed tier
 * that was itself granted by a subscription (tierSource
 * "subscription") falls back to Free, because there is no
 * operator grant behind it. tierSource is what makes an
 * operator grant survive a lapsed subscription, and what makes a
 * lapsed subscription stop conferring Subscribed. There is no
 * background sweeper and no cron: every read computes the
 * effective tier from the rows and the clock.
 *
 * Money rules shared by both adapters live in the pure helpers
 * below so the two implementations cannot drift.
 */
import type { StoreTier, TierSource } from "./commercialPorts";
export type { TierSource };

export type SubscriptionStatus = "active" | "canceled";

export interface SubscriptionPlanRecord {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
  includedRuns: number;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  tenantId: string;
  planId: string;
  provider: string;
  providerPaymentRef: string;
  /**
   * Issue #2198 (slice 2, #2146) — native Stripe join keys, stored
   * alongside providerPaymentRef (which stays the route-minted
   * `sub-` draft id and the replay-guard key). The session id
   * alone cannot be refunded (POST /v1/refunds needs the
   * payment-intent id), so both are kept: null on pre-native
   * (cfpay-era) rows, which have neither.
   */
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  /**
   * Issue #2202 (implementation of design #2145) —
   * provider-managed Billing join keys. Null on
   * repurchase rows (one-time checkout, no provider
   * subscription) and on pre-Billing rows: a null
   * provider id is exactly what makes a row
   * NOT Billing-managed, so Billing webhooks (looked up
   * by provider id) can never touch a repurchase row —
   * the grandfather rule, enforced by the lookup, not
   * by a flag on the row.
   */
  providerSubscriptionId: string | null;
  /** Provider status string (Stripe: active, past_due, canceled, …); null on non-Billing rows. Recorded verbatim, never judged here. */
  providerStatus: string | null;
  status: SubscriptionStatus;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One day in epoch-ms; subscription periods are whole days. */
export const MS_PER_DAY = 86_400_000;

/** Round money to the cent; anything finer is a caller bug. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertPlan(input: {
  id?: unknown;
  name?: unknown;
  priceUSD?: unknown;
  periodDays?: unknown;
  includedRuns?: unknown;
}): {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
  includedRuns: number;
} {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const priceUSD = Number(input.priceUSD);
  const periodDays = Number(input.periodDays);
  const includedRuns = Number(input.includedRuns);
  if (!name) throw new Error("Plan name is required.");
  if (!Number.isFinite(priceUSD) || priceUSD <= 0) {
    throw new Error("priceUSD must be a finite positive number.");
  }
  if (!Number.isFinite(periodDays) || periodDays < 1 || Math.floor(periodDays) !== periodDays) {
    throw new Error("periodDays must be a positive integer.");
  }
  if (!Number.isFinite(includedRuns) || includedRuns < 0 || Math.floor(includedRuns) !== includedRuns) {
    throw new Error("includedRuns must be a non-negative integer.");
  }
  return { id, name, priceUSD: round2(priceUSD), periodDays, includedRuns };
}

export function assertSubscriptionStatus(status: unknown): SubscriptionStatus {
  if (status !== "active" && status !== "canceled") {
    throw new Error(`Invalid subscription status: ${String(status)} (must be active or canceled).`);
  }
  return status;
}

/**
 * The effective tier at read time. An unexpired row confers
 * Subscribed even when the stored tier says otherwise (the user
 * paid through periodEnd; the operator's lever is cancellation,
 * not the tier flag). A stored Subscribed tier granted by a
 * subscription confers nothing once every row has expired — the
 * stored tier is NOT restored to a pre-subscription value by
 * magic; it falls back to Free unless an operator granted it
 * (tierSource "operator") or the stored tier is PayPerUse, which
 * survives untouched because activation never overwrites it.
 */
export function resolveEffectiveTier(
  account: { tier: StoreTier; tierSource?: TierSource | null } | null,
  subscriptions: Array<{ periodEndMs: number }>,
  nowMs: number,
): StoreTier {
  if (subscriptions.some((s) => s.periodEndMs > nowMs)) return "Subscribed";
  if (!account) return "Free";
  if (account.tier === "Subscribed" && (account.tierSource ?? "operator") !== "operator") {
    return "Free";
  }
  return account.tier;
}

/**
 * Issue #2522 (slice 3, #2405 Phase 1.3): the tier transition for
 * audit payloads. Pure: both sides are the same
 * resolveEffectiveTier rule applied to the before/after rows, so
 * an audit row can state previous → new effective tier without
 * re-implementing the rule. Callers read the before rows, run
 * their mutation, read the after rows, and audit this pair.
 * Cancel-at-period-end is the unchanged case: periodEndMs is
 * untouched by cancel, so previous and new are equal — the audit
 * states the effective tier at cancel time, not a change.
 */
export function resolveTierTransition(
  previousAccount: { tier: StoreTier; tierSource?: TierSource | null } | null,
  previousSubscriptions: Array<{ periodEndMs: number }>,
  nextAccount: { tier: StoreTier; tierSource?: TierSource | null } | null,
  nextSubscriptions: Array<{ periodEndMs: number }>,
  nowMs: number,
): { previousEffectiveTier: StoreTier; newEffectiveTier: StoreTier } {
  return {
    previousEffectiveTier: resolveEffectiveTier(previousAccount, previousSubscriptions, nowMs),
    newEffectiveTier: resolveEffectiveTier(nextAccount, nextSubscriptions, nowMs),
  };
}

/** Repurchase stacking: a new period starts at the latest paid-through instant, never earlier. */
export function nextPeriodStartMs(existingPeriodEndsMs: number[], nowMs: number): number {
  return Math.max(nowMs, ...existingPeriodEndsMs);
}

/** Patch for a Billing-managed row's provider state. Every field is optional; updatedAtMs is always refreshed. Single-statement update in the D1 adapter. */
export interface ProviderBillingPatch {
  providerSubscriptionId?: string | null;
  providerStatus?: string | null;
  periodStartMs?: number;
  periodEndMs?: number;
  status?: SubscriptionStatus;
  canceledAtMs?: number | null;
}

export interface SubscriptionStore {
  createPlan(input: {
    id?: unknown;
    name?: unknown;
    priceUSD?: unknown;
    periodDays?: unknown;
    includedRuns?: unknown;
  }): Promise<SubscriptionPlanRecord>;
  getPlan(planId: string): Promise<SubscriptionPlanRecord | null>;
  listPlans(activeOnly: boolean): Promise<SubscriptionPlanRecord[]>;
  deactivatePlan(planId: string): Promise<SubscriptionPlanRecord>;
  createSubscription(input: {
    id: string;
    userId: string;
    tenantId: string;
    planId: string;
    provider: string;
    providerPaymentRef: string;
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    providerSubscriptionId?: string | null;
    providerStatus?: string | null;
    periodStartMs: number;
    periodEndMs: number;
  }): Promise<SubscriptionRecord>;
  getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null>;
  /** The Billing-managed row for this provider subscription id, if any — the webhook lookup. Repurchase rows (null id) never match. */
  findByProviderSubscriptionId(providerSubscriptionId: string): Promise<SubscriptionRecord | null>;
  /** Apply a provider-state patch to a Billing-managed row (webhook / cancel flows). Refuses a patch on a missing row. */
  updateProviderBilling(subscriptionId: string, patch: ProviderBillingPatch): Promise<SubscriptionRecord>;
  /** All rows for the user, oldest first. */
  listSubscriptions(userId: string): Promise<SubscriptionRecord[]>;
  /** The subscription activated by this payment reference, if any — the replay guard. */
  findByPaymentRef(providerPaymentRef: string): Promise<SubscriptionRecord | null>;
  /** Cancel every unexpired row for the user (cancel-at-period-end: access continues to periodEnd). */
  cancelUnexpiredSubscriptions(userId: string, nowMs: number): Promise<SubscriptionRecord[]>;
  /**
   * Issue #2656 (Phase 2.1) — cancel ONE row at period end:
   * status canceled, periodEndMs KEPT (access continues to
   * periodEnd), canceledAtMs set. Null when the row does not
   * exist. The Billing-aware cancel route uses this for
   * repurchase rows after provider-canceling Billing rows, so
   * one cancel request never cancels rows it did not mean to
   * (cancelUnexpiredSubscriptions cancels ALL unexpired rows).
   */
  cancelSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null>;
  /**
   * Issue #2204 (refunds) — revoke ONE subscription immediately:
   * status canceled AND periodEndMs moved to nowMs, so the
   * effective tier stops conferring Subscribed at the next read
   * (resolveEffectiveTier keys on periodEndMs, not on status, so
   * cancel alone cannot revoke). Returns the updated row, or null
   * when the id is unknown. This is the full-refund consequence
   * for policy effect "revoke_immediately"; it changes no other
   * subscription semantics.
   */
  revokeSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null>;
}
