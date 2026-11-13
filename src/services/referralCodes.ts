/**
 * Issue #3307 (sub-issue of #3241), slice 1 — referral-code
 * issue / redeem services. This module is the service home for
 * the referral-code domain (the referralCredits.ts precedent):
 * it owns the issuance and redemption semantics and imports no
 * store client — only the port interfaces. Routes do auth +
 * audit + response mapping only.
 *
 * A code is a bearer token that, redeemed by a verified login,
 * credits RUNS to that login's code-runs balance. Codes confer
 * runs only — never tier, never credits, never a price, never
 * access.
 *
 * Redemption order (design §3.3, fixed — do not reorder):
 *   1. Normalize + hash the submitted value; unknown value →
 *      generic invalid (a guessing attacker learns nothing).
 *   2. Load the code row + its rule (missing rule fails closed).
 *   3. Redeemability: active rule + unrevoked + unexpired.
 *   4. Self-redemption refused (referrer === redeemer).
 *   5. Tenant scope: a tenant-scoped code refuses any other
 *      tenant (403 at the route, same generic message).
 *   6. One-time replay: an existing redemption for (code,
 *      login) returns as-is — never double-credits.
 *   7. Caps: conditional increments in order per-login →
 *      per-code → global; the first failure stops the sequence
 *      and the redemption refuses (409). Increments that already
 *      landed stand (documented residual — caps err toward
 *      refusal, never toward over-grant).
 *   8. Attribution (referral kind + ledger rule only): the
 *      redeem passes source "code" to the #2657 ledger's
 *      recordAttribution. Check-first conflict handling lives
 *      in the port; ANY attribution outcome — conflict, throw,
 *      or a lifecycle port that is unbound — NEVER fails the
 *      redemption. Invite codes never attribute; the earn
 *      trigger is unchanged.
 *   9. Record the redemption row, then credit the balance.
 *      The redemption row is recorded FIRST and the balance
 *      credit LAST, so a credit failure after the row is
 *      recorded is visible (the route audits it and answers
 *      500; a retry of a one-time code replays the row without
 *      re-crediting — the documented credit-stuck residual,
 *      same-DB sequential statements, negligible probability).
 *
 * This slice builds NO #3247 state: it reads no free-access
 * table, port, or route, and it keeps working if #3247 never
 * lands.
 */
import type { ReferralCreditPort } from "../data/lifecyclePorts";
import {
  assertReferralCodeKind,
  assertReferrerForKind,
  hashCodeValue,
  isCodeRedeemable,
  normalizeCodeValue,
  type CodeRedemption,
  type CodeRedemptionStore,
  type CodeRunsBalancePort,
  type ReferralCode,
  type ReferralCodeKind,
  type ReferralCodeRuleStore,
  type ReferralCodeStore,
} from "../data/referralCodePorts";

/** The route maps this to the generic 400 (FAILURE_REFERRAL_CODE_INVALID). */
export class ReferralCodeInvalidError extends Error {
  constructor(message = "Referral code is invalid.") {
    super(message);
    this.name = "ReferralCodeInvalidError";
  }
}

/** The route maps this to 409 (FAILURE_REFERRAL_CODE_CAP_EXCEEDED). */
export class ReferralCodeCapExceededError extends Error {
  constructor(message = "Referral code redemption cap exceeded.") {
    super(message);
    this.name = "ReferralCodeCapExceededError";
  }
}

/** The route maps this to 409 (FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE). */
export class ReferralCodeRuleUnavailableError extends Error {
  constructor(message = "Referral code rule is unavailable.") {
    super(message);
    this.name = "ReferralCodeRuleUnavailableError";
  }
}

/**
 * The route maps this to 403 with the GENERIC invalid message —
 * a tenant-scope refusal must not leak whether the code exists
 * or which tenant it belongs to.
 */
export class ReferralCodeScopeRefusedError extends Error {
  constructor(message = "Referral code is invalid.") {
    super(message);
    this.name = "ReferralCodeScopeRefusedError";
  }
}

