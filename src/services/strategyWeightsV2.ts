/**
 * Issue #1140 (epic #1096 Phase 5) — strategy weights v2: the RSI
 * loop's weight policy, hardened from the #754 v1 job.
 *
 * What changes vs v1 (strategyWeights.ts, deleted by the #1257
 * retirement — its bounds envelope, week key, actor, and pure
 * evaluation helpers now live in this module):
 *  - REGIME-CONDITIONED: evidence is sliced per (strategy, regime)
 *    using the Phase 1 regime classes (RegimeAssessment:
 *    bull / bear / chop / high_vol / unknown). A strategy is never
 *    moved by evidence from a regime it did not trade in.
 *  - AFTER-COST, RISK-ADJUSTED: the scored quantity is the win rate
 *    of P&L AFTER the researchEconomics cost assumptions
 *    (fee + slippage per contract, from researchConfig), and a
 *    positive win-rate excess with a non-positive average after-cost
 *    R multiple can never propose an increase. Raw win rate alone
 *    moves nothing.
 *  - DECAY: each proposal's step is scaled by 0.5^(age/half-life) of
 *    its newest evidence, and an idle weight decays back toward the
 *    default — stale evidence stops steering the bank.
 *  - VERSIONED: every applied change writes an append-only version
 *    record (strategy, regime, before — null when no row existed,
 *    #760 exact-restore semantics — after, signal evidence, actor),
 *    so outcomes (outcomeTracking.ts) can cite the exact weights
 *    version that was live. Applications go through the #755
 *    applyAdaptation seam (budget + audit; kill switch halts).
 *
 * The bounds envelope now lives here (moved verbatim from v1 in the
 * #1257 retirement; WEIGHTS_V2_DEFAULTS reads it) — there is no
 * second bounds regime.
 *
 * READ BOUNDARY (#5064, AG-10 — pinned by
 * tests/strategy_weights_v2_read_boundary_5064.test.ts). The readers are
 * declared once, in STRATEGY_WEIGHTS_V2_READERS below; adding an import
 * without a line there fails the pin. In words:
 *   - the reselection tick reads the regime's weights to build
 *     PROPOSALS only (`proposal_only_not_promoted`) — it changes no live
 *     ranking;
 *   - the challenger evaluation and the fit-discovery runner read the
 *     policy to score candidates;
 *   - the reselection/challenger bridge reads the regime type only.
 * The LIVE screen ranking does NOT read v2 weights at decision time —
 * `src/agents/screener-agent.ts` is on the pin's never-list. Promotion of
 * a v2 change into live state is the champion/challenger gate's job
 * (championChallenger.ts), not this module's.
 *
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4): the versioned
 * store sits behind the strategy weights port (src/data/
 * strategyWeightsPorts.ts; DO adapter in
 * doSqliteStrategyWeightsAdapter.ts, composed by
 * createStrategyClusterPorts.ts). The pure policy (bounds,
 * proposals, decay, after-cost scoring) and the application
 * paths stay here, unchanged; their row operations run through
 * the port.
 */

import { applyAdaptation, isAdaptationHalted } from "./adaptationAudit";
import { DoSqliteStrategyWeightsStore } from "../data/doSqliteStrategyWeightsAdapter";
import { createSettingsPort } from "../data/createSettingsPorts";
import { weightsV2Key } from "../data/strategyWeightsPorts";
import type {
  StrategyWeightsSqlExecutor,
  StrategyWeightsStore,
  WeightVersionRecord,
  WeightsV2Regime,
} from "../data/strategyWeightsPorts";
import type { CostAssumptions } from "./researchEconomics";
import type { TrackRecord } from "./researchTrackRecord";

/**
 * Issue #5064 (AG-10) — the v2-weights read boundary, declared once.
 *
 * Every module allowed to import this file, with why (value read or
 * type-only). The pin test enumerates the real import graph and fails on
 * any difference, so a new reader cannot land without a deliberate line
 * here — the header's claim and the call graph stay in step.
 */
