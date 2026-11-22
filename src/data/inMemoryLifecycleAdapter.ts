/**
 * Issue #2208 — in-memory adapter for the lifecycle port. Shares
 * the port module's validators and allocation with the D1
 * adapter so the two implementations cannot drift; the port
 * conformance suite runs unchanged against both.
 *
 * Seeding mirrors migration 0015 exactly (same PROPOSED values,
 * pending owner approval): earn $0.50, 7-day vesting,
 * pay-per-run redemption only.
 */
import {
  assertTenantScopeMatch,
  bindTenantScope,
} from "./tenantScope";
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  DEFAULT_REFERRAL_EXTENSION_DAYS,
  DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE,
  DEFAULT_REFERRED_TRIAL_DAYS,
  DEFAULT_MAX_EXTENSIONS_PER_DAY,
  DEFAULT_MAX_EXTENSIONS_PER_MONTH,
  allocateRedemption,
  defaultPreferences,
  expiredBalanceFor,
  redeemableBalanceFor,
  referralEarningId,
  round2,
  validateReferralRules,
  type DigestSubscriber,
  type LifecycleStore,
  type NotificationPreferences,
  type ReferralAllocation,
  type ReferralAttribution,
  type ReferralEarning,
  type ReferralRules,
  type ReferralTrialExtension,
} from "./lifecyclePorts";

/** In-memory lifecycle store (tests + unbound-env fallback shape). */
export class InMemoryLifecycleAdapter implements LifecycleStore {
  private rules: ReferralRules = {
    id: "default",
    earnAmountUSD: 0.5,
    vestingDelayMs: 604800000,
    redemptionScope: "pay-per-run",
    // #5229: seeded 90-day expiry, mirroring migration 0069.
    expiryPeriodMs: 7776000000,
    // #6141: seeded PROPOSED extension defaults, mirroring migration 0082.
    extensionDays: DEFAULT_REFERRAL_EXTENSION_DAYS,
    referredTrialDays: DEFAULT_REFERRED_TRIAL_DAYS,
    maxExtensionsPerDay: DEFAULT_MAX_EXTENSIONS_PER_DAY,
    maxExtensionsPerMonth: DEFAULT_MAX_EXTENSIONS_PER_MONTH,
    referralTrialPlanId: null,
    shareMessageTemplate: DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE,
    updatedAtMs: 0,
  };
  private earnings = new Map<string, ReferralEarning>();
  private extensions = new Map<string, ReferralTrialExtension>();
  private attributions = new Map<string, ReferralAttribution>();
  private preferences = new Map<string, NotificationPreferences>();
  private digestSends = new Set<string>();
  private subscriberEmails = new Map<string, { tenantId: string; email: string }>();
  private digestPassDays = new Set<string>();

  async getRules(): Promise<ReferralRules> {
    return { ...this.rules };
  }