/**
 * The route maps this to a loud 500 with an audit event
 * (`commercial.referral_code.credit_stuck`): the redemption row
 * was recorded but the balance credit failed, so the run credit
 * is stuck and an operator must reconcile it (the code id +
 * redeemer + runs are carried for exactly that). A retry of a
 * one-time code replays the row WITHOUT re-crediting — the
 * documented credit-stuck residual.
 */
export class ReferralCodeCreditStuckError extends Error {
  readonly codeId: string;
  readonly redeemerLogin: string;
  readonly runsGranted: number;
  constructor(codeId: string, redeemerLogin: string, runsGranted: number, cause: unknown) {
    super(
      `Referral code credit stuck: redemption recorded for code ${codeId} but ${runsGranted} runs were not credited to ${redeemerLogin}.`,
    );
    this.name = "ReferralCodeCreditStuckError";
    this.codeId = codeId;
    this.redeemerLogin = redeemerLogin;
    this.runsGranted = runsGranted;
    this.cause = cause;
  }
}

/** The store surfaces the referral-code services need. */
export interface ReferralCodeServiceDeps {
  rules: ReferralCodeRuleStore;
  codes: ReferralCodeStore;
  redemptions: CodeRedemptionStore;
  balances: CodeRunsBalancePort;
  /** Null when the lifecycle port is unbound — attribution is skipped, redemption proceeds. */
  lifecycle: ReferralCreditPort | null;
}

/** A code row without its hash — the only shape that ever leaves the server. */
export type PublicReferralCode = Omit<ReferralCode, "codeHash">;

export function publicCodeView(code: ReferralCode): PublicReferralCode {
  const { codeHash: _codeHash, ...publicCode } = code;
  return publicCode;
}

/**
 * Issue one code under (productId, issuerKind)'s rule. The rule
 * is the ONLY source of terms: a missing or inactive rule
 * refuses (fail-closed); terms are snapshotted onto the code
 * row at issuance, so a later rule edit never reprices it.
 * The plaintext is returned ONCE — it is never stored, never
 * logged, never rendered again.
 */
export async function issueReferralCode(
  deps: ReferralCodeServiceDeps,
  input: {
    productId: string;
    kind: ReferralCodeKind;
    issuerLogin: string;
    issuerKind: "platform_admin" | "tenant_admin" | "user";
    referrerUserId: string | null;
    tenantScope: string | null;
    nowMs: number;
  },
): Promise<{ code: PublicReferralCode; plaintext: string }> {
  const kind = assertReferralCodeKind(input.kind);
  const referrer = assertReferrerForKind(kind, input.referrerUserId);
  if (!input.issuerLogin.trim()) throw new Error("Referral code issuerLogin is required.");
  const rule = await deps.rules.getRule(input.productId, input.issuerKind);
  if (!rule || !rule.active) {
    throw new ReferralCodeRuleUnavailableError(
      `No active referral code rule for product ${input.productId} and issuer ${input.issuerKind}.`,
    );
  }
  const { code, plaintext } = await deps.codes.createCode({
    rule,
    kind,
    issuerLogin: input.issuerLogin.trim(),
    issuerKind: input.issuerKind,
    referrerUserId: referrer,
    tenantScope: input.tenantScope,
    nowMs: input.nowMs,
  });
  return { code: publicCodeView(code), plaintext };
}

/** The result of a redemption (a replay is a success, not an error). */
export interface ReferralCodeRedemptionResult {
  redemption: CodeRedemption;
  runsGranted: number;
  /** True when this redemption established a `source: "code"` attribution row. */
  attributionWritten: boolean;
  /** True when an earlier redemption of this one-time code by this login was replayed. */
  replayed: boolean;
}

/**
 * Redeem a code value for a verified login. See the module
 * header for the fixed step order. Throws
 * ReferralCodeInvalidError (generic 400), ReferralCodeCapExceededError
 * (409), ReferralCodeScopeRefusedError (403, generic message), or
 * ReferralCodeRuleUnavailableError (409) when the code's rule row
 * is missing. A balance-credit failure after the redemption row
 * is recorded propagates (the route audits it as credit-stuck
 * and answers 500).
 */
