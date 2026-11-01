/**
 * Issue #1496 (#940-B): stock criteria UI for the manual stock run form.
 *
 * Built ONLY from src/client/components/ui/ primitives (Card, FieldShell,
 * TextInput, Select, Button) with token styling from primitives.css —
 * no raw HTML controls, no hand-rolled cards.
 *
 * Three jobs:
 *  1. View — the "Last run's criteria" section shows the criteria SENT
 *     with the last run (client-known, labeled as sent), with "Not set —
 *     no constraint" for unset fields. The E*TRADE route does not echo
 *     filterApplied back, so the view does not claim server confirmation;
 *     adding that echo is a follow-up candidate, not a silent assumption.
 *     Unset genuinely means no constraint: evaluateUniverse guards every
 *     field with `!== undefined` (or `!== "any"` for the selects).
 *  2. Modify — numeric thresholds (RSI, volume, market cap, P/E) and
 *     selects (RSI band, momentum). Market cap is entered in $B and
 *     converted to dollars (x1e9) on send, so the engine's
 *     "<1e8 means billions" rule can never misread the value.
 *  3. Toggle — each criterion has an On/Off toggle. Off omits the field
 *     from the next run request WITHOUT clearing its value, so it can be
 *     re-enabled. Off is the default for every criterion, so adding the
 *     panel changes no existing run behavior.
 *
 * Every exposed field genuinely filters on the manual path (verified
 * 2026-10-25): ScreenerAgent.runScreen funnels both providers through
 * screenUniverse -> screenWithQuotes -> evaluateUniverse, where minRsi,
 * maxRsi, rsiFilter, momentum, minVolume, minMarketCap, and maxPeRatio
 * each reject with a reason. The provider flag only changes quote
 * acquisition, so no per-provider gating is needed here.
 */

import React from "react";
import type { StockScreenerFilter } from "../types";
import { Card } from "./components/ui/Card";
import { FieldShell } from "./components/ui/Field";
import { TextInput } from "./components/ui/TextInput";
import { Select } from "./components/ui/Select";
import { Button } from "./components/ui/Button";
import { EmptyState } from "./components/ui/EmptyState";

export type RsiBand = "any" | "oversold" | "overbought" | "neutral";
export type MomentumKind =
  | "any"
  | "bullish_breakout"
  | "bearish_pullback"
  | "high_relative_volume";

export interface StockCriterionValue {
  enabled: boolean;
  value: string;
}

export interface StockCriteriaState {
  minRsi: StockCriterionValue;
  maxRsi: StockCriterionValue;
  minVolume: StockCriterionValue;
  minMarketCapB: StockCriterionValue;
  maxPeRatio: StockCriterionValue;
  rsiFilter: { enabled: boolean; value: RsiBand };
  momentum: { enabled: boolean; value: MomentumKind };
}

const off = (value: string): StockCriterionValue => ({ enabled: false, value });

export const defaultStockCriteria: StockCriteriaState = {
  minRsi: off(""),
  maxRsi: off(""),
  minVolume: off(""),
  minMarketCapB: off(""),
  maxPeRatio: off(""),
  rsiFilter: { enabled: false, value: "any" },
  momentum: { enabled: false, value: "any" },
};

