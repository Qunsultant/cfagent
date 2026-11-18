/**
 * Issue #5229 (monetization Phase 2.31, program #2405) — referral
 * credit rules management UI on the Billing overview.
 *
 * This section CALLS the referral-rules route only and creates none:
 * GET /referral/rules (any verified login) for values; POST
 * /referral/rules (operator-only) to replace the rule row; GET
 * operators (operator-only) to learn whether the viewer is an
 * operator. The server routes remain the access control — a
 * non-operator sees values read-only, with no action buttons,
 * because the operators read refused them; nothing here enforces
 * anything the server does not.
 *
 * After every save the section re-reads the rules and renders ONLY
 * the fresh read, never the POST answer and never an optimistic
 * assertion. Failures render as fixed strings keyed by HTTP status;
 * server error bodies are never rendered. Values are entered in
 * days in the UI and stored as milliseconds on the server (whole
 * days are exact; fractional days are allowed). Expiry 0 means the
 * credit never expires — an explicit operator choice.
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { listOperators } from "./refundPolicyApi";
import {
  getReferralRules,
  setReferralRules,
  ReferralRulesApiError,
  type ReferralRulesView,
} from "./referralRulesApi";

const DAY_MS = 86400000;

function statusOf(error: unknown): number {
  return error instanceof ReferralRulesApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The referral rules are not configured yet.";
  return "The referral rules could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400) return "The referral rules were not saved: check the values and try again.";
  if (status === 403) return "Only a store operator can change referral rules.";
  if (status === 503) return "The referral service is temporarily unavailable. Try again later.";
  return "The referral rules could not be saved. Try again later.";
}

function msToDays(ms: number): string {
  return String(ms / DAY_MS);
}

function daysToMs(days: string): number | null {
  const value = Number(days);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * DAY_MS);
}

export function ReferralCreditRulesSection() {
  const [rules, setRules] = useState<ReferralRulesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [earn, setEarn] = useState("");
  const [vestingDays, setVestingDays] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [rulesResult, operatorsResult] = await Promise.allSettled([
        getReferralRules(),
        listOperators(),
      ]);
      if (rulesResult.status === "fulfilled") {
        const fresh = rulesResult.value;
        setRules(fresh);
        setEarn(String(fresh.earnAmountUSD));
        setVestingDays(msToDays(fresh.vestingDelayMs));
        setExpiryDays(msToDays(fresh.expiryPeriodMs));
      } else {
        setRules(null);
        setLoadError(loadMessage(statusOf(rulesResult.reason)));
      }
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the read-only view; the
      // server still refuses any action the UI should not offer.
      setIsOperator(operatorsResult.status === "fulfilled");
    } catch {
      setRules(null);
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
    setActionError(null);
    setSavedNote("");
    const earnAmountUSD = Number(earn);
    const vestingDelayMs = daysToMs(vestingDays);
    const expiryPeriodMs = daysToMs(expiryDays);
    if (!Number.isFinite(earnAmountUSD) || earnAmountUSD <= 0) {
      setActionError("Earn amount must be a positive number of US dollars.");
      return;
    }
    if (vestingDelayMs === null || expiryPeriodMs === null) {
      setActionError("Vesting and expiry must be zero or more days.");
      return;
    }
    if (!rules) return;
    setSaving(true);
    try {
      await setReferralRules({
        earnAmountUSD,
        vestingDelayMs,
        redemptionScope: rules.redemptionScope,
        expiryPeriodMs,
      });
      const fresh = await getReferralRules();
      setRules(fresh);
      setEarn(String(fresh.earnAmountUSD));
      setVestingDays(msToDays(fresh.vestingDelayMs));
      setExpiryDays(msToDays(fresh.expiryPeriodMs));
      setSavedNote("Referral rules saved.");
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [earn, vestingDays, expiryDays, rules]);

  if (loading) {
    return (
      <Card>
        <p>Referral credit rules</p>
        <p>Loading…</p>
      </Card>
    );
  }
  if (loadError || !rules) {
    return (
      <Card>
        <p>Referral credit rules</p>
        <Notice tone="warning">{loadError ?? "The referral rules could not be loaded."}</Notice>
      </Card>
    );
  }

  return (
    <Card>
      <p>Referral credit rules</p>
      <p>Earn per referred first paid run: ${rules.earnAmountUSD.toFixed(2)} USD</p>
      <p>Redemption scope: {rules.redemptionScope}</p>
      <p>
        Credits expire {rules.expiryPeriodMs === 0 ? "never" : `${msToDays(rules.expiryPeriodMs)} days after they are earned`}.
      </p>
      {!isOperator && <p>Only a store operator can change referral rules.</p>}
      {isOperator && (
        <>
          <TextInput
            label="Earn amount (USD)"
            hint="Credit earned per referred user's first paid run."
            value={earn}
            onChange={(e) => setEarn(e.target.value)}
            inputMode="decimal"
          />
          <TextInput
            label="Vesting delay (days)"
            hint="Days between earning and redemption eligibility."
            value={vestingDays}
            onChange={(e) => setVestingDays(e.target.value)}
            inputMode="decimal"
          />
          <TextInput
            label="Expiry period (days)"
            hint="Days from earn until the credit expires. 0 means the credit never expires."
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            inputMode="decimal"
          />
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save referral rules"}
          </Button>
        </>
      )}
      {savedNote && <Notice tone="success">{savedNote}</Notice>}
      {actionError && <Notice tone="danger">{actionError}</Notice>}
    </Card>
  );
}
