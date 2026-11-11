/**
 * Issues #2020/#2127 — purchase activation service.
 *
 * Port-level logic with no fetch and no flag reads, so it is
 * unit-testable without a payment rail: the route verifies the
 * payment (flag ON, provider state re-read and judged paid) and
 * then calls here. Native callers pass provider "stripe" plus the
 * Stripe session/payment-intent ids; legacy callers pass nothing
 * and keep provider "cfpay" with null Stripe ids.
 *
 * Activation, in order:
 * 1. The plan must exist and be active (an operator-deactivated
 *    plan cannot be bought, even with a valid checkout).
 * 2. The payment reference must be unused (replay guard — the
 *    UNIQUE index on provider_payment_ref is the backstop).
 * 3. The period stacks from the latest paid-through instant, so
 *    repurchase before expiry loses no paid time.
 * 4. The account keeps its stored tier (the operator-managed
 *    baseline) and gains tierSource "subscription" plus the
 *    plan's included runs. The effective tier is Subscribed
 *    while the period is unexpired (see resolveEffectiveTier);
 *    activation never overwrites the baseline, so a lapse
 *    restores PayPerUse instead of dropping the user to Free.
 * 5. Tenant: an existing account with a different tenant refuses
 *    (no cross-tenant activation); a missing account is created
 *    in the caller's tenant (the tenant is pinned from then on).
 *
 * Issue #3244 adds grantSubscription below: the same activation
 * shape for an operator grant (no payment, provider "operator"),
 * except the target account must already exist — its row is the
 * grant's only tenant source.
 */
import type { CommercialAccountRecord, CommercialStore } from "../data/commercialPorts";
import {
  MS_PER_DAY,
  nextPeriodStartMs,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "../data/subscriptionPorts";

export interface ActivationInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  userId: string;
  tenantId: string;
  plan: SubscriptionPlanRecord;
  providerPaymentRef: string;
  /** Native only: defaults to "cfpay" so existing callers are unchanged. */
  provider?: string;
  /** Native only: the Stripe session + payment-intent ids, stored for refunds (#2198). Null when absent. */
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  nowMs?: number;
}

export interface ActivationResult {
  subscription: SubscriptionRecord;
  account: CommercialAccountRecord;
}

/**
 * Issue #3289 — validate a plan version is approved and active.
 * The plan row IS a version, so its approval is per-version: a
 * PROPOSED version is never chargeable, and a deactivated
 * version is never buyable. Used by the purchase path
 * (activateSubscription), which validates approved+active ONLY
 * — not effective: a checkout minted for plan X must still
 * activate after an operator launches a new version in between,
 * or a paid checkout would strand (the mint-time effective
 * check is the route's job).
 */
export function assertPlanApprovedAndActive(plan: SubscriptionPlanRecord): void {
  if (!plan.active) throw new Error(`Plan ${plan.id} is not active.`);
  if (plan.approvalStatus !== "approved") {
    throw new Error(
      `Plan ${plan.id} is not approved (status: ${plan.approvalStatus}): refusing to activate an unapproved price (fail-closed).`,
    );
  }
}

/**
 * Issue #3289 — validate a plan version is effective + approved
 * FOR THE BUYER'S SEGMENT at purchase/trial start. The buyer
 * buys the effective version for their segment, never a stale,
 * future, expired, deactivated, or unapproved one, and never a
 * version effective only for another segment. The effective
 * lookup uses the store's getEffectiveVersion (the one
 * resolver), so the check cannot drift from the GET /plans
 * listing the buyer chose from. Used by the trial path
 * (activateTrialSubscription), where no payment has been taken
 * yet and refusing a superseded version costs the buyer
 * nothing — they re-list and trial the current version.
 */
export async function assertPlanEffectiveAndApprovedForSegment(
  subs: SubscriptionStore,
  plan: SubscriptionPlanRecord,
  segment: string,
  nowMs: number = Date.now(),
): Promise<void> {
  assertPlanApprovedAndActive(plan);
  const effective = await subs.getEffectiveVersion(plan.productId, segment, nowMs);
  if (!effective || effective.id !== plan.id) {
    throw new Error(
      `Plan ${plan.id} is not the effective version for product ${plan.productId} in segment ${segment}: refusing to activate a version the buyer cannot currently buy (fail-closed).`,
    );
  }
}

