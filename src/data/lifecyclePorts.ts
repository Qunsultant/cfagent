/**
 * Issue #2208 ([CBO] Lifecycle email + referral credits, sub-issue
 * of #2012; advances #2021 and #2020; source #1076) — lifecycle
 * port.
 *
 * Two halves, one port file, kept deliberately separate from the
 * failure-credit system:
 *
 * - Referral credits: earned by a referrer when a referred user's
 *   first paid run lands, vested after a delay, redeemable against
 *   pay-per-run runs. They live in their OWN tables
 *   (agent_referral_earnings) and their OWN balance — they are
 *   NEVER mixed with the D1 failure-credit claims
 *   (agent_credit_claims) or the simulated $50 wallet credit
 *   (#1076: that wallet is NOT referral credit).
 * - Notification preferences + digest guard: per-user per-category
 *   toggles (digest opt-in defaults OFF; digest opt-out is
 *   effective same-day because it is a single store write) and a
 *   per-user per-day digest-send record (at most one digest per
 *   day, skip-on-empty).
 *
 * Rules are EXTERNALIZED operator data, never code constants: the
 * rule row lives in agent_referral_rules, seeded ONCE by migration
 * 0015 with PROPOSED values (pending owner approval — NOT price
 *   approval, NOT activation; the monetization flag stays OFF).
 *   Operators change rules via setRules; no code deploy is needed
 *   for a rule change, and every behavior below reads the stored
 *   row. Subscription application of referral credits is DEFERRED
 *   (redemptionScope is "pay-per-run" only in this slice).
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the port interfaces, and pure helpers ONLY. It imports no store
 * client, references no env binding, and writes no SQL. All
 * query-builder code lives in d1LifecycleAdapter.ts; the
 * in-memory adapter shares the validators and allocation below
 * so the two implementations cannot drift. A structural test
 * pins the import rule.
 *
 * Tenancy: every earning and preference carries tenantId; a
 * redeem whose tenant differs from the earning's tenant throws,
 * and no read is unscoped (all reads take a userId). Credits
 * never cross tenants.
 */

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What a referral credit may be redeemed against. Only pay-per-run in this slice. */
export type ReferralRedemptionScope = "pay-per-run";

/**
 * The operator-owned referral rule row. Exactly one row (id
 * "default") exists; getRules returns it, setRules replaces it.
 * earnTrigger is descriptive: the earn event is a referred
 * user's first paid run (see recordFirstPaidRunEarning).
 */
export interface ReferralRules {
  id: string;
  earnAmountUSD: number;
  /** Milliseconds between earning and vesting (redemption eligibility). */
  vestingDelayMs: number;
  redemptionScope: ReferralRedemptionScope;
  updatedAtMs: number;
}

export function validateReferralRules(input: {
  earnAmountUSD: unknown;
  vestingDelayMs: unknown;
  redemptionScope: unknown;
}): { earnAmountUSD: number; vestingDelayMs: number; redemptionScope: ReferralRedemptionScope } {
  const earnAmountUSD = round2(Number(input.earnAmountUSD));
  if (!Number.isFinite(earnAmountUSD) || earnAmountUSD <= 0) {
    throw new Error("Referral earnAmountUSD must be a positive finite number.");
  }
  const vestingDelayMs = Number(input.vestingDelayMs);
  if (!Number.isFinite(vestingDelayMs) || vestingDelayMs < 0 || Math.floor(vestingDelayMs) !== vestingDelayMs) {
    throw new Error("Referral vestingDelayMs must be a finite non-negative integer.");
  }
  if (input.redemptionScope !== "pay-per-run") {
    throw new Error('Referral redemptionScope must be "pay-per-run" (subscription application is deferred).');
  }
  return { earnAmountUSD, vestingDelayMs, redemptionScope: "pay-per-run" };
}

/**
 * One referral earning. One per referred user, ever: the first
 * paid run earns, later runs earn nothing (idempotent replay
 * returns the existing row). Partial redemption is supported:
 * redeemedAmountUSD tracks what has been spent; the remainder
 * (amountUSD - redeemedAmountUSD) stays redeemable once vested.
 */
export interface ReferralEarning {
  id: string;
  referrerUserId: string;
  referredUserId: string;
  tenantId: string;
  amountUSD: number;
  redeemedAmountUSD: number;
  earnedAtMs: number;
  vestedAtMs: number;
  redeemedByRunId: string | null;
  redeemedAtMs: number | null;
}

/** Deterministic earning id: one earning per referred user. */
export function referralEarningId(referredUserId: string): string {
  return `referral:${referredUserId}`;
}

export function isEarningVested(earning: ReferralEarning, nowMs: number): boolean {
  return nowMs >= earning.vestedAtMs;
}

