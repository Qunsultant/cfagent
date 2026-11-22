/**
 * Issue #1122 (epic #1096 Phase 3) — nightly strategy-bank
 * re-selection (the Holly pattern, hardened).
 *
 * Once per weekday night, the strategy bank is re-run against recorded
 * evidence — researchTrackRecord slices joined to the regime of the
 * run that produced them, plus the current strategyWeights values —
 * and an active set is re-selected PER REGIME. The output is a
 * recorded PROPOSAL with a full transparency log: selected strategies,
 * deselected strategies (losers included, with their metrics and the
 * reason they lost the seat), insufficient-evidence strategies, and —
 * under the hard per-run cost cap (the #495 retry-cap pattern) —
 * strategies not evaluated because the cap ran out. Nobody is
 * silently dropped from the log.
 *
 * GOVERNANCE BOUNDARY (explicit): re-selection proposes and records;
 * it NEVER writes strategy weights, never applies an adaptation, and
 * never changes its own acceptance criteria. Promotion/activation of
 * weight or ranking changes remains the Phase 5 champion/challenger
 * gate. This module therefore has no import path to the weights
 * writer — a fact the Phase 3 tests pin at the source level.
 *
 * Scheduling follows the researchScheduleGuard idiom (#354): a pure
 * fire/no-fire decision folding into the existing every-30-minutes tick exactly
 * once per weekday at/after 21:00 UTC, keyed by its OWN durable
 * marker. No new cron trigger (Workers cron ceiling).
 *
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4): the durable
 * transparency record sits behind the reselection port (src/data/
 * reselectionPorts.ts; DO adapter in doSqliteReselectionAdapter.ts,
 * composed by createStrategyClusterPorts.ts). The pure policy
 * (schedule guard, evidence, re-selection) stays here, unchanged.
 */

import {
  researchTickDateKey,
  type ResearchFireHourConfig,
  type ResearchTickDecision,
} from "./researchScheduleGuard";
import { DEFAULT_RESEARCH_JOB_CONFIG } from "../config/researchJobConfig";
import { DoSqliteReselectionStore } from "../data/doSqliteReselectionAdapter";
import type {
  ReselectionActiveEntry,
  ReselectionLogEntry,
  ReselectionProposal,
  ReselectionRegime,
  ReselectionSqlExecutor,
  ReselectionStore,
  StrategyRegimeEvidence,
} from "../data/reselectionPorts";

export {
  RESELECTION_GOVERNANCE,
  type ReselectionActiveEntry,
  type ReselectionLogEntry,
  type ReselectionOutcome,
  type ReselectionProposal,
  type ReselectionRegime,
  type StrategyRegimeEvidence,
} from "../data/reselectionPorts";

/* ------------------------------------------------------------------ */
/* Schedule guard (same idiom, own durable marker)                     */
/* ------------------------------------------------------------------ */

/**
 * Durable marker key for the last day the strategy-bank re-selection
 * fired, stored in mas_settings (YYYY-MM-DD, UTC). Distinct from the
 * research run's marker: the two nightly jobs are independent.
 */
export const STRATEGY_BANK_LAST_RUN_KEY = "strategy_bank_reselection_last_run";

/**
 * Decide whether the nightly re-selection should fire at `now`,
 * given the durable last-fired date key. Fires exactly once per
 * weekday (Mon–Fri UTC), only at/after the configured
 * `scheduleUtcHour` (issue #6030: one declaration, shared with the
 * research guard — never a second literal). The caller owns
 * persistence and writes the marker only after a successful run, so
 * a failed night retries on the next tick (#354 semantics).
 */
