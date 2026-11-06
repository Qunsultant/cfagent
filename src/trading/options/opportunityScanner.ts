/**
 * Cross-symbol opportunity scanner: runs the options agent pipeline over many
 * underlyings (a watchlist, an explicit list, or a stock-screen universe) and
 * ranks each symbol's best trade against the others.
 */

import { OptionsDataAgent } from "./optionsDataAgent";
import type { OptionsDataSnapshot } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RankedStrategy, type RiskProfile } from "./recommendationAgent";
import type { EventCalendarInfo, StrategyCandidate, StrategyRequest } from "./strategyEngine";
import { DEFAULT_MAX_DTE, MAX_EXPIRATIONS_PER_SYMBOL, MAX_SCAN_SYMBOLS as DEFAULT_MAX_SCAN_SYMBOLS, type DynamicOptionsScreener } from "../optionsScreener";
import { getOpportunityScannerConfig, type EtapiFitGateConfig } from "../../config/etapiConfig";
import { defaultRegistry } from "./strategies/catalog";
import { buildStrategyCoverage } from "../optionsReportMatrix";
import { deriveFetchBands, resolveStrategyMode } from "./strategyChoice";
import { applyProfileFields, profileDisclosure, toProfileRef, type ProfileRef, type StrategyProfile } from "./strategyProfile";
import type { ScreenedOptionContractItem } from "../../types";
import { RiskProfileComposite, type KernelCandidate } from "../../services/recommendationKernel";

const baseOppConfig = getOpportunityScannerConfig();
export const MAX_SCAN_SYMBOLS = baseOppConfig.maxScanSymbols;
const CONCURRENCY = baseOppConfig.concurrency;

/**
 * Version of the scan model (issue #27): the semantics that produced a
 * result — scoring, the fit gate, the fit matrix, and the scan modes.
 * Bump discipline: ANY change to scoring, gating, matrix construction,
 * or mode semantics bumps this version (patch for purely additive
 * fields, minor/major for changed verdicts), so persisted runs stamped
 * with different model versions are never silently compared as if they
 * were produced by the same model.
 */
/** 1.2.1 (issue #2600): scanner fetch selection honours strategyMode —
 *  mode "all" now fetches contra-thesis templates' horizons too, so
 *  all-mode verdicts for those templates change from "not evaluated"
 *  to evaluated. Thesis-mode scans are byte-identical to 1.2.0. */
export const SCAN_MODEL_VERSION = "1.2.1";

/**
 * The two strategy questions a scan can answer (issue #23):
 *  - "strategy_fit" — Q1: "which names fit my strategy?" Returns the full
 *    accounting: every fitting name in `fits`, not a best-trade top-N.
 *  - "per_name_best" — Q2: "what is the best trade per name?" The headline
 *    list stays `opportunities` (top-N best-per-name), exactly the
 *    pre-#23 behavior, and is the default.
 */
export type ScanMode = "strategy_fit" | "per_name_best";

/**
 * Per-name parameters for one symbol in a scan (issue #23): a thesis
 * and/or target that override the shared template for that symbol only.
 * Supplied explicitly at the API/template level (e.g. the #84 UI form);
 * NLQ prose parsing does not produce these.
 */
export interface ScanSymbolOverride {
  thesis?: StrategyRequest["thesis"];
  target?:
    | { kind: "absolute"; price: number }
    | { kind: "percent"; pct: number }
    /** Target expressed in expected-move units (issue #25, completing
     *  the #23 deferral): spot × (1 + multiple × EM%), where EM% is the
     *  1-sigma move to expiry implied by the symbol's own chain. Needs
     *  an expected-move estimate; without one it cannot resolve and the
     *  symbol falls back to its thesis derivation. */
    | { kind: "em"; multiple: number };
}

/** Where a scan row's target came from (issues #19, #23, #25): the
 *  user's stated target for the symbol ("stated"), a per-name percent
 *  override ("percent"), a per-name expected-move override ("em"), or
 *  the thesis derivation ("thesis" — expected-move-based when the
 *  symbol's chain yields an estimate, the legacy spot factor when not). */
export type ScanTargetSource = "stated" | "percent" | "thesis" | "em";

export type ScanRequestTemplate = Omit<StrategyRequest, "symbol" | "targetPrice"> & {
  /**
   * A target price the user stated for one specific symbol (issue #19).
   * Scoped by design: it applies only to `symbol` when one is attached;
   * every other scanned symbol — and every symbol when no symbol is
   * attached — gets a thesis-derived target instead. A target stated in a
   * single-name question must never leak onto the other names in a scan.
   */
  statedTarget?: { price: number; symbol?: string };
  /**
   * Per-name parameters keyed by (uppercase) symbol (issue #23). An
   * override target wins over the shared statedTarget for that symbol —
   * it is the more specific instruction.
   */
  perSymbol?: Record<string, ScanSymbolOverride>;
};

export interface OpportunityRow {
  symbol: string;
  underlyingPrice: number;
  targetPrice: number;
  /** Where this row's target came from; see ScanTargetSource. */
  targetSource: ScanTargetSource;
  /** The target's distance from spot in expected-move units (issue
   *  #25): (target − spot) / (spot × EM%), where EM% is the 1-sigma
   *  move to expiry implied by this name's own chain. The cross-name
   *  comparison unit — two names whose targets sit at the same EM
   *  distance are being asked for statistically equivalent moves.
   *  Null when the chain yielded no expected-move estimate. */
  targetEmUnits: number | null;
  pick: BestTradePick;
  score: number;
  /** Fit-gate verdict for this row's pick (issue #24): "fit" when the
   *  pick clears every gate criterion, otherwise "borderline" with the
   *  failed criteria in gateReasons. (A row exists only when there is a
   *  pick, so "no_fit" never appears here.) */
  gateBucket: FitGateBucket;
  gateReasons: string[];
}

/** The fit gate's qualification buckets (issue #24). */
export type FitGateBucket = "fit" | "borderline" | "no_fit";

/** Fit-gate parameters (issue #24): the bar a symbol's best pick must
 *  clear to count as a fit. Resolved per scan from the config defaults
 *  in getOpportunityScannerConfig() plus any per-call overrides. */
export type FitGateParams = EtapiFitGateConfig;

const CONFIDENCE_RANK: Record<BestTradePick["confidence"], number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Percent rendering for gate prose: 0.35 → "35", 0.425 → "42.5". */
function gatePct(fraction: number): string {
  return (fraction * 100).toFixed(1).replace(/\.0$/, "");
}

/**
 * Evaluate one symbol's best-trade pick against the fit gate (issue
 * #24). Pure and exported for direct unit testing.
 *
 * A pick that clears every criterion is a "fit"; a pick that exists but
 * fails at least one is "borderline" (the criteria it failed are listed
 * in `reasons`, in a fixed order: composite, POP, freshness, confidence,
 * research-only). A pick with no best candidate (status "no_trade") is
 * "no_fit" with the recommender's rationale as the reason. Thresholds
 * are inclusive: a value exactly at a minimum passes. One nuance: the
 * recommender's stale-quote blocker merely restates the freshness fact,
 * so when requireFresh is waived it does not also disqualify the pick
 * via the research-only criterion (other blockers always do).
 */
export function evaluateFitGate(
  pick: BestTradePick,
  gate: FitGateParams,
): { bucket: FitGateBucket; reasons: string[] } {
  if (!pick.best) {
    return { bucket: "no_fit", reasons: pick.rationale.length ? [...pick.rationale] : ["No qualifying strategy"] };
  }
  const candidate = pick.best.candidate;
  const reasons: string[] = [];
  if (pick.best.compositeScore < gate.minCompositeScore) {
    reasons.push(`composite score ${pick.best.compositeScore.toFixed(1)} below minimum ${gate.minCompositeScore}`);
  }
  if (candidate.modelImpliedProbabilityOfProfit < gate.minProbabilityOfProfit) {
    reasons.push(
      `probability of profit ${(candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% below minimum ${gatePct(gate.minProbabilityOfProfit)}%`,
    );
  }
  if (gate.requireFresh && candidate.dataFreshness !== "FRESH") {
    reasons.push(`quote data is ${candidate.dataFreshness}`);
  }
  if (CONFIDENCE_RANK[pick.confidence] < CONFIDENCE_RANK[gate.minConfidence]) {
    reasons.push(`confidence ${pick.confidence} below minimum ${gate.minConfidence}`);
  }
  if (pick.status === "research_only") {
    // Status and blockers are two views of the same fact, so they surface
    // as ONE reason listing the blockers. The stale-quote blocker is a
    // third view of the freshness fact: when the caller waives the
    // freshness criterion (requireFresh false) it is governed by that
    // criterion alone and does not disqualify via research-only as well.
    // Every other blocker (no positive max profit, POP under 20%) always
    // counts — no gate parameter waives it.
    const effectiveBlockers = gate.requireFresh
      ? pick.blockers
      : pick.blockers.filter((b) => !b.startsWith("Quote data is "));
    if (effectiveBlockers.length) {
      reasons.push(`pick is research-only (blockers present): ${effectiveBlockers.slice(0, 2).join("; ")}`);
    } else if (pick.blockers.length === 0) {
      // Unreachable today (research_only implies blockers); kept so a
      // future blocker-free research_only still fails the gate.
      reasons.push("pick is research-only");
    }
  }
  return { bucket: reasons.length === 0 ? "fit" : "borderline", reasons };
}

