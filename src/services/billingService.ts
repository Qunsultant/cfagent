/**
 * Issue #2202 (sub-issue of #2020, implementation of design
 * #2145) — billing service: port-level orchestration over
 * the BillingPort, the billing-policy store, and the
 * subscription store. No fetch, no env read, no flag read,
 * no gateway SDK: the caller verifies the monetization
 * flag (via the composition root, which returns null when
 * the flag is OFF) and verifies webhook signatures (via
 * PaymentGatewayService.verifyWebhookSignature) before
 * calling here. The repurchase path
 * (subscriptionActivation.ts) is NOT touched by this
 * service and stays the live behavior until activation.
 *
 * Grandfather rule (policy default, PROPOSED pending owner
 * approval): with repurchaseMigration "grandfather", this
 * service never migrates, expires, or rewrites a
 * repurchase row. Billing state is looked up BY PROVIDER
 * SUBSCRIPTION ID, so a repurchase row (provider id null)
 * can never be matched by a Billing webhook, and create
 * here always writes a NEW provider-managed row through
 * the subscription store — it never converts an existing
 * row. The "expire" and "migrate" policy values are
 * operator choices recorded for a future activation slice;
 * this slice refuses to act on them (see
 * assertActivationPolicy) rather than silently picking a
 * migration behaviour the owner has not approved.
 *
 * Access model (additive — resolveEffectiveTier is
 * unchanged): billingAccessFor answers full / grace /
 * none for a provider-managed row. Grace is measured from
 * the current period end (the renewal point): a past_due
 * row keeps access until periodEnd + gracePeriodDays.
 * That is a stated simplification — the first-failure
 * instant is not stored on the row in this slice, so a
 * failure that arrives mid-period is not distinguished
 * from one at renewal. Downgrade timing "period_end"
 * keeps access to periodEnd after cancellation;
 * "immediate" truncates it at the cancel instant.
 */
import type { BillingPolicy, BillingPolicyStore } from "../data/billingPolicyPorts";
import { MS_PER_DAY, type SubscriptionRecord, type SubscriptionStore } from "../data/subscriptionPorts";
import type { BillingPort, ProviderSubscription } from "./billingPorts";

export type BillingAccess = "full" | "grace" | "none";

/** A row is Billing-managed iff it carries a provider subscription id; repurchase rows (null) are never Billing-managed. */
export function isBillingManaged(record: { providerSubscriptionId?: string | null }): boolean {
  return Boolean(record.providerSubscriptionId);
}

/**
 * Pure access decision for a provider-managed row. Rows
 * without a provider status are not Billing-managed and
 * return "none" here — their access is decided by the
 * existing repurchase/tier rules, never by this helper.
 */
export function billingAccessFor(
  record: { providerStatus?: string | null; periodEndMs: number; status?: string },
  policy: BillingPolicy,
  nowMs: number,
): BillingAccess {
  const providerStatus = record.providerStatus ?? null;
  if (providerStatus === "active" || providerStatus === "trialing") return "full";
  if (providerStatus === "past_due") {
    return nowMs <= record.periodEndMs + policy.gracePeriodDays * MS_PER_DAY ? "grace" : "none";
  }
  if (providerStatus === "canceled") {
    if (policy.downgradeTiming === "period_end" && record.periodEndMs > nowMs) return "full";
    return "none";
  }
  // unpaid, incomplete, incomplete_expired, paused, unknown: no access.
  return "none";
}

/** Next dunning notice instant for a failure at failureMs, or null when the schedule is exhausted. */
export function nextDunningNoticeMs(policy: BillingPolicy, failureMs: number, attemptIndex: number): number | null {
  const delay = policy.dunningRetryDelayDays[attemptIndex];
  if (delay === undefined) return null;
  return failureMs + delay * MS_PER_DAY;
}

