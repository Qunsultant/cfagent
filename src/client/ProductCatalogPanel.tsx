/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 * Modernized UI under issue #2843 with design token styling, structured cards,
 * tabular sales rails & receipts, and robust error/status notices.
 *
 * The first surface that renders the Phase 2 product catalog:
 * a read-only panel over GET /api/products/catalog. Prices are
 * shown only when approved (the route derives them from the
 * catalog; this panel never invents one), parity verdicts are
 * shown exactly as Phase 3 recorded them, and unlisted products
 * render with their reasons, never hidden silently.
 *
 * The draft preview composes (never publishes) a marketing draft
 * for a listed row from the Phase 2 naming registry. Preview is
 * composition only: no draft is stored, sent, or posted, and the
 * preview states that publishing requires owner approval.
 * No ads are served from this panel (ads enforcement is #2658).
 */
import React, { useEffect, useRef, useState } from "react";
import { Badge } from "./components/ui/Badge";
import { FieldShell } from "./components/ui/Field";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { PageSection, PageShell } from "./components/ui/PageShell";
import { Select } from "./components/ui/Select";
import { TextInput } from "./components/ui/TextInput";
import { Table, type TableColumn } from "./components/ui/Table";
import { AmbientOfferCompare, type PlanChoice } from "./PlanCompare";
import {
  composeMarketingDraft,
  TEASER_CANDIDATE_CAP,
  type CatalogDisplayEntry,
  type MarketingChannel,
  type MarketingDraft,
} from "../data/productMarketing";
import {
  buildProductSelling,
  type CatalogDisplayEntryLike,
  type SellingPlanInput,
  type SubscriptionRowInput,
  type SellingReceipt,
  type ProductSellingEntry,
} from "../data/productSelling";
import {
  errorMessageForStatus,
  fetchPlatformIdentity,
  FirstRunApiError,
} from "./firstRunApi";
import { trialEndedMessage } from "../services/trialSubscriptionActivation";
import { csrfHeaders } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const SELLING_BASE = COMMERCIAL_API_BASE;

const pageWrapperStyle: React.CSSProperties = {
  padding: "var(--space-4)",
  boxSizing: "border-box",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const cardHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  marginBottom: "var(--space-3)",
  flexWrap: "wrap",
};

const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-title-sm)",
  fontWeight: "var(--font-weight-bold)",
  color: "var(--color-text-primary)",
};

const cardSubtitleStyle: React.CSSProperties = {
  margin: "var(--space-1) 0 0",
  fontSize: "var(--font-size-body-sm)",
  color: "var(--color-text-muted)",
};

const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
  flexWrap: "wrap",
};

const detailTextStyle: React.CSSProperties = {
  margin: "var(--space-2) 0",
  fontSize: "var(--font-size-body)",
  color: "var(--color-text-primary)",
};

const detailMutedTextStyle: React.CSSProperties = {
  margin: "var(--space-2) 0 0",
  fontSize: "var(--font-size-body-sm)",
  color: "var(--color-text-muted)",
};

const checkoutRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
  alignItems: "flex-end",
  flexWrap: "wrap",
  marginTop: "var(--space-3)",
  marginBottom: "var(--space-3)",
};

const mintedActionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-3)",
  marginBottom: "var(--space-3)",
};

const sectionHeaderStyle: React.CSSProperties = {
  marginBottom: "var(--space-3)",
};

const channelSelectWrapperStyle: React.CSSProperties = {
  maxWidth: "320px",
  marginBottom: "var(--space-3)",
};

const draftBoxStyle: React.CSSProperties = {
  background: "var(--color-surface-sunken)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-3)",
  margin: "var(--space-3) 0",
  overflowX: "auto",
};

const draftTextStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--font-size-body-sm)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--color-text-primary)",
};

const linkStyle: React.CSSProperties = {
  color: "var(--color-accent)",
  textDecoration: "underline",
  fontWeight: "var(--font-weight-medium)",
};

