/**
 * Issue #3246 (sub-issue of #3241), slice 2 — upgrade-offer rules
 * editor in the Billing servicing surface.
 *
 * This section CALLS existing routes only and creates none: GET
 * billing-policy (operator-only) for the rules + seed note, POST
 * billing-policy (operator-only) for edits (the whole offer-rules
 * block is replaced on update), and GET operators (operator-only)
 * to learn whether the viewer is an operator. The server routes
 * remain the access control — a non-operator sees a fixed note
 * with no values and no edit controls, because the operators read
 * refused them; nothing here enforces anything the server does
 * not. Unlike the top-up limits, there is no non-operator read
 * source for the rules (pricing does not carry them), so the
 * non-operator view shows no values at all.
 *
 * After every save the section re-reads the policy and renders
 * ONLY the fresh read, never the POST answer and never an
 * optimistic assertion. Failures render as fixed strings keyed by
 * HTTP status; server error bodies are never rendered. The rules
 * are the externalized defaults (all switches on, 7-day cooldown)
 * until an operator edits them; the section never invents a value.
 * Rank is NOT a rule — it lives on the product row and is edited
 * in the Products section. ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Checkbox } from "./components/ui/Checkbox";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { listOperators } from "./refundPolicyApi";
import {
  getOfferRules,
  setOfferRules,
  BillingPolicyApiError,
  type OfferRulesView,
} from "./billingPolicyApi";

function statusOf(error: unknown): number {
  return error instanceof BillingPolicyApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The upgrade-offer rules are not configured yet.";
  return "The upgrade-offer rules could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400) return "The offer rules are invalid. Check the cooldown days and try again.";
  if (status === 403) return "Only a store operator can change upgrade-offer rules.";
  if (status === 503) return "The billing service is temporarily unavailable. Try again later.";
  return "The offer rules could not be saved. Try again later.";
}

const COOLDOWN_INVALID =
  "The dismissal cooldown must be a whole number of days from 1 to 365.";

export function OfferRulesSection() {
  const [rules, setRules] = useState<OfferRulesView | null>(null);
  const [seedNote, setSeedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [draft, setDraft] = useState<OfferRulesView | null>(null);
  const [cooldownInput, setCooldownInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [policyResult, operatorsResult] = await Promise.allSettled([
        getOfferRules(),
        listOperators(),
      ]);
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the fixed note; the server
      // still refuses any action the UI should not offer.
      const operator = operatorsResult.status === "fulfilled";
      setIsOperator(operator);
      if (operator && policyResult.status === "fulfilled") {
        setRules(policyResult.value.offerRules);
        setDraft(policyResult.value.offerRules);
        setSeedNote(policyResult.value.seedNote);
        setCooldownInput(String(policyResult.value.offerRules.dismissCooldownDays));
      } else if (operator) {
        setRules(null);
        setDraft(null);
        setLoadError(
          loadMessage(policyResult.status === "rejected" ? statusOf(policyResult.reason) : 0),
        );
      } else {
        // Non-operator: no values, no edit controls. The policy
        // read refusal is expected, not an error to surface.
        setRules(null);
        setDraft(null);
      }
    } catch {
      setRules(null);
      setDraft(null);
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
    if (!draft) return;
    const cooldown = Number(cooldownInput);
    if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 365) {
      setActionError(COOLDOWN_INVALID);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await setOfferRules({ ...draft, dismissCooldownDays: cooldown });
      const fresh = await getOfferRules();
      setRules(fresh.offerRules);
      setDraft(fresh.offerRules);
      setSeedNote(fresh.seedNote);
      setCooldownInput(String(fresh.offerRules.dismissCooldownDays));
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [draft, cooldownInput]);

  const toggle = useCallback(
    (patch: Partial<OfferRulesView>) => {
      setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    },
    [],
  );

  return (
    <Card>
      <p>Upgrade-offer rules</p>
      {loading && <p>Loading upgrade-offer rules</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && !isOperator && (
        <p>Only a store operator can view or change upgrade-offer rules.</p>
      )}
      {!loading && !loadError && isOperator && rules && draft && (
        <>
          {seedNote && <p>{seedNote}</p>}
          <Checkbox
            label="Upgrade offers enabled"
            checked={draft.enabled}
            onChange={(e) => toggle({ enabled: e.target.checked })}
          />
          <Checkbox
            label="Offer after a payment-required screen error"
            checked={draft.triggersEnabled.manual402}
            onChange={(e) =>
              toggle({ triggersEnabled: { ...draft.triggersEnabled, manual402: e.target.checked } })
            }
          />
          <Checkbox
            label="Offer on a skipped scheduled run notice"
            checked={draft.triggersEnabled.skipNotice}
            onChange={(e) =>
              toggle({ triggersEnabled: { ...draft.triggersEnabled, skipNotice: e.target.checked } })
            }
          />
          <Checkbox
            label="Offer at trial end"
            checked={draft.triggersEnabled.trialEnd}
            onChange={(e) =>
              toggle({ triggersEnabled: { ...draft.triggersEnabled, trialEnd: e.target.checked } })
            }
          />
          <Checkbox
            label="Offer when the approved-free quota is exhausted"
            checked={draft.triggersEnabled.quotaExhausted}
            onChange={(e) =>
              toggle({
                triggersEnabled: { ...draft.triggersEnabled, quotaExhausted: e.target.checked },
              })
            }
          />
          <Checkbox
            label="Offer on the plan comparison surface"
            checked={draft.triggersEnabled.ambient}
            onChange={(e) =>
              toggle({ triggersEnabled: { ...draft.triggersEnabled, ambient: e.target.checked } })
            }
          />
          <TextInput
            label="Dismissal cooldown (days)"
            type="number"
            value={cooldownInput}
            onChange={(e) => setCooldownInput(e.target.value)}
          />
          <Checkbox
            label="Show proposed prices as unavailable"
            checked={draft.showProposed}
            onChange={(e) => toggle({ showProposed: e.target.checked })}
          />
          <Checkbox
            label="Show lower plans on the comparison surface"
            checked={draft.downgradesEnabled}
            onChange={(e) => toggle({ downgradesEnabled: e.target.checked })}
          />
          <Checkbox
            label="Show runs packs on the comparison surface"
            checked={draft.runsPacksEnabled}
            onChange={(e) => toggle({ runsPacksEnabled: e.target.checked })}
          />
          <Checkbox
            label="Show the referral mention"
            checked={draft.mentionsEnabled.referral}
            onChange={(e) =>
              toggle({ mentionsEnabled: { ...draft.mentionsEnabled, referral: e.target.checked } })
            }
          />
          <Checkbox
            label="Show the free-access mention"
            checked={draft.mentionsEnabled.freeAccess}
            onChange={(e) =>
              toggle({ mentionsEnabled: { ...draft.mentionsEnabled, freeAccess: e.target.checked } })
            }
          />
          <Button variant="secondary" loading={saving} onClick={save}>
            Save upgrade-offer rules
          </Button>
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>Changing the rules never affects an offer already shown; the next offer reads the stored rules.</p>
        </>
      )}
    </Card>
  );
}
