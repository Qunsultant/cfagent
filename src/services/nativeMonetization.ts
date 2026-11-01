/**
 * Issue #2193 (sub-issue of #2012, slice 1 of the native-payments
 * program #2146, main-based; slice-0 price catalogue #2189 already
 * on main) — the native
 * monetization gate.
 *
 * This is DOMAIN code: it keeps only the rules — prices via the
 * slice-0 price port, coverage order, scheduling, tenant isolation,
 * idempotency, and confirm semantics. It holds NO rail, reads NO
 * env, and imports NO gateway SDK: checkouts and evidence come
 * only through the CheckoutPort bundle (src/services/checkoutPorts.ts).
 * The composition root (src/services/createCheckoutPorts.ts) is the
 * only place that reads checkout env or constructs adapters.
 *
 * Rules (mirroring CfPayMonetizationGate, whose construction in
 * the workflow adapter this gate supersedes — see the deprecation
 * note there and on that class):
 * - One charge per run-request, never per stage/shard/leg/retry/re-serve.
 * - Manual runs: subscription/credits first, then checkout (402).
 * - Scheduled runs: subscription/credits only, never unattended
 *   card, EXCEPT a one-off scheduled run authorized by a human
 *   present at submission (scheduleKind "one_off" +
 *   authorizedAtSubmission), which may checkout at submission.
 *   A scheduled run with no scheduleKind is treated as recurring.
 * - Tenant isolation: run tenant must equal the verified account tenant.
 * - Card confirm ONLY when a Stripe session retrieve reports the
 *   session complete AND payment_status paid AND amount_total ==
 *   priceUSD x 100 AND client_reference_id == runRequestId. A
 *   Stripe success-page redirect is never proof (it throws, like
 *   the cfpay return page did).
 * - Crypto confirm ONLY when the facilitator verifies the proof
 *   for this run's amount + recipient AND the proof's payer matches
 *   the claimed payer AND the proof's nonce matches the challenge
 *   nonce minted for this run (when the gate minted it). Amount
 *   binding: the verify request carries this run's amount and the
 *   configured recipient as paymentRequirements (see
 *   X402CheckoutAdapter); a facilitator that ignores requirements
 *   would weaken that binding — the on-chain claim check
 *   (src/services/x402Verifier.ts) is the follow-up hardening.
 * - Idempotent on run-request id: the in-memory byRun/byClaim
 *   maps (already-paid short-circuit, claim/session/proof replay
 *   rejection across runs) mirror the cfpay gate; durable dedupe
 *   still lives in the ledger endpoint and the subscription replay
 *   guard, unchanged by this slice.
 * - Fail closed: no checkout ports, no port for the requested rail,
 *   no catalogue, no stored price, or an invalid stored value all
 *   throw/refuse — never a free run, never a guessed price. The
 *   coverage-only exception for scheduled runs is unchanged.
 * - The hardcoded x402 recipient fallback is forbidden on this
 *   path: an x402 port exists only when X402_RECIPIENT_ADDRESS was
 *   explicitly configured (see the composition root + adapter).
 * - Prices are operator data (#2185): the gate reads them through
 *   the PriceCatalogue port, seeded with PROPOSED defaults pending
 *   owner approval (stock $0.02, goal $0.10, options $0.05,
 *   strategy $0.10). Missing price data is fail-closed: NO charge,
 *   never a hardcoded fallback charge. This module holds no price
 *   table at all.
 */
import type { PriceCatalogue, PriceFamily } from "../data/priceCataloguePorts";
import type { CheckoutPorts, CheckoutRail } from "./checkoutPorts";

export type NativeScreenerFamily = PriceFamily;
export type NativeRunTrigger = "manual" | "scheduled";
export type NativeScheduleKind = "one_off" | "recurring";

export interface NativeCommercialAccount {
  userId: string;
  email: string;
  tenantId?: string;
  tier: "Free" | "PayPerUse" | "Subscribed";
  creditsUSD: number;
  includedRunsRemaining: number;
}

export interface NativeMonetizationConfig {
  monetizationEnabled: boolean;
  /**
   * The operator price catalogue (#2185). Required for any price
   * resolution: a null/absent catalogue, or a family with no
   * stored price, makes priceFor throw fail-closed. There is no
   * fallback price anywhere in this module.
   */
  priceCatalogue?: PriceCatalogue | null;
  /**
   * The checkout ports bundle, or null when nothing is configured.
   * Null means: no checkout can be minted and no payment can be
   * confirmed — coverage and flag-OFF paths still work, and a
   * checkout attempt throws fail-closed.
   */
  checkout: CheckoutPorts | null;
}