function assertGrandfatherOnly(policy: BillingPolicy): void {
  if (policy.repurchaseMigration !== "grandfather") {
    throw new Error(
      `Billing activation refuses repurchaseMigration "${policy.repurchaseMigration}": only "grandfather" is implemented in this slice; expire/migrate need a separate owner-approved activation slice.`,
    );
  }
}

export interface CreateBillingSubscriptionInput {
  billing: BillingPort;
  policyStore: BillingPolicyStore;
  subs: SubscriptionStore;
  userId: string;
  tenantId: string;
  /** Local plan record (operator data). Its price id comes from policy, never from plan.priceUSD. */
  plan: { id: string };
  /** Stripe customer id (cus_*), supplied by the caller (future route owns customer mapping). */
  stripeCustomerId: string;
  /** Requested period; defaults to the policy default and must be in the allowed list. */
  billingPeriod?: string;
  defaultPaymentMethodId?: string;
  nowMs?: number;
}

/**
 * Create a provider-managed subscription and record it as
 * a NEW subscription row (provider "stripe", provider
 * payment ref = provider subscription id for the replay
 * guard's key shape — the row's own provider id is the
 * authoritative join key). Refuses when the plan has no
 * operator-mapped Stripe Price id, when the period is not
 * allowed, or when the migration policy is not
 * grandfather. Does NOT touch any existing repurchase row.
 */
export async function createBillingSubscription(input: CreateBillingSubscriptionInput): Promise<{
  subscription: SubscriptionRecord;
  provider: ProviderSubscription;
}> {
  const { billing, policyStore, subs, userId, tenantId, plan } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!input.stripeCustomerId?.trim()) throw new Error("stripeCustomerId is required.");
  const policy = await policyStore.getPolicy();
  assertGrandfatherOnly(policy);
  const priceId = policy.stripePriceByPlan[plan.id];
  if (!priceId) {
    throw new Error(`No operator-mapped Stripe Price id for plan ${plan.id}: refusing a Billing create (fail closed).`);
  }
  const period = input.billingPeriod ?? policy.billingPeriodDefault;
  if (!policy.billingPeriodsAllowed.includes(period as "monthly" | "annual")) {
    throw new Error(`Billing period "${period}" is not in the allowed periods (${policy.billingPeriodsAllowed.join(", ")}).`);
  }
  const provider = await billing.createProviderSubscription({
    customerId: input.stripeCustomerId,
    priceId,
    defaultPaymentMethodId: input.defaultPaymentMethodId,
    metadata: { cfagent_tenant_id: tenantId, cfagent_user_id: userId, cfagent_plan_id: plan.id, billing_period: period },
  });
  if (!provider.providerSubscriptionId) throw new Error("Provider returned no subscription id: refusing to record a Billing subscription.");
  const periodStartMs = provider.currentPeriodStartMs ?? nowMs;
  const periodEndMs = provider.currentPeriodEndMs ?? periodStartMs;
  if (!(periodEndMs > periodStartMs)) {
    throw new Error("Provider returned no usable current period: refusing to record a Billing subscription.");
  }
  const subscription = await subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId: plan.id,
    provider: "stripe",
    providerPaymentRef: provider.providerSubscriptionId,
    providerSubscriptionId: provider.providerSubscriptionId,
    providerStatus: provider.status,
    periodStartMs,
    periodEndMs,
  });
  return { subscription, provider };
}

/**
 * Issue #2656 (Phase 2.1) — record a Billing-managed row from an
 * ALREADY-VERIFIED provider subscription object (the fulfillment
 * route verified the Checkout session + retrieved this object
 * before calling here). This is the Checkout-fulfillment twin
 * of createBillingSubscription: createBillingSubscription
 * creates the provider subscription itself (operator flow);
 * this one never calls the provider — it only records what
 * the provider already returned.
 *
 * Idempotent on provider id: a replay returns the existing
 * row (the route maps that to 409, like the one-time replay
 * guard). An existing row claimed by a DIFFERENT user or
 * tenant THROWS (possible account confusion — never a silent
 * reassign). A missing provider id or an unusable period
 * THROWS (never invent a period). The row is a NEW provider
 * row: it never converts a repurchase row (grandfather rule).
 */
