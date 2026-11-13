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
 * - An active unlimited-free grant (#3245) covers the run FIRST,
 *   before price resolution and before the scheduled coverage-only
 *   rule: price 0, no checkout, no coverage consumed, including
 *   recurring runs. An expired grant lapses to the normal gate.
 * - Per-service quota for approved-free accounts (#3263): the grant
 *   is BOUNDED — an active grant covers a run only within its
 *   per-service quota for the family in the current period (default
 *   10 runs per service per month, operator-managed data, seeded by
 *   migration 0055). At the cap nothing runs over allowance (#3241
 *   decision 4): the run is refused with an outcome-coded
 *   at-limit decision (upgrade or buy credits, or stop when the
 *   operator set that action) and no checkout is minted. Counts are
 *   keyed (tenant, login, family, period) — Tenant A usage never
 *   leaks to Tenant B. No quota port wired, or no settings row,
 *   falls through to the normal gate (fail-closed: the Free
 *   allowance at most, never an unverified unlimited run).
 * - Free-tier allowance (#3305): a Free account may run up to
 *   the operator-managed allowance (10 runs per product per UTC
 *   calendar month, seeded) without payment, before price
 *   resolution — like the grant, a free run at price 0 must not
 *   fail on a missing/unapproved family price, and per-run
 *   prices are PROPOSED, not approved. The run is counted by
 *   the free-run counter port; at the cap the gate falls through
 *   to the paid path. Grant-covered runs never touch the
 *   counter; trial/Subscribed runs use included runs, not the
 *   counter. No counter wired = today's behavior (no free runs).
 * - Manual runs: subscription included runs first, then the
 *   runs-pack balance (#3246 slice 3), then credits, then
 *   checkout (402). A pack run is spent at decision time, and
 *   only after price resolution (an unapproved family price
 *   fails closed before the pack is read).
 * - Scheduled runs: subscription included runs, pack balance,
 *   or credits only, never unattended
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
 *   rejection across runs) mirror the cfpay gate. Since #2548 the
 *   replay rejection is ALSO durable: when a proof-redemption
 *   store is wired (the workflow wires one from AGENT_DB),
 *   confirm checks and records redemption keyed by claim id,
 *   x402 nonce+payer, and proof-payload hash, so a proof redeems
 *   exactly once across gate instances and restarts; the ledger
 *   endpoint dedupe and the subscription replay guard are
 *   unchanged.
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
import { isUnlimitedFreeGrantActive, type UnlimitedFreeGrant } from "../data/commercialPorts";
import { freeRunMonthKey, type FreeRunCounter } from "../data/freeRunCounterPorts";
import type { RunsPackBalancePort } from "../data/runsPackPorts";
import {
  approvedFreeQuotaPeriodKey,
  type ApprovedFreeQuota,
  type ApprovedFreeQuotaAtLimitAction,
} from "../data/approvedFreeQuotaPorts";
import { logAspectEvent } from "../aspects/loggingAspect";
import {
  claimRedemptionKey,
  x402NonceRedemptionKey,
  x402ProofRedemptionKey,
  type ProofRedemptionRecord,
  type ProofRedemptionStore,
} from "../data/proofRedemptionPorts";
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
  /**
   * Issue #3245: operator-granted unlimited-free entitlement
   * (null/undefined = none). check() honors an active grant
   * FIRST, before price resolution.
   */
  unlimitedFreeGrant?: UnlimitedFreeGrant | null;
  /**
   * Issue #3289 — the account's segment (market), an explicit
   * operator assignment, default "default". check() resolves
   * per-run prices for this segment; the segment always
   * derives from the verified account row, never from a
   * client claim.
   */
  segment?: string;
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
   * The durable proof-redemption store (#2548). When wired,
   * confirmPaid checks and records proof redemption against it
   * — a proof then redeems exactly once across gate instances
   * and restarts, not just within this instance's in-memory
   * maps. The payment workflow wires it from AGENT_DB. When
   * absent, only the in-memory guard applies (the pre-#2548
   * behavior, kept as the floor, not the ceiling).
   */
  proofRedemptions?: ProofRedemptionStore | null;
  /**
   * The free-run counter (#3305). When wired, a Free-tier run
   * under the operator-managed allowance (10 runs per product
   * per UTC calendar month, seeded) is allowed at price 0 and
   * counted, before price resolution. When absent, the gate
   * keeps today's behavior — no free runs, a Free account falls
   * through to the paid path. The counter is operator data;
   * absence is never a reason to guess an allowance.
   */
  freeRunCounter?: FreeRunCounter | null;
  /**
   * The approved-free per-service quota (#3263). When wired, an
   * active unlimited-free grant covers a run only within its
   * per-service quota for the family in the current period
   * (default 10 runs per service per month, operator-managed
   * data, seeded by migration 0055); at the cap the run is
   * refused with the outcome-coded at-limit decision. When
   * absent, or when no settings row is stored, the grant falls
   * through to the normal gate (fail-closed: the Free allowance
   * at most, never an unverified unlimited run). The quota is
   * operator data; absence is never a reason to guess a bound.
   */
  approvedFreeQuota?: ApprovedFreeQuota | null;
  /**
   * Issue #3246 slice 3 — the runs-pack balance port. When wired,
   * a pack balance covers a run AFTER subscription included runs
   * and BEFORE credits: one pack run is consumed at decision
   * time (a conditional decrement with an applied-check, so a
   * concurrent double-spend is refused). When absent, no pack
   * balance exists and the gate keeps today's behavior. Pack runs
   * spend only after price resolution — resolveChargePricing
   * throws on a missing/unapproved catalogue price before the
   * pack is read — so a pack never covers a run whose family
   * price is not approved (NQ7). Pack runs are family-agnostic
   * (NQ6): the same balance covers any family's run.
   */
  runsPackBalance?: RunsPackBalancePort | null;
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
  // Issue #3289: paid outcomes carry the product/version
  // charged (per-charge recording, §3.9); price-0 outcomes
  // carry none (no charge was priced).
  | { allowed: true; status: string; runRequestId: string; priceUSD: number; paidVia?: string; outcomeCode?: string; productId?: string; versionId?: string }
  | { allowed: false; status: string; httpStatus: 402; runRequestId: string; priceUSD: number; family: NativeScreenerFamily; checkout?: unknown; disclosure?: string; reason?: string; outcomeCode?: string; nextStep?: ApprovedFreeQuotaAtLimitAction; productId?: string; versionId?: string };

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
  /** Issue #3289: the product/version priced for this run (per-charge recording, §3.9). */
  productId?: string;
  versionId?: string;
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
  /**
   * Issue #3245: evaluation time for the unlimited-free grant's
   * expiry. Defaults to Date.now(); tests pass it explicitly so
   * grant expiry is deterministic.
   */
  nowMs?: number;
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
   * port (#2185), for a segment (#3289). Fail-closed, exactly:
   * no catalogue configured, no stored row, an invalid stored
   * value, or a stored price that is not APPROVED (#2547) all
   * throw before any checkout is minted or any coverage is
   * consumed. There is no hardcoded fallback price — a throw
   * here means "no charge", never "charge a guessed price".
   * The resolution is the EFFECTIVE version for the segment at
   * now: the returned productId/versionId identify the version
   * charged, so the charge is recorded against the price that
   * was actually quoted (per-charge recording, §3.9).
   */
  async resolveChargePricing(
    family: NativeScreenerFamily,
    segment: string,
  ): Promise<{ priceUSD: number; productId: string; versionId: string }> {
    const catalogue = this.config.priceCatalogue;
    if (!catalogue) {
      throw new Error(
        "Price catalogue is not configured: refusing to price a run without operator price data (fail-closed).",
      );
    }
    // #2547: only an APPROVED price is chargeable. A proposed
    // price fails closed exactly like a missing one — the seed
    // values are proposals, not an activation. The entry is the
    // effective version for the segment, so its approval is the
    // version's approval, not the family's.
    const entry =
      typeof catalogue.getEntry === "function"
        ? await catalogue.getEntry(family, segment).catch(() => null)
        : null;
    if (!entry) {
      throw new Error(`No valid stored price for family ${family}: refusing to charge (fail-closed).`);
    }
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) {
      throw new Error(`No valid stored price for family ${family}: refusing to charge (fail-closed).`);
    }
    if (entry.approvalStatus !== "approved") {
      throw new Error(
        `Stored price for family ${family} is not approved (status: ${entry.approvalStatus}): refusing to charge (fail-closed).`,
      );
    }
    return { priceUSD: entry.priceUSD, productId: entry.productId, versionId: entry.id };
  }

  /**
   * Resolve the per-run price for a family — the price alone.
   * Kept for callers that only need the amount; check() and
   * confirmPaid resolve through resolveChargePricing so the
   * product/version ride along. Segment defaults to "default"
   * here; the gate paths pass the account's segment.
   */
  async priceFor(family: NativeScreenerFamily, segment?: string): Promise<number> {
    return (await this.resolveChargePricing(family, segment ?? "default")).priceUSD;
  }

  /**
   * Issue #3246 slice 3 — runs-pack coverage, read at decision
   * time. Returns "runs_pack" when one pack run was spent, null
   * when the port is unbound or the balance is empty. A store
   * error degrades the same way the quota store does
   * (tech-standards §13): the failure is logged as a structured
   * aspect event and the run falls through to credits/checkout,
   * so a store blip never fails a run and never grants an
   * unverified pack run. Callers invoke this only AFTER
   * resolveChargePricing, so a pack never spends on a run whose
   * family price is missing or unapproved (NQ7).
   */
  private async readPackCoverage(login: string): Promise<"runs_pack" | null> {
    const port = this.config.runsPackBalance ?? null;
    if (!port) return null;
    try {
      const consumed = await port.consumePackRun({ login });
      return consumed.allowed ? "runs_pack" : null;
    } catch (err) {
      logAspectEvent({
        aspect: "RunsPack",
        operationName: "gate-pack-check",
        code: "FAILURE_RUNS_PACK_UNAVAILABLE",
        level: "warn",
        message: "Runs-pack balance store read failed; falling through to credits/checkout (fail-closed).",
        error: err instanceof Error ? err.message : String(err),
        metadata: { login },
      });
      return null;
    }
  }

  async check(run: NativeCheckInput): Promise<NativeGateDecision> {
    const { account } = run;
    if (!account.userId || !account.email) throw new Error("Verified user id and email are required");
    if (run.tenantId && account.tenantId && run.tenantId !== account.tenantId) throw new Error("Tenant mismatch: run tenant must equal the verified account tenant. No cross-tenant billing.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") {
      return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD, paidVia: existing.paidVia, productId: existing.productId, versionId: existing.versionId };
    }
    // Flag OFF means this gate charges nothing — no checkout, no
    // coverage spend — so the run is free without resolving a
    // price at all (#2547: approval state gates CHARGING, and a
    // free run must not depend on the CPO approval state of the
    // catalogue, or on the catalogue existing).
    if (!this.config.monetizationEnabled) {
      return { allowed: true, status: "free_flag_off", runRequestId: run.id, priceUSD: 0 };
    }
    // Issue #3245: an active unlimited-free grant covers the run
    // FIRST, before price resolution — so a grant-covered run at
    // price 0 must NOT fail on a missing/unapproved family price —
    // and before the scheduled coverage-only rule, so it also
    // covers recurring runs (a deliberate change to that rule).
    // Price 0, no checkout, no credit/included-run deduction:
    // the covered path records payment.covered (audited, paidVia
    // unlimited_free_grant) and consumeCoverage no-ops on it.
    // The paid row makes a later confirmPaid return already_paid
    // through the existing path.
    //
    // Issue #3263: the grant is BOUNDED by the per-service quota.
    // An active grant covers the run only within its quota for the
    // family in the current period (default 10 runs per service per
    // month, operator-managed data). At the cap nothing runs over
    // allowance (#3241 decision 4): the run is refused with the
    // outcome-coded at-limit decision and no checkout is minted.
    // The quota is keyed (tenant, login, family, period) — the
    // tenant is the server-resolved account tenant, never a
    // client-supplied value. No quota port wired, no settings row,
    // or no resolvable tenant falls through to the normal gate
    // (fail-closed: the Free allowance at most, never an
    // unverified unlimited run). A quota STORE error degrades the
    // same way — the failure is logged as a structured aspect
    // event and the run falls through to the normal gate, so a
    // store blip never fails a run and never grants an unverified
    // free run (tech-standards §13 safe degradation). Grant-covered
    // runs never touch the free-run counter, and at the cap there
    // is no fall-through to it either — the quota is the bound
    // for the grant.
    if (isUnlimitedFreeGrantActive(account.unlimitedFreeGrant, run.nowMs ?? Date.now())) {
      const quota = this.config.approvedFreeQuota ?? null;
      try {
        const settings = quota ? await quota.getSettings() : null;
        const tenantId = account.tenantId ?? run.tenantId ?? "";
        if (quota && settings && tenantId !== "") {
          const period = approvedFreeQuotaPeriodKey(run.nowMs ?? Date.now(), settings.windowKind);
          const consumed = await quota.consumeQuotaRun({
            tenantId,
            login: account.userId,
            family: run.family,
            period,
          });
          if (consumed.allowed) {
            this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD: 0, status: "paid", paidVia: "approved_free_quota" });
            return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: 0, paidVia: "approved_free_quota", outcomeCode: "SUCCESS_APPROVED_FREE_QUOTA_COVERED" };
          }
          const outcomeCode =
            settings.atLimitAction === "stop"
              ? "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED_STOP"
              : "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED";
          return {
            allowed: false,
            status: "approved_free_quota_exhausted",
            httpStatus: 402,
            runRequestId: run.id,
            priceUSD: 0,
            family: run.family,
            outcomeCode,
            nextStep: settings.atLimitAction,
            reason: `Approved-free quota for ${run.family} exhausted in the current ${settings.windowKind} period (${consumed.used}/${consumed.cap}). Nothing runs over allowance (#3241 decision 4).`,
          };
        }
      } catch (err) {
        // Safe degradation (tech-standards §13): the quota store
        // could not be read — log the failure structurally and fall
        // through to the normal gate. No free run is granted on a
        // store error, and the run itself is not failed by it.
        logAspectEvent({
          aspect: "ApprovedFreeQuota",
          operationName: "gate-quota-check",
          code: "FAILURE_APPROVED_FREE_QUOTA_UNAVAILABLE",
          level: "warn",
          message: "Approved-free quota store read failed; falling through to the normal gate (fail-closed).",
          error: err instanceof Error ? err.message : String(err),
          metadata: { tenantId: account.tenantId ?? run.tenantId ?? "", login: account.userId, family: run.family },
        });
      }
    }
    // Issue #3305: the Free-tier allowance — 10 runs per product
    // per UTC calendar month, operator-managed and changeable.
    // Evaluated BEFORE price resolution, like the grant: a free
    // run at price 0 must NOT fail on a missing/unapproved
    // family price (per-run prices are PROPOSED, not approved),
    // and it consumes no credits and no included runs. Free runs
    // are the Free tier's entitlement, so they are spent before
    // paid credits. Trial and Subscribed runs never reach this
    // branch (trial sets tier Subscribed; included runs are the
    // Subscribed path below). When no counter is wired the gate
    // keeps today's behavior — the allowance is operator data,
    // and no data means no free runs, never a guessed allowance.
    // At the cap the run falls through to the paid path below
    // (402 manual / skip scheduled); the counter is untouched
    // by a capped run.
    if (account.tier === "Free" && this.config.freeRunCounter) {
      const consumed = await this.config.freeRunCounter.consumeFreeRun({
        login: account.userId,
        family: run.family,
        month: freeRunMonthKey(run.nowMs ?? Date.now()),
      });
      if (consumed.allowed) {
        this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD: 0, status: "paid", paidVia: "free_run_allowance" });
        return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: 0, paidVia: "free_run_allowance" };
      }
    }
    // Issue #3263 (CI fix): the operator-issued grant as the LAST
    // free fall-through. The quota branch above bounds the grant when
    // the quota system can enforce the bound; the Free allowance
    // covers next when it can. Only when neither can cover the run
    // does the grant itself cover it at price 0 — before price
    // resolution, consuming nothing, exactly as #3245 pinned. This
    // restores the grant runs that fell through to priceFor (which
    // throws with no catalogue) and to the checkout mint (which
    // throws with no ports). Ordering note: this SUPERSEDES the
    // #3245 grant-first order — the grant no longer precedes the
    // Free allowance, so a grant run spends the allowance first when
    // the quota is unavailable (see the updated bypass test in
    // tests/native_monetization_gate.test.ts). The grant is still
    // verified operator data (stored grant + expiry check); the
    // quota is its bound, not its verification.
    if (isUnlimitedFreeGrantActive(account.unlimitedFreeGrant, run.nowMs ?? Date.now())) {
      this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD: 0, status: "paid", paidVia: "unlimited_free_grant" });
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: 0, paidVia: "unlimited_free_grant" };
    }
    // Issue #3289: price resolution happens ONCE, here, after
    // the free branches — so the grant, the Free allowance, and
    // flag-OFF never depend on a price existing — and the
    // resolved product/version are carried on every paid outcome
    // and on the byRun row, so the charge is recorded against
    // the version that was quoted. The segment is the verified
    // account's segment, never a client claim.
    const pricing = await this.resolveChargePricing(run.family, account.segment ?? "default");
    const priceUSD = pricing.priceUSD;
    const { productId, versionId } = pricing;

    // Issue #3246 slice 3 — the runs-pack step: AFTER subscription
    // included runs, BEFORE credits (NQ1). The included condition
    // is evaluated once here so the pack is never read — and never
    // spent — when included runs cover the run. The pack read
    // happens after price resolution above, so an unapproved
    // family price throws before any pack run is spent (NQ7).
    const hasIncludedRuns = account.tier === "Subscribed" && account.includedRunsRemaining > 0;
    const packCovered = !hasIncludedRuns && (await this.readPackCoverage(account.userId)) !== null;
    const coverage = hasIncludedRuns
      ? "subscription_included"
      : packCovered
        ? "runs_pack"
        : account.creditsUSD >= priceUSD
          ? "credits"
          : null;
    if (coverage) {
      if (coverage === "subscription_included") account.includedRunsRemaining -= 1;
      else if (coverage === "credits") account.creditsUSD = Math.round((account.creditsUSD - priceUSD) * 100) / 100;
      // runs_pack: the run was already spent inside readPackCoverage; nothing to mutate on the account row.
      this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD, status: "paid", paidVia: coverage, productId, versionId });
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD, paidVia: coverage, productId, versionId };
    }
    // All runs are scheduled behind the scenes: only a one-off scheduled
    // run authorized at submission may checkout; every other scheduled
    // run (recurring, or no scheduleKind stated) is coverage-only.
    const isOneOffScheduled =
      run.trigger === "scheduled" && run.scheduleKind === "one_off" && run.authorizedAtSubmission === true;
    if (run.trigger === "scheduled" && !isOneOffScheduled) {
      return { allowed: false, status: "coverage_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, reason: "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken.", productId, versionId };
    }
    if (existing?.status === "payment_required") {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, productId: existing.productId, versionId: existing.versionId };
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
      productId,
      versionId,
    });
    return {
      allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, checkout,
      disclosure: NATIVE_PAYMENT_DISCLOSURE,
      productId,
      versionId,
    };
  }

  async confirmPaid(
    run: { id: string; userId: string; email: string; family?: NativeScreenerFamily; segment?: string },
    proof: NativeConfirmProof = {},
  ): Promise<NativeGateDecision> {
    if (proof.stripeReturnPage) throw new Error("A Stripe return page is not proof of payment.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD, paidVia: existing.paidVia, productId: existing.productId, versionId: existing.versionId };
    // Replay guard: a claim hash, payment-intent id, or session id
    // already redeemed for another run is rejected, never re-spent.
    for (const key of [proof.claimTxHash, proof.paymentIntentId, proof.sessionId]) {
      if (!key) continue;
      const prior = this.byClaim.get(key.toLowerCase());
      if (prior && prior !== run.id) throw new Error(`This payment was already redeemed for run ${prior}`);
    }
    // Durable replay guard (#2548): the same claim keys checked
    // against the redemption store, so the guard survives this
    // instance — a fresh gate after a durable resume, or another
    // run's gate entirely, sees the redemption the first gate
    // recorded. Store errors propagate: a money path does not
    // confirm against an unreadable redemption record.
    await this.assertNotDurablyRedeemed(
      [proof.claimTxHash, proof.paymentIntentId, proof.sessionId]
        .filter((k): k is string => typeof k === "string" && k.length > 0)
        .map((k) => claimRedemptionKey(k)),
      run.id,
    );
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
    // fail closed without confirming. Issue #3289: the stateless
    // path resolves the effective version for the run's segment
    // (default "default"); the checked path carries the version
    // quoted at check time on the byRun row. A pre-0058 byRun row
    // carries no version — the decision then carries none, and
    // the best-effort journal post logs the gap instead of
    // inventing a version.
    const expectedPricing = existing
      ? { priceUSD: existing.priceUSD, productId: existing.productId, versionId: existing.versionId }
      : run.family
        ? await this.resolveChargePricing(run.family, run.segment ?? "default")
        : undefined;
    const expectedPrice = expectedPricing?.priceUSD;
    if (expectedPrice === undefined || !Number.isFinite(expectedPrice) || expectedPrice <= 0) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: 0, family: run.family ?? existing?.family ?? "goal" };
    }

    if (rail === "stripe") {
      const sessionId = existing?.sessionId ?? proof.sessionId;
      if (!sessionId) {
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? 0, family: run.family ?? existing?.family ?? "goal", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
      }
      // A proof naming a different session than the minted checkout
      // is not evidence for this run.
      if (existing?.sessionId && proof.sessionId && existing.sessionId !== proof.sessionId) {
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing.priceUSD, family: existing.family, productId: existing.productId, versionId: existing.versionId };
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
        return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
      }
      this.byRun.set(run.id, {
        ...(existing as NativeLedgerRow),
        runRequestId: run.id,
        family: run.family ?? existing?.family ?? "goal",
        trigger: existing?.trigger ?? "manual",
        priceUSD: expectedPrice,
        status: "paid",
        paidVia: "stripe_checkout",
        productId: expectedPricing?.productId,
        versionId: expectedPricing?.versionId,
      });
      for (const key of [sessionId, proof.paymentIntentId, evidence.paymentIntentId, proof.claimTxHash]) {
        if (key) this.byClaim.set(key.toLowerCase(), run.id);
      }
      await this.recordDurableRedemption(
        [sessionId, proof.paymentIntentId, evidence.paymentIntentId, proof.claimTxHash]
          .filter((k): k is string => typeof k === "string" && k.length > 0)
          .map((k) => claimRedemptionKey(k)),
        run.id,
        "stripe",
        run.userId,
      );
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: expectedPrice, paidVia: "stripe_checkout", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
    }

    // x402 rail.
    if (!proof.paymentProof) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
    }
    const verdict = await port.verifyCryptoPayment({ paymentProof: proof.paymentProof, expectedAmountUSD: expectedPrice });
    if (!verdict.verified || !verdict.payer) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
    }
    // Payer match: a claimed payer must equal the verified payer.
    if (proof.payer && proof.payer.toLowerCase() !== verdict.payer.toLowerCase()) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? expectedPrice, family: run.family ?? existing?.family ?? "goal", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
    }
    // Nonce binding: when this gate minted the challenge, the proof
    // must carry that challenge's nonce — otherwise the proof was
    // minted for a different run's amount.
    if (existing?.challengeNonce && verdict.nonce && existing.challengeNonce !== verdict.nonce) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing.priceUSD, family: existing.family, productId: existing.productId, versionId: existing.versionId };
    }
    // Stateless nonce binding (#2548): on the durable-resume path
    // there is no `existing` row and no minted-challenge nonce in
    // memory, so the in-memory check above cannot fire. The
    // binding is restored durably instead: the verdict's
    // nonce+payer and the proof payload itself are redemption
    // keys — if either was already redeemed by another run, this
    // proof is a replay, whatever gate instance recorded it.
    const x402Keys: string[] = [];
    if (verdict.nonce && verdict.payer) x402Keys.push(x402NonceRedemptionKey(verdict.nonce, verdict.payer));
    x402Keys.push(await x402ProofRedemptionKey(proof.paymentProof));
    await this.assertNotDurablyRedeemed(x402Keys, run.id);
    this.byRun.set(run.id, {
      ...(existing as NativeLedgerRow),
      runRequestId: run.id,
      family: run.family ?? existing?.family ?? "goal",
      trigger: existing?.trigger ?? "manual",
      priceUSD: expectedPrice,
      status: "paid",
      paidVia: "x402",
      productId: expectedPricing?.productId,
      versionId: expectedPricing?.versionId,
    });
    for (const key of [proof.claimTxHash, verdict.nonce ? `x402:${verdict.nonce}:${verdict.payer}` : undefined]) {
      if (key) this.byClaim.set(key.toLowerCase(), run.id);
    }
    await this.recordDurableRedemption(
      [
        ...x402Keys,
        ...(proof.claimTxHash ? [claimRedemptionKey(proof.claimTxHash)] : []),
      ],
      run.id,
      "x402",
      verdict.payer,
    );
    return { allowed: true, status: "paid", runRequestId: run.id, priceUSD: expectedPrice, paidVia: "x402", productId: expectedPricing?.productId, versionId: expectedPricing?.versionId };
  }

  /**
   * #2548: throw if any key was durably redeemed by a DIFFERENT
   * run. A key redeemed by this same run is idempotency, not
   * replay (a resumed workflow re-confirming its own payment).
   * No store wired = no durable state to consult (in-memory
   * guard only).
   */
  private async assertNotDurablyRedeemed(keys: string[], runId: string): Promise<void> {
    const store = this.config.proofRedemptions;
    if (!store || keys.length === 0) return;
    for (const key of keys) {
      const record: ProofRedemptionRecord | null = await store.findRedemption(key);
      if (record && record.runRequestId !== runId) {
        throw new Error(`This payment was already redeemed for run ${record.runRequestId}`);
      }
    }
  }

  /**
   * #2548: record this run's redemption of every key. If a
   * racing confirm from another run recorded a key first, the
   * store returns that run's record and this confirm throws —
   * the proof is spent, and this run must not proceed as paid.
   */
  private async recordDurableRedemption(
    keys: string[],
    runId: string,
    rail: "stripe" | "x402",
    payer: string | null,
  ): Promise<void> {
    const store = this.config.proofRedemptions;
    if (!store) return;
    for (const key of keys) {
      const { record } = await store.recordRedemption({ redemptionKey: key, runRequestId: runId, rail, payer });
      if (record.runRequestId !== runId) {
        throw new Error(`This payment was already redeemed for run ${record.runRequestId}`);
      }
    }
  }
}