/**
 * The failure policy, disclosed BEFORE any payment (the native
 * successor to the cfpay gate's PAYMENT_DISCLOSURE: same one-charge
 * terms and the same both-mechanisms failure policy, #2549 —
 * automatic compensation is a replacement-run credit, cash
 * refunds are operator-initiated only — with the settlement-chain
 * sentence replaced: native settlement is Stripe/x402, not cfpay).
 */
export const NATIVE_PAYMENT_DISCLOSURE =
  "One charge per run-request. Shards, stages, retries and re-serves are free. If a paid run fails, its automatic compensation is a one-time replacement-run credit — a cash refund is never issued automatically. Cash refunds exist only as an operator-initiated action, granted only with operator approval. A payment success page is never proof of payment; payment is confirmed only by re-reading provider state.";

export type NativeGateDecision =
  | { allowed: true; status: string; runRequestId: string; priceUSD: number; paidVia?: string }
  | { allowed: false; status: string; httpStatus: 402; runRequestId: string; priceUSD: number; family: NativeScreenerFamily; checkout?: unknown; disclosure?: string; reason?: string };

interface NativeLedgerRow {
  runRequestId: string;
  userId: string;
  tenantId?: string;
  family: NativeScreenerFamily;
  trigger: NativeRunTrigger;
  priceUSD: number;
  status: "payment_required" | "paid";
  paidVia?: string;
  rail?: CheckoutRail;
  sessionId?: string;
  challengeNonce?: string;
}

export interface NativeCheckInput {
  id: string;
  family: NativeScreenerFamily;
  trigger: NativeRunTrigger;
  scheduleKind?: NativeScheduleKind;
  authorizedAtSubmission?: boolean;
  tenantId?: string;
  account: NativeCommercialAccount;
  /** Requested rail; default is card when a card port exists, else x402. */
  rail?: CheckoutRail;
}

export interface NativeConfirmProof {
  claimTxHash?: string;
  paymentIntentId?: string;
  /** Stripe session id, carried by the payment_verified wake-up event. */
  sessionId?: string;
  /** x402 PAYMENT-SIGNATURE payload (base64 JSON or raw JSON). */
  paymentProof?: string;
  /** Claimed x402 payer; must match the facilitator-verified payer when present. */
  payer?: string;
  /** A success/return page redirect — never proof, always throws. */
  stripeReturnPage?: boolean;
}

export class NativeMonetizationGate {
  private byRun = new Map<string, NativeLedgerRow>();
  private byClaim = new Map<string, string>();

  constructor(private config: NativeMonetizationConfig) {}

  /**
   * Resolve the per-run price for a family through the catalogue
   * port (#2185). Fail-closed, exactly: no catalogue configured,
   * no stored row, an invalid stored value, or a stored price
   * that is not APPROVED (#2547) all throw before any checkout
   * is minted or any coverage is consumed. There is no hardcoded
   * fallback price — a throw here means "no charge", never
   * "charge a guessed price".
   */
  async priceFor(family: NativeScreenerFamily): Promise<number> {
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

  async check(run: NativeCheckInput): Promise<NativeGateDecision> {
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
      return { allowed: false, status: "coverage_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, reason: "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken." };
    }
    if (existing?.status === "payment_required") {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family };
    }
    const ports = this.config.checkout;
    if (!ports) {
      throw new Error("Native checkout is not configured (no card or x402 port): refusing to mint a checkout (fail-closed).");
    }
    const rail: CheckoutRail = run.rail ?? (ports.card ? "stripe" : "x402");
    const port = rail === "stripe" ? ports.card : ports.x402;
    if (!port) {
      throw new Error(`Native checkout is not configured for rail ${rail}: refusing to mint a checkout (fail-closed).`);
    }
    const checkout = await port.createCheckout({
      runRequestId: run.id,
      family: run.family,
      priceUSD,
      email: account.email,
      userId: account.userId,
    });
    if (!checkout.checkoutId) {
      throw new Error("Checkout adapter returned no checkout id: refusing to record a checkout without a join key.");
    }
    this.byRun.set(run.id, {
      runRequestId: run.id,
      userId: account.userId,
      tenantId: run.tenantId ?? account.tenantId,
      family: run.family,
      trigger: run.trigger,
      priceUSD,
      status: "payment_required",
      rail,
      sessionId: rail === "stripe" ? checkout.checkoutId : undefined,
      challengeNonce: rail === "x402" ? checkout.challenge?.nonce : undefined,
    });
    return {
      allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, checkout,
      disclosure: NATIVE_PAYMENT_DISCLOSURE,
    };
  }

