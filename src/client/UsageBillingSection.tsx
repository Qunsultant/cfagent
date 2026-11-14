/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing
 * reader section in the Billing servicing surface.
 *
 * One section rendering the new GET /payments/agentic/commercial/
 * usage-billing view: usage (metered calls with per-row provenance,
 * included-run balance, credit balance) AND billing (subscriptions
 * with periods, renewals, refunds with per-row provenance, referral
 * balance) together. The server is the authority on every value;
 * this section renders server truth verbatim and never totals money
 * across mixed provenance. Simulated rows render as "Simulated",
 * never as "Real". Failures render the coded catalog message
 * verbatim ([CODE] businessMessage, the #2573 pattern); server error
 * bodies are never rendered. ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { apiFetch } from "./apiFetch";
import { commercialPath } from "../data/commercialUrlCatalog";
import {
  fetchUsageBilling,
  UsageBillingApiError,
  type UsageBillingView,
} from "./usageBillingApi";
import type {
  UsageBillingProvenance,
  UsageBillingRefundRow,
  UsageBillingSubscriptionRow,
} from "../data/usageBilling";

function usd(amountUSD: number): string {
  return `$${amountUSD.toFixed(2)} USD`;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function provenanceLabel(provenance: UsageBillingProvenance): string {
  if (provenance === "real") return "Real";
  if (provenance === "simulated") return "Simulated";
  return "Audit";
}

function errorMessage(error: unknown): string {
  if (error instanceof UsageBillingApiError) return error.message;
  return "Your usage and billing could not be loaded. Try again later.";
}

interface FreeAccessGrantLineView {
  kind: "lifetime" | "limited";
  expiresAtMs: number | null;
}

function isFreeAccessGrantLineView(value: unknown): value is FreeAccessGrantLineView {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    (grant.kind === "lifetime" || grant.kind === "limited") &&
    (grant.expiresAtMs === null || typeof grant.expiresAtMs === "number")
  );
}

/**
 * Free-access line (issue #3247 §4.2): the caller's own active
 * grant, read through the own-or-operator GET route. Renders only
 * when a grant exists; a null grant or a failed read renders
 * nothing, so ungranted users see no change. Access only — the
 * line links nowhere and offers no action.
 */
function FreeAccessLine({ userLogin }: { userLogin: string }) {
  const [grant, setGrant] = useState<FreeAccessGrantLineView | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(
          `${commercialPath("freeAccess")}?userId=${encodeURIComponent(userLogin)}`,
        );
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!cancelled && isFreeAccessGrantLineView(data.active)) {
          setGrant(data.active);
        }
      } catch {
        // A failed read renders nothing — the billing section loads on.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userLogin]);
  if (!grant) return null;
  if (grant.kind === "lifetime") return <p>Free access: lifetime.</p>;
  if (grant.expiresAtMs === null) return null;
  return <p>Free access until {day(grant.expiresAtMs)}.</p>;
}

export function UsageBillingSection() {
  const [view, setView] = useState<UsageBillingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchUsageBilling();
      setView(next);
    } catch (err) {
      setView(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // The current subscription is the latest-period row; it is also in
  // the subscriptions list, so render it once (prepended when absent
  // from the list) rather than twice.
  const subscriptions: UsageBillingSubscriptionRow[] = view
    ? view.billing.current &&
      !view.billing.subscriptions.some((row) => row.id === view.billing.current!.id)
      ? [view.billing.current, ...view.billing.subscriptions]
      : view.billing.subscriptions
    : [];
  const refunds: UsageBillingRefundRow[] = view ? view.billing.refunds : [];

  return (
    <Card>
      <h3>Usage and billing</h3>
      {loading && !view && !error && <p>Loading your usage and billing…</p>}
      {error && (
        <>
          <Notice>{error}</Notice>
          <Button onClick={load}>Retry</Button>
        </>
      )}
      {view && (
        <>
          <h4>Usage</h4>
          <p>Included runs remaining: {view.identity.includedRunsRemaining}</p>
          <p>Credit balance: {usd(view.identity.creditsUSD)}</p>
          {view.usage.receipts.length === 0 && <p>No usage recorded yet.</p>}
          {view.usage.receipts.map((entry) => (
            <p key={entry.id}>
              {entry.receiptId ?? entry.id} —{" "}
              {entry.amountUSD !== null ? usd(entry.amountUSD) : "—"} —{" "}
              {provenanceLabel(entry.provenance)}
            </p>
          ))}
          <h4>Billing</h4>
          {subscriptions.length === 0 && <p>No subscriptions on file.</p>}
          {subscriptions.map((row) => (
            <p key={row.id}>
              {row.planId} — {day(row.periodStartMs)} to {day(row.periodEndMs)} — {row.status} —{" "}
              {provenanceLabel(row.provenance)}
            </p>
          ))}
          <h4>Renewals</h4>
          {view.billing.renewals.length === 0 && <p>No renewals scheduled.</p>}
          {view.billing.renewals.map((row) => (
            <p key={row.subscriptionId}>
              {row.planId} — renews {day(row.renewsAtMs)} — {row.status}
            </p>
          ))}
          <h4>Refunds</h4>
          {refunds.length === 0 && <p>No refunds on file.</p>}
          {refunds.map((row) => (
            <p key={row.id}>
              {row.id} — {row.kind} — {row.status} — {usd(row.amountUSD)} —{" "}
              {provenanceLabel(row.provenance)}
            </p>
          ))}
          <p>Redeemable: {usd(view.billing.referral.redeemableUSD)}</p>
          <p>Total earned: {usd(view.billing.referral.totalEarnedUSD)}</p>
          <FreeAccessLine userLogin={view.userLogin} />
          <Button onClick={load}>Refresh</Button>
        </>
      )}
    </Card>
  );
}
