/**
 * Options research surface scheme (issue #2784).
 *
 * Research modes are panel state in OptionsResearchPanel, so a cold
 * link cannot reach them — until now. The `research` URL param on the
 * options host (?tab=options) names a SURFACE, and each surface maps
 * to the panel mode that hosts it plus the section to focus on
 * landing. Surfaces that share a mode (discovery / strategy-panel /
 * llm-evaluate all live in discovery mode; best-trade / compare in
 * custom mode) differ by their focus section.
 *
 * Two honest cold-load boundaries, documented not hidden:
 * - best-trade / compare land on the custom run-actions row. A link
 *   cannot auto-run: run() requires user input (symbol, target price,
 *   target date) that a cold link cannot invent.
 * - llm-evaluate lands on the strategy panel, where Evaluate buttons
 *   live on discovered strategies. A cold link cannot pre-select a
 *   strategy, so the modal itself opens only from a chosen strategy.
 */

import type { ResearchMode } from "./OptionsResearchPanel";

export interface OptionsResearchSurface {
  /** The `research` param value. */
  surface: string;
  /** The panel mode that hosts this surface. */
  mode: ResearchMode;
  /** Element id to focus on landing, or null when the mode top is the surface. */
  sectionId: string | null;
}

export const OPTIONS_RESEARCH_SURFACES: readonly OptionsResearchSurface[] = [
  { surface: "discovery", mode: "discovery", sectionId: "options-research-runs" },
  { surface: "strategy-panel", mode: "discovery", sectionId: "options-research-strategy" },
  { surface: "contracts", mode: "contracts", sectionId: null },
  { surface: "best-trade", mode: "custom", sectionId: "options-research-custom-actions" },
  { surface: "compare", mode: "custom", sectionId: "options-research-custom-actions" },
  { surface: "llm-ideas", mode: "llm-ideas", sectionId: null },
  { surface: "llm-evaluate", mode: "discovery", sectionId: "options-research-strategy" },
  { surface: "custom", mode: "custom", sectionId: null },
  { surface: "nlq", mode: "nlq", sectionId: null },
];

export const OPTIONS_RESEARCH_SURFACE_VALUES: readonly string[] =
  OPTIONS_RESEARCH_SURFACES.map((s) => s.surface);

/** Surface for a raw param value; null when unknown or absent — never a wrong landing. */
export function researchSurfaceForParam(
  value: string | null | undefined,
): OptionsResearchSurface | null {
  if (!value) return null;
  return OPTIONS_RESEARCH_SURFACES.find((s) => s.surface === value) ?? null;
}

/**
 * Param to write back when the panel mode changes. Inside custom mode,
 * a best-trade / compare surface is kept — overwriting it with
 * "custom" would lose the surface the link landed on.
 */
export function researchParamForMode(
  mode: ResearchMode,
  currentSurface: string | null,
): string {
  if (mode === "custom" && (currentSurface === "best-trade" || currentSurface === "compare")) {
    return currentSurface;
  }
  return mode;
}
