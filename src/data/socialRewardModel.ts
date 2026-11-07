/**
 * Issue #3477 ([Social rewards] Reward model + ledger alignment, parent #3476).
 *
 * The reward model the whole #3476 program runs on, as pure rules.
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the config schema + validators, and pure helpers ONLY. It imports
 * no store client, references no env binding, and writes no SQL.
 * All query-builder code lives in the adapters of the slices that
 * persist grants; this slice persists nothing.
 *
 * What the model states (see docs/architecture/business/social-rewards-model.md):
 *
 * - Reward types map onto EXISTING mechanisms, never a parallel
 *   system: `credit` reuses the referral-ledger RULES (earn -> vest
 *   -> oldest-first allocation -> commercial conversion -> the
 *   existing gate coverage) but is NEVER recorded as a referral
 *   earning; `free-runs` is a SEPARATE BUCKET under the #3305
 *   free-run counter (allowance-first coverage order); `free-month`
 *   is an operator subscription grant / trial (#3243/#3245).
 * - Accumulation: grants accumulate as separate records; redemption
 *   is oldest-first over vested + unexpired + unredeemed grants.
 * - Every grant carries a mandatory expiry; zero never means "no
 *   expiry". Expiry is evaluated at redeem time.
 * - Caps are per-type, per-user: daily (UTC day) and monthly (UTC
 *   calendar month), from config, never code.
 * - Every value is owner/CBO-decided and unset (null) until
 *   configured. An unconfigured type is unavailable (fail-closed).
 * - No grant without a VERIFIED social action; no self-reward.
 * - Tenant scoping (#1069 §8): every grant/redemption carries a
 *   server-resolved tenantId; a mismatch throws; no unscoped read.
 *
 * The outcome-code map below is the AOP contract for this model:
 * every grant/expire/redeem outcome has a catalog entry, resolved
 * only through src/outcomes/outcomeAspects.ts. A test pins every
 * mapped code exists in the catalog with the expected outcome.
 */
import type { MarketingChannel } from "./productMarketing";
import { round2 } from "./lifecyclePorts";

/** Reward kinds. Each maps onto an existing mechanism (see the module header). */
export type SocialRewardType = "credit" | "free-runs" | "free-month";

/** The social actions that can earn a reward. */
export type SocialAction = "like" | "share" | "subscribe";

/** Platforms are the product marketing channels. Slack is share/notification only. */
export type SocialPlatform = MarketingChannel;

/** The three reward types, in model order. */
export const SOCIAL_REWARD_TYPES: readonly SocialRewardType[] = [
  "credit",
  "free-runs",
  "free-month",
];

/**
 * Outcome codes for the reward lifecycle. The catalog entries live
 * in src/outcomes/outcomeCatalog.json (category "commercial") and
 * are resolved only through the outcome resolver.
 */
export const SOCIAL_REWARD_OUTCOME_CODES = {
  granted: "SUCCESS_SOCIAL_REWARD_GRANTED",
  redeemed: "SUCCESS_SOCIAL_REWARD_REDEEMED",
  notConfigured: "FAILURE_SOCIAL_REWARD_NOT_CONFIGURED",
  expired: "FAILURE_SOCIAL_REWARD_EXPIRED",
  notVested: "FAILURE_SOCIAL_REWARD_NOT_VESTED",
  capReached: "FAILURE_SOCIAL_REWARD_CAP_REACHED",
  notVerified: "FAILURE_SOCIAL_REWARD_NOT_VERIFIED",
} as const;

/**
 * Per-type configuration. Every field is nullable: null means
 * "unconfigured" (owner/CBO have not decided a value), and an
 * unconfigured type is unavailable — never defaulted, never
 * guessed. `amountUSD` belongs to `credit` only; `runs` belongs
 * to `free-runs` only; `free-month` carries neither.
 */
export interface SocialRewardTypeConfig {
  enabled: boolean | null;
  /** Milliseconds between granting and vesting (redemption eligibility). */
  vestingDelayMs: number | null;
  /** Milliseconds between granting and expiry. Mandatory when configured; zero never means "no expiry". */
  expiryWindowMs: number | null;
  /** Max uses per user per UTC day. */
  dailyCap: number | null;
  /** Max uses per user per UTC calendar month. */
  monthlyCap: number | null;
  /** Credit grant amount in USD (credit only). */
  amountUSD: number | null;
  /** Free-run grant size in runs (free-runs only). */
  runs: number | null;
}

