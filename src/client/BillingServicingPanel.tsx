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
 *
 * Issue #4638 — the sections render as URL-synced sub-tabs (ProductHub
 * pattern: `useUrlSyncedTabs` on "view" + Tabs/TabPanel + visitedTabs
 * gating), Overview first and default; each section appears exactly
 * once, in its own tab. Tabs change navigation only, never who sees
 * what: operator-only sections keep their existing non-operator
 * behaviour inside their tab.
 *
 * Issue #4691 — the panel renders as a tab, not a page: Chat applies
 * "tab" chrome (PageChromeContext) around it, so this PageShell renders
 * content-only and the servicing description rides as its scope note
 * (dropped under tab chrome, kept under page chrome). The tab strip
 * renders from first paint; each section owns its title through its
 * own PageShell, so under tab chrome the tab label is the title.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { PageShell, PageSection } from "./components/ui/PageShell";
import { Tabs, TabPanel, type TabOption } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { ErrorBoundary } from "./ErrorBoundary";
import { fetchPlatformIdentity } from "./firstRunApi";
import { receiptKindLabel } from "./agenticWalletApi";
import { RefundPolicySection } from "./RefundPolicySection";
import { RefundFlowSection } from "./RefundFlowSection";
import { ApprovedFreeQuotaSection } from "./ApprovedFreeQuotaSection";
import { UsageBillingSection } from "./UsageBillingSection";
import { TopUpLimitsSection } from "./TopUpLimitsSection";
import { ReferralCodesSection } from "./ReferralCodesSection";
import { OfferRulesSection } from "./OfferRulesSection";
import { PlanStripePriceSection } from "./PlanStripePriceSection";
import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
import type { SubscriptionView } from "./commercialApi";
import {
  buildBillingView,
  type BillingBundleEntitlementInput,
  type BillingBundlePurchaseInput,
  type BillingPlanInput,
  type BillingReceiptInput,
  type BillingReferralInput,
  type BillingSubscriptionInput,
  type BillingView,
} from "../data/billingServicing";

const BILLING_BASE = COMMERCIAL_API_BASE;

