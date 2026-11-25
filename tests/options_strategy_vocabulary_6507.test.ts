// @vitest-environment node
/**
 * Issue #6507 — one options-strategy vocabulary for OODA and the screen
 * registry.
 *
 * Pins:
 * - 6507-P01 every catalog entry exists in the screen registry with the same
 *   label, theses, and category;
 * - 6507-P02 every OODA structure name resolves to its canonical screen id
 *   through the registry (and through the catalog helper);
 * - 6507-P03 OODA selection returns only catalogued names for every outlook
 *   and ownership/PMCC combination;
 * - 6507-P04 screen aliases resolve to their entry's id;
 * - 6507-P05 catalog ids resolve back to an OODA structure name.
 */
import { describe, it, expect } from "vitest";
import {
  OPTIONS_STRATEGY_VOCABULARY,
  allResearchStructureNames,
  catalogIdsForResearchStructure,
  researchStructureForCatalogId,
} from "../src/shared/optionsStrategyVocabulary";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";
import { strategyLabel } from "../src/trading/options/strategyEngine";
import { structuresForOutlook } from "../src/services/researchPipeline";
import type { Outlook } from "../src/services/researchGates";

describe("one options strategy vocabulary (issue 6507)", () => {
  it("P01: every catalog entry matches the screen registry metadata", () => {
    for (const entry of OPTIONS_STRATEGY_VOCABULARY) {
      const definition = defaultRegistry.get(entry.id);
      expect(definition, entry.id).toBeDefined();
      expect(definition!.label).toBe(entry.label);
      expect(definition!.category).toBe(entry.category);
      expect([...definition!.theses].sort()).toEqual([...entry.theses].sort());
    }
  });

  it("P02: every OODA structure name resolves to its canonical screen id", () => {
    for (const entry of OPTIONS_STRATEGY_VOCABULARY) {
      for (const researchName of entry.researchNames) {
        expect(catalogIdsForResearchStructure(researchName)).toEqual([entry.id]);
        expect(defaultRegistry.resolve(researchName)).toEqual([entry.id]);
        expect(strategyLabel(entry.id)).toBe(entry.label);
      }
    }
  });

  it("P03: OODA selection returns only catalogued names", () => {
    const outlooks: Outlook[] = ["bullish", "bearish", "range_bound", "volatile", "unknown"];
    const catalogued = new Set(allResearchStructureNames());
    expect(catalogued.size).toBe(allResearchStructureNames().length);

    for (const outlook of outlooks) {
      for (const ownership of [false, true]) {
        for (const pmcc of [false, true]) {
          for (const name of structuresForOutlook(outlook, ownership, pmcc)) {
            expect(catalogued.has(name), `${outlook}/${ownership}/${pmcc}: ${name}`).toBe(true);
            expect(catalogIdsForResearchStructure(name)).toHaveLength(1);
          }
        }
      }
    }
  });

  it("P04: screen aliases resolve to their entry's id", () => {
    for (const entry of OPTIONS_STRATEGY_VOCABULARY) {
      for (const alias of entry.aliases) {
        expect(defaultRegistry.resolve(alias), alias).toEqual([entry.id]);
      }
    }
  });

  it("P05: catalog ids resolve back to an OODA structure name", () => {
    for (const entry of OPTIONS_STRATEGY_VOCABULARY) {
      expect(researchStructureForCatalogId(entry.id)).toBe(entry.researchNames[0]);
    }
    expect(researchStructureForCatalogId("not_a_strategy")).toBeNull();
  });
});