export const STRATEGY_WEIGHTS_V2_READERS = [
  { path: "src/agents/routes/screenerResearch.ts", purpose: "reselection tick proposals (proposal-only, never applied live)" },
  { path: "src/services/championChallenger.ts", purpose: "challenger evaluation + weights-table bootstrap" },
  { path: "src/services/fitDiscoveryRunner.ts", purpose: "fit-discovery runner: bounds and policy evaluation" },
  { path: "src/services/proposalChallengerBridge.ts", purpose: "type-only: regime vocabulary" },
  // #6503 — scheduled-screening tick (new file, the screening path
  // extracted into the unified scheduler): builds v2 slices from the
  // screened ideas and runs the adjustment; the adjustment self-checks
  // the kill switch (halted, nothing applied) and the tick records it.
  { path: "src/services/scheduledScreeningSteps.ts", purpose: "scheduled-screening tick: runs the v2 weights adjustment over the screened ideas (kill-switch self-checked)" },
] as const;

/**
 * Modules that must NEVER import this file: the live decision paths.
 * A ranking change reaches production only through the champion/challenger
 * gate, never by reading a weight at decision time.
 */
export const STRATEGY_WEIGHTS_V2_NEVER_READERS = [
  "src/agents/screener-agent.ts",
  "src/services/stockCopilotAgenticLoop.ts",
] as const;

export { weightsV2Key };
export type { WeightVersionRecord, WeightsV2Regime };

function weightsStore(sql: StrategyWeightsSqlExecutor): StrategyWeightsStore {
  return new DoSqliteStrategyWeightsStore(sql);
}

/* ------------------------------------------------------------------ */
/* Moved from v1 strategyWeights.ts (#1257 retirement)                 */
/* ------------------------------------------------------------------ */
// The v1 module is deleted. These symbols survive because live code
// still needs them: the bounds envelope (WEIGHTS_V2_DEFAULTS reads it
// verbatim), the shared week key (one adjustment per week regardless
// of engine), the v1 actor string (kept distinct from WEIGHTS_V2_ACTOR
// so audit history stays attributable), and the pure evaluation
// helpers (GET /adaptation/weights feeds the collapsed v2 map through
// buildWeightPolicyEvaluation). The v1 store functions and the v1
// adjustment job are NOT moved — they are deleted with v1.
export const STRATEGY_WEIGHT_BOUNDS = {
  min: 0.25,
  max: 2.0,
  maxStep: 0.1,
  minSample: 20,
  deadband: 0.02,
  defaultWeight: 1.0,
} as const;

export const WEIGHTS_LAST_RUN_WEEK_KEY = "adaptation.weights.lastRunWeek";
export const WEIGHT_ADAPTATION_ACTOR = "strategy-weight-job";

export const WEIGHTS_V2_DEFAULTS = {
  min: STRATEGY_WEIGHT_BOUNDS.min,
  max: STRATEGY_WEIGHT_BOUNDS.max,
  maxStep: STRATEGY_WEIGHT_BOUNDS.maxStep,
  deadband: STRATEGY_WEIGHT_BOUNDS.deadband,
  minSample: STRATEGY_WEIGHT_BOUNDS.minSample,
  defaultWeight: STRATEGY_WEIGHT_BOUNDS.defaultWeight,
  halfLifeDays: 90,
} as const;

