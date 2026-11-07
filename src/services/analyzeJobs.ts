/**
 * Issue #3537 (Pipeline J4, epic #3533) — analyze jobs: the
 * contract, the registry, the computation, and the run/read/
 * status service. The second hand-off of the pipeline: an
 * analyze job reads the PERSISTED enriched dataset its enrich
 * job produced (with its provenance — enrichedDatasetPorts),
 * applies the DETERMINISTIC rule sets its externalized
 * configuration names, and persists the analyzed dataset
 * (analyzedDatasetPorts) for the generate stage.
 *
 * Determinism (the platform's rule): the computation is a
 * pure function of the persisted enriched artifact and the
 * configuration — no LLM, no live fetch, no clock reads
 * inside the computation. Identical input + identical
 * configuration ⇒ identical output; replay never re-derives
 * from a different copy.
 *
 * Honesty rules (the platform's, carried from #3530/#3536):
 * - A read NEVER fetches: this module has no provider in its
 *   inputs. The input is resolved from the enriched-dataset
 *   store by the producing enrich job's id — exact lineage.
 * - A rule set the persisted features cannot support for a
 *   symbol is recorded as UNAVAILABLE with a coded reason —
 *   never a fabricated verdict. A feature absent because the
 *   enrich job did not compute its element is a different
 *   reason from a feature the enrich run recorded as
 *   unavailable — both are named, not conflated.
 * - A missing persisted input refuses BY NAME
 *   (ANALYZE_INPUT_MISSING, fail-closed): the failed run is
 *   recorded on the analyzed store and returned, never a
 *   silent empty success.
 *
 * Run outcomes are RETURNED, not thrown — the run record is
 * the job's state (the #3530 idiom). Only contract violations
 * throw (unknown job id — a caller bug; an unknown rule-set
 * or threshold name in configuration — a configuration bug).
 */
import { scrubFailureMessage, type DataProviderId, type IndexId } from "../trading";
import {
  type EnrichedDatasetArtifact,
  type EnrichedDatasetRow,
  type EnrichedDatasetStore,
} from "../data/enrichedDatasetPorts";
import {
  type AnalyzedDatasetArtifact,
  type AnalyzedDatasetStore,
  type AnalyzedRuleGap,
} from "../data/analyzedDatasetPorts";
import { buildEnrichJobRegistry } from "./enrichJobs";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/analyzeJobs",
});

/** Stable coded errors for analyze-job outcomes (externalized vocabulary). */
export const ANALYZE_JOB_CODES = {
  jobNotFound: "ANALYZE_JOB_NOT_FOUND",
  inputMissing: "ANALYZE_INPUT_MISSING",
  ruleSetUnknown: "ANALYZE_RULE_SET_UNKNOWN",
  thresholdUnknown: "ANALYZE_THRESHOLD_UNKNOWN",
} as const;
export type AnalyzeJobCode = (typeof ANALYZE_JOB_CODES)[keyof typeof ANALYZE_JOB_CODES];

/** Stable log event code for a failed analyze run (codes + counts only). */
export const ANALYZE_JOB_RUN_FAILED = "analyze_job_run_failed";