  async confirmPaid(
    run: { id: string; userId: string; email: string; family?: NativeScreenerFamily },
    proof: NativeConfirmProof = {},
  ): Promise<NativeGateDecision> {
    if (proof.stripeReturnPage) throw new Error("A Stripe return page is not proof of payment.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD, paidVia: existing.paidVia };
    // Replay guard: a claim hash, payment-intent id, or session id
    // already redeemed for another run is rejected, never re-spent.
    for (const key of [proof.claimTxHash, proof.paymentIntentId, proof.sessionId]) {
      if (!key) continue;
      const prior = this.byClaim.get(key.toLowerCase());
      if (prior && prior !== run.id) throw new Error(`This payment was already redeemed for run ${prior}`);
    }
    const rail: CheckoutRail | undefined =
      existing?.rail ?? (proof.sessionId ? "stripe" : proof.paymentProof ? "x402" : undefined);
    if (!rail) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: 0, family: run.family ?? "goal" };
    }
    const ports = this.config.checkout;
    const port = rail === "stripe" ? ports?.card : ports?.x402;
    if (!port) {
      throw new Error(`Native checkout is not configured for rail ${rail}: refusing to confirm a payment without a verification port (fail-closed).`);
    }
    // Expected price: the checked price when this gate minted the
    // checkout, else the catalogue price for the family (stateless
    // confirm, e.g. after a durable resume re-built the gate). No
    // stored price and no family means no amount to match against:
    // fail closed without confirming.
    const expectedPrice =
      existing?.priceUSD ?? (run.family ? await this.priceFor(run.family) : undefined);
    if (expectedPrice === undefined || !Number.isFinite(expectedPrice) || expectedPrice <= 0) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: 0, family: run.family ?? existing?.family ?? "goal" };
    }

    if (rail === "stripe") {
      const sessionId = existing?.sessionId ?? proof.sessionId;
      if (!sessionId) {
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? 0, family: run.family ?? existing?.family ?? "goal" };
      }
      // A proof naming a different session than the minted checkout
      // is not evidence for this run.
      if (existing?.sessionId && proof.sessionId && existing.sessionId !== proof.sessionId) {
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing.priceUSD, family: existing.family };
      }
      const evidence = await port.retrieveCardSession({ sessionId });
      const amountMatches = evidence.amountTotalCents === Math.round(expectedPrice * 100);
      const intentMatches =
        !proof.paymentIntentId || !evidence.paymentIntentId || proof.paymentIntentId === evidence.paymentIntentId;
      const confirmed =
        evidence.status === "complete" &&
        evidence.paymentStatus === "paid" &&
        amountMatches &&
        evidence.clientReferenceId === run.id &&
        intentMatches;
      if (!confirmed) {
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal" };
      }
      this.byRun.set(run.id, {
        ...(existing as NativeLedgerRow),
        runRequestId: run.id,
        family: run.family ?? existing?.family ?? "goal",
        trigger: existing?.trigger ?? "manual",
        priceUSD: expectedPrice,
        status: "paid",
        paidVia: "stripe_checkout",
      });
      for (const key of [sessionId, proof.paymentIntentId, evidence.paymentIntentId, proof.claimTxHash]) {
        if (key) this.byClaim.set(key.toLowerCase(), run.id);
      }
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: expectedPrice, paidVia: "stripe_checkout" };
    }

    // x402 rail.
    if (!proof.paymentProof) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal" };
    }
    const verdict = await port.verifyCryptoPayment({ paymentProof: proof.paymentProof, expectedAmountUSD: expectedPrice });
    if (!verdict.verified || !verdict.payer) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal" };
    }
    // Payer match: a claimed payer must equal the verified payer.
    if (proof.payer && proof.payer.toLowerCase() !== verdict.payer.toLowerCase()) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal" };
    }
    // Nonce binding: when this gate minted the challenge, the proof
    // must carry that challenge's nonce — otherwise the proof was
    // minted for a different run's amount.
    if (existing?.challengeNonce && verdict.nonce && existing.challengeNonce !== verdict.nonce) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing.priceUSD, family: existing.family };
    }
    this.byRun.set(run.id, {
      ...(existing as NativeLedgerRow),
      runRequestId: run.id,
      family: run.family ?? existing?.family ?? "goal",
      trigger: existing?.trigger ?? "manual",
      priceUSD: expectedPrice,
      status: "paid",
      paidVia: "x402",
    });
    for (const key of [proof.claimTxHash, verdict.nonce ? `x402:${verdict.nonce}:${verdict.payer}` : undefined]) {
      if (key) this.byClaim.set(key.toLowerCase(), run.id);
    }
    return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: expectedPrice, paidVia: "x402" };
  }
}
