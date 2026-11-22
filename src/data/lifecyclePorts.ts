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

import { BusinessError } from "../outcomes/outcomeAspects";

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Issue #5229 (slice 2.31): the PROPOSED default referral-credit
 * expiry — 90 days from earn. Operator data, never a code
 * constant: the rule row carries the live value; this constant
 * is only the seed/default when no value is supplied.
 */
export const DEFAULT_REFERRAL_EXPIRY_PERIOD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Issue #6141 — PROPOSED defaults for the referral trial-extension
 * model (Grafana-style, adapted). Operator data, never code
 * constants: the rule row carries the live values; these constants
 * are only the seeds/defaults when no value is supplied. The share
 * message copy is a PROPOSED default pending owner approval.
 */
export const DEFAULT_REFERRAL_EXTENSION_DAYS = 7;
export const DEFAULT_REFERRED_TRIAL_DAYS = 14;
export const DEFAULT_MAX_EXTENSIONS_PER_DAY = 3;
export const DEFAULT_MAX_EXTENSIONS_PER_MONTH = 10;
export const DEFAULT_REFERRAL_TRIAL_PLAN_ID: string | null = null;
export const DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE =
  "Join me on OpenAIMP — sign up with my link and get a {trialDays}-day free trial of the paid tier, plus free runs every month: {link}";

/** What a referral credit may be redeemed against. Only pay-per-run in this slice. */
export type ReferralRedemptionScope = "pay-per-run";

/**
 * The operator-owned referral rule row. Exactly one row (id
 * "default") exists; getRules returns it, setRules replaces it.
 * earnTrigger is descriptive: the earn event is a referred
 * user's first paid run (see recordFirstPaidRunEarning).
 * expiryPeriodMs (#5229): milliseconds from earn after which
 * the credit can no longer convert or redeem. 0 means never
 * expires — an explicit operator choice, visible in the rules
 * UX; the seeded default is 90 days.
 *
 * Trial-extension fields (#6141): extensionDays is the trial time
 * a referrer earns per referred user's first verified paid run;
 * referredTrialDays is the trial a referred user is granted on
 * signup via the link; maxExtensionsPerDay/PerMonth cap grants
 * (UTC day / UTC calendar month); referralTrialPlanId is the plan
 * whose trial the referred grant activates (null = the grant is
 * disabled until an operator sets it); shareMessageTemplate is
 * the referral share copy, with {link} (required) and {trialDays}
 * placeholders. The extension is TIME only (D-2.25): it never
 * mints a subscription, never pays for a plan, never converts to
 * credits — the banked expiry below reuses expiryPeriodMs, so a
 * banked extension dies on the same schedule as a credit.
 */
export interface ReferralRules {
  id: string;
  earnAmountUSD: number;
  /** Milliseconds between earning and vesting (redemption eligibility). */
  vestingDelayMs: number;
  redemptionScope: ReferralRedemptionScope;
  /** Milliseconds from earn to expiry; 0 = never expires. */
  expiryPeriodMs: number;
  /** #6141: trial days earned per referred first verified paid run. */
  extensionDays: number;
  /** #6141: trial days granted to a referred user on signup via the link. */
  referredTrialDays: number;
  /** #6141: max trial-extension grants per referrer per UTC day. */
  maxExtensionsPerDay: number;
  /** #6141: max trial-extension grants per referrer per UTC calendar month. */
  maxExtensionsPerMonth: number;
  /** #6141: plan whose trial the referred grant activates; null = disabled. */
  referralTrialPlanId: string | null;
  /** #6141: share-message template; must contain {link}. */
  shareMessageTemplate: string;
  updatedAtMs: number;
}