/** The whole reward configuration: one block per reward type. */
export interface SocialRewardConfig {
  credit: SocialRewardTypeConfig;
  "free-runs": SocialRewardTypeConfig;
  "free-month": SocialRewardTypeConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    throw new Error(`Social reward config ${field} must be a boolean or null.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`Social reward config ${field} must be a non-negative integer or null.`);
  }
  return n;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new Error(`Social reward config ${field} must be a positive integer or null.`);
  }
  return n;
}

function optionalPositiveAmountUSD(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const amount = round2(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Social reward config ${field} must be a positive finite USD amount or null.`);
  }
  return amount;
}

function validateTypeConfig(
  input: unknown,
  type: SocialRewardType,
): SocialRewardTypeConfig {
  if (!isRecord(input)) {
    throw new Error(`Social reward config for "${type}" must be an object.`);
  }
  const config: SocialRewardTypeConfig = {
    enabled: optionalBoolean(input.enabled, `${type}.enabled`),
    vestingDelayMs: optionalNonNegativeInteger(
      input.vestingDelayMs,
      `${type}.vestingDelayMs`,
    ),
    expiryWindowMs: optionalPositiveInteger(
      input.expiryWindowMs,
      `${type}.expiryWindowMs`,
    ),
    dailyCap: optionalPositiveInteger(input.dailyCap, `${type}.dailyCap`),
    monthlyCap: optionalPositiveInteger(input.monthlyCap, `${type}.monthlyCap`),
    amountUSD: optionalPositiveAmountUSD(input.amountUSD, `${type}.amountUSD`),
    runs: optionalPositiveInteger(input.runs, `${type}.runs`),
  };
  // Cross-field misuse: each type carries only its own unit.
  if (type !== "credit" && config.amountUSD !== null) {
    throw new Error(
      `Social reward config for "${type}" must not carry amountUSD (credit only).`,
    );
  }
  if (type !== "free-runs" && config.runs !== null) {
    throw new Error(
      `Social reward config for "${type}" must not carry runs (free-runs only).`,
    );
  }
  return config;
}

/**
 * Strict validation of the whole reward configuration. Nulls are
 * allowed everywhere (unconfigured); anything else must satisfy
 * the per-field rules above. Throws on malformed input — the
 * loader fails fast at startup rather than serving a half-valid
 * config. Follows the `validateReferralRules` idiom: structural
 * validation throws descriptive errors; the route layer maps them
 * to catalog codes.
 */
export function validateSocialRewardConfig(input: unknown): SocialRewardConfig {
  if (!isRecord(input)) {
    throw new Error("Social reward config must be an object with credit, free-runs, and free-month blocks.");
  }
  return {
    credit: validateTypeConfig(input.credit, "credit"),
    "free-runs": validateTypeConfig(input["free-runs"], "free-runs"),
    "free-month": validateTypeConfig(input["free-month"], "free-month"),
  };
}

/**
 * Fail-closed availability: a type is available only when it is
 * enabled AND every value its rules need is configured. Anything
 * else returns the not-configured outcome — there is no fallback
 * value anywhere in code.
 */
export function resolveSocialRewardAvailability(
  config: SocialRewardConfig,
  type: SocialRewardType,
): { available: boolean; code: string | null } {
  const block = config[type];
  const required: Array<number | null> = [
    block.vestingDelayMs,
    block.expiryWindowMs,
    block.dailyCap,
    block.monthlyCap,
  ];
  if (type === "credit") required.push(block.amountUSD);
  if (type === "free-runs") required.push(block.runs);
  if (
    block.enabled !== true ||
    required.some((value) => value === null || value === undefined)
  ) {
    return {
      available: false,
      code: SOCIAL_REWARD_OUTCOME_CODES.notConfigured,
    };
  }
  return { available: true, code: null };
}

/**
 * One social reward grant. The record shape the future store will
 * carry (defined here; the store arrives in a later slice — this
 * slice persists nothing). Eligibility is DERIVED from these
 * fields + nowMs (vested, unexpired, unredeemed); there is no
 * separate status field to drift.
 */
export interface SocialRewardGrant {
  id: string;
  userId: string;
  tenantId: string;
  type: SocialRewardType;
  action: SocialAction;
  platform: SocialPlatform;
  amountUSD: number | null;
  runs: number | null;
  /**
   * Spent portions (partial redemption, the referral-ledger idiom):
   * `redeemedAmountUSD` tracks the spent credit (credit only, 0
   * otherwise); `redeemedRuns` tracks the spent runs (free-runs
   * only, 0 otherwise). The remainder stays redeemable once
   * vested. `redeemedAtMs` is set when the grant is FULLY redeemed
   * (remainder 0); a partially redeemed grant keeps
   * `redeemedAtMs` null with a positive remainder.
   */
  redeemedAmountUSD: number;
  redeemedRuns: number;
  grantedAtMs: number;
  vestedAtMs: number;
  expiresAtMs: number;
  redeemedAtMs: number | null;
  /** The run request id or subscription id that consumed this grant, if any. */
  redeemedFor: string | null;
}

