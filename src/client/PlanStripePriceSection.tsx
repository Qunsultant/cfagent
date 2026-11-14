/**
 * Issue #4511 — plan Stripe Price mapping editor in the Billing
 * servicing surface.
 *
 * This section CALLS existing routes only and creates none: GET
 * billing-policy (operator-only) for the stripePriceByPlan block +
 * seed note, POST billing-policy (operator-only) for edits (the whole
 * stripePriceByPlan block is replaced on update, the same wholesale
 * discipline as offerRules), GET plans for the plan list, and GET
 * operators (operator-only) to learn whether the viewer is an
 * operator. The server routes remain the access control — a
 * non-operator sees a fixed note with no values and no edit controls,
 * because the operators read refused them; nothing here enforces
 * anything the server does not. There is no non-operator read source
 * for the mapping (pricing does not carry it), so the non-operator
 * view shows no values at all.
 *
 * The checkout reads stripePriceByPlan[plan.id] only — the version's
 * own stripePriceId field is never read by the checkout, and approving
 * a version does not sync it into the policy. This UI is the only
 * operator path to set the mapping. After every save the section
 * re-reads the policy and renders ONLY the fresh read, never the POST
 * answer and never an optimistic assertion. Failures render as fixed
 * strings keyed by HTTP status; server error bodies are never
 * rendered. Clearing a plan's price id removes its mapping on save.
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { listPlans, type PlanView } from "./commercialApi";
import { listOperators } from "./refundPolicyApi";
import {
  getStripePriceByPlan,
  setStripePriceByPlan,
  BillingPolicyApiError,
} from "./billingPolicyApi";

function statusOf(error: unknown): number {
  return error instanceof BillingPolicyApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The plan Stripe Price mappings are not configured yet.";
  return "The plan Stripe Price mappings could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400)
    return "The Stripe Price mapping is invalid: each mapping must be a non-empty Stripe Price id.";
  if (status === 403) return "Only a store operator can change plan Stripe Price mappings.";
  if (status === 503) return "The billing service is temporarily unavailable. Try again later.";
  return "The plan Stripe Price mappings could not be saved. Try again later.";
}

export function PlanStripePriceSection() {
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [seedNote, setSeedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [policyResult, plansResult, operatorsResult] = await Promise.allSettled([
        getStripePriceByPlan(),
        listPlans(),
        listOperators(),
      ]);
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the fixed note; the server
      // still refuses any action the UI should not offer.
      const operator = operatorsResult.status === "fulfilled";
      setIsOperator(operator);
      if (operator && policyResult.status === "fulfilled" && plansResult.status === "fulfilled") {
        const freshMapping = policyResult.value.stripePriceByPlan;
        setMapping(freshMapping);
        setPlans(plansResult.value.plans);
        setSeedNote(policyResult.value.seedNote);
        const nextDrafts: Record<string, string> = {};
        for (const plan of plansResult.value.plans) {
          nextDrafts[plan.id] = freshMapping[plan.id] ?? "";
        }
        setDrafts(nextDrafts);
      } else if (operator) {
        setMapping(null);
        setPlans(null);
        const failed =
          policyResult.status === "rejected"
            ? policyResult.reason
            : plansResult.status === "rejected"
              ? plansResult.reason
              : null;
        setLoadError(loadMessage(failed ? statusOf(failed) : 0));
      } else {
        // Non-operator: no values, no edit controls. The policy
        // read refusal is expected, not an error to surface.
        setMapping(null);
        setPlans(null);
      }
    } catch {
      setMapping(null);
      setPlans(null);
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
    if (!plans) return;
    // Wholesale replacement: the POST carries the whole mapping.
    // A blank input removes that plan's mapping; every other plan's
    // current value rides along so an unrelated mapping is never
    // wiped by an edit to one plan.
    const next: Record<string, string> = {};
    for (const plan of plans) {
      const value = (drafts[plan.id] ?? "").trim();
      if (value) next[plan.id] = value;
    }
    setSaving(true);
    setActionError(null);
    try {
      await setStripePriceByPlan(next);
      const fresh = await getStripePriceByPlan();
      const freshPlans = await listPlans();
      setMapping(fresh.stripePriceByPlan);
      setPlans(freshPlans.plans);
      setSeedNote(fresh.seedNote);
      const nextDrafts: Record<string, string> = {};
      for (const plan of freshPlans.plans) {
        nextDrafts[plan.id] = fresh.stripePriceByPlan[plan.id] ?? "";
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [plans, drafts]);

  return (
    <Card>
      <p>Plan Stripe Price mappings</p>
      {loading && <p>Loading plan Stripe Price mappings</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && !isOperator && (
        <p>Only a store operator can view or change plan Stripe Price mappings.</p>
      )}
      {!loading && !loadError && isOperator && mapping && plans && (
        <>
          {seedNote && <p>{seedNote}</p>}
          <p>
            The subscription checkout reads the Stripe Price id from this mapping only — a plan
            without a mapping refuses checkout. Set the test-mode Stripe Price id for each plan;
            clearing a price id removes that plan&apos;s mapping.
          </p>
          {plans.length === 0 && <p>No plans yet. Create a plan first.</p>}
          {plans.map((plan) => (
            <div key={plan.id}>
              <p>
                {plan.name} — ${plan.priceUSD.toFixed(2)} / {plan.periodDays} days
              </p>
              <p>
                {mapping[plan.id]
                  ? `Mapped Stripe Price id: ${mapping[plan.id]}`
                  : "Not mapped"}
              </p>
              <TextInput
                label={`Stripe Price id for ${plan.name}`}
                value={drafts[plan.id] ?? ""}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [plan.id]: e.target.value }))
                }
                placeholder="price_…"
              />
            </div>
          ))}
          <Button variant="secondary" loading={saving} onClick={save}>
            Save plan Stripe Price mappings
          </Button>
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>
            Changing a mapping never affects a subscription already bought; the next checkout
            reads the stored mapping.
          </p>
        </>
      )}
    </Card>
  );
}
