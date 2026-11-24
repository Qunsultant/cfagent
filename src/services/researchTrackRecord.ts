/**
 * Issue #340: the research track record — every published idea (§9
 * record, written before outcomes were known) joined to its scheduled
 * evaluation results. Pure builder over the stored shapes: no
 * recomputation, no retrospective edits — render what was recorded.
 *
 * Join: evaluations belong to a run; an idea is matched by
 * (runId, symbol, structure). When a run was evaluated more than once,
 * the LATEST evaluation wins (evaluations are append-only snapshots).
 */

export type TrackRecordRegime = "bull" | "bear" | "chop" | "high_vol" | "unknown";

export interface TrackRecordIdea {
  runId: string;
  runCreatedAt: string;
  symbol: string;
  structure: string;
  outlook: string;
  thesis: string;
  invalidation: string;
  entrySpot: number | null;
  /**
   * The regime the producing run recorded in its report (Phase 6 join
   * for the Phase 5 evidence builders, which require the regime to be
   * joined by the caller, never guessed). "unknown" when the run
   * recorded no valid regime.
   */
  regime: TrackRecordRegime;
  /**
   * Contracts per structure unit, summed from the published legs'
   * |quantity|. null when the idea record carries no legs — the
   * Phase 5 after-cost scoring then counts the idea as unpriced
   * instead of assuming a contract count.
   */
  contractsPerUnit: number | null;
  /** Latest evaluation for this idea, or null when never evaluated. */
  evaluation: {
    evaluatedAt: string;
    invalidated: boolean;
    pnlEstimatePerUnit: number | null;
    /** pnl / published maxLoss — the R multiple, when computable. */
    rMultiple: number | null;
    evalSpot: number | null;
    directionCorrect: boolean | null;
    notes: string[];
  } | null;
}

export interface TrackRecordSlice {
  key: string;
  published: number;
  evaluated: number;
  /** Share of evaluated ideas with pnl > 0 (null when none evaluated). */
  winRate: number | null;
  avgRMultiple: number | null;
  /**
   * Issue #773 (b) — share of this family's DIRECTION-SCORED evaluations that
   * called the direction correctly (null when none scored). This is the input
   * the structure reorder was written for; before it, the reorder read a field
   * the slice never carried and silently never ran.
   */
  directionAccuracy: number | null;
}

export interface TrackRecord {
  published: number;
  evaluated: number;
  invalidated: number;
  winRate: number | null;
  directionAccuracy: number | null;
  avgPnlPerUnit: number | null;
  avgRMultiple: number | null;
  byStrategy: TrackRecordSlice[];
  byPeriod: TrackRecordSlice[];
  ideas: TrackRecordIdea[];
}

interface ReportLike {
  runId?: unknown;
  createdAt?: unknown;
  ideas?: unknown;
  regime?: unknown;
}

const TRACK_RECORD_REGIMES: ReadonlySet<string> = new Set([
  "bull",
  "bear",
  "chop",
  "high_vol",
  "unknown",
]);

/** The regime a run recorded on its report; anything else is "unknown" — never inferred from the outlook. */
/**
 * Issue #1742: exported so the D1 telemetry projector derives
 * the same regime string the dashboard reads (reuse, not a
 * second derivation). Pure; behavior unchanged.
 */
export function reportRegime(raw: unknown): TrackRecordRegime {
  const value =
    typeof raw === "string"
      ? raw
      : isObj(raw) && typeof raw.regime === "string"
        ? raw.regime
        : "";
  return (TRACK_RECORD_REGIMES.has(value) ? value : "unknown") as TrackRecordRegime;
}

/** Sum of |quantity| over an idea's published legs; null when no legs were recorded. */
function contractsPerUnitOf(rawIdea: Record<string, any>): number | null {
  if (!Array.isArray(rawIdea.legs) || rawIdea.legs.length === 0) return null;
  let total = 0;
  for (const leg of rawIdea.legs) {
    if (!isObj(leg) || typeof leg.quantity !== "number" || !Number.isFinite(leg.quantity)) {
      return null;
    }
    total += Math.abs(leg.quantity);
  }
  return total > 0 ? total : null;
}