/** The best screen-passing candidate of one strategy type for one symbol
 *  (issue #22), flattened from the ranked matched set. */
export interface ScanMatrixCellBest {
  candidateId: string;
  label: string;
  compositeScore: number;
  score: number;
  expirationDate: string;
  legs: StrategyCandidate["legs"];
  netDebit: number;
  maxLoss: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  targetRewardRisk: number;
  probabilityOfProfit: number;
}

/** One strategy type's fit for one symbol: how many candidates were built,
 *  how many passed the screen, how many were rejected (and why), and the
 *  best passing candidate when there is one. */
export interface ScanMatrixCell {
  strategyType: string;
  best: ScanMatrixCellBest | null;
  evaluatedCount: number;
  passedCount: number;
  rejectedCount: number;
  rejectionReasons: Record<string, number>;
}

/** One symbol's row in the names × strategy-types fit matrix (issue #22).
 *  The verdict is a screen-pass verdict only — "pass" means at least one
 *  candidate passed the screen in at least one type. Qualification is a
 *  separate layer (issue #24): gateBucket applies the fit gate to the
 *  symbol's best pick — "fit" / "borderline" for evaluated symbols with
 *  a pick, "no_fit" for evaluated symbols with none — and is null for
 *  skipped symbols, which were never judged. */
export interface ScanMatrixRow {
  symbol: string;
  verdict: "pass" | "no_pass" | "skipped";
  /** Set only when verdict is "skipped": why the symbol was never evaluated. */
  skipReason?: string;
  /** Null when the symbol was skipped before a spot price existed. */
  targetPrice: number | null;
  targetSource: ScanTargetSource | null;
  /** The target's distance from spot in expected-move units (issue
   *  #25); null for skipped symbols and when the chain yielded no
   *  expected-move estimate. */
  targetEmUnits: number | null;
  /** One cell per strategy type that had at least one built candidate;
   *  empty for skipped symbols. */
  cells: ScanMatrixCell[];
  /** Fit-gate bucket for this symbol (issue #24); null when skipped. */
  gateBucket: FitGateBucket | null;
  /** The gate's failed criteria (or the no-trade rationale); empty for
   *  fits and for skipped symbols. */
  gateReasons: string[];
}

/** One strategy type's aggregate across every symbol in a scan (issue
 *  #26): the cross-symbol roll-up of the fit matrix's per-symbol cells.
 *  Counts are sums of the cells' own counts, so they reconcile with the
 *  matrix exactly. Semantics note: "passed" here is the #22 screen-pass
 *  (the scanner's StrategyRiskAgent screen) — the single-name roll-up
 *  (StrategyTypeRollup in strategies/ledger.ts) counts acceptance-rule
 *  passes from the evaluation ledger instead. The two surfaces keep
 *  their own pipeline's meaning; they are not the same gate. */
export interface ScanTypeRollup {
  strategyType: string;
  /** Symbols whose matrix row has a cell of this type (i.e. at least
   *  one candidate of the type was built for the symbol). Skipped
   *  symbols have no cells and contribute nothing. */
  symbolsEvaluated: number;
  /** Symbols whose cell for this type has at least one screen-passing
   *  candidate. */
  symbolsPassed: number;
  evaluatedCount: number;
  passedCount: number;
  rejectedCount: number;
  /** Rejection-reason histogram merged across symbols. */
  rejectionReasons: Record<string, number>;
  /** The highest-composite cell best of this type across the scan,
   *  with the symbol it belongs to; null when no symbol produced a
   *  passing candidate of this type. */
  bestOverall: ({ symbol: string } & ScanMatrixCellBest) | null;
}

/**
 * Aggregate a scan's fit matrix into per-strategy-type roll-ups (issue
 * #26). Pure and exported for direct unit testing. Ordering follows the
 * matrix-cell discipline: best composite descending, best-less types
 * last, strategy type ascending on ties. A bestOverall tie on
 * compositeScore breaks by symbol ascending, so the aggregate is
 * independent of batch order.
 */
export function rollupScanTypes(matrix: ScanMatrixRow[]): ScanTypeRollup[] {
  const byType = new Map<string, ScanTypeRollup>();
  for (const row of matrix) {
    for (const cell of row.cells) {
      let entry = byType.get(cell.strategyType);
      if (!entry) {
        entry = {
          strategyType: cell.strategyType,
          symbolsEvaluated: 0,
          symbolsPassed: 0,
          evaluatedCount: 0,
          passedCount: 0,
          rejectedCount: 0,
          rejectionReasons: {},
          bestOverall: null,
        };
        byType.set(cell.strategyType, entry);
      }
      entry.symbolsEvaluated++;
      if (cell.passedCount > 0) entry.symbolsPassed++;
      entry.evaluatedCount += cell.evaluatedCount;
      entry.passedCount += cell.passedCount;
      entry.rejectedCount += cell.rejectedCount;
      for (const [reason, count] of Object.entries(cell.rejectionReasons)) {
        entry.rejectionReasons[reason] = (entry.rejectionReasons[reason] ?? 0) + count;
      }
      if (cell.best) {
        const current = entry.bestOverall;
        if (
          !current ||
          cell.best.compositeScore > current.compositeScore ||
          (cell.best.compositeScore === current.compositeScore && row.symbol < current.symbol)
        ) {
          entry.bestOverall = { symbol: row.symbol, ...cell.best };
        }
      }
    }
  }
  return [...byType.values()].sort((a, b) => {
    const sa = a.bestOverall?.compositeScore;
    const sb = b.bestOverall?.compositeScore;
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    if (sa !== undefined && sb === undefined) return -1;
    if (sa === undefined && sb !== undefined) return 1;
    return a.strategyType.localeCompare(b.strategyType);
  });
}

/** What a scan was asked (issue #27): the resolved template fields that
 *  shaped the run, the mode, the ranking profile, and the screen filter.
 *  The resolved fit gate rides separately on the result as `gateParams`
 *  (issue #24) and is deliberately not duplicated here. When a saved
 *  strategy profile was applied (issue #28), `template` holds the
 *  EFFECTIVE (post-merge) fields and `profile` carries the full applied
 *  profile object, so a persisted run stays self-describing; it is null
 *  for profile-less scans. */
/** The caller's original request, recorded verbatim (issue #103) so a
 *  stored run can be REPLAYED, not just audited. Plain data in the
 *  unified request's field vocabulary (symbols, thesis, caps, profile
 *  selection, pagination) plus the template fields the unified request
 *  grew to carry (statedTarget, minDte, maxDte) — declared here, in the
 *  scanner's own module, so the scanner never imports the unified
 *  service's types (layering). Callers attach it to the result's
 *  requestSnapshot before persistence; the scanner itself never sets
 *  it (it cannot know the caller's envelope — defaults it resolved,
 *  fields it never saw). Absent on runs recorded before issue #103 and
 *  on results from callers that do not record one; replays of those
 *  fall back to mapping the effective template (issue #84 slice 5). */
export interface ScanRequestRecord {
  symbols?: string[];
  thesis?: StrategyRequest["thesis"];
  riskProfile?: RiskProfile;
  mode?: ScanMode;
  profileId?: string;
  profileName?: string;
  limit?: number;
  offset?: number;
  targetDate?: string;
  expectedIvDirection?: StrategyRequest["expectedIvDirection"];
  optimizationBias?: number;
  maxPlannedLoss?: number;
  minRewardRisk?: number;
  allowedStrategies?: StrategyRequest["allowedStrategies"];
  perSymbol?: Record<string, ScanSymbolOverride>;
  statedTarget?: { price: number; symbol?: string };
  minDte?: number;
  maxDte?: number;
  /** Issue #2600: the four controls as submitted/resolved. */
  strategyMode?: StrategyRequest["strategyMode"];
  farDated?: boolean;
  candidateLimit?: number | "all";
}

export interface ScanRequestSnapshot {
  /** The caller's original request, when the calling path recorded
   *  one (issue #103) — the replayable form of this snapshot. */
  request?: ScanRequestRecord;
  template: {
    thesis: StrategyRequest["thesis"];
    targetDate: string;
    minDte?: number;
    maxDte?: number;
    maxPlannedLoss: number;
    minRewardRisk: number;
    allowedStrategies: StrategyRequest["allowedStrategies"];
    /** Issue #2091: the scan's strategy scope, stamped by scan(). */
    evaluateAllStrategies?: boolean;
    /** Issue #2600: canonical mode as resolved by scan(). */
    strategyMode?: StrategyRequest["strategyMode"];
    /** Issue #2600: far-dated toggle as run (absent = legacy bands). */
    farDated?: boolean;
    statedTarget?: { price: number; symbol?: string };
    perSymbol?: Record<string, ScanSymbolOverride>;
  };
  mode: ScanMode;
  riskProfile: RiskProfile;
  strategyFilter?: StrategyScreenFilter;
  profile: StrategyProfile | null;
}

