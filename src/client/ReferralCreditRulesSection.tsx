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
 * Issue #6141 extends the same row with the trial-extension values
 * (extension days, referred trial days, caps, trial plan, share
 * message) — same route, same save, same re-read discipline.
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { Select } from "./components/ui/Select";
import { TextInput } from "./components/ui/TextInput";
import { listOperators } from "./refundPolicyApi";
import { listPlans, type PlanView } from "./commercialApi";
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
  // Issue #6141: trial-extension rule values (whole days / counts;
  // the plan select is "" for "None — disabled").
  const [extensionDays, setExtensionDays] = useState("");
  const [referredTrialDays, setReferredTrialDays] = useState("");
  const [maxExtensionsPerDay, setMaxExtensionsPerDay] = useState("");
  const [maxExtensionsPerMonth, setMaxExtensionsPerMonth] = useState("");
  const [referralTrialPlanId, setReferralTrialPlanId] = useState("");
  const [shareMessageTemplate, setShareMessageTemplate] = useState("");
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [rulesResult, operatorsResult, plansResult] = await Promise.allSettled([
        getReferralRules(),
        listOperators(),
        listPlans(),
      ]);
      if (rulesResult.status === "fulfilled") {
        const fresh = rulesResult.value;
        setRules(fresh);
        setEarn(String(fresh.earnAmountUSD));
        setVestingDays(msToDays(fresh.vestingDelayMs));
        setExpiryDays(msToDays(fresh.expiryPeriodMs));
        setExtensionDays(String(fresh.extensionDays));
        setReferredTrialDays(String(fresh.referredTrialDays));
        setMaxExtensionsPerDay(String(fresh.maxExtensionsPerDay));
        setMaxExtensionsPerMonth(String(fresh.maxExtensionsPerMonth));
        setReferralTrialPlanId(fresh.referralTrialPlanId ?? "");
        setShareMessageTemplate(fresh.shareMessageTemplate);
      } else {
        setRules(null);
        setLoadError(loadMessage(statusOf(rulesResult.reason)));
      }
      // #6141: the plan list feeds the referred-trial plan select.
      // A failed plans read leaves the select with "None — disabled"
      // only; the rules still load and save.
      setPlans(plansResult.status === "fulfilled" ? plansResult.value.plans : []);
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
    // #6141: extension values are whole numbers, 1 or more; the
    // share template must be non-empty and contain {link}.
    const parsedExtensionDays = Number(extensionDays);
    const parsedReferredTrialDays = Number(referredTrialDays);
    const parsedMaxPerDay = Number(maxExtensionsPerDay);
    const parsedMaxPerMonth = Number(maxExtensionsPerMonth);
    if (
      !Number.isInteger(parsedExtensionDays) || parsedExtensionDays < 1 ||
      !Number.isInteger(parsedReferredTrialDays) || parsedReferredTrialDays < 1 ||
      !Number.isInteger(parsedMaxPerDay) || parsedMaxPerDay < 1 ||
      !Number.isInteger(parsedMaxPerMonth) || parsedMaxPerMonth < 1
    ) {
      setActionError("Extension days, referred trial days, and both caps must be whole numbers of 1 or more.");
      return;
    }
    if (!shareMessageTemplate.trim() || !shareMessageTemplate.includes("{link}")) {
      setActionError("The share message must not be empty and must contain {link}.");
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
        extensionDays: parsedExtensionDays,
        referredTrialDays: parsedReferredTrialDays,
        maxExtensionsPerDay: parsedMaxPerDay,
        maxExtensionsPerMonth: parsedMaxPerMonth,
        referralTrialPlanId: referralTrialPlanId === "" ? null : referralTrialPlanId,
        shareMessageTemplate,
      });
      const fresh = await getReferralRules();
      setRules(fresh);
      setEarn(String(fresh.earnAmountUSD));
      setVestingDays(msToDays(fresh.vestingDelayMs));
      setExpiryDays(msToDays(fresh.expiryPeriodMs));
      setExtensionDays(String(fresh.extensionDays));
      setReferredTrialDays(String(fresh.referredTrialDays));
      setMaxExtensionsPerDay(String(fresh.maxExtensionsPerDay));
      setMaxExtensionsPerMonth(String(fresh.maxExtensionsPerMonth));
      setReferralTrialPlanId(fresh.referralTrialPlanId ?? "");
      setShareMessageTemplate(fresh.shareMessageTemplate);
      setSavedNote("Referral rules saved.");
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [earn, vestingDays, expiryDays, extensionDays, referredTrialDays, maxExtensionsPerDay, maxExtensionsPerMonth, referralTrialPlanId, shareMessageTemplate, rules]);

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
      <p>
        Trial extension: {rules.extensionDays} days per referred first paid run; referred users get a {rules.referredTrialDays}-day trial
        {rules.referralTrialPlanId ? ` (${rules.referralTrialPlanId})` : " (no trial plan selected — referred trials are disabled)"}.
        Caps: {rules.maxExtensionsPerDay} per day, {rules.maxExtensionsPerMonth} per month.
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
          <TextInput
            label="Trial extension (days per referral)"
            hint="Trial days the referrer earns per referred user's first paid run."
            value={extensionDays}
            onChange={(e) => setExtensionDays(e.target.value)}
            inputMode="numeric"
          />
          <TextInput
            label="Referred trial (days)"
            hint="Trial days a referred user gets on signup via the link."
            value={referredTrialDays}
            onChange={(e) => setReferredTrialDays(e.target.value)}
            inputMode="numeric"
          />
          <TextInput
            label="Max extensions per day"
            hint="Most trial-extension grants per referrer per day."
            value={maxExtensionsPerDay}
            onChange={(e) => setMaxExtensionsPerDay(e.target.value)}
            inputMode="numeric"
          />
          <TextInput
            label="Max extensions per month"
            hint="Most trial-extension grants per referrer per calendar month."
            value={maxExtensionsPerMonth}
            onChange={(e) => setMaxExtensionsPerMonth(e.target.value)}
            inputMode="numeric"
          />
          <Select
            label="Referred trial plan"
            hint="Plan whose trial a referred user gets on signup. None disables referred trials."
            value={referralTrialPlanId}
            onChange={(e) => setReferralTrialPlanId(e.target.value)}
          >
            <option value="">None — disabled</option>
            {plans
              .filter((p) => p.trialDays !== null && p.trialDays !== undefined)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.trialDays} days)
                </option>
              ))}
          </Select>
          <TextInput
            label="Share message"
            hint="Message shown with the referral link. Must contain {link}; {trialDays} is replaced with the referred trial days."
            value={shareMessageTemplate}
            onChange={(e) => setShareMessageTemplate(e.target.value)}
          />
          <Button onClick={save} loading={saving}>
            Save referral rules
          </Button>
        </>
      )}
      {savedNote && <Notice tone="success">{savedNote}</Notice>}
      {actionError && <Notice tone="danger">{actionError}</Notice>}
    </Card>
  );
}
