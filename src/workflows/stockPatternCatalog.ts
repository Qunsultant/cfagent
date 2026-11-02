/**
 * Issue #2884 (under #2764, full-stack #2766) — stock pattern
 * catalog: the patterns-tab read model + select/apply mapping.
 *
 * Source of truth: the existing setup catalog
 * (src/trading/setupCatalog.ts, issue #435) filtered to stock
 * families ONLY. Options families (defined_risk_spread, pmcc)
 * are never listed here, and nothing is seeded: the tab lists
 * exactly what the catalog holds. Read-only in v1 — no
 * add/update path exists yet (later phase, per Phase 1).
 *
 * Pattern -> screen-filter mapping (pinned in tests):
 *   - trend_breakout -> { momentum: "bullish_breakout" }
 *     (the signature IS a trend breakout; the momentum gate
 *     carries it).
 *   - pullback_reversion -> { maxRsi: 30 } (guardrail rsiMax
 *     maps exactly onto the maxRsi filter field).
 * Guardrails with no filter field stay visible as pattern
 * metadata and are NEVER silently converted: trend_breakout's
 * volumeRatioMin (1.2) has no volume-ratio filter field —
 * minVolume is an absolute floor, not a ratio — so it lands
 * in `unmappedGuardrails`, shown in the catalog, not in the
 * filter. Applying a pattern sets the New Screen criteria
 * panel from `screenFilter` via the existing
 * stockFilterToCriteria mapping; it never touches preset
 * storage and never flattens the pattern into a preset copy.
 * Patterns and presets stay separate surfaces.
 */

import { listSetups, type MarketSetup } from "../trading";
import type { StockScreenerFilter } from "../types";

export interface StockPattern {
  id: string;
  label: string;
  description: string;
  assetClass: "stock";
  signatureDescription: string;
  indicators: string[];
  guardrails: Record<string, number>;
  pairedStrategies: string[];
  riskNotes: string[];
  /** The filter Apply hands to the New Screen panel. */
  screenFilter: StockScreenerFilter;
  /** Guardrail keys with no filter field — shown, never converted. */
  unmappedGuardrails: string[];
}

const PATTERN_MOMENTUM: Record<string, StockScreenerFilter["momentum"]> = {
  trend_breakout: "bullish_breakout",
};

/** Map one stock setup to its catalog pattern (pure; unknown stock setups map to an empty filter, never a guessed one). */
export function stockPatternFromSetup(setup: MarketSetup): StockPattern {
  const screenFilter: StockScreenerFilter = {};
  const unmappedGuardrails: string[] = [];
  const momentum = PATTERN_MOMENTUM[setup.id];
  if (momentum) screenFilter.momentum = momentum;
  for (const [key, value] of Object.entries(setup.signature.guardrails ?? {})) {
    if (key === "rsiMax") {
      screenFilter.maxRsi = value;
    } else if (key === "rsiMin") {
      screenFilter.minRsi = value;
    } else {
      unmappedGuardrails.push(key);
    }
  }
  return {
    id: setup.id,
    label: setup.label,
    description: setup.description,
    assetClass: "stock",
    signatureDescription: setup.signature.description,
    indicators: [...setup.signature.indicators],
    guardrails: { ...(setup.signature.guardrails ?? {}) },
    pairedStrategies: [...setup.pairedStrategies],
    riskNotes: [...setup.riskNotes],
    screenFilter,
    unmappedGuardrails,
  };
}

/** Stock families only, in catalog order. Options families are excluded here, always. */
export function listStockPatterns(): StockPattern[] {
  return listSetups()
    .filter((setup) => setup.assetClass === "stock")
    .map(stockPatternFromSetup);
}

/** Unknown ids resolve to undefined, never an invented pattern. */
export function stockPatternById(id: string): StockPattern | undefined {
  return listStockPatterns().find((pattern) => pattern.id === id);
}
