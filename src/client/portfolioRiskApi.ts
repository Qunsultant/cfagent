/**
 * Client for the portfolio-risk backends (issues #34/#35/#36/#54), surfaced
 * in the UI by PortfolioRiskPanel (issue #63).
 *
 * Type-only imports from the server services keep the wire shapes
 * single-sourced — the panel can never drift from the endpoints it calls.
 */

import type { PortfolioRiskReport } from "../services/portfolioRisk";
import type { ConcentrationReport } from "../services/portfolioConcentration";
import type { SizingCandidate, SizingResult } from "../services/positionSizing";
import type { HedgeAnalysis, HedgeProposal } from "../services/hedgeProposals";
import type { RepairAnalysis, RepairProposal } from "../services/repairProposals";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import { apiFetch } from "./apiFetch";

export type { PortfolioRiskReport, ConcentrationReport, SizingCandidate, SizingResult, HedgeAnalysis, HedgeProposal };

async function postJson<T>(path: string, env: string, body?: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-environment": env },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
  return data;
}

/**
 * Issue #3356: which backend serves a risk read for the SELECTED broker.
 *
 * The neutral `/broker/portfolio-risk*` routes (#3324) compute the same report
 * from the selected broker's own book, Greeks and spot price - they are the only
 * backend a non-E*TRADE broker has. E*TRADE keeps its own routes here on purpose:
 * they are the surface its pins describe, and moving E*TRADE onto the neutral
 * route needs an equivalence proof of its own, not a side effect of this slice.
 */
export type RiskBroker = "etrade" | "alpaca" | "public"; // Issue #3990: Public risk reads name their own broker.

export function riskApiPath(broker: RiskBroker, suffix: string): string {
  return broker === "etrade" ? `/api/etrade${suffix}` : `/api/broker${suffix}`;
}

export async function fetchPortfolioRisk(
  env: string,
  broker: RiskBroker = "etrade",
): Promise<PortfolioRiskReport> {
  const resp = await apiFetch(riskApiPath(broker, "/portfolio-risk"), { headers: { "x-environment": env } });
  const data = (await resp.json().catch(() => ({}))) as PortfolioRiskReport & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  // Shape guard (issue #71): a 200 body that is not a report (e.g. an
  // async-job stub that was not polled) must surface as an error state,
  // never reach the renderer and crash on a missing array.
  if (!data || !Array.isArray(data.rows) || !data.totals || !Array.isArray(data.excluded) || !Array.isArray(data.partial) || !Array.isArray(data.undefinedRiskPositions)) {
    throw new Error("Unexpected portfolio-risk response shape — the report payload was incomplete.");
  }
  return data;
}

export async function fetchHedgeAnalysis(env: string): Promise<HedgeAnalysis> {
  const analysis = await postJson<HedgeAnalysis>("/api/etrade/hedge/analyze", env);
  // Shape guard (issue #71): the renderer reads .length on both arrays.
  if (!analysis || !Array.isArray(analysis.proposals) || !Array.isArray(analysis.symbolsMissingBeta)) {
    throw new Error("Unexpected hedge-analysis response shape — the payload was incomplete.");
  }
  return analysis;
}

export function fetchConcentration(
  env: string,
  candidateSymbol?: string,
  broker: RiskBroker = "etrade",
): Promise<ConcentrationReport> {
  return postJson<ConcentrationReport>(riskApiPath(broker, "/portfolio-risk/correlation"), env, { candidateSymbol });
}

export function fetchSizing(
  env: string,
  candidate: SizingCandidate,
  broker: RiskBroker = "etrade",
): Promise<SizingResult> {
  return postJson<SizingResult>(riskApiPath(broker, "/portfolio-risk/size"), env, { candidate });
}

// ---------------------------------------------------------------------------
// Formatting + view-model helpers (unit-tested)
// ---------------------------------------------------------------------------