/** Vested, unspent remainder across a user's earnings. */
export function redeemableBalanceFor(earnings: ReferralEarning[], nowMs: number): number {
  let total = 0;
  for (const e of earnings) {
    if (!isEarningVested(e, nowMs)) continue;
    total = round2(total + round2(e.amountUSD - e.redeemedAmountUSD));
  }
  return total;
}

export interface ReferralAllocation {
  earningId: string;
  amountUSD: number;
}

/**
 * Pure oldest-first allocation over VESTED earnings only.
 * Unvested earnings are never allocated, even when the vested
 * balance is short: a shortfall throws, it never dips into
 * unvested credit. Throws before any write (adapters allocate
 * with this helper, then apply the allocation).
 */
export function allocateRedemption(
  earnings: ReferralEarning[],
  amountUSD: number,
  nowMs: number,
): ReferralAllocation[] {
  const amount = round2(amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Referral redemption amountUSD must be a positive finite number.");
  }
  const vested = [...earnings]
    .filter((e) => isEarningVested(e, nowMs) && round2(e.amountUSD - e.redeemedAmountUSD) > 0)
    .sort((a, b) => a.earnedAtMs - b.earnedAtMs || (a.id < b.id ? -1 : 1));
  let remaining = amount;
  const allocations: ReferralAllocation[] = [];
  for (const e of vested) {
    if (remaining <= 0) break;
    const available = round2(e.amountUSD - e.redeemedAmountUSD);
    const take = Math.min(available, remaining);
    allocations.push({ earningId: e.id, amountUSD: take });
    remaining = round2(remaining - take);
  }
  if (remaining > 0) {
    throw new Error(
      `Insufficient vested referral balance: need ${amount}, vested available ${round2(amount - remaining)}.`,
    );
  }
  return allocations;
}

export interface ReferralCreditPort {
  /** The stored operator rule row (seeded by migration 0015). */
  getRules(): Promise<ReferralRules>;
  /** Operator-only: replace the rule row (no code deploy needed). */
  setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
  }): Promise<ReferralRules>;
  /**
   * Record the first-paid-run earning for a referred user.
   * Idempotent: re-recording the same referred user returns the
   * existing earning (the DO/payment record is the audit; this
   * row is the operational balance). Throws when referrer and
   * referred are the same user (no self-referral).
   */
  recordEarning(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
  }): Promise<ReferralEarning>;
  /** All earnings for one user, oldest first. No unscoped read. */
  listEarnings(userId: string): Promise<ReferralEarning[]>;
  /** Vested, unspent referral balance for one user. */
  redeemableBalance(userId: string): Promise<number>;
  /**
   * Redeem an exact amount against vested earnings, oldest
   * first. Throws on insufficient vested balance, on a tenant
   * mismatch (any allocated earning's tenant differs from the
   * caller's tenant), or on a non-positive amount — before
   * applying any allocation that would leave a partial spend
   * unrecorded (allocation is computed pure-first).
   */
  redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number }>;
}

/**
 * Per-user notification preferences. Categories in this slice:
 * digest (opt-in, default OFF) and welcome (default ON).
 * Security mail is NOT a category: it is non-suppressible and
 * no toggle here can silence it (#1076 A3).
 */
export interface NotificationPreferences {
  userId: string;
  tenantId: string;
  digestEnabled: boolean;
  welcomeEnabled: boolean;
  updatedAtMs: number;
}

/** Defaults for a user with no stored row: digest OFF, welcome ON. */
export function defaultPreferences(userId: string, tenantId: string): NotificationPreferences {
  return { userId, tenantId, digestEnabled: false, welcomeEnabled: true, updatedAtMs: Date.now() };
}

export interface NotificationPreferencePort {
  /**
   * Stored row, or the defaults above when no row exists (no
   * write). #1761: tenant-scoped — a blank tenant throws, and
   * a stored row for another tenant reads as the defaults,
   * never as the other tenant's row.
   */
  getPreferences(userId: string, tenantId: string): Promise<NotificationPreferences>;
  /**
   * Upsert toggles. A digest opt-out takes effect on the next
   * send check, which is the same write — same-day effect, no
   * propagation delay. #1761: fail-closed on tenant mismatch —
   * a stored row for another tenant throws before any write
   * instead of being overwritten (the row key is user_id alone).
   */
  setPreferences(input: {
    userId: string;
    tenantId: string;
    digestEnabled?: unknown;
    welcomeEnabled?: unknown;
  }): Promise<NotificationPreferences>;
}

/** UTC calendar day, YYYY-MM-DD — the digest guard's grain. */
export function digestDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface DigestGuardPort {
  /** True when this user already received a digest on this day. */
  hasSentDigest(userId: string, day: string): Promise<boolean>;
  /** Idempotent: re-marking the same (user, day) is a no-op. */
  markDigestSent(userId: string, day: string): Promise<void>;
}

/** The full lifecycle store: referral + preferences + digest guard. */
export type LifecycleStore = ReferralCreditPort & NotificationPreferencePort & DigestGuardPort;