export interface GrantInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  userId: string;
  plan: SubscriptionPlanRecord;
  /** Verified operator login performing the grant (recorded in the route audit, not on the row). */
  grantedBy: string;
  nowMs?: number;
}

/**
 * Issue #3244 (slice 2 of #3241) — operator subscription grant.
 *
 * Mirrors activateSubscription exactly, minus the payment:
 * 1. The plan must exist and be active (an operator-deactivated
 *    plan cannot be granted either).
 * 2. The target account must already exist: its row is the only
 *    tenant source (a grant never takes a client-supplied
 *    tenantId, and there is no tenant to invent for a missing
 *    account — the operator creates the account first through
 *    the existing Accounts UI flow). This is the one deliberate
 *    difference from activation, which auto-creates the account
 *    in the session-derived tenant after verified payment.
 * 3. The period stacks from the latest paid-through instant, so
 *    a re-grant before expiry loses no granted time.
 * 4. The account keeps its stored tier and gains tierSource
 *    "subscription" plus the plan's included runs — the gate
 *    reads included runs from the account row only, so a
 *    row-only grant would enable nothing (the Billing-path gap).
 *    The effective tier is Subscribed while the period is
 *    unexpired (see resolveEffectiveTier); at expiry it falls
 *    back to the stored baseline and the normal gate resumes.
 * 5. No checkout, no Stripe record: provider is "operator", the
 *    payment ref is a minted `grant-` id (unique per grant, so
 *    the replay guard can never collide), both Stripe ids null.
 */
export async function grantSubscription(input: GrantInput): Promise<ActivationResult> {
  const { subs, store, userId, plan } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!plan.active) throw new Error(`Plan ${plan.id} is not active.`);
  if (!input.grantedBy) throw new Error("grantedBy is required.");
  const existing = await store.getAccount(userId);
  if (!existing) {
    throw new Error(
      "No commercial account exists for this user; an operator must create the account first.",
    );
  }
  const tenantId = existing.tenantId;
  const prior = await subs.listSubscriptions(userId);
  const periodStartMs = nextPeriodStartMs(
    prior.map((s) => s.periodEndMs),
    nowMs,
  );
  const periodEndMs = periodStartMs + plan.periodDays * MS_PER_DAY;
  const subscription = await subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId: plan.id,
    provider: "operator",
    providerPaymentRef: `grant-${crypto.randomUUID()}`,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    periodStartMs,
    periodEndMs,
  });
  const account = await store.upsertAccount({
    userId,
    tenantId,
    tier: existing.tier,
    tierSource: "subscription",
    creditsUSD: existing.creditsUSD,
    includedRuns: existing.includedRuns + plan.includedRuns,
  });
  return { subscription, account };
}

export async function activateSubscription(input: ActivationInput): Promise<ActivationResult> {
  const { subs, store, userId, tenantId, plan, providerPaymentRef } = input;
  const nowMs = input.nowMs ?? Date.now();
  // Issue #3289: approved+active only (NOT effective) — see
  // assertPlanApprovedAndActive: a paid checkout must not
  // strand because a new version launched after mint.
  assertPlanApprovedAndActive(plan);
  if (!providerPaymentRef) throw new Error("providerPaymentRef is required.");
  const replay = await subs.findByPaymentRef(providerPaymentRef);
  if (replay) {
    throw new Error(`Payment reference ${providerPaymentRef} already activated subscription ${replay.id}.`);
  }
  const existing = await store.getAccount(userId);
  if (existing && existing.tenantId !== tenantId) {
    throw new Error("Tenant mismatch: subscription tenant must equal the verified account tenant.");
  }
  const prior = await subs.listSubscriptions(userId);
  const periodStartMs = nextPeriodStartMs(
    prior.map((s) => s.periodEndMs),
    nowMs,
  );
  const periodEndMs = periodStartMs + plan.periodDays * MS_PER_DAY;
  const subscription = await subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId: plan.id,
    provider: input.provider ?? "cfpay",
    providerPaymentRef,
    stripeSessionId: input.stripeSessionId ?? null,
    stripePaymentIntentId: input.stripePaymentIntentId ?? null,
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
  return { subscription, account };
}