/** The resolved scanner configuration a scan ran under (issue #27),
 *  from getOpportunityScannerConfig(). */
export interface ScanConfigSnapshot {
  maxScanSymbols: number;
  targetFactors: Record<StrategyRequest["thesis"], number>;
  targetEmMultiples: Record<StrategyRequest["thesis"], number>;
}

/** Coverage accounting for a scan (issue #27): how much of the requested
 *  universe was actually judged. `considered` = unique symbols asked
 *  for; `scanned` = symbols in the (capped) batch; `truncated` =
 *  considered − scanned; `evaluated` = symbols with a non-skipped
 *  matrix row; `errors` = symbols skipped (never evaluated);
 *  `withTrades` mirrors the result's withTrades count. */
export interface ScanCoverage {
  considered: number;
  scanned: number;
  truncated: number;
  evaluated: number;
  errors: number;
  withTrades: number;
  /** Event-calendar coverage for this run (issue #16): how many of the
   *  scanned names carried live earnings/dividend calendar facts. A
   *  name without supplied coverage was judged with event risk
   *  unverified — the count is reported, never hidden. */
  eventCalendar: { covered: number; total: number; coveragePct: number };
}

export interface OpportunityScanResult {
  scanned: number;
  withTrades: number;
  opportunities: OpportunityRow[];
  skipped: Array<{ symbol: string; reason: string }>;
  truncatedSymbols: number;
  /** Plain-language disclosures about scan-level assumptions (e.g. how a
   *  stated target was scoped). Empty when there is nothing to disclose. */
  assumptions: string[];
  /** The full names × strategy-types fit matrix (issue #22): one row for
   *  every symbol in the scanned batch, in batch (input) order. */
  matrix: ScanMatrixRow[];
  /** Per-strategy-type roll-up across the whole scan (issue #26): the
   *  matrix aggregated by type — how many symbols evaluated/passed each
   *  type, candidate totals that reconcile with the matrix cells, and
   *  the best candidate of each type overall. Derived from `matrix`
   *  alone (rollupScanTypes); carries no new verdicts. */
  typeRollup: ScanTypeRollup[];
  /** Which of the two strategy questions this scan answered (issue #23). */
  mode: ScanMode;
  /** Strategy-fit mode only: the matrix rows whose fit-gate bucket is
   *  "fit" (issue #24 — a gated fit implies a screen pass, since a pick
   *  exists), paginated by the scan's offset/limit. Empty in
   *  per_name_best mode, where `opportunities` is the headline list. */
  fits: ScanMatrixRow[];
  /** Strategy-fit mode only: total gated "fit" rows BEFORE pagination
   *  slicing. 0 in per_name_best mode. */
  fitsTotal: number;
  /** Fit-gate accounting over EVALUATED symbols (issue #24): counts of
   *  matrix rows by gate bucket. Skipped symbols are not counted — they
   *  were never judged. */
  gate: { fit: number; borderline: number; noFit: number };
  /** Every matrix row whose gate bucket is "borderline", in batch
   *  order, in both modes (issue #24). */
  borderline: ScanMatrixRow[];
  /** The resolved fit-gate parameters this scan was judged under
   *  (issue #24) — provenance for every "fit" declared in the result. */
  gateParams: FitGateParams;
  /** The saved strategy profile this scan ran under (issue #28): id,
   *  name, and version — the acceptance stamp that makes verdicts
   *  comparable across sessions. Null when no profile was applied; the
   *  full profile object rides in requestSnapshot.profile. */
  profileRef: ProfileRef | null;
  /** The generated PDF report's storage key when the producing flow
   *  rendered one before the run was saved (issue #1239): the scan
   *  history projection carries it so the run can offer its download.
   *  Optional — most producers render the report after saving the
   *  scan, and their summaries simply lack it (absent = no key). */
  pdfKey?: string;
  /** The generated workbook/CSV storage keys, mirroring pdfKey:
   *  stamped by producers that rendered them before the run was
   *  saved, or backfilled onto the saved scan row afterwards.
   *  Optional — absent = no key. */
  xlsxKey?: string;
  csvKey?: string;
  /** When this result was generated, ISO 8601 (issue #27). */
  generatedAt: string;
  /** The scan-model version that produced this result (issue #27);
   *  see SCAN_MODEL_VERSION for the bump discipline. */
  modelVersion: string;
  /** What the scan was asked — template, mode, profile, filter
   *  (issue #27). */
  requestSnapshot: ScanRequestSnapshot;
  /** The resolved scanner config the scan ran under (issue #27). */
  configSnapshot: ScanConfigSnapshot;
  /** Coverage accounting (issue #27): how much of the requested
   *  universe was actually judged. */
  coverage: ScanCoverage;
  /** Issue #2091: the chain horizon this scan actually fetched (the
   *  dataMaxDte used for the snapshot load), and which wanted strategies
   *  the fetched chain evaluated vs not — with each not-evaluated
   *  strategy's reason named. Collation recomputes it from the merged
   *  matrix; the monolithic scan stamps it directly. */
  fetchedMaxDte?: number;
  strategyCoverage?: {
    scope: "all" | "thesis";
    evaluatedStrategyIds: string[];
    notEvaluated: Array<{ id: string; label: string; reason: string }>;
  };
  /** Issue #1290 (#1173 R6): set when coverage is partial — the run
   *  publishes as a *qualified partial* (the options mirror of the
   *  stock #462 doctrine): never presented as a complete scan, and
   *  never a failure while something evaluated. Zero evaluated is
   *  turned into a coded failure by the scheduled gate (FAILURE_SCREEN_NO_CONTRACTS_EVALUATED). */
  partial?: OptionsPartialQualification;
}

/**
 * Issue #1290: qualification metadata for an options scan that could
 * not judge its whole requested universe. Built once, at the scan
 * result's single assembly point, and carried on the result into the
 * summary, the PDF banner, and the scheduled gate — replacing the
 * pre-R6 state where partiality existed only as a console warning in
 * the scheduled flow.
 */
export interface OptionsPartialQualification {
  /** Underlyings actually evaluated (coverage.evaluated). */
  evaluatedCount: number;
  /** Underlyings requested (coverage.considered). */
  consideredCount: number;
  /** Symbols skipped with an error (coverage.errors). */
  coverageErrors: number;
  /** Symbols never attempted (universe cap / truncation). */
  truncatedCount: number;
  /** Dominant skip reason across the skipped symbols, when any. */
  topSkipReason?: string;
  /** How many skipped symbols carried that reason. */
  topSkipCount?: number;
}

/** Pure builder for the qualification above: undefined when coverage
 *  is complete (evaluated == considered) or the universe was empty. */