/** Unspent remainder of a grant: credit in USD, runs as a count (only the grant's own unit is non-zero). */
export function grantRemainder(grant: SocialRewardGrant): {
  amountUSD: number;
  runs: number;
} {
  return {
    amountUSD: round2((grant.amountUSD ?? 0) - grant.redeemedAmountUSD),
    runs: (grant.runs ?? 0) - grant.redeemedRuns,
  };
}

/**
 * Deterministic grant id: one grant per (user, type, action,
 * platform) per UTC day. A replay of the same verified action on
 * the same day returns the existing grant — never a second mint
 * (idempotent-receiver rule).
 */
export function socialRewardGrantId(input: {
  userId: string;
  type: SocialRewardType;
  action: SocialAction;
  platform: SocialPlatform;
  dayKey: string;
}): string {
  return `social:${input.userId}:${input.type}:${input.action}:${input.platform}:${input.dayKey}`;
}

/** True exactly at and after vestedAtMs. */
export function isGrantVested(grant: SocialRewardGrant, nowMs: number): boolean {
  return nowMs >= grant.vestedAtMs;
}

/** True exactly at and after expiresAtMs — at the instant of expiry the grant is gone. */
export function isGrantExpired(grant: SocialRewardGrant, nowMs: number): boolean {
  return nowMs >= grant.expiresAtMs;
}

/**
 * Redeemable grants of one type: vested + unexpired + a positive
 * unspent remainder, oldest first (grantedAtMs, id tiebreak — the
 * same idiom as the referral ledger's allocation). Unvested,
 * expired, and fully spent grants are never returned, even when
 * the redeemable balance is short.
 */
export function redeemableGrants(
  grants: SocialRewardGrant[],
  type: SocialRewardType,
  nowMs: number,
): SocialRewardGrant[] {
  return [...grants]
    .filter((g) => {
      if (g.type !== type) return false;
      if (!isGrantVested(g, nowMs) || isGrantExpired(g, nowMs)) return false;
      const remainder = grantRemainder(g);
      return type === "credit" ? remainder.amountUSD > 0 : remainder.runs > 0;
    })
    .sort((a, b) => a.grantedAtMs - b.grantedAtMs || (a.id < b.id ? -1 : 1));
}

export interface SocialCreditAllocation {
  grantId: string;
  amountUSD: number;
}

/**
 * Pure oldest-first allocation of a credit amount over redeemable
 * credit grants. Throws on shortfall — it never dips into
 * unvested or expired credit, and it allocates nothing on failure
 * (allocation is computed pure-first, before any write).
 */
export function allocateSocialCreditRedemption(
  grants: SocialRewardGrant[],
  amountUSD: number,
  nowMs: number,
): SocialCreditAllocation[] {
  const amount = round2(amountUSD);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Social credit redemption amountUSD must be a positive finite number.");
  }
  const redeemable = redeemableGrants(grants, "credit", nowMs);
  let remaining = amount;
  const allocations: SocialCreditAllocation[] = [];
  for (const g of redeemable) {
    if (remaining <= 0) break;
    const available = grantRemainder(g).amountUSD;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    allocations.push({ grantId: g.id, amountUSD: take });
    remaining = round2(remaining - take);
  }
  if (remaining > 0) {
    throw new Error(
      `Insufficient vested social reward balance: need ${amount}, vested available ${round2(amount - remaining)}.`,
    );
  }
  return allocations;
}

export interface SocialRunAllocation {
  grantId: string;
  runs: number;
}

/**
 * Pure oldest-first allocation of a run count over redeemable
 * free-runs grants. Same fail-safe shape as the credit
 * allocation: shortfall throws, unvested/expired never allocated.
 */