export function shouldFireStrategyBankTick(
  now: Date,
  lastFiredDateKey: string | null,
  config: ResearchFireHourConfig = DEFAULT_RESEARCH_JOB_CONFIG
): ResearchTickDecision {
  const dateKey = researchTickDateKey(now);
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return { fire: false, dateKey, reason: "weekend" };
  if (now.getUTCHours() < config.scheduleUtcHour)
    return { fire: false, dateKey, reason: "too-early" };
  if (lastFiredDateKey === dateKey)
    return { fire: false, dateKey, reason: "already-fired" };
  return { fire: true, dateKey };
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Aggregate researchTrackRecord ideas into per-(strategy, regime)
 * evidence. The regime is the one recorded for the run that produced
 * the idea — joined by the caller, never guessed here. Ideas with no
 * evaluation count as published-only; an evaluation without a P&L
 * estimate cannot be scored and is not counted as evaluated.
 */
export function buildStrategyRegimeEvidence(
  ideas: Array<{
    structure: string;
    regime: ReselectionRegime;
    evaluation: {
      pnlEstimatePerUnit: number | null;
      rMultiple: number | null;
    } | null;
  }>
): StrategyRegimeEvidence[] {
  const byKey = new Map<
    string,
    {
      strategy: string;
      regime: ReselectionRegime;
      published: number;
      evaluated: number;
      wins: number;
      rSum: number;
      rCount: number;
    }
  >();
  for (const idea of ideas) {
    const key = `${idea.structure}|${idea.regime}`;
    let slice = byKey.get(key);
    if (!slice) {
      slice = {
        strategy: idea.structure,
        regime: idea.regime,
        published: 0,
        evaluated: 0,
        wins: 0,
        rSum: 0,
        rCount: 0,
      };
      byKey.set(key, slice);
    }
    slice.published++;
    const evaluation = idea.evaluation;
    if (evaluation && typeof evaluation.pnlEstimatePerUnit === "number") {
      slice.evaluated++;
      if (evaluation.pnlEstimatePerUnit > 0) slice.wins++;
      if (typeof evaluation.rMultiple === "number") {
        slice.rSum += evaluation.rMultiple;
        slice.rCount++;
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0))
    .map((slice) => ({
      strategy: slice.strategy,
      regime: slice.regime,
      published: slice.published,
      evaluated: slice.evaluated,
      winRate: slice.evaluated > 0 ? slice.wins / slice.evaluated : null,
      avgRMultiple: slice.rCount > 0 ? slice.rSum / slice.rCount : null,
    }));
}

/* ------------------------------------------------------------------ */
/* Re-selection                                                        */
/* ------------------------------------------------------------------ */

export interface ReselectionConfig {
  /** Minimum evaluated ideas before a strategy can hold a seat. */
  minEvaluated: number;
  /** Maximum strategies in the active set per regime. */
  maxActive: number;
  /** Hard per-run evaluation budget, in cost units (#495 cap pattern). */
  costCapUnits: number;
  /** Cost units charged per strategy evaluated. */
  costPerStrategyUnits: number;
}

export const DEFAULT_RESELECTION_CONFIG: ReselectionConfig = {
  minEvaluated: 10,
  maxActive: 5,
  costCapUnits: 100,
  costPerStrategyUnits: 10,
};

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Pure re-selection. Deterministic: evidence is evaluated in
 * strategy-name order (so cost-cap accounting is reproducible), and
 * selection ranks by score = winRate × avgRMultiple — a strategy must
 * both win at/above the overall baseline AND have a positive average
 * R to hold a seat. Everything else is in the log with its reason.
 */
export function reselectStrategyBank(input: {
  evidence: StrategyRegimeEvidence[];
  weights: Record<string, number>;
  regime: ReselectionRegime;
  overallWinRate: number | null;
  now: Date;
  config?: Partial<ReselectionConfig>;
}): ReselectionProposal {
  const config: ReselectionConfig = { ...DEFAULT_RESELECTION_CONFIG, ...(input.config ?? {}) };
  const baseline = input.overallWinRate ?? 0.5;
  const inRegime = input.evidence
    .filter((e) => e.regime === input.regime)
    .sort((a, b) => (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0));

  const log: ReselectionLogEntry[] = [];
  const eligible: ReselectionActiveEntry[] = [];
  let evaluatedCount = 0;
  let costUnitsUsed = 0;

  for (const slice of inRegime) {
    if (costUnitsUsed + config.costPerStrategyUnits > config.costCapUnits) {
      log.push({
        strategy: slice.strategy,
        outcome: "not_evaluated_cost_cap",
        loser: false,
        evaluated: slice.evaluated,
        winRate: slice.winRate,
        avgRMultiple: slice.avgRMultiple,
        score: null,
        reason: `Not evaluated: the run's cost cap (${config.costCapUnits} units) was exhausted by earlier strategies in deterministic order.`,
      });
      continue;
    }
    costUnitsUsed += config.costPerStrategyUnits;
    evaluatedCount++;

    if (slice.evaluated < config.minEvaluated || slice.winRate === null) {
      log.push({
        strategy: slice.strategy,
        outcome: "insufficient_evidence",
        loser: false,
        evaluated: slice.evaluated,
        winRate: slice.winRate,
        avgRMultiple: slice.avgRMultiple,
        score: null,
        reason: `Only ${slice.evaluated} evaluated ideas (minimum ${config.minEvaluated}); thin evidence never holds a seat.`,
      });
      continue;
    }

    const avgR = slice.avgRMultiple ?? 0;
    const score = round4(slice.winRate * avgR);
    const qualifies = slice.winRate >= baseline && avgR > 0;
    if (qualifies) {
      eligible.push({
        strategy: slice.strategy,
        score,
        winRate: slice.winRate,
        avgRMultiple: avgR,
        evaluated: slice.evaluated,
        weight: input.weights[slice.strategy] ?? null,
      });
      continue;
    }
    const loser = avgR < 0 || slice.winRate < baseline;
    log.push({
      strategy: slice.strategy,
      outcome: "deselected",
      loser,
      evaluated: slice.evaluated,
      winRate: slice.winRate,
      avgRMultiple: slice.avgRMultiple,
      score,
      reason:
        avgR <= 0
          ? `Deselected: negative average R (${avgR}) on ${slice.evaluated} evaluated ideas — a losing strategy on recorded evidence.`
          : `Deselected: win rate ${slice.winRate} is below the overall baseline ${baseline} on recorded evidence.`,
    });
  }

  eligible.sort(
    (a, b) => b.score - a.score || (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0)
  );
  const activeSet = eligible.slice(0, config.maxActive);
  for (const entry of activeSet) {
    log.push({
      strategy: entry.strategy,
      outcome: "selected",
      loser: false,
      evaluated: entry.evaluated,
      winRate: entry.winRate,
      avgRMultiple: entry.avgRMultiple,
      score: entry.score,
      reason: `Selected: win rate ${entry.winRate} at/above baseline ${baseline} with positive average R (${entry.avgRMultiple}) over ${entry.evaluated} evaluated ideas.`,
    });
  }
  for (const entry of eligible.slice(config.maxActive)) {
    log.push({
      strategy: entry.strategy,
      outcome: "eligible_over_cap",
      loser: false,
      evaluated: entry.evaluated,
      winRate: entry.winRate,
      avgRMultiple: entry.avgRMultiple,
      score: entry.score,
      reason: `Qualified on evidence but the active set is capped at ${config.maxActive} per regime; ranked below the selected strategies by score.`,
    });
  }

  return {
    regime: input.regime,
    generatedAt: input.now.toISOString(),
    governance: "proposal_only_not_promoted",
    overallWinRate: input.overallWinRate,
    activeSet,
    log,
    evaluatedCount,
    costUnitsUsed,
    costCapUnits: config.costCapUnits,
  };
}

/* ------------------------------------------------------------------ */
/* Durable transparency record (append-only, per tenant)               */
/* ------------------------------------------------------------------ */

function store(sql: ReselectionSqlExecutor): ReselectionStore {
  return new DoSqliteReselectionStore(sql);
}

export function ensureStrategyBankProposalTable(sql: any): void {
  store(sql).ensureTable();
}

/**
 * Append a re-selection proposal to the tenant's durable transparency
 * log. This writes ONLY to mas_strategy_bank_proposals — the weights
 * table is never touched here (Phase 5 owns promotion).
 */
export function recordReselectionProposal(
  sql: any,
  userLogin: string,
  proposal: ReselectionProposal
): string {
  ensureStrategyBankProposalTable(sql);
  const id = `sbp-${
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;
  store(sql).insertProposal(id, userLogin, proposal);
  return id;
}

export function listReselectionProposals(
  sql: any,
  userLogin: string,
  limit = 20
): Array<{ id: string; regime: string; createdAt: string; proposal: ReselectionProposal }> {
  return store(sql).listProposals(userLogin, limit);
}