export function optionsPartialQualification(
  coverage: ScanCoverage,
  skipped: Array<{ reason?: unknown }>
): OptionsPartialQualification | undefined {
  if (coverage.considered <= 0 || coverage.evaluated >= coverage.considered) {
    return undefined;
  }
  const reasonCounts = new Map<string, number>();
  for (const entry of skipped) {
    const reason = typeof entry?.reason === "string" && entry.reason ? entry.reason : null;
    if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  let topSkipReason: string | undefined;
  let topSkipCount = 0;
  for (const [reason, count] of reasonCounts) {
    if (count > topSkipCount) {
      topSkipReason = reason;
      topSkipCount = count;
    }
  }
  return {
    evaluatedCount: coverage.evaluated,
    consideredCount: coverage.considered,
    coverageErrors: coverage.errors,
    truncatedCount: coverage.truncated,
    ...(topSkipReason ? { topSkipReason, topSkipCount } : {}),
  };
}

/** Collate independently scanned symbol shards into the same scan shape
 *  as a monolithic run. Global ranking, fit counts and coverage are
 *  recomputed here, after every shard has reached a terminal state. */
export function collateOpportunityScanShards(
  symbols: string[],
  results: OpportunityScanResult[],
  failed: Array<{ symbol: string; reason: string }> = [],
  now = new Date(),
  /**
   * Issue #2600: headline cap for the collated list, mirroring the
   * scan's candidateLimit option. Absent = the historical top-10;
   * "all" = every opportunity (explicit "all ranked", never a large
   * number). The shard executor passes the chain's stored cap here.
   */
  candidateLimit?: number | "all",
): OpportunityScanResult {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const first = results[0];
  const matrix = results.flatMap((result) => result.matrix);
  for (const item of failed) {
    matrix.push({
      symbol: item.symbol,
      verdict: "skipped",
      skipReason: item.reason,
      targetPrice: null,
      targetSource: null,
      targetEmUnits: null,
      cells: [],
      gateBucket: null,
      gateReasons: [],
    });
  }
  const skipped = [...results.flatMap((result) => result.skipped), ...failed];
  const allOpportunities = results.flatMap((result) => result.opportunities)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const mode = first?.mode ?? "per_name_best";
  const gate = { fit: 0, borderline: 0, noFit: 0 };
  for (const row of matrix) {
    if (row.gateBucket === "fit") gate.fit++;
    else if (row.gateBucket === "borderline") gate.borderline++;
    else if (row.gateBucket === "no_fit") gate.noFit++;
  }
  const eventCovered = results.reduce((sum, result) => sum + result.coverage.eventCalendar.covered, 0);
  const evaluated = matrix.filter((row) => row.verdict !== "skipped").length;
  const coverage: ScanCoverage = {
    considered: unique.length,
    scanned: Math.min(unique.length, matrix.length),
    truncated: Math.max(0, unique.length - matrix.length),
    evaluated,
    errors: matrix.length - evaluated,
    withTrades: allOpportunities.length,
    eventCalendar: {
      covered: Math.min(unique.length, eventCovered),
      total: unique.length,
      coveragePct: unique.length ? Math.round((Math.min(unique.length, eventCovered) / unique.length) * 1000) / 10 : 0,
    },
  };
  const assumptions = [...new Set(results.flatMap((result) => result.assumptions)
    .filter((line) => !line.startsWith("Earnings/dividend calendar coverage:")))];
  if (results.some((result) => result.assumptions.some((line) => line.startsWith("Earnings/dividend calendar coverage:")))) {
    assumptions.push(
      `Earnings/dividend calendar coverage: ${coverage.eventCalendar.covered} of ${coverage.eventCalendar.total} names (${coverage.eventCalendar.coveragePct}%). Names without coverage were judged with event risk unverified.`,
    );
  }
  const fitsAll = mode === "strategy_fit" ? matrix.filter((row) => row.gateBucket === "fit") : [];
  const gateParams = first?.gateParams ?? baseOppConfig.fitGate;
  const result: OpportunityScanResult = {
    scanned: coverage.scanned,
    withTrades: allOpportunities.length,
    opportunities: candidateLimit === "all"
      ? allOpportunities
      : allOpportunities.slice(0, candidateLimit ?? 10),
    skipped,
    truncatedSymbols: coverage.truncated,
    assumptions,
    matrix,
    typeRollup: rollupScanTypes(matrix),
    mode,
    fits: fitsAll,
    fitsTotal: fitsAll.length,
    gate,
    borderline: matrix.filter((row) => row.gateBucket === "borderline"),
    gateParams,
    profileRef: first?.profileRef ?? null,
    generatedAt: now.toISOString(),
    modelVersion: first?.modelVersion ?? SCAN_MODEL_VERSION,
    requestSnapshot: first!.requestSnapshot,
    configSnapshot: first?.configSnapshot ?? {
      maxScanSymbols: baseOppConfig.maxScanSymbols,
      targetFactors: { ...baseOppConfig.targetFactors },
      targetEmMultiples: { ...baseOppConfig.targetEmMultiples },
    },
    coverage,
    // Issue #2091: recomputed from the merged matrix, not inherited from
    // a single shard — a shard's coverage names only its own symbols.
    fetchedMaxDte: first?.fetchedMaxDte,
    strategyCoverage: buildStrategyCoverage(
      matrix,
      first?.requestSnapshot.template.allowedStrategies,
      first?.fetchedMaxDte,
      first?.strategyCoverage?.scope ?? (first?.requestSnapshot.template.evaluateAllStrategies === true ? "all" : "thesis"),
    ),
  };
  result.partial = optionsPartialQualification(coverage, skipped);
  return result;
}

const TARGET_FACTOR: Record<StrategyRequest["thesis"], number> = baseOppConfig.targetFactors;
const TARGET_EM_MULTIPLE: Record<StrategyRequest["thesis"], number> = baseOppConfig.targetEmMultiples;

/** Signed EM-multiple rendering for disclosure prose: 0.6 → "+0.6",
 *  -0.6 → "-0.6", 0 → "0". */
function formatEmMultiple(multiple: number): string {
  const v = Number(multiple.toFixed(2));
  return v > 0 ? `+${v}` : `${v}`;
}

/** The chain fields the expected-move estimate reads. */
export type ExpectedMoveContract = Pick<
  ScreenedOptionContractItem,
  "strikePrice" | "impliedVolatility" | "expirationDate" | "symbol"
>;

/** A resolved expected-move estimate (issue #25; the window fields
 *  added for issue #533): the pct the scanner has always computed,
 *  plus the chosen contract's IV and expiry and the window length, so
 *  a consumer that derives a target from the estimate can disclose
 *  exactly which horizon and IV produced it. */
export interface ExpectedMoveEstimate {
  /** IV × sqrt(windowDays/365) — the 1-sigma move to the window expiry, as a fraction of spot. */
  pct: number;
  /** Implied volatility of the chosen most-ATM contract. */
  atmIv: number;
  /** Expiration date of the chosen contract (the window's end). */
  windowExpiry: string;
  /** Days from `now` to the window expiry (ceil, UTC). */
  windowDays: number;
}

/**
 * Estimate a symbol's expected move to expiry (issue #25): IV ×
 * sqrt(days/365) from the most at-the-money contract in the chain —
 * the 1-sigma move the chain itself implies. Pure and exported for
 * direct unit testing.
 *
 * Only contracts with a usable IV (> 0) and a parseable expirationDate
 * qualify. The most-ATM contract wins (min |strike − spot|); ties break
 * deterministically by earliest expirationDate, then lowest strike,
 * then symbol. Days are counted from `now` to the chosen expiry (UTC
 * midnight). Returns null when no contract qualifies or the chosen
 * expiry is today/past.
 */
export function estimateExpectedMove(
  contracts: ReadonlyArray<ExpectedMoveContract>,
  spotPrice: number,
  now: Date,
): ExpectedMoveEstimate | null {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  let best: { contract: ExpectedMoveContract; distance: number; expiryMs: number } | null = null;
  for (const contract of contracts) {
    const iv = contract.impliedVolatility;
    if (typeof iv !== "number" || !Number.isFinite(iv) || iv <= 0) continue;
    if (!Number.isFinite(contract.strikePrice)) continue;
    const expiryMs = Date.parse(`${contract.expirationDate}T00:00:00.000Z`);
    if (!Number.isFinite(expiryMs)) continue;
    const distance = Math.abs(contract.strikePrice - spotPrice);
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance &&
        (expiryMs < best.expiryMs ||
          (expiryMs === best.expiryMs &&
            (contract.strikePrice < best.contract.strikePrice ||
              (contract.strikePrice === best.contract.strikePrice &&
                contract.symbol < best.contract.symbol)))))
    ) {
      best = { contract, distance, expiryMs };
    }
  }
  if (best === null) return null;
  const days = Math.ceil((best.expiryMs - now.getTime()) / 86_400_000);
  if (days <= 0) return null;
  const atmIv = best.contract.impliedVolatility as number;
  const pct = atmIv * Math.sqrt(days / 365);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return { pct, atmIv, windowExpiry: best.contract.expirationDate, windowDays: days };
}

/**
 * The expected-move percentage alone (issue #25) — delegates to
 * estimateExpectedMove so there is exactly one selection algorithm.
 * Scanner callers that get null fall back to legacy percentage targets
 * for the symbol and disclose that they did; discovery derivation
 * (issue #533) consumes estimateExpectedMove directly and abstains on
 * null instead — it never takes the legacy fallback.
 */
export function estimateExpectedMovePct(
  contracts: ReadonlyArray<ExpectedMoveContract>,
  spotPrice: number,
  now: Date,
): number | null {
  return estimateExpectedMove(contracts, spotPrice, now)?.pct ?? null;
}

/**
 * Resolve the target price for one symbol in a scan (issue #19). A stated
 * target applies only to the symbol it was stated for; every other symbol
 * gets a thesis-derived target. Pure and exported for direct unit
 * testing.
 *
 * Precedence (issue #23): a per-name override target for this symbol wins
 * over the shared statedTarget — it is the more specific instruction. A
 * per-name thesis override (with no override target) also steers the
 * thesis used for the derived fallback.
 *
 * Units (issue #25): explicit targets (stated, absolute/percent
 * overrides) are absolute by definition and never move. The thesis
 * derivation is expressed in expected-move units when the caller
 * supplies an estimate (`em`): target = spot × (1 + multiple × EM%),
 * so the same thesis asks for a statistically equivalent move on every
 * name. Without an estimate it is the legacy spot × targetFactors
 * product, exactly as before #25. Either way, when an estimate exists
 * the result also reports the resolved target's distance in EM units.
 */
