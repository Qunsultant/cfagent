/**
 * Issue #2208 — referral-credit service: the earn event and the
 * coverage-path redemption.
 *
 * Earn: a referred user's FIRST paid run earns the referrer the
 * stored rule amount (read from the operator rule row at earn
 * time, so a rule change affects future earnings only). The
 * port's recordEarning is idempotent per referred user, so a
 * replayed earn event cannot double-earn.
 *
 * Attribution gap, stated plainly: no signup/submit path today
 * records which referrer a user came from (referral LINKS exist
 * in ads/referrals tracking, but no referrer attribution lands
 * on the account). The operator record-earn route is therefore
 * the earn trigger in this slice; wiring automatic attribution
 * (referral code captured at account creation, earn fired on
 * first verified paid run) is follow-up work, not claimed here.
 *
 * Redemption and the coverage path: referral credits are NOT
 * spent by starting a run directly — that would be a parallel
 * payment bypass around the gate. Instead, conversion settles
 * referral credit INTO the commercial account (adjustCredits),
 * and the run then goes through the EXISTING gate + payment
 * workflow, which covers it via paidVia "credits" and consumes
 * it via the existing consumeCoverage path. Zero gate changes,
 * zero new paidVia values, zero price changes. The referral
 * ledger keeps the audit (which earnings were redeemed, for
 * which run); the commercial balance is only ever topped up by
 * exactly the redeemed amount.
 *
 * Ordering (fail-safe direction): redeem the referral earnings
 * FIRST, then top up the commercial account. If the top-up
 * throws, the redeem already happened — the caller fails closed
 * (503, no run, no payment workflow) and the earning rows are
 * the operator's reconcile signal. The reverse order (top-up
 * first) would mint spendable commercial credit on a redeem
 * failure, which is strictly worse. Partial balances ARE
 * converted (#5228): a balance below the run price converts as
 * a partial discount via convertReferralCreditsForRunPartial —
 * the balance tops up the commercial account and the gate
 * charges the remainder through the usual path. The balance
 * read goes through the single balance-read path
 * (LifecycleStore.redeemableBalance) in both the exact and the
 * partial conversion, so a future filter on that path (e.g.
 * the 2.31 expiry filter) applies to both without touching
 * this code. No new hardcoded values: the only inputs are the
 * run price (operator price catalogue) and the vested balance
 * (operator rule rows via the lifecycle port).
 */
import type { CommercialStore } from "../data/commercialPorts";
import type { LifecycleStore } from "../data/lifecyclePorts";
import { round2 } from "../data/lifecyclePorts";
import { BusinessError } from "../outcomes/outcomeAspects";

/** The earn event: a referred user's first paid run. Idempotent per referred user. */
export async function recordFirstPaidRunEarning(
  store: LifecycleStore,
  input: { referrerUserId: string; referredUserId: string; tenantId: string },
) {
  return store.recordEarning(input);
}

/**
 * Convert exactly amountUSD of vested referral credit into
 * commercial-account credit for one run, then let the normal
 * gate consume it. Throws (before any payment workflow starts)
 * on insufficient vested balance, tenant mismatch, or a failed
 * top-up — the last case after redeem, by the ordering above.
 */
export async function convertReferralCreditsForRun(input: {
  lifecycle: LifecycleStore;
  commercial: CommercialStore;
  userId: string;
  tenantId: string;
  amountUSD: number;
  runRequestId: string;
}): Promise<{ redeemedUSD: number; allocations: Array<{ earningId: string; amountUSD: number }> }> {
  const existing = await input.commercial.getAccount(input.userId);
  if (existing && existing.tenantId !== input.tenantId) {
    throw new BusinessError("FAILURE_COMMERCIAL_FORBIDDEN"); // #5606 (G-3)
  }
  const redeemed = await input.lifecycle.redeem({
    userId: input.userId,
    tenantId: input.tenantId,
    amountUSD: input.amountUSD,
    runRequestId: input.runRequestId,
  });
  try {
    if (!existing) {
      await input.commercial.upsertAccount({
        userId: input.userId,
        tenantId: input.tenantId,
        tier: "Free",
        creditsUSD: 0,
        includedRuns: 0,
      });
    }
    await input.commercial.adjustCredits(input.userId, redeemed.redeemedUSD);
  } catch (err: any) {
    // #5606 (G-3): the top-up failure detail stays server-side (cause);
    // the client gets the catalog generic message, status unchanged (500).
    throw new BusinessError("FAILURE_UNEXPECTED_ERROR", {}, err);
  }
  return redeemed;
}

/**
 * Partial conversion (#5228, owner decision 2026-11-17: run
 * prices only — referral credits may NOT buy subscriptions).
 *
 * Reads the vested balance through the SINGLE balance-read
 * path (LifecycleStore.redeemableBalance — never a raw
 * earnings read) and converts min(balance, amountUSD):
 * a balance below the run price converts as a partial
 * discount and the caller charges the returned remainingUSD
 * through the usual payment path; a balance at or above the
 * price converts exactly, as convertReferralCreditsForRun
 * does today; a zero balance converts nothing and touches
 * no account (no redeem, no top-up). Allocations are
 * oldest-first over vested earnings only, as in the exact
 * path — unvested credit is never dipped into. The 2.31
 * expiry filter plugs into redeemableBalance, so it applies
 * here automatically.
 */
export async function convertReferralCreditsForRunPartial(input: {
  lifecycle: LifecycleStore;
  commercial: CommercialStore;
  userId: string;
  tenantId: string;
  amountUSD: number;
  runRequestId: string;
}): Promise<{ redeemedUSD: number; remainingUSD: number; allocations: Array<{ earningId: string; amountUSD: number }> }> {
  const balance = await input.lifecycle.redeemableBalance(input.userId);
  const amount = round2(Math.min(balance, input.amountUSD));
  if (amount <= 0) {
    return { redeemedUSD: 0, remainingUSD: round2(input.amountUSD), allocations: [] };
  }
  const redeemed = await convertReferralCreditsForRun({ ...input, amountUSD: amount });
  return {
    redeemedUSD: redeemed.redeemedUSD,
    remainingUSD: round2(input.amountUSD - redeemed.redeemedUSD),
    allocations: redeemed.allocations,
  };
}
