/**
 * Issue #6141 — referral trial-extension model (Grafana-style, adapted).
 *
 * TDD suite for the trial-extension engine: rule extension fields,
 * grant (apply-to-trial vs bank), caps, idempotency, expiry,
 * first-expired-first-out banked apply, the referred-trial grant,
 * and the D-2.25 boundary (time only — the engine never touches a
 * commercial balance, never mints a subscription, never pays for a
 * plan, never converts to credits).
 *
 * The engine reuses the 2.27 attribution + 2.2/2.31 ledger/expiry
 * rail: a grant fires on a referred user's first verified paid run
 * (the earning event), one extension per referred user, ever.
 */
import { describe, expect, it } from "vitest";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  DEFAULT_MAX_EXTENSIONS_PER_DAY,
  DEFAULT_MAX_EXTENSIONS_PER_MONTH,
  DEFAULT_REFERRED_TRIAL_DAYS,
  DEFAULT_REFERRAL_EXTENSION_DAYS,
  DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE,
  bankedExtensionDaysFor,
  isExtensionExpired,
  trialExtensionId,
  validateReferralRules,
} from "../src/data/lifecyclePorts";
import {
  MS_PER_DAY,
  type SubscriptionPlanRecord,
} from "../src/data/subscriptionPorts";
import { activateTrialSubscription } from "../src/services/trialSubscriptionActivation";
import {
  applyBankedExtensions,
  extendTrialSubscription,
  grantTrialExtension,
  renderShareMessage,
  trialExtensionSummary,
} from "../src/services/referralTrialExtensions";

const REFERRER = "alice";
const TENANT = "tenant-alice";

function makeAdapters() {
  return {
    lifecycle: new InMemoryLifecycleAdapter(),
    subs: new InMemorySubscriptionAdapter(),
    commercial: new InMemoryCommercialAdapter(),
  };
}

async function makeTrialPlan(
  subs: InMemorySubscriptionAdapter,
  trialDays = 14,
): Promise<SubscriptionPlanRecord> {
  const created = await subs.createPlan({
    name: "Basic",
    priceUSD: 49.99,
    periodDays: 30,
    includedRuns: 10,
    trialDays,
    // Effective from the epoch so the fixed test instants (2026-11-22)
    // fall inside the version window regardless of wall-clock time.
    effectiveFromMs: 0,
  });
  // Issue #3289: trial activation validates the version is
  // effective + approved for the buyer's segment — approve the
  // fixture plan (and re-read it: createPlan returns PROPOSED).
  await subs.approvePlan(created.id, "test-operator");
  return (await subs.getPlan(created.id))!;
}

async function startTrial(
  adapters: ReturnType<typeof makeAdapters>,
  userId: string,
  plan: SubscriptionPlanRecord,
  nowMs: number,
) {
  return activateTrialSubscription({
    subs: adapters.subs,
    store: adapters.commercial,
    userId,
    tenantId: TENANT,
    plan,
    nowMs,
  });
}

describe("6141 rule extension fields", () => {
  it("seeds the PROPOSED extension defaults", async () => {
    const { lifecycle } = makeAdapters();
    const rules = await lifecycle.getRules();
    expect(rules.extensionDays).toBe(7);
    expect(rules.referredTrialDays).toBe(14);
    expect(rules.maxExtensionsPerDay).toBe(3);
    expect(rules.maxExtensionsPerMonth).toBe(10);
    expect(rules.referralTrialPlanId).toBeNull();
    expect(rules.shareMessageTemplate).toBe(DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE);
    expect(DEFAULT_REFERRAL_EXTENSION_DAYS).toBe(7);
    expect(DEFAULT_REFERRED_TRIAL_DAYS).toBe(14);
    expect(DEFAULT_MAX_EXTENSIONS_PER_DAY).toBe(3);
    expect(DEFAULT_MAX_EXTENSIONS_PER_MONTH).toBe(10);
  });

  it("setRules accepts extension fields and keeps the credit fields", async () => {
    const { lifecycle } = makeAdapters();
    const updated = await lifecycle.setRules({
      earnAmountUSD: 0.5,
      vestingDelayMs: 604800000,
      redemptionScope: "pay-per-run",
      expiryPeriodMs: 7776000000,
      extensionDays: 5,
      referredTrialDays: 21,
      maxExtensionsPerDay: 2,
      maxExtensionsPerMonth: 6,
      referralTrialPlanId: "plan-basic",
      shareMessageTemplate: "Join me: {link} ({trialDays} days free)",
    });
    expect(updated.extensionDays).toBe(5);
    expect(updated.referredTrialDays).toBe(21);
    expect(updated.maxExtensionsPerDay).toBe(2);
    expect(updated.maxExtensionsPerMonth).toBe(6);
    expect(updated.referralTrialPlanId).toBe("plan-basic");
    expect(updated.shareMessageTemplate).toBe("Join me: {link} ({trialDays} days free)");
    expect(updated.earnAmountUSD).toBe(0.5);
  });

  it("absent extension fields keep the seeded defaults (2.31 pattern)", async () => {
    const { lifecycle } = makeAdapters();
    const updated = await lifecycle.setRules({
      earnAmountUSD: 1,
      vestingDelayMs: 0,
      redemptionScope: "pay-per-run",
    });
    expect(updated.extensionDays).toBe(7);
    expect(updated.referredTrialDays).toBe(14);
    expect(updated.maxExtensionsPerDay).toBe(3);
    expect(updated.maxExtensionsPerMonth).toBe(10);
    expect(updated.referralTrialPlanId).toBeNull();
  });

  it("rejects bad extension values", () => {
    const base = {
      earnAmountUSD: 0.5,
      vestingDelayMs: 0,
      redemptionScope: "pay-per-run" as const,
    };
    expect(() => validateReferralRules({ ...base, extensionDays: 0 })).toThrow();
    expect(() => validateReferralRules({ ...base, extensionDays: 1.5 })).toThrow();
    expect(() => validateReferralRules({ ...base, referredTrialDays: -1 })).toThrow();
    expect(() => validateReferralRules({ ...base, maxExtensionsPerDay: 0 })).toThrow();
    expect(() => validateReferralRules({ ...base, maxExtensionsPerMonth: 0 })).toThrow();
    expect(() => validateReferralRules({ ...base, referralTrialPlanId: "" })).toThrow();
    expect(() =>
      validateReferralRules({ ...base, shareMessageTemplate: "Join me (no link here)" }),
    ).toThrow();
    expect(() => validateReferralRules({ ...base, shareMessageTemplate: "" })).toThrow();
  });
});

