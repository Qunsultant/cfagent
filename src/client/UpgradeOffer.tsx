/**
 * Issue #3246 (sub-issue of #3241), slice 2 — the interruptive
 * upgrade-offer surface: the at-limit message plus the
 * server-computed plan comparison, with a dismiss affordance.
 *
 * Behavior (design §5.2/§5.4):
 * - The fixed fallback message renders IMMEDIATELY (it is the
 *   error state, role="alert"); the offer section renders below
 *   it with a neutral loading line while the fetch is in flight.
 * - On an eligible payload the comparison renders; on any fetch
 *   failure, malformed payload, or ineligible response the fixed
 *   string stands alone — never a blank section, never an eternal
 *   spinner, never a bare error.
 * - "Not now" POSTs the dismiss route with the trigger and the
 *   family and collapses to the fixed copy on success. Dismissal
 *   state lives ONLY on the server: this component writes nothing
 *   to localStorage, sessionStorage, or any client store.
 * - Choosing a plan or buying credits navigates to the checkout
 *   surface with the target preselected and the offer trigger
 *   carried as query params (`?plan=<versionId>&offer=<trigger>`,
 *   `?checkoutTab=topup&offer=<trigger>`); the checkout surface
 *   owns the purchase and the acceptance audit. The navigation is
 *   injectable for tests; the default is a plain location assign.
 *
 * ui primitives only, token-only styling. No issue references in
 * rendered text.
 */
import React, { useEffect, useRef, useState } from "react";
import { Button, Notice } from "./components/ui";
import {
  isOfferPayloadView,
  postOffer,
  postOfferDismiss,
  type OfferPayloadView,
  type OfferTrigger,
  type ScreenerFamily,
} from "./commercialApi";
import { PlanCompare, type PlanChoice } from "./PlanCompare";

export interface UpgradeOfferProps {
  trigger: Exclude<OfferTrigger, "ambient" | "skip_notice" | "trial_end">;
  family: ScreenerFamily;
  runRequestId?: string;
  /** The fixed fallback message (the mapScreenError string): shown always, and alone on any offer failure. */
  fallback: string;
  /** Navigation override for tests. Defaults to a plain location assign. */
  navigate?: (href: string) => void;
}

const LOADING_LINE = "Loading upgrade options…";
const DISMISS_RETRY_NOTE = "Your choice could not be saved. The offer is still shown — try again, or ignore it.";

export function UpgradeOffer({ trigger, family, runRequestId, fallback, navigate }: UpgradeOfferProps) {
  const [payload, setPayload] = useState<OfferPayloadView | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [dismissFailed, setDismissFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await postOffer({ trigger, family, runRequestId });
        if (cancelled) return;
        // A malformed payload degrades exactly like a failed fetch:
        // the fixed copy stands alone.
        if (isOfferPayloadView(res) && res.eligible) setPayload(res);
      } catch {
        // Fixed copy only. No error state, no retry loop.
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trigger, family, runRequestId]);

  const go = (href: string) => {
    if (navigate) navigate(href);
    else window.location.assign(href);
  };

  const onChoosePlan = (choice: PlanChoice) => {
    const params = new URLSearchParams({
      tab: "checkout",
      checkoutTab: "subscriptions",
      plan: choice.versionId,
      offer: trigger,
    });
    go(`?${params.toString()}`);
  };

  const onBuyCredits = () => {
    const params = new URLSearchParams({ tab: "checkout", checkoutTab: "topup", offer: trigger });
    go(`?${params.toString()}`);
  };

  const onDismiss = async () => {
    setDismissFailed(false);
    try {
      await postOfferDismiss({ trigger, family });
      if (mounted.current) setDismissed(true);
    } catch {
      if (mounted.current) setDismissFailed(true);
    }
  };

  return (
    <div>
      <Notice tone="danger">{fallback}</Notice>
      {!dismissed && loading && <p role="status">{LOADING_LINE}</p>}
      {!dismissed && !loading && payload && (
        <div role="status">
          <PlanCompare payload={payload} onChoosePlan={onChoosePlan} onBuyCredits={onBuyCredits} />
          <Button variant="secondary" onClick={onDismiss}>
            Not now
          </Button>
          {dismissFailed && <p>{DISMISS_RETRY_NOTE}</p>}
        </div>
      )}
    </div>
  );
}
