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
import {
  allocateRedemption,
  defaultPreferences,
  referralEarningId,
  round2,
  validateReferralRules,
  type LifecycleStore,
  type NotificationPreferences,
  type ReferralAllocation,
  type ReferralEarning,
  type ReferralRules,
} from "./lifecyclePorts";

/** In-memory lifecycle store (tests + unbound-env fallback shape). */
export class InMemoryLifecycleAdapter implements LifecycleStore {
  private rules: ReferralRules = {
    id: "default",
    earnAmountUSD: 0.5,
    vestingDelayMs: 604800000,
    redemptionScope: "pay-per-run",
    updatedAtMs: 0,
  };
  private earnings = new Map<string, ReferralEarning>();
  private preferences = new Map<string, NotificationPreferences>();
  private digestSends = new Set<string>();

  async getRules(): Promise<ReferralRules> {
    return { ...this.rules };
  }

  async setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
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
      throw new Error("referrerUserId, referredUserId, and tenantId are required.");
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new Error("A user cannot refer themselves.");
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

  async listEarnings(userId: string): Promise<ReferralEarning[]> {
    return [...this.earnings.values()]
      .filter((e) => e.referrerUserId === userId)
      .sort((a, b) => a.earnedAtMs - b.earnedAtMs || (a.id < b.id ? -1 : 1))
      .map((e) => ({ ...e }));
  }

  async redeemableBalance(userId: string): Promise<number> {
    const earnings = await this.listEarnings(userId);
    const now = Date.now();
    let total = 0;
    for (const e of earnings) {
      if (now < e.vestedAtMs) continue;
      total = round2(total + round2(e.amountUSD - e.redeemedAmountUSD));
    }
    return total;
  }

  async redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number }> {
    if (!input.userId || !input.tenantId || !input.runRequestId) {
      throw new Error("userId, tenantId, and runRequestId are required.");
    }
    const earnings = await this.listEarnings(input.userId);
    for (const e of earnings) {
      if (e.tenantId !== input.tenantId) {
        throw new Error("Referral credits never cross tenants: earning tenant differs from run tenant.");
      }
    }
    const allocations = allocateRedemption(earnings, input.amountUSD, Date.now());
    const now = Date.now();
    for (const a of allocations) {
      const earning = this.earnings.get(a.earningId);
      if (!earning) throw new Error(`Referral earning ${a.earningId} vanished mid-redeem.`);
      const next = round2(earning.redeemedAmountUSD + a.amountUSD);
      if (next > earning.amountUSD) {
        throw new Error(`Referral earning ${a.earningId} would over-redeem; redeem refused.`);
      }
      this.earnings.set(a.earningId, {
        ...earning,
        redeemedAmountUSD: next,
        redeemedByRunId: input.runRequestId,
        redeemedAtMs: now,
      });
    }
    return { allocations, redeemedUSD: round2(allocations.reduce((s, a) => s + a.amountUSD, 0)) };
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

  async hasSentDigest(userId: string, day: string): Promise<boolean> {
    return this.digestSends.has(`${userId}:${day}`);
  }

  async markDigestSent(userId: string, day: string): Promise<void> {
    this.digestSends.add(`${userId}:${day}`);
  }
}