  async setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
    expiryPeriodMs?: unknown;
    extensionDays?: unknown;
    referredTrialDays?: unknown;
    maxExtensionsPerDay?: unknown;
    maxExtensionsPerMonth?: unknown;
    referralTrialPlanId?: unknown;
    shareMessageTemplate?: unknown;
  }): Promise<ReferralRules> {
    const validated = validateReferralRules(input);
    this.rules = { id: "default", ...validated, updatedAtMs: Date.now() };
    return { ...this.rules };
  }

  async recordEarning(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
  }): Promise<ReferralEarning> {
    if (!input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const id = referralEarningId(input.referredUserId);
    const existing = this.earnings.get(id);
    if (existing) return { ...existing };
    const now = Date.now();
    const record: ReferralEarning = {
      id,
      referrerUserId: input.referrerUserId,
      referredUserId: input.referredUserId,
      tenantId: input.tenantId,
      amountUSD: this.rules.earnAmountUSD,
      redeemedAmountUSD: 0,
      earnedAtMs: now,
      vestedAtMs: now + this.rules.vestingDelayMs,
      redeemedByRunId: null,
      redeemedAtMs: null,
    };
    this.earnings.set(id, record);
    return { ...record };
  }

  async recordExtension(input: ReferralTrialExtension): Promise<ReferralTrialExtension> {
    if (!input.id || !input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const existing = this.extensions.get(input.id);
    if (existing) return { ...existing };
    const record: ReferralTrialExtension = { ...input };
    this.extensions.set(record.id, record);
    return { ...record };
  }

  async listExtensions(referrerUserId: string): Promise<ReferralTrialExtension[]> {
    return [...this.extensions.values()]
      .filter((e) => e.referrerUserId === referrerUserId)
      .sort((a, b) => a.grantedAtMs - b.grantedAtMs || (a.id < b.id ? -1 : 1))
      .map((e) => ({ ...e }));
  }

  async countExtensionsSince(referrerUserId: string, sinceMs: number): Promise<number> {
    let count = 0;
    for (const e of this.extensions.values()) {
      if (e.referrerUserId === referrerUserId && e.grantedAtMs >= sinceMs) count += 1;
    }
    return count;
  }

  async markExtensionApplied(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null> {
    const existing = this.extensions.get(id);
    if (!existing) return null;
    const updated: ReferralTrialExtension = {
      ...existing,
      status: "applied",
      subscriptionId,
      appliedAtMs: nowMs,
    };
    this.extensions.set(id, updated);
    return { ...updated };
  }

  async markExtensionConsumed(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null> {
    const existing = this.extensions.get(id);
    if (!existing) return null;
    const updated: ReferralTrialExtension = {
      ...existing,
      status: "consumed",
      subscriptionId,
      consumedAtMs: nowMs,
    };
    this.extensions.set(id, updated);
    return { ...updated };
  }

  async recordAttribution(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
    source?: ReferralAttribution["source"];
  }): Promise<ReferralAttribution> {
    if (!input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const existing = this.attributions.get(input.referredUserId);
    if (existing) {
      if (existing.referrerUserId !== input.referrerUserId) {
        throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
      }
      return { ...existing };
    }
    const record: ReferralAttribution = {
      referredUserId: input.referredUserId,
      referrerUserId: input.referrerUserId,
      tenantId: input.tenantId,
      // Additive (#3307): a caller that passes nothing keeps
      // stamping "operator"; a referral-kind code redemption
      // passes "code".
      source: input.source ?? "operator",
      createdAtMs: Date.now(),
    };
    this.attributions.set(input.referredUserId, record);
    return { ...record };
  }

  async getAttribution(referredUserId: string): Promise<ReferralAttribution | null> {
    if (!referredUserId) return null;
    const row = this.attributions.get(referredUserId);
    return row ? { ...row } : null;
  }

  async listEarnings(userId: string): Promise<ReferralEarning[]> {
    return [...this.earnings.values()]
      .filter((e) => e.referrerUserId === userId)
      .sort((a, b) => a.earnedAtMs - b.earnedAtMs || (a.id < b.id ? -1 : 1))
      .map((e) => ({ ...e }));
  }

  async redeemableBalance(userId: string): Promise<number> {
    const earnings = await this.listEarnings(userId);
    // #5229: the single balance-read path — vested AND unexpired.
    return redeemableBalanceFor(earnings, Date.now(), this.rules.expiryPeriodMs);
  }

  async redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number; expiredUSD: number }> {
    if (!input.userId || !input.tenantId || !input.runRequestId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const earnings = await this.listEarnings(input.userId);
    for (const e of earnings) {
      if (e.tenantId !== input.tenantId) {
        throw new BusinessError("FAILURE_COMMERCIAL_FORBIDDEN"); // #5606 (G-3)
      }
    }
    const now = Date.now();
    const allocations = allocateRedemption(earnings, input.amountUSD, now, this.rules.expiryPeriodMs);
    const expiredUSD = expiredBalanceFor(earnings, now, this.rules.expiryPeriodMs);
    for (const a of allocations) {
      const earning = this.earnings.get(a.earningId);
      if (!earning) throw new BusinessError("FAILURE_UNEXPECTED_ERROR"); // #5606 (G-3)
      const next = round2(earning.redeemedAmountUSD + a.amountUSD);
      if (next > earning.amountUSD) {
        throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
      }
      this.earnings.set(a.earningId, {
        ...earning,
        redeemedAmountUSD: next,
        redeemedByRunId: input.runRequestId,
        redeemedAtMs: now,
      });
    }
    return { allocations, redeemedUSD: round2(allocations.reduce((s, a) => s + a.amountUSD, 0)), expiredUSD };
  }

  async getPreferences(userId: string, tenantId: string): Promise<NotificationPreferences> {
    // #1761: mirror the D1 adapter — a blank tenant throws, a
    // stored row for another tenant reads as defaults, never
    // as the other tenant's row.
    const scope = bindTenantScope(tenantId);
    const existing = this.preferences.get(userId);
    if (!existing) return defaultPreferences(userId, tenantId);
    if (existing.tenantId !== scope.tenantId) return defaultPreferences(userId, tenantId);
    return { ...existing };
  }

  async setPreferences(input: {
    userId: string;
    tenantId: string;
    digestEnabled?: unknown;
    welcomeEnabled?: unknown;
  }): Promise<NotificationPreferences> {
    if (!input.userId || !input.tenantId) {
      throw new Error("userId and tenantId are required.");
    }
    // #1761: mirror the D1 adapter — a stored row for another
    // tenant throws before any write, instead of being
    // silently overwritten (the map key is user_id alone).
    const stored = this.preferences.get(input.userId);
    if (stored) assertTenantScopeMatch(stored.tenantId, bindTenantScope(input.tenantId));
    const existing = await this.getPreferences(input.userId, input.tenantId);
    const record: NotificationPreferences = {
      userId: input.userId,
      tenantId: input.tenantId,
      digestEnabled:
        input.digestEnabled === undefined ? existing.digestEnabled : input.digestEnabled === true,
      welcomeEnabled:
        input.welcomeEnabled === undefined ? existing.welcomeEnabled : input.welcomeEnabled === true,
      updatedAtMs: Date.now(),
    };
    this.preferences.set(input.userId, record);
    return { ...record };
  }

  async suppressMailForUser(userId: string): Promise<NotificationPreferences | null> {
    // Issue #2660: mirror the D1 adapter — flip both flags on the
    // user's row (the map key is user_id alone); no row → null.
    if (!userId) throw new Error("userId is required.");
    const existing = this.preferences.get(userId);
    if (!existing) return null;
    const record: NotificationPreferences = {
      ...existing,
      digestEnabled: false,
      welcomeEnabled: false,
      updatedAtMs: Date.now(),
    };
    this.preferences.set(userId, record);
    return { ...record };
  }

  async hasSentDigest(userId: string, day: string): Promise<boolean> {
    return this.digestSends.has(`${userId}:${day}`);
  }

  async markDigestSent(userId: string, day: string): Promise<void> {
    this.digestSends.add(`${userId}:${day}`);
  }

  async listDigestSubscribers(): Promise<DigestSubscriber[]> {
    const subs: DigestSubscriber[] = [];
    for (const prefs of this.preferences.values()) {
      if (!prefs.digestEnabled) continue;
      // Tenant-aware lookup: an address stored under another
      // tenant never leaks into this subscriber's row.
      const row = this.subscriberEmails.get(prefs.userId);
      subs.push({
        userId: prefs.userId,
        tenantId: prefs.tenantId,
        email: row && row.tenantId === prefs.tenantId ? row.email : null,
      });
    }
    subs.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return subs;
  }

  async setSubscriberEmail(userId: string, tenantId: string, email: string): Promise<void> {
    if (!userId || !tenantId || !email) {
      throw new Error("userId, tenantId, and email are required.");
    }
    // #1761: a stored address for another tenant throws before
    // any write (mirrors the D1 adapter's fail-closed check).
    const scope = bindTenantScope(tenantId);
    const existing = this.subscriberEmails.get(userId);
    if (existing) assertTenantScopeMatch(existing.tenantId, scope);
    this.subscriberEmails.set(userId, { tenantId, email });
  }

  async hasDigestPassRun(day: string): Promise<boolean> {
    return this.digestPassDays.has(day);
  }

  async markDigestPassRun(day: string): Promise<void> {
    this.digestPassDays.add(day);
  }
}
