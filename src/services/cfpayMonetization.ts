/**
 * Goal 1 Phase 2 (draft, #2014): cfpay monetization gate, TypeScript port.
 *
 * This is a standalone service: no route wiring, no flag enablement, no
 * PROD deployment in this file. Wiring it into the unified run-request
 * path is a separate, reviewed step under #2014, behind FeatureFlagPort,
 * default OFF.
 *
 * Mainnet (Phase 6, #2016) enabled by owner direction 2026-10-28:
 * the network allowlist below admits Base mainnet alongside the
 * Sepolia testnets. The default network stays base-sepolia — mainnet
 * requires an explicit MONETIZATION_NETWORK=base (or eip155:8453).
 * Ethereum mainnet is NOT admitted: it is not in cfpay's chain map.
 * Network here is the operator-declared deployment network and a
 * fail-closed allowlist only — settlement chain follows the cfpay
 * deployment's own configuration, so the two must be kept in
 * agreement by the operator.
 *
 * Rules (from the prototype, 16 tests, updated 2026-10-27 for
 * all-runs-scheduled-behind-the-scenes):
 * - One charge per run-request, never per stage/shard/leg/retry/re-serve.
 * - Manual runs: subscription/credits first, then cfpay checkout (402).
 * - Scheduled runs: subscription/credits only, never unattended card,
 *   EXCEPT a one-off scheduled run authorized by a human present at
 *   submission (scheduleKind "one_off" + authorizedAtSubmission), which
 *   may checkout at submission; execution happens later, on schedule.
 *   A scheduled run with no scheduleKind is treated as recurring.
 * - Tenant isolation: run tenant must equal the verified account tenant.
 * - Confirm paid only via cfpay checkout.status == fulfilled.
 *   Stripe return page is never proof. Replay of a tx hash / payment
 *   intent id is rejected. Identity, price, and network are fail-closed.
 * - Failure compensation (#2549, both mechanisms stand): a failed
 *   paid run gets a one-time replacement-run credit automatically,
 *   disclosed before payment; this gate never issues a cash refund
 *   automatically — cash refunds are operator-initiated only, via
 *   the refund service (#2204), and never for a run that already
 *   received its failure credit.
 * - Prices are operator data, not code (#2185, sub-issue of
 *   #2012): the gate reads them through the PriceCatalogue port
 *   (src/data/priceCataloguePorts.ts), seeded with PROPOSED
 *   defaults pending owner approval (stock $0.02, goal $0.10,
 *   options $0.05, strategy $0.10). Missing or empty price data
 *   is fail-closed: NO charge, never a hardcoded fallback charge.
 *   This module holds no price table at all.
 */
import type { PriceCatalogue } from "../data/priceCataloguePorts";

export type ScreenerFamily = "stock" | "goal" | "options" | "strategy";
export type RunTrigger = "manual" | "scheduled";
export type ScheduleKind = "one_off" | "recurring";

/**
 * Networks the gate accepts when monetization is enabled, as the
 * operator-declared MONETIZATION_NETWORK value. Testnets first
 * (the original testnet-only build), then Base mainnet, admitted by
 * owner direction 2026-10-28 (Phase 6, #2016). Identifiers follow
 * cfpay's chain map: "base" and "eip155:8453" are Base mainnet;
 * Ethereum mainnet ("eip155:1") is NOT in cfpay's map and is not
 * admitted. Anything else is refused fail-closed. The default
 * network (base-sepolia, in the workflow adapter) is unchanged —
 * mainnet requires an explicit opt-in value.
 */
export const ALLOWED_NETWORKS = ["base-sepolia", "ethereum-sepolia", "base", "eip155:8453"] as const;

/**
 * The failure policy, disclosed BEFORE any payment (gate + pricing
 * route share this one string so the UI can never drift from the
 * gate). Catalogue prices are PROPOSED, not owner-approved. Text
 * kept truthful after #2140: mainnet on Base is admitted when the
 * operator configures MONETIZATION_NETWORK=base; the default
 * remains testnet (base-sepolia).
 */