async function fetchJson(path: string): Promise<unknown> {
  const res = await globalThis.fetch(path);
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type BillingTab =
  | "overview"
  | "refund-policy"
  | "refund-flow"
  | "usage-billing"
  | "referral-codes"
  | "approved-free-quota"
  | "top-up-limits"
  | "offer-rules"
  | "plan-stripe-price"
  | "support-snapshot";

export const BILLING_TABS: readonly BillingTab[] = [
  "overview",
  "refund-policy",
  "refund-flow",
  "usage-billing",
  "referral-codes",
  "approved-free-quota",
  "top-up-limits",
  "offer-rules",
  "plan-stripe-price",
  "support-snapshot",
] as const;

export function isValidBillingTab(tab: unknown): tab is BillingTab {
  return (
    typeof tab === "string" &&
    (BILLING_TABS as readonly string[]).includes(tab)
  );
}

const BILLING_TAB_OPTIONS: TabOption<BillingTab>[] = [
  { id: "overview", label: "Overview" },
  { id: "refund-policy", label: "Refund policy" },
  { id: "refund-flow", label: "Refund flow" },
  { id: "usage-billing", label: "Usage billing" },
  { id: "referral-codes", label: "Referral codes" },
  { id: "approved-free-quota", label: "Approved free quota" },
  { id: "top-up-limits", label: "Top-up limits" },
  { id: "offer-rules", label: "Offer rules" },
  { id: "plan-stripe-price", label: "Plan Stripe Price mappings" },
  { id: "support-snapshot", label: "Support snapshot" },
];

/**
 * Issue #4643 — narrow the already-fetched GET /subscription rows
 * (unknown[]) to SubscriptionView[] for the refund picker. A row that
 * does not match the shape is dropped, never invented; the picker
 * simply lists fewer rows.
 */
function toSubscriptionViews(rows: unknown[]): SubscriptionView[] {
  return rows.filter((row): row is SubscriptionView => {
    if (!isRecord(row)) return false;
    return (
      typeof row.id === "string" &&
      typeof row.planId === "string" &&
      typeof row.status === "string" &&
      typeof row.periodStartMs === "number" &&
      typeof row.periodEndMs === "number" &&
      (row.providerSubscriptionId === undefined ||
        row.providerSubscriptionId === null ||
        typeof row.providerSubscriptionId === "string") &&
      (row.canceledAtMs === undefined ||
        row.canceledAtMs === null ||
        typeof row.canceledAtMs === "number")
    );
  });
}
export function BillingServicingPanel() {
  const { activeTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<BillingTab>({
      param: "view",
      isValid: isValidBillingTab,
      defaultTab: "overview",
    });
  const [view, setView] = useState<BillingView | null>(null);
  const [subscriptionRows, setSubscriptionRows] = useState<SubscriptionView[]>([]);
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
      // Issue #2781: bundle purchases + entitlements ride the
      // subscription read (additive keys); absent keys read as empty.
      const bundlePurchases =
        isRecord(subscriptionResult.value) && Array.isArray(subscriptionResult.value.bundlePurchases)
          ? (subscriptionResult.value.bundlePurchases as BillingBundlePurchaseInput[])
          : [];
      const bundleEntitlements =
        isRecord(subscriptionResult.value) && Array.isArray(subscriptionResult.value.bundleEntitlements)
          ? (subscriptionResult.value.bundleEntitlements as BillingBundleEntitlementInput[])
          : [];
      setView(
        buildBillingView({
          identity: { userLogin: identity.userLogin, tier: identity.tier },
          subscription,
          receipts,
          plans,
          referral,
          bundles: { purchases: bundlePurchases, entitlements: bundleEntitlements },
          nowMs: Date.now(),
        }),
      );
      setSubscriptionRows(toSubscriptionViews(subscription.subscriptions));
    } catch {
      setSubscriptionRows([]);
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
    <PageShell
      title="Billing"
      scopeNote="Your subscription, receipts, plans, and referral-credit balance — servicing over existing routes. This view never charges, purchases, cancels, or deactivates. Operators also approve refund-policy kinds here and decide and execute refunds; any verified login may request and verify their own refunds."
    >
      <PageSection>
      {/* Issue #4691 — the tab strip renders from first paint (the
          ProductHub shape): the active tab is URL-derived, so the strip
          is the navigation while the data loads, and the panels mount
          once the view loads. */}
      <Tabs<BillingTab>
        idBase="billing"
        ariaLabel="Billing sections"
        tabs={BILLING_TAB_OPTIONS}
        value={activeTab}
        onChange={handleTabChange}
        className="ui-billing-tabs-sticky"
      />

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
          {/* Tabbed sections — mount on first visit, stay preserved. */}

          {visitedTabs.has("overview") && (
            <TabPanel
              idBase="billing"
              tabId="overview"
              active={activeTab === "overview"}
              retain
            >
              <ErrorBoundary label="Overview panel">
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
                  <p>Bundle purchases ({view.bundles.activePurchaseCount} active)</p>
                  {view.bundles.purchases.length === 0 && <p>No bundle purchases recorded yet.</p>}
                  {view.bundles.purchases.map((purchase) => (
                    <p key={purchase.id}>
                      Bundle {purchase.bundleId} — {purchase.status} — period ends{" "}
                      {new Date(purchase.periodEndMs).toISOString()}
                    </p>
                  ))}
                  {view.bundles.liveEntitlementCount > 0 && (
                    <p>
                      Live member entitlements: {view.bundles.liveEntitlementCount} —{" "}
                      {view.bundles.entitlements
                        .filter((e) => e.status === "active")
                        .map((e) => e.productId)
                        .join(", ")}
                    </p>
                  )}
                  <p>
                    Bundle purchases are not refundable through the refund flow — the refund decision
                    for bundles is undecided (owner decision pending).
                  </p>
                </Card>
                <Card>
                  <p>Referral credits</p>
                  <p>Redeemable: ${view.referral.redeemableUSD.toFixed(2)} USD</p>
                  <p>Total earned: ${view.referral.totalEarnedUSD.toFixed(2)} USD</p>
                  <p>Attributed referrer: {view.referral.attributedReferrer ?? "none"}</p>
                  <p>{view.referral.rulesNote}</p>
                </Card>
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("refund-policy") && (
            <TabPanel
              idBase="billing"
              tabId="refund-policy"
              active={activeTab === "refund-policy"}
              retain
            >
              <ErrorBoundary label="Refund policy panel">
                <RefundPolicySection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("refund-flow") && (
            <TabPanel
              idBase="billing"
              tabId="refund-flow"
              active={activeTab === "refund-flow"}
              retain
            >
              <ErrorBoundary label="Refund flow panel">
                <RefundFlowSection subscriptions={subscriptionRows} plans={view.plans} />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("usage-billing") && (
            <TabPanel
              idBase="billing"
              tabId="usage-billing"
              active={activeTab === "usage-billing"}
              retain
            >
              <ErrorBoundary label="Usage billing panel">
                <UsageBillingSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("referral-codes") && (
            <TabPanel
              idBase="billing"
              tabId="referral-codes"
              active={activeTab === "referral-codes"}
              retain
            >
              <ErrorBoundary label="Referral codes panel">
                <ReferralCodesSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("approved-free-quota") && (
            <TabPanel
              idBase="billing"
              tabId="approved-free-quota"
              active={activeTab === "approved-free-quota"}
              retain
            >
              <ErrorBoundary label="Approved free quota panel">
                <ApprovedFreeQuotaSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("top-up-limits") && (
            <TabPanel
              idBase="billing"
              tabId="top-up-limits"
              active={activeTab === "top-up-limits"}
              retain
            >
              <ErrorBoundary label="Top-up limits panel">
                <TopUpLimitsSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("offer-rules") && (
            <TabPanel
              idBase="billing"
              tabId="offer-rules"
              active={activeTab === "offer-rules"}
              retain
            >
              <ErrorBoundary label="Offer rules panel">
                <OfferRulesSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("plan-stripe-price") && (
            <TabPanel
              idBase="billing"
              tabId="plan-stripe-price"
              active={activeTab === "plan-stripe-price"}
              retain
            >
              <ErrorBoundary label="Plan Stripe Price mappings panel">
                <PlanStripePriceSection />
              </ErrorBoundary>
            </TabPanel>
          )}

          {visitedTabs.has("support-snapshot") && (
            <TabPanel
              idBase="billing"
              tabId="support-snapshot"
              active={activeTab === "support-snapshot"}
              retain
            >
              <ErrorBoundary label="Support snapshot panel">
                <Card>
                  <p>Account: {view.supportSnapshot.login}</p>
                  <p>Tier: {view.supportSnapshot.tier}</p>
                  <p>Subscription: {view.supportSnapshot.subscriptionStatus}</p>
                  <p>Receipts on file: {view.supportSnapshot.receiptsCount}</p>
                  <p>
                    Include these details when contacting the operator. No in-product support channel is
                    configured; support scope stays an owner decision.
                  </p>
                </Card>
              </ErrorBoundary>
            </TabPanel>
          )}        </>
      )}
      </PageSection>
    </PageShell>
  );
}
