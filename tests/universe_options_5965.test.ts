/**
 * Issue #5965 (first slice) — the scheduled-run universe pickers read the
 * whole-set vocabulary.
 *
 * Before this pin each form carried its own list and offered `TECH` as a
 * universe, which #5515 removed: `TECH` is a sector
 * (`sector-information-technology`). The options now come from the reader, so
 * the pin asserts the list's *content* (what an operator may choose) rather
 * than a JSX block.
 */
import { afterEach, describe, expect, it } from "vitest";
import { universeOptions, withLegacyValue } from "../src/client/vocabularyOptions";
import { getVocabulary, setVocabulary, type Vocabulary } from "../src/config/vocabulary";

afterEach(() => setVocabulary(null));

function copyOf(vocab: Vocabulary): Vocabulary {
  return {
    version: vocab.version,
    defaults: { ...vocab.defaults },
    axes: Object.fromEntries(
      Object.entries(vocab.axes).map(([axis, entries]) => [axis, entries.map((e) => ({ ...e }))]),
    ) as Vocabulary["axes"],
    conflations: vocab.conflations.map((c) => ({ ...c })),
  };
}

describe("#5965 universe options come from the vocabulary", () => {
  it("P01 the screener picker offers the screener sets and never TECH", () => {
    const values = universeOptions("screener").map((o) => o.value);
    expect(values.sort()).toEqual(
      ["ALL", "ETF", "LEV_ETF", "NASDAQ100", "RUSSELL2000", "SP100", "SP500"].sort(),
    );
    // #5515: TECH is a sector, not a universe.
    expect(values).not.toContain("TECH");
    expect(values.map((v) => v.toLowerCase())).not.toContain("tech");
    // The stored index lists are a different family; the criteria schema does
    // not accept them, so the screener picker must not offer them.
    expect(values).not.toContain("dow");
    expect(values).not.toContain("sp400");
  });

  it("P02 every option carries the registry's label, not the raw id", () => {
    const byValue = new Map(universeOptions("screener").map((o) => [o.value, o.label]));
    expect(byValue.get("NASDAQ100")).toBe("Nasdaq-100");
    expect(byValue.get("RUSSELL2000")).toBe("Russell 2000");
    expect(byValue.get("ETF")).toBe("ETFs");
  });

  it("P03 the index picker offers the stored lists plus the sector lists", () => {
    const values = universeOptions("index").map((o) => o.value);
    for (const id of ["dow", "sp400", "sector-energy", "sector-information-technology"]) {
      expect(values, id).toContain(id);
    }
    // A screener-only set is not a stored list.
    expect(values).not.toContain("ALL");
    expect(values).not.toContain("NASDAQ100");
  });

  it("P04 a stored value the registry no longer offers stays visible as legacy", () => {
    const options = universeOptions("screener");
    const withTech = withLegacyValue(options, "TECH");
    const legacy = withTech.find((o) => o.value === "TECH");
    expect(legacy).toBeDefined();
    expect(legacy?.label).toContain("legacy");
    expect(legacy?.legacy).toBe(true);
    // A known value is not duplicated.
    expect(withLegacyValue(options, "NASDAQ100")).toHaveLength(options.length);
    // No current value means no extra row.
    expect(withLegacyValue(options, undefined)).toHaveLength(options.length);
  });

  it("P05 data, not JSX: a universe added to the registry appears in the picker", () => {
    const vocab = copyOf(getVocabulary());
    vocab.axes.universe = [
      ...vocab.axes.universe,
      { id: "sp1500", label: "S&P 1500", kind: "screener" },
    ];
    setVocabulary(vocab);
    const option = universeOptions("screener").find((o) => o.label === "S&P 1500");
    expect(option).toBeDefined();
    expect(option?.value).toBe("sp1500");
  });
});