export async function recordBillingSubscription(input: {
  subs: SubscriptionStore;
  provider: ProviderSubscription;
  userId: string;
  tenantId: string;
  planId: string;
  nowMs?: number;
}): Promise<SubscriptionRecord> {
  const { subs, provider, userId, tenantId, planId } = input;
  const nowMs = input.nowMs ?? Date.now();
  const providerId = provider.providerSubscriptionId;
  if (!providerId?.trim()) {
    throw new Error("Provider returned no subscription id: refusing to record a Billing subscription.");
  }
  const existing = await subs.findByProviderSubscriptionId(providerId);
  if (existing) {
    if (existing.userId !== userId || existing.tenantId !== tenantId) {
      throw new Error(
        `Billing subscription ${providerId} already belongs to another user/tenant: refusing to reassign (operator resolves).`,
      );
    }
    return existing;
  }
  const periodStartMs = provider.currentPeriodStartMs ?? nowMs;
  const periodEndMs = provider.currentPeriodEndMs ?? periodStartMs;
  if (!(periodEndMs > periodStartMs)) {
    throw new Error("Provider returned no usable current period: refusing to record a Billing subscription.");
  }
  return subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId,
    provider: "stripe",
    providerPaymentRef: providerId,
    providerSubscriptionId: providerId,
    providerStatus: provider.status,
    periodStartMs,
    periodEndMs,
  });
}

/** Cancel a Billing-managed row at period end, on the provider and locally (local status canceled, period end kept). */
export async function cancelBillingAtPeriodEnd(input: {
  billing: BillingPort;
  subs: SubscriptionStore;
  subscriptionId: string;
}): Promise<SubscriptionRecord> {
  const record = await input.subs.getSubscription(input.subscriptionId);
  if (!record) throw new Error(`No subscription ${input.subscriptionId}.`);
  if (!record.providerSubscriptionId) {
    throw new Error("Refusing to Billing-cancel a repurchase subscription: use the repurchase cancel path instead.");
  }
  const provider = await input.billing.cancelProviderAtPeriodEnd(record.providerSubscriptionId);
  return input.subs.updateProviderBilling(record.id, {
    providerStatus: provider.status,
    status: "canceled",
    canceledAtMs: provider.canceledAtMs ?? Date.now(),
  });
}

/** Cancel a Billing-managed row immediately, on the provider and locally (access truncated per policy at apply time). */
export async function cancelBillingImmediately(input: {
  billing: BillingPort;
  subs: SubscriptionStore;
  subscriptionId: string;
  nowMs?: number;
}): Promise<SubscriptionRecord> {
  const nowMs = input.nowMs ?? Date.now();
  const record = await input.subs.getSubscription(input.subscriptionId);
  if (!record) throw new Error(`No subscription ${input.subscriptionId}.`);
  if (!record.providerSubscriptionId) {
    throw new Error("Refusing to Billing-cancel a repurchase subscription: use the repurchase cancel path instead.");
  }
  const provider = await input.billing.cancelProviderImmediately(record.providerSubscriptionId);
  return input.subs.updateProviderBilling(record.id, {
    providerStatus: provider.status,
    status: "canceled",
    canceledAtMs: provider.canceledAtMs ?? nowMs,
    periodEndMs: provider.currentPeriodEndMs ?? nowMs,
  });
}

/** Normalized Billing webhook event (the caller has already verified the signature and parsed the provider payload). */
export interface BillingWebhookEvent {
  type: string;
  /** Provider subscription id the event is about (event.data.object.id for subscription events; invoice.subscription for invoice events). */
  providerSubscriptionId: string;
  /** Full provider subscription object when the event carries one (subscription events); null for invoice events without a retrieve. */
  provider: ProviderSubscription | null;
}