/** Fixed caller-facing selling messages per HTTP status. Server bodies
 *  are never rendered — they can carry internal detail. */
function sellingMintError(status: number): string {
  if (status === 503) {
    return "Subscription checkout is not configured yet (no active plan, price mapping, or Stripe configuration).";
  }
  if (status === 403) {
    return "Subscription purchase is disabled (the monetization flag is off).";
  }
  return errorMessageForStatus(status);
}

function sellingConfirmError(status: number): string {
  if (status === 402) {
    return "Payment not verified — nothing activated.";
  }
  if (status === 409) {
    return "This checkout was already used or does not match — nothing activated.";
  }
  return errorMessageForStatus(status);
}

/** Fixed caller-facing trial messages per HTTP status (#3243). */
function trialErrorMessage(status: number): string {
  if (status === 409) {
    return "This plan's trial is not available — it may already have been used, or the plan offers no trial.";
  }
  if (status === 403) {
    return "Trial signup is disabled (the monetization flag is off).";
  }
  return errorMessageForStatus(status);
}

/** Fixed caller-facing cfpay channel messages per HTTP status (#2945). */
function channelMintError(status: number): string {
  if (status === 503) {
    return "The cfpay channel is not configured yet (no approved price or operator channel price).";
  }
  if (status === 409) {
    return "This product's price does not match the channel's configured fixed price.";
  }
  if (status === 403) {
    return "Channel purchases are disabled (the monetization flag is off).";
  }
  return errorMessageForStatus(status);
}