export function fmtUsd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSignedUsd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${fmtUsd(Math.abs(value), digits)}`;
}

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Converts a hedge DRAFT into the asset-aware order-ticket context the hub's
 * HITL flow consumes. The panel never previews or
 * executes anything itself — this hand-off is the only bridge, and the
 * human still reviews and approves in the order ticket.
 */
export function hedgeProposalToTradeContext(proposal: HedgeProposal, spyPrice: number | null): TradeOrderContext {
  const move = `β-weighted Δ ${fmtSignedUsd(proposal.preHedgeBetaWeightedDeltaDollars)} → ${fmtSignedUsd(proposal.postHedgeBetaWeightedDeltaDollars)}`;
  if (proposal.instrument === "SPY_SHARES") {
    const limit = proposal.executableOrder?.limitPrice ?? spyPrice ?? undefined;
    return {
      assetClass: "equity",
      symbol: "SPY",
      action: proposal.side,
      quantity: proposal.quantity,
      underlyingPrice: limit,
      label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY shares (${move})`,
      legs: [`${proposal.side} ${proposal.quantity} SPY shares @ ~${fmtUsd(limit ?? null, 2)}`],
    };
  }
  const putLimit = proposal.executableOrder?.limitPrice ?? (proposal.quantity > 0 ? round2(Math.abs(proposal.estimatedCost) / (proposal.quantity * 100)) : 0.01);
  return {
    assetClass: "options",
    symbol: "SPY",
    action: proposal.side,
    quantity: proposal.quantity,
    underlyingPrice: spyPrice ?? undefined,
    label: `Hedge draft — ${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT ${proposal.expirationDate} (${move})`,
    legs: [
      `${proposal.side} ${proposal.quantity} SPY ${proposal.strike} PUT exp ${proposal.expirationDate} — est. cost ${fmtUsd(Math.abs(proposal.estimatedCost), 2)}`,
    ],
    optionLegs: [{
      securityType: "OPTN",
      side: proposal.side,
      quantity: 1,
      optionType: "PUT",
      strike: proposal.strike,
      expirationDate: proposal.expirationDate,
    }],
    strategyNetDebit: proposal.executableOrder?.strategyNetDebit ?? (Math.sign(proposal.estimatedCost || 1) * Math.max(1, Math.round(putLimit * 100))),
  };
}

export type { RepairAnalysis, RepairProposal };

// ---------------------------------------------------------------------------
// Repair proposals (#355 endpoint)
// ---------------------------------------------------------------------------

export async function fetchRepairAnalysis(env: string): Promise<RepairAnalysis> {
  const analysis = await postJson<RepairAnalysis>("/api/etrade/portfolio-repair/analyze", env);
  // Shape guard (issue #71 pattern): the renderer reads .length on both arrays.
  if (!analysis || !Array.isArray(analysis.proposals) || !Array.isArray(analysis.symbolsUnavailable)) {
    throw new Error("Unexpected repair-analysis response shape — the payload was incomplete.");
  }
  return analysis;
}

/**
 * Hand a repair draft to the hub's HITL order-ticket flow. The 1×2 ratio
 * becomes two option legs; the DRAFT status and the rationale travel in the
 * label so the ticket shows what is being previewed.
 */
export function repairProposalToTradeContext(proposal: RepairProposal): TradeOrderContext {
  const cost = proposal.netDebitPerUnit <= 0
    ? `credit ${fmtUsd(Math.abs(proposal.netDebitPerUnit), 2)}`
    : `debit ${fmtUsd(proposal.netDebitPerUnit, 2)}`;
  const perShareLimit = proposal.executableOrder?.limitPrice ?? Math.max(0.01, round2(Math.abs(proposal.netDebitPerUnit)));
  const contractNetDebit = proposal.executableOrder?.strategyNetDebit ?? (Math.sign(proposal.netDebitPerUnit || -1) * Math.round(perShareLimit * 100));

  return {
    assetClass: "options",
    symbol: proposal.symbol,
    action: "BUY",
    quantity: proposal.units,
    label: `Repair draft — 1×2 call ratio on ${proposal.symbol} (${cost}/unit, recover at ${proposal.upsideCappedAbove})`,
    legs: [
      `BUY ${proposal.units} ${proposal.symbol} ${proposal.legLong.strike} CALL exp ${proposal.legLong.expirationDate} @ ~${fmtUsd(proposal.legLong.premium, 2)}`,
      `SELL ${proposal.units * 2} ${proposal.symbol} ${proposal.legShort.strike} CALL exp ${proposal.legShort.expirationDate} @ ~${fmtUsd(proposal.legShort.premium, 2)}`,
    ],
    optionLegs: [
      {
        securityType: "OPTN",
        side: "BUY",
        quantity: 1, // Unit ratio is 1; ETradeTradingHub multiplies leg.quantity * orderQuantity!
        optionType: "CALL",
        strike: proposal.legLong.strike,
        expirationDate: proposal.legLong.expirationDate,
      },
      {
        securityType: "OPTN",
        side: "SELL",
        quantity: 2, // Unit ratio is 2; ETradeTradingHub multiplies leg.quantity * orderQuantity!
        optionType: "CALL",
        strike: proposal.legShort.strike,
        expirationDate: proposal.legShort.expirationDate,
      },
    ],
    strategyNetDebit: contractNetDebit,
  };
}

