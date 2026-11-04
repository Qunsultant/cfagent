/**
 * Issue #2604 — the #2764 preset rule applied to the options report scope:
 * the resolver stays total (its #2577 contract), but it MARKS a scope it
 * could not honour, and a caller about to RUN must refuse instead of
 * defaulting the preset or widening a dead strategy list to every strategy.
 */
import { describe, expect, it } from "vitest";
import { defaultOptionsReportScope, resolveOptionsReportScope } from "../src/trading/optionsReportScope";
import { strategyModeFromReportScope } from "../src/trading/options/strategyChoice";

describe("a scope that cannot be honoured is marked, not silently defaulted (#2604)", () => {
  it("marks an unknown stored preset", () => {
    const scope = resolveOptionsReportScope({ preset: "no-such-preset" });
    expect(scope.invalidPreset).toBe("no-such-preset");
    // The resolver stays total (#2577): it still returns a usable scope.
    expect(scope.preset).toBeTruthy();
    expect(scope.warnings.some((w) => w.axis === "presets")).toBe(true);
  });

  it("marks an explicit strategy list that resolved to nothing (the all-scope hazard)", () => {
    const scope = resolveOptionsReportScope({ strategies: ["nope", "also_nope"] });
    expect(scope.invalidStrategyList).toEqual(["nope", "also_nope"]);
    // Compatibility: the widened set is still returned, but it is marked.
    expect(scope.strategyScope).toBe("all");
  });

  it("does NOT mark an explicit all-strategy scope (a choice, not a fallback)", () => {
    const scope = resolveOptionsReportScope({ strategies: "all" });
    expect(scope.invalidStrategyList).toBeNull();
    expect(scope.invalidPreset).toBeNull();
    expect(scope.strategyScope).toBe("all");
  });

  it("does NOT mark a valid preset or a partially-known list", () => {
    const valid = resolveOptionsReportScope({ strategies: ["covered_call", "nope"] });
    expect(valid.invalidStrategyList).toBeNull();
    expect(valid.strategyScope).toBe("explicit");
    const noStoredScope = defaultOptionsReportScope();
    expect(noStoredScope.invalidPreset).toBeNull();
    expect(noStoredScope.invalidStrategyList).toBeNull();
  });
});

describe("no stored mode never becomes an all-scope silently (#2604)", () => {
  it("maps an explicit scope to the thesis mode", () => {
    expect(strategyModeFromReportScope("explicit")).toBe("thesis");
  });

  it("maps only an explicitly-all scope to the all mode", () => {
    expect(strategyModeFromReportScope("all")).toBe("all");
  });

  it("a marked fallback is distinguishable from a chosen all", () => {
    const chosen = resolveOptionsReportScope({ strategies: "all" });
    const fallback = resolveOptionsReportScope({ strategies: ["nope"] });
    expect(chosen.strategyScope).toBe(fallback.strategyScope); // both "all"…
    expect(chosen.invalidStrategyList).toBeNull();
    expect(fallback.invalidStrategyList).not.toBeNull(); // …but only one is honest
  });
});
