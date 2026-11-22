// @vitest-environment node
/**
 * Issue #6032 — an unresolvable universe refuses by name.
 *
 * Before this slice: `resolveUniverse` returned `[]` for `ALL` and the
 * research caller `.map`ped it, so a typo'd or `ALL` universe produced a
 * *published* report reading "Universe retrieval failed; no candidates
 * evaluated" — indistinguishable from a genuine zero-qualification night,
 * with no field naming the bad id. The settings API accepted any non-empty
 * string, and the editor offered free text.
 *
 * The refusal slice pinned here:
 *  - the accepted set is one declaration (`researchUniverseIds()`),
 *  - `ALL` refuses ("a shard plan is not resolvable for a single run"),
 *  - an unknown id refuses in the provider before any quote,
 *  - config validation refuses the same ids the run refuses,
 *  - the run's report carries `research_universe_unknown`, naming the id.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isResearchUniverseId,
  isResearchUniverseRefusal,
  normalizeResearchUniverseId,
  RESEARCH_UNIVERSE_IDS,
  researchUniverseIds,
  ResearchUniverseRefusal,
  resolveUniverse,
} from "../src/trading";
import {
  RESEARCH_CONFIG_DEFAULTS,
  RESEARCH_CONFIG_SCHEMA,
  validateResearchConfig,
} from "../src/services/researchConfig";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";

const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAAA", companyName: "Alpha Tech", exchange: "NASDAQ", marketCap: 3_000_000_000_000 },
  { symbol: "BBBB", companyName: "Beta Software", exchange: "NASDAQ", marketCap: 2_000_000_000_000 },
  { symbol: "CCCC", companyName: "Gamma Corp", exchange: "NYSE", marketCap: 1_000_000_000_000 },
] as NasdaqStockListing[];

describe("#6032 universe refusal", () => {
  it("one accepted set: the registry minus ALL", () => {
    expect(researchUniverseIds()).toEqual([...RESEARCH_UNIVERSE_IDS]);
    expect(researchUniverseIds()).not.toContain("ALL");
    expect(researchUniverseIds()).toContain("NASDAQ100");
  });

  it("normalises stored ids (trim + upper-case) and refuses the rest", () => {
    expect(normalizeResearchUniverseId(" nasdaq100 ")).toBe("NASDAQ100");
    expect(normalizeResearchUniverseId("dow")).toBeNull();
    expect(normalizeResearchUniverseId("ALL")).toBeNull();
    expect(isResearchUniverseId("SP500")).toBe(true);
    expect(isResearchUniverseId("SP500 ")).toBe(false);
  });

  it("ALL refuses instead of returning an empty universe", () => {
    try {
      resolveUniverse("ALL", LISTINGS);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isResearchUniverseRefusal(error)).toBe(true);
      const refusal = error as ResearchUniverseRefusal;
      expect(refusal.code).toBe("research_universe_unknown");
      expect(refusal.universe).toBe("ALL");
      expect(refusal.message).toContain("shard plan");
      expect(refusal.message).toContain("Accepted:");
    }
  });

  it("an id outside the registry refuses, naming the id and the accepted set", () => {
    try {
      resolveUniverse("dow" as never, LISTINGS);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isResearchUniverseRefusal(error)).toBe(true);
      const refusal = error as ResearchUniverseRefusal;
      expect(refusal.universe).toBe("dow");
      expect(refusal.accepted).toEqual([...RESEARCH_UNIVERSE_IDS]);
    }
  });

  it("the eight screener universes still resolve", () => {
    for (const id of RESEARCH_UNIVERSE_IDS) {
      expect(() => resolveUniverse(id, LISTINGS)).not.toThrow();
    }
  });

  it("config validation refuses the same ids the run refuses", () => {
    const base = { ...RESEARCH_CONFIG_DEFAULTS };

    expect(validateResearchConfig({ ...base, universe: "NASDAQ100" })).toEqual([]);

    const errors = validateResearchConfig({ ...base, universe: "dow" });
    expect(errors.join(" ")).toContain("dow");
    expect(errors.join(" ")).toContain("Accepted:");
    expect(validateResearchConfig({ ...base, universe: "ALL" }).length).toBeGreaterThan(0);
  });

  it("the editor schema offers a select fed from the registry", () => {
    const field = RESEARCH_CONFIG_SCHEMA.find((f) => f.key === "universe");
    expect(field?.type).toBe("select");
    expect(field?.options).toEqual([...RESEARCH_UNIVERSE_IDS]);
  });
});