function num(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Enabled criteria only, as a StockScreenerFilter for the run request. */
export function stockCriteriaToFilter(criteria: StockCriteriaState): StockScreenerFilter {
  const filter: StockScreenerFilter = {};
  const minRsi = criteria.minRsi.enabled ? num(criteria.minRsi.value) : undefined;
  if (minRsi !== undefined) filter.minRsi = minRsi;
  const maxRsi = criteria.maxRsi.enabled ? num(criteria.maxRsi.value) : undefined;
  if (maxRsi !== undefined) filter.maxRsi = maxRsi;
  const minVolume = criteria.minVolume.enabled ? num(criteria.minVolume.value) : undefined;
  if (minVolume !== undefined) filter.minVolume = minVolume;
  const minMarketCapB = criteria.minMarketCapB.enabled
    ? num(criteria.minMarketCapB.value)
    : undefined;
  if (minMarketCapB !== undefined && minMarketCapB > 0) {
    filter.minMarketCap = minMarketCapB * 1e9;
  }
  const maxPeRatio = criteria.maxPeRatio.enabled ? num(criteria.maxPeRatio.value) : undefined;
  if (maxPeRatio !== undefined) filter.maxPeRatio = maxPeRatio;
  if (criteria.rsiFilter.enabled && criteria.rsiFilter.value !== "any") {
    filter.rsiFilter = criteria.rsiFilter.value;
  }
  if (criteria.momentum.enabled && criteria.momentum.value !== "any") {
    filter.momentum = criteria.momentum.value;
  }
  return filter;
}

/**
 * Issue #1497 (#940-C): map a stored preset's filter back onto panel
 * state. A present field becomes an enabled row with its value; an
 * absent field becomes an off row with an empty value — loading a preset
 * fully determines the panel, never merges silently with draft state.
 * Market cap converts back from dollars to the panel's $B unit. A saved
 * "any" band/momentum (possible via direct API writes; the panel never
 * saves "any") maps to off, since "any" means no constraint.
 */
export function stockFilterToCriteria(filter: StockScreenerFilter): StockCriteriaState {
  const numeric = (value: number | undefined): StockCriterionValue =>
    value === undefined ? { enabled: false, value: "" } : { enabled: true, value: String(value) };
  return {
    minRsi: numeric(filter.minRsi),
    maxRsi: numeric(filter.maxRsi),
    minVolume: numeric(filter.minVolume),
    minMarketCapB:
      filter.minMarketCap === undefined
        ? { enabled: false, value: "" }
        : { enabled: true, value: String(filter.minMarketCap / 1e9) },
    maxPeRatio: numeric(filter.maxPeRatio),
    rsiFilter:
      filter.rsiFilter && filter.rsiFilter !== "any"
        ? { enabled: true, value: filter.rsiFilter }
        : { enabled: false, value: "any" },
    momentum:
      filter.momentum && filter.momentum !== "any"
        ? { enabled: true, value: filter.momentum }
        : { enabled: false, value: "any" },
  };
}

const RSI_BAND_LABELS: Record<RsiBand, string> = {
  any: "Any",
  oversold: "Oversold (RSI < 35)",
  overbought: "Overbought (RSI > 70)",
  neutral: "Neutral (RSI 35–70)",
};

const MOMENTUM_LABELS: Record<MomentumKind, string> = {
  any: "Any",
  bullish_breakout: "Bullish breakout",
  bearish_pullback: "Bearish pullback",
  high_relative_volume: "High relative volume",
};

function sentDisplay(key: string, sent: Record<string, unknown> | null | undefined): string {
  if (!sent) return "Not set — no constraint";
  const value = sent[key];
  if (value === undefined || value === null || value === "") return "Not set — no constraint";
  if (key === "minMarketCap" && typeof value === "number") {
    return `$${(value / 1e9).toLocaleString()}B`;
  }
  if (key === "rsiFilter") return RSI_BAND_LABELS[value as RsiBand] ?? String(value);
  if (key === "momentum") return MOMENTUM_LABELS[value as MomentumKind] ?? String(value);
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export interface StockCriteriaPanelProps {
  criteria: StockCriteriaState;
  onChange: (next: StockCriteriaState) => void;
  /** Run request object sent with the last run (null before any run). */
  lastSentFilters: Record<string, unknown> | null;
}

export function StockCriteriaPanel({ criteria, onChange, lastSentFilters }: StockCriteriaPanelProps) {
  const setNumeric = (key: keyof Omit<StockCriteriaState, "rsiFilter" | "momentum">) => (value: string) =>
    onChange({ ...criteria, [key]: { ...criteria[key], value } });
  const setEnabled = (key: keyof StockCriteriaState) => () =>
    onChange({ ...criteria, [key]: { ...criteria[key], enabled: !criteria[key].enabled } });

  const numericRow = (
    key: "minRsi" | "maxRsi" | "minVolume" | "minMarketCapB" | "maxPeRatio",
    label: string,
    hint: string,
    inputProps: Record<string, string>
  ) => {
    const field = criteria[key];
    const id = `stock-criteria-${key}`;
    return (
      <div className={`stock-criteria-row${field.enabled ? " is-enabled" : ""}`} key={key}>
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
    key: "rsiFilter" | "momentum",
    label: string,
    hint: string,
    options: Array<{ value: string; label: string }>
  ) => {
    const field = criteria[key];
    const id = `stock-criteria-${key}`;
    return (
      <div className={`stock-criteria-row${field.enabled ? " is-enabled" : ""}`} key={key}>
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
                  value: event.target.value as RsiBand & MomentumKind,
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
    { label: "Min RSI", key: "minRsi" },
    { label: "Max RSI", key: "maxRsi" },
    { label: "Min daily volume", key: "minVolume" },
    { label: "Min market cap", key: "minMarketCap" },
    { label: "Max P/E", key: "maxPeRatio" },
    { label: "RSI band", key: "rsiFilter" },
    { label: "Momentum", key: "momentum" },
  ];

  return (
    <Card>
      <h3>Stock criteria</h3>
      <p>
        Thresholds the next run filters on. A criterion left Off is omitted
        from the run request without clearing its value. All seven fields
        are applied by the screen&apos;s filter stage on both providers.
      </p>
      {numericRow("minRsi", "Min RSI", "0–100; stocks below this RSI-14 are rejected.", { min: "0", max: "100" })}
      {numericRow("maxRsi", "Max RSI", "0–100; stocks above this RSI-14 are rejected.", { min: "0", max: "100" })}
      {numericRow("minVolume", "Min daily volume", "Shares; stocks below this volume are rejected.", { min: "0" })}
      {numericRow("minMarketCapB", "Min market cap", "Billions of dollars; converted to dollars when sent.", { min: "0", step: "0.5" })}
      {numericRow("maxPeRatio", "Max P/E", "Stocks above this P/E, or with no P/E, are rejected.", { min: "0", step: "0.1" })}
      {selectRow("rsiFilter", "RSI band", "Oversold < 35, overbought > 70, neutral 35–70.", [
        { value: "any", label: "Any" },
        { value: "oversold", label: "Oversold (RSI < 35)" },
        { value: "overbought", label: "Overbought (RSI > 70)" },
        { value: "neutral", label: "Neutral (RSI 35–70)" },
      ])}
      {selectRow("momentum", "Momentum", "Breakout, pullback, or high-relative-volume pattern.", [
        { value: "any", label: "Any" },
        { value: "bullish_breakout", label: "Bullish breakout" },
        { value: "bearish_pullback", label: "Bearish pullback" },
        { value: "high_relative_volume", label: "High relative volume" },
      ])}
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
