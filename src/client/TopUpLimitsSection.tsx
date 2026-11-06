/**
 * Issue #3262 — top-up limits editor in the Billing servicing surface.
 *
 * This section CALLS existing routes only and creates none: GET
 * billing-policy (operator-only) for the limits + seed note, POST
 * billing-policy (operator-only) for min/max edits, GET operators
 * (operator-only) to learn whether the viewer is an operator, and
 * GET pricing (any verified login) so non-operators still see the
 * current limits. The server routes remain the access control — a
 * non-operator sees limits read-only, with no edit controls,
 * because the operators read refused them; nothing here enforces
 * anything the server does not.
 *
 * After every save the section re-reads the policy and renders ONLY
 * the fresh read, never the POST answer and never an optimistic
 * assertion. Failures render as fixed strings keyed by HTTP status;
 * server error bodies are never rendered. The limits are PROPOSED
 * seeds ($1–$500, owner-decided 2026-11-06) until an operator edits
 * them; the section never invents a value. ui primitives only,
 * token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { getPricing, formatUSD } from "./commercialApi";
import { listOperators } from "./refundPolicyApi";
import {
  getBillingPolicy,
  setTopUpLimits,
  BillingPolicyApiError,
  type TopUpLimitsView,
} from "./billingPolicyApi";

function statusOf(error: unknown): number {
  return error instanceof BillingPolicyApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The top-up limits are not configured yet.";
  return "The top-up limits could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400) return "The limits are invalid: the minimum must be a positive amount no greater than the maximum.";
  if (status === 403) return "Only a store operator can change top-up limits.";
  if (status === 503) return "The billing service is temporarily unavailable. Try again later.";
  return "The limits could not be saved. Try again later.";
}

export function TopUpLimitsSection() {
  const [limits, setLimits] = useState<TopUpLimitsView | null>(null);
  const [seedNote, setSeedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [policyResult, operatorsResult, pricingResult] = await Promise.allSettled([
        getBillingPolicy(),
        listOperators(),
        getPricing(),
      ]);
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the read-only view; the
      // server still refuses any action the UI should not offer.
      const operator = operatorsResult.status === "fulfilled";
      setIsOperator(operator);
      if (operator && policyResult.status === "fulfilled") {
        setLimits(policyResult.value.limits);
        setSeedNote(policyResult.value.seedNote);
        setMinInput(String(policyResult.value.limits.topUpMinUSD));
        setMaxInput(String(policyResult.value.limits.topUpMaxUSD));
      } else if (
        pricingResult.status === "fulfilled" &&
        pricingResult.value.topUpLimits !== null
      ) {
        // Non-operators read the limits from pricing (any verified
        // login); the operator-only policy read refused them. The
        // pricing shape carries minUSD/maxUSD; map it onto the
        // limits view (topUpMinUSD/topUpMaxUSD).
        const shown = pricingResult.value.topUpLimits;
        setLimits({ topUpMinUSD: shown.minUSD, topUpMaxUSD: shown.maxUSD });
        setSeedNote("");
        setMinInput(String(shown.minUSD));
        setMaxInput(String(shown.maxUSD));
      } else if (policyResult.status === "rejected") {
        setLimits(null);
        setLoadError(loadMessage(statusOf(policyResult.reason)));
      } else {
        setLimits(null);
        setLoadError("The top-up limits are currently unavailable.");
      }
    } catch {
      setLimits(null);
      setLoadError(loadMessage(0));
      setIsOperator(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError(loadMessage(0));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const save = useCallback(async () => {
    const min = Number(minInput);
    const max = Number(maxInput);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max) {
      setActionError("The limits are invalid: the minimum must be a positive amount no greater than the maximum.");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await setTopUpLimits(min, max);
      const fresh = await getBillingPolicy();
      setLimits(fresh.limits);
      setSeedNote(fresh.seedNote);
      setMinInput(String(fresh.limits.topUpMinUSD));
      setMaxInput(String(fresh.limits.topUpMaxUSD));
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [minInput, maxInput]);

  return (
    <Card>
      <p>Top-up limits</p>
      {loading && <p>Loading top-up limits</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && limits && (
        <>
          <p>
            Current limits: {formatUSD(limits.topUpMinUSD)} – {formatUSD(limits.topUpMaxUSD)} per top-up.
          </p>
          {seedNote && <p>{seedNote}</p>}
          {!isOperator && <p>Only a store operator can change top-up limits.</p>}
          {isOperator && (
            <>
              <TextInput
                label="Minimum top-up (USD)"
                type="number"
                value={minInput}
                onChange={(e) => setMinInput(e.target.value)}
              />
              <TextInput
                label="Maximum top-up (USD)"
                type="number"
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
              />
              <Button variant="secondary" loading={saving} onClick={save}>
                Save top-up limits
              </Button>
            </>
          )}
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>Changing the limits never affects a top-up already minted; mint validates against the stored limits.</p>
        </>
      )}
    </Card>
  );
}
