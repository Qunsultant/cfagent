/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
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
import { PageSection, PageShell } from "./components/ui/PageShell";
import { Select } from "./components/ui/Select";
import { Table, type TableColumn } from "./components/ui/Table";
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
} from "../data/productSelling";
import {
  errorMessageForStatus,
  fetchPlatformIdentity,
  FirstRunApiError,
} from "./firstRunApi";

const SELLING_BASE = "/api/payments/agentic/commercial";

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
      headers: { "content-type": "application/json" },
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
 * This section writes no checkout logic of its own: mint opens the
 * Stripe URL the API returns, and activation is shown only after a
 * verified row comes back from the subscription read. No cancel
 * action (2.14 + Phase 6 own it), no credits UI (2.2 unlanded),
 * no ads code, no lifecycle sends, no price invented anywhere.
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

  // A catalog row's Subscribe button opens this section from outside
  // (the purchase path for subscription products). The ref guard makes
  // repeat signals idempotent even under the effect's first-render
  // closure.
  useEffect(() => {
    if (openSignal > 0) void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {opened && loading && <p>Loading selling options</p>}
      {opened && error && <p>{error}</p>}
      {opened && !loading && !error && selling && (
        <>
          <Card>
            <p>Current tier: {selling.subscription.effectiveTier}</p>
            <p>Activation: {selling.subscription.activation}</p>
            {selling.subscription.current && (
              <p>
                Current period ends: {new Date(selling.subscription.current.periodEndMs).toISOString()}
              </p>
            )}
            <p>{selling.subscription.creditsRedemption.reason}</p>
          </Card>
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
          {actionError && <p>{actionError}</p>}
          {confirmed && <p>Subscription activated.</p>}
          {!minted && selling.plans.length > 0 && (
            <Button variant="secondary" onClick={subscribe}>
              Start checkout
            </Button>
          )}
          {!minted && selling.plans.length === 0 && (
            <p>No active subscription plan — operator data missing.</p>
          )}
          {minted && (
            <>
              <p>Checkout opened in a new tab. After paying, confirm below.</p>
              <Button variant="secondary" onClick={confirmPaid}>
                I have paid
              </Button>
            </>
          )}
          <Card>
            <p>Purchase receipts</p>
            {selling.subscription.receipts.length === 0 && <p>No purchases yet.</p>}
            {selling.subscription.receipts.map((receipt) => (
              <p key={receipt.subscriptionId}>
                {receipt.planName ?? receipt.planId} —{" "}
                {receipt.priceUSD === null ? "price unknown" : `$${receipt.priceUSD.toFixed(2)}`} —{" "}
                {receipt.providerStatus ?? receipt.status} — ends{" "}
                {new Date(receipt.periodEndMs).toISOString()}
              </p>
            ))}
          </Card>
          <Card>
            <p>How each product is sold</p>
            {selling.products.map((product) => (
              <p key={product.productId}>
                {product.canonicalName} — {product.rail} —{" "}
                {product.purchasable ? "purchasable" : (product.notPurchasableReason ?? "not purchasable")}
              </p>
            ))}
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
  // A catalog row's Subscribe button requests the Selling section to
  // open (the purchase path for subscription products, replacing the
  // Phase 4 "View plans" dead-end that linked at an API route).
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
    { key: "product", header: "Product", render: (row) => row.canonicalName },
    { key: "tier", header: "Tier", render: (row) => row.tier },
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
        // Subscription products buy through the Selling section's 2.1
        // Billing flow — NOT the Phase 4 "View plans" anchor, which
        // linked at an API route and was a dead end. The derivation
        // still records the plans pointer; the renderer upgrades it
        // to the purchase action, so Phase 4's display contract is
        // untouched. Unlisted rows never get a Subscribe button.
        row.listed && (row.tier === "Subscribed" || row.availability === "entitlement-pending") ? (
          <Button variant="secondary" onClick={() => setSellingOpenRequest((n) => n + 1)}>
            Subscribe
          </Button>
        ) : row.purchasePath ? (
          <a href={row.purchasePath.route}>{row.purchasePath.label}</a>
        ) : (
          (row.purchasePathReason ?? row.unlistedReasons.join("; "))
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
          row.unlistedReasons.join("; ")
        ),
    },
  ];

  return (
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
          <p>
            Teasers show at most {TEASER_CANDIDATE_CAP} candidates from the
            same screening pipeline and gates. Only gate-passing candidates
            with stated falsification criteria are shown; every entry is
            labeled as a teaser, never as a recommendation. Links appear
            only when the caller supplies them — a teaser never promises
            a report, subscription, or referral-credit path that does not
            exist.
          </p>
        </Card>
      </PageSection>
      <PageSection title="Marketing draft preview">
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
        {previewError && <p>{previewError}</p>}
        {preview && (
          <Card>
            <p>{preview.text}</p>
            <p>
              Draft only — not published. Publishing requires owner
              approval.
            </p>
            {preview.citationOmittedReason && (
              <p>Citation omitted: {preview.citationOmittedReason}</p>
            )}
            {preview.truncated && <p>Draft truncated to the channel limit.</p>}
          </Card>
        )}
      </PageSection>
      <SellingSection products={products} openSignal={sellingOpenRequest} />
    </PageShell>
  );
}