function channelConfirmError(status: number): string {
  if (status === 402) {
    return "Payment not verified — no credit granted.";
  }
  if (status === 409) {
    return "This channel purchase was already fulfilled.";
  }
  if (status === 502) {
    return "Payment is verified, but fulfilment could not be recorded — no credit granted. An operator must reconcile.";
  }
  if (status === 404) {
    return "Unknown channel purchase.";
  }
  if (status === 403) {
    return "Only the purchase owner may confirm it.";
  }
  return errorMessageForStatus(status);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await globalThis.fetch(path);
  } catch {
    throw new FirstRunApiError(0);
  }
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postJson(
  path: string,
  payload: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await globalThis.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new FirstRunApiError(0);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlans(body: unknown): SellingPlanInput[] {
  if (!isRecord(body) || !Array.isArray(body.plans)) return [];
  return body.plans.filter(isRecord).map((p) => ({
    id: typeof p.id === "string" ? p.id : "",
    name: typeof p.name === "string" ? p.name : "",
    priceUSD: typeof p.priceUSD === "number" ? p.priceUSD : 0,
    periodDays: typeof p.periodDays === "number" ? p.periodDays : 0,
    includedRuns: typeof p.includedRuns === "number" ? p.includedRuns : 0,
    trialDays: typeof p.trialDays === "number" ? p.trialDays : null,
    active: p.active === true,
  }));
}

function parseSubscriptions(body: unknown): { effectiveTier: string; rows: SubscriptionRowInput[] } {
  if (!isRecord(body) || !Array.isArray(body.subscriptions)) {
    return { effectiveTier: "Free", rows: [] };
  }
  const rows = body.subscriptions.filter(isRecord).map((s) => ({
    id: typeof s.id === "string" ? s.id : "",
    userId: typeof s.userId === "string" ? s.userId : "",
    planId: typeof s.planId === "string" ? s.planId : "",
    provider: typeof s.provider === "string" ? s.provider : "",
    providerSubscriptionId: typeof s.providerSubscriptionId === "string" ? s.providerSubscriptionId : null,
    providerStatus: typeof s.providerStatus === "string" ? s.providerStatus : null,
    status: typeof s.status === "string" ? s.status : "",
    periodStartMs: typeof s.periodStartMs === "number" ? s.periodStartMs : 0,
    periodEndMs: typeof s.periodEndMs === "number" ? s.periodEndMs : 0,
    canceledAtMs: typeof s.canceledAtMs === "number" ? s.canceledAtMs : null,
  }));
  return {
    effectiveTier: typeof body.effectiveTier === "string" ? body.effectiveTier : "Free",
    rows,
  };
}

/**
 * Issue #2717 (Platform Phase 5) — the Selling section.
 *
 * Loads on demand only (a button click), so the panel's catalog-only
 * fetch contract is untouched until the user asks to buy. All selling
 * calls go to EXISTING routes: identity (session-derived, self-only),
 * subscription read, plans list, and the 2.1 Billing API
 * (billing-checkout mint, billing-purchase confirm-by-retrieve).
 */
function SellingSection({
  products,
  openSignal,
}: {
  products: CatalogDisplayEntry[] | null;
  openSignal: number;
}) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const [effectiveTier, setEffectiveTier] = useState<string | null>(null);
  const [rows, setRows] = useState<SubscriptionRowInput[]>([]);
  const [plans, setPlans] = useState<SellingPlanInput[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [minted, setMinted] = useState<{
    planId: string;
    checkoutRequestId: string;
    checkoutSessionId: string;
    checkoutUrl: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // Issue #3243 — trial signup state (same Selling section, never
  // a second purchase path: the trial is a $0 checkout on the
  // selected plan, and the paid Billing checkout above is untouched).
  const [trialStarted, setTrialStarted] = useState<{
    planName: string;
    message: string;
    trialEndsAtMs: number;
  } | null>(null);
  const [trialError, setTrialError] = useState<string | null>(null);
  // Issue #2945 — cfpay channel card state (same Selling section, never
  // a second purchase path: the catalog entry stays the single entry).
  const [channelFamily, setChannelFamily] = useState("");
  const [channelEmail, setChannelEmail] = useState("");
  const [channelDraft, setChannelDraft] = useState<{
    id: string;
    family: string;
    expectedPriceUSD: number;
  } | null>(null);
  const [channelConfirmed, setChannelConfirmed] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  async function load(userLogin: string) {
    const sub = await getJson(
      `${SELLING_BASE}/subscription?userId=${encodeURIComponent(userLogin)}`,
    );
    if (sub.status !== 200) throw new FirstRunApiError(sub.status);
    const parsed = parseSubscriptions(sub.body);
    setEffectiveTier(parsed.effectiveTier);
    setRows(parsed.rows);
    const plansRes = await getJson(`${SELLING_BASE}/plans`);
    if (plansRes.status !== 200) throw new FirstRunApiError(plansRes.status);
    const parsedPlans = parsePlans(plansRes.body);
    setPlans(parsedPlans);
    const firstActive = parsedPlans.find((p) => p.active);
    if (firstActive) setSelectedPlanId(firstActive.id);
  }

  async function open() {
    setOpened(true);
    if (loadedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const identity = await fetchPlatformIdentity();
      await load(identity.userLogin);
      loadedRef.current = true;
    } catch (err) {
      setError(err instanceof FirstRunApiError ? errorMessageForStatus(err.status) : "Something went wrong. Try again later.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (openSignal > 0) void open();
  }, [openSignal]);

  async function subscribe() {
    if (!selectedPlanId) return;
    setActionError(null);
    setConfirmed(false);
    try {
      const res = await postJson(`${SELLING_BASE}/subscription/billing-checkout`, { planId: selectedPlanId });
      if (res.status !== 200) {
        setActionError(sellingMintError(res.status));
        return;
      }
      const checkoutRequestId = typeof res.body.checkoutRequestId === "string" ? res.body.checkoutRequestId : "";
      const checkoutSessionId = typeof res.body.checkoutSessionId === "string" ? res.body.checkoutSessionId : "";
      const checkoutUrl = typeof res.body.checkoutUrl === "string" ? res.body.checkoutUrl : "";
      if (!checkoutRequestId || !checkoutSessionId || !checkoutUrl) {
        setActionError("Subscription checkout could not be created. Try again later.");
        return;
      }
      setMinted({ planId: selectedPlanId, checkoutRequestId, checkoutSessionId, checkoutUrl });
      window.open(checkoutUrl, "_blank");
    } catch {
      setActionError("Subscription checkout could not be created. Try again later.");
    }
  }

  async function confirmPaid() {
    if (!minted) return;
    setActionError(null);
    try {
      const res = await postJson(`${SELLING_BASE}/subscription/billing-purchase`, {
        planId: minted.planId,
        checkoutRequestId: minted.checkoutRequestId,
        checkoutSessionId: minted.checkoutSessionId,
      });
      if (res.status !== 200) {
        setActionError(sellingConfirmError(res.status));
        return;
      }
      const identity = await fetchPlatformIdentity();
      await load(identity.userLogin);
      setConfirmed(true);
      setMinted(null);
    } catch {
      setActionError("Payment confirmation could not be completed. Try again later.");
    }
  }

  async function startTrial() {
    if (!selectedPlanId) return;
    setTrialError(null);
    setTrialStarted(null);
    try {
      const res = await postJson(`${SELLING_BASE}/subscription/trial`, { planId: selectedPlanId });
      if (res.status !== 200) {
        setTrialError(trialErrorMessage(res.status));
        return;
      }
      const message = typeof res.body.message === "string" ? res.body.message : "";
      const trialEndsAtMs = typeof res.body.trialEndsAtMs === "number" ? res.body.trialEndsAtMs : 0;
      const planName = plans.find((p) => p.id === selectedPlanId)?.name ?? selectedPlanId;
      setTrialStarted({ planName, message, trialEndsAtMs });
      const identity = await fetchPlatformIdentity();
      await load(identity.userLogin);
    } catch {
      setTrialError("Trial could not be started. Try again later.");
    }
  }

  async function channelMint() {
    if (!channelFamily || !channelEmail.trim()) return;
    setChannelError(null);
    setChannelConfirmed(false);
    try {
      const res = await postJson(`${SELLING_BASE}/channel/checkout`, {
        family: channelFamily,
        email: channelEmail.trim(),
      });
      if (res.status !== 201) {
        setChannelError(channelMintError(res.status));
        return;
      }
      const draft = res.body.draft as Record<string, unknown> | undefined;
      const id = typeof draft?.id === "string" ? draft.id : "";
      const price = typeof draft?.expectedPriceUSD === "number" ? draft.expectedPriceUSD : NaN;
      if (!id || !Number.isFinite(price)) {
        setChannelError("Channel checkout could not be created. Try again later.");
        return;
      }
      setChannelDraft({ id, family: channelFamily, expectedPriceUSD: price });
    } catch {
      setChannelError("Channel checkout could not be created. Try again later.");
    }
  }

  async function channelConfirmPaid() {
    if (!channelDraft) return;
    setChannelError(null);
    try {
      const res = await postJson(`${SELLING_BASE}/channel/purchase`, {
        channelRequestId: channelDraft.id,
      });
      if (res.status !== 200) {
        setChannelError(channelConfirmError(res.status));
        return;
      }
      const identity = await fetchPlatformIdentity();
      await load(identity.userLogin);
      setChannelConfirmed(true);
      setChannelDraft(null);
    } catch {
      setChannelError("Payment confirmation could not be completed. Try again later.");
    }
  }

  const selling =
    effectiveTier !== null
      ? buildProductSelling({
          display: (products ?? []).map(
            (p): CatalogDisplayEntryLike => ({
              id: p.id,
              canonicalName: p.canonicalName,
              tier: p.tier,
              availability: p.availability,
              listed: p.listed,
              unlistedReasons: p.unlistedReasons,
              priceUSD: p.priceUSD,
              purchasePath: p.purchasePath,
              purchasePathReason: p.purchasePathReason,
            }),
          ),
          plans,
          effectiveTier,
          subscriptions: rows,
          nowMs: Date.now(),
        })
      : null;

  // Issue #3243 — trial state for the selected plan, derived from
  // the rows the subscription read already returns: a trial row
  // (provider "trial") means the trial was used; a trial row
  // past periodEnd means it ended. The server enforces both —
  // this is display only.
  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;
  const trialRow = rows.find((r) => r.planId === selectedPlanId && r.provider === "trial") ?? null;
  const trialExpired = trialRow !== null && trialRow.periodEndMs <= Date.now();

  // Issue #3246 — the trial-end offer: this panel has NO family
  // context (plans carry no family; subscription products are not
  // family-scoped), and the trial_end trigger requires a family,
  // so the surface renders the AMBIENT compare (GET
  // /offer/compare, family omitted) below the trial-ended notice
  // — the same component and payload shape, honestly labeled.
  // The compare's actions navigate to the native checkout (the
  // one-time purchase route is the only acceptance path for an
  // offer; this panel's own Billing checkout confers tier only
  // and would strand the user), carrying the trial_end trigger
  // for the acceptance audit.
  const goToCheckoutOffer = (choice: PlanChoice) => {
    const params = new URLSearchParams({
      tab: "checkout",
      checkoutTab: "subscriptions",
      plan: choice.versionId,
      offer: "trial_end",
    });
    window.location.assign(`?${params.toString()}`);
  };
  const goToTopUpOffer = () => {
    const params = new URLSearchParams({ tab: "checkout", checkoutTab: "topup", offer: "trial_end" });
    window.location.assign(`?${params.toString()}`);
  };

  return (
    <PageSection
      title="Selling"
      description="Subscribe through the Billing checkout API and see activation + purchase receipts. This panel never decides a charge — the 2.1 Billing API does, on verified payment only. Billing subscriptions renew automatically via Stripe; renewals are applied by webhook."
    >
      {!opened && (
        <Button variant="secondary" onClick={open}>
          Show selling options
        </Button>
      )}
      {opened && loading && <Notice tone="neutral">Loading selling options</Notice>}
      {opened && error && <Notice tone="danger" title="Selling options unavailable">{error}</Notice>}
      {opened && !loading && !error && selling && (
        <>
          <Card>
            <div style={cardHeaderRowStyle}>
              <div>
                <h3 style={cardTitleStyle}>Current tier: {selling.subscription.effectiveTier}</h3>
                <p style={cardSubtitleStyle}>Live entitlement status and active period window</p>
              </div>
              <div style={badgeRowStyle}>
                <Badge tone="accent">{selling.subscription.effectiveTier}</Badge>
                <Badge tone={selling.subscription.activation !== "none" ? "success" : "neutral"}>
                  Activation: {selling.subscription.activation}
                </Badge>
              </div>
            </div>
            {selling.subscription.current && (
              <p style={detailTextStyle}>
                Current period ends: {new Date(selling.subscription.current.periodEndMs).toISOString()}
              </p>
            )}
            {selling.subscription.current && (
              <p style={detailMutedTextStyle}>
                <a href="?tab=checkout&checkoutTab=subscriptions">
                  Manage or cancel this subscription in Checkout → Subscriptions
                </a>
                . This panel never cancels — cancellation lives in Checkout (2.14).
              </p>
            )}
            <p style={detailMutedTextStyle}>{selling.subscription.creditsRedemption.reason}</p>
          </Card>

          <div style={checkoutRowStyle}>
            <FieldShell id="selling-plan" label="Plan">
              <Select
                id="selling-plan"
                aria-label="Subscription plan"
                value={selectedPlanId}
                onChange={(event) => setSelectedPlanId(event.target.value)}
              >
                {selling.plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} — ${plan.priceUSD.toFixed(2)} / {plan.periodDays} days
                  </option>
                ))}
              </Select>
            </FieldShell>
            {!minted && selling.plans.length > 0 && (
              <Button variant="secondary" onClick={subscribe}>
                Start checkout
              </Button>
            )}
            {!minted && selectedPlan && selectedPlan.trialDays !== null && !trialRow && (
              <Button variant="secondary" onClick={startTrial}>
                Start free trial ({selectedPlan.trialDays} days)
              </Button>
            )}
          </div>

          {actionError && <Notice tone="danger" title="Checkout Error">{actionError}</Notice>}
          {confirmed && <Notice tone="success" title="Subscription Activated">Subscription activated.</Notice>}
          {selectedPlan && selectedPlan.trialDays !== null && !trialRow && (
            <p style={detailMutedTextStyle}>
              Free trial: {selectedPlan.trialDays} days, {selectedPlan.includedRuns} included runs.
              No payment is taken. When the trial ends, subscribe or pay per run to keep running screens.
            </p>
          )}
          {trialError && <Notice tone="danger" title="Trial Error">{trialError}</Notice>}
          {trialStarted && (
            <Notice tone="success" title="Free Trial Started">
              {trialStarted.message}
            </Notice>
          )}
          {trialExpired && selectedPlan && (
            <>
              <Notice tone="neutral" title="Trial Ended">
                {trialEndedMessage(selectedPlan.name)}
              </Notice>
              <AmbientOfferCompare
                onChoosePlan={(choice) => goToCheckoutOffer(choice)}
                onBuyCredits={goToTopUpOffer}
              />
            </>
          )}
          {!minted && selling.plans.length === 0 && (
            <Notice tone="neutral">No active subscription plan — operator data missing.</Notice>
          )}
          {minted && (
            <div style={mintedActionStyle}>
              <Notice tone="info" title="Checkout In Progress">
                Checkout opened in a new tab. After paying, confirm below.
              </Notice>
              <Button variant="secondary" onClick={confirmPaid}>
                I have paid
              </Button>
            </div>
          )}

          <Card>
            <div style={sectionHeaderStyle}>
              <h3 style={cardTitleStyle}>Pay per run via cfpay channel</h3>
              <p style={cardSubtitleStyle}>
                One pay-per-use run of a listed product, paid through the cfpay channel. No
                subscription is created. Credit is added only after the payment is verified —
                never on checkout creation. The server refuses any product whose approved price
                does not match the operator-set channel price.
              </p>
            </div>
            <div style={checkoutRowStyle}>
              <FieldShell id="channel-product" label="Product">
                <Select
                  id="channel-product"
                  aria-label="Channel product"
                  value={channelFamily}
                  onChange={(event) => setChannelFamily(event.target.value)}
                >
                  <option value="">Select a product</option>
                  {(products ?? [])
                    .filter((p) => p.listed && p.priceUSD !== null)
                    .map((p) => (
                      <option key={p.family} value={p.family}>
                        {p.canonicalName} — ${p.priceUSD!.toFixed(2)}
                      </option>
                    ))}
                </Select>
              </FieldShell>
              <FieldShell id="channel-email" label="Email">
                <TextInput
                  id="channel-email"
                  aria-label="Channel checkout email"
                  type="email"
                  placeholder="you@example.com"
                  value={channelEmail}
                  onChange={(event) => setChannelEmail(event.target.value)}
                />
              </FieldShell>
              {!channelDraft && (
                <Button
                  variant="secondary"
                  onClick={channelMint}
                  disabled={!channelFamily || !channelEmail.trim()}
                >
                  Start channel checkout
                </Button>
              )}
            </div>
            {channelError && <Notice tone="danger" title="Channel Error">{channelError}</Notice>}
            {channelConfirmed && (
              <Notice tone="success" title="Channel Purchase Fulfilled">
                Run credit added.
              </Notice>
            )}
            {channelDraft && (
              <div style={mintedActionStyle}>
                <Notice tone="info" title="Channel Checkout Created">
                  Pay this channel purchase (${channelDraft.expectedPriceUSD.toFixed(2)} for{" "}
                  {channelDraft.family}), then confirm below. Request id: {channelDraft.id}
                </Notice>
                <Button variant="secondary" onClick={channelConfirmPaid}>
                  I have paid
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <div style={sectionHeaderStyle}>
              <h3 style={cardTitleStyle}>Purchase receipts</h3>
              <p style={cardSubtitleStyle}>Recorded transaction history and billing verification</p>
            </div>
            {selling.subscription.receipts.length === 0 ? (
              <p style={detailMutedTextStyle}>No purchases yet.</p>
            ) : (
              <Table<SellingReceipt>
                columns={[
                  {
                    key: "plan",
                    header: "Plan",
                    render: (receipt) => <strong>{receipt.planName ?? receipt.planId}</strong>,
                  },
                  {
                    key: "price",
                    header: "Price",
                    render: (receipt) =>
                      receipt.priceUSD === null ? "price unknown" : `$${receipt.priceUSD.toFixed(2)}`,
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (receipt) => (
                      <Badge tone={receipt.status === "active" ? "success" : "neutral"}>
                        {receipt.providerStatus ?? receipt.status}
                      </Badge>
                    ),
                  },
                  {
                    key: "period",
                    header: "Coverage",
                    render: (receipt) => `ends ${new Date(receipt.periodEndMs).toISOString()}`,
                  },
                ]}
                rows={selling.subscription.receipts}
                rowKey={(receipt) => receipt.subscriptionId}
                caption="Purchase receipts"
              />
            )}
          </Card>

          <Card>
            <div style={sectionHeaderStyle}>
              <h3 style={cardTitleStyle}>How each product is sold</h3>
              <p style={cardSubtitleStyle}>Entitlement rails and subscription gating breakdown</p>
            </div>
            <Table<ProductSellingEntry>
              columns={[
                {
                  key: "product",
                  header: "Product",
                  render: (product) => <strong>{product.canonicalName}</strong>,
                },
                {
                  key: "rail",
                  header: "Billing Rail",
                  render: (product) => <Badge tone="neutral">{product.rail}</Badge>,
                },
                {
                  key: "purchasable",
                  header: "Status",
                  render: (product) => (
                    <Badge tone={product.purchasable ? "success" : "neutral"}>
                      {product.purchasable
                        ? "purchasable"
                        : (product.notPurchasableReason ?? "not purchasable")}
                    </Badge>
                  ),
                },
              ]}
              rows={selling.products}
              rowKey={(product) => product.productId}
              caption="Product sales rails"
            />
          </Card>
        </>
      )}
    </PageSection>
  );
}

function availabilityTone(
  availability: CatalogDisplayEntry["availability"],
): "success" | "neutral" {
  return availability === "purchasable" ? "success" : "neutral";
}

function parityTone(
  verdict: CatalogDisplayEntry["parityVerdict"],
): "success" | "neutral" {
  return verdict === "parity" ? "success" : "neutral";
}

export function ProductCatalogPanel() {
  const [products, setProducts] = useState<CatalogDisplayEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<MarketingChannel>("facebook");
  const [preview, setPreview] = useState<MarketingDraft | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sellingOpenRequest, setSellingOpenRequest] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/products/catalog")
      .then(async (res) => {
        if (!res.ok) throw new Error(`catalog request failed: ${res.status}`);
        const body = (await res.json()) as { products: CatalogDisplayEntry[] };
        if (!cancelled) setProducts(body.products);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "catalog request failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columns: TableColumn<CatalogDisplayEntry>[] = [
    { key: "product", header: "Product", render: (row) => <strong>{row.canonicalName}</strong> },
    { key: "tier", header: "Tier", render: (row) => <Badge tone="neutral">{row.tier}</Badge> },
    {
      key: "price",
      header: "Price",
      render: (row) => row.priceLabel ?? "—",
    },
    {
      key: "availability",
      header: "Availability",
      render: (row) => (
        <Badge tone={availabilityTone(row.availability)}>{row.availability}</Badge>
      ),
    },
    {
      key: "parity",
      header: "Parity",
      render: (row) => (
        <Badge tone={parityTone(row.parityVerdict)}>
          {row.parityVerdict ?? "unknown"}
        </Badge>
      ),
    },
    {
      key: "purchase",
      header: "Purchase path",
      render: (row) =>
        row.listed && (row.tier === "Subscribed" || row.availability === "entitlement-pending") ? (
          <Button variant="secondary" onClick={() => setSellingOpenRequest((n) => n + 1)}>
            Subscribe
          </Button>
        ) : row.purchasePath ? (
          <a href={row.purchasePath.route} style={linkStyle}>{row.purchasePath.label}</a>
        ) : (
          <span style={detailMutedTextStyle}>{row.purchasePathReason ?? row.unlistedReasons.join("; ")}</span>
        ),
    },
    {
      key: "draft",
      header: "Draft preview",
      render: (row) =>
        row.listed ? (
          <Button
            variant="secondary"
            onClick={() => {
              try {
                setPreviewError(null);
                setPreview(
                  composeMarketingDraft(
                    {
                      id: row.id,
                      canonicalName: row.canonicalName,
                      priceUSD: row.priceUSD,
                      listed: row.listed,
                      unlistedReasons: row.unlistedReasons,
                    },
                    channel,
                  ),
                );
              } catch (err) {
                setPreview(null);
                setPreviewError(
                  err instanceof Error ? err.message : "draft composition failed",
                );
              }
            }}
          >
            Preview draft
          </Button>
        ) : (
          <span style={detailMutedTextStyle}>{row.unlistedReasons.join("; ")}</span>
        ),
    },
  ];

  return (
    <div style={pageWrapperStyle}>
      <PageShell
        title="Products"
        scopeNote="The product catalog as the Phase 2 registry records it, with Phase 3 access parity. Prices shown are approved prices only."
        loading={products === null && error === null}
        loadingLabel="Loading catalog"
        error={error}
        empty={products !== null && products.length === 0}
        emptyTitle="No products registered"
        emptyDescription="The catalog has no entries yet."
      >
        <PageSection title="Catalog">
          <Table
            columns={columns}
            rows={products ?? []}
            rowKey={(row) => row.id}
            caption="Product catalog"
          />
        </PageSection>
        <PageSection
          title="Teaser rules"
          description="How limited teasers are built (teaser rule B1, issue 1076)."
        >
          <Card>
            <Notice tone="info" title="Teaser Rule B1 (Issue 1076)">
              Teasers show at most {TEASER_CANDIDATE_CAP} candidates from the
              same screening pipeline and gates. Only gate-passing candidates
              with stated falsification criteria are shown; every entry is
              labeled as a teaser, never as a recommendation. Links appear
              only when the caller supplies them — a teaser never promises
              a report, subscription, or referral-credit path that does not
              exist.
            </Notice>
          </Card>
        </PageSection>
        <PageSection
          title="Marketing draft preview"
          description="Compose channel-formatted promotional snippets directly from catalog records."
        >
          <div style={channelSelectWrapperStyle}>
            <FieldShell id="marketing-channel" label="Channel">
              <Select
                id="marketing-channel"
                aria-label="Marketing channel"
                value={channel}
                onChange={(event) =>
                  setChannel(event.target.value as MarketingChannel)
                }
              >
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="threads">Threads</option>
                <option value="slack">Slack</option>
              </Select>
            </FieldShell>
          </div>
          {previewError && (
            <Notice tone="danger" title="Draft Composition Error">
              {previewError}
            </Notice>
          )}
          {preview && (
            <Card>
              <div style={cardHeaderRowStyle}>
                <h4 style={cardTitleStyle}>Draft Preview</h4>
                <Badge tone="accent">{channel.toUpperCase()}</Badge>
              </div>
              <div style={draftBoxStyle}>
                <pre style={draftTextStyle}>{preview.text}</pre>
              </div>
              <Notice tone="warning" title="Publication Guardrail">
                Draft only — not published. Publishing requires owner approval.
              </Notice>
              {preview.citationOmittedReason && (
                <p style={detailMutedTextStyle}>Citation omitted: {preview.citationOmittedReason}</p>
              )}
              {preview.truncated && <Notice tone="neutral">Draft truncated to the channel limit.</Notice>}
            </Card>
          )}
        </PageSection>
        <SellingSection products={products} openSignal={sellingOpenRequest} />
      </PageShell>
    </div>
  );
}
