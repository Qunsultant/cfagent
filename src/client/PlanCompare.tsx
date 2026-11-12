/**
 * Issue #3246 (sub-issue of #3241), slice 2 — the shared plan
 * comparison surface: one component, one payload shape, used by
 * the at-limit upsell, the CheckoutPanel subscriptions tab, and
 * the trial-end notice.
 *
 * The component renders the server-computed offer payload VERBATIM:
 * every number shown equals the payload exactly (the only
 * client-side formatting is currency/number display). It invents
 * no price, no discount, and no charging decision; it never reads
 * tier, tenant, segment, or price from client state, query params,
 * or storage. The payload is the only source.
 *
 * Layout: one row per plan (the current plan first, then upgrade
 * targets, then unavailable versions), attribute columns aligned
 * across rows — the same comparison shape as the checkout plans
 * table. Downgrade targets render in a separate group below, and
 * only for the ambient trigger (defense in depth: the server never
 * sends them on interruptive triggers, and this component checks
 * the trigger before rendering the group). Unavailable (PROPOSED)
 * versions render with the proposed label and ZERO buy actions.
 * Mentions render only when the payload carries them, verbatim.
 * Runs-pack rows belong to slice 3 and are not rendered here.
 *
 * ui primitives only, token-only styling. No issue references in
 * rendered text.
 */
import React, { useEffect, useState } from "react";
import { Badge, Button, Table } from "./components/ui";
import {
  formatPeriodEnd,
  formatUSD,
  getOfferCompare,
  isOfferPayloadView,
  type OfferPayloadView,
  type OfferTargetView,
  type ScreenerFamily,
} from "./commercialApi";

/** The version a Choose action buys: the target's primary version or its annual option. */
export interface PlanChoice {
  versionId: string;
  name: string;
  priceUSD: number;
  billingPeriod: "monthly" | "annual";
}

export interface PlanCompareProps {
  payload: OfferPayloadView;
  /** Fired when the user chooses a plan (upgrade or downgrade). The surface owns the purchase flow. */
  onChoosePlan?: (choice: PlanChoice) => void;
  /** Fired when the user chooses to buy credits (the pay-per-run alternative). */
  onBuyCredits?: () => void;
}

const UNAVAILABLE_LABEL = "Proposed price — not yet approved, not buyable";
const STACKING_DISCLOSURE =
  "Buying a plan adds its period to your current subscription and adds its included runs to your balance. Your current plan is not canceled or replaced.";
const DOWNGRADE_DISCLOSURE =
  "Buying this plan adds its runs to your balance and starts its period when your current paid-through period ends. Your current plan is not canceled and is not refunded.";
const BILLING_MANAGED_COPY =
  "Your current plan is managed through Stripe Billing — buying here would not change that subscription.";

function periodLabel(billingPeriod: "monthly" | "annual"): string {
  return billingPeriod === "monthly" ? "month" : "year";
}

function trialLabel(trialDays: number | null): string {
  return trialDays === null ? "No trial" : `${trialDays} days`;
}

interface CompareRow {
  key: string;
  kind: "current" | "target" | "unavailable" | "downgrade";
  name: React.ReactNode;
  price: React.ReactNode;
  runs: string;
  period: string;
  trial: string;
  features: string;
  action: React.ReactNode;
  disabled: boolean;
}

