/**
 * Issue #6507 — one vocabulary for the option strategies both engines name.
 *
 * The screen registry (`trading/options/strategies/catalog.ts`) and OODA's
 * research pipeline (`services/researchPipeline.ts` / `researchDiscovery.ts`)
 * described the same structures with different names. This module is the
 * single source for the shared slice: canonical screen id, display label,
 * thesis compatibility, category, screen aliases, and the OODA structure
 * names that build the same thing.
 *
 * Evaluation stays with each engine: research gates/ranking and the screen
 * engine's scoring are not part of this catalog.
 *
 * The module lives in `src/shared/` because `services/research*` may not
 * import a `trading/*` internal (research boundary, #290).
 */

export type StrategyThesis = "bullish" | "bearish" | "range_bound" | "large_move";

export type StrategyVocabularyCategory =
  | "single"
  | "vertical"
  | "condor"
  | "butterfly"
  | "volatility"
  | "time";

export interface OptionsStrategyVocabularyEntry {
  /** Canonical screen-registry id. */
  id: string;
  /** Display label owned by the screen catalog. */
  label: string;
  theses: StrategyThesis[];
  category: StrategyVocabularyCategory;
  /** Screen-registry aliases (free-form names that resolve to `id`). */
  aliases: string[];
  /** OODA structure names that construct this same strategy. */
  researchNames: string[];
}

export const OPTIONS_STRATEGY_VOCABULARY: readonly OptionsStrategyVocabularyEntry[] = [
  {
    id: "call_debit_spread",
    label: "Call Debit Spread",
    theses: ["bullish"],
    category: "vertical",
    aliases: ["Bull Call Spread", "Bull Call Debit Spread", "Long Call Vertical Spread"],
    researchNames: ["bull_call_spread"],
  },
  {
    id: "put_credit_spread",
    label: "Put Credit Spread",
    theses: ["bullish"],
    category: "vertical",
    aliases: ["Bull Put Spread", "Bull Put Credit Spread", "Short Put Vertical Spread"],
    researchNames: ["bull_put_spread"],
  },
  {
    id: "put_debit_spread",
    label: "Put Debit Spread",
    theses: ["bearish"],
    category: "vertical",
    aliases: ["Bear Put Spread", "Bear Put Debit Spread", "Long Put Vertical Spread"],
    researchNames: ["bear_put_spread"],
  },
  {
    id: "call_credit_spread",
    label: "Call Credit Spread",
    theses: ["bearish"],
    category: "vertical",
    aliases: ["Bear Call Spread", "Bear Call Credit Spread", "Short Call Vertical Spread"],
    researchNames: ["bear_call_spread"],
  },
  {
    id: "cash_secured_put",
    label: "Cash-Secured Put",
    theses: ["bullish", "range_bound"],
    category: "single",
    aliases: ["Cash Put"],
    researchNames: ["cash_secured_put"],
  },
  {
    id: "iron_condor",
    label: "Iron Condor",
    theses: ["range_bound"],
    category: "condor",
    aliases: [],
    researchNames: ["iron_condor"],
  },
  {
    id: "long_call_butterfly",
    label: "Long Call Butterfly",
    theses: ["range_bound"],
    category: "butterfly",
    aliases: [],
    researchNames: ["butterfly"],
  },
  {
    id: "long_straddle",
    label: "Long Straddle",
    theses: ["large_move"],
    category: "volatility",
    aliases: ["Straddle"],
    researchNames: ["long_straddle"],
  },
  {
    id: "long_strangle",
    label: "Long Strangle",
    theses: ["large_move"],
    category: "volatility",
    aliases: ["Strangle"],
    researchNames: ["long_strangle"],
  },
  {
    id: "poor_mans_covered_call",
    label: "Poor Man's Covered Call",
    theses: ["bullish", "range_bound"],
    category: "time",
    aliases: ["PMCC"],
    researchNames: ["pmcc"],
  },
];

const BY_ID = new Map(OPTIONS_STRATEGY_VOCABULARY.map((entry) => [entry.id, entry]));
const BY_RESEARCH_NAME = new Map(
  OPTIONS_STRATEGY_VOCABULARY.flatMap((entry) =>
    entry.researchNames.map((name) => [name, entry] as const),
  ),
);

/** Catalog entry for a screen-registry id. */
export function strategyVocabularyById(id: string): OptionsStrategyVocabularyEntry | undefined {
  return BY_ID.get(id);
}

/** Catalog entry for an OODA structure name. */
export function strategyVocabularyByResearchName(
  name: string,
): OptionsStrategyVocabularyEntry | undefined {
  return BY_RESEARCH_NAME.get(name);
}

/** Screen-registry ids an OODA structure constructs (empty when unknown). */
export function catalogIdsForResearchStructure(name: string): string[] {
  const entry = BY_RESEARCH_NAME.get(name);
  return entry ? [entry.id] : [];
}

/** The OODA structure name for a screen-registry id (first when several). */
export function researchStructureForCatalogId(id: string): string | null {
  return BY_ID.get(id)?.researchNames[0] ?? null;
}

/** Every OODA structure name in the catalog. */
export function allResearchStructureNames(): string[] {
  return OPTIONS_STRATEGY_VOCABULARY.flatMap((entry) => entry.researchNames);
}
