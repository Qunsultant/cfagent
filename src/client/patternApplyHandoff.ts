/**
 * Issue #2909 (G2 under #2764) — the Patterns tab -> New Screen
 * Apply handoff, as pure functions (no DOM, no React) so the
 * contract is unit-testable and the two hubs cannot drift apart.
 *
 * The bug it fixes (audit F1): PatternsPanel passed a filter to
 * ScreenersHub, ScreenersHub dropped it and only navigated, and
 * StockHub started from default criteria — Apply landed on a
 * blank form with a success notice. The handoff is now URL
 * params, the URL being the router's source of truth: the
 * Patterns hub encodes the pattern (id, pinned version, the
 * filter fields stockFilterToCriteria understands, and the
 * unmapped guardrails with their values), and StockHub decodes
 * them on navigation and sets its criteria from them — fully,
 * never merged silently with draft state.
 *
 * Guardrail honesty: an unmapped guardrail (a pattern guardrail
 * with no filter field, e.g. trend_breakout volumeRatioMin 1.2)
 * is carried as appliedUnmapped=key=value, shown as a
 * qualification on the New Screen form, and sent with the run
 * as unmappedGuardrails — never converted into a filter it
 * is not, never silently dropped. Patterns and presets stay
 * separate: this handoff writes no preset storage.
 */

import type { StockScreenerFilter } from "../types";

export interface AppliedPatternGuardrail {
  key: string;
  value: number;
}

export interface AppliedPattern {
  patternId: string;
  version: string;
  filter: StockScreenerFilter;
  unmappedGuardrails: AppliedPatternGuardrail[];
}

const MOMENTUM_VALUES = new Set(["bullish_breakout", "bearish_pullback", "high_relative_volume"]);
const RSI_FILTER_VALUES = new Set(["oversold", "overbought", "neutral"]);

function finiteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Encode a catalog pattern as URL params. Only defined filter
 * fields are emitted; an absent field means no constraint, never
 * a zero. Unmapped guardrails ride as key=value pairs so the
 * New Screen form can name them in its qualification notice.
 */
export function buildAppliedPatternParams(pattern: {
  id: string;
  version: string;
  screenFilter: StockScreenerFilter;
  unmappedGuardrails: string[];
  guardrails: Record<string, number>;
}): Record<string, string> {
  const params: Record<string, string> = {
    appliedPattern: pattern.id,
    appliedPatternVersion: pattern.version,
  };
  const f = pattern.screenFilter;
  if (f.momentum) params.appliedMomentum = f.momentum;
  if (f.minRsi !== undefined) params.appliedMinRsi = String(f.minRsi);
  if (f.maxRsi !== undefined) params.appliedMaxRsi = String(f.maxRsi);
  if (f.minVolume !== undefined) params.appliedMinVolume = String(f.minVolume);
  if (f.minMarketCap !== undefined) params.appliedMinMarketCap = String(f.minMarketCap);
  if (f.maxPeRatio !== undefined) params.appliedMaxPeRatio = String(f.maxPeRatio);
  if (f.rsiFilter) params.appliedRsiFilter = f.rsiFilter;
  const unmapped = pattern.unmappedGuardrails
    .map((key) => {
      const value = pattern.guardrails[key];
      return value === undefined ? null : `${key}=${value}`;
    })
    .filter((entry): entry is string => entry !== null);
  if (unmapped.length > 0) params.appliedUnmapped = unmapped.join(",");
  return params;
}

/**
 * Decode an Apply handoff from a query string. Returns null when
 * no applied pattern is present. A malformed field is dropped
 * (never guessed); an unknown pattern id is never invented —
 * the id is carried verbatim and the server pins it only if the
 * catalog knows it (the run request carries it as-is; a bad id
 * is the caller's, not a fabricated pattern).
 */
export function parseAppliedPatternParams(search: string): AppliedPattern | null {
  const params = new URLSearchParams(search);
  const patternId = params.get("appliedPattern");
  if (!patternId) return null;
  const filter: StockScreenerFilter = {};
  const momentum = params.get("appliedMomentum");
  if (momentum && MOMENTUM_VALUES.has(momentum)) {
    filter.momentum = momentum as StockScreenerFilter["momentum"];
  }
  const minRsi = finiteNumber(params.get("appliedMinRsi"));
  if (minRsi !== undefined) filter.minRsi = minRsi;
  const maxRsi = finiteNumber(params.get("appliedMaxRsi"));
  if (maxRsi !== undefined) filter.maxRsi = maxRsi;
  const minVolume = finiteNumber(params.get("appliedMinVolume"));
  if (minVolume !== undefined) filter.minVolume = minVolume;
  const minMarketCap = finiteNumber(params.get("appliedMinMarketCap"));
  if (minMarketCap !== undefined) filter.minMarketCap = minMarketCap;
  const maxPeRatio = finiteNumber(params.get("appliedMaxPeRatio"));
  if (maxPeRatio !== undefined) filter.maxPeRatio = maxPeRatio;
  const rsiFilter = params.get("appliedRsiFilter");
  if (rsiFilter && RSI_FILTER_VALUES.has(rsiFilter)) {
    filter.rsiFilter = rsiFilter as StockScreenerFilter["rsiFilter"];
  }
  const unmappedGuardrails: AppliedPatternGuardrail[] = [];
  const unmapped = params.get("appliedUnmapped");
  if (unmapped) {
    for (const entry of unmapped.split(",")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const value = Number(entry.slice(eq + 1));
      if (Number.isFinite(value)) {
        unmappedGuardrails.push({ key: entry.slice(0, eq), value });
      }
    }
  }
  return {
    patternId,
    version: params.get("appliedPatternVersion") || "1",
    filter,
    unmappedGuardrails,
  };
}

/** Human lines for a run qualification: each unmapped guardrail, named, with the reason it is not enforced. */
export function patternQualificationLines(
  unmappedGuardrails: AppliedPatternGuardrail[],
): string[] {
  return unmappedGuardrails.map(
    (g) =>
      `${g.key} = ${g.value} — not enforced by this screen: no matching filter field exists, so the run does not apply this guardrail.`,
  );
}