export interface BillingWebhookResult {
  applied: boolean;
  reason: string;
  subscription?: SubscriptionRecord;
}

/**
 * Apply a VERIFIED Billing webhook event. The caller MUST
 * pass verified=true only after
 * PaymentGatewayService.verifyWebhookSignature returned
 * valid; verified=false THROWS before any store read or
 * write — an unverified webhook is rejected, never
 * applied. Unknown provider ids and unknown event types
 * are reported as not-applied (loud log by the caller),
 * never as errors that would make Stripe retry a
 * well-formed but unmatchable event forever. Events are
 * idempotent: re-applying the same provider state writes
 * the same local state.
 */
export async function applyBillingWebhookEvent(input: {
  verified: boolean;
  event: BillingWebhookEvent;
  subs: SubscriptionStore;
  policy: BillingPolicy;
  nowMs?: number;
}): Promise<BillingWebhookResult> {
  if (!input.verified) {
    throw new Error("Refusing to apply an unverified Billing webhook event: signature verification is required.");
  }
  const nowMs = input.nowMs ?? Date.now();
  const record = await input.subs.findByProviderSubscriptionId(input.event.providerSubscriptionId);
  if (!record) {
    return { applied: false, reason: "unknown_provider_subscription" };
  }
  const { type, provider } = input.event;
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    if (!provider) return { applied: false, reason: "missing_provider_object" };
    const patch: Parameters<SubscriptionStore["updateProviderBilling"]>[1] = {
      providerStatus: provider.status,
    };
    if (provider.currentPeriodStartMs !== null) patch.periodStartMs = provider.currentPeriodStartMs;
    if (provider.currentPeriodEndMs !== null) patch.periodEndMs = provider.currentPeriodEndMs;
    // Provider cancel-at-period-end is a local cancel with access kept to period end (tier resolver reads periodEnd).
    if (provider.cancelAtPeriodEnd) {
      patch.status = "canceled";
      patch.canceledAtMs = provider.canceledAtMs ?? nowMs;
    } else if (provider.status === "active" || provider.status === "trialing") {
      patch.status = "active";
      patch.canceledAtMs = null;
    }
    const subscription = await input.subs.updateProviderBilling(record.id, patch);
    return { applied: true, reason: type, subscription };
  }
  if (type === "customer.subscription.deleted") {
    const periodEndMs =
      input.policy.downgradeTiming === "immediate"
        ? nowMs
        : (provider?.currentPeriodEndMs ?? record.periodEndMs);
    const subscription = await input.subs.updateProviderBilling(record.id, {
      providerStatus: provider?.status ?? "canceled",
      status: "canceled",
      canceledAtMs: provider?.canceledAtMs ?? nowMs,
      periodEndMs,
    });
    return { applied: true, reason: type, subscription };
  }
  if (type === "invoice.paid") {
    // Renewal paid: clear a past_due state. Periods only move when the caller supplied a retrieved provider object — an invoice alone never invents a period.
    const patch: Parameters<SubscriptionStore["updateProviderBilling"]>[1] = { providerStatus: "active" };
    if (provider?.currentPeriodStartMs !== null && provider?.currentPeriodStartMs !== undefined) {
      patch.periodStartMs = provider.currentPeriodStartMs as number;
    }
    if (provider?.currentPeriodEndMs !== null && provider?.currentPeriodEndMs !== undefined) {
      patch.periodEndMs = provider.currentPeriodEndMs as number;
    }
    const subscription = await input.subs.updateProviderBilling(record.id, patch);
    return { applied: true, reason: type, subscription };
  }
  if (type === "invoice.payment_failed") {
    const subscription = await input.subs.updateProviderBilling(record.id, { providerStatus: "past_due" });
    return { applied: true, reason: type, subscription };
  }
  return { applied: false, reason: `ignored_event_type:${type}` };
}
