/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing reader.
 *
 * The contract for the joined usage/billing read plus the pure derivation
 * for the Billing-tab section. Every field is server truth carried
 * verbatim from the route (`GET /payments/agentic/commercial/usage-billing`)
 * — this module never invents a price, a balance, a tier, a period end,
 * or a provenance: provenance arrives on each row from the service
 * (`src/services/usageBillingSurface.ts`), derived there, never asserted.
 *
 * No money totals are computed here: a summed figure over mixed
 * provenance would read as revenue (receipts precedent #2543). Counts
 * by kind + by provenance only; per-row amounts stay per-row.
 */
import type { ReceiptEntry } from "../services/receiptSurface";

export type UsageBillingProvenance = "real" | "simulated" | "audit";

export interface UsageBillingSubscriptionRow {
  id: string;
  userId: string;
  tenantId: string;
  planId: string;
  provider: string;
  providerPaymentRef: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  providerSubscriptionId: string | null;
  providerStatus: string | null;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  provenance: UsageBillingProvenance;
  provenanceNote: string;
}

export interface UsageBillingRefundRow {
  id: string;
  kind: string;
  rail: string;
  tenantId: string;
  userId: string;
  originalPaymentRef: string;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  family: string | null;
  originalAmountUSD: number;
  amountUSD: number;
  originalPaidAtMs: number;
  reason: string;
  status: string;
  approverLogin: string | null;
  decisionNote: string | null;
  gatewayRefundId: string | null;
  executedAtMs: number | null;
  entitlementConsequence: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  provenance: UsageBillingProvenance;
  provenanceNote: string;
}

export interface UsageBillingRenewalRow {
  subscriptionId: string;
  planId: string;
  renewsAtMs: number;
  renewsAtISO: string;
  status: string;
}

export interface UsageBillingView {
  outcome: "SUCCESS_USAGE_BILLING_READ";
  userLogin: string;
  tier: string;
  limit: number;
  identity: {
    creditsUSD: number;
    includedRunsRemaining: number;
    hasAccount: boolean;
  };
  usage: {
    receipts: ReceiptEntry[];
    counts: {
      meter: number;
      tier: number;
      transaction: number;
      real: number;
      simulated: number;
      audit: number;
    };
  };
  billing: {
    effectiveTier: string;
    current: UsageBillingSubscriptionRow | null;
    subscriptions: UsageBillingSubscriptionRow[];
    renewals: UsageBillingRenewalRow[];
    refunds: UsageBillingRefundRow[];
    referral: {
      redeemableUSD: number;
      totalEarnedUSD: number;
    };
  };
}

export type UsageBillingSubscriptionStatus = "active" | "expired" | "canceled";

export interface UsageBillingPanelView {
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
  hasAccount: boolean;
  receipts: ReceiptEntry[];
  counts: UsageBillingView["usage"]["counts"];
  subscriptions: Array<UsageBillingSubscriptionRow & { displayStatus: UsageBillingSubscriptionStatus }>;
  renewals: UsageBillingRenewalRow[];
  refunds: UsageBillingRefundRow[];
  referral: {
    redeemableUSD: number;
    totalEarnedUSD: number;
  };
}

/** Per-subscription display status: canceled wins, then period end vs now. */
export function subscriptionDisplayStatus(
  row: UsageBillingSubscriptionRow,
  nowMs: number,
): UsageBillingSubscriptionStatus {
  if (row.canceledAtMs !== null || row.status === "canceled") return "canceled";
  return row.periodEndMs > nowMs ? "active" : "expired";
}

/** Pure shaping for the panel: server truth in, display status out. */
export function buildUsageBillingView(
  input: UsageBillingView,
  nowMs: number,
): UsageBillingPanelView {
  return {
    tier: input.tier,
    creditsUSD: input.identity.creditsUSD,
    includedRunsRemaining: input.identity.includedRunsRemaining,
    hasAccount: input.identity.hasAccount,
    receipts: input.usage.receipts,
    counts: input.usage.counts,
    subscriptions: input.billing.subscriptions.map((row) => ({
      ...row,
      displayStatus: subscriptionDisplayStatus(row, nowMs),
    })),
    renewals: input.billing.renewals,
    refunds: input.billing.refunds,
    referral: input.billing.referral,
  };
}
