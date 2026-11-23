/**
 * Issue #6037 (b) — the structure-selection rules are read, not literals.
 *
 * The seam landed in #6310 (`src/config/researchRules.ts`); this is the slice
 * that makes it live. Five values moved out of `researchPipeline.ts`: the PMCC
 * long-leg minimum DTE (180), the vertical target DTE window (30/45), the
 * vertical width (5%), the PMCC moneyness (0.9) and the butterfly body
 * tolerance (2%).
 *
 * What this file pins — deliberately the parts that need no chain fixture:
 *
 *  B1  **behaviour is unchanged at the defaults**: every default equals the
 *      literal the pipeline used, and the PMCC duplicate the issue names is
 *      cross-checked against the strategy catalogue's `farMinDte` (one
 *      declaration, not two).
 *  B3  **the literals are gone from the decision path**, and the pipeline reads
 *      the block by key — the grep pin that stops one from creeping back.
 *
 * The builders' behaviour at the defaults is covered by the existing suites
 * (`research-pipeline`, `research-pmcc-window`, `iv_defaults_removed_926`),
 * which run unchanged in CI: if a default had moved, they would fail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RESEARCH_RULES_DEFAULTS } from "../src/config/researchRules";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";

describe("#6037 (b) — the structure-selection rules are data", () => {
  it("B1: every default equals the literal the pipeline used", () => {
    expect(RESEARCH_RULES_DEFAULTS.pmccLongLegMinDte).toBe(180);
    expect(RESEARCH_RULES_DEFAULTS.structureTargetDteMin).toBe(30);
    expect(RESEARCH_RULES_DEFAULTS.structureTargetDteMax).toBe(45);
    expect(RESEARCH_RULES_DEFAULTS.verticalWidthPct).toBe(0.05);
    expect(RESEARCH_RULES_DEFAULTS.pmccMoneyness).toBe(0.9);
    expect(RESEARCH_RULES_DEFAULTS.butterflyBodyTolerancePct).toBe(0.02);
  });

  it("B1: the PMCC long-leg minimum has one declaration, cross-checked against the strategy", () => {
    const pmcc = defaultRegistry.get("poor_mans_covered_call");
    expect(pmcc).toBeTruthy();
    // The strategy declares the far-leg floor as `requiredMaxDte` (built from
    // its `farMinDte: 180`). The pipeline no longer restates it: it reads the
    // rules block, whose default must equal the strategy's own number.
    expect(pmcc!.requiredMaxDte).toBe(RESEARCH_RULES_DEFAULTS.pmccLongLegMinDte);
  });

  it("B3: no structure-selection literal is left in the pipeline", () => {
    const source = readFileSync("src/services/researchPipeline.ts", "utf8");
    expect(source).not.toMatch(/const PMCC_LONG_LEG_MIN_DTE/);
    expect(source).not.toMatch(/const widthPct = 0\.05/);
    expect(source).not.toMatch(/spot \* 0\.9\b/);
    expect(source).not.toMatch(/config\.minDte, 30, 45/);
    expect(source).not.toMatch(/\/ spot < 0\.02\b/);
  });

  it("B3: the pipeline reads the block by key, for all five rules", () => {
    const source = readFileSync("src/services/researchPipeline.ts", "utf8");
    for (const key of [
      "pmccLongLegMinDte",
      "structureTargetDteMin",
      "structureTargetDteMax",
      "verticalWidthPct",
      "pmccMoneyness",
      "butterflyBodyTolerancePct",
    ]) {
      expect(source, key).toContain(`rules.${key}`);
    }
    // One resolver call per entry point, not a second merge.
    expect(source).toContain("resolveResearchRules(config.rules)");
  });
});