export const WEIGHTS_V2_ACTOR = "strategy-weight-v2-job";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Pure evaluation helpers, moved from v1 (#1257 retirement)           */
/* ------------------------------------------------------------------ */

export function isoWeekKey(d: Date): string {
  // ISO 8601 week: shift to the Thursday of the current week.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface WeightProposal {
  strategy: string;
  current: number;
  proposed: number;
  delta: number;
  evaluated: number;
  winRate: number;
  overallWinRate: number;
}

/**
 * The pure policy: given the track record and current weights, the
 * moves this run would make. Deterministic; no store access.
 */
export function proposeWeightAdjustments(
  track: TrackRecord,
  weights: Record<string, number>,
  caps: Record<string, number> = {}
): WeightProposal[] {
  const overall = track.winRate;
  if (overall === null) return [];
  const proposals: WeightProposal[] = [];
  for (const slice of track.byStrategy) {
    if (slice.evaluated < STRATEGY_WEIGHT_BOUNDS.minSample) continue;
    if (slice.winRate === null) continue;
    const step = clamp(slice.winRate - overall, -STRATEGY_WEIGHT_BOUNDS.maxStep, STRATEGY_WEIGHT_BOUNDS.maxStep);
    if (Math.abs(step) < STRATEGY_WEIGHT_BOUNDS.deadband) continue;
    const current = weights[slice.key] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
    // A per-strategy cap override (#760, human-gated through the
    // promotion pipeline) replaces the global max for that strategy.
    const maxBound = caps[slice.key] ?? STRATEGY_WEIGHT_BOUNDS.max;
    const proposed = round4(clamp(current + step, STRATEGY_WEIGHT_BOUNDS.min, maxBound));
    if (proposed === current) continue;
    proposals.push({
      strategy: slice.key,
      current,
      proposed,
      delta: round4(proposed - current),
      evaluated: slice.evaluated,
      winRate: slice.winRate,
      overallWinRate: overall,
    });
  }
  return proposals;
}

export interface WeightPolicyEvaluation {
  generatedAt: string;
  unweightedWinRate: number | null;
  weightedWinRate: number | null;
  proposals: WeightProposal[];
  lowSample: string[];
}

/**
 * The #17-style evaluation harness: what the current weights imply
 * (weighted vs unweighted win rate over the track record) and what the
 * policy would do next. Measurement only — applies nothing.
 */
export function buildWeightPolicyEvaluation(
  track: TrackRecord,
  weights: Record<string, number>
): WeightPolicyEvaluation {
  let wHits = 0;
  let wEval = 0;
  for (const s of track.byStrategy) {
    if (s.winRate === null) continue;
    const w = weights[s.key] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
    wHits += w * s.winRate * s.evaluated;
    wEval += w * s.evaluated;
  }
  return {
    generatedAt: new Date().toISOString(),
    unweightedWinRate: track.winRate,
    weightedWinRate: wEval > 0 ? wHits / wEval : null,
    proposals: proposeWeightAdjustments(track, weights),
    lowSample: track.byStrategy
      .filter((s) => s.evaluated < STRATEGY_WEIGHT_BOUNDS.minSample)
      .map((s) => s.key),
  };
}

/** Weight decay toward the default as evidence ages (pure). */
export function decayedWeight(
  current: number,
  ageDays: number,
  halfLifeDays: number = WEIGHTS_V2_DEFAULTS.halfLifeDays
): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return current;
  const factor = Math.pow(0.5, ageDays / halfLifeDays);
  return WEIGHTS_V2_DEFAULTS.defaultWeight +
    (current - WEIGHTS_V2_DEFAULTS.defaultWeight) * factor;
}

