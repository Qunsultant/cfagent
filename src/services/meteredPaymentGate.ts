/**
 * Monetization Phase 1.2 (#2408, sub-issue of #2405): metering
 * enforcement for the single user — the paid gate's meter + tier
 * helpers.
 *
 * The paid gate (ETradeAgenticPaymentService.handleGatedEndpoint)
 * serves a paid call only when the meter accepts it: after
 * fulfill, before serving, the gate inserts one usage_event into
 * the existing usage_events store (UsageEventPort) and refuses
 * with a typed error when the meter is missing or the insert
 * fails. This replaces the previously advisory posture ("metering
 * must not break the run", "the published result stands either
 * way" in researchPublish.ts) ON PAID PATHS ONLY — ungated/free
 * paths keep their existing behavior and never touch this module.
 *
 * Tier rule (fail-closed default, #1076):
 * - No resolver wired, or the resolver finds no stored tier, or
 *   the commercial store is unbound → "Free". Free is implicit
 *   (commercialPorts.toCommercialAccount) and grants nothing by
 *   itself; payment remains the entitlement evidence, so the
 *   default can never grant paid access.
 * - A resolved tier is validated with assertStoreTier: an invalid
 *   value is refused, never defaulted away silently.
 * - A tier-store read failure propagates to the gate, which
 *   refuses with a typed error (the money-path fail direction
 *   per createCommercialPorts.ts: fail-closed on money paths).
 * - Tier NEVER bypasses payment in this slice: a Subscribed
 *   included-run bypass at the premium gate is a slice-3 /
 *   Phase-2 decision, not invented here, and would grant paid
 *   access by tier value alone before the owner assigns any tier.
 *
 * #1819 rows-read lens: this module performs NO store read at
 * all. The meter insert is a single write through the caller's
 * port (no preceding read); tier resolution reads, when they
 * happen, live in the caller's resolver (premium routes: two
 * indexed D1 point reads on session traffic only, zero reads on
 * anonymous traffic) — never in SessionStore, never a scan.
 * This module is pure apart from the caller's port: labeling it
 * costs no per-request store read, exactly like slice 1's
 * x402PaymentPath helper.
 */
import type {
  InsertUsageEventRow,
  UsageEventPort,
} from "../data/canonicalReportStorePorts";
import { assertStoreTier, type StoreTier } from "../data/commercialPorts";
import type { AgenticPaymentReceipt } from "../types";

/**
 * What the paid gate needs to meter a served call. The meter is
 * optional in the type so call sites without storage can still
 * build the options — but the gate treats a missing meter as a
 * refusal, never as "serve unmetered" (see handleGatedEndpoint).
 * The tier resolver is optional for the same reason: anonymous
 * (payer-bound) traffic has no session login to resolve, so no
 * resolver is wired and the tier defaults to Free with zero
 * store reads.
 */
export interface MeteredGateOptions {
  /** The usage_events port the served call is metered into. */
  meter?: UsageEventPort;
  /** Billable category for the meter row: the paid service id (e.g. "options_screener"). */
  category: string;
  /**
   * Resolve the caller's effective tier. Returns null when no
   * stored tier exists (or the store is unbound) → Free default.
   * Throws on a store read failure → the gate refuses.
   */
  resolveTier?: (userLogin: string) => Promise<StoreTier | null>;
  /**
   * Issue #5222: consume one subscription included run for this
   * caller when covered. The gate calls it BEFORE any payment is
   * demanded, only for session traffic (x-user-login present).
   * Returns true when a run was consumed (serve without a 402),
   * false when not covered. Throws on a store failure → the gate
   * treats it as "not covered" and demands payment (fail closed).
   * Absent → no bypass (existing behavior: payment is the only
   * entitlement evidence). The port itself enforces the coverage
   * rule (effective tier Subscribed + runs remaining); the gate
   * trusts only its boolean, never a tier value.
   */
  consumeIncludedRun?: (userLogin: string) => Promise<boolean>;
}

/** The fail-closed default: implicit Free grants nothing by itself. */
export const METERED_GATE_DEFAULT_TIER: StoreTier = "Free";

/**
 * Resolve the metered tier for one gate decision. No resolver or
 * a null resolution → Free. A resolved value is validated — an
 * invalid tier throws instead of being silently defaulted.
 * Resolver (store) failures propagate to the caller.
 */
export async function resolveMeteredTier(
  resolveTier: MeteredGateOptions["resolveTier"],
  userLogin: string,
): Promise<StoreTier> {
  if (!resolveTier) return METERED_GATE_DEFAULT_TIER;
  const resolved = await resolveTier(userLogin);
  if (resolved === null || resolved === undefined) return METERED_GATE_DEFAULT_TIER;
  return assertStoreTier(resolved);
}

/** Build the one usage_event row for a served paid call. */
export function buildMeteredCallEvent(input: {
  receipt: AgenticPaymentReceipt;
  userLogin: string;
  category: string;
  priceUSD: number;
  tier: StoreTier;
  /**
   * Issue #3185 (stamp slice): the stamped account tenant.
   * Null for anonymous x402/MPP traffic (payer-scope identity
   * only) — never invented.
   */
  tenantId: string | null;
}): InsertUsageEventRow {
  const { receipt, userLogin, category, priceUSD, tier, tenantId } = input;
  return {
    // Deterministic per payment: a retry after a meter failure
    // re-inserts under the same id only if the first insert
    // never landed; a landed row is never double-metered for
    // one receipt (replays are refused upstream by tx-hash
    // consumption, #329).
    id: `use_${receipt.receiptId}`,
    userLogin,
    runId: receipt.receiptId,
    category,
    createdAt: new Date().toISOString(),
    detailJson: JSON.stringify({
      receiptId: receipt.receiptId,
      priceUSD,
      tier,
      protocol: receipt.protocol,
    }),
    tenantId,
  };
}

/**
 * Issue #5222: build the one usage_event row for a served call
 * covered by subscription included runs. Same row shape as
 * buildMeteredCallEvent, but there is no payment receipt to key
 * on: the row is keyed by the coverage id (`cov_<uuid>`, the
 * receiptId of the locally synthesised coverage receipt) and the
 * detail names paidVia explicitly — a covered row must never
 * claim a protocol payment happened. priceUSD is the run's
 * price (for revenue accounting); the charge was 0 (included
 * in the subscription), recorded on the coverage receipt, not
 * here. tier is Subscribed by construction: the port only
 * consumes for effective-tier Subscribed.
 */
export function buildCoveredCallEvent(input: {
  coverageId: string;
  userLogin: string;
  category: string;
  priceUSD: number;
  tier: StoreTier;
  /**
   * Issue #3185 (stamp slice): the stamped account tenant for
   * this session login — resolved by the caller at serve time.
   * Null when the session login holds no account row.
   */
  tenantId: string | null;
}): InsertUsageEventRow {
  const { coverageId, userLogin, category, priceUSD, tier, tenantId } = input;
  return {
    id: `use_${coverageId}`,
    userLogin,
    runId: coverageId,
    category,
    createdAt: new Date().toISOString(),
    detailJson: JSON.stringify({
      coverageId,
      paidVia: "subscription_included",
      priceUSD,
      tier,
    }),
    tenantId,
  };
}

/** Typed refusal for a meter/tier gate failure: never silent, never served. */
export function meteredGateRefusal(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: code, statusCode: status, message }, null, 2),
    {
      status,
      statusText: code,
      headers: { "Content-Type": "application/json" },
    },
  );
}
