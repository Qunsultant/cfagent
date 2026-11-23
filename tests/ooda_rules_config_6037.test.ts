/**
 * Issue #6037 (a) (sub-issue level: the rules seam) — one declared, validated,
 * versioned block for the OODA strategy rules.
 *
 * This slice moves **no decision**: every default equals the literal the issue's
 * table cites, and the pipeline keeps reading its literals until (b)/(c). What
 * lands here is the seam the later slices write through, plus the two
 * invariants that make a report reproducible:
 *
 *  R1  one declaration — key, bounds, default — and every default equals
 *      today's literal (the behaviour-neutral proof);
 *  R2  a stored block is merged over the defaults and validated: an unknown
 *      rule, a non-number, an out-of-bounds value, an inverted DTE window, a
 *      weight sum that is not 1 and an inverted breakeven band each refuse by
 *      name;
 *  R3  `ResearchConfig.rules` persists the block through the existing settings
 *      store, and `validateResearchConfig` judges it with the same validator;
 *  R4  a rules change without a `rulesVersion` bump is refused atomically —
 *      the version is the audit key a report names;
 *  R5  the report snapshot carries both the version and the resolved values.
 */
import { describe, it, expect } from "vitest";
import {
  RESEARCH_RULE_BOUNDS,
  RESEARCH_RULES_DEFAULTS,
  isDefaultResearchRules,
  resolveResearchRules,
  validateResearchRules,
} from "../src/config/researchRules";
import {
  RESEARCH_CONFIG_DEFAULTS,
  RESEARCH_CONFIG_SCHEMA,
  ResearchConfigService,
  validateResearchConfig,
  type ResearchConfig,
} from "../src/services/researchConfig";

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    store: {
      get: (key: string) => map.get(key) ?? null,
      set: (key: string, value: string) => void map.set(key, value),
    },
  };
}

