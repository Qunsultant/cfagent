/**
 * Issue #2740 (Platform Phase 6, program #2468) — servicing.
 *
 * Read-only Billing servicing view, except the operator refund-policy
 * approval section (2.19, #2985), the refund flow section (2.20,
 * #3045), and the operator top-up limits section (#3262): all CALL
 * existing routes only and create none: identity
 * (#2219, session-derived, self-only),
 * subscription read + plans list (2.1 Billing API), paid-call receipts
 * (slice 4), referral balance (2.2 — this panel is its first client
 * caller), refund policy read + per-kind approve/withdraw (2.7 routes
 * via RefundPolicySection — policy configuration only, never a refund
 * request, approval, or execution), and refund request / record
 * approve-deny / execute / verify (2.7 routes via RefundFlowSection),
 * and top-up limits read + min/max edit (billing-policy route via
 * TopUpLimitsSection — configuration only, never a top-up).
 * It never purchases (Selling owns
 * purchase), never cancels (rescoped 2.14 owns cancel-action UI), never
 * deactivates (2.5), never invents a price,
 * balance, tier, or period end. Failures render as fixed error strings;
 * server error bodies are never rendered. Referral rule values render as
 * operator-set PROPOSED, pending owner approval (per #2657 §15).
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { PageShell, PageSection } from "./components/ui/PageShell";
import { fetchPlatformIdentity } from "./firstRunApi";
import { receiptKindLabel } from "./agenticWalletApi";
import { RefundPolicySection } from "./RefundPolicySection";
import { RefundFlowSection } from "./RefundFlowSection";
import { TopUpLimitsSection } from "./TopUpLimitsSection";
import {
  buildBillingView,
  type BillingPlanInput,
  type BillingReceiptInput,
  type BillingReferralInput,
  type BillingSubscriptionInput,
  type BillingView,
} from "../data/billingServicing";

const BILLING_BASE = "/api/payments/agentic/commercial";

async function fetchJson(path: string): Promise<unknown> {
  const res = await globalThis.fetch(path);
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function BillingServicingPanel() {
  const [view, setView] = useState<BillingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receiptsError, setReceiptsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setReceiptsError(null);
    try {
      const identity = await fetchPlatformIdentity();
      const login = identity.userLogin;
      const [subscriptionResult, receiptsResult, plansResult, referralResult] =
        await Promise.allSettled([
          fetchJson(`${BILLING_BASE}/subscription?userId=${encodeURIComponent(login)}`),
          fetchJson("/api/payments/receipts"),
          fetchJson(`${BILLING_BASE}/plans`),
          fetchJson(`${BILLING_BASE}/referral/balance?userId=${encodeURIComponent(login)}`),
        ]);
      if (subscriptionResult.status === "rejected") throw new Error("subscription");
      if (plansResult.status === "rejected") throw new Error("plans");
      if (referralResult.status === "rejected") throw new Error("referral");
      if (receiptsResult.status === "rejected") {
        setReceiptsError("The paid-call receipts could not be loaded.");
      }
      const subscription = subscriptionResult.value as BillingSubscriptionInput;
      const receipts =
        receiptsResult.status === "fulfilled" && isRecord(receiptsResult.value) && Array.isArray(receiptsResult.value.receipts)
          ? (receiptsResult.value.receipts as BillingReceiptInput[])
          : [];
      const plans =
        plansResult.status === "fulfilled" && isRecord(plansResult.value) && Array.isArray(plansResult.value.plans)
          ? (plansResult.value.plans as BillingPlanInput[])
          : [];
      const referral = referralResult.value as BillingReferralInput;
      setView(
        buildBillingView({
          identity: { userLogin: identity.userLogin, tier: identity.tier },
          subscription,
          receipts,
          plans,
          referral,
          nowMs: Date.now(),
        }),
      );
    } catch {
      setLoadError("The billing view could not be loaded. Try again later.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError("The billing view could not be loaded. Try again later.");
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <PageShell title="Billing">
      <PageSection description="Your subscription, receipts, plans, and referral-credit balance — servicing over existing routes. This view never charges, purchases, cancels, or deactivates. Operators also approve refund-policy kinds here and decide and execute refunds; any verified login may request and verify their own refunds.">
      {loading && <p>Loading billing view</p>}
      {!loading && loadError && (
        <>
          <p>{loadError}</p>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && view && (
        <>
          <Card>
            <p>Current tier: {view.tier}</p>
            <p>Subscription: {view.subscriptionStatus}</p>
            {view.periodEndISO && <p>Current period ends: {view.periodEndISO}</p>}
            <p>Subscriptions on file: {view.subscriptionCount}</p>
            <p>
              To cancel a subscription, go to{" "}
              <a href="?tab=checkout&checkoutTab=subscriptions">Checkout → Subscriptions</a>. This view never
              cancels — cancellation lives in Checkout (2.14).
            </p>
          </Card>
          <Card>
            <p>Paid-call receipts ({view.receipts.length})</p>
            {receiptsError && <p>{receiptsError}</p>}
            {!receiptsError && view.receipts.length === 0 && <p>No receipts recorded yet.</p>}
            {view.receipts.map((entry) => (
              <p key={entry.id}>
                {receiptKindLabel(entry)} — {entry.amountUSD !== null ? `$${entry.amountUSD.toFixed(2)} USD` : "—"} —{" "}
                {entry.provenance}
              </p>
            ))}
          </Card>
          <Card>
            <p>Active plans</p>
            {view.plans.length === 0 && <p>No active subscription plan — operator data missing.</p>}
            {view.plans.map((plan) => (
              <p key={plan.id}>
                {plan.name} — ${plan.priceUSD.toFixed(2)} / {plan.periodDays} days
              </p>
            ))}
          </Card>
          <Card>
            <p>Referral credits</p>
            <p>Redeemable: ${view.referral.redeemableUSD.toFixed(2)} USD</p>
            <p>Total earned: ${view.referral.totalEarnedUSD.toFixed(2)} USD</p>
            <p>Attributed referrer: {view.referral.attributedReferrer ?? "none"}</p>
            <p>{view.referral.rulesNote}</p>
          </Card>
          <RefundPolicySection />
          <RefundFlowSection />
          <TopUpLimitsSection />
          <Card>
            <p>Support snapshot</p>
            <p>Account: {view.supportSnapshot.login}</p>
            <p>Tier: {view.supportSnapshot.tier}</p>
            <p>Subscription: {view.supportSnapshot.subscriptionStatus}</p>
            <p>Receipts on file: {view.supportSnapshot.receiptsCount}</p>
            <p>
              Include these details when contacting the operator. No in-product support channel is
              configured; support scope stays an owner decision.
            </p>
          </Card>
        </>
      )}
      </PageSection>
    </PageShell>
  );
}
