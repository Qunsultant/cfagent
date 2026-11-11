/**
 * Issue #3243 — trial subscription activation service (slice 3
 * of #3241).
 *
 * Port-level logic with no fetch and no flag reads, so it is
 * unit-testable without a payment rail: the trial route checks
 * the caller (flag ON, verified login, plan exists and is
 * active) and then calls here. There is NO Stripe involvement:
 * the survey found no Stripe-trial parameter path in-repo (the
 * Billing checkout port takes price/customer/metadata only),
 * so the trial checkout is honestly our own $0 path — local
 * trialing state, no charge, no Stripe session — and this file
 * says so instead of faking a provider trial.
 *
 * Activation, mirroring activateSubscription (the one-time
 * purchase path) except for the period and the provider:
 * 1. The plan must exist and be active, and must offer a trial
 *    (trialDays is a positive integer, operator data; a null
 *    trialDays means no trial).
 * 2. One trial per user per plan: a prior trial row for this
 *    plan refuses, live or expired.
 * 3. The trial period starts NOW (it does not stack from the
 *    latest paid-through instant the way a repurchase does —
 *    a trial is an evaluation window starting at signup) and
 *    runs trialDays whole days.
 * 4. The row is provider "trial" with providerStatus
 *    "trialing" (see isTrialSubscription in subscriptionPorts);
 *    no Stripe ids. The effective tier is Subscribed while the
 *    row is unexpired, via the existing resolveEffectiveTier
 *    read — and it lapses at periodEnd with no sweeper, the
 *    same rule a lapsed paid subscription follows.
 * 5. THE critical requirement: the account gains the plan's
 *    included runs, exactly like activateSubscription. Tier
 *    alone enables nothing — the gate reads included runs from
 *    the commercial account row only, and the Billing purchase
 *    route confers tier only ("Included-run bypass stays OFF").
 *    A trial that only conferred tier would land the user
 *    exactly where a Free user lands (checkout on manual runs,
 *    skip on scheduled ones).
 * 6. Tenant: same rule as activateSubscription — an existing
 *    account with a different tenant refuses; a missing
 *    account is created in the caller's tenant.
 *
 * Known limit, stated not hidden: the granted runs join the
 * account's single fungible includedRuns counter, so remaining
 * trial runs are NOT clawed back separately at trial end —
 * the same as paid repurchase stacking. The trial-end fallback
 * is the tier lapse (above) plus the outcome-encoded message
 * (trialEndedMessage), which points at the existing at-limit
 * checkout offer. A per-source run ledger would be a separate
 * slice, not invented here.
 */
import type { CommercialAccountRecord, CommercialStore } from "../data/commercialPorts";
import {
  MS_PER_DAY,
  isTrialSubscription,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "../data/subscriptionPorts";
import { assertPlanEffectiveAndApprovedForSegment } from "./subscriptionActivation";

export interface TrialActivationInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  userId: string;
  tenantId: string;
  plan: SubscriptionPlanRecord;
  nowMs?: number;
}

export interface TrialActivationResult {
  subscription: SubscriptionRecord;
  account: CommercialAccountRecord;
  /** The trial end instant: subscription.periodEndMs. */
  trialEndsAtMs: number;
}

/** Outcome-encoded copy for a started trial: what the user got and when it ends, never a raw error code. */
export function trialStartedMessage(input: {
  planName: string;
  trialDays: number;
  includedRuns: number;
  trialEndsAtMs: number;
}): string {
  const endDate = new Date(input.trialEndsAtMs).toISOString().slice(0, 10);
  return (
    `Your ${input.trialDays}-day free trial of ${input.planName} started: ` +
    `${input.includedRuns} included runs, ending ${endDate}. ` +
    `No payment was taken. When the trial ends, subscribe or pay per run to keep running screens.`
  );
}

/** Outcome-encoded copy for a lapsed trial: the fallback, never a raw error code. */
export function trialEndedMessage(planName: string): string {
  return (
    `Your free trial of ${planName} has ended. ` +
    `Subscribe or pay per run to keep running screens.`
  );
}

export async function activateTrialSubscription(
  input: TrialActivationInput,
): Promise<TrialActivationResult> {
  const { subs, store, userId, tenantId, plan } = input;
  const nowMs = input.nowMs ?? Date.now();
  const existing = await store.getAccount(userId);
  // Issue #3289: a trial starts the effective, approved version
  // FOR THE BUYER'S SEGMENT (their account's segment, "default"
  // when no account exists yet) — never a superseded, future,
  // expired, or unapproved version. No payment has been taken,
  // so refusing costs the buyer nothing.
  await assertPlanEffectiveAndApprovedForSegment(
    subs,
    plan,
    existing?.segment ?? "default",
    nowMs,
  );
  const trialDays = plan.trialDays;
  if (trialDays === null || trialDays === undefined || !Number.isInteger(trialDays) || trialDays < 1) {
    throw new Error(`Plan ${plan.id} offers no trial.`);
  }
  if (existing && existing.tenantId !== tenantId) {
    throw new Error("Tenant mismatch: subscription tenant must equal the verified account tenant.");
  }
  const prior = await subs.listSubscriptions(userId);
  if (prior.some((s) => s.planId === plan.id && isTrialSubscription(s))) {
    throw new Error(`Trial for plan ${plan.id} already used.`);
  }
  const periodStartMs = nowMs;
  const periodEndMs = periodStartMs + trialDays * MS_PER_DAY;
  const subscription = await subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId: plan.id,
    provider: "trial",
    providerPaymentRef: `trial-${crypto.randomUUID().slice(0, 8)}`,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    providerSubscriptionId: null,
    providerStatus: "trialing",
    periodStartMs,
    periodEndMs,
  });
  const account = await store.upsertAccount({
    userId,
    tenantId,
    tier: existing?.tier ?? "Free",
    tierSource: "subscription",
    creditsUSD: existing?.creditsUSD ?? 0,
    includedRuns: (existing?.includedRuns ?? 0) + plan.includedRuns,
  });
  return { subscription, account, trialEndsAtMs: periodEndMs };
}