function targetRow(
  target: OfferTargetView,
  kind: "target" | "unavailable" | "downgrade",
  onChoosePlan: PlanCompareProps["onChoosePlan"],
): CompareRow {
  const annual = target.annualOption;
  const choosePrimary: PlanChoice = {
    versionId: target.versionId,
    name: target.name,
    priceUSD: target.priceUSD,
    billingPeriod: target.billingPeriod,
  };
  return {
    key: `${kind}-${target.versionId}`,
    kind,
    name: (
      <>
        {target.name}
        {target.recommended && kind === "target" && (
          <>
            {" "}
            <Badge tone="accent">Recommended</Badge>
          </>
        )}
        {kind === "unavailable" && (
          <>
            <br />
            <span>{UNAVAILABLE_LABEL}</span>
          </>
        )}
      </>
    ),
    price: (
      <>
        {formatUSD(target.priceUSD)} / {periodLabel(target.billingPeriod)}
        {annual && (
          <>
            <br />
            <span>
              Annual option: {formatUSD(annual.priceUSD)} per year (saves{" "}
              {formatUSD(annual.savingsVsMonthlyUSD)} vs monthly)
            </span>
          </>
        )}
      </>
    ),
    runs: String(target.includedRuns),
    period: `${target.periodDays} days · ${target.billingPeriod}`,
    trial: trialLabel(target.trialDays),
    features: target.features.length > 0 ? target.features.join(", ") : "—",
    action:
      kind === "unavailable" ? (
        <>—</>
      ) : !target.buyable ? (
        <Button size="sm" disabled>
          Choose plan
        </Button>
      ) : (
        <>
          <Button size="sm" onClick={() => onChoosePlan?.(choosePrimary)}>
            Choose plan
          </Button>
          {annual && (
            <>
              {" "}
              <Button
                size="sm"
                onClick={() =>
                  onChoosePlan?.({
                    versionId: annual.versionId,
                    name: target.name,
                    priceUSD: annual.priceUSD,
                    billingPeriod: "annual",
                  })
                }
              >
                Choose annual
              </Button>
            </>
          )}
        </>
      ),
    disabled: kind === "unavailable" || !target.buyable,
  };
}

const COLUMNS = [
  { key: "plan", header: "Plan", render: (row: CompareRow) => row.name },
  { key: "price", header: "Price", render: (row: CompareRow) => row.price, align: "right" as const },
  { key: "runs", header: "Included runs", render: (row: CompareRow) => row.runs, align: "right" as const },
  { key: "period", header: "Period", render: (row: CompareRow) => row.period },
  { key: "trial", header: "Trial", render: (row: CompareRow) => row.trial },
  { key: "features", header: "Features", render: (row: CompareRow) => row.features },
  { key: "action", header: "", render: (row: CompareRow) => row.action },
];

