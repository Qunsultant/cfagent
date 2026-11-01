/**
 * Issue #1498 (#940-D): options criteria UI for the manual options
 * contract screen (RawContractsScreener).
 *
 * Built ONLY from src/client/components/ui/ primitives (Card, FieldShell,
 * TextInput, Select, Button) with token styling from primitives.css —
 * no raw HTML controls, no hand-rolled cards.
 *
 * Three jobs, mirroring StockCriteriaPanel (#1496):
 *  1. View — the "Last run's criteria" section shows the criteria SENT
 *     with the last run (client-known, labeled as sent), with "Not set —
 *     no constraint" for unset fields. The options route does not echo
 *     filterApplied back, so the view does not claim server confirmation.
 *  2. Modify — numeric thresholds (liquidity, DTE, premium, greeks, IV)
 *     and selects (contract type, moneyness). IV is entered as a percent
 *     and converted to the engine's decimal (÷100) on send, back to
 *     percent on load — the summary path renders IV the same way.
 *  3. Toggle — each criterion has an On/Off toggle. Off omits the field
 *     from the next run request WITHOUT clearing its value. Off is the
 *     default for every criterion, so adding the panel changes no
 *     existing run behavior: omitted minDte/maxDte fall back to the
 *     engine defaults (0/90, the old form's values), an omitted
 *     contractType screens BOTH, and "ALL" moneyness means no constraint.
 *
 * Every exposed field genuinely filters on the manual path (verified
 * 2026-10-25): provider.screen -> DynamicOptionsScreener.evaluateChains
 * -> the per-contract filter, where maxSpreadPct, min/max premium, DTE,
 * Delta, Gamma, Theta, Vega, Rho, IV, volume, open interest, moneyness,
 * strike distance, and contract type each reject with a reason.
 *
 * Deliberately NOT exposed (verified non-filters or scope inputs):
 * - maxQuoteAgeSeconds: only sets the FRESH/STALE label, never rejects.
 * - underlyingSymbols / sector: scope inputs owned by the form, not rows.
 * - limit / sortBy: result shaping, kept in the form as today.
 * - expirationDteBands: a complex array value, no single-row control.
 */

import React from "react";
import type { OptionScreenerFilter } from "../types";
import { Card } from "./components/ui/Card";
import { FieldShell } from "./components/ui/Field";
import { TextInput } from "./components/ui/TextInput";
import { Select } from "./components/ui/Select";
import { Button } from "./components/ui/Button";
import { EmptyState } from "./components/ui/EmptyState";

export type OptionsContractType = "BOTH" | "CALL" | "PUT";
export type OptionsMoneyness = "ALL" | "ITM" | "OTM" | "ATM";

export interface OptionsCriterionValue {
  enabled: boolean;
  value: string;
}

export interface OptionsCriteriaState {
  contractType: { enabled: boolean; value: OptionsContractType };
  moneyness: { enabled: boolean; value: OptionsMoneyness };
  minVolume: OptionsCriterionValue;
  minOpenInterest: OptionsCriterionValue;
  maxSpreadPct: OptionsCriterionValue;
  maxStrikeDistancePct: OptionsCriterionValue;
  minDte: OptionsCriterionValue;
  maxDte: OptionsCriterionValue;
  minPrice: OptionsCriterionValue;
  maxPrice: OptionsCriterionValue;
  minDelta: OptionsCriterionValue;
  maxDelta: OptionsCriterionValue;
  minGamma: OptionsCriterionValue;
  maxGamma: OptionsCriterionValue;
  minTheta: OptionsCriterionValue;
  maxTheta: OptionsCriterionValue;
  minVega: OptionsCriterionValue;
  maxVega: OptionsCriterionValue;
  minRho: OptionsCriterionValue;
  maxRho: OptionsCriterionValue;
  minIvPct: OptionsCriterionValue;
  maxIvPct: OptionsCriterionValue;
}

const off = (value: string): OptionsCriterionValue => ({ enabled: false, value });