interface EvaluationLike {
  runId?: unknown;
  evaluatedAt?: unknown;
  ideas?: unknown;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sliceStats(rows: TrackRecordIdea[]): Omit<TrackRecordSlice, "key" | "published"> {
  const evaluated = rows.filter((r) => r.evaluation != null);
  const wins = evaluated.filter(
    (r) => (r.evaluation!.pnlEstimatePerUnit ?? 0) > 0
  ).length;
  const scored = evaluated.filter((r) => r.evaluation!.directionCorrect != null);
  const correct = scored.filter((r) => r.evaluation!.directionCorrect === true).length;
  return {
    evaluated: evaluated.length,
    winRate: evaluated.length > 0 ? wins / evaluated.length : null,
    avgRMultiple: mean(
      evaluated
        .map((r) => r.evaluation!.rMultiple)
        .filter((v): v is number => v != null)
    ),
    // Issue #773 (b): the per-family direction accuracy, from the recorded
    // scores only — an unscored family stays null, never a guessed 0.
    directionAccuracy: scored.length > 0 ? correct / scored.length : null,
  };
}

function groupSlices(
  ideas: TrackRecordIdea[],
  keyOf: (idea: TrackRecordIdea) => string
): TrackRecordSlice[] {
  const groups = new Map<string, TrackRecordIdea[]>();
  for (const idea of ideas) {
    const key = keyOf(idea);
    const list = groups.get(key) ?? [];
    list.push(idea);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, published: rows.length, ...sliceStats(rows) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function buildTrackRecord(
  reports: unknown[],
  evaluations: unknown[]
): TrackRecord {
  // Latest evaluation per run.
  const latestByRun = new Map<string, { evaluatedAt: string; ideas: any[] }>();
  for (const raw of evaluations) {
    if (!isObj(raw)) continue;
    const ev = raw as EvaluationLike;
    const runId = str(ev.runId);
    if (!runId) continue;
    const evaluatedAt = str(ev.evaluatedAt);
    const existing = latestByRun.get(runId);
    if (!existing || evaluatedAt > existing.evaluatedAt) {
      latestByRun.set(runId, {
        evaluatedAt,
        ideas: Array.isArray(ev.ideas) ? (ev.ideas as any[]) : [],
      });
    }
  }

  const ideas: TrackRecordIdea[] = [];
  for (const raw of reports) {
    if (!isObj(raw)) continue;
    const report = raw as ReportLike;
    const runId = str(report.runId);
    if (!runId || !Array.isArray(report.ideas)) continue;
    const runCreatedAt = str(report.createdAt);
    const regime = reportRegime(report.regime);
    const latest = latestByRun.get(runId);
    for (const rawIdea of report.ideas as any[]) {
      if (!isObj(rawIdea)) continue;
      const symbol = str(rawIdea.symbol);
      const structure = str(rawIdea.structure);
      if (!symbol) continue;
      const maxLoss = num((rawIdea.economics as any)?.maxLoss);
      let evaluation: TrackRecordIdea["evaluation"] = null;
      if (latest) {
        const match = latest.ideas.find(
          (e) => isObj(e) && str(e.symbol) === symbol && str(e.structure) === structure
        );
        if (match) {
          const pnl = num(match.pnlEstimatePerUnit);
          evaluation = {
            evaluatedAt: latest.evaluatedAt,
            invalidated: match.invalidated === true,
            pnlEstimatePerUnit: pnl,
            rMultiple:
              pnl != null && maxLoss != null && maxLoss > 0 ? pnl / maxLoss : null,
            evalSpot: num(match.evalSpot),
            directionCorrect:
              typeof match.directionCorrect === "boolean"
                ? match.directionCorrect
                : null,
            notes: Array.isArray(match.notes) ? match.notes.map(str) : [],
          };
        }
      }
      ideas.push({
        runId,
        runCreatedAt,
        symbol,
        structure,
        outlook: str(rawIdea.outlook),
        thesis: str(rawIdea.thesis),
        invalidation: str(rawIdea.invalidation),
        entrySpot: num(rawIdea.entrySpot),
        regime,
        contractsPerUnit: contractsPerUnitOf(rawIdea),
        evaluation,
      });
    }
  }

  // Newest publications first.
  ideas.sort((a, b) => b.runCreatedAt.localeCompare(a.runCreatedAt));

  const evaluated = ideas.filter((i) => i.evaluation != null);
  const directionScored = evaluated.filter(
    (i) => i.evaluation!.directionCorrect != null
  );
  return {
    published: ideas.length,
    evaluated: evaluated.length,
    invalidated: evaluated.filter((i) => i.evaluation!.invalidated).length,
    winRate:
      evaluated.length > 0
        ? evaluated.filter((i) => (i.evaluation!.pnlEstimatePerUnit ?? 0) > 0)
            .length / evaluated.length
        : null,
    directionAccuracy:
      directionScored.length > 0
        ? directionScored.filter((i) => i.evaluation!.directionCorrect).length /
          directionScored.length
        : null,
    avgPnlPerUnit: mean(
      evaluated
        .map((i) => i.evaluation!.pnlEstimatePerUnit)
        .filter((v): v is number => v != null)
    ),
    avgRMultiple: mean(
      evaluated
        .map((i) => i.evaluation!.rMultiple)
        .filter((v): v is number => v != null)
    ),
    byStrategy: groupSlices(ideas, (i) => i.structure || "(unknown)"),
    byPeriod: groupSlices(ideas, (i) => i.runCreatedAt.slice(0, 7) || "(unknown)"),
    ideas,
  };
}