export function PlanCompare({ payload, onChoosePlan, onBuyCredits }: PlanCompareProps) {
  // An ineligible payload carries no targets and no actions: the
  // surface renders its fixed copy instead. This component never
  // shows an offer the payload says does not apply.
  if (!payload.eligible) return null;

  const { current } = payload;
  const held = current.heldPlan;
  const currentRow: CompareRow = {
    key: "current",
    kind: "current",
    name: (
      <>
        {held ? held.name : "Free"} <span>(your current plan)</span>
      </>
    ),
    price: held ? (
      <>Your price {formatUSD(held.heldPriceUSD)} / {periodLabel(held.billingPeriod)}</>
    ) : (
      <>{formatUSD(0)}</>
    ),
    runs: held
      ? `${current.includedRunsRemaining} of ${held.includedRuns} remaining`
      : current.freeRunsRemaining !== null && current.freeRunsRemaining !== undefined
        ? `${current.freeRunsRemaining} free runs remaining`
        : "—",
    period: held ? `Ends ${formatPeriodEnd(held.periodEndMs)}` : "—",
    trial: "—",
    features: "—",
    action: <>—</>,
    disabled: false,
  };

  const rows: CompareRow[] = [
    currentRow,
    ...payload.targets.map((t) => targetRow(t, "target", onChoosePlan)),
    ...payload.unavailableTargets.map((t) => targetRow(t, "unavailable", onChoosePlan)),
  ];

  // Downgrades render ONLY for the ambient trigger: a downgrade
  // cannot resolve being at the limit, so interruptive surfaces
  // never show them (the server never sends them there either).
  const showDowngrades = payload.trigger === "ambient" && payload.downgradeTargets.length > 0;
  const downgradeRows = payload.downgradeTargets.map((t) => targetRow(t, "downgrade", onChoosePlan));
  const anyBillingManagedDowngrade = payload.downgradeTargets.some(
    (t) => !t.buyable && t.unavailableReason === "billing_managed",
  );

  const { referral, freeAccess } = payload.mentions;

  return (
    <div role="status">
      <h3>Compare plans</h3>
      <p>
        Credits: {formatUSD(current.creditsUSD)} · Included runs remaining: {current.includedRunsRemaining}
        {current.packRunsRemaining > 0 && <> · Pack runs remaining: {current.packRunsRemaining}</>}
      </p>
      {referral && (
        <p>
          You have {formatUSD(referral.redeemableUSD)} in referral credit (
          {formatUSD(referral.totalEarnedUSD)} earned in total). Referrals earn{" "}
          {formatUSD(referral.earnAmountUSD)} per referred user.
          {referral.attributedReferrer && <> Referred by {referral.attributedReferrer}.</>}{" "}
          <a href="?tab=billing">See your referral balance in Billing.</a>
        </p>
      )}
      {freeAccess && (
        <p>
          {freeAccess.kind === "lifetime"
            ? "You have free lifetime access."
            : freeAccess.expiresAtMs !== null
              ? `You have free access until ${formatPeriodEnd(freeAccess.expiresAtMs)}.`
              : "You have free access for a limited time."}
        </p>
      )}
      <Table
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.key}
        caption="Plan comparison"
        rowProps={(row) => (row.disabled ? { "aria-disabled": true } : {})}
      />
      {held && <p>{STACKING_DISCLOSURE}</p>}
      {showDowngrades && (
        <>
          <h4>Lower plans</h4>
          <p>{DOWNGRADE_DISCLOSURE}</p>
          {anyBillingManagedDowngrade && <p>{BILLING_MANAGED_COPY}</p>}
          <Table
            columns={COLUMNS}
            rows={downgradeRows}
            rowKey={(row) => row.key}
            caption="Lower plans"
            rowProps={(row) => (row.disabled ? { "aria-disabled": true } : {})}
          />
        </>
      )}
      {payload.perRun && (
        <p>
          Or pay per run: {formatUSD(payload.perRun.priceUSD)} per {payload.perRun.family} run at the current
          approved price.
        </p>
      )}
      {payload.topUp && onBuyCredits && <Button onClick={onBuyCredits}>Buy credits</Button>}
    </div>
  );
}

export interface AmbientOfferCompareProps {
  family?: ScreenerFamily;
  /**
   * Fired with the chosen plan and the instant the offer payload
   * arrived (shownAtMs for the acceptance audit). The surface owns
   * the purchase flow.
   */
  onChoosePlan?: (choice: PlanChoice, shownAtMs: number) => void;
  onBuyCredits?: () => void;
}

/**
 * The ambient compare surface: fetches GET /offer/compare and
 * renders PlanCompare. Any fetch failure, malformed payload, or
 * ineligible response renders NOTHING — the hosting surface works
 * without the compare, and the compare must never degrade it.
 */
export function AmbientOfferCompare({ family, onChoosePlan, onBuyCredits }: AmbientOfferCompareProps) {
  const [payload, setPayload] = useState<OfferPayloadView | null>(null);
  const [shownAtMs, setShownAtMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getOfferCompare(family);
        if (cancelled) return;
        if (isOfferPayloadView(res) && res.eligible) {
          setPayload(res);
          setShownAtMs(Date.now());
        }
      } catch {
        // The compare is additive: a failed fetch leaves the host
        // surface exactly as it was. No error state is rendered.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [family]);

  if (!payload || shownAtMs === null) return null;
  return (
    <PlanCompare
      payload={payload}
      onChoosePlan={onChoosePlan ? (choice) => onChoosePlan(choice, shownAtMs) : undefined}
      onBuyCredits={onBuyCredits}
    />
  );
}