export async function redeemReferralCode(
  deps: ReferralCodeServiceDeps,
  input: {
    codeValue: string;
    redeemerLogin: string;
    redeemerTenantId: string;
    nowMs: number;
  },
): Promise<ReferralCodeRedemptionResult> {
  const redeemerLogin = input.redeemerLogin.trim();
  if (!redeemerLogin) throw new ReferralCodeInvalidError();
  let normalized: string;
  try {
    normalized = normalizeCodeValue(input.codeValue);
  } catch {
    throw new ReferralCodeInvalidError();
  }
  const code = await deps.codes.getCodeByHash(await hashCodeValue(normalized));
  if (!code) throw new ReferralCodeInvalidError();
  // The code's rule must exist and be the row the code was
  // issued under; a missing rule (or a rule id that does not
  // match the code) fails closed with the generic invalid.
  const rule = await deps.rules.getRule(code.productId, code.issuerKind);
  if (!rule || rule.id !== code.ruleId) throw new ReferralCodeInvalidError();
  if (!isCodeRedeemable(code, rule, input.nowMs)) throw new ReferralCodeInvalidError();
  // Self-redemption: the referrer may not redeem their own code.
  if (code.referrerUserId !== null && code.referrerUserId === redeemerLogin) {
    throw new ReferralCodeInvalidError();
  }
  // Tenant scope: a tenant-scoped code refuses any other tenant.
  // The route answers 403 with the generic invalid message.
  if (code.tenantScope !== null && code.tenantScope !== input.redeemerTenantId) {
    throw new ReferralCodeScopeRefusedError();
  }
  // One-time replay: the same login redeeming the same code
  // again gets the earlier redemption — never double-credits.
  if (!code.reusable) {
    const existing = await deps.redemptions.findRedemption(code.id, redeemerLogin);
    if (existing) {
      return {
        redemption: existing,
        runsGranted: existing.runsGranted,
        attributionWritten: existing.attributionWritten,
        replayed: true,
      };
    }
  }
  // Caps, in order: per-login → per-code → global. The first
  // failure stops the sequence; increments that already landed
  // stand (documented residual — caps err toward refusal).
  const caps = await deps.codes.incrementCapCounts({
    codeId: code.id,
    redeemerLogin,
    ruleId: rule.id,
    maxPerCode: rule.maxRedemptionsPerCode,
    maxPerLogin: rule.maxRedemptionsPerLogin,
    globalCap: rule.globalCap,
    nowMs: input.nowMs,
  });
  if (!caps.ok) {
    throw new ReferralCodeCapExceededError(
      `Referral code redemption cap exceeded (${caps.failed}).`,
    );
  }
  // Attribution (referral kind + ledger rule only): the redeem
  // passes source "code" to the #2657 ledger. Check-first
  // conflict handling lives in the port; ANY attribution
  // outcome NEVER fails the redemption.
  let attributionWritten = false;
  if (
    code.kind === "referral" &&
    rule.attributionMode === "ledger" &&
    code.referrerUserId !== null &&
    deps.lifecycle
  ) {
    try {
      const attribution = await deps.lifecycle.recordAttribution({
        referrerUserId: code.referrerUserId,
        referredUserId: redeemerLogin,
        tenantId: input.redeemerTenantId,
        source: "code",
      });
      attributionWritten =
        attribution.source === "code" && attribution.referrerUserId === code.referrerUserId;
    } catch {
      // An attribution outcome never fails a redemption.
      attributionWritten = false;
    }
  }
  // Redemption row FIRST, balance credit LAST (see module header).
  // A credit failure after the row is recorded is a stuck
  // credit: wrap it so the route can audit + 500 loudly instead
  // of returning a generic failure that hides the stuck row.
  const redemption = await deps.redemptions.recordRedemption({
    codeId: code.id,
    redeemerLogin,
    redeemerTenantId: input.redeemerTenantId,
    productId: code.productId,
    runsGranted: code.runs,
    attributionWritten,
    nowMs: input.nowMs,
  });
  try {
    await deps.balances.addCodeRuns(redeemerLogin, code.runs);
  } catch (err) {
    throw new ReferralCodeCreditStuckError(code.id, redeemerLogin, code.runs, err);
  }
  return { redemption, runsGranted: code.runs, attributionWritten, replayed: false };
}