function decayFactor(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/* ------------------------------------------------------------------ */
/* Evidence slices                                                     */
/* ------------------------------------------------------------------ */

export interface WeightsV2IdeaInput {
  structure: string;
  regime: WeightsV2Regime;
  /**
   * Contracts per structure unit (sum of |quantity| over the idea's
   * legs, derived by the caller from the stored idea record).
   * null = unknown — the idea is then EXCLUDED from after-cost
   * scoring (counted as unpriced), never assigned an assumed cost.
   */
  contractsPerUnit: number | null;
  evaluation: {
    pnlEstimatePerUnit: number | null;
    rMultiple: number | null;
    evaluatedAt: string;
  } | null;
}

export interface WeightsV2Slice {
  strategy: string;
  regime: WeightsV2Regime;
  published: number;
  /** Ideas with a P&L estimate AND a known contract count. */
  evaluated: number;
  /** Ideas with a P&L estimate but an unknown contract count. */
  unpriced: number;
  winRateAfterCost: number | null;
  avgPnlAfterCost: number | null;
  avgRAfterCost: number | null;
  latestEvaluatedAt: string | null;
}

/**
 * After-cost P&L per unit. pnlEstimatePerUnit is per share-unit, so a
 * per-contract fee/slippage is divided by 100 (one contract = 100
 * shares). The after-cost R reuses the pre-cost R's implied max-loss
 * scale (pnl / rMultiple), so risk units are unchanged — only the
 * numerator moves by the costs.
 */
export function afterCost(
  pnlPerUnit: number,
  rMultiple: number | null,
  contractsPerUnit: number,
  costs: Pick<CostAssumptions, "feePerContract" | "slippagePerContract">
): { pnlAfterCost: number; rAfterCost: number | null } {
  const costPerUnit =
    ((costs.feePerContract + costs.slippagePerContract) * contractsPerUnit) / 100;
  const pnlAfterCost = pnlPerUnit - costPerUnit;
  let rAfterCost: number | null = null;
  if (rMultiple !== null && pnlPerUnit !== 0) {
    const impliedMaxLoss = pnlPerUnit / rMultiple;
    if (impliedMaxLoss > 0) rAfterCost = pnlAfterCost / impliedMaxLoss;
  }
  return { pnlAfterCost, rAfterCost };
}

export function buildWeightsV2Slices(
  ideas: WeightsV2IdeaInput[],
  costs: Pick<CostAssumptions, "feePerContract" | "slippagePerContract">
): WeightsV2Slice[] {
  const byKey = new Map<
    string,
    {
      strategy: string;
      regime: WeightsV2Regime;
      published: number;
      evaluated: number;
      unpriced: number;
      wins: number;
      pnlSum: number;
      rSum: number;
      rCount: number;
      latestEvaluatedAt: string | null;
    }
  >();
  for (const idea of ideas) {
    const key = weightsV2Key(idea.structure, idea.regime);
    let slice = byKey.get(key);
    if (!slice) {
      slice = {
        strategy: idea.structure,
        regime: idea.regime,
        published: 0,
        evaluated: 0,
        unpriced: 0,
        wins: 0,
        pnlSum: 0,
        rSum: 0,
        rCount: 0,
        latestEvaluatedAt: null,
      };
      byKey.set(key, slice);
    }
    slice.published++;
    const evaluation = idea.evaluation;
    if (!evaluation || typeof evaluation.pnlEstimatePerUnit !== "number") continue;
    if (idea.contractsPerUnit === null || idea.contractsPerUnit <= 0) {
      slice.unpriced++;
      continue;
    }
    const { pnlAfterCost, rAfterCost } = afterCost(
      evaluation.pnlEstimatePerUnit,
      evaluation.rMultiple,
      idea.contractsPerUnit,
      costs
    );
    slice.evaluated++;
    if (pnlAfterCost > 0) slice.wins++;
    slice.pnlSum += pnlAfterCost;
    if (rAfterCost !== null) {
      slice.rSum += rAfterCost;
      slice.rCount++;
    }
    if (
      slice.latestEvaluatedAt === null ||
      evaluation.evaluatedAt > slice.latestEvaluatedAt
    ) {
      slice.latestEvaluatedAt = evaluation.evaluatedAt;
    }
  }
  return [...byKey.values()]
    .sort((a, b) =>
      a.strategy === b.strategy
        ? a.regime < b.regime
          ? -1
          : 1
        : a.strategy < b.strategy
          ? -1
          : 1
    )
    .map((s) => ({
      strategy: s.strategy,
      regime: s.regime,
      published: s.published,
      evaluated: s.evaluated,
      unpriced: s.unpriced,
      winRateAfterCost: s.evaluated > 0 ? s.wins / s.evaluated : null,
      avgPnlAfterCost: s.evaluated > 0 ? s.pnlSum / s.evaluated : null,
      avgRAfterCost: s.rCount > 0 ? s.rSum / s.rCount : null,
      latestEvaluatedAt: s.latestEvaluatedAt,
    }));
}

/* ------------------------------------------------------------------ */
/* Policy (pure)                                                       */
/* ------------------------------------------------------------------ */

export interface WeightV2Proposal {
  strategy: string;
  regime: WeightsV2Regime;
  current: number;
  proposed: number;
  delta: number;
  evaluated: number;
  winRateAfterCost: number;
  overallWinRateAfterCost: number;
  avgRAfterCost: number | null;
  latestEvaluatedAt: string | null;
  evidenceAgeDays: number;
  decayFactor: number;
}

export function proposeWeightAdjustmentsV2(
  slices: WeightsV2Slice[],
  weights: Record<string, number>,
  opts: {
    now: Date;
    caps?: Record<string, number>;
    halfLifeDays?: number;
  }
): WeightV2Proposal[] {
  const halfLife = opts.halfLifeDays ?? WEIGHTS_V2_DEFAULTS.halfLifeDays;
  // Regime baselines: after-cost win rate over ALL evaluated ideas in
  // the regime — a strategy is judged against its own regime only.
  const baselines = new Map<string, { wins: number; evaluated: number }>();
  for (const s of slices) {
    if (s.winRateAfterCost === null || s.evaluated === 0) continue;
    const b = baselines.get(s.regime) ?? { wins: 0, evaluated: 0 };
    b.wins += s.winRateAfterCost * s.evaluated;
    b.evaluated += s.evaluated;
    baselines.set(s.regime, b);
  }

  const proposals: WeightV2Proposal[] = [];
  for (const slice of slices) {
    if (slice.evaluated < WEIGHTS_V2_DEFAULTS.minSample) continue;
    if (slice.winRateAfterCost === null) continue;
    const baseline = baselines.get(slice.regime);
    if (!baseline || baseline.evaluated === 0) continue;
    const overall = baseline.wins / baseline.evaluated;

    const ageDays = slice.latestEvaluatedAt
      ? Math.max(0, (opts.now.getTime() - Date.parse(slice.latestEvaluatedAt)) / DAY_MS)
      : Number.POSITIVE_INFINITY;
    const factor = decayFactor(ageDays, halfLife);
    const current =
      weights[weightsV2Key(slice.strategy, slice.regime)] ??
      WEIGHTS_V2_DEFAULTS.defaultWeight;
    const cap = opts.caps?.[slice.strategy] ?? WEIGHTS_V2_DEFAULTS.max;

    let signal = slice.winRateAfterCost - overall;
    let step = clamp(signal, -WEIGHTS_V2_DEFAULTS.maxStep, WEIGHTS_V2_DEFAULTS.maxStep);
    // Risk adjustment: without a positive average after-cost R, a
    // win-rate excess may only ever argue for a DECREASE (or nothing).
    if (slice.avgRAfterCost === null || slice.avgRAfterCost <= 0) {
      step = Math.min(step, 0);
    }
    step = step * factor;

    let proposed: number;
    if (Math.abs(step) < WEIGHTS_V2_DEFAULTS.deadband) {
      // No live signal — but a non-default weight resting on decayed
      // evidence still drifts home toward the default.
      if (factor >= 1 || current === WEIGHTS_V2_DEFAULTS.defaultWeight) continue;
      const target = decayedWeight(current, ageDays, halfLife);
      const move = clamp(
        target - current,
        -WEIGHTS_V2_DEFAULTS.maxStep,
        WEIGHTS_V2_DEFAULTS.maxStep
      );
      if (Math.abs(move) < WEIGHTS_V2_DEFAULTS.deadband) continue;
      proposed = round4(clamp(current + move, WEIGHTS_V2_DEFAULTS.min, cap));
      signal = 0;
    } else {
      proposed = round4(clamp(current + step, WEIGHTS_V2_DEFAULTS.min, cap));
    }
    if (proposed === current) continue;
    proposals.push({
      strategy: slice.strategy,
      regime: slice.regime,
      current,
      proposed,
      delta: round4(proposed - current),
      evaluated: slice.evaluated,
      winRateAfterCost: slice.winRateAfterCost,
      overallWinRateAfterCost: overall,
      avgRAfterCost: slice.avgRAfterCost,
      latestEvaluatedAt: slice.latestEvaluatedAt,
      evidenceAgeDays: Number.isFinite(ageDays) ? Math.round(ageDays) : -1,
      decayFactor: round4(factor),
    });
  }
  return proposals;
}

/* ------------------------------------------------------------------ */
/* Versioned store                                                     */
/* ------------------------------------------------------------------ */

export function ensureWeightsV2Tables(sql: any): void {
  weightsStore(sql).ensureTables();
  // The apply paths below read the adaptation kill switch from
  // mas_settings immediately after ensuring. That table's DDL
  // used to ride along inside the weights store's ensure; since
  // step 4g (#2390, G-7 ruling) its single owner is the
  // dedicated settings port's adapter, so this family's ensure
  // invokes the port's ensureSchema() — the ensure contract
  // ("every table this family's operations touch exists") is
  // unchanged, only the DDL's owner moved.
  createSettingsPort(sql).ensureSchema();
}

export function currentWeightsVersion(sql: any): number {
  return weightsStore(sql).currentVersion();
}

export function listWeightVersionRecords(
  sql: any,
  limit = 200
): WeightVersionRecord[] {
  return weightsStore(sql).listVersionRecords(limit);
}

export function getStrategyWeightsV2(sql: any): Record<string, number> {
  return weightsStore(sql).getWeights();
}

/**
 * Consolidation C5 (#1361, #1257): the per-regime read. The v2 store
 * is keyed strategy|regime; consumers that run under one regime (the
 * reselection tick loops regimes) need plain strategy keys for that
 * regime alone — no other regime's value may leak into the read.
 */
export function getStrategyWeightsV2ForRegime(sql: any, regime: string): Record<string, number> {
  return weightsStore(sql).getWeightsForRegime(regime);
}

/**
 * Consolidation C5 (#1361, #1257): the regime-blind aggregate for
 * legacy-shaped consumers (the GET weights evaluation, the candidate
 * replay) that key weights by strategy alone. The collapse rule is
 * the mean across the strategy's regimes — documented here, not
 * hidden in a caller: a regime-blind consumer cannot attribute a
 * strategy to one regime, so it reads the average, never a silently
 * picked regime's value.
 */
export function getStrategyWeightsV2Collapsed(sql: any): Record<string, number> {
  return weightsStore(sql).getWeightsCollapsed();
}

/* ------------------------------------------------------------------ */
/* Application (through the #755 seam)                                 */
/* ------------------------------------------------------------------ */

export interface WeightsV2AdjustmentResult {
  halted?: boolean;
  considered: number;
  adjusted: Array<{
    strategy: string;
    regime: string;
    before: number | null;
    after: number;
    version: number;
  }>;
  blocked: Array<{ strategy: string; regime: string; reason: string }>;
}

/**
 * One application path for explicit target weights (the promotion
 * gate's apply step, and rollback's restore step). Each change goes
 * through applyAdaptation with budgets NOT enforced (human-gated,
 * the #760 pattern) but fully audited; the kill switch is checked by
 * the caller before the seam and again here. `weight: null` deletes
 * the row — restoring "no row existed" exactly.
 */
export function applyWeightsV2Targets(
  sql: any,
  targets: Array<{
    strategy: string;
    regime: string;
    weight: number | null;
    signal?: number | null;
    evaluated?: number;
    winRateAfterCost?: number | null;
    avgRAfterCost?: number | null;
  }>,
  opts: { actor: string; rationale: string; now: Date }
): { halted?: boolean; applied: WeightsV2AdjustmentResult["adjusted"] } {
  ensureWeightsV2Tables(sql);
  if (isAdaptationHalted(sql)) return { halted: true, applied: [] };
  const store = weightsStore(sql);
  const applied: WeightsV2AdjustmentResult["adjusted"] = [];
  for (const t of targets) {
    const existed = store.weightRowExists(t.strategy, t.regime);
    const before = existed
      ? (store.getWeights()[weightsV2Key(t.strategy, t.regime)] ?? null)
      : null;
    const effectiveAfter = t.weight ?? WEIGHTS_V2_DEFAULTS.defaultWeight;
    const out = applyAdaptation(
      sql,
      {
        actor: opts.actor,
        subject: `strategy-weight-v2:${t.strategy}:${t.regime}`,
        parameter: "weight",
        before: before === null ? "none" : String(before),
        after: t.weight === null ? "none" : String(t.weight),
        delta: round4(effectiveAfter - (before ?? WEIGHTS_V2_DEFAULTS.defaultWeight)),
        rationale: opts.rationale,
        dataWindow: `weights v2 as of ${opts.now.toISOString().slice(0, 10)}`,
      },
      () => {
        const version = store.currentVersion() + 1;
        store.writeWeightRow(t.strategy, t.regime, t.weight, version, opts.now);
        store.writeVersionRecord(
          {
            version,
            strategy: t.strategy,
            regime: t.regime,
            before,
            after: effectiveAfter,
            signal: t.signal ?? null,
            evaluated: t.evaluated ?? 0,
            winRateAfterCost: t.winRateAfterCost ?? null,
            avgRAfterCost: t.avgRAfterCost ?? null,
            actor: opts.actor,
            rationale: opts.rationale,
          },
          opts.now
        );
        applied.push({
          strategy: t.strategy,
          regime: t.regime,
          before,
          after: effectiveAfter,
          version,
        });
      },
      opts.now,
      { enforceBudgets: false }
    );
    if (!out.applied) {
      // Seam refused (should not happen with budgets off, short of a
      // throw in apply) — surface by omission; callers compare counts.
      continue;
    }
  }
  return { applied };
}

/**
 * The v2 adjustment job: propose from slices and apply through the
 * seam WITH budget enforcement (it is an autonomous loop, like the
 * #754 job). Halted outright by the adaptation kill switch.
 */
export function runWeightsV2Adjustment(
  sql: any,
  slices: WeightsV2Slice[],
  opts: {
    now: Date;
    actor?: string;
    caps?: Record<string, number>;
    halfLifeDays?: number;
  }
): WeightsV2AdjustmentResult {
  ensureWeightsV2Tables(sql);
  const base: WeightsV2AdjustmentResult = {
    considered: slices.length,
    adjusted: [],
    blocked: [],
  };
  if (isAdaptationHalted(sql)) return { ...base, halted: true };

  const actor = opts.actor ?? WEIGHTS_V2_ACTOR;
  const store = weightsStore(sql);
  const weights = store.getWeights();
  const proposals = proposeWeightAdjustmentsV2(slices, weights, {
    now: opts.now,
    caps: opts.caps,
    halfLifeDays: opts.halfLifeDays,
  });
  for (const p of proposals) {
    const existed = store.weightRowExists(p.strategy, p.regime);
    const before = existed ? p.current : null;
    const out = applyAdaptation(
      sql,
      {
        actor,
        subject: `strategy-weight-v2:${p.strategy}:${p.regime}`,
        parameter: "weight",
        before: before === null ? "none" : String(before),
        after: String(p.proposed),
        delta: p.delta,
        rationale:
          `regime ${p.regime}: after-cost win rate ${p.winRateAfterCost.toFixed(2)} vs regime baseline ` +
          `${p.overallWinRateAfterCost.toFixed(2)} over ${p.evaluated} evaluated ideas; avg after-cost R ` +
          `${p.avgRAfterCost === null ? "n/a" : p.avgRAfterCost.toFixed(3)}; evidence age ${p.evidenceAgeDays}d, ` +
          `decay ${p.decayFactor}; bounded step ${p.delta >= 0 ? "+" : ""}${p.delta.toFixed(2)} ` +
          `within [${WEIGHTS_V2_DEFAULTS.min}, ${WEIGHTS_V2_DEFAULTS.max}]`,
        dataWindow: `evidence through ${p.latestEvaluatedAt ?? "unknown"}`,
      },
      () => {
        const version = store.currentVersion() + 1;
        store.writeWeightRow(p.strategy, p.regime, p.proposed, version, opts.now);
        store.writeVersionRecord(
          {
            version,
            strategy: p.strategy,
            regime: p.regime,
            before,
            after: p.proposed,
            signal: round4(p.winRateAfterCost - p.overallWinRateAfterCost),
            evaluated: p.evaluated,
            winRateAfterCost: p.winRateAfterCost,
            avgRAfterCost: p.avgRAfterCost,
            actor,
            rationale: `v2 proposal: after-cost, regime-conditioned, decay ${p.decayFactor}`,
          },
          opts.now
        );
        base.adjusted.push({
          strategy: p.strategy,
          regime: p.regime,
          before,
          after: p.proposed,
          version,
        });
      },
      opts.now
    );
    if (!out.applied) {
      base.blocked.push({
        strategy: p.strategy,
        regime: p.regime,
        reason: out.reason ?? "budget",
      });
    }
  }
  return base;
}