export function allocateSocialRunRedemption(
  grants: SocialRewardGrant[],
  runs: number,
  nowMs: number,
): SocialRunAllocation[] {
  if (!Number.isFinite(runs) || runs <= 0 || Math.floor(runs) !== runs) {
    throw new Error("Social free-run redemption runs must be a positive integer.");
  }
  const redeemable = redeemableGrants(grants, "free-runs", nowMs);
  let remaining = runs;
  const allocations: SocialRunAllocation[] = [];
  for (const g of redeemable) {
    if (remaining <= 0) break;
    const available = grantRemainder(g).runs;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    allocations.push({ grantId: g.id, runs: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(
      `Insufficient vested social reward balance: need ${runs} runs, vested available ${runs - remaining} runs.`,
    );
  }
  return allocations;
}

/**
 * Daily/monthly cap evaluation for one reward type: daily first,
 * then monthly. Uses are counts in the current UTC day / UTC
 * calendar month (the windows are defined by `digestDayKey` and
 * `freeRunMonthKey`; the counts themselves are supplied by the
 * caller). At either cap the use is refused with the cap code.
 */
export function evaluateSocialCaps(input: {
  usesToday: number;
  usesThisMonth: number;
  dailyCap: number;
  monthlyCap: number;
}): { allowed: boolean; code: string | null } {
  if (input.usesToday >= input.dailyCap || input.usesThisMonth >= input.monthlyCap) {
    return { allowed: false, code: SOCIAL_REWARD_OUTCOME_CODES.capReached };
  }
  return { allowed: true, code: null };
}

/**
 * Run-coverage stacking order (#3477 §4.1): the free-run
 * allowance covers a run first; the social free-runs bucket
 * covers only when the allowance is exhausted for that
 * (family, month); a run is never covered by both. Neither
 * bucket extends the other, so rewards can never become a way
 * around the allowance cap by another name.
 */
export function resolveRunCoverage(input: {
  allowanceRemaining: number;
  socialRemaining: number;
}): "allowance" | "social-bucket" | "none" {
  if (input.allowanceRemaining > 0) return "allowance";
  if (input.socialRemaining > 0) return "social-bucket";
  return "none";
}

/**
 * Free-month stacking (#3477 §4.2): a free month is issuable only
 * when the user holds no active paid subscription and no active
 * free period (trial or operator grant). Otherwise the grant
 * waits until its expiry — the reason names which free/paid state
 * is holding it. Never double-grants, never silently extends a
 * paid period.
 */
export function resolveFreeMonthEligibility(input: {
  hasActivePaidSubscription: boolean;
  hasActiveFreePeriod: boolean;
}): {
  eligible: boolean;
  reason: "active-subscription" | "active-free-period" | null;
} {
  if (input.hasActivePaidSubscription) {
    return { eligible: false, reason: "active-subscription" };
  }
  if (input.hasActiveFreePeriod) {
    return { eligible: false, reason: "active-free-period" };
  }
  return { eligible: true, reason: null };
}

/**
 * Tenant guard (#1069 §8): a grant's tenant must equal the
 * caller's server-resolved tenant. Blank ids throw — a missing
 * tenant is never treated as a match.
 */
export function assertSocialRewardTenant(
  grantTenantId: string,
  tenantId: string,
): void {
  if (!grantTenantId || !tenantId) {
    throw new Error("Social reward tenant must be present on both the grant and the caller.");
  }
  if (grantTenantId !== tenantId) {
    throw new Error("Social reward tenant mismatch: the grant belongs to another tenant.");
  }
}

/**
 * No self-reward: the actor and the beneficiary must differ (the
 * referral ledger's self-referral rule). Invite codes reward BOTH
 * sides, but inviter ≠ invitee by construction.
 */
export function assertSocialGrantParties(
  actorUserId: string,
  beneficiaryUserId: string,
): void {
  if (!actorUserId || !beneficiaryUserId) {
    throw new Error("Social reward actor and beneficiary must both be present.");
  }
  if (actorUserId === beneficiaryUserId) {
    throw new Error("Social reward self-reward is not allowed: actor and beneficiary must differ.");
  }
}

/**
 * Verification gate: a grant mints only on a VERIFIED social
 * action. An unverified claim never mints — the error names the
 * catalog code the route layer resolves it to
 * (FAILURE_SOCIAL_REWARD_NOT_VERIFIED). Verification itself is
 * built by #3479–#3481; until then no grant can mint.
 */
export function requireVerifiedSocialAction(verified: boolean): void {
  if (!verified) {
    throw new Error(
      `Social reward action is not verified (${SOCIAL_REWARD_OUTCOME_CODES.notVerified}).`,
    );
  }
}

/**
 * Platform/action matrix (#3476): like and subscribe are
 * supported on facebook, instagram, threads only. Share is
 * supported on all four marketing channels, including slack.
 * Slack is a notification/delivery channel, never a
 * like/subscribe platform.
 */
export function assertSocialActionSupported(
  action: SocialAction,
  platform: SocialPlatform,
): void {
  if ((action === "like" || action === "subscribe") && platform === "slack") {
    throw new Error(
      `Social reward action "${action}" is not supported on slack (share only).`,
    );
  }
}