export function resolveScanTarget(
  template: ScanRequestTemplate,
  symbol: string,
  spotPrice: number,
  override?: ScanSymbolOverride,
  em?: { pct: number } | null,
): { targetPrice: number; source: ScanTargetSource; targetEmUnits: number | null } {
  const emPct = em && Number.isFinite(em.pct) && em.pct > 0 ? em.pct : null;
  const emUnits = (targetPrice: number): number | null =>
    emPct === null ? null : Number(((targetPrice - spotPrice) / (spotPrice * emPct)).toFixed(4));
  if (override?.target?.kind === "absolute") {
    return { targetPrice: override.target.price, source: "stated", targetEmUnits: emUnits(override.target.price) };
  }
  if (override?.target?.kind === "percent") {
    const targetPrice = Number((spotPrice * (1 + override.target.pct / 100)).toFixed(2));
    return { targetPrice, source: "percent", targetEmUnits: emUnits(targetPrice) };
  }
  if (override?.target?.kind === "em" && emPct !== null) {
    const targetPrice = Number((spotPrice * (1 + override.target.multiple * emPct)).toFixed(2));
    return { targetPrice, source: "em", targetEmUnits: emUnits(targetPrice) };
  }
  const stated = template.statedTarget;
  if (stated?.symbol && stated.symbol.trim().toUpperCase() === symbol.toUpperCase()) {
    return { targetPrice: stated.price, source: "stated", targetEmUnits: emUnits(stated.price) };
  }
  const thesis = override?.thesis ?? template.thesis;
  if (emPct !== null) {
    const targetPrice = Number((spotPrice * (1 + TARGET_EM_MULTIPLE[thesis] * emPct)).toFixed(2));
    return { targetPrice, source: "thesis", targetEmUnits: emUnits(targetPrice) };
  }
  return {
    targetPrice: Number((spotPrice * TARGET_FACTOR[thesis]).toFixed(2)),
    source: "thesis",
    targetEmUnits: null,
  };
}

/** Disclosure lines for a scan whose request carried a stated target. */
function scanTargetAssumptions(template: ScanRequestTemplate): string[] {
  const stated = template.statedTarget;
  if (!stated) return [];
  if (stated.symbol) {
    return [
      `Stated target $${stated.price.toFixed(2)} applied to ${stated.symbol.trim().toUpperCase()} only; every other symbol uses a thesis-derived target.`,
    ];
  }
  return [
    `A target of $${stated.price.toFixed(2)} was stated without a symbol, so it was not applied to any scanned name; thesis-derived targets were used for all symbols.`,
  ];
}

/**
 * The single disclosure line for per-name overrides (issue #23): one entry
 * per symbol in the scanned batch that carries an override, symbols
 * ascending. Returns null when no batch symbol is overridden (or every
 * override is empty), so the caller can omit the line entirely.
 */
function scanOverrideAssumption(template: ScanRequestTemplate, batch: string[]): string | null {
  if (!template.perSymbol) return null;
  const applied = batch
    .filter((symbol) => template.perSymbol![symbol])
    .sort((a, b) => a.localeCompare(b));
  const entries: string[] = [];
  for (const symbol of applied) {
    const override = template.perSymbol[symbol];
    const clauses: string[] = [];
    if (override.thesis) clauses.push(`thesis ${override.thesis}`);
    if (override.target?.kind === "absolute") {
      clauses.push(`target $${override.target.price.toFixed(2)}`);
    } else if (override.target?.kind === "percent") {
      clauses.push(`target ${override.target.pct >= 0 ? "+" : ""}${override.target.pct.toFixed(1)}%`);
    } else if (override.target?.kind === "em") {
      clauses.push(`target ${formatEmMultiple(override.target.multiple)} EM`);
    }
    if (clauses.length) entries.push(`${symbol} (${clauses.join(", ")})`);
  }
  return entries.length ? `Per-name overrides applied: ${entries.join("; ")}.` : null;
}

/**
 * Build one symbol's matrix cells from the scanner's own build/screen/rank
 * outputs (issue #22). Evaluated counts come from grouping the built
 * candidates by type; rejections are mapped back to their candidate's type;
 * the per-type best is the highest-composite entry of the ranked matched
 * set. Cells are ordered by best compositeScore descending (best-less cells
 * last), ties broken by strategy type ascending for determinism.
 */
/**
 * Rank-only wrapping of an engine candidate for the kernel ranking policy.
 * RiskProfileComposite reads only id / source / engineScore / status, so
 * the pipeline-only fields are carried honestly, not asserted: legs are not
 * carried (ranking never reads them), economics is null (no kernel
 * economics is computed here), status is "unverified" (screen-passed, never
 * kernel-gated), and the limitation says so. The wrapped objects are
 * transient — mapped back immediately, never stored or returned.
 */
function wrapScannerCandidateForPolicy(c: StrategyCandidate): KernelCandidate {
  return {
    id: c.id,
    symbol: c.symbol,
    structure: c.type,
    label: c.label,
    legs: [],
    economics: null,
    status: "unverified",
    provenance: "quant",
    chainProvenance: "live",
    definedRisk: Number.isFinite(c.maxLoss),
    marginEstimate: null,
    assignmentRisk: c.legs.some((l) => l.side === "SELL" && l.optionType !== "STOCK"),
    gateReasons: [],
    limitations: ["scanner rank-only wrapping: screen-passed, not kernel-gated/priced/falsified"],
    rationale: "",
    builderId: "opportunity-scanner",
    engineScore: c.score,
    source: c,
  };
}

/**
 * #1257 rankers-as-policies: the scanner's per-symbol rank, routed through
 * the kernel RiskProfileComposite policy instead of calling the recommender
 * directly. The ranker is the same function the policy wraps (and the panel
 * path uses), so the order is identical — the policy owns it.
 *
 * Fallback: when the policy cannot invoke the ranker (its guard requires
 * numeric maxPlannedLoss/minRewardRisk and a numeric targetRewardRisk on
 * every candidate), the adapter falls back to the direct ranker — today's
 * path, unchanged — rather than returning engineScore-ordered rows with
 * engine scores mislabeled as composites.
 */
export function rankScannerCandidates(
  rankFn: (
    candidates: StrategyCandidate[],
    request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk">,
    profile: RiskProfile,
  ) => RankedStrategy[],
  matched: StrategyCandidate[],
  request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk">,
  profile: RiskProfile,
): Array<{ candidate: StrategyCandidate; compositeScore: number }> {
  let rankedViaPolicy = false;
  const policy = new RiskProfileComposite({
    rankFn: (c, r, p) => {
      rankedViaPolicy = true;
      return rankFn(c, r, p);
    },
  });
  const policyRanked = policy.rank(matched.map(wrapScannerCandidateForPolicy), {
    request,
    riskProfile: profile,
  });
  if (rankedViaPolicy) {
    return policyRanked.map((kc) => ({
      candidate: kc.source as StrategyCandidate,
      compositeScore: kc.score ?? 0,
    }));
  }
  return rankFn(matched, request, profile).map((r) => ({
    candidate: r.candidate,
    compositeScore: r.compositeScore,
  }));
}

