/**
 * Issue #3307 (sub-issue of #3241), slice 1 — referral/invite
 * code ports.
 *
 * This module is the ADR 0002 R1 boundary for referral codes:
 * it imports no store client, references no env binding, and
 * writes no SQL. Only the adapters (Drizzle D1, in-memory)
 * touch a store, and only the composition root
 * (createReferralCodePorts.ts) maps a Worker binding to an
 * adapter.
 *
 * A code is a bearer token that, redeemed by a verified login,
 * credits RUNS to that login's code-runs balance. Codes confer
 * runs only — never tier, never credits, never a price, never
 * access. The code VALUE is never stored: only its SHA-256
 * hash (plus a display prefix) is persisted, and the plaintext
 * is returned once, at issuance.
 *
 * Rules are keyed by (productId, issuer) and are the ONLY
 * source of issuance/redemption terms; there is no code-constant
 * fallback. A missing rule, or an inactive rule, disables codes
 * for that (product, issuer) entirely — issuance refuses,
 * redemption refuses (fail-closed). Rule terms (runs,
 * reusability, expiry) are SNAPSHOTTED onto the code row at
 * issuance, so a later rule edit never reprices outstanding
 * codes; caps are read LIVE from the rule at redemption, so an
 * operator tightening a cap affects outstanding codes
 * immediately.
 *
 * The code-runs balance is one row per login, family-agnostic,
 * with no expiry and no clawback (mirroring
 * agent_runs_pack_balances). It is a SEPARATE bucket from the
 * Free-run counter: code runs never increment the counter, and
 * the gate spends the allowance FIRST, so code runs are honestly
 * "on top" of sign-up and grants.
 *
 * Attribution reuses the #2657 ledger through
 * ReferralCreditPort.recordAttribution with source "code"
 * (the value reserved for exactly this). An attribution
 * outcome never fails a redemption; invite codes never
 * attribute; the earn trigger is unchanged.
 *
 * This slice builds NO #3247 state: it reads no free-access
 * table, port, or route, and it keeps working if #3247 never
 * lands.
 */

import type { Membership } from "../security/authorization";

/** Who may issue codes under a rule. */
export type ReferralCodeIssuer = "platform_admin" | "tenant_admin" | "user";

/** A code's kind: referral (attribution-eligible) or invite (never attributes). */
export type ReferralCodeKind = "referral" | "invite";

/** How a referral-kind redemption under a rule treats attribution. */
export type ReferralCodeAttributionMode = "ledger" | "none";

/** Validate a code issuer value. */
export function assertReferralCodeIssuer(value: unknown): ReferralCodeIssuer {
  if (value !== "platform_admin" && value !== "tenant_admin" && value !== "user") {
    throw new Error('Referral code issuer must be "platform_admin", "tenant_admin", or "user".');
  }
  return value;
}

/** Validate a code kind value. */
export function assertReferralCodeKind(value: unknown): ReferralCodeKind {
  if (value !== "referral" && value !== "invite") {
    throw new Error('Referral code kind must be "referral" or "invite".');
  }
  return value;
}

/** Validate an attribution-mode value. */
export function assertReferralCodeAttributionMode(value: unknown): ReferralCodeAttributionMode {
  if (value !== "ledger" && value !== "none") {
    throw new Error('Referral code attribution mode must be "ledger" or "none".');
  }
  return value;
}

/** Validate a positive-integer runs count (runs per code, balance credits). */
export function assertCodeRuns(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Code runs must be a positive integer.");
  }
  return value;
}

