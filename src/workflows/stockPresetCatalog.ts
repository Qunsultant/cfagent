/**
 * Issue #2886 (under #2764, full-stack #2766) — starter
 * preset proposals for the presets tab.
 *
 * The eight starter names were PROPOSED, not finalized — this
 * module labels every starter "proposed" and never presents
 * one as a finalized system preset. Choosing a starter COPIES
 * it to the user's My Presets (POST /api/screener/presets);
 * starters themselves are never edited and never written as
 * system rows. Copying a starter snapshots its proposed
 * criteria at copy time into the user's own preset — later
 * starter changes do not rewrite the user's copy.
 *
 * Criteria honesty: a starter with no expressible filter
 * field carries criteria null and its reason, with copy and
 * apply disabled — never an invented threshold. 52-Week
 * Strength has no 52-week-distance filter field; Value Zone
 * has no finalized value-zone filter. The other six map onto
 * real filter fields (momentum, maxRsi, rsiFilter, gainers,
 * squeeze gate).
 *
 * Presets are separate from patterns: this module never
 * reads pattern definitions. Name overlap with patterns
 * (Trend Breakout, Pullback Reversion) is coincidental
 * proposal naming — same names, different surface, and the
 * tab labels it as such.
 */

import type { StockScreenerFilter } from "../types";

export interface StarterPreset {
  id: string;
  name: string;
  /** Always "proposed" until the names + criteria are finalized. */
  status: "proposed";
  /** Null when no filter field expresses the starter yet (see reason). */
  criteria: StockScreenerFilter | null;
  /** Present when criteria is null. */
  reason?: string;
}

export const STARTER_PRESETS: readonly StarterPreset[] = [
  {
    id: "starter-trend-breakout",
    name: "Trend Breakout",
    status: "proposed",
    criteria: { momentum: "bullish_breakout" },
  },
  {
    id: "starter-pullback-reversion",
    name: "Pullback Reversion",
    status: "proposed",
    criteria: { maxRsi: 30 },
  },
  {
    id: "starter-momentum-leaders",
    name: "Momentum Leaders",
    status: "proposed",
    criteria: { momentum: "high_relative_volume", gainersOnly: true },
  },
  {
    id: "starter-oversold-bounce",
    name: "Oversold Bounce",
    status: "proposed",
    criteria: { rsiFilter: "oversold" },
  },
  {
    id: "starter-volume-surge",
    name: "Volume Surge",
    status: "proposed",
    criteria: { momentum: "high_relative_volume" },
  },
  {
    id: "starter-52-week-strength",
    name: "52-Week Strength",
    status: "proposed",
    criteria: null,
    reason: "No 52-week-distance filter field exists yet; criteria to be finalized.",
  },
  {
    id: "starter-value-zone",
    name: "Value Zone",
    status: "proposed",
    criteria: null,
    reason: "No finalized value-zone filter; criteria to be finalized.",
  },
  {
    id: "starter-squeeze-watch",
    name: "Squeeze Watch",
    status: "proposed",
    criteria: { requireSqueezeGate: true },
  },
];

export function listStarterPresets(): StarterPreset[] {
  return [...STARTER_PRESETS];
}

/** Unknown ids resolve to undefined, never an invented starter. */
export function starterPresetById(id: string): StarterPreset | undefined {
  return STARTER_PRESETS.find((starter) => starter.id === id);
}