function buildMatrixCells(
  candidates: StrategyCandidate[],
  rejected: Array<{ id: string; reason: string }>,
  rankedMatched: Array<{ candidate: StrategyCandidate; compositeScore: number }>,
): ScanMatrixCell[] {
  const typeById = new Map(candidates.map((c) => [c.id, c.type]));
  const cells = new Map<string, ScanMatrixCell>();
  const cellFor = (strategyType: string): ScanMatrixCell => {
    let cell = cells.get(strategyType);
    if (!cell) {
      cell = {
        strategyType,
        best: null,
        evaluatedCount: 0,
        passedCount: 0,
        rejectedCount: 0,
        rejectionReasons: {},
      };
      cells.set(strategyType, cell);
    }
    return cell;
  };
  for (const c of candidates) cellFor(c.type).evaluatedCount++;
  for (const r of rejected) {
    const strategyType = typeById.get(r.id);
    if (!strategyType) continue;
    const cell = cellFor(strategyType);
    cell.rejectedCount++;
    cell.rejectionReasons[r.reason] = (cell.rejectionReasons[r.reason] ?? 0) + 1;
  }
  for (const cell of cells.values()) cell.passedCount = cell.evaluatedCount - cell.rejectedCount;
  // rankedMatched is already sorted by compositeScore descending, so the
  // first entry seen per type is that type's best.
  for (const entry of rankedMatched) {
    const cell = cells.get(entry.candidate.type);
    if (cell && !cell.best) {
      const c = entry.candidate;
      cell.best = {
        candidateId: c.id,
        label: c.label,
        compositeScore: entry.compositeScore,
        score: c.score,
        expirationDate: c.expirationDate,
        legs: c.legs,
        netDebit: c.netDebit,
        maxLoss: c.maxLoss,
        maxProfit: c.maxProfit,
        maxProfitUnbounded: c.maxProfitUnbounded,
        targetRewardRisk: c.targetRewardRisk,
        probabilityOfProfit: c.modelImpliedProbabilityOfProfit,
      };
    }
  }
  return [...cells.values()].sort((a, b) => {
    const sa = a.best?.compositeScore;
    const sb = b.best?.compositeScore;
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    if (sa !== undefined && sb === undefined) return -1;
    if (sa === undefined && sb !== undefined) return 1;
    return a.strategyType.localeCompare(b.strategyType);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export type OpportunityScanOptions = {
  riskProfile?: RiskProfile;
  strategyFilter?: StrategyScreenFilter;
  limit?: number;
  /**
   * Issue #2600: ranked-candidate cap for the headline
   * per_name_best list, kept separate from `limit` (fit
   * pagination / row cap in strategy_fit mode). A number caps
   * the headline list; "all" returns every opportunity (the
   * explicit "all ranked" choice, never a large number).
   * Absent = the historical top-10 headline cap.
   */
  candidateLimit?: number | "all";
  /** Which strategy question to answer (issue #23); default
   *  "per_name_best". In strategy_fit mode `limit` paginates `fits`
   *  instead of `opportunities`. */
  mode?: ScanMode;
  /** Strategy-fit pagination offset into the fit rows; default 0. */
  offset?: number;
  /** Fit-gate overrides for this call (issue #24), merged over the
   *  config defaults from getOpportunityScannerConfig(). */
  fitGate?: Partial<FitGateParams>;
  /** Issue #738: max symbols to scan. Defaults to MAX_SCAN_SYMBOLS (20)
   *  — the schedule passes its maxItems (100) to scan the full universe. */
  maxSymbols?: number;
  /** Saved strategy profile to run under (issue #28): its
   *  StrategyRequest-level fields fill the template wherever the
   *  caller did not declare the field explicit (see
   *  `explicitFields`), its fitGate layers between the config
   *  defaults and `fitGate`, and its riskProfile / mode apply
   *  unless declared explicit. The applied profile is disclosed in
   *  `assumptions` and stamped into `profileRef` +
   *  `requestSnapshot.profile`. */
  profile?: StrategyProfile;
  /** Field names the caller declares as request-expressed for the
   *  profile merge (issue #28): template-level StrategyRequest
   *  fields (thesis, maxPlannedLoss, ...) plus the option-level
   *  declarations "riskProfile" and "mode". Declared fields keep
   *  the caller's values; the profile supplies the rest. */
  explicitFields?: string[];
  /** Clock override for deterministic provenance (issue #27): the
   *  result's `generatedAt` is stamped from this instant instead of
   *  the wall clock. */
  now?: Date;
  /** Per-name earnings/dividend calendar facts (issue #16),
   *  pre-fetched by the caller from the calendar service
   *  (src/services/eventCalendar.ts). The scanner never fetches.
   *  Names absent from the map — or present with covered: false —
   *  are treated as unverified by the engine, and every scanned
   *  name counts toward coverage.eventCalendar either way. */
  eventCalendarBySymbol?: Record<string, EventCalendarInfo>;
};


/**
 * Issue #3186 step 3e - the opportunity scanner's stages, extracted
 * from OpportunityScanner.scan so the one options pipeline can run
 * them as pipeline stages (plan -> chainFetch -> enrich -> screen ->
 * risk -> persistCanonicalResults -> shapeReport -> deliver). scan()
 * is the composition of these functions, in order; the existing
 * scanner suites pin the behavior, and the pipeline equivalence pin
 * (tests/scanner_screen_workflow_3186.test.ts) proves the pipeline
 * reproduces scan() exactly.
 *
 * Two notes on the split. (1) Skipped order: scan() pushed skips in
 * fetch-completion order under concurrency; the stages return skips
 * per stage, and collation re-sorts them by batch index, so the
 * result's skipped list is now deterministic batch order. The
 * existing suites already compare skips as a map for this reason
 * (tests/options_scanner.test.ts:316). (2) The fit gate runs as its
 * own risk stage: the screen stage builds the matrix row and the
 * pick; the risk stage fills gateBucket/gateReasons on the row and
 * builds the opportunity row (which the type requires to carry a
 * gate verdict, so it cannot exist before the gate runs).
 */

export interface ScanPlan {
  unique: string[];
  batch: string[];
  effectiveTemplate: ScanRequestTemplate;
  requestTemplate: ScanRequestTemplate;
  strategyProfile?: StrategyProfile;
  appliedProfileFields: string[];
  profile: RiskProfile;
  mode: ScanMode;
  gate: FitGateParams;
  assumptions: string[];
  eventCalendarCoverage: { covered: number; total: number; coveragePct: number };
  // Narrowed by normalizeScanPlan's no-view throw: a plan never carries "no-view".
  scanMode: Exclude<ReturnType<typeof resolveStrategyMode>, "no-view">;
  dataMaxDte: number;
  expirationDteBands: ReturnType<typeof deriveFetchBands>["bands"];
}

export interface ScanSkipped {
  symbol: string;
  reason: string;
  matrix: ScanMatrixRow;
}

export interface ScanSnapshotRow {
  symbol: string;
  snapshot: OptionsDataSnapshot;
}

export interface ScanEnrichedRow {
  symbol: string;
  snapshot: OptionsDataSnapshot;
  price: number;
  targetPrice: number;
  targetSource: ScanTargetSource;
  targetEmUnits: number | null;
  request: StrategyRequest;
}

export interface ScanScreenedRow {
  symbol: string;
  request: StrategyRequest;
  pick: BestTradePick;
  cells: ScanMatrixCell[];
  matrix: ScanMatrixRow;
  price: number;
  targetPrice: number;
  targetSource: ScanTargetSource;
  targetEmUnits: number | null;
}

export interface ScanAssessedRow extends ScanScreenedRow {
  opportunity: OpportunityRow | null;
}

/** A skipped symbol's matrix row: never evaluated, never gate-judged. */
export function skippedScanMatrixRow(symbol: string, reason: string): ScanMatrixRow {
  return {
    symbol,
    verdict: "skipped",
    skipReason: reason,
    targetPrice: null,
    targetSource: null,
    targetEmUnits: null,
    cells: [],
    gateBucket: null,
    gateReasons: [],
  };
}

export function normalizeScanPlan(
  symbols: string[],
  template: ScanRequestTemplate,
  options: OpportunityScanOptions = {},
): ScanPlan {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  // Issue #738: respect the caller's maxSymbols instead of the hardcoded
  // 20-symbol cap. The schedule asks for 100; truncating to 20 then failing
  // the run for "incomplete universe" is self-inflicted.
  const maxSymbols = options.maxSymbols ?? MAX_SCAN_SYMBOLS;
  const batch = unique.slice(0, maxSymbols);
  // Issue #16: per-run event-calendar coverage over the scanned batch,
  // reported in the result's coverage (and disclosed in assumptions
  // when the caller supplied calendars at all).
  const eventCalendarCovered = batch.filter((s) => options.eventCalendarBySymbol?.[s]?.covered).length;
  const eventCalendarCoverage = {
    covered: eventCalendarCovered,
    total: batch.length,
    coveragePct: batch.length ? Math.round((eventCalendarCovered / batch.length) * 1000) / 10 : 0,
  };
  // Saved strategy profile (issue #28): the profile is the BASE layer
  // of this scan — everything downstream (request building, target
  // resolution, the fit gate, the provenance snapshot) runs on the
  // EFFECTIVE values computed here, never on the raw inputs.
  const strategyProfile = options.profile;
  const explicitSet = new Set(options.explicitFields ?? []);
  let effectiveTemplate = template;
  let appliedProfileFields: string[] = [];
  if (strategyProfile) {
    const applied = applyProfileFields(template, strategyProfile, explicitSet);
    effectiveTemplate = applied.merged;
    appliedProfileFields = applied.appliedFields;
  }
  // An omitted ceiling follows the screener's default near-leg horizon.
  // Strategy-specific catalog requirements extend only the acquired data
  // window; the engine keeps those long expiries isolated to strategies
  // that declare the corresponding DTE floor.
  effectiveTemplate = {
    ...effectiveTemplate,
    maxDte: effectiveTemplate.maxDte ?? DEFAULT_MAX_DTE,
  };
  const profileGateApplied = strategyProfile?.fitGate !== undefined;
  const profile = explicitSet.has("riskProfile")
    ? options.riskProfile ?? "balanced"
    : strategyProfile?.riskProfile ?? options.riskProfile ?? "balanced";
  const mode = explicitSet.has("mode")
    ? options.mode ?? "per_name_best"
    : strategyProfile?.mode ?? options.mode ?? "per_name_best";
  const gate: FitGateParams = { ...baseOppConfig.fitGate, ...(strategyProfile?.fitGate ?? {}), ...options.fitGate };
  const overrideAssumption = scanOverrideAssumption(effectiveTemplate, batch);
  const assumptions = [
    ...scanTargetAssumptions(effectiveTemplate),
    ...(overrideAssumption ? [overrideAssumption] : []),
    ...(strategyProfile ? [profileDisclosure(strategyProfile, appliedProfileFields, profileGateApplied)] : []),
    ...(options.eventCalendarBySymbol
      ? [`Earnings/dividend calendar coverage: ${eventCalendarCoverage.covered} of ${eventCalendarCoverage.total} names (${eventCalendarCoverage.coveragePct}%). Names without coverage were judged with event risk unverified.`]
      : []),
  ];
  // The stated target and the per-name overrides are scan-level scoping
  // metadata, not request fields: strip them so per-symbol
  // StrategyRequests stay exactly StrategyRequest-shaped. A
  // template-level eventCalendar is stripped for a different reason
  // (issue #16): calendar facts belong to one name and must never
  // leak across the batch — per-symbol calendars arrive only via
  // options.eventCalendarBySymbol.
  const { statedTarget: _statedTarget, perSymbol: _perSymbol, eventCalendar: _templateEventCalendar, ...requestTemplate } = effectiveTemplate;
  const resolvedStrategies = new Set(defaultRegistry.resolveMany(requestTemplate.allowedStrategies).ids);
  const scanTheses = new Set([
    requestTemplate.thesis,
    ...Object.values(effectiveTemplate.perSymbol ?? {}).flatMap((override) => override.thesis ? [override.thesis] : []),
  ]);
  // Issue #2600 (slice-2 fix (c), carried over): fetch selection
  // applies the SAME mode resolution as the engine. Previously it
  // was always thesis-filtered, so in mode "all" a long-horizon
  // contra-thesis strategy was judged by the engine but never
  // fetched — it could never build. Thesis mode is unchanged: the
  // per-symbol override theses still widen the thesis set, exactly
  // as before. farDated === false suppresses horizon bands (the
  // far templates are then horizon-limited, named in the scan's
  // strategyCoverage via dataMaxDte); absent/true keeps the legacy
  // horizon bands, so existing scheduled scans are unaffected.
  const scanMode = resolveStrategyMode(requestTemplate);
  if (scanMode === "no-view") {
    throw new Error("strategyMode \"no-view\" cannot run a viewed opportunity scan; use the no-view path (recommendNoViewStrategies)");
  }
  const selectedDefinitions = defaultRegistry.list()
    .filter((def) => resolvedStrategies.has(def.id) && (scanMode === "all" || def.theses.some((thesis) => scanTheses.has(thesis))));
  const nearMaxDte = requestTemplate.maxDte ?? DEFAULT_MAX_DTE;
  const { bands: expirationDteBands, dataMaxDte } = deriveFetchBands({
    selected: selectedDefinitions,
    nearMinDte: requestTemplate.minDte ?? 0,
    nearMaxDte,
    farDated: requestTemplate.farDated,
    nearMaxExpirations: MAX_EXPIRATIONS_PER_SYMBOL,
  });
  return {
    unique,
    batch,
    effectiveTemplate,
    requestTemplate,
    strategyProfile,
    appliedProfileFields,
    profile,
    mode,
    gate,
    assumptions,
    eventCalendarCoverage,
    scanMode,
    dataMaxDte,
    expirationDteBands,
  };
}

export async function fetchScanSnapshots(
  data: OptionsDataAgent,
  plan: ScanPlan,
): Promise<{ snapshots: ScanSnapshotRow[]; skipped: ScanSkipped[] }> {
  // Issue #1204: ONE subrequest budget for the whole scan. Snapshots
  // are fetched per symbol over a shared screener, so without a
  // shared ledger each symbol would re-fan-out up to
  // maxExpirationsPerSymbol chain fetches and the batch as a whole
  // would trip the Worker per-invocation subrequest cap — the
  // 100-of-100 failure mode. Symbols past the budget are deferred:
  // their snapshot carries the named budget reason, which surfaces
  // below as the skip reason.
  const fetchBudget = data.createFetchBudget();
  const fetched = await mapLimit(plan.batch, CONCURRENCY, async (symbol) => {
    try {
      const snapshot = await data.loadSnapshot({
        ...plan.requestTemplate,
        maxDte: plan.dataMaxDte,
        expirationDteBands: plan.expirationDteBands,
        symbol,
        fetchBudget,
      });
      return { symbol, snapshot };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Scan failed";
      return { symbol, reason };
    }
  });
  const snapshots: ScanSnapshotRow[] = [];
  const skipped: ScanSkipped[] = [];
  for (const entry of fetched) {
    if (entry.snapshot) snapshots.push({ symbol: entry.symbol, snapshot: entry.snapshot });
    else skipped.push({ symbol: entry.symbol, reason: entry.reason!, matrix: skippedScanMatrixRow(entry.symbol, entry.reason!) });
  }
  return { snapshots, skipped };
}

export function enrichScanSnapshots(
  snapshots: ScanSnapshotRow[],
  plan: ScanPlan,
  options: OpportunityScanOptions = {},
): { enriched: ScanEnrichedRow[]; skipped: ScanSkipped[] } {
  const enriched: ScanEnrichedRow[] = [];
  const skipped: ScanSkipped[] = [];
  for (const { symbol, snapshot } of snapshots) {
    try {
      const price = snapshot.contracts[0]?.underlyingPrice;
      if (!price) {
        const reason = snapshot.validationError || snapshot.screen.fetchErrors?.[0]?.reason || "No eligible option contracts";
        skipped.push({ symbol, reason, matrix: skippedScanMatrixRow(symbol, reason) });
        continue;
      }
      // Per-name parameters (issue #23): this symbol's override steers
      // its target resolution and, when it carries a thesis, the thesis
      // its build/screen/pick run under. The snapshot load above stays
      // on the shared template, as before.
      const override = plan.effectiveTemplate.perSymbol?.[symbol];
      // Expected-move estimate (issue #25): the 1-sigma move to expiry
      // implied by this symbol's own chain, from the scan's clock so
      // provenance-stamped runs stay reproducible. Null when the chain
      // carries no usable IV — the symbol then resolves its thesis
      // target from the legacy percentage factor and is named in the
      // fallback disclosure below.
      const emPct = estimateExpectedMovePct(snapshot.contracts, price, options.now ?? new Date());
      const { targetPrice, source: targetSource, targetEmUnits } = resolveScanTarget(
        plan.effectiveTemplate,
        symbol,
        price,
        override,
        emPct === null ? null : { pct: emPct },
      );
      const request: StrategyRequest = {
        ...plan.requestTemplate,
        symbol,
        targetPrice,
        thesis: override?.thesis ?? plan.requestTemplate.thesis,
        eventCalendar: options.eventCalendarBySymbol?.[symbol],
      };
      enriched.push({ symbol, snapshot, price, targetPrice, targetSource, targetEmUnits, request });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Scan failed";
      skipped.push({ symbol, reason, matrix: skippedScanMatrixRow(symbol, reason) });
    }
  }
  return { enriched, skipped };
}

export function screenScanCandidates(
  enriched: ScanEnrichedRow[],
  // The concrete agent: the scanner's engine-typed rank/pick calls
  // need the tight StrategyCandidate / BestTradePick types, which the
  // panel's looser structural agent types do not prove. The ports pass
  // the real agent (see ScannerScreenAgents).
  risk: StrategyRiskAgent,
  // The concrete agent: the panel's PanelRecommender return types
  // are too loose for the engine-typed rank/pick calls here (they
  // admit MinimalEngineCandidate rows and a status-union pick). The
  // ports cast the shared structural agent back to this concrete
  // type at the call site; production always passes the real agent.
  recommender: RecommendationAgent,
  plan: ScanPlan,
  options: OpportunityScanOptions = {},
): { screened: ScanScreenedRow[]; skipped: ScanSkipped[] } {
  const screened: ScanScreenedRow[] = [];
  const skipped: ScanSkipped[] = [];
  for (const row of enriched) {
    try {
      const built = risk.buildStrategies(row.snapshot.contracts, row.request);
      const { matched, rejected } = risk.screenStrategies(built.candidates, options.strategyFilter);
      // The fit matrix is additive: it reports every built/screened
      // candidate per strategy type, ranked once via the recommender.
      // The pick path below is unchanged and still uses pickBestTrade.
      const cells = buildMatrixCells(
        built.candidates,
        rejected,
        rankScannerCandidates(
          (c, r, p) => recommender.rank(c, r, p),
          matched,
          row.request,
          plan.profile,
        ),
      );
      const pick = recommender.pickBestTrade(matched, row.request, plan.profile, 2);
      const matrix: ScanMatrixRow = {
        symbol: row.symbol,
        verdict: cells.some((c) => c.passedCount > 0) ? "pass" : "no_pass",
        targetPrice: row.targetPrice,
        targetSource: row.targetSource,
        targetEmUnits: row.targetEmUnits,
        cells,
        gateBucket: null,
        gateReasons: [],
      };
      screened.push({ ...row, pick, cells, matrix });
      if (!pick.best) {
        skipped.push({ symbol: row.symbol, reason: pick.rationale[0] || "No qualifying strategy", matrix });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Scan failed";
      skipped.push({ symbol: row.symbol, reason, matrix: skippedScanMatrixRow(row.symbol, reason) });
    }
  }
  return { screened, skipped };
}

export function assessScanRisk(
  screened: ScanScreenedRow[],
  plan: ScanPlan,
): { assessed: ScanAssessedRow[]; gate: { fit: number; borderline: number; noFit: number } } {
  const gate = { fit: 0, borderline: 0, noFit: 0 };
  const assessed: ScanAssessedRow[] = [];
  for (const row of screened) {
    // The fit gate (issue #24) qualifies the pick: it rides on the
    // matrix row (fit / borderline / no_fit) and on the opportunity
    // row when a pick exists. The #22 verdict stays screen-pass.
    const gateEval = evaluateFitGate(row.pick, plan.gate);
    row.matrix.gateBucket = gateEval.bucket;
    row.matrix.gateReasons = gateEval.reasons;
    const opportunity: OpportunityRow | null = row.pick.best
      ? {
          symbol: row.symbol,
          underlyingPrice: row.price,
          targetPrice: row.targetPrice,
          targetSource: row.targetSource,
          targetEmUnits: row.targetEmUnits,
          pick: row.pick,
          score: row.pick.best.compositeScore,
          gateBucket: gateEval.bucket,
          gateReasons: gateEval.reasons,
        }
      : null;
    assessed.push({ ...row, opportunity });
    if (gateEval.bucket === "fit") gate.fit++;
    else if (gateEval.bucket === "borderline") gate.borderline++;
    else if (gateEval.bucket === "no_fit") gate.noFit++;
  }
  return { assessed, gate };
}

export function collateScanResult(
  plan: ScanPlan,
  assessed: ScanAssessedRow[],
  skipped: ScanSkipped[],
  options: OpportunityScanOptions = {},
  gateCounts: { fit: number; borderline: number; noFit: number } = { fit: 0, borderline: 0, noFit: 0 },
): OpportunityScanResult {
  const opportunities = assessed
    .map((a) => a.opportunity)
    .filter((r): r is OpportunityRow => r !== null)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  // Matrix rows in batch order: every symbol lands exactly once, from
  // its assessed row or its skip entry.
  const rowBySymbol = new Map<string, ScanMatrixRow>();
  for (const entry of skipped) rowBySymbol.set(entry.symbol, entry.matrix);
  for (const row of assessed) rowBySymbol.set(row.symbol, row.matrix);
  const matrix = plan.batch.map((symbol) => rowBySymbol.get(symbol)!);
  // Skips in deterministic batch order (see the header note).
  const batchIndex = new Map(plan.batch.map((symbol, i) => [symbol, i]));
  const orderedSkipped = [...skipped].sort(
    (a, b) => (batchIndex.get(a.symbol) ?? 0) - (batchIndex.get(b.symbol) ?? 0),
  );
  const skippedList = orderedSkipped.map(({ symbol, reason }) => ({ symbol, reason }));
  const fitRows = plan.mode === "strategy_fit" ? matrix.filter((m) => m.gateBucket === "fit") : [];
  const offset = options.offset ?? 0;
  const borderline = matrix.filter((m) => m.gateBucket === "borderline");
  const assumptions = [...plan.assumptions];
  // Target-basis disclosures (issue #25), assembled post-scan from the
  // matrix rows so they are never asserted falsely: the EM line appears
  // only when at least one evaluated symbol's target was actually
  // EM-derived (a thesis derivation with an estimate, or an em
  // override); the fallback line names every evaluated symbol whose
  // chain yielded no estimate — its thesis target came from the legacy
  // percentage factor (and an em override on it could not resolve).
  // On an evaluated row, targetEmUnits is null exactly when no estimate
  // existed for the symbol.
  const evaluatedRows = matrix.filter((m) => m.verdict !== "skipped");
  if (evaluatedRows.some((m) => m.targetSource === "em" || (m.targetSource === "thesis" && m.targetEmUnits !== null))) {
    const mult = baseOppConfig.targetEmMultiples;
    assumptions.push(
      `Thesis-derived targets are expressed in expected-move units (bullish ${formatEmMultiple(mult.bullish)} EM, bearish ${formatEmMultiple(mult.bearish)} EM, large_move ${formatEmMultiple(mult.large_move)} EM, range_bound ${formatEmMultiple(mult.range_bound)} EM; 1 EM = the 1-sigma move to expiry implied by each name's own chain).`,
    );
  }
  const emFallbackSymbols = evaluatedRows.filter((m) => m.targetEmUnits === null).map((m) => m.symbol);
  if (emFallbackSymbols.length) {
    assumptions.push(
      `Expected-move estimate unavailable for ${emFallbackSymbols.join(", ")}; legacy percentage targets were used for those names.`,
    );
  }
  // Provenance (issue #27): when the scan ran, which model produced
  // it, exactly what was asked, the config it ran under, and how much
  // of the requested universe was actually judged. Pure data — the
  // scanner performs no I/O; persistence lives behind the
  // ScanRunStore seam (src/trading/options/scanRunStore.ts).
  const skippedRows = matrix.filter((m) => m.verdict === "skipped").length;
  const coverage: ScanCoverage = {
    considered: plan.unique.length,
    scanned: plan.batch.length,
    truncated: Math.max(0, plan.unique.length - plan.batch.length),
    evaluated: matrix.length - skippedRows,
    errors: skippedRows,
    withTrades: opportunities.length,
    eventCalendar: plan.eventCalendarCoverage,
  };
  // Issue #1290: stamp the qualified-partial marker at the single
  // assembly point so every surface downstream inherits it.
  const partial = optionsPartialQualification(coverage, skippedList);
  return {
    scanned: plan.batch.length,
    withTrades: opportunities.length,
    opportunities: opportunities.slice(0, plan.mode === "per_name_best"
      ? (options.candidateLimit === "all" ? opportunities.length : (options.candidateLimit ?? options.limit ?? 10))
      : 10),
    skipped: skippedList,
    truncatedSymbols: Math.max(0, plan.unique.length - plan.batch.length),
    assumptions,
    matrix,
    typeRollup: rollupScanTypes(matrix),
    mode: plan.mode,
    fits: fitRows.slice(offset, options.limit === undefined ? undefined : offset + options.limit),
    fitsTotal: fitRows.length,
    gate: gateCounts,
    borderline,
    gateParams: plan.gate,
    profileRef: plan.strategyProfile ? toProfileRef(plan.strategyProfile) : null,
    generatedAt: (options.now ?? new Date()).toISOString(),
    modelVersion: SCAN_MODEL_VERSION,
    requestSnapshot: {
      template: {
        thesis: plan.effectiveTemplate.thesis,
        targetDate: plan.effectiveTemplate.targetDate,
        minDte: plan.effectiveTemplate.minDte,
        maxDte: plan.effectiveTemplate.maxDte,
        maxPlannedLoss: plan.effectiveTemplate.maxPlannedLoss,
        minRewardRisk: plan.effectiveTemplate.minRewardRisk,
        allowedStrategies: plan.effectiveTemplate.allowedStrategies,
        evaluateAllStrategies: plan.effectiveTemplate.evaluateAllStrategies,
        // Issue #2600: canonical mode + far-dated toggle as run, so
        // a later reader need not re-derive them from the alias.
        strategyMode: plan.scanMode,
        farDated: plan.effectiveTemplate.farDated,
        statedTarget: plan.effectiveTemplate.statedTarget,
        perSymbol: plan.effectiveTemplate.perSymbol,
      },
      mode: plan.mode,
      riskProfile: plan.profile,
      strategyFilter: options.strategyFilter,
      profile: plan.strategyProfile ?? null,
    },
    configSnapshot: {
      maxScanSymbols: baseOppConfig.maxScanSymbols,
      targetFactors: { ...baseOppConfig.targetFactors },
      targetEmMultiples: { ...baseOppConfig.targetEmMultiples },
    },
    coverage,
    ...(partial ? { partial } : {}),
    // Issue #2091: the fetched horizon + which wanted strategies the
    // fetched chain evaluated, so reports can name not-evaluated
    // strategies with their reason instead of dropping them silently.
    fetchedMaxDte: plan.dataMaxDte,
    strategyCoverage: buildStrategyCoverage(
      matrix,
      plan.requestTemplate.allowedStrategies,
      plan.dataMaxDte,
      plan.scanMode,
    ),
  };
}


export class OpportunityScanner {
  private readonly data: OptionsDataAgent;
  private readonly risk = new StrategyRiskAgent();
  private readonly recommender = new RecommendationAgent();

  constructor(screener: DynamicOptionsScreener) {
    this.data = new OptionsDataAgent(screener);
  }

  async scan(
    symbols: string[],
    template: ScanRequestTemplate,
    options: OpportunityScanOptions = {},
  ): Promise<OpportunityScanResult> {
    const plan = normalizeScanPlan(symbols, template, options);
    const { snapshots, skipped: fetchSkipped } = await fetchScanSnapshots(this.data, plan);
    const { enriched, skipped: enrichSkipped } = enrichScanSnapshots(snapshots, plan, options);
    const { screened, skipped: screenSkipped } = screenScanCandidates(enriched, this.risk, this.recommender, plan, options);
    const { assessed, gate } = assessScanRisk(screened, plan);
    return collateScanResult(plan, assessed, [...fetchSkipped, ...enrichSkipped, ...screenSkipped], options, gate);
  }
}
