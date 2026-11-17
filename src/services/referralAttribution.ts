/**
 * Issue #5226 (2.27) — automatic referral attribution at account creation.
 *
 * The missing half of the #2657 referral-credit system: the automatic
 * earn trigger in the paid-submit path (agenticPayments.ts) already
 * reads the attribution row and fires recordFirstPaidRunEarning, but
 * no signup path ever recorded one — the operator record-earn route
 * was the only trigger. This module is the capture half.
 *
 * Capture: the referral code (or referral link) supplied at account
 * creation is resolved to a referrer and persisted as a
 * source-"signup" attribution row via the lifecycle port. The row is
 * the persistence — no new table, no new column: recordAttribution
 * is set-once per referred user, so a second capture replays the
 * existing row and a different referrer is refused, never silently
 * overwritten.
 *
 * Resolution order (fixed — do not reorder):
 *   1. Issued-code path: a 16-character Crockford value is looked
 *      up by hash in the referral-code store. A row that exists and
 *      is redeemable (active rule, unrevoked, unexpired, tenant
 *      scope covers the referred tenant) attributes to the code's
 *      referrer. A code-shaped value that fails any of those checks
 *      resolves to nothing — it is NOT re-tried as a login.
 *   2. Referral-link path: any other value is treated as a referrer
 *      login (the `?ref=<login>` link format). It attributes only
 *      when that login has a commercial account in the SAME tenant
 *      (referral credits never cross tenants).
 *   3. Self-referral never attributes, in either path.
 *
 * Failure direction: capture NEVER throws and NEVER fails the
 * caller. Any store failure, any port throw (self-referral,
 * conflicting attribution), any unresolvable value yields null —
 * the account creation proceeds without attribution. The operator
 * record-earn route stays as the manual fallback.
 *
 * No new values: no amounts, caps, delays, or thresholds are added
 * here. Earn/vest rule values stay the existing operator rule row
 * (2.2, migration 0015); the attribution rules are the
 * owner-recorded behavioral defaults (#5226, 2026-11-17).
 */
import {
  hashCodeValue,
  isCodeRedeemable,
  normalizeCodeValue,
  type ReferralCodeRuleStore,
  type ReferralCodeStore,
} from "../data/referralCodePorts";
import type { CommercialStore } from "../data/commercialPorts";
import type { ReferralAttribution, ReferralCreditPort } from "../data/lifecyclePorts";

/** The stores the signup capture needs. Narrow on purpose: the route passes the real adapters, tests pass fakes. */
export interface SignupAttributionDeps {
  codes: Pick<ReferralCodeStore, "getCodeByHash">;
  rules: Pick<ReferralCodeRuleStore, "getRule">;
  commercial: Pick<CommercialStore, "getAccount">;
  lifecycle: ReferralCreditPort;
}

export interface SignupAttributionInput {
  /** The submitted referral code or link value; blank / non-string means no attribution. */
  codeValue: unknown;
  referredUserId: string;
  tenantId: string;
  nowMs: number;
}

/**
 * Resolve a submitted referral value to its referrer, or null when
 * nothing may be attributed. Never throws on a bad value; a store
 * read failure resolves to null (the link path's getAccount is
 * caught; a code-store read failure falls through to the link path
 * and finds no account for a code-shaped value).
 */
export async function resolveSignupReferrer(
  deps: SignupAttributionDeps,
  input: SignupAttributionInput,
): Promise<{ referrerUserId: string } | null> {
  const value = typeof input.codeValue === "string" ? input.codeValue.trim() : "";
  if (!value) return null;
  if (value === input.referredUserId) return null;
  // 1. Issued-code path.
  try {
    const normalized = normalizeCodeValue(value);
    const code = await deps.codes.getCodeByHash(await hashCodeValue(normalized));
    if (code) {
      const rule = await deps.rules.getRule(code.productId, code.issuerKind);
      if (
        isCodeRedeemable(code, rule, input.nowMs) &&
        code.referrerUserId !== null &&
        code.referrerUserId !== input.referredUserId &&
        (code.tenantScope === null || code.tenantScope === input.tenantId)
      ) {
        return { referrerUserId: code.referrerUserId };
      }
      // A code-shaped value that fails is not a login.
      return null;
    }
  } catch {
    // Not a code value — fall through to the link path.
  }
  // 2. Referral-link path: the value is a referrer login. It counts
  // only when that login has a commercial account in this tenant.
  let account: Awaited<ReturnType<SignupAttributionDeps["commercial"]["getAccount"]>> = null;
  try {
    account = await deps.commercial.getAccount(value);
  } catch {
    return null;
  }
  if (!account || account.tenantId !== input.tenantId) return null;
  return { referrerUserId: value };
}

/**
 * Capture the signup attribution: resolve the submitted value and
 * persist the attribution row (source "signup"). Returns the row,
 * or null when nothing was attributed. NEVER throws — any failure
 * is a silent skip, so account creation is never blocked by
 * attribution.
 */
export async function captureSignupAttribution(
  deps: SignupAttributionDeps,
  input: SignupAttributionInput,
): Promise<ReferralAttribution | null> {
  try {
    const resolved = await resolveSignupReferrer(deps, input);
    if (!resolved) return null;
    return await deps.lifecycle.recordAttribution({
      referrerUserId: resolved.referrerUserId,
      referredUserId: input.referredUserId,
      tenantId: input.tenantId,
      source: "signup",
    });
  } catch {
    return null;
  }
}
