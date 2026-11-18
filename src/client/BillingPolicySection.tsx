/**
 * Issue #5230 — the remaining billing-policy fields editor in the
 * Billing servicing surface (new "Billing policy" sub-tab).
 *
 * This section CALLS existing routes only and creates none: GET
 * billing-policy (operator-only) for the fields + seed note, POST
 * billing-policy (operator-only) for edits, and GET operators
 * (operator-only) to learn whether the viewer is an operator. The
 * server routes remain the access control — a non-operator sees a
 * fixed note with no values and no edit controls, because the
 * operators read refused them; nothing here enforces anything the
 * server does not.
 *
 * Coverage: the nine policy fields with no surface before this slice
 * (grace period, dunning schedule, proration, downgrade timing,
 * billing period default/allowed, annual discount, repurchase
 * migration, cfpay channel fixed price) plus the bundle Stripe Price
 * mapping (same class: operator data, no surface). Top-up limits,
 * offer rules, and the plan Stripe Price mapping already have their
 * own sub-tabs and are NOT repeated here.
 *
 * After every save the section re-reads the policy and renders ONLY
 * the fresh read, never the POST answer and never an optimistic
 * assertion. Failures render as fixed strings keyed by HTTP status;
 * server error bodies are never rendered. Changing a field never
 * affects a subscription already bought; the next checkout or
 * renewal reads the stored policy. ui primitives only, token-only
 * styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Checkbox } from "./components/ui/Checkbox";
import { PageShell } from "./components/ui/PageShell";
import { Notice } from "./components/ui/Notice";
import { Select } from "./components/ui/Select";
import { TextInput } from "./components/ui/TextInput";
import { listOperators } from "./refundPolicyApi";
import {
  getBillingPolicyFields,
  setBillingPolicyFields,
  BillingPolicyApiError,
  type BillingPeriod,
  type BillingPolicyFieldsView,
  type DowngradeTiming,
  type ProrationBehavior,
  type RepurchaseMigration,
} from "./billingPolicyApi";

function statusOf(error: unknown): number {
  return error instanceof BillingPolicyApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The billing policy is not configured yet.";
  return "The billing policy could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 400) return "The billing policy values are invalid. Check each field and try again.";
  if (status === 403) return "Only a store operator can change billing policy.";
  if (status === 503) return "The billing service is temporarily unavailable. Try again later.";
  return "The billing policy could not be saved. Try again later.";
}

interface BundleRow {
  key: number;
  bundleId: string;
  priceId: string;
}

export function BillingPolicySection() {
  const [fields, setFields] = useState<BillingPolicyFieldsView | null>(null);
  const [seedNote, setSeedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [graceInput, setGraceInput] = useState("");
  const [dunningInput, setDunningInput] = useState("");
  const [proration, setProration] = useState<ProrationBehavior>("none");
  const [downgrade, setDowngrade] = useState<DowngradeTiming>("period_end");
  const [periodDefault, setPeriodDefault] = useState<BillingPeriod>("monthly");
  const [periodsAllowed, setPeriodsAllowed] = useState<BillingPeriod[]>(["monthly"]);
  const [discountInput, setDiscountInput] = useState("");
  const [migration, setMigration] = useState<RepurchaseMigration>("grandfather");
  const [cfpayInput, setCfpayInput] = useState("");
  const [bundleRows, setBundleRows] = useState<BundleRow[]>([]);
  const [nextRowKey, setNextRowKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const applyFields = useCallback((fresh: BillingPolicyFieldsView) => {
    setFields(fresh);
    setGraceInput(String(fresh.gracePeriodDays));
    setDunningInput(fresh.dunningRetryDelayDays.join(", "));
    setProration(fresh.prorationBehavior);
    setDowngrade(fresh.downgradeTiming);
    setPeriodDefault(fresh.billingPeriodDefault);
    setPeriodsAllowed([...fresh.billingPeriodsAllowed]);
    setDiscountInput(String(fresh.annualDiscountPct));
    setMigration(fresh.repurchaseMigration);
    setCfpayInput(fresh.cfpayChannelFixedPriceUSD === null ? "" : String(fresh.cfpayChannelFixedPriceUSD));
    const rows = Object.entries(fresh.stripePriceByBundle).map(([bundleId, priceId], i) => ({
      key: i,
      bundleId,
      priceId,
    }));
    setBundleRows(rows);
    setNextRowKey(rows.length);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [fieldsResult, operatorsResult] = await Promise.allSettled([
        getBillingPolicyFields(),
        listOperators(),
      ]);
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the fixed note; the server
      // still refuses any action the UI should not offer.
      const operator = operatorsResult.status === "fulfilled";
      setIsOperator(operator);
      if (operator && fieldsResult.status === "fulfilled") {
        applyFields(fieldsResult.value.fields);
        setSeedNote(fieldsResult.value.seedNote);
      } else if (operator) {
        setFields(null);
        if (fieldsResult.status === "rejected") {
          setLoadError(loadMessage(statusOf(fieldsResult.reason)));
        }
      } else {
        // Non-operator: no values, no edit controls. The policy
        // read refusal is expected, not an error to surface.
        setFields(null);
      }
    } catch {
      setFields(null);
      setLoadError(loadMessage(0));
      setIsOperator(false);
    } finally {
      setLoading(false);
    }
  }, [applyFields]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError(loadMessage(0));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const togglePeriod = useCallback((period: BillingPeriod) => {
    setPeriodsAllowed((prev) =>
      prev.includes(period) ? prev.filter((p) => p !== period) : [...prev, period],
    );
  }, []);

  const save = useCallback(async () => {
    const grace = Number(graceInput);
    if (!Number.isInteger(grace) || grace < 0) {
      setActionError("The grace period is invalid: enter a whole number of days, 0 or more.");
      return;
    }
    const dunning = dunningInput
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => Number(part));
    if (dunning.some((d) => !Number.isInteger(d) || d < 0)) {
      setActionError("The dunning schedule is invalid: enter whole days separated by commas, for example 1, 3, 7.");
      return;
    }
    const discount = Number(discountInput);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      setActionError("The annual discount is invalid: enter a whole percent from 0 to 100.");
      return;
    }
    const cfpay = cfpayInput.trim() === "" ? null : Number(cfpayInput);
    if (cfpay !== null && (!Number.isFinite(cfpay) || cfpay <= 0)) {
      setActionError("The cfpay channel fixed price is invalid: enter a positive amount in USD, or leave it blank to leave the channel unconfigured.");
      return;
    }
    if (periodsAllowed.length === 0) {
      setActionError("At least one billing period must be allowed.");
      return;
    }
    if (!periodsAllowed.includes(periodDefault)) {
      setActionError("The default billing period must be one of the allowed periods.");
      return;
    }
    const bundleMapping: Record<string, string> = {};
    for (const row of bundleRows) {
      const bundleId = row.bundleId.trim();
      const priceId = row.priceId.trim();
      if (!bundleId && !priceId) continue;
      if (!bundleId || !priceId) {
        setActionError("Each bundle mapping needs both a bundle id and a Stripe Price id.");
        return;
      }
      bundleMapping[bundleId] = priceId;
    }
    setSaving(true);
    setActionError(null);
    try {
      await setBillingPolicyFields({
        gracePeriodDays: grace,
        dunningRetryDelayDays: dunning,
        prorationBehavior: proration,
        downgradeTiming: downgrade,
        billingPeriodDefault: periodDefault,
        billingPeriodsAllowed: periodsAllowed,
        annualDiscountPct: discount,
        repurchaseMigration: migration,
        cfpayChannelFixedPriceUSD: cfpay,
        stripePriceByBundle: bundleMapping,
      });
      const fresh = await getBillingPolicyFields();
      applyFields(fresh.fields);
      setSeedNote(fresh.seedNote);
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setSaving(false);
    }
  }, [
    graceInput,
    dunningInput,
    discountInput,
    cfpayInput,
    periodsAllowed,
    periodDefault,
    proration,
    downgrade,
    migration,
    bundleRows,
    applyFields,
  ]);

  // Issue #4691 — the section title lives in the PageShell: under the
  // Billing tab host it collapses to content-only (the tab label is the
  // title); standalone it renders as the page h1.
  return (
    <PageShell title="Billing policy">
      <Card>
      {loading && <p>Loading billing policy</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && !isOperator && (
        <p>Only a store operator can view or change billing policy.</p>
      )}
      {!loading && !loadError && isOperator && fields && (
        <>
          {seedNote && <p>{seedNote}</p>}
          <p>
            The remaining billing-policy values: renewal grace and dunning,
            proration and downgrade rules, billing periods, the annual
            discount, repurchase migration, the cfpay channel fixed price,
            and bundle Stripe Price mappings. Top-up limits, offer rules,
            and plan Stripe Price mappings have their own sub-tabs.
          </p>
          <TextInput
            label="Grace period (days of continued access after a renewal failure)"
            type="number"
            value={graceInput}
            onChange={(e) => setGraceInput(e.target.value)}
          />
          <TextInput
            label="Dunning schedule (notice delays in days, comma-separated, in order)"
            value={dunningInput}
            onChange={(e) => setDunningInput(e.target.value)}
            placeholder="1, 3, 7"
          />
          <Select
            label="Proration on subscription updates"
            value={proration}
            onChange={(e) => setProration(e.target.value as ProrationBehavior)}
          >
            <option value="none">None</option>
            <option value="create_prorations">Create prorations</option>
            <option value="always_invoice">Always invoice</option>
          </Select>
          <Select
            label="Downgrade timing"
            value={downgrade}
            onChange={(e) => setDowngrade(e.target.value as DowngradeTiming)}
          >
            <option value="period_end">At period end</option>
            <option value="immediate">Immediately</option>
          </Select>
          <Select
            label="Default billing period for new subscriptions"
            value={periodDefault}
            onChange={(e) => setPeriodDefault(e.target.value as BillingPeriod)}
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </Select>
          <p>Allowed billing periods</p>
          <Checkbox
            label="Monthly"
            checked={periodsAllowed.includes("monthly")}
            onChange={() => togglePeriod("monthly")}
          />
          <Checkbox
            label="Annual"
            checked={periodsAllowed.includes("annual")}
            onChange={() => togglePeriod("annual")}
          />
          <TextInput
            label="Annual discount (whole percent off the monthly price × 12)"
            type="number"
            value={discountInput}
            onChange={(e) => setDiscountInput(e.target.value)}
          />
          <Select
            label="Repurchase migration when Billing activates"
            value={migration}
            onChange={(e) => setMigration(e.target.value as RepurchaseMigration)}
          >
            <option value="grandfather">Grandfather existing subscriptions</option>
            <option value="expire">Expire existing subscriptions</option>
            <option value="migrate">Migrate existing subscriptions</option>
          </Select>
          <TextInput
            label="cfpay channel fixed price (USD — blank leaves the channel unconfigured)"
            type="number"
            value={cfpayInput}
            onChange={(e) => setCfpayInput(e.target.value)}
            placeholder="Leave blank for unconfigured"
          />
          <p>
            Bundle Stripe Price mappings — the subscription checkout reads
            the Stripe Price id from this mapping only; a bundle without a
            mapping refuses checkout.
          </p>
          {bundleRows.map((row) => (
            <div key={row.key}>
              <TextInput
                label="Bundle id"
                value={row.bundleId}
                onChange={(e) =>
                  setBundleRows((prev) =>
                    prev.map((r) => (r.key === row.key ? { ...r, bundleId: e.target.value } : r)),
                  )
                }
              />
              <TextInput
                label="Stripe Price id"
                value={row.priceId}
                onChange={(e) =>
                  setBundleRows((prev) =>
                    prev.map((r) => (r.key === row.key ? { ...r, priceId: e.target.value } : r)),
                  )
                }
                placeholder="price_…"
              />
              <Button
                variant="secondary"
                onClick={() => setBundleRows((prev) => prev.filter((r) => r.key !== row.key))}
              >
                Remove mapping
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() => {
              setBundleRows((prev) => [...prev, { key: nextRowKey, bundleId: "", priceId: "" }]);
              setNextRowKey((prev) => prev + 1);
            }}
          >
            Add bundle mapping
          </Button>
          <Button variant="secondary" loading={saving} onClick={save}>
            Save billing policy
          </Button>
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>
            Changing a field never affects a subscription already bought; the
            next checkout or renewal reads the stored policy.
          </p>
        </>
      )}
    </Card>
    </PageShell>
  );
}