// ---------------------------------------------------------------------------
// Post-trade evaluator (#34 endpoint, surfaced in the UI by issue #67)
// ---------------------------------------------------------------------------

import type { CandidateGreekContribution, PortfolioRiskTotals } from "../services/portfolioRisk";
import type { ThinkTradeValidationResult } from "../types";

export type { CandidateGreekContribution, PortfolioRiskTotals, ThinkTradeValidationResult };

export interface EvaluateResult {
  current: PortfolioRiskReport;
  postTradeTotals: PortfolioRiskTotals;
}

export function fetchEvaluate(
  env: string,
  candidate: CandidateGreekContribution,
  broker: RiskBroker = "etrade",
): Promise<EvaluateResult> {
  return postJson<EvaluateResult>(riskApiPath(broker, "/portfolio-risk/evaluate"), env, { candidate });
}

// ---------------------------------------------------------------------------
// Recommendation Bundle — Best Trade v2 (issue #1135, Phase 4 of #1096)
// ---------------------------------------------------------------------------

import type { RecommendationBundle } from "../services/recommendationBundle";
import type { StrategyCandidate } from "../trading";

export type { RecommendationBundle };

/**
 * Build a recommendation bundle for a strategy candidate against the
 * live book. Shape guard (issue #71 pattern): the renderer reads arrays
 * on the bundle, so an incomplete payload surfaces as an error state.
 */
export async function fetchBundle(
  env: string,
  body: { candidate: StrategyCandidate; beta?: number | null; requestedContracts?: number },
): Promise<RecommendationBundle> {
  const bundle = await postJson<RecommendationBundle>("/api/etrade/portfolio-risk/bundle", env, body);
  if (!bundle || !Array.isArray(bundle.alternatives) || !bundle.optimizer || !Array.isArray(bundle.optimizer.evidence)) {
    throw new Error("Unexpected bundle response shape — the payload was incomplete.");
  }
  return bundle;
}

/** Parse the panel's candidate-JSON textarea: a full StrategyCandidate
 *  object (as produced by the strategy engine / opportunity scanner). */
export function parseBundleCandidate(text: string): StrategyCandidate {
  const parsed = JSON.parse(text) as StrategyCandidate;
  if (!parsed || typeof parsed.symbol !== "string" || !Array.isArray(parsed.legs) || parsed.legs.length === 0) {
    throw new Error("Candidate JSON must be a strategy candidate object with a symbol and at least one leg.");
  }
  return parsed;
}

/**
 * A real, minimal, parseable example candidate (issue 1205), mirroring
 * the Phase 4 fixtures in tests/phase4_recommender_v2.test.ts: one XYZ
 * 200 long call at a $2.00 debit. It exists so the panel offers a path
 * to a valid candidate — a user can load it, build end-to-end, and learn
 * the expected shape by editing it. It is EXAMPLE data, labeled as such
 * in its label/explanations; the bundle it produces is a draft like any
 * other and still requires human approval.
 */
