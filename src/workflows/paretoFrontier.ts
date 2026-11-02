/**
 * Issue #2773 (under #2764) — stock-only deterministic Pareto
 * frontier evaluation, a post-screening DAG stage.
 *
 * Dominance (deterministic, no judgement): candidate A
 * dominates candidate B iff A is at least as good as B on
 * EVERY objective and strictly better on AT LEAST ONE.
 * "Better" is per-objective direction (maximize: higher;
 * minimize: lower). Exact ties on every objective dominate
 * neither way — tied candidates are co-frontier, not
 * dominated. There is NO combined score anywhere in this
 * module: no weighted sum, no ranker disguised as Pareto.
 * The output is a frontier set + a dominated set (each with
 * its dominators and per-objective gaps) + an unscored set
 * — never a single ranked list, never a trade, never a
 * promotion. Nothing here places orders or promotes a
 * candidate; consumers decide what to do with the frontier.
 *
 * Scoring rules (loud, never silent):
 *   - Empty objective list, duplicate candidate ids, or
 *     duplicate objective ids throw.
 *   - A candidate missing an objective value, or carrying a
 *     non-finite one, is UNSCORED (with the missing
 *     objective ids named) — never silently dropped, never
 *     placed on the frontier, never dominated.
 *   - Gaps: per objective, the shortfall to the STRONGEST
 *     dominator on that objective (direction-adjusted
 *     units), so a dominated candidate's gaps name exactly
 *     what it would need to reach the frontier.
 *   - Output order is deterministic: frontier sorted by
 *     candidate id, dominators sorted by id, gaps keyed by
 *     objective id in objective order. Shuffling the input
 *     never changes the output.
 *
 * Stock stage (stock-only usage): paretoFrontierForScreen
 * maps screened rows to candidates on the DEFAULT stock
 * objectives — momentumScore (maximize) and changePercent
 * (maximize), both always present on ScannedStock rows.
 * RSI is deliberately NOT an objective: no RSI direction is
 * inherently better (oversold vs overbought depends on
 * thesis); RSI stays a filter/gate, never a frontier axis.
 * Callers may add peRatio (minimize) as an extra objective;
 * rows lacking it then land in unscored, by the rule above.
 */

export interface ParetoObjective {
  id: string;
  direction: "maximize" | "minimize";
}

export interface ParetoCandidate {
  id: string;
  values: Record<string, number>;
}

export interface DominatedParetoCandidate {
  id: string;
  values: Record<string, number>;
  dominators: string[];
  /** Per-objective shortfall to the strongest dominator on that objective. */
  gaps: Record<string, number>;
}

export interface UnscoredParetoCandidate {
  id: string;
  values: Record<string, number>;
  missingObjectiveIds: string[];
}

export interface ParetoEvaluation {
  objectives: ParetoObjective[];
  frontier: ParetoCandidate[];
  dominated: DominatedParetoCandidate[];
  unscored: UnscoredParetoCandidate[];
}

/** Direction-adjusted comparison: positive means `a` is better than `b` on this objective. */
function better(a: number, b: number, direction: "maximize" | "minimize"): number {
  return direction === "maximize" ? a - b : b - a;
}

/** True iff `a` dominates `b` on every objective (strictly better on at least one). */
export function paretoDominates(
  a: ParetoCandidate,
  b: ParetoCandidate,
  objectives: ParetoObjective[],
): boolean {
  let strictlyBetter = false;
  for (const objective of objectives) {
    const diff = better(a.values[objective.id], b.values[objective.id], objective.direction);
    if (diff < 0) return false;
    if (diff > 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function evaluateParetoFrontier(
  candidates: ParetoCandidate[],
  objectives: ParetoObjective[],
): ParetoEvaluation {
  if (objectives.length === 0) {
    throw new Error("Pareto evaluation requires at least one objective.");
  }
  const objectiveIds = new Set<string>();
  for (const objective of objectives) {
    if (objectiveIds.has(objective.id)) {
      throw new Error(`Duplicate Pareto objective id: ${objective.id}`);
    }
    objectiveIds.add(objective.id);
  }
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new Error(`Duplicate Pareto candidate id: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
  }

  const scored: ParetoCandidate[] = [];
  const unscored: UnscoredParetoCandidate[] = [];
  for (const candidate of candidates) {
    const missingObjectiveIds = objectives
      .filter((objective) => {
        const value = candidate.values[objective.id];
        return typeof value !== "number" || !Number.isFinite(value);
      })
      .map((objective) => objective.id);
    if (missingObjectiveIds.length > 0) {
      unscored.push({ id: candidate.id, values: { ...candidate.values }, missingObjectiveIds });
    } else {
      scored.push({ id: candidate.id, values: { ...candidate.values } });
    }
  }

  const dominatorsById = new Map<string, ParetoCandidate[]>();
  for (const candidate of scored) {
    dominatorsById.set(
      candidate.id,
      scored.filter((other) => other.id !== candidate.id && paretoDominates(other, candidate, objectives)),
    );
  }

  const frontier: ParetoCandidate[] = [];
  const dominated: DominatedParetoCandidate[] = [];
  for (const candidate of scored) {
    const dominators = dominatorsById.get(candidate.id) ?? [];
    if (dominators.length === 0) {
      frontier.push(candidate);
      continue;
    }
    const gaps: Record<string, number> = {};
    for (const objective of objectives) {
      // Strongest dominator on this objective = largest
      // direction-adjusted shortfall of the candidate.
      gaps[objective.id] = Math.max(
        ...dominators.map((dominator) =>
          better(dominator.values[objective.id], candidate.values[objective.id], objective.direction),
        ),
      );
    }
    dominated.push({
      id: candidate.id,
      values: { ...candidate.values },
      dominators: dominators.map((d) => d.id).sort(),
      gaps,
    });
  }

  frontier.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  dominated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unscored.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    objectives: objectives.map((o) => ({ ...o })),
    frontier,
    dominated,
    unscored,
  };
}

/** A screened stock row, structurally — the stage never imports the screener agent. */
export interface ParetoStockRow {
  symbol: string;
  momentumScore: number;
  changePercent: number;
  peRatio?: number | null;
}

/** Default stock objectives: momentumScore + changePercent, both maximize. RSI is excluded by design (see header). */
export const DEFAULT_STOCK_PARETO_OBJECTIVES: readonly ParetoObjective[] = [
  { id: "momentumScore", direction: "maximize" },
  { id: "changePercent", direction: "maximize" },
];

/** Optional third stock objective: peRatio, minimize. Rows lacking it land in unscored. */
export const PE_RATIO_PARETO_OBJECTIVE: ParetoObjective = { id: "peRatio", direction: "minimize" };

/**
 * Post-screening stage: evaluate the frontier over a run's
 * scanned rows. Pure — no ranking change, no promotion, no
 * order. Callers pass extra objectives (e.g. peRatio) only
 * when they accept the unscored rule for rows lacking them.
 */
export function paretoFrontierForScreen(
  rows: ParetoStockRow[],
  extraObjectives: ParetoObjective[] = [],
): ParetoEvaluation {
  const objectives = [...DEFAULT_STOCK_PARETO_OBJECTIVES, ...extraObjectives];
  const candidates: ParetoCandidate[] = rows.map((row) => ({
    id: row.symbol,
    values: {
      momentumScore: row.momentumScore,
      changePercent: row.changePercent,
      ...(row.peRatio !== undefined && row.peRatio !== null ? { peRatio: row.peRatio } : {}),
    },
  }));
  return evaluateParetoFrontier(candidates, objectives);
}