export const PAYMENT_DISCLOSURE =
  "One charge per run-request. Shards, stages, retries and re-serves are free. If a paid run fails, its automatic compensation is a one-time replacement-run credit — a cash refund is never issued automatically. Cash refunds exist only as an operator-initiated action, granted only with operator approval. Mainnet payments are accepted on Base (MONETIZATION_NETWORK=base); testnets remain available. Settlement chain follows the cfpay deployment configuration.";

/**
 * @deprecated superseded by src/services/nativeMonetization.ts (NativeMonetizationGate + CheckoutPort).
 * Kept in place for in-flight cfpay runs to drain (the gate is built at workflow-instance start);
 * new runs use the native gate. Never delete this interface in the migration slices.
 */
export interface CfPayCheckoutClient {
  createCheckout(input: { requestId: string; email: string; request: string }): Promise<unknown>;
  checkoutStatus(requestId: string): Promise<{ status?: string; state?: string; paid?: boolean }>;
}

export interface CommercialAccount {
  userId: string;
  email: string;
  tenantId?: string;
  tier: "Free" | "PayPerUse" | "Subscribed";
  creditsUSD: number;
  includedRunsRemaining: number;
}

export interface MonetizationConfig {
  monetizationEnabled: boolean;
  network: string;
  /**
   * The operator price catalogue (#2185). Required for any price
   * resolution: a null/absent catalogue, or a family with no
   * stored price, makes priceFor throw fail-closed. There is no
   * fallback price anywhere in this module.
   */
  priceCatalogue?: PriceCatalogue | null;
}

export type GateDecision =
  | { allowed: true; status: string; runRequestId: string; priceUSD: number; paidVia?: string }
  | { allowed: false; status: string; httpStatus: 402; runRequestId: string; priceUSD: number; family: ScreenerFamily; checkout?: unknown; disclosure?: string; reason?: string };

interface LedgerRow {
  runRequestId: string;
  userId: string;
  tenantId?: string;
  family: ScreenerFamily;
  trigger: RunTrigger;
  priceUSD: number;
  status: "payment_required" | "paid";
  paidVia?: string;
}

/**
 * @deprecated superseded by src/services/nativeMonetization.ts (NativeMonetizationGate + CheckoutPort).
 * Kept in place for in-flight cfpay runs to drain (the gate is built at workflow-instance start);
 * new runs use the native gate. Never delete this class in the migration slices.
 */
export class CfPayMonetizationGate {
  private byRun = new Map<string, LedgerRow>();
  private byClaim = new Map<string, string>();
  private events: Array<{ runRequestId: string; type: string }> = [];

  constructor(
    private cfpay: CfPayCheckoutClient,
    private config: MonetizationConfig,
  ) {
    if (config.monetizationEnabled && !(ALLOWED_NETWORKS as readonly string[]).includes(config.network)) {
      throw new Error(`Refusing monetization on network ${config.network}: unknown network (allowed: ${ALLOWED_NETWORKS.join(", ")}).`);
    }
  }

  /**
   * Resolve the per-run price for a family through the catalogue
   * port (#2185). Fail-closed, exactly: no catalogue configured,
   * no stored row, an invalid stored value, or a stored price
   * that is not APPROVED (#2547) all throw before any checkout
   * is minted or any coverage is consumed. There is no hardcoded
   * fallback price — a throw here means "no charge", never
   * "charge a guessed price". (This draining gate enforces the
   * same approval rule as its native successor: a draining
   * path is not a bypass.)
   */
  async priceFor(family: ScreenerFamily): Promise<number> {
    const catalogue = this.config.priceCatalogue;
    if (!catalogue) {
      throw new Error(
        "Price catalogue is not configured: refusing to price a run without operator price data (fail-closed).",
      );
    }
    // #2547: only an APPROVED price is chargeable. A proposed
    // price fails closed exactly like a missing one — the seed
    // values are proposals, not an activation.
    const price = await catalogue.getApprovedPrice(family);
    if (price === null || !Number.isFinite(price) || price <= 0) {
      const entry = typeof catalogue.getEntry === "function" ? await catalogue.getEntry(family).catch(() => null) : null;
      if (entry && entry.approvalStatus !== "approved") {
        throw new Error(
          `Stored price for family ${family} is not approved (status: ${entry.approvalStatus}): refusing to charge (fail-closed).`,
        );
      }
      throw new Error(`No valid stored price for family ${family}: refusing to charge (fail-closed).`);
    }
    return price;
  }