/** Validate an optional cap: null (uncapped) or a non-negative integer. */
export function assertCodeCap(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be null or a non-negative integer.`);
  }
  return value;
}

/** Normalize a 0/1/boolean flag to a boolean. */
function assertFlag(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new Error(`${name} must be a boolean or 0/1.`);
}

/**
 * Validate a rule upsert input (operator data). Terms that are
 * absent default to the fail-closed shape: not reusable, no
 * expiry, uncapped, inactive. A rule is created inactive — the
 * operator activates it in the UI; nothing is live until then.
 */
export function assertReferralCodeRuleInput(input: {
  productId?: unknown;
  issuer?: unknown;
  runsPerCode?: unknown;
  reusable?: unknown;
  expiryDays?: unknown;
  attributionMode?: unknown;
  maxRedemptionsPerCode?: unknown;
  maxRedemptionsPerLogin?: unknown;
  globalCap?: unknown;
  active?: unknown;
}): {
  productId: string;
  issuer: ReferralCodeIssuer;
  runsPerCode: number;
  reusable: boolean;
  expiryDays: number | null;
  attributionMode: ReferralCodeAttributionMode;
  maxRedemptionsPerCode: number | null;
  maxRedemptionsPerLogin: number | null;
  globalCap: number | null;
  active: boolean;
} {
  const productId =
    typeof input.productId === "string" && input.productId.trim() ? input.productId.trim() : "";
  if (!productId) throw new Error("Referral code rule productId is required.");
  const issuer = assertReferralCodeIssuer(input.issuer);
  const runsPerCode = assertCodeRuns(input.runsPerCode);
  const reusable = assertFlag(input.reusable, "reusable", false);
  let expiryDays: number | null = null;
  if (input.expiryDays !== undefined && input.expiryDays !== null) {
    if (
      typeof input.expiryDays !== "number" ||
      !Number.isInteger(input.expiryDays) ||
      input.expiryDays < 1
    ) {
      throw new Error("expiryDays must be null or a positive integer number of days.");
    }
    expiryDays = input.expiryDays;
  }
  const attributionMode = assertReferralCodeAttributionMode(input.attributionMode);
  return {
    productId,
    issuer,
    runsPerCode,
    reusable,
    expiryDays,
    attributionMode,
    maxRedemptionsPerCode: assertCodeCap(input.maxRedemptionsPerCode, "maxRedemptionsPerCode"),
    maxRedemptionsPerLogin: assertCodeCap(input.maxRedemptionsPerLogin, "maxRedemptionsPerLogin"),
    globalCap: assertCodeCap(input.globalCap, "globalCap"),
    active: assertFlag(input.active, "active", false),
  };
}

/**
 * Validate the kind/referrer coherence of an issuance request.
 * A referral code REQUIRES a referrer; an invite code FORBIDS
 * one. The route enforces who the referrer may be (the caller
 * for user issuance; any login for operator issuance).
 */
export function assertReferrerForKind(
  kind: ReferralCodeKind,
  referrerUserId: string | null | undefined,
): string | null {
  const referrer =
    typeof referrerUserId === "string" && referrerUserId.trim() ? referrerUserId.trim() : null;
  if (kind === "referral" && !referrer) {
    throw new Error("A referral code requires a referrerUserId.");
  }
  if (kind === "invite" && referrer) {
    throw new Error("An invite code must not carry a referrerUserId.");
  }
  return referrer;
}

/** Crockford base32 alphabet (no I, L, O, U — no ambiguous glyphs). */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Normalize a submitted code value: uppercase, dashes/spaces
 * stripped, exactly 16 Crockford base32 characters. Anything
 * else throws — the caller maps it to the generic invalid
 * response, so a guessing attacker learns nothing.
 */
export function normalizeCodeValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Referral code must be a string.");
  const normalized = value.toUpperCase().replace(/[-\s]/g, "");
  if (
    normalized.length !== 16 ||
    [...normalized].some((ch) => !CROCKFORD_ALPHABET.includes(ch))
  ) {
    throw new Error("Referral code must be 16 Crockford base32 characters.");
  }
  return normalized;
}

/** SHA-256 hex of the normalized code value (WebCrypto, Workers + Node). */
export async function hashCodeValue(normalized: string): Promise<string> {
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a code value: 10 random bytes (80 bits) rendered as
 * 16 Crockford characters in 4 groups of 4. Server-side only.
 */
export function generateCodeValue(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const chars: string[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars.push(CROCKFORD_ALPHABET[(buffer >> bits) & 31]);
    }
  }
  return (
    `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-` +
    `${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`
  );
}

/** The display prefix of a code value: the first group (4 chars). */
export function displayPrefixForCodeValue(normalized: string): string {
  return normalized.slice(0, 4);
}

/** A code is expired exactly when its expiry is set and not in the future. */
export function isCodeExpired(code: { expiresAtMs: number | null }, nowMs: number): boolean {
  return code.expiresAtMs !== null && code.expiresAtMs <= nowMs;
}

/**
 * A code is redeemable only while its rule is active, it is
 * unrevoked, and its expiry (if any) is in the future. Pure
 * over the rows; the adapters and the redeem service apply the
 * same predicate.
 */
export function isCodeRedeemable(
  code: { revokedAtMs: number | null; expiresAtMs: number | null },
  rule: { active: boolean } | null,
  nowMs: number,
): boolean {
  if (!rule || !rule.active) return false;
  if (code.revokedAtMs !== null) return false;
  return !isCodeExpired(code, nowMs);
}

/**
 * Tenant-admin check, mirroring isPlatformAdmin
 * (src/security/iaaaAdminOverview.ts): the caller holds a
 * tenant-admin role binding in the named tenant, on an
 * unrevoked membership, with the binding unexpired. Reads
 * only — IAAA writes stay CISO-owned.
 */
export function isTenantAdminForTenant(
  memberships: Membership[],
  tenantId: string,
  nowMs: number,
): boolean {
  return memberships.some(
    (m) =>
      m.tenantId === tenantId &&
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "tenant-admin" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
      ),
  );
}

/** One referral-code rule: the issuance/redemption terms for (productId, issuer). */
export interface ReferralCodeRule {
  /** Server-generated id (`coderule-<uuid8>`). */
  id: string;
  productId: string;
  issuer: ReferralCodeIssuer;
  /** Runs one redemption credits. Positive integer. */
  runsPerCode: number;
  /** False = one-time (a login redeems a given code at most once); true = reusable. */
  reusable: boolean;
  /** Code lifetime from issuance in days; null = no expiry. */
  expiryDays: number | null;
  attributionMode: ReferralCodeAttributionMode;
  /** Null = uncapped. */
  maxRedemptionsPerCode: number | null;
  /** Null = uncapped. Per (code, login) count. */
  maxRedemptionsPerLogin: number | null;
  /** Null = uncapped. Total redemptions across all codes under this rule. */
  globalCap: number | null;
  /** Denormalized counter backing the global cap's conditional increment. */
  redemptionCount: number;
  /** False = codes disabled under this rule. Seeds land inactive. */
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One issued referral code: a row of agent_referral_codes. The VALUE is never stored. */
export interface ReferralCode {
  /** Server-generated id (`code-<uuid8>`). */
  id: string;
  /** Hex SHA-256 of the normalized code value. The redemption lookup key. */
  codeHash: string;
  /** First group (4 chars) — operator listing + user display without revealing the code. */
  displayPrefix: string;
  /** The rule whose terms this code carries (snapshot: terms copied at issuance). */
  ruleId: string;
  productId: string;
  kind: ReferralCodeKind;
  /** Verified session login that issued the code. */
  issuerLogin: string;
  /** The check that authorized issuance. */
  issuerKind: ReferralCodeIssuer;
  /** Required when kind is referral; must be null when kind is invite. */
  referrerUserId: string | null;
  /** Null = any tenant; non-null = redeemable only by accounts in that tenant. */
  tenantScope: string | null;
  /** Runs one redemption credits — snapshotted from the rule at issuance. */
  runs: number;
  /** Snapshotted from the rule at issuance. */
  reusable: boolean;
  /** Issuance time + expiry_days, or null. Snapshotted; a rule edit never extends it. */
  expiresAtMs: number | null;
  /** Set by revoke; a revoked code never redeems. */
  revokedAtMs: number | null;
  /** Denormalized; backs the per-code cap's conditional increment. */
  redemptionCount: number;
  createdAtMs: number;
}

/** One code redemption: a row of agent_code_redemptions (the audit + idempotency record). */
export interface CodeRedemption {
  /** Server-generated id (`red-<uuid8>`). */
  id: string;
  codeId: string;
  redeemerLogin: string;
  /** Resolved server-side at redemption (session/account). */
  redeemerTenantId: string;
  productId: string;
  /** Runs credited by this redemption (the code's snapshot). */
  runsGranted: number;
  /** 1 when this redemption wrote a `source: "code"` attribution row. */
  attributionWritten: boolean;
  createdAtMs: number;
}

/** The rule store surface. */
export interface ReferralCodeRuleStore {
  getRule(productId: string, issuer: ReferralCodeIssuer): Promise<ReferralCodeRule | null>;
  /** The per-product panel read (all issuers). */
  listRules(productId: string): Promise<ReferralCodeRule[]>;
  /** Operator-only at the route; validates via assertReferralCodeRuleInput. */
  upsertRule(input: {
    productId: unknown;
    issuer?: unknown;
    runsPerCode?: unknown;
    reusable?: unknown;
    expiryDays?: unknown;
    attributionMode?: unknown;
    maxRedemptionsPerCode?: unknown;
    maxRedemptionsPerLogin?: unknown;
    globalCap?: unknown;
    active?: unknown;
  }): Promise<ReferralCodeRule>;
}

/** The code store surface. */
export interface ReferralCodeStore {
  /**
   * Issue one code: generates the value server-side, stores
   * only the hash, returns the plaintext ONCE (never stored,
   * never logged, never rendered again).
   */
  createCode(input: {
    rule: ReferralCodeRule;
    kind: ReferralCodeKind;
    issuerLogin: string;
    issuerKind: ReferralCodeIssuer;
    referrerUserId: string | null;
    tenantScope: string | null;
    nowMs: number;
  }): Promise<{ code: ReferralCode; plaintext: string }>;
  /** Lookup by id (revoke + own-code reads). */
  getCode(id: string): Promise<ReferralCode | null>;
  /** Lookup by hash (the redemption path). */
  getCodeByHash(codeHash: string): Promise<ReferralCode | null>;
  /** Operator list (hashes never leave the store; rows carry displayPrefix only). */
  listCodes(productId: string): Promise<ReferralCode[]>;
  /** The caller's own issued codes, across products (R7). */
  listCodesByIssuerLogin(issuerLogin: string): Promise<ReferralCode[]>;
  /** Set revokedAtMs; idempotent (an already-revoked code returns as-is). */
  revokeCode(codeId: string, nowMs: number): Promise<ReferralCode | null>;
  /**
   * The three conditional increments, in order (per-login,
   * per-code, global). Each is a single conditional UPDATE with
   * an applied-check; a null cap skips that increment. The FIRST
   * failed increment stops the sequence; increments that already
   * landed stand (documented residual — caps err toward refusal).
   */
  incrementCapCounts(input: {
    codeId: string;
    redeemerLogin: string;
    ruleId: string;
    maxPerCode: number | null;
    maxPerLogin: number | null;
    globalCap: number | null;
    nowMs: number;
  }): Promise<{ ok: true } | { ok: false; failed: "per_login" | "per_code" | "global" }>;
}

/** The redemption store surface. */
export interface CodeRedemptionStore {
  /** One-time replay lookup. */
  findRedemption(codeId: string, redeemerLogin: string): Promise<CodeRedemption | null>;
  recordRedemption(input: {
    codeId: string;
    redeemerLogin: string;
    redeemerTenantId: string;
    productId: string;
    runsGranted: number;
    attributionWritten: boolean;
    nowMs: number;
  }): Promise<CodeRedemption>;
  /** Row-count read (operator reconcile; the CAP is enforced by the counter, not this count). */
  countRedemptionsByLogin(codeId: string, login: string): Promise<number>;
  /** The user's redemption history, newest first. */
  listRedemptionsForLogin(login: string): Promise<CodeRedemption[]>;
}

/** The result of a code-runs balance read/spend. */
export interface CodeRunsConsumption {
  /** True exactly when one code run was spent by this call. */
  allowed: boolean;
  /** The balance after this call. */
  remaining: number;
}

/**
 * The code-runs balance surface (mirrors RunsPackBalancePort).
 * `getBalance` returns 0 for a login with no row (no code ever
 * redeemed). `addCodeRuns` credits runs (redemption only);
 * `consumeCodeRun` spends one run at gate-decision time (slice 2).
 */
export interface CodeRunsBalancePort {
  getBalance(login: string): Promise<number>;
  addCodeRuns(login: string, runs: number): Promise<number>;
  consumeCodeRun(input: { login: string }): Promise<CodeRunsConsumption>;
}