export const defaultOptionsCriteria: OptionsCriteriaState = {
  contractType: { enabled: false, value: "BOTH" },
  moneyness: { enabled: false, value: "ALL" },
  minVolume: off(""),
  minOpenInterest: off(""),
  maxSpreadPct: off(""),
  maxStrikeDistancePct: off(""),
  minDte: off(""),
  maxDte: off(""),
  minPrice: off(""),
  maxPrice: off(""),
  minDelta: off(""),
  maxDelta: off(""),
  minGamma: off(""),
  maxGamma: off(""),
  minTheta: off(""),
  maxTheta: off(""),
  minVega: off(""),
  maxVega: off(""),
  minRho: off(""),
  maxRho: off(""),
  minIvPct: off(""),
  maxIvPct: off(""),
};

function num(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type NumericKey = Exclude<
  keyof OptionsCriteriaState,
  "contractType" | "moneyness"
>;

/** Enabled criteria only, as an OptionScreenerFilter for the run request. */
export function optionsCriteriaToFilter(criteria: OptionsCriteriaState): OptionScreenerFilter {
  const filter: OptionScreenerFilter = {};
  const put = (key: NumericKey, target: keyof OptionScreenerFilter, convert?: (n: number) => number) => {
    const value = criteria[key].enabled ? num(criteria[key].value) : undefined;
    if (value !== undefined) (filter as Record<string, number>)[target] = convert ? convert(value) : value;
  };
  put("minVolume", "minVolume");
  put("minOpenInterest", "minOpenInterest");
  put("maxSpreadPct", "maxSpreadPct");
  put("maxStrikeDistancePct", "maxStrikeDistancePct");
  put("minDte", "minDte");
  put("maxDte", "maxDte");
  put("minPrice", "minPrice");
  put("maxPrice", "maxPrice");
  put("minDelta", "minDelta");
  put("maxDelta", "maxDelta");
  put("minGamma", "minGamma");
  put("maxGamma", "maxGamma");
  put("minTheta", "minTheta");
  put("maxTheta", "maxTheta");
  put("minVega", "minVega");
  put("maxVega", "maxVega");
  put("minRho", "minRho");
  put("maxRho", "maxRho");
  put("minIvPct", "minImpliedVolatility", (pct) => pct / 100);
  put("maxIvPct", "maxImpliedVolatility", (pct) => pct / 100);
  if (criteria.contractType.enabled && criteria.contractType.value !== "BOTH") {
    filter.contractType = criteria.contractType.value;
  }
  if (criteria.moneyness.enabled && criteria.moneyness.value !== "ALL") {
    filter.moneyness = criteria.moneyness.value;
  }
  return filter;
}

/**
 * Issue #1498 (#940-D): map a stored preset's filter back onto panel
 * state. A present field becomes an enabled row with its value; an
 * absent field becomes an off row with an empty value — loading a preset
 * fully determines the panel, never merges silently with draft state.
 * IV converts back from the engine's decimal to the panel's percent unit.
 * A saved "BOTH" contract type or "ALL" moneyness (possible via direct
 * API writes; the panel never saves them) maps to off, since both mean
 * no constraint.
 */
export function optionsFilterToCriteria(filter: OptionScreenerFilter): OptionsCriteriaState {
  const numeric = (value: number | undefined): OptionsCriterionValue =>
    value === undefined ? { enabled: false, value: "" } : { enabled: true, value: String(value) };
  const iv = (value: number | undefined): OptionsCriterionValue =>
    value === undefined
      ? { enabled: false, value: "" }
      : { enabled: true, value: String(Number((value * 100).toFixed(2))) };
  return {
    contractType:
      filter.contractType && filter.contractType !== "BOTH"
        ? { enabled: true, value: filter.contractType }
        : { enabled: false, value: "BOTH" },
    moneyness:
      filter.moneyness && filter.moneyness !== "ALL"
        ? { enabled: true, value: filter.moneyness }
        : { enabled: false, value: "ALL" },
    minVolume: numeric(filter.minVolume),
    minOpenInterest: numeric(filter.minOpenInterest),
    maxSpreadPct: numeric(filter.maxSpreadPct),
    maxStrikeDistancePct: numeric(filter.maxStrikeDistancePct),
    minDte: numeric(filter.minDte),
    maxDte: numeric(filter.maxDte),
    minPrice: numeric(filter.minPrice),
    maxPrice: numeric(filter.maxPrice),
    minDelta: numeric(filter.minDelta),
    maxDelta: numeric(filter.maxDelta),
    minGamma: numeric(filter.minGamma),
    maxGamma: numeric(filter.maxGamma),
    minTheta: numeric(filter.minTheta),
    maxTheta: numeric(filter.maxTheta),
    minVega: numeric(filter.minVega),
    maxVega: numeric(filter.maxVega),
    minRho: numeric(filter.minRho),
    maxRho: numeric(filter.maxRho),
    minIvPct: iv(filter.minImpliedVolatility),
    maxIvPct: iv(filter.maxImpliedVolatility),
  };
}

const CONTRACT_TYPE_LABELS: Record<OptionsContractType, string> = {
  BOTH: "Both",
  CALL: "Calls",
  PUT: "Puts",
};

const MONEYNESS_LABELS: Record<OptionsMoneyness, string> = {
  ALL: "All",
  ITM: "In the money",
  OTM: "Out of the money",
  ATM: "At the money",
};

function sentDisplay(key: string, sent: Record<string, unknown> | null | undefined): string {
  if (!sent) return "Not set — no constraint";
  const value = sent[key];
  if (value === undefined || value === null || value === "") return "Not set — no constraint";
  if ((key === "minImpliedVolatility" || key === "maxImpliedVolatility") && typeof value === "number") {
    return `${Number((value * 100).toFixed(2))}%`;
  }
  if (key === "contractType") return CONTRACT_TYPE_LABELS[value as OptionsContractType] ?? String(value);
  if (key === "moneyness") return MONEYNESS_LABELS[value as OptionsMoneyness] ?? String(value);
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export interface OptionsCriteriaPanelProps {
  criteria: OptionsCriteriaState;
  onChange: (next: OptionsCriteriaState) => void;
  /** Run request object sent with the last run (null before any run). */
  lastSentFilters: Record<string, unknown> | null;
}

export function OptionsCriteriaPanel({ criteria, onChange, lastSentFilters }: OptionsCriteriaPanelProps) {
  const setNumeric = (key: NumericKey) => (value: string) =>
    onChange({ ...criteria, [key]: { ...criteria[key], value } });
  const setEnabled = (key: keyof OptionsCriteriaState) => () =>
    onChange({ ...criteria, [key]: { ...criteria[key], enabled: !criteria[key].enabled } });

  const numericRow = (
    key: NumericKey,
    label: string,
    hint: string,
    inputProps: Record<string, string>
  ) => {
    const field = criteria[key];
    const id = `options-criteria-${key}`;
    return (
      <div className={`options-criteria-row${field.enabled ? " is-enabled" : ""}`} key={key}>
        <Button
          type="button"
          variant={field.enabled ? "primary" : "secondary"}
          aria-pressed={field.enabled}
          aria-label={`Toggle ${label}`}
          onClick={setEnabled(key)}
        >
          {field.enabled ? "On" : "Off"}
        </Button>
        <FieldShell id={id} label={label} hint={hint}>
          <TextInput
            id={id}
            type="number"
            value={field.value}
            disabled={!field.enabled}
            onChange={(event) => setNumeric(key)(event.target.value)}
            {...inputProps}
          />
        </FieldShell>
      </div>
    );
  };

  const selectRow = (
    key: "contractType" | "moneyness",
    label: string,
    hint: string,
    options: Array<{ value: string; label: string }>
  ) => {
    const field = criteria[key];
    const id = `options-criteria-${key}`;
    return (
      <div className={`options-criteria-row${field.enabled ? " is-enabled" : ""}`} key={key}>
        <Button
          type="button"
          variant={field.enabled ? "primary" : "secondary"}
          aria-pressed={field.enabled}
          aria-label={`Toggle ${label}`}
          onClick={setEnabled(key)}
        >
          {field.enabled ? "On" : "Off"}
        </Button>
        <FieldShell id={id} label={label} hint={hint}>
          <Select
            id={id}
            value={field.value}
            disabled={!field.enabled}
            onChange={(event) =>
              onChange({
                ...criteria,
                [key]: {
                  ...field,
                  value: event.target.value as OptionsContractType & OptionsMoneyness,
                },
              })
            }
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FieldShell>
      </div>
    );
  };

  const viewRows: Array<{ label: string; key: string }> = [
    { label: "Contract type", key: "contractType" },
    { label: "Moneyness", key: "moneyness" },
    { label: "Min volume", key: "minVolume" },
    { label: "Min open interest", key: "minOpenInterest" },
    { label: "Max spread", key: "maxSpreadPct" },
    { label: "Max strike distance", key: "maxStrikeDistancePct" },
    { label: "Min DTE", key: "minDte" },
    { label: "Max DTE", key: "maxDte" },
    { label: "Min premium", key: "minPrice" },
    { label: "Max premium", key: "maxPrice" },
    { label: "Min delta", key: "minDelta" },
    { label: "Max delta", key: "maxDelta" },
    { label: "Min gamma", key: "minGamma" },
    { label: "Max gamma", key: "maxGamma" },
    { label: "Min theta", key: "minTheta" },
    { label: "Max theta", key: "maxTheta" },
    { label: "Min vega", key: "minVega" },
    { label: "Max vega", key: "maxVega" },
    { label: "Min rho", key: "minRho" },
    { label: "Max rho", key: "maxRho" },
    { label: "Min IV", key: "minImpliedVolatility" },
    { label: "Max IV", key: "maxImpliedVolatility" },
  ];

  return (
    <Card>
      <h3>Options criteria</h3>
      <p>
        Thresholds the next run filters on. A criterion left Off is omitted
        from the run request without clearing its value. All rows are
        applied by the contract filter stage on the manual path.
      </p>
      {selectRow("contractType", "Contract type", "Calls, puts, or both. Both means no type constraint.", [
        { value: "BOTH", label: "Both" },
        { value: "CALL", label: "Calls" },
        { value: "PUT", label: "Puts" },
      ])}
      {selectRow("moneyness", "Moneyness", "In, out of, or at the money. All means no constraint.", [
        { value: "ALL", label: "All" },
        { value: "ITM", label: "In the money" },
        { value: "OTM", label: "Out of the money" },
        { value: "ATM", label: "At the money" },
      ])}
      {numericRow("minVolume", "Min volume", "Contracts; below this volume are rejected.", { min: "0", step: "1" })}
      {numericRow("minOpenInterest", "Min open interest", "Contracts; below this open interest are rejected.", { min: "0", step: "1" })}
      {numericRow("maxSpreadPct", "Max spread", "Percent; wider spreads are rejected.", { min: "0", step: "0.5" })}
      {numericRow("maxStrikeDistancePct", "Max strike distance", "Percent from spot; farther strikes are rejected.", { min: "0", step: "0.5" })}
      {numericRow("minDte", "Min DTE", "Days to expiration; nearer expirations are rejected.", { min: "0", step: "1" })}
      {numericRow("maxDte", "Max DTE", "Days to expiration; farther expirations are rejected.", { min: "0", step: "1" })}
      {numericRow("minPrice", "Min premium", "Dollars of midpoint premium; below this are rejected.", { min: "0", step: "0.05" })}
      {numericRow("maxPrice", "Max premium", "Dollars of midpoint premium; above this are rejected.", { min: "0", step: "0.05" })}
      {numericRow("minDelta", "Min delta", "Signed decimal; below this delta are rejected.", { step: "0.05" })}
      {numericRow("maxDelta", "Max delta", "Signed decimal; above this delta are rejected.", { step: "0.05" })}
      {numericRow("minGamma", "Min gamma", "Below this gamma are rejected.", { step: "0.001" })}
      {numericRow("maxGamma", "Max gamma", "Above this gamma are rejected.", { step: "0.001" })}
      {numericRow("minTheta", "Min theta", "Below this theta are rejected.", { step: "0.001" })}
      {numericRow("maxTheta", "Max theta", "Above this theta are rejected.", { step: "0.001" })}
      {numericRow("minVega", "Min vega", "Below this vega are rejected.", { step: "0.001" })}
      {numericRow("maxVega", "Max vega", "Above this vega are rejected.", { step: "0.001" })}
      {numericRow("minRho", "Min rho", "Below this rho are rejected.", { step: "0.001" })}
      {numericRow("maxRho", "Max rho", "Above this rho are rejected.", { step: "0.001" })}
      {numericRow("minIvPct", "Min IV", "Percent; below this implied volatility are rejected.", { min: "0", step: "1" })}
      {numericRow("maxIvPct", "Max IV", "Percent; above this implied volatility are rejected.", { min: "0", step: "1" })}
      <h4>Last run&apos;s criteria</h4>
      {lastSentFilters === null ? (
        <EmptyState title="No run yet — the criteria above apply to the next run." />
      ) : (
        <ul>
          {viewRows.map((row) => (
            <li key={row.key}>
              {row.label}: {sentDisplay(row.key, lastSentFilters)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
