import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";
import {
  OPTIONS_REPORT_CONFIG,
  describeReportScope,
  resolveOptionsReportScope,
  thesisRunPlan,
} from "../src/trading/optionsReportScope";

/**
 * The report scope is the contract that lets an operator produce one,
 * some, or all of any axis — theses, strategies, chains, formats,
 * channels — without touching code. These tests pin the resolution
 * order (request > env > preset > defaults), the "all" expansion, the
 * never-fail-a-run posture, and the horizon honesty that explains why a
 * long-dated strategy was not evaluated.
 */

describe("options report scope — defaults", () => {
  it("defaults to every thesis, every registry strategy, all formats", () => {
    const scope = resolveOptionsReportScope();
    expect(scope.theses).toEqual(["bullish", "bearish", "range_bound", "large_move"]);
    expect(scope.strategyScope).toBe("all");
    expect(scope.strategyIds).toEqual(defaultRegistry.ids());
    expect(scope.strategyIds.length).toBeGreaterThan(50);
    expect(scope.evaluateAllStrategies).toBe(true);
    expect(scope.formats).toEqual(["pdf", "xlsx", "csv"]);
    expect(scope.channels).toEqual(["ui"]);
    expect(scope.warnings).toEqual([]);
    expect(scope.provenance).toMatchObject({ preset: "full", source: "builtin" });
  });

  it("resolves a three-strategy request to exactly three strategies and keeps the thesis filter", () => {
    const wanted = ["long_call", "put_credit_spread", "iron_condor"];
    const scope = resolveOptionsReportScope({ thesis: "bullish", strategies: wanted });
    expect(scope.strategyScope).toBe("explicit");
    expect(scope.strategyIds.sort()).toEqual([...wanted].sort());
    // An explicit list keeps the historical behavior: only thesis-aligned
    // strategies are judged. Iron condor is range_bound, so it is excluded
    // under a bullish thesis — and named, never silently dropped.
    expect(scope.evaluateAllStrategies).toBe(false);
    expect(scope.thesisExcluded).toEqual(["iron_condor"]);
  });

  it("'all' lifts the thesis filter, which is what a full report needs", () => {
    const scope = resolveOptionsReportScope({ thesis: "bullish", strategies: "all" });
    expect(scope.thesisExcluded).toEqual([]);
    expect(scope.evaluateAllStrategies).toBe(true);
  });
});

describe("options report scope — precedence", () => {
  it("a request wins over a preset", () => {
    const scope = resolveOptionsReportScope({
      preset: "quick",
      theses: ["bearish"],
      strategies: "all",
      formats: ["xlsx"],
    });
    expect(scope.preset).toBe("quick");
    expect(scope.theses).toEqual(["bearish"]);
    expect(scope.strategyIds).toEqual(defaultRegistry.ids());
    expect(scope.formats).toEqual(["xlsx"]);
    expect(scope.provenance.requestOverrides).toEqual(
      expect.arrayContaining(["theses", "strategies", "formats"]),
    );
  });

  it("a preset supplies the axes the request omits", () => {
    const scope = resolveOptionsReportScope({ preset: "quick" });
    expect(scope.theses).toEqual(["bullish"]);
    expect([...scope.strategyIds].sort()).toEqual(["iron_condor", "long_call", "put_credit_spread"]);
    expect(scope.formats).toEqual(["pdf"]);
    expect(scope.content.candidateLimit).toBe(25);
  });

  it("env config patches defaults and the env preset is honored", () => {
    const scope = resolveOptionsReportScope({
      env: {
        OPTIONS_REPORT_PRESET: "thesis",
        OPTIONS_REPORT_CONFIG: JSON.stringify({ content: { candidateLimit: 7 }, channels: ["slack"] }),
      },
    });
    expect(scope.preset).toBe("thesis");
    expect(scope.theses).toEqual(["bullish"]);
    expect(scope.channels).toEqual(["slack"]);
    expect(scope.content.candidateLimit).toBe(7);
    expect(scope.provenance.source).toBe("env");
    expect(scope.provenance.envOverrides).toEqual(expect.arrayContaining(["content", "channels"]));
  });
});