describe("6141 grant: apply to an active trial", () => {
  it("extends the referrer's active trial by the rule's extension days", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs);
    const originalEnd = subscription.periodEndMs;
    const result = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    expect(result.outcome).toBe("applied");
    expect(result.extension.daysGranted).toBe(7);
    expect(result.extension.status).toBe("applied");
    expect(result.extension.subscriptionId).toBe(subscription.id);
    const rows = await adapters.subs.listSubscriptions(REFERRER);
    expect(rows[0].periodEndMs).toBe(originalEnd + 7 * MS_PER_DAY);
  });

  it("accumulates: a second referred user extends the trial again", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs);
    const originalEnd = subscription.periodEndMs;
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "carol",
      tenantId: TENANT,
      nowMs: nowMs + 2000,
    });
    const rows = await adapters.subs.listSubscriptions(REFERRER);
    expect(rows[0].periodEndMs).toBe(originalEnd + 14 * MS_PER_DAY);
  });

  it("is idempotent per referred user: a replay returns the existing row and extends nothing", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs);
    const originalEnd = subscription.periodEndMs;
    const first = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    const replay = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 2000,
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.extension.id).toBe(first.extension.id);
    expect(replay.extension.id).toBe(trialExtensionId("bob"));
    const rows = await adapters.subs.listSubscriptions(REFERRER);
    expect(rows[0].periodEndMs).toBe(originalEnd + 7 * MS_PER_DAY);
  });

  it("D-2.25: a grant changes ONLY the trial periodEndMs — no commercial balance, no purchase, no credits", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    await startTrial(adapters, REFERRER, plan, nowMs);
    const accountBefore = await adapters.commercial.getAccount(REFERRER);
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    const accountAfter = await adapters.commercial.getAccount(REFERRER);
    expect(accountAfter).toEqual(accountBefore);
  });
});

describe("6141 grant: banking when no trial is active", () => {
  it("banks the days with the D-2.31 expiry when the referrer has no active trial", async () => {
    const adapters = makeAdapters();
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const result = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs,
    });
    expect(result.outcome).toBe("banked");
    expect(result.extension.status).toBe("banked");
    expect(result.extension.daysGranted).toBe(7);
    expect(result.extension.subscriptionId).toBeNull();
    // Seeded 90-day expiry (D-2.31).
    expect(result.extension.expiresAtMs).toBe(nowMs + 90 * MS_PER_DAY);
  });

  it("banked days expire on their earn anniversary and are never applied after expiry", async () => {
    const adapters = makeAdapters();
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const granted = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs,
    });
    expect(isExtensionExpired(granted.extension, nowMs + 89 * MS_PER_DAY)).toBe(false);
    expect(isExtensionExpired(granted.extension, nowMs + 90 * MS_PER_DAY)).toBe(true);
    expect(
      bankedExtensionDaysFor([granted.extension], nowMs + 90 * MS_PER_DAY),
    ).toBe(0);
    expect(bankedExtensionDaysFor([granted.extension], nowMs)).toBe(7);
  });

  it("banked days apply to a later trial, oldest-expiring-first, and are marked consumed", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs,
    });
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "carol",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs + 2000);
    const originalEnd = subscription.periodEndMs;
    const applied = await applyBankedExtensions(adapters, {
      userId: REFERRER,
      subscriptionId: subscription.id,
      nowMs: nowMs + 3000,
    });
    expect(applied.daysApplied).toBe(14);
    expect(applied.consumedIds).toHaveLength(2);
    const rows = await adapters.subs.listSubscriptions(REFERRER);
    expect(rows[0].periodEndMs).toBe(originalEnd + 14 * MS_PER_DAY);
    const summary = await trialExtensionSummary(adapters, { userId: REFERRER, nowMs: nowMs + 3000 });
    expect(summary.bankedDays).toBe(0);
    expect(summary.appliedDays).toBe(14);
  });

  it("expired banked days are never applied to a later trial", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs,
    });
    const lateMs = nowMs + 91 * MS_PER_DAY;
    const { subscription } = await startTrial(adapters, REFERRER, plan, lateMs);
    const applied = await applyBankedExtensions(adapters, {
      userId: REFERRER,
      subscriptionId: subscription.id,
      nowMs: lateMs + 1000,
    });
    expect(applied.daysApplied).toBe(0);
    expect(applied.consumedIds).toHaveLength(0);
  });
});