  async check(run: { id: string; family: ScreenerFamily; trigger: RunTrigger; scheduleKind?: ScheduleKind; authorizedAtSubmission?: boolean; tenantId?: string; account: CommercialAccount }): Promise<GateDecision> {
    const { account } = run;
    if (!account.userId || !account.email) throw new Error("Verified user id and email are required");
    if (run.tenantId && account.tenantId && run.tenantId !== account.tenantId) throw new Error("Tenant mismatch: run tenant must equal the verified account tenant. No cross-tenant billing.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") {
      return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD, paidVia: existing.paidVia };
    }
    // Flag OFF means this gate charges nothing — no checkout, no
    // coverage spend — so the run is free without resolving a
    // price at all (#2547: approval state gates CHARGING, and a
    // free run must not depend on the CPO approval state of the
    // catalogue, or on the catalogue existing).
    if (!this.config.monetizationEnabled) {
      return { allowed: true, status: "free_flag_off", runRequestId: run.id, priceUSD: 0 };
    }
    const priceUSD = await this.priceFor(run.family);

    const coverage =
      account.tier === "Subscribed" && account.includedRunsRemaining > 0
        ? "subscription_included"
        : account.creditsUSD >= priceUSD
          ? "credits"
          : null;
    if (coverage) {
      if (coverage === "subscription_included") account.includedRunsRemaining -= 1;
      else account.creditsUSD = Math.round((account.creditsUSD - priceUSD) * 100) / 100;
      this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD, status: "paid", paidVia: coverage });
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD, paidVia: coverage };
    }
    // All runs are scheduled behind the scenes: only a one-off scheduled
    // run authorized at submission may checkout; every other scheduled
    // run (recurring, or no scheduleKind stated) is coverage-only.
    const isOneOffScheduled =
      run.trigger === "scheduled" && run.scheduleKind === "one_off" && run.authorizedAtSubmission === true;
    if (run.trigger === "scheduled" && !isOneOffScheduled) {
      this.events.push({ runRequestId: run.id, type: "scheduled.skipped_uncovered" });
      return { allowed: false, status: "coverage_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, reason: "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken." };
    }
    if (existing?.status === "payment_required") {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family };
    }
    const checkout = await this.cfpay.createCheckout({ requestId: run.id, email: account.email, request: `${run.family} run ${run.id}` });
    this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD, status: "payment_required" });
    return {
      allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, checkout,
      disclosure: PAYMENT_DISCLOSURE,
    };
  }

  async confirmPaid(run: { id: string; userId: string; email: string }, proof: { claimTxHash?: string; paymentIntentId?: string; stripeReturnPage?: boolean } = {}): Promise<GateDecision> {
    if (proof.stripeReturnPage) throw new Error("A Stripe return page is not proof of payment.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD };
    const claimKey = (proof.claimTxHash ?? proof.paymentIntentId ?? "").toLowerCase();
    if (claimKey) {
      const prior = this.byClaim.get(claimKey);
      if (prior && prior !== run.id) throw new Error(`This payment was already redeemed for run ${prior}`);
    }
    const status = await this.cfpay.checkoutStatus(run.id);
    const state = String(status?.status ?? status?.state ?? "").toLowerCase();
    if (!(state === "fulfilled" || state === "paid" || status?.paid === true)) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? 0, family: existing?.family ?? "goal" };
    }
    const priceUSD = existing?.priceUSD ?? 0;
    this.byRun.set(run.id, { ...(existing as LedgerRow), runRequestId: run.id, status: "paid" });
    if (claimKey) this.byClaim.set(claimKey, run.id);
    return { allowed: true, status: "paid", runRequestId: run.id, priceUSD };
  }
}