describe("options report scope — never fails a run", () => {
  it("keeps the valid part of a strategy list and reports the unknown ids", () => {
    const scope = resolveOptionsReportScope({ strategies: ["long_call", "not_a_strategy"] });
    expect(scope.strategyIds).toEqual(["long_call"]);
    expect(scope.unknownStrategies).toEqual(["not_a_strategy"]);
    expect(scope.warnings.map((w) => w.axis)).toContain("strategies");
  });

  it("falls back to the full registry when nothing in the list resolves", () => {
    const scope = resolveOptionsReportScope({ strategies: ["nope", "also_nope"] });
    expect(scope.strategyScope).toBe("all");
    expect(scope.strategyIds).toEqual(defaultRegistry.ids());
  });

  it("drops an unknown thesis instead of throwing, and keeps the rest", () => {
    const scope = resolveOptionsReportScope({ theses: ["bullish", "sideways"] });
    expect(scope.theses).toEqual(["bullish"]);
    expect(scope.warnings.find((w) => w.axis === "theses")?.value).toBe("sideways");
  });

  it("ignores malformed env JSON and still resolves a usable scope", () => {
    const scope = resolveOptionsReportScope({ env: { OPTIONS_REPORT_CONFIG: "{not json" } });
    expect(scope.strategyIds).toEqual(defaultRegistry.ids());
    expect(scope.warnings.find((w) => w.axis === "config")).toBeTruthy();
  });

  it("drops unknown formats/channels and keeps the known ones", () => {
    const scope = resolveOptionsReportScope({ formats: ["pdf", "docx"], channels: ["slack", "carrier-pigeon"] });
    expect(scope.formats).toEqual(["pdf"]);
    expect(scope.channels).toEqual(["slack"]);
  });
});

describe("options report scope — chains and horizon honesty", () => {
  it("normalizes and dedupes symbols", () => {
    const scope = resolveOptionsReportScope({ symbols: [" aapl ", "AAPL", "msft"] });
    expect(scope.chains.symbols).toEqual(["AAPL", "MSFT"]);
    expect(scope.chains.source).toBe("run");
  });

  it("widens the fetch band to the catalog horizon so long-dated strategies can run", () => {
    const wide = resolveOptionsReportScope({
      strategies: ["leaps_call", "long_call"],
      dte: { minDte: 0, maxDte: 30, widenToCatalogHorizon: true },
    });
    expect(wide.catalogHorizonDte).toBeGreaterThanOrEqual(365);
    expect(wide.chains.dte.maxDte).toBe(wide.catalogHorizonDte);
    expect(wide.horizonLimited).toEqual([]);
  });

  it("names every strategy the narrow band cannot reach", () => {
    const scope = resolveOptionsReportScope({
      strategies: ["leaps_call", "long_call"],
      dte: { maxDte: 60, widenToCatalogHorizon: false },
    });
    expect(scope.horizonLimited.map((entry) => entry.id)).toEqual(["leaps_call"]);
    expect(scope.horizonLimited[0].horizonDte).toBeGreaterThan(60);
    expect(scope.horizonLimited[0].label).toBeTruthy();
  });

  it("repairs an inverted DTE band and says so", () => {
    const scope = resolveOptionsReportScope({ dte: { minDte: 90, maxDte: 30 } });
    expect(scope.chains.dte.maxDte).toBeGreaterThanOrEqual(scope.chains.dte.minDte);
    expect(scope.warnings.map((w) => w.axis)).toContain("chains");
  });
});

describe("options report scope — execution plan and description", () => {
  it("plans one execution per thesis with the shared fetch band", () => {
    const scope = resolveOptionsReportScope({ theses: ["bullish", "bearish"] });
    const plan = thesisRunPlan(scope);
    expect(plan.map((entry) => entry.thesis)).toEqual(["bullish", "bearish"]);
    for (const entry of plan) {
      expect(entry.fetchBand).toEqual({ minDte: scope.chains.dte.minDte, maxDte: scope.chains.dte.maxDte });
      expect(entry.alignedStrategyIds.length).toBeGreaterThan(0);
      expect(entry.alignedStrategyIds.length).toBeLessThanOrEqual(scope.strategyIds.length);
    }
  });

  it("describes what the run covers, including the horizon gap", () => {
    const scope = resolveOptionsReportScope({
      preset: "thesis",
      strategies: ["leaps_call", "long_call"],
      symbols: ["AAPL"],
      dte: { maxDte: 60 },
    });
    const text = describeReportScope(scope);
    expect(text).toContain("thesis");
    expect(text).toContain("AAPL");
    expect(text).toContain("DTE auto–60");
    expect(text).toContain("need expiries beyond 60 DTE");
  });
});

describe("options report config", () => {
  it("declares the vocabularies the resolver enforces", () => {
    expect(OPTIONS_REPORT_CONFIG.allowed.theses).toEqual(["bullish", "bearish", "range_bound", "large_move"]);
    expect(OPTIONS_REPORT_CONFIG.allowed.formats).toEqual(["pdf", "xlsx", "csv"]);
    expect(OPTIONS_REPORT_CONFIG.allowed.presets).toEqual(expect.arrayContaining(["full", "thesis", "quick"]));
    for (const preset of OPTIONS_REPORT_CONFIG.allowed.presets) {
      expect(OPTIONS_REPORT_CONFIG.presets[preset]).toBeTruthy();
    }
  });
});
