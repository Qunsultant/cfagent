/**
 * Issue #6037 (a) — the OODA strategy rules as one declared, validated block.
 *
 * Twelve numbers inside `src/services/researchPipeline.ts` decide which
 * structures are built, how candidates rank and which thesis wins. They are
 * literals in the decision path, so a report cannot be reproduced (the snapshot
 * carries the filter config, not these values) and tuning is a deploy.
 *
 * Slice (a) is the seam only, exactly as the issue stages it: one declaration
 * of every rule — key, bounds, default — a resolver that merges the stored
 * block over the defaults and validates it, and the version stamp that
 * `ResearchConfig.rulesVersion` already carries. **No default changes and no
 * decision moves in this slice**: the pipeline reads these values in slices
 * (b) structure selection and (c) scoring/thesis, which must each pin "same
 * output at default values". Until then the literals stay where they are; the
 * grep pin in (b)/(c) is what removes them.
 *
 * Why a block instead of twelve settings: the issue's rule is "a rule is
 * declared once: key, type, bounds, default — and read by key", and the whole
 * block is one versioned artifact so a report can say which rules it ran under.
 */

export interface ResearchRules {
  /** Structure selection. */
  /** Minimum DTE for a PMCC long leg (the strategy's `farMinDte`). */
  pmccLongLegMinDte: number;
  /** The vertical's target DTE window, inclusive. */
  structureTargetDteMin: number;
  structureTargetDteMax: number;
  /** Strike width as a fraction of spot (0.05 = 5%). */
  verticalWidthPct: number;
  /** PMCC long-call moneyness: long strike = spot * this (0.9 = 10% ITM). */
  pmccMoneyness: number;
  /** Butterfly body window as a fraction of spot (0.02 = 2%). */
  butterflyBodyTolerancePct: number;
  /** Scoring. */
  scoreWeightThesis: number;
  scoreWeightLiquidity: number;
  scoreWeightRewardRisk: number;
  /** Score subtracted when the chain is not live-provenance. */
  nonLiveProvenancePenalty: number;
  /** Score subtracted for event risk. */
  eventRiskPenalty: number;
  /** Thesis strength ladder. */
  thesisStrengthBase: number;
  thesisStrengthStrong: number;
  thesisStrengthVeryStrong: number;
  /** Added per confirmation, capped at `thesisStrengthCap`. */
  thesisStrengthPerConfirmation: number;
  thesisStrengthCap: number;
  /** Track-record reordering: below → last, above → first. */
  trackRecordWeakBelow: number;
  trackRecordStrongAbove: number;
  /** Pre-screen: how many candidates get a full chain fetch (x maxCandidates). */
  candidatePreScreenMultiplier: number;
  /** Evaluation: the "moved past breakeven" band. */
  breakevenToleranceLower: number;
  breakevenToleranceUpper: number;
}

/**
 * Today's values, verbatim from the pipeline (the issue's table). Changing any
 * of these is a strategy change and bumps the rules version — slice (a) proves
 * the defaults are unchanged, which is what makes the release behaviour-neutral.
 */
export const RESEARCH_RULES_DEFAULTS: ResearchRules = {
  pmccLongLegMinDte: 180,
  structureTargetDteMin: 30,
  structureTargetDteMax: 45,
  verticalWidthPct: 0.05,
  pmccMoneyness: 0.9,
  butterflyBodyTolerancePct: 0.02,
  scoreWeightThesis: 0.4,
  scoreWeightLiquidity: 0.35,
  scoreWeightRewardRisk: 0.25,
  nonLiveProvenancePenalty: -1,
  eventRiskPenalty: 0.15,
  thesisStrengthBase: 0.4,
  thesisStrengthStrong: 0.55,
  thesisStrengthVeryStrong: 0.6,
  thesisStrengthPerConfirmation: 0.1,
  thesisStrengthCap: 1,
  trackRecordWeakBelow: 0.4,
  trackRecordStrongAbove: 0.6,
  candidatePreScreenMultiplier: 3,
  breakevenToleranceLower: 0.98,
  breakevenToleranceUpper: 1.02,
};