export function validateReferralRules(input: {
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
}): {
  earnAmountUSD: number;
  vestingDelayMs: number;
  redemptionScope: ReferralRedemptionScope;
  expiryPeriodMs: number;
  extensionDays: number;
  referredTrialDays: number;
  maxExtensionsPerDay: number;
  maxExtensionsPerMonth: number;
  referralTrialPlanId: string | null;
  shareMessageTemplate: string;
} {
  const earnAmountUSD = round2(Number(input.earnAmountUSD));
  if (!Number.isFinite(earnAmountUSD) || earnAmountUSD <= 0) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const vestingDelayMs = Number(input.vestingDelayMs);
  if (!Number.isFinite(vestingDelayMs) || vestingDelayMs < 0 || Math.floor(vestingDelayMs) !== vestingDelayMs) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  if (input.redemptionScope !== "pay-per-run") {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  // #5229: absent means "keep the seeded default" — callers that
  // predate expiry pass three fields and must not reset the value
  // to an invented one. 0 is a valid explicit value (never expires).
  const expiryPeriodMs =
    input.expiryPeriodMs === undefined ? DEFAULT_REFERRAL_EXPIRY_PERIOD_MS : Number(input.expiryPeriodMs);
  if (!Number.isFinite(expiryPeriodMs) || expiryPeriodMs < 0 || Math.floor(expiryPeriodMs) !== expiryPeriodMs) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  // #6141: absent extension fields keep the seeded PROPOSED
  // defaults, same as expiry above — a pre-extension caller must
  // not reset them to an invented value. Days and caps are whole
  // numbers >= 1; the plan id is null (disabled) or a non-empty
  // string; the template must contain {link}.
  const extensionDays =
    input.extensionDays === undefined ? DEFAULT_REFERRAL_EXTENSION_DAYS : Number(input.extensionDays);
  if (!Number.isFinite(extensionDays) || extensionDays < 1 || Math.floor(extensionDays) !== extensionDays) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const referredTrialDays =
    input.referredTrialDays === undefined ? DEFAULT_REFERRED_TRIAL_DAYS : Number(input.referredTrialDays);
  if (!Number.isFinite(referredTrialDays) || referredTrialDays < 1 || Math.floor(referredTrialDays) !== referredTrialDays) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const maxExtensionsPerDay =
    input.maxExtensionsPerDay === undefined ? DEFAULT_MAX_EXTENSIONS_PER_DAY : Number(input.maxExtensionsPerDay);
  if (!Number.isFinite(maxExtensionsPerDay) || maxExtensionsPerDay < 1 || Math.floor(maxExtensionsPerDay) !== maxExtensionsPerDay) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const maxExtensionsPerMonth =
    input.maxExtensionsPerMonth === undefined ? DEFAULT_MAX_EXTENSIONS_PER_MONTH : Number(input.maxExtensionsPerMonth);
  if (!Number.isFinite(maxExtensionsPerMonth) || maxExtensionsPerMonth < 1 || Math.floor(maxExtensionsPerMonth) !== maxExtensionsPerMonth) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  let referralTrialPlanId: string | null = DEFAULT_REFERRAL_TRIAL_PLAN_ID;
  if (input.referralTrialPlanId !== undefined && input.referralTrialPlanId !== null) {
    if (typeof input.referralTrialPlanId !== "string" || !input.referralTrialPlanId.trim()) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    referralTrialPlanId = input.referralTrialPlanId.trim();
  }
  const shareMessageTemplate =
    input.shareMessageTemplate === undefined
      ? DEFAULT_REFERRAL_SHARE_MESSAGE_TEMPLATE
      : input.shareMessageTemplate;
  if (
    typeof shareMessageTemplate !== "string" ||
    !shareMessageTemplate.trim() ||
    !shareMessageTemplate.includes("{link}")
  ) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return {
    earnAmountUSD,
    vestingDelayMs,
    redemptionScope: "pay-per-run",
    expiryPeriodMs,
    extensionDays,
    referredTrialDays,
    maxExtensionsPerDay,
    maxExtensionsPerMonth,
    referralTrialPlanId,
    shareMessageTemplate: shareMessageTemplate.trim(),
  };
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

/**
 * Issue #5229 (slice 2.31): expiry is measured from EARN time
 * (earnedAtMs), not vest time — a credit that vests late still
 * dies on its earn anniversary. The boundary is inclusive: at
 * exactly earnedAtMs + expiryPeriodMs the credit is expired.
 * expiryPeriodMs 0 means never expires.
 */
export function isEarningExpired(earning: ReferralEarning, nowMs: number, expiryPeriodMs: number): boolean {
  if (!expiryPeriodMs || expiryPeriodMs <= 0) return false;
  return nowMs >= earning.earnedAtMs + expiryPeriodMs;
}

/** Unspent remainder of expired earnings — surfaced, never silently deducted. */
export function expiredBalanceFor(earnings: ReferralEarning[], nowMs: number, expiryPeriodMs: number): number {
  let total = 0;
  for (const e of earnings) {
    if (!isEarningExpired(e, nowMs, expiryPeriodMs)) continue;
    total = round2(total + round2(e.amountUSD - e.redeemedAmountUSD));
  }
  return total;
}

/** Vested, unspent, unexpired remainder across a user's earnings. */
export function redeemableBalanceFor(
  earnings: ReferralEarning[],
  nowMs: number,
  expiryPeriodMs = 0,
): number {
  let total = 0;
  for (const e of earnings) {
    if (!isEarningVested(e, nowMs)) continue;
    if (isEarningExpired(e, nowMs, expiryPeriodMs)) continue;
    total = round2(total + round2(e.amountUSD - e.redeemedAmountUSD));
  }
  return total;
}

export interface ReferralAllocation {
  earningId: string;
  amountUSD: number;
}

/**
 * Pure oldest-first allocation over VESTED, UNEXPIRED earnings
 * only (#5229: expired earnings are never allocated, even when
 * the unexpired balance is short). Unvested earnings are never
 * allocated either. A shortfall throws, it never dips into
 * unvested or expired credit — and the error names the expired
 * amount when expiry is (part of) the reason, so the caller can
 * surface it instead of failing silently. Throws before any
 * write (adapters allocate with this helper, then apply the
 * allocation).
 */
export function allocateRedemption(
  earnings: ReferralEarning[],
  amountUSD: number,
  nowMs: number,
  expiryPeriodMs = 0,
): ReferralAllocation[] {
  const amount = round2(amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  const vested = [...earnings]
    .filter(
      (e) =>
        isEarningVested(e, nowMs) &&
        !isEarningExpired(e, nowMs, expiryPeriodMs) &&
        round2(e.amountUSD - e.redeemedAmountUSD) > 0,
    )
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
    const expired = expiredBalanceFor(earnings, nowMs, expiryPeriodMs);
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return allocations;
}

export interface ReferralAttribution {
  /** The referred user; the attribution row key (one attribution per referred user, ever). */
  referredUserId: string;
  referrerUserId: string;
  tenantId: string;
  /**
   * How the attribution was recorded. `operator` = the operator attribution
   * route (#2657). `code` = a referral-kind code redemption (#3307), which
   * passes `source: "code"`; the operator route always stamps `operator`
   * regardless of client input. `signup` = captured at account creation
   * from a referral code or link (#5226, 2.27); the setup route always
   * stamps `signup` regardless of which form resolved.
   */
  source: "operator" | "code" | "signup";
  createdAtMs: number;
}

/**
 * Issue #6141 — one trial-extension grant. One per referred user,
 * ever: the first verified paid run grants the referrer the rule's
 * extensionDays, and a replay returns the existing row (the id is
 * deterministic, the same pattern as referralEarningId). The grant
 * is TIME only (D-2.25): it extends a trial's periodEndMs or banks
 * as free days — it never touches a commercial balance, never
 * mints a subscription, never pays for a plan, never converts to
 * credits. Banked rows expire per the rule's expiryPeriodMs
 * (D-2.31); applied/consumed rows are spent and never expire.
 */
export type ReferralTrialExtensionStatus = "applied" | "banked" | "consumed";

export interface ReferralTrialExtension {
  id: string;
  referrerUserId: string;
  referredUserId: string;
  tenantId: string;
  daysGranted: number;
  status: ReferralTrialExtensionStatus;
  /** The trial row extended (applied) or later consumed into (consumed); null while banked. */
  subscriptionId: string | null;
  grantedAtMs: number;
  /** Null when the rule's expiryPeriodMs is 0 (never expires). */
  expiresAtMs: number | null;
  appliedAtMs: number | null;
  consumedAtMs: number | null;
}

/** Deterministic extension id: one extension per referred user. */
export function trialExtensionId(referredUserId: string): string {
  return `trial-ext:${referredUserId}`;
}

/**
 * Issue #6141: expiry is measured from GRANT time (grantedAtMs).
 * The boundary is inclusive: at exactly grantedAtMs + expiry the
 * banked days are expired. expiresAtMs null means never expires.
 * Applied/consumed rows never expire — they are spent.
 */
export function isExtensionExpired(extension: ReferralTrialExtension, nowMs: number): boolean {
  if (extension.status !== "banked") return false;
  if (extension.expiresAtMs === null) return false;
  return nowMs >= extension.expiresAtMs;
}

/** Unexpired banked days across a user's extensions. */
export function bankedExtensionDaysFor(
  extensions: ReferralTrialExtension[],
  nowMs: number,
): number {
  let total = 0;
  for (const e of extensions) {
    if (e.status !== "banked") continue;
    if (isExtensionExpired(e, nowMs)) continue;
    total += e.daysGranted;
  }
  return total;
}

/**
 * Issue #6141 — the trial-extension ledger port. The ledger is the
 * audit for every grant: caps count its rows, the profile panel
 * reads its sums, and the banked-apply path consumes its rows
 * oldest-expiring-first. All reads are referrer-scoped.
 */
export interface ReferralTrialExtensionPort {
  /**
   * Record a grant. Insert-or-ignore by id: replaying the same
   * referred user returns the existing row, never a second grant.
   */
  recordExtension(input: ReferralTrialExtension): Promise<ReferralTrialExtension>;
  /** All extensions for one referrer, oldest first. No unscoped read. */
  listExtensions(referrerUserId: string): Promise<ReferralTrialExtension[]>;
  /** Grants for one referrer at or after sinceMs (cap counting). */
  countExtensionsSince(referrerUserId: string, sinceMs: number): Promise<number>;
  /** Mark a banked row applied to a trial (extends periodEndMs). */
  markExtensionApplied(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null>;
  /** Mark a banked row consumed into a later trial. */
  markExtensionConsumed(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null>;
}

export interface ReferralCreditPort {
  /** The stored operator rule row (seeded by migration 0015). */
  getRules(): Promise<ReferralRules>;
  /** Operator-only: replace the rule row (no code deploy needed). */
  setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
    /** #5229: optional — absent keeps the seeded 90-day default. */
    expiryPeriodMs?: unknown;
    /** #6141: optional — absent keeps the seeded PROPOSED defaults. */
    extensionDays?: unknown;
    referredTrialDays?: unknown;
    maxExtensionsPerDay?: unknown;
    maxExtensionsPerMonth?: unknown;
    referralTrialPlanId?: unknown;
    shareMessageTemplate?: unknown;
  }): Promise<ReferralRules>;
  /**
   * Record a referrer→referred attribution (#2657). Set-once: replaying the
   * SAME referrer for the same referred user returns the existing row;
   * a DIFFERENT referrer for an already-attributed user throws (never a
   * silent overwrite); self-referral throws; blank ids/tenant throw.
   * Attribution alone earns nothing — it only lets the automatic earn
   * trigger (submit path) know whom to credit on the referred user's
   * first paid run. It is deliberately separate from the earning rows:
   * attribution is the link, the earning is the money.
   */
  recordAttribution(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
    /**
     * Additive, optional (#3307): which surface recorded the
     * attribution. Defaults to "operator" — existing callers
     * pass nothing and their rows keep stamping "operator".
     * A referral-kind code redemption passes "code".
     */
    source?: ReferralAttribution["source"];
  }): Promise<ReferralAttribution>;
  /** The attribution row for one referred user, or null when unattributed. */
  getAttribution(referredUserId: string): Promise<ReferralAttribution | null>;
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
   * Redeem an exact amount against vested, unexpired earnings,
   * oldest first (#5229: expired earnings are never allocated).
   * Throws on insufficient vested balance, on a tenant mismatch
   * (any allocated earning's tenant differs from the caller's
   * tenant), or on a non-positive amount — before applying any
   * allocation that would leave a partial spend unrecorded
   * (allocation is computed pure-first). The returned expiredUSD
   * is the unspent remainder of expired earnings at redeem time:
   * surfaced, never silently deducted.
   */
  redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number; expiredUSD: number }>;
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
  /**
   * Issue #2660 (monetization Phase 2.5): commercial-plane mail
   * suppression on deactivation. Flips digestEnabled AND welcomeEnabled
   * off on the user's preference row (the table's primary key is
   * user_id alone, so one row covers the user — no tenant-mismatch
   * trap). The scheduled digest pass enumerates digestEnabled=1 rows
   * only, and the send-time checks enforce both flags, so this is
   * what makes "deactivation stops digest mail" true. Returns the
   * flipped row, or null when no row exists (defaults are already
   * digest-OFF; a missing row needs no suppression write).
   */
  suppressMailForUser(userId: string): Promise<NotificationPreferences | null>;
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

/**
 * Issue #2659 (monetization Phase 2.4): a digest subscriber for the
 * scheduled pass. The email is the address mail was last
 * successfully sent to for this subscriber (recorded by the send
 * routes) — never guessed, never derived from a login. Null when
 * no address is on file; the pass reports such subscribers as
 * `no-email-on-file` and never attempts a send.
 */
export interface DigestSubscriber {
  userId: string;
  tenantId: string;
  email: string | null;
}

/**
 * Issue #2659: the scheduled digest pass port. Enumeration is
 * digestEnabled=1 rows only; the email JOIN is tenant-aware (a
 * row for another tenant never leaks an address across tenants).
 * setSubscriberEmail mirrors setPreferences' #1761 fail-closed
 * idiom: a stored row for another tenant throws before any write.
 */
export interface DigestPassPort {
  /** Digest-enabled subscribers, ordered by user_id, with addresses. */
  listDigestSubscribers(): Promise<DigestSubscriber[]>;
  /** Record the address a successful send used. Throws on blank inputs or tenant mismatch. */
  setSubscriberEmail(userId: string, tenantId: string, email: string): Promise<void>;
  /** True when the scheduled pass already ran on this UTC day. */
  hasDigestPassRun(day: string): Promise<boolean>;
  /** Idempotent: re-marking the same day is a no-op. */
  markDigestPassRun(day: string): Promise<void>;
}

/** The full lifecycle store: referral + preferences + digest guard + digest pass + trial extensions (#6141). */
export type LifecycleStore = ReferralCreditPort &
  NotificationPreferencePort &
  DigestGuardPort &
  DigestPassPort &
  ReferralTrialExtensionPort;
