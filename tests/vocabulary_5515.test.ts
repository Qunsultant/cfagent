/**
 * Issue #5515 — the whole-set vocabulary pins.
 *
 * One pin per axis (the registry holds today's values, so nothing changes
 * behaviour while consumers migrate), plus the three rules the issue states:
 * a job declares a SUBSET, an absent axis resolves from externalized defaults,
 * and a conflated value is refused by name with a pointer — never guessed.
 *
 * The "data, not code" proof overrides the registry through the seam and shows
 * a new provider resolving end-to-end with no code change (#5880 precedent).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  AXES,
  VOCABULARY_CODES,
  axisEntries,
  axisIds,
  getVocabulary,
  requireAxis,
  resolveJobSubset,
  resolveValue,
  setVocabulary,
  universeValues,
  vocabularyDefaults,
  type Vocabulary,
} from "../src/config/vocabulary";
import { DATA_PROVIDER_IDS, DATA_PROVIDER_KINDS } from "../src/trading/dataProviders/contract";
import { SECTOR_GICS_NAME, SECTOR_IDS } from "../src/trading/indexMembership";

afterEach(() => setVocabulary(null));

/** A deep-enough copy to mutate one axis in a test without touching the live one. */
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

describe("#5515 whole-set vocabulary", () => {
  it("P01 every axis is a non-empty registry, and there are exactly eight", () => {
    expect([...AXES]).toHaveLength(8);
    for (const axis of AXES) {
      expect(axisIds(axis).length, `${axis} is empty`).toBeGreaterThan(0);
      for (const entry of axisEntries(axis)) {
        expect(entry.label, `${axis}/${entry.id} has no label`).toBeTruthy();
      }
    }
  });

  it("P02 provider axis holds today's five ids with today's kinds", () => {
    // Equality, both directions: the registry is the source, and while the
    // consumer slice has not moved yet this pin proves the values are identical
    // (requirement 4 — existing runs resolve as before).
    expect([...axisIds("provider")].sort()).toEqual([...DATA_PROVIDER_IDS].sort());
    for (const id of DATA_PROVIDER_IDS) {
      const entry = axisEntries("provider").find((e) => e.id === id);
      expect(entry?.kind, `${id} kind`).toBe(DATA_PROVIDER_KINDS[id]);
    }
  });

  it("P03 universe axis unifies the screener sets and the stored index lists; TECH is not a universe", () => {
    const ids = axisIds("universe");
    for (const id of ["nasdaq100", "sp100", "sp500", "russell2000", "etf", "lev_etf", "all"]) {
      expect(ids, `screener universe ${id}`).toContain(id);
    }
    for (const id of ["dow", "sp400"]) expect(ids, `stored index list ${id}`).toContain(id);
    expect(ids).not.toContain("TECH");
  });

  it("P04 sector axis holds exactly the eleven GICS sectors, and they are also universe lists", () => {
    expect([...axisIds("sector")].sort()).toEqual([...SECTOR_IDS].sort());
    for (const id of SECTOR_IDS) {
      const entry = axisEntries("sector").find((e) => e.id === id);
      expect(entry?.label, `${id} label`).toBe(SECTOR_GICS_NAME[id]);
    }
    // One source, both views: every sector is a universe list, derived.
    const derived = universeValues()
      .filter((u) => u.kind === "sector-list")
      .map((u) => u.id);
    expect(derived.sort()).toEqual([...SECTOR_IDS].sort());
  });

  it("P05 exchange axis is the four screen filters, alias-preserving", () => {
    expect([...axisIds("exchange")].sort()).toEqual(["all", "amex", "nasdaq", "nyse"]);
    expect(resolveValue("exchange", "ALL")).toEqual({ ok: true, value: "all" });
    expect(resolveValue("exchange", "NYSE")).toEqual({ ok: true, value: "nyse" });
  });

  it("P06 broker and asset axes hold today's values; asset is equity and options only", () => {
    expect([...axisIds("broker")].sort()).toEqual(["alpaca", "etrade", "public", "tastytrade"]);
    expect([...axisIds("asset")].sort()).toEqual(["equity", "options"]);
    // Public has no paper mode — the registry states it, so a subset refuses it.
    expect(resolveJobSubset({ broker: "public", mode: "paper" })).toMatchObject({
      ok: false,
      code: VOCABULARY_CODES.unsupportedPair,
    });
  });

  it("P07 declared conflations refuse by name and point at the right axis", () => {
    const tech = resolveValue("universe", "TECH");
    expect(tech.ok).toBe(false);
    if (tech.ok) throw new Error("unreachable");
    expect(tech.code).toBe(VOCABULARY_CODES.notAValue);
    expect(tech.message).toContain("sector-information-technology");

    const nasdaq = resolveValue("universe", "nasdaq");
    expect(nasdaq.ok).toBe(false);
    if (nasdaq.ok) throw new Error("unreachable");
    expect(nasdaq.message).toContain("data provider");

    // The right axes still accept those values.
    expect(resolveValue("sector", "sector-information-technology")).toEqual({
      ok: true,
      value: "sector-information-technology",
    });
    expect(resolveValue("provider", "nasdaq")).toEqual({ ok: true, value: "nasdaq" });
  });

  it("P08 a job subset resolves declared axes, defaults the absent ones, and refuses the rest", () => {
    expect(resolveJobSubset({ universe: "NASDAQ100", provider: "yahoo", broker: "alpaca", mode: "paper", asset: "equity" })).toMatchObject({
      ok: true,
      value: { universe: "nasdaq100", provider: "yahoo", broker: "alpaca", mode: "paper", asset: "equity" },
    });
    // Absent axes with externalized defaults fill in; axes with no default stay
    // undeclared — a subset names what it needs, nothing is invented.
    const subset = resolveJobSubset({ provider: "yahoo" });
    expect(subset.ok).toBe(true);
    if (!subset.ok) throw new Error("unreachable");
    expect(subset.value).toMatchObject({ provider: "yahoo", broker: "alpaca", mode: "paper" });
    expect(subset.value.universe).toBe("nasdaq100");
    expect(subset.value.dataset).toBeUndefined();
    // A consumer that NEEDS an axis says so, and the refusal names it.
    expect(requireAxis(subset.value, "dataset")).toMatchObject({
      ok: false,
      code: VOCABULARY_CODES.missingDefault,
    });
    // Declared-but-unknown refuses by name, listing the axis's known values.
    const unknown = resolveJobSubset({ provider: "yahoo", universe: "SP900" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.code).toBe(VOCABULARY_CODES.unknownValue);
    expect(unknown.message).toContain("SP900");
    expect(unknown.message).toContain("nasdaq100");
  });

  it("P09 defaults are externalized, not hardcoded: alpaca / paper / equity / nasdaq100", () => {
    expect(vocabularyDefaults()).toEqual({
      broker: "alpaca",
      mode: "paper",
      asset: "equity",
      universe: "nasdaq100",
    });
  });

  it("P10 data, not code: a new provider resolves end-to-end through the seam", () => {
    const vocab = copyOf(getVocabulary());
    expect(axisIds("provider")).not.toContain("finnhub");
    vocab.axes.provider = [...vocab.axes.provider, { id: "finnhub", label: "Finnhub", kind: "pure" }];
    setVocabulary(vocab);
    // A picker renders it and a resolver resolves it — no code change.
    expect(axisIds("provider")).toContain("finnhub");
    expect(resolveValue("provider", "Finnhub")).toEqual({ ok: true, value: "finnhub" });
    expect(resolveJobSubset({ provider: "finnhub", dataset: "news" })).toMatchObject({ ok: true });
  });

  it("P11 an invalid definition is refused, and the previous registry stays in force", () => {
    const duplicate = copyOf(getVocabulary());
    duplicate.axes.asset = [...duplicate.axes.asset, { id: "equity", label: "Equity again" }];
    expect(() => setVocabulary(duplicate)).toThrow(/declares "equity" twice/);
    expect(axisIds("asset")).toEqual(["equity", "options"]);
  });
});
