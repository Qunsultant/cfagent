/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing reader.
 *
 * The single user's read-back over the existing stores — no new ledger,
 * no new table, no new writes. One surface joining the reads that the
 * Billing tab previously made separately:
 *
 * - Usage: metered calls via readReceipts (slice 4, #2543) — the same
 *   rows, the same derived provenance — plus the included-run balance
 *   and credit balance from the platform identity (#2219).
 * - Billing: subscriptions via listSubscriptions (2.1), refunds via
 *   listRefunds (2.7), referral balance via the lifecycle port (2.2).
 *   Renewals are derived from active subscriptions' period ends.
 *
 * Provenance is derived, never asserted (issue #122, receipts precedent):
 * - Receipt rows: reuse readReceipts' derivation verbatim.
 * - Subscription rows: real iff provider-managed with a provider payment
 *   reference (stripePaymentIntentId or providerSubscriptionId). A row
 *   whose only payment key is the route-minted `sub-` draft id
 *   (providerPaymentRef) carries no verifiable provider payment, so it
 *   is audit — the row evidences a subscription, not a payment (the
 *   same third value tier-decision rows carry in receiptSurface).
 * - Refund rows: real iff executed with a gateway refund id (a
 *   provider-verified execution); otherwise audit.
 *
 * No money totals are computed here: a summed figure over mixed
 * provenance would read as revenue (receipts precedent). Counts by
 * kind + by provenance only; per-row amounts stay per-row.
 *
 * This module moves no money and confirms nothing — it is read-only.
 * It adds no SQL: it calls readReceipts + the existing ports, so the
 * D-D census is untouched (no new `.exec(`/`prepare(` sites above the
 * data layer, no new table writers).
 */
import type { CommercialStore } from "../data/commercialPorts";
import type { SubscriptionStore, SubscriptionRecord } from "../data/subscriptionPorts";
import type { RefundPorts } from "../data/createRefundPorts";
import type { RefundRecord } from "../data/refundPorts";
import type { LifecycleStore } from "../data/lifecyclePorts";
import type {
  UsageBillingProvenance,
  UsageBillingSubscriptionRow,
  UsageBillingRefundRow,
  UsageBillingRenewalRow,
  UsageBillingView,
} from "../data/usageBilling";
import {
  resolvePlatformIdentity,
  toPlatformIdentityView,
} from "./platformIdentity";
import {
  readReceipts,
  type ReceiptSqlExecutor,
  type ReceiptOrm,
} from "./receiptSurface";

export type {
  UsageBillingProvenance,
  UsageBillingSubscriptionRow,
  UsageBillingRefundRow,
  UsageBillingRenewalRow,
  UsageBillingView,
} from "../data/usageBilling";

export interface UsageBillingDeps {
  sql: ReceiptSqlExecutor;
  orm: ReceiptOrm;
  store: CommercialStore;
  subs: SubscriptionStore;
  refunds: RefundPorts;
  lifecycle: LifecycleStore;
}

export const USAGE_BILLING_DEFAULT_LIMIT = 50;
export const USAGE_BILLING_MAX_LIMIT = 100;

/**
 * A subscription row is a provider-verified payment only when a provider
 * payment reference is present. providerPaymentRef alone is the
 * route-minted `sub-` draft id (the replay-guard key), never a provider
 * payment — a row carrying only it evidences a subscription, not a
 * payment, and is audit, never asserted real.
 */
export function resolveSubscriptionProvenance(row: SubscriptionRecord): {
  provenance: UsageBillingProvenance;
  provenanceNote: string;
} {
  if (row.stripePaymentIntentId || row.providerSubscriptionId) {
    return {
      provenance: "real",
      provenanceNote:
        "Provider-managed subscription with a verified provider payment reference",
    };
  }
  return {
    provenance: "audit",
    provenanceNote:
      "Subscription record without a verifiable provider payment (evidence of a subscription, not a payment)",
  };
}

/**
 * A refund row is a provider-verified execution only when it executed
 * with a gateway refund id. Anything else (requested, approved, denied,
 * execution_failed, or executed without a gateway id) evidences the
 * refund record, not a provider payment.
 */
export function resolveRefundProvenance(row: RefundRecord): {
  provenance: UsageBillingProvenance;
  provenanceNote: string;
} {
  if (row.status === "executed" && row.gatewayRefundId) {
    return {
      provenance: "real",
      provenanceNote: "Executed refund with a provider refund id",
    };
  }
  return {
    provenance: "audit",
    provenanceNote:
      "Refund record without a provider-verified execution (evidence of a refund request, not a payment)",
  };
}

/**
 * Renewals derive from active, unexpired, uncanceled subscriptions:
 * the next renewal is the current period end. Canceled, expired, or
 * non-active rows renew nothing.
 */
export function deriveRenewals(
  subscriptions: SubscriptionRecord[],
  nowMs: number,
): UsageBillingRenewalRow[] {
  return subscriptions
    .filter(
      (s) =>
        s.status === "active" && s.canceledAtMs === null && s.periodEndMs > nowMs,
    )
    .map((s) => ({
      subscriptionId: s.id,
      planId: s.planId,
      renewsAtMs: s.periodEndMs,
      renewsAtISO: new Date(s.periodEndMs).toISOString(),
      status: s.status,
    }))
    .sort((a, b) => a.renewsAtMs - b.renewsAtMs);
}

function toSubscriptionRow(row: SubscriptionRecord): UsageBillingSubscriptionRow {
  const { provenance, provenanceNote } = resolveSubscriptionProvenance(row);
  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    planId: row.planId,
    provider: row.provider,
    providerPaymentRef: row.providerPaymentRef,
    stripeSessionId: row.stripeSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    providerSubscriptionId: row.providerSubscriptionId,
    providerStatus: row.providerStatus,
    status: row.status,
    periodStartMs: row.periodStartMs,
    periodEndMs: row.periodEndMs,
    canceledAtMs: row.canceledAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    provenance,
    provenanceNote,
  };
}

function toRefundRow(row: RefundRecord): UsageBillingRefundRow {
  const { provenance, provenanceNote } = resolveRefundProvenance(row);
  return {
    id: row.id,
    kind: row.kind,
    rail: row.rail,
    tenantId: row.tenantId,
    userId: row.userId,
    originalPaymentRef: row.originalPaymentRef,
    subscriptionId: row.subscriptionId,
    paymentIntentId: row.paymentIntentId,
    family: row.family,
    originalAmountUSD: row.originalAmountUSD,
    amountUSD: row.amountUSD,
    originalPaidAtMs: row.originalPaidAtMs,
    reason: row.reason,
    status: row.status,
    approverLogin: row.approverLogin,
    decisionNote: row.decisionNote,
    gatewayRefundId: row.gatewayRefundId,
    executedAtMs: row.executedAtMs,
    entitlementConsequence: row.entitlementConsequence,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    provenance,
    provenanceNote,
  };
}

/**
 * The joined usage/billing read for one verified login. Every read is
 * scoped to that login by the ports themselves (receipts by user_login,
 * subscriptions/refunds/referral by userId); there is no userId
 * parameter, so no other user's data can be requested through this read.
 */
export async function readUsageBilling(
  deps: UsageBillingDeps,
  userLogin: string,
  opts: { limit: number },
): Promise<UsageBillingView> {
  const nowMs = Date.now();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), USAGE_BILLING_MAX_LIMIT);
  const identity = toPlatformIdentityView(
    await resolvePlatformIdentity(
      { commercial: deps.store, subscriptions: deps.subs },
      { userId: userLogin, nowMs },
    ),
  );
  const receipts = readReceipts({ sql: deps.sql, orm: deps.orm }, userLogin, {
    limit,
    kind: "all",
  });
  const subscriptionRows = await deps.subs.listSubscriptions(userLogin);
  const subscriptions = subscriptionRows.map(toSubscriptionRow);
  const current =
    subscriptions.length > 0
      ? subscriptions.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a))
      : null;
  const refundRows = await deps.refunds.store.listRefunds(userLogin);
  const [redeemableUSD, earnings] = await Promise.all([
    deps.lifecycle.redeemableBalance(userLogin),
    deps.lifecycle.listEarnings(userLogin),
  ]);
  return {
    outcome: "SUCCESS_USAGE_BILLING_READ",
    userLogin,
    tier: identity.tier,
    limit,
    identity: {
      creditsUSD: identity.creditsUSD,
      includedRunsRemaining: identity.includedRunsRemaining,
      hasAccount: identity.hasAccount,
    },
    usage: {
      receipts: receipts.receipts,
      counts: receipts.counts,
    },
    billing: {
      effectiveTier: identity.tier,
      current,
      subscriptions,
      renewals: deriveRenewals(subscriptionRows, nowMs),
      refunds: refundRows.map(toRefundRow),
      referral: {
        redeemableUSD,
        totalEarnedUSD: earnings.reduce((s, e) => s + e.amountUSD, 0),
      },
    },
  };
}