/** Inclusive numeric bounds per rule; a value outside refuses by name. */
export const RESEARCH_RULE_BOUNDS: Record<keyof ResearchRules, { min: number; max: number }> = {
  pmccLongLegMinDte: { min: 1, max: 730 },
  structureTargetDteMin: { min: 1, max: 730 },
  structureTargetDteMax: { min: 1, max: 730 },
  verticalWidthPct: { min: 0.001, max: 0.5 },
  pmccMoneyness: { min: 0.5, max: 1 },
  butterflyBodyTolerancePct: { min: 0.001, max: 0.25 },
  scoreWeightThesis: { min: 0, max: 1 },
  scoreWeightLiquidity: { min: 0, max: 1 },
  scoreWeightRewardRisk: { min: 0, max: 1 },
  nonLiveProvenancePenalty: { min: -10, max: 0 },
  eventRiskPenalty: { min: 0, max: 10 },
  thesisStrengthBase: { min: 0, max: 1 },
  thesisStrengthStrong: { min: 0, max: 1 },
  thesisStrengthVeryStrong: { min: 0, max: 1 },
  thesisStrengthPerConfirmation: { min: 0, max: 1 },
  thesisStrengthCap: { min: 0, max: 1 },
  trackRecordWeakBelow: { min: 0, max: 1 },
  trackRecordStrongAbove: { min: 0, max: 1 },
  candidatePreScreenMultiplier: { min: 1, max: 20 },
  breakevenToleranceLower: { min: 0, max: 2 },
  breakevenToleranceUpper: { min: 0, max: 2 },
};

const RULE_KEYS = Object.keys(RESEARCH_RULES_DEFAULTS) as Array<keyof ResearchRules>;

/**
 * Issue #6037 (d) — the canonical text a report's rules row carries: every
 * rule, sorted by key, so two reports with the same values compare equal and
 * a reader can see exactly what the run decided under.
 */
export function canonicalResearchRulesJson(
  rules: ResearchRules | null | undefined,
): string {
  if (!rules) return "";
  const sorted = [...RULE_KEYS].sort();
  return JSON.stringify(
    Object.fromEntries(sorted.map((key) => [key, rules[key]])),
  );
}

/** The weights are one fact: they must sum to 1 (a 0.001 tolerance). */
const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * Validate one stored rules block and return it merged over the defaults.
 * Unknown keys and out-of-bound values refuse **by name** with the accepted
 * range — a typo can never quietly change a decision, and nothing is invented.
 */
export function validateResearchRules(parsed: unknown): {
  rules: ResearchRules;
  errors: string[];
} {
  const rules: ResearchRules = { ...RESEARCH_RULES_DEFAULTS };
  const errors: string[] = [];
  if (parsed === null || parsed === undefined) return { rules, errors };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rules, errors: ["rules must be an object keyed by research rule name."] };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const known = (RULE_KEYS as string[]).includes(key);
    if (!known) {
      errors.push(
        `Unknown research rule "${key}". Expected one of: ${RULE_KEYS.join(", ")}`,
      );
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`rules.${key} must be a finite number.`);
      continue;
    }
    const bound = RESEARCH_RULE_BOUNDS[key as keyof ResearchRules];
    if (value < bound.min || value > bound.max) {
      errors.push(`rules.${key} must be within [${bound.min}, ${bound.max}]; got ${value}.`);
      continue;
    }
    rules[key as keyof ResearchRules] = value;
  }
  if (rules.structureTargetDteMin > rules.structureTargetDteMax) {
    errors.push(
      `rules.structureTargetDteMin (${rules.structureTargetDteMin}) must not exceed rules.structureTargetDteMax (${rules.structureTargetDteMax}).`,
    );
  }
  const weightSum =
    rules.scoreWeightThesis + rules.scoreWeightLiquidity + rules.scoreWeightRewardRisk;
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    errors.push(
      `rules.scoreWeightThesis + scoreWeightLiquidity + scoreWeightRewardRisk must sum to 1; got ${weightSum}.`,
    );
  }
  if (rules.breakevenToleranceLower > rules.breakevenToleranceUpper) {
    errors.push(
      `rules.breakevenToleranceLower (${rules.breakevenToleranceLower}) must not exceed rules.breakevenToleranceUpper (${rules.breakevenToleranceUpper}).`,
    );
  }
  return { rules, errors };
}

/** The resolved block a run reads; throws the first refusal (fail closed). */
export function resolveResearchRules(parsed: unknown): ResearchRules {
  const { rules, errors } = validateResearchRules(parsed);
  if (errors.length > 0) throw new Error(errors[0]);
  return rules;
}

/**
 * True when a stored block is behaviourally identical to the defaults — the
 * proof slice (a) publishes, and the condition under which a version bump is
 * not required.
 */
export function isDefaultResearchRules(rules: ResearchRules): boolean {
  return RULE_KEYS.every((key) => rules[key] === RESEARCH_RULES_DEFAULTS[key]);
}