export class AnalyzeJobError extends Error {
  readonly code: AnalyzeJobCode;
  constructor(code: AnalyzeJobCode, message: string) {
    super(message);
    this.name = "AnalyzeJobError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* The rule-set vocabulary                                             */
/* ------------------------------------------------------------------ */

/**
 * The deterministic rule sets an analyze job may apply. Each
 * reads named features off the persisted enriched rows and
 * writes a signal label + a score in [-100, 100]:
 * - momentum: the day-move feature — direction and strength.
 * - range: position in the 52-week range (or the Bollinger
 *   %B the enrich stage derived) — where price sits.
 * - volume: relative volume — conviction behind the move.
 * - value: analyst upside (fundamentals join) or the
 *   screening value zone — price versus value.
 */
export const ANALYZE_RULE_SETS = ["momentum", "range", "volume", "value"] as const;
export type AnalyzeRuleSet = (typeof ANALYZE_RULE_SETS)[number];

export const ANALYZE_ALL_RULE_SETS: readonly string[] = [...ANALYZE_RULE_SETS];

/** Coded gap reasons (externalized vocabulary). */
export const ANALYZE_GAP_REASONS = {
  /** The feature the rule set reads is not on the enriched
   *  row at all — the enrich job was not configured to
   *  compute its element. */
  featureNotInArtifact: "feature_not_in_artifact",
  /** The enrich run recorded the producing element as
   *  unavailable for this symbol (the reason rides the
   *  enriched artifact's own gaps). */
  elementUnavailableInInput: "element_unavailable_in_input",
} as const;

/** Validate a configured rule-set list; an unknown name is a
 *  configuration error, refused by name (never silently dropped). */
export function validateAnalyzeRuleSets(ruleSets: readonly string[]): string[] {
  const out: string[] = [];
  for (const ruleSet of ruleSets) {
    if (!ANALYZE_ALL_RULE_SETS.includes(ruleSet)) {
      throw new AnalyzeJobError(
        ANALYZE_JOB_CODES.ruleSetUnknown,
        `Unknown analyze rule set "${ruleSet}". Known rule sets: ${ANALYZE_ALL_RULE_SETS.join(", ")}.`,
      );
    }
    if (!out.includes(ruleSet)) out.push(ruleSet);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Thresholds — configuration, not literals                            */
/* ------------------------------------------------------------------ */

/**
 * The rule thresholds + composite weights. Defaults live here
 * (one named home); a job's step params override individual
 * keys (the definition IS the externalized configuration —
 * the pipeline plane's configureJob changes them without a
 * deploy).
 */
export interface AnalyzeThresholds {
  /** |momentum %| at/above which the move is "strong". */
  strongMovePercent: number;
  /** |momentum %| at/above which the move is directional at all. */
  mildMovePercent: number;
  /** Range position at/above which price is "near_high". */
  nearHighPosition: number;
  /** Range position at/above which price is "upper". */
  upperPosition: number;
  /** Range position at/above which price is "lower" (below ⇒ "near_low"). */
  lowerPosition: number;
  /** Relative volume at/above which volume is a "surge". */
  surgeVolumeRatio: number;
  /** Relative volume at/above which volume is "elevated". */
  elevatedVolumeRatio: number;
  /** Relative volume below which volume is "quiet". */
  quietVolumeRatio: number;
  /** Analyst upside % at/above which value is "deep_value". */
  deepValueUpsidePercent: number;
  /** Analyst upside % at/above which value is "undervalued". */
  undervaluedUpsidePercent: number;
  /** Analyst upside % at/below which value is "overvalued". */
  overvaluedUpsidePercent: number;
  /** Composite weights per rule set (the composite is the
   *  weighted mean over the rule sets that evaluated). */
  weights: Record<AnalyzeRuleSet, number>;
}

export const ANALYZE_DEFAULT_THRESHOLDS: AnalyzeThresholds = {
  strongMovePercent: 5,
  mildMovePercent: 1,
  nearHighPosition: 0.9,
  upperPosition: 0.7,
  lowerPosition: 0.1,
  surgeVolumeRatio: 2,
  elevatedVolumeRatio: 1.5,
  quietVolumeRatio: 0.7,
  deepValueUpsidePercent: 25,
  undervaluedUpsidePercent: 10,
  overvaluedUpsidePercent: -10,
  weights: { momentum: 1, range: 1, volume: 1, value: 1 },
};

const NUMERIC_THRESHOLD_KEYS = [
  "strongMovePercent",
  "mildMovePercent",
  "nearHighPosition",
  "upperPosition",
  "lowerPosition",
  "surgeVolumeRatio",
  "elevatedVolumeRatio",
  "quietVolumeRatio",
  "deepValueUpsidePercent",
  "undervaluedUpsidePercent",
  "overvaluedUpsidePercent",
] as const;

/** Merge a configured threshold override over the defaults;
 *  an unknown key or a non-finite value is a configuration
 *  error, refused by name. */
export function resolveAnalyzeThresholds(
  override?: Partial<Record<string, unknown>> | null,
): AnalyzeThresholds {
  const out: AnalyzeThresholds = {
    ...ANALYZE_DEFAULT_THRESHOLDS,
    weights: { ...ANALYZE_DEFAULT_THRESHOLDS.weights },
  };
  if (!override) return out;
  for (const [key, value] of Object.entries(override)) {
    if (key === "weights") {
      if (typeof value !== "object" || value === null) {
        throw new AnalyzeJobError(
          ANALYZE_JOB_CODES.thresholdUnknown,
          `Analyze threshold "weights" must be an object of rule-set weights.`,
        );
      }
      for (const [ruleSet, weight] of Object.entries(value as Record<string, unknown>)) {
        if (!ANALYZE_ALL_RULE_SETS.includes(ruleSet)) {
          throw new AnalyzeJobError(
            ANALYZE_JOB_CODES.thresholdUnknown,
            `Unknown analyze composite weight "${ruleSet}". Known rule sets: ${ANALYZE_ALL_RULE_SETS.join(", ")}.`,
          );
        }
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
          throw new AnalyzeJobError(
            ANALYZE_JOB_CODES.thresholdUnknown,
            `Analyze composite weight "${ruleSet}" must be a finite number >= 0.`,
          );
        }
        out.weights[ruleSet as AnalyzeRuleSet] = weight;
      }
      continue;
    }
    if (!(NUMERIC_THRESHOLD_KEYS as readonly string[]).includes(key)) {
      throw new AnalyzeJobError(
        ANALYZE_JOB_CODES.thresholdUnknown,
        `Unknown analyze threshold "${key}". Known thresholds: ${NUMERIC_THRESHOLD_KEYS.join(", ")}, weights.`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AnalyzeJobError(
        ANALYZE_JOB_CODES.thresholdUnknown,
        `Analyze threshold "${key}" must be a finite number.`,
      );
    }
    (out as unknown as Record<string, number>)[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The contract + registry                                             */
/* ------------------------------------------------------------------ */

/**
 * The analyze-job contract: the enrich job whose persisted
 * dataset it consumes, the rule sets it applies, and its
 * cadence/freshness knobs (config-resolved, see
 * buildAnalyzeJobRegistry — never literals at call sites).
 */
export interface AnalyzeJobDefinition {
  id: string;
  /** The enrich job whose persisted dataset is the input. */
  enrichJobId: string;
  /** The feed job at the head of this job's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source ("quotes"). */
  dataset: string;
  universe: { kind: "index"; index: IndexId; label: string };
  /** The rule sets this job applies by default (the pipeline
   *  definition's step params may override per configuration). */
  ruleSets: readonly string[];
  /** Declared cadence — the scheduling slice's input. */
  cadenceMinutes: number;
  /** Age past which the stored analyzed copy is labelled stale. */
  staleAfterMinutes: number;
}

/**
 * The analyze-job registry — the EnrichJobRegistry idiom
 * (unique ids, re-registering throws so provenance ids stay
 * unambiguous; explicit resolution failure, no silent fallback).
 */
export class AnalyzeJobRegistry {
  private jobs = new Map<string, AnalyzeJobDefinition>();

  register(job: AnalyzeJobDefinition): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Analyze job "${job.id}" is already registered.`);
    }
    this.jobs.set(job.id, job);
  }

  get(id: string): AnalyzeJobDefinition | undefined {
    return this.jobs.get(id);
  }

  list(): AnalyzeJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  /** The analyze job consuming an enrich job's dataset, if one is registered. */
  forEnrichJob(enrichJobId: string): AnalyzeJobDefinition | undefined {
    return this.list().find((j) => j.enrichJobId === enrichJobId);
  }
}

/* ------------------------------------------------------------------ */
/* Cadence / freshness / rule-set knobs — config, not literals.        */
/* ANALYZE_JOB_<JOB_ID>_CADENCE_MINUTES / _STALE_MINUTES / _RULE_SETS  */
/* ------------------------------------------------------------------ */

function knobKey(jobId: string, suffix: string): string {
  return `ANALYZE_JOB_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function resolveMinutesKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
  fallback: number,
): number {
  const raw = env[knobKey(jobId, suffix)];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRuleSetsKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  fallback: readonly string[],
): string[] {
  const raw = env[knobKey(jobId, "RULE_SETS")];
  if (typeof raw !== "string" || !raw.trim()) return [...fallback];
  return validateAnalyzeRuleSets(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

export const ANALYZE_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/** The default rule-set configuration: every rule set. */
export const ANALYZE_DEFAULT_RULE_SETS: readonly string[] = [...ANALYZE_RULE_SETS];

/**
 * The built-in registry: one analyze job per enrich job in
 * the J3 registry (which is one per quotes feed job). The
 * job id extends the lineage: <feed job>-enrich-analyze.
 */
export function buildAnalyzeJobRegistry(
  env: Record<string, string | undefined>,
): AnalyzeJobRegistry {
  const enrichRegistry = buildEnrichJobRegistry(env);
  const registry = new AnalyzeJobRegistry();
  for (const enrich of enrichRegistry.list()) {
    const id = `${enrich.id}-analyze`;
    registry.register({
      id,
      enrichJobId: enrich.id,
      feedJobId: enrich.feedJobId,
      sourceId: enrich.sourceId,
      dataset: enrich.dataset,
      universe: enrich.universe,
      ruleSets: resolveRuleSetsKnob(env, id, ANALYZE_DEFAULT_RULE_SETS),
      cadenceMinutes: resolveMinutesKnob(
        env,
        id,
        "CADENCE_MINUTES",
        ANALYZE_JOB_DEFAULTS.cadenceMinutes,
      ),
      staleAfterMinutes: resolveMinutesKnob(
        env,
        id,
        "STALE_MINUTES",
        ANALYZE_JOB_DEFAULTS.staleAfterMinutes,
      ),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* The computation (pure: persisted artifact in, analyzed rows out)    */
/* ------------------------------------------------------------------ */

export interface AnalyzeComputationInput {
  /** The persisted enriched artifact (the enrich job's own copy). */
  inputArtifact: EnrichedDatasetArtifact;
  /** The rule sets to apply (validated configuration). */
  ruleSets: readonly string[];
  /** Thresholds + composite weights (resolved configuration). */
  thresholds: AnalyzeThresholds;
}

export interface AnalyzeComputation {
  rows: AnalyzedDatasetArtifact["rows"];
  gaps: AnalyzedRuleGap[];
  ruleCoverage: AnalyzedDatasetArtifact["ruleCoverage"];
  summary: AnalyzedDatasetArtifact["summary"];
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const clampScore = (v: number): number => Math.max(-100, Math.min(100, v));

function numFeature(row: EnrichedDatasetRow, key: string): number | null {
  const value = row.features[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computeAnalysis(input: AnalyzeComputationInput): AnalyzeComputation {
  const ruleSets = validateAnalyzeRuleSets(input.ruleSets);
  const t = input.thresholds;
  const gaps: AnalyzedRuleGap[] = [];
  const coverage: AnalyzeComputation["ruleCoverage"] = {};
  for (const ruleSet of ruleSets) coverage[ruleSet] = { evaluated: 0, unavailable: 0 };
  const gapSymbols = new Map<string, Set<string>>(); // `${ruleSet}|${reason}` -> symbols
  const noteGap = (ruleSet: string, reason: string, symbol: string) => {
    const key = `${ruleSet}|${reason}`;
    const set = gapSymbols.get(key) ?? new Set<string>();
    set.add(symbol);
    gapSymbols.set(key, set);
  };
  /** The gap reason for a missing feature: the enrich run
   *  recorded one of the producing elements unavailable, or
   *  the feature simply is not in the artifact. */
  const missingReason = (row: EnrichedDatasetRow, elements: readonly string[]): string =>
    elements.some((e) => row.unavailable.includes(e))
      ? ANALYZE_GAP_REASONS.elementUnavailableInInput
      : ANALYZE_GAP_REASONS.featureNotInArtifact;

  const rows: AnalyzedDatasetArtifact["rows"] = [];
  let advancers = 0;
  let decliners = 0;
  let flat = 0;
  let momentumSum = 0;
  let momentumCount = 0;
  let compositeSum = 0;
  let compositeCount = 0;

  for (const row of input.inputArtifact.rows) {
    const signals: Record<string, string> = {};
    const scores: Record<string, number> = {};
    const unavailable: string[] = [];
    const markUnavailable = (ruleSet: string, reason: string) => {
      coverage[ruleSet].unavailable++;
      unavailable.push(ruleSet);
      noteGap(ruleSet, reason, row.symbol);
    };

    for (const ruleSet of ruleSets) {
      switch (ruleSet) {
        case "momentum": {
          const momentum = numFeature(row, "momentum");
          if (momentum === null) {
            markUnavailable(ruleSet, missingReason(row, ["momentum"]));
            break;
          }
          signals.momentum =
            momentum >= t.strongMovePercent
              ? "strong_up"
              : momentum >= t.mildMovePercent
                ? "up"
                : momentum <= -t.strongMovePercent
                  ? "strong_down"
                  : momentum <= -t.mildMovePercent
                    ? "down"
                    : "flat";
          scores.momentum = round6(clampScore(momentum * 10));
          coverage.momentum.evaluated++;
          break;
        }
        case "range": {
          const position =
            numFeature(row, "rangePosition52w") ?? numFeature(row, "bollingerPercentB");
          if (position === null) {
            markUnavailable(ruleSet, missingReason(row, ["rangePosition52w", "bollinger"]));
            break;
          }
          signals.range =
            position >= t.nearHighPosition
              ? "near_high"
              : position >= t.upperPosition
                ? "upper"
                : position < t.lowerPosition
                  ? "near_low"
                  : position < 0.5
                    ? "lower"
                    : "middle";
          scores.range = round6(clampScore((position - 0.5) * 200));
          coverage.range.evaluated++;
          break;
        }
        case "volume": {
          const relativeVolume = numFeature(row, "relativeVolume");
          if (relativeVolume === null) {
            markUnavailable(ruleSet, missingReason(row, ["relativeVolume"]));
            break;
          }
          signals.volume =
            relativeVolume >= t.surgeVolumeRatio
              ? "surge"
              : relativeVolume >= t.elevatedVolumeRatio
                ? "elevated"
                : relativeVolume < t.quietVolumeRatio
                  ? "quiet"
                  : "normal";
          scores.volume = round6(clampScore((relativeVolume - 1) * 100));
          coverage.volume.evaluated++;
          break;
        }
        case "value": {
          const upside = numFeature(row, "analystUpsidePercent");
          if (upside !== null) {
            signals.value =
              upside >= t.deepValueUpsidePercent
                ? "deep_value"
                : upside >= t.undervaluedUpsidePercent
                  ? "undervalued"
                  : upside <= t.overvaluedUpsidePercent
                    ? "overvalued"
                    : "fair";
            scores.value = round6(clampScore(upside * 4));
            coverage.value.evaluated++;
            break;
          }
          const zone = row.features.valueZone;
          if (zone === "undervalued" || zone === "fair" || zone === "overvalued") {
            signals.value = zone;
            scores.value = zone === "undervalued" ? 50 : zone === "overvalued" ? -50 : 0;
            coverage.value.evaluated++;
            break;
          }
          markUnavailable(
            ruleSet,
            missingReason(row, ["analystUpsidePercent", "valueZone"]),
          );
          break;
        }
        default:
          // validateAnalyzeRuleSets already refused unknown names.
          markUnavailable(ruleSet, ANALYZE_GAP_REASONS.featureNotInArtifact);
      }
    }

    // Composite: the weighted mean over the rule sets that
    // evaluated for THIS symbol — a missing rule set narrows
    // the basis (and is named unavailable), never zero-filled.
    let weighted = 0;
    let weightSum = 0;
    for (const ruleSet of ruleSets) {
      const score = scores[ruleSet];
      if (score === undefined) continue;
      const weight = t.weights[ruleSet as AnalyzeRuleSet] ?? 1;
      weighted += score * weight;
      weightSum += weight;
    }
    const compositeScore = weightSum > 0 ? round6(weighted / weightSum) : null;

    const momentum = numFeature(row, "momentum");
    if (momentum !== null) {
      momentumSum += momentum;
      momentumCount++;
      if (momentum > 0) advancers++;
      else if (momentum < 0) decliners++;
      else flat++;
    }
    if (compositeScore !== null) {
      compositeSum += compositeScore;
      compositeCount++;
    }

    rows.push({
      symbol: row.symbol,
      lastPrice: row.lastPrice,
      signals,
      scores,
      compositeScore,
      unavailable,
    });
  }

  for (const [key, symbols] of gapSymbols) {
    const [ruleSet, reason] = key.split("|");
    gaps.push({ ruleSet, reason, symbols: [...symbols].sort() });
  }

  const byComposite = rows
    .filter((r) => r.compositeScore !== null)
    .map((r) => ({ symbol: r.symbol, score: r.compositeScore as number }))
    .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));

  return {
    rows,
    gaps,
    ruleCoverage: coverage,
    summary: {
      symbols: rows.length,
      advancers,
      decliners,
      flat,
      meanMomentum: momentumCount > 0 ? round6(momentumSum / momentumCount) : null,
      meanCompositeScore: compositeCount > 0 ? round6(compositeSum / compositeCount) : null,
      topByComposite: byComposite.slice(0, 5),
      bottomByComposite: byComposite.slice(-5).reverse(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface AnalyzeJobDeps {
  /** The enriched-dataset store (the input copies). */
  enrichedStore: EnrichedDatasetStore;
  /** The analyzed-dataset store (this stage's persisted output). */
  analyzedStore: AnalyzedDatasetStore;
}

export interface RunAnalyzeJobOptions {
  trigger?: "manual" | "scheduled";
  /** The run id to record under (the pipeline engine's run id,
   *  when dispatched through the plane — one run, one id). */
  runId?: string;
  /** Injectable clock (tests); defaults to now. */
  nowMs?: number;
  /** Rule-set override (the pipeline definition's configured
   *  params win over the registry defaults). */
  ruleSets?: readonly string[];
  /** Threshold override (configuration, same rule). */
  thresholds?: Partial<Record<string, unknown>> | null;
  /** Shard partition: analyze only these symbols of the input
   *  artifact (the plane's sharded shape). */
  symbols?: readonly string[];
}

export interface AnalyzeRunResult {
  jobId: string;
  runId: string;
  status: "completed" | "partial" | "failed";
  artifactId: string | null;
  /** Symbols the run set out to analyze. */
  requested: number;
  /** Symbols analyzed. */
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
  /** The enriched artifact consumed (lineage), when one was. */
  inputArtifactId: string | null;
  inputRunId: string | null;
  ruleCoverage: AnalyzedDatasetArtifact["ruleCoverage"];
}

const EMPTY_SUMMARY: AnalyzedDatasetArtifact["summary"] = {
  symbols: 0,
  advancers: 0,
  decliners: 0,
  flat: 0,
  meanMomentum: null,
  meanCompositeScore: null,
  topByComposite: [],
  bottomByComposite: [],
};

/**
 * Run one analyze job: resolve the persisted enriched input,
 * compute, persist the analyzed artifact. Outcomes are
 * RETURNED (the failed-input run is recorded first); only an
 * unknown job id throws (a caller bug, the #3530 idiom).
 */
export async function runAnalyzeJob(
  registry: AnalyzeJobRegistry,
  deps: AnalyzeJobDeps,
  jobId: string,
  opts: RunAnalyzeJobOptions = {},
): Promise<AnalyzeRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new AnalyzeJobError(
      ANALYZE_JOB_CODES.jobNotFound,
      `Analyze job "${jobId}" is not registered.`,
    );
  }
  const startedMs = opts.nowMs ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `analyze-run-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";
  const ruleSets = validateAnalyzeRuleSets(opts.ruleSets ?? def.ruleSets);
  const thresholds = resolveAnalyzeThresholds(opts.thresholds);

  const finish = async (
    partial: Omit<
      AnalyzeRunResult,
      "jobId" | "runId" | "artifactId" | "inputArtifactId" | "inputRunId"
    > & {
      rows: AnalyzedDatasetArtifact["rows"];
      gaps: AnalyzedRuleGap[];
      summary: AnalyzedDatasetArtifact["summary"];
      inputArtifact: EnrichedDatasetArtifact | undefined;
    },
  ): Promise<AnalyzeRunResult> => {
    const finishedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
    const artifact = await deps.analyzedStore.store({
      jobId: def.id,
      enrichJobId: def.enrichJobId,
      feedJobId: def.feedJobId,
      sourceId: def.sourceId,
      dataset: def.dataset,
      universe: partial.inputArtifact?.universe ?? {
        kind: "index",
        index: def.universe.index,
        label: def.universe.label,
        snapshotDate: null,
        sourceLabel: null,
        size: 0,
      },
      inputArtifactId: partial.inputArtifact?.id ?? "",
      inputRunId: partial.inputArtifact?.run.runId ?? "",
      inputAsOf: partial.inputArtifact?.createdAt ?? "",
      ruleSets,
      gaps: partial.gaps,
      ruleCoverage: partial.ruleCoverage,
      summary: partial.summary,
      rows: partial.rows,
      run: {
        runId,
        trigger,
        startedAt,
        finishedAt,
        status: partial.status,
        requested: partial.requested,
        received: partial.received,
        failed: partial.failed,
        codedError: partial.codedError,
        errorMessage: partial.errorMessage,
      },
      nowIso: finishedAt,
    });
    if (partial.status === "failed") {
      structuredLog.warn(ANALYZE_JOB_RUN_FAILED, {
        message: `[analyzeJobs] ${partial.codedError ?? "ANALYZE_RUN_FAILED"}: analyze job "${def.id}" run ${runId} failed (${partial.errorMessage ?? "no detail"})`,
        jobId: def.id,
        runId,
        codedError: partial.codedError,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: partial.status,
      artifactId: artifact.id,
      requested: partial.requested,
      received: partial.received,
      failed: partial.failed,
      codedError: partial.codedError,
      errorMessage: partial.errorMessage,
      inputArtifactId: partial.inputArtifact?.id ?? null,
      inputRunId: partial.inputArtifact?.run.runId ?? null,
      ruleCoverage: partial.ruleCoverage,
    };
  };

  // The input: the enrich job's newest USABLE persisted
  // artifact, by its exact job id — reads never fetch.
  const inputArtifact = await deps.enrichedStore.latestUsable(def.enrichJobId);
  if (!inputArtifact) {
    return finish({
      status: "failed",
      requested: 0,
      received: 0,
      failed: 0,
      codedError: ANALYZE_JOB_CODES.inputMissing,
      errorMessage: scrubFailureMessage(
        `No usable persisted enriched dataset for enrich job "${def.enrichJobId}": the analyze run was refused rather than fetching live or analyzing another job's copy.`,
      ),
      rows: [],
      gaps: [],
      summary: EMPTY_SUMMARY,
      ruleCoverage: Object.fromEntries(
        ruleSets.map((r) => [r, { evaluated: 0, unavailable: 0 }]),
      ),
      inputArtifact: undefined,
    });
  }

  // A sharded unit analyzes its partition of the input only
  // (its lineage still names the whole input artifact).
  const effectiveRows = opts.symbols
    ? inputArtifact.rows.filter((r) =>
        opts.symbols!.some((s) => s.toUpperCase() === r.symbol.toUpperCase()),
      )
    : inputArtifact.rows;
  const effectiveInput: EnrichedDatasetArtifact = {
    ...inputArtifact,
    rows: effectiveRows,
  };

  const computation = computeAnalysis({
    inputArtifact: effectiveInput,
    ruleSets,
    thresholds,
  });

  const requested = effectiveRows.length;
  const received = computation.rows.length;
  const anyUnavailable = Object.values(computation.ruleCoverage).some(
    (c) => c.unavailable > 0,
  );
  return finish({
    status: anyUnavailable ? "partial" : "completed",
    requested,
    received,
    failed: requested - received,
    codedError: null,
    errorMessage: null,
    rows: computation.rows,
    gaps: computation.gaps,
    summary: computation.summary,
    ruleCoverage: computation.ruleCoverage,
    inputArtifact,
  });
}

/* ------------------------------------------------------------------ */
/* Status — what the UX renders (one source of truth: the store)       */
/* ------------------------------------------------------------------ */

export interface AnalyzeStatusView {
  jobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  ruleSets: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: AnalyzedDatasetArtifact["run"] | null;
  /** Recent run history, newest first. */
  history: AnalyzedDatasetArtifact["run"][];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
    /** Lineage: the enriched artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    ruleSets: string[];
    summary: AnalyzedDatasetArtifact["summary"];
  } | null;
}

export async function buildAnalyzeStatus(
  store: AnalyzedDatasetStore,
  def: AnalyzeJobDefinition,
  nowMs: number,
): Promise<AnalyzeStatusView> {
  const [latest, usable, runArtifacts] = await Promise.all([
    store.latest(def.id),
    store.latestUsable(def.id),
    store.listRuns(def.id, 5),
  ]);
  const base: AnalyzeStatusView = {
    jobId: def.id,
    enrichJobId: def.enrichJobId,
    feedJobId: def.feedJobId,
    sourceId: def.sourceId,
    dataset: def.dataset,
    ruleSets: [...def.ruleSets],
    universeLabel: def.universe.label,
    cadenceMinutes: def.cadenceMinutes,
    staleAfterMinutes: def.staleAfterMinutes,
    state: latest ? "ready" : "never-run",
    lastRun: latest?.run ?? null,
    history: runArtifacts.map((a) => a.run),
    snapshot: null,
  };
  if (!usable) return base;
  const asOfMs = Date.parse(usable.createdAt);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    ...base,
    snapshot: {
      artifactId: usable.id,
      asOf: usable.createdAt,
      ageSeconds,
      rowsPersisted: usable.rows.length,
      stale: ageSeconds > def.staleAfterMinutes * 60,
      inputArtifactId: usable.inputArtifactId,
      inputRunId: usable.inputRunId,
      inputAsOf: usable.inputAsOf,
      ruleSets: [...usable.ruleSets],
      summary: usable.summary,
    },
  };
}