describe("6141 grant: caps", () => {
  it("refuses the grant (skip, not throw) when the daily cap is reached", async () => {
    const adapters = makeAdapters();
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    for (const referred of ["u1", "u2", "u3"]) {
      const r = await grantTrialExtension(adapters, {
        referrerUserId: REFERRER,
        referredUserId: referred,
        tenantId: TENANT,
        nowMs: nowMs + 1000,
      });
      expect(r.outcome).toBe("banked");
    }
    const refused = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "u4",
      tenantId: TENANT,
      nowMs: nowMs + 2000,
    });
    expect(refused.outcome).toBe("cap_refused");
    expect(refused.extension).toBeNull();
    const summary = await trialExtensionSummary(adapters, { userId: REFERRER, nowMs });
    expect(summary.totalExtensionDays).toBe(21);
  });

  it("refuses the grant when the monthly cap is reached", async () => {
    const adapters = makeAdapters();
    await adapters.lifecycle.setRules({
      earnAmountUSD: 0.5,
      vestingDelayMs: 0,
      redemptionScope: "pay-per-run",
      maxExtensionsPerDay: 30,
      maxExtensionsPerMonth: 2,
    });
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    for (const referred of ["u1", "u2"]) {
      const r = await grantTrialExtension(adapters, {
        referrerUserId: REFERRER,
        referredUserId: referred,
        tenantId: TENANT,
        nowMs: nowMs + 1000,
      });
      expect(r.outcome).toBe("banked");
    }
    const refused = await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "u3",
      tenantId: TENANT,
      nowMs: nowMs + 2000,
    });
    expect(refused.outcome).toBe("cap_refused");
  });
});

describe("6141 extendTrialSubscription", () => {
  it("extends an unexpired trial and refuses a non-trial or expired row", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs);
    const updated = await extendTrialSubscription(adapters, {
      subscriptionId: subscription.id,
      days: 7,
      nowMs: nowMs + 1000,
    });
    expect(updated.periodEndMs).toBe(subscription.periodEndMs + 7 * MS_PER_DAY);
    await expect(
      extendTrialSubscription(adapters, {
        subscriptionId: subscription.id,
        days: 7,
        nowMs: subscription.periodEndMs + 7 * MS_PER_DAY + 1000,
      }),
    ).rejects.toThrow();
    await expect(
      extendTrialSubscription(adapters, { subscriptionId: "missing", days: 7, nowMs }),
    ).rejects.toThrow();
  });
});

describe("6141 summary + share message", () => {
  it("summarizes referred count and day totals for the profile panel", async () => {
    const adapters = makeAdapters();
    const plan = await makeTrialPlan(adapters.subs, 14);
    const nowMs = Date.parse("2026-11-22T10:00:00Z");
    // bob earns while alice has a trial (applied); carol earns with no trial left (banked after expiry).
    const { subscription } = await startTrial(adapters, REFERRER, plan, nowMs);
    await grantTrialExtension(adapters, {
      referrerUserId: REFERRER,
      referredUserId: "bob",
      tenantId: TENANT,
      nowMs: nowMs + 1000,
    });
    // Record earnings so the referred count reads from the ledger rail.
    await adapters.lifecycle.recordEarning({ referrerUserId: REFERRER, referredUserId: "bob", tenantId: TENANT });
    await adapters.lifecycle.recordEarning({ referrerUserId: REFERRER, referredUserId: "carol", tenantId: TENANT });
    const summary = await trialExtensionSummary(adapters, { userId: REFERRER, nowMs: nowMs + 2000 });
    expect(summary.referredCount).toBe(2);
    expect(summary.totalExtensionDays).toBe(7);
    expect(summary.appliedDays).toBe(7);
    expect(summary.bankedDays).toBe(0);
    expect(summary.expiredDays).toBe(0);
    expect(summary.trialEndsAtMs).toBe(subscription.periodEndMs + 7 * MS_PER_DAY);
  });

  it("renders the share message from the rule template", () => {
    const message = renderShareMessage(DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE, {
      trialDays: 14,
      link: "https://agent.openaimp.com/?ref=alice",
    });
    expect(message).toContain("https://agent.openaimp.com/?ref=alice");
    expect(message).toContain("14-day");
    expect(message).not.toContain("{link}");
    expect(message).not.toContain("{trialDays}");
  });
});