describe("#6037 (a) — the rules block is one declaration", () => {
  it("R1: every default equals the literal the issue cites (behaviour-neutral)", () => {
    // The issue's table, value by value.
    expect(RESEARCH_RULES_DEFAULTS.pmccLongLegMinDte).toBe(180);
    expect(RESEARCH_RULES_DEFAULTS.structureTargetDteMin).toBe(30);
    expect(RESEARCH_RULES_DEFAULTS.structureTargetDteMax).toBe(45);
    expect(RESEARCH_RULES_DEFAULTS.verticalWidthPct).toBe(0.05);
    expect(RESEARCH_RULES_DEFAULTS.pmccMoneyness).toBe(0.9);
    expect(RESEARCH_RULES_DEFAULTS.butterflyBodyTolerancePct).toBe(0.02);
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightThesis).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightLiquidity).toBe(0.35);
    expect(RESEARCH_RULES_DEFAULTS.scoreWeightRewardRisk).toBe(0.25);
    expect(RESEARCH_RULES_DEFAULTS.nonLiveProvenancePenalty).toBe(-1);
    expect(RESEARCH_RULES_DEFAULTS.eventRiskPenalty).toBe(0.15);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthBase).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthStrong).toBe(0.55);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthVeryStrong).toBe(0.6);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthPerConfirmation).toBe(0.1);
    expect(RESEARCH_RULES_DEFAULTS.thesisStrengthCap).toBe(1);
    expect(RESEARCH_RULES_DEFAULTS.trackRecordWeakBelow).toBe(0.4);
    expect(RESEARCH_RULES_DEFAULTS.trackRecordStrongAbove).toBe(0.6);
    expect(RESEARCH_RULES_DEFAULTS.candidatePreScreenMultiplier).toBe(3);
    expect(RESEARCH_RULES_DEFAULTS.breakevenToleranceLower).toBe(0.98);
    expect(RESEARCH_RULES_DEFAULTS.breakevenToleranceUpper).toBe(1.02);
    // Every rule has bounds, and the empty block resolves to the defaults.
    for (const key of Object.keys(RESEARCH_RULES_DEFAULTS) as Array<keyof typeof RESEARCH_RULES_DEFAULTS>) {
      expect(RESEARCH_RULE_BOUNDS[key]).toBeTruthy();
    }
    expect(resolveResearchRules({})).toEqual(RESEARCH_RULES_DEFAULTS);
    expect(isDefaultResearchRules(resolveResearchRules({}))).toBe(true);
  });

  it("R2: a stored block merges over the defaults and every bad value refuses by name", () => {
    const merged = validateResearchRules({ verticalWidthPct: 0.03 });
    expect(merged.errors).toEqual([]);
    expect(merged.rules.verticalWidthPct).toBe(0.03);
    expect(merged.rules.pmccLongLegMinDte).toBe(180);

    expect(validateResearchRules({ nonsense: 1 }).errors[0]).toMatch(/Unknown research rule "nonsense"/);
    expect(validateResearchRules({ verticalWidthPct: "wide" }).errors[0]).toMatch(/must be a finite number/);
    expect(validateResearchRules({ verticalWidthPct: 0.7 }).errors[0]).toMatch(/within \[0.001, 0.5\]/);
    expect(
      validateResearchRules({ structureTargetDteMin: 60, structureTargetDteMax: 45 }).errors[0],
    ).toMatch(/must not exceed/);
    expect(validateResearchRules({ scoreWeightThesis: 0.8 }).errors[0]).toMatch(/must sum to 1/);
    expect(
      validateResearchRules({ breakevenToleranceLower: 1.05, breakevenToleranceUpper: 1.02 }).errors[0],
    ).toMatch(/must not exceed/);
    // Unknown keys are never merged in.
    expect("nonsense" in validateResearchRules({ nonsense: 1 }).rules).toBe(false);
  });

  it("R3: the block persists through the existing settings store and the config validator judges it", () => {
    const { map, store } = memoryStore();
    const service = new ResearchConfigService(store);
    const saved = service.save({ rules: { verticalWidthPct: 0.03 }, rulesVersion: "1.0.1" });
    expect(saved.errors).toEqual([]);
    expect(map.get("research.rules")).toBe(JSON.stringify({ verticalWidthPct: 0.03 }));
    const loaded = new ResearchConfigService(store).load();
    expect(loaded.rules).toEqual({ verticalWidthPct: 0.03 });
    expect(loaded.rulesVersion).toBe("1.0.1");

    // The same validator refuses an invalid stored block at the config level.
    const errors = validateResearchConfig({
      ...RESEARCH_CONFIG_DEFAULTS,
      rules: { verticalWidthPct: 0.7 },
    } as ResearchConfig);
    expect(errors.join(" ")).toMatch(/rules\.verticalWidthPct/);
    // A structured block is not a scalar form row: like `stageModes`, it is
    // edited by its own control, so the scalar schema lists neither.
    const schemaKeys = RESEARCH_CONFIG_SCHEMA.map((f) => f.key as string);
    expect(schemaKeys).not.toContain("rules");
    expect(schemaKeys).not.toContain("stageModes");
    // The empty block is the default: every rule takes its declared value.
    expect(RESEARCH_CONFIG_DEFAULTS.rules).toEqual({});
  });

  it("R4: a rules change without a version bump is refused, and nothing is written", () => {
    const { map, store } = memoryStore();
    const service = new ResearchConfigService(store);
    const refused = service.save({ rules: { verticalWidthPct: 0.03 } });
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/bump rulesVersion/);
    expect(map.size).toBe(0);

    // A no-op save of the same block is not a change, so it needs no bump.
    const bumped = service.save({ rules: { verticalWidthPct: 0.03 }, rulesVersion: "1.0.1" });
    expect(bumped.errors).toEqual([]);
    const same = new ResearchConfigService(store).save({ rules: { verticalWidthPct: 0.03 } });
    expect(same.errors).toEqual([]);
  });

  it("R5: the report snapshot carries the version and the resolved values", () => {
    const { store } = memoryStore();
    const service = new ResearchConfigService(store);
    service.save({ rules: { verticalWidthPct: 0.03 }, rulesVersion: "2.0.0" });
    const snapshot = service.snapshot(service.load());
    expect(snapshot.rulesVersion).toBe("2.0.0");
    expect(snapshot.rules).toEqual({ verticalWidthPct: 0.03 });
  });
});
