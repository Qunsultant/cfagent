/**
 * Issue #6141 — referral trial-extension engine (Grafana-style, adapted).
 *
 * The time reward for referrals: a referrer earns the rule's
 * extensionDays of trial time per referred user's first verified
 * paid run (the 2.27 earn event), and a referred user is granted
 * the rule's referredTrialDays on signup via the link. Extensions
 * accumulate; when the referrer has no active trial the days bank
 * as free days, expiring per the D-2.31 rule (90 days, PROPOSED).
 *
 * D-2.25, enforced by construction: this module takes NO
 * commercial store and NO payment input — it extends a trial's
 * periodEndMs or writes the extension ledger, and nothing else.
 * It never mints a subscription, never pays for a plan, never
 * converts to credits. The grant is best-effort from the caller's
 * side: a grant failure must never fail the run or the signup
 * that triggered it (the caller logs + audits and continues).
 *
 * Idempotency: one extension per referred user, ever — the ledger
 * id is deterministic (`trial-ext:<referredUserId>`), so a
 * replayed earn event returns the existing row and extends
 * nothing. Caps count ledger rows (UTC day / UTC calendar month).
 */
import {
  MS_PER_DAY,
  isTrialSubscription,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "../data/subscriptionPorts";
import {
  bankedExtensionDaysFor,
  isExtensionExpired,
  trialExtensionId,
  type LifecycleStore,
  type ReferralTrialExtension,
} from "../data/lifecyclePorts";
import { BusinessError } from "../outcomes/outcomeAspects";

/** The stores the extension engine needs. No commercial store — D-2.25 by construction. */
export interface TrialExtensionDeps {
  lifecycle: LifecycleStore;
  subs: SubscriptionStore;
}

export type GrantOutcome = "applied" | "banked" | "cap_refused" | "replayed";

export interface GrantTrialExtensionResult {
  extension: ReferralTrialExtension | null;
  outcome: GrantOutcome;
}

function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcMonth(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function activeTrialEnd(
  subscriptions: SubscriptionRecord[],
  nowMs: number,
): SubscriptionRecord | null {
  let best: SubscriptionRecord | null = null;
  for (const s of subscriptions) {
    if (!isTrialSubscription(s)) continue;
    if (s.status !== "active") continue;
    if (s.periodEndMs <= nowMs) continue;
    if (!best || s.periodEndMs > best.periodEndMs) best = s;
  }
  return best;
}

/**
 * Grant one trial extension for a referred user's first verified
 * paid run. Applied to the referrer's active trial when one
 * exists; banked as free days otherwise. Cap-refused grants are
 * a skip (outcome "cap_refused", extension null), never a throw
 * — the caller audits the skip and the run proceeds. A replay
 * returns the existing row. Throws only on blank ids or
 * self-referral (caller bugs, not earn events).
 */
export async function grantTrialExtension(
  deps: TrialExtensionDeps,
  input: { referrerUserId: string; referredUserId: string; tenantId: string; nowMs: number },
): Promise<GrantTrialExtensionResult> {
  const referrerUserId = input.referrerUserId.trim();
  const referredUserId = input.referredUserId.trim();
  const tenantId = input.tenantId.trim();
  if (!referrerUserId || !referredUserId || !tenantId) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  if (referrerUserId === referredUserId) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const nowMs = input.nowMs;
  const id = trialExtensionId(referredUserId);
  // Idempotency first: a replay never counts toward caps and
  // never extends twice.
  const existing = (await deps.lifecycle.listExtensions(referrerUserId)).find((e) => e.id === id);
  if (existing) return { extension: existing, outcome: "replayed" };
  const rules = await deps.lifecycle.getRules();
  // Caps: UTC day, then UTC calendar month. The first refusal stops.
  const dayCount = await deps.lifecycle.countExtensionsSince(referrerUserId, startOfUtcDay(nowMs));
  if (dayCount >= rules.maxExtensionsPerDay) {
    return { extension: null, outcome: "cap_refused" };
  }
  const monthCount = await deps.lifecycle.countExtensionsSince(referrerUserId, startOfUtcMonth(nowMs));
  if (monthCount >= rules.maxExtensionsPerMonth) {
    return { extension: null, outcome: "cap_refused" };
  }
  const expiresAtMs =
    rules.expiryPeriodMs > 0 ? nowMs + rules.expiryPeriodMs : null;
  const trial = activeTrialEnd(await deps.subs.listSubscriptions(referrerUserId), nowMs);
  if (trial) {
    const newEndMs = trial.periodEndMs + rules.extensionDays * MS_PER_DAY;
    await deps.subs.updateProviderBilling(trial.id, { periodEndMs: newEndMs });
    const extension = await deps.lifecycle.recordExtension({
      id,
      referrerUserId,
      referredUserId,
      tenantId,
      daysGranted: rules.extensionDays,
      status: "applied",
      subscriptionId: trial.id,
      grantedAtMs: nowMs,
      expiresAtMs,
      appliedAtMs: nowMs,
      consumedAtMs: null,
    });
    return { extension, outcome: "applied" };
  }
  const extension = await deps.lifecycle.recordExtension({
    id,
    referrerUserId,
    referredUserId,
    tenantId,
    daysGranted: rules.extensionDays,
    status: "banked",
    subscriptionId: null,
    grantedAtMs: nowMs,
    expiresAtMs,
    appliedAtMs: null,
    consumedAtMs: null,
  });
  return { extension, outcome: "banked" };
}

/**
 * Apply a user's unexpired banked days to a trial, oldest-expiring
 * first (D-2.31 first-expired-first-out). Expired banked days are
 * never applied. One periodEndMs update for the whole batch.
 */
export async function applyBankedExtensions(
  deps: TrialExtensionDeps,
  input: { userId: string; subscriptionId: string; nowMs: number },
): Promise<{ daysApplied: number; consumedIds: string[] }> {
  const subscription = await deps.subs.getSubscription(input.subscriptionId);
  if (!subscription || !isTrialSubscription(subscription) || subscription.status !== "active") {
    throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
  }
  if (subscription.periodEndMs <= input.nowMs) {
    throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
  }
  const banked = (await deps.lifecycle.listExtensions(input.userId))
    .filter((e) => e.status === "banked" && !isExtensionExpired(e, input.nowMs))
    .sort(
      (a, b) =>
        (a.expiresAtMs ?? Number.POSITIVE_INFINITY) - (b.expiresAtMs ?? Number.POSITIVE_INFINITY) ||
        a.grantedAtMs - b.grantedAtMs,
    );
  if (banked.length === 0) return { daysApplied: 0, consumedIds: [] };
  const daysApplied = banked.reduce((s, e) => s + e.daysGranted, 0);
  await deps.subs.updateProviderBilling(subscription.id, {
    periodEndMs: subscription.periodEndMs + daysApplied * MS_PER_DAY,
  });
  const consumedIds: string[] = [];
  for (const e of banked) {
    await deps.lifecycle.markExtensionConsumed(e.id, subscription.id, input.nowMs);
    consumedIds.push(e.id);
  }
  return { daysApplied, consumedIds };
}

/**
 * Extend one trial row by days. Validates the row is a trial, is
 * active, and is unexpired — a paid row, a canceled row, or an
 * expired trial refuses (409 at the caller, never a silent no-op).
 */
export async function extendTrialSubscription(
  deps: TrialExtensionDeps,
  input: { subscriptionId: string; days: number; nowMs: number },
): Promise<SubscriptionRecord> {
  const subscription = await deps.subs.getSubscription(input.subscriptionId);
  if (!subscription || !isTrialSubscription(subscription)) {
    throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
  }
  if (subscription.status !== "active" || subscription.periodEndMs <= input.nowMs) {
    throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
  }
  if (!Number.isInteger(input.days) || input.days < 1) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return deps.subs.updateProviderBilling(subscription.id, {
    periodEndMs: subscription.periodEndMs + input.days * MS_PER_DAY,
  });
}

/**
 * The profile panel's numbers for one user: referred users who
 * completed their first paid run (the earnings rail), extension
 * day totals from the ledger, and the active trial's end.
 */
export async function trialExtensionSummary(
  deps: TrialExtensionDeps,
  input: { userId: string; nowMs: number },
): Promise<{
  referredCount: number;
  totalExtensionDays: number;
  appliedDays: number;
  bankedDays: number;
  expiredDays: number;
  trialEndsAtMs: number | null;
}> {
  const [earnings, extensions, subscriptions] = await Promise.all([
    deps.lifecycle.listEarnings(input.userId),
    deps.lifecycle.listExtensions(input.userId),
    deps.subs.listSubscriptions(input.userId),
  ]);
  const totalExtensionDays = extensions.reduce((s, e) => s + e.daysGranted, 0);
  const appliedDays = extensions
    .filter((e) => e.status === "applied" || e.status === "consumed")
    .reduce((s, e) => s + e.daysGranted, 0);
  const bankedDays = bankedExtensionDaysFor(extensions, input.nowMs);
  const expiredDays = extensions
    .filter((e) => e.status === "banked" && isExtensionExpired(e, input.nowMs))
    .reduce((s, e) => s + e.daysGranted, 0);
  const trial = activeTrialEnd(subscriptions, input.nowMs);
  return {
    referredCount: earnings.length,
    totalExtensionDays,
    appliedDays,
    bankedDays,
    expiredDays,
    trialEndsAtMs: trial ? trial.periodEndMs : null,
  };
}

/**
 * Render the rule's share-message template. {link} and {trialDays}
 * are replaced; any other braces pass through untouched. Throws
 * when the template lacks {link} — the rule validator guarantees
 * it, so a throw here is a caller bug, never a user error.
 */
export function renderShareMessage(
  template: string,
  input: { trialDays: number; link: string },
): string {
  if (!template.includes("{link}")) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return template.replaceAll("{trialDays}", String(input.trialDays)).replaceAll("{link}", input.link);
}