export const EXAMPLE_BUNDLE_CANDIDATE: StrategyCandidate = {
  id: "example-xyz-long-call",
  rank: 1,
  type: "long_call",
  label: "XYZ 200 long call — worked example (replace with a real candidate)",
  symbol: "XYZ",
  underlyingPrice: 200,
  expirationDate: "2026-11-22",
  dataFreshness: "FRESH",
  legs: [{
    symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1, strike: 200,
    expirationDate: "2026-11-22", daysToExpiration: 30, entryPrice: 2, bid: 1.8, ask: 2.2,
    impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
    openInterest: 5_000, volume: 1_000, spreadPct: 0.08,
    quoteTimestamp: "2026-10-23T00:00:00.000Z", quoteFreshness: "FRESH", multiplier: 100,
  }],
  netDebit: 2,
  estimatedFees: 2,
  maxProfit: null,
  maxProfitUnbounded: true,
  maxLoss: 200,
  breakevens: [202],
  targetPnl: 300,
  targetRewardRisk: 1.5,
  modelImpliedProbabilityOfProfit: 0.45,
  netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
  liquidityScore: 80,
  score: 70,
  scoreBreakdown: {
    thesisAlignment: 70, targetRewardRisk: 60, liquidity: 80, volatilityAlignment: 65,
    thetaBurden: 55, freshness: 90, popAlignment: 45, cushion: 1, capitalEfficiency: 1.5,
    weights: {
      thesisAlignment: 0.15, targetRewardRisk: 0.15, liquidity: 0.15, volatilityAlignment: 0.1,
      thetaBurden: 0.1, freshness: 0.1, popAlignment: 0.1, cushion: 0.075, capitalEfficiency: 0.075,
    },
  },
  payoffCurve: [],
  scenarios: [],
  explanations: ["Worked example shipped with the panel (issue 1205) so the expected candidate shape is visible — replace the symbol, strike, prices and Greeks with a real strategy-engine candidate before relying on the output."],
  warnings: [],
  assumptions: [],
};

/**
 * Consolidation C5 (#1361): the from-results handoff. A screening
 * results panel stages a ranked/best-trade candidate here; the bundle
 * panel consumes it once on mount and pre-fills the textarea, so
 * candidates flow from screening results into the bundle builder
 * instead of only arriving by manual paste. One-shot by design: take
 * removes the key even for invalid JSON, so a stale or broken staged
 * candidate can never re-appear on a later visit. Best-effort —
 * staging never throws (the panel still accepts paste).
 */
export const STAGED_BUNDLE_CANDIDATE_KEY = "cfagent_bundle_candidate";

export function stageBundleCandidate(candidate: unknown): void {
  try {
    localStorage.setItem(STAGED_BUNDLE_CANDIDATE_KEY, JSON.stringify(candidate));
  } catch {
    /* staging unavailable; paste still works */
  }
}

export function takeStagedBundleCandidate(): string | null {
  try {
    const raw = localStorage.getItem(STAGED_BUNDLE_CANDIDATE_KEY);
    localStorage.removeItem(STAGED_BUNDLE_CANDIDATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { symbol?: unknown; legs?: unknown } | null;
    if (!parsed || typeof parsed.symbol !== "string" || !Array.isArray(parsed.legs) || parsed.legs.length === 0) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** The example candidate as pretty-printed JSON for the textarea. */
export function exampleBundleCandidateJson(): string {
  return JSON.stringify(EXAMPLE_BUNDLE_CANDIDATE, null, 2);
}

export type BundleCandidateTextState =
  | { status: "empty"; message: string }
  | { status: "invalid"; message: string }
  | { status: "valid"; message: null };

/**
 * Honest state for the bundle candidate textarea (issue 1205). The
 * panel shipped with the Build button silently disabled on an empty box
 * whose placeholder — a JSON skeleton full of literal "…" — looked like
 * pre-filled input. This helper is the single source of the words the
 * panel shows for each state: why Build is unavailable, and what to do
 * instead. `valid` carries no message.
 */
export function bundleCandidateTextState(text: string): BundleCandidateTextState {
  if (!text.trim()) {
    return {
      status: "empty",
      message: "No candidate yet — Build bundle is disabled. The grey skeleton text in the box is a placeholder showing the expected JSON shape, not input. Paste a strategy candidate (strategy-engine JSON), or click “Insert example candidate” to load a working example.",
    };
  }
  try {
    parseBundleCandidate(text);
    return { status: "valid", message: null };
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      return {
        status: "invalid",
        message: "That text is not valid JSON, so there is nothing to build. Paste a complete strategy candidate object, or click “Insert example candidate” to load a working example.",
      };
    }
    return {
      status: "invalid",
      message: `${err?.message || "That candidate is not valid."} Fix the candidate, or click “Insert example candidate” to load a working example.`,
    };
  }
}

/** Parses the Evaluate form into a candidate contribution; null when a required field is not numeric. */
export function buildEvaluateCandidate(form: Record<string, string>): CandidateGreekContribution | null {
  const num = (key: string): number | null => {
    const raw = (form[key] ?? "").trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const required = ["deltaShares", "deltaDollars", "gammaSharesPerDollar", "thetaDollarsPerDay", "vegaDollarsPerVolPoint", "rhoDollarsPerRatePoint", "definedMaxLoss"];
  const values: Record<string, number> = {};
  for (const key of required) {
    const v = num(key);
    if (v === null) return null;
    values[key] = v;
  }
  const betaRaw = (form.betaWeightedDeltaDollars ?? "").trim();
  return {
    deltaShares: values.deltaShares,
    deltaDollars: values.deltaDollars,
    betaWeightedDeltaDollars: betaRaw === "" ? null : Number(betaRaw),
    gammaSharesPerDollar: values.gammaSharesPerDollar,
    thetaDollarsPerDay: values.thetaDollarsPerDay,
    vegaDollarsPerVolPoint: values.vegaDollarsPerVolPoint,
    rhoDollarsPerRatePoint: values.rhoDollarsPerRatePoint,
    definedMaxLoss: values.definedMaxLoss,
  };
}

// ---------------------------------------------------------------------------
// Think-harness guardrail verdicts (#37 service, HTTP route added in #67)
// ---------------------------------------------------------------------------

export interface ThinkEvaluateInput {
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP";
  price?: number;
}

export function fetchThinkVerdict(env: string, input: ThinkEvaluateInput): Promise<ThinkTradeValidationResult> {
  return postJson<ThinkTradeValidationResult>("/api/etrade/think/evaluate", env, input);
}

// ---------------------------------------------------------------------------
// Prefill wiring (issue #69): pure mappings into the Evaluator form shape
// ---------------------------------------------------------------------------

import type { PositionRiskRow } from "../services/portfolioRisk";
import type { SizingResult as SizingResultType } from "../services/positionSizing";

const str = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(Math.round(v * 100) / 100));

/** A held position's Greek contribution → Evaluator form (complete: rows carry every Greek). */
export function positionRowToEvalForm(row: PositionRiskRow): Record<string, string> {
  return {
    deltaShares: str(row.deltaShares),
    deltaDollars: str(row.deltaDollars),
    betaWeightedDeltaDollars: str(row.betaWeightedDeltaDollars),
    gammaSharesPerDollar: str(row.gammaSharesPerDollar),
    thetaDollarsPerDay: str(row.thetaDollarsPerDay),
    vegaDollarsPerVolPoint: str(row.vegaDollarsPerVolPoint),
    rhoDollarsPerRatePoint: str(row.rhoDollarsPerRatePoint),
    definedMaxLoss: str(row.definedMaxLoss),
  };
}

/**
 * A sizing result → Evaluator form for the fields sizing knows (delta,
 * beta-weighted delta, defined max loss), scaled per-contract × recommended
 * contracts. Greeks sizing doesn't carry (gamma/theta/vega/rho, delta shares)
 * are left blank for the user — never invented.
 */
export function sizingToEvalForm(candidate: SizingCandidate, sizing: SizingResultType): Record<string, string> {
  const n = sizing.recommendedContracts;
  return {
    deltaShares: "",
    deltaDollars: str(candidate.perContract.deltaDollars * n),
    betaWeightedDeltaDollars: candidate.perContract.betaWeightedDeltaDollars === null ? "" : str(candidate.perContract.betaWeightedDeltaDollars * n),
    gammaSharesPerDollar: "",
    thetaDollarsPerDay: "",
    vegaDollarsPerVolPoint: "",
    rhoDollarsPerRatePoint: "",
    definedMaxLoss: candidate.perContract.definedMaxLoss === null ? "" : str(candidate.perContract.definedMaxLoss * n),
  };
}
