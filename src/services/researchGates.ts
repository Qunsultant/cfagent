/**
 * Issue #319 — stage-gate validation (spec §5).
 *
 * The seven gates run in order with the spec's failure actions. A candidate
 * that fails a gate is Rejected (with reason) or Watchlist-only — never
 * filled in with estimates. "Unverified" marks missing data, per spec §8.
 *
 * SDK-free. Every threshold comes from the injected config (amendment 1:
 * nothing hardcoded in the pipeline).
 */

import type { ResearchConfig } from "./researchConfig";
import type {
  ResearchLeg,
  StructureEconomics,
} from "./researchEconomics";
import { verticalSpreadEconomics } from "./researchEconomics";

export type IdeaStatus = "qualified" | "watchlist" | "unverified" | "rejected";

export type GateId =
  | "data_integrity"
  | "contract_integrity"
  | "quote_quality"
  | "thesis_coherence"
  | "strategy_integrity"
  | "risk_review"
  | "publication";

export interface GateResult {
  gate: GateId;
  passed: boolean;
  /** The spec's failure action for this gate. */
  action: string;
  reasons: string[];
}

export type Outlook =
  | "bullish"
  | "bearish"
  | "range_bound"
  | "volatile"
  | "unknown";

export type ChainProvenance = "live" | "calibrated" | "unavailable";

export interface GateQuote {
  price: number;
  /** ms epoch. */
  timestamp: number;
  marketCap?: number | null;
  quoteStatus?: string;
  source: string;
}

export interface GateChain {
  underlyingPrice: number;
  asOf: number;
  provenance: ChainProvenance;
}

export interface GateCandidate {
  symbol: string;
  outlook: Outlook;
  /** One-paragraph thesis. */
  thesis: string;
  quote: GateQuote | null;
  chain: GateChain | null;
  legs: ResearchLeg[];
  structure: string;
  economics: StructureEconomics | null;
  /** Expected move as a fraction of spot (e.g. 0.08). */
  expectedMovePct: number | null;
  /** Known event (e.g. earnings) inside the holding window, if any. */
  eventRisk?: string | null;
  /** Whether any short leg expires within the assignment-risk window. */
  hasNearTermShortLeg?: boolean;
  /** Sources cited, e.g. ["etrade:quote", "etrade:chain"]. */
  sources: string[];
  /** Known limitations, e.g. ["catalyst feed unavailable"]. */
  limitations: string[];
  falsificationPresent: boolean;
}

export interface GateContext {
  config: ResearchConfig;
  /** ms epoch. */
  now: number;
}

function fail(gate: GateId, action: string, reasons: string[]): GateResult {
  return { gate, passed: false, action, reasons };
}

function pass(gate: GateId): GateResult {
  return { gate, passed: true, action: "pass", reasons: [] };
}

/** Gate 1 — data integrity: provider, timestamp, session, consistent snapshot. */
export function gateDataIntegrity(
  candidate: GateCandidate,
  ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  const q = candidate.quote;
  if (!q) {
    reasons.push("No underlying quote available.");
  } else {
    if (!(q.price > 0) || !Number.isFinite(q.price)) {
      reasons.push(`Quote price invalid: ${q.price}.`);
    }
    const ageSec = (ctx.now - q.timestamp) / 1000;
    if (!(q.timestamp > 0) || ageSec < 0) {
      reasons.push("Quote timestamp missing or in the future.");
    } else if (ageSec > ctx.config.maxQuoteAgeSeconds) {
      reasons.push(
        `Quote is ${Math.round(ageSec)}s old (limit ${ctx.config.maxQuoteAgeSeconds}s).`
      );
    }
    if (!q.source) reasons.push("Quote source not recorded.");
  }
  const chain = candidate.chain;
  if (chain && q && q.price > 0) {
    const drift = Math.abs(chain.underlyingPrice - q.price) / q.price;
    if (drift > 0.02) {
      reasons.push(
        `Chain underlying ${chain.underlyingPrice} drifts ${(drift * 100).toFixed(1)}% from quote ${q.price}.`
      );
    }
  }
  if (reasons.length > 0) {
    return fail("data_integrity", "refresh_or_unverified", reasons);
  }
  return pass("data_integrity");
}

/** Gate 2 — contract integrity: correct type/expiry/multiplier, no ambiguity. */
export function gateContractIntegrity(
  candidate: GateCandidate,
  ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  if (candidate.legs.length === 0) {
    reasons.push("No contracts selected.");
  }
  const expiries = new Set(candidate.legs.map((l) => l.expiry));
  for (const leg of candidate.legs) {
    if (leg.optionType !== "call" && leg.optionType !== "put") {
      reasons.push(`Leg has invalid option type: ${String(leg.optionType)}.`);
    }
    if (!(leg.strike > 0)) reasons.push(`Leg has invalid strike ${leg.strike}.`);
    if (!(leg.dte >= ctx.config.minDte)) {
      reasons.push(
        `Leg ${leg.optionType} ${leg.strike} expires in ${leg.dte} DTE (minimum ${ctx.config.minDte}).`
      );
    }
    if (leg.quantity !== 1 && leg.quantity !== -1 && leg.quantity !== -2 && leg.quantity !== 2) {
      reasons.push(`Leg quantity ${leg.quantity} is not a supported spread ratio.`);
    }
  }
  // Vertical-family structures require a single expiry; condors/butterflies too.
  const multiExpiryStructures = new Set([
    "vertical_spread",
    "iron_condor",
    "butterfly",
  ]);
  if (multiExpiryStructures.has(candidate.structure) && expiries.size > 1) {
    reasons.push(
      `${candidate.structure} legs span multiple expiries (${[...expiries].join(", ")}).`
    );
  }
  if (reasons.length > 0) {
    return fail("contract_integrity", "reject_ambiguous_contract", reasons);
  }
  return pass("contract_integrity");
}

/** Gate 3 — quote quality: valid bid/ask, freshness, spread/activity thresholds. */
export function gateQuoteQuality(
  candidate: GateCandidate,
  ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  const cfg = ctx.config;
  const chain = candidate.chain;
  if (!chain || chain.provenance === "unavailable") {
    return fail("quote_quality", "reject", ["No option chain available."]);
  }
  if (chain.provenance === "calibrated") {
    // Calibrated (synthetic) chains inform the thesis but are NEVER
    // presented as executable quotes (spec: never fabricate a quote).
    return {
      gate: "quote_quality",
      passed: false,
      action: "watchlist_only",
      reasons: [
        "Chain is model-calibrated, not a live broker quote — idea is watchlist-only with the limitation flagged.",
      ],
    };
  }
  for (const leg of candidate.legs) {
    const label = `${leg.optionType} ${leg.strike} ${leg.expiry}`;
    if (!(leg.bid > 0)) {
      reasons.push(`${label}: bid ${leg.bid} is not positive.`);
      continue;
    }
    if (!(leg.ask >= leg.bid)) {
      reasons.push(`${label}: ask ${leg.ask} below bid ${leg.bid}.`);
      continue;
    }
    const mid = (leg.bid + leg.ask) / 2;
    const spreadPct = ((leg.ask - leg.bid) / mid) * 100;
    if (spreadPct > cfg.maxSpreadPct) {
      reasons.push(
        `${label}: spread ${spreadPct.toFixed(1)}% exceeds ${cfg.maxSpreadPct.toFixed(0)}%.`
      );
    }
    if (leg.quoteTimestamp) {
      const ageSec = (ctx.now - leg.quoteTimestamp) / 1000;
      if (ageSec > cfg.quoteFreshnessSeconds) {
        reasons.push(
          `${label}: quote ${Math.round(ageSec)}s old (limit ${cfg.quoteFreshnessSeconds}s).`
        );
      }
    }
    if (leg.volume != null && leg.volume < cfg.minOptionVolume) {
      reasons.push(
        `${label}: volume ${leg.volume} below minimum ${cfg.minOptionVolume}.`
      );
    }
    if (leg.openInterest != null && leg.openInterest < cfg.minOpenInterest) {
      reasons.push(
        `${label}: open interest ${leg.openInterest} below minimum ${cfg.minOpenInterest}.`
      );
    }
  }
  if (reasons.length > 0) {
    return fail("quote_quality", "reject_or_watchlist_only", reasons);
  }
  return pass("quote_quality");
}

/** Gate 4 — thesis coherence: outlook, catalyst, expected move, timing align. */
/** Pipeline structure ids mapped to their economics family. */
export function structureFamily(structure: string): string {
  if (structure === "pmcc") return "pmcc";
  if (structure === "iron_condor") return "iron_condor";
  if (structure.endsWith("_butterfly")) return "butterfly";
  if (structure.endsWith("_straddle")) return "straddle";
  if (structure.endsWith("_strangle")) return "strangle";
  if (structure.endsWith("_spread")) return "vertical_spread";
  if (structure === "cash_secured_put" || structure === "covered_call") return "ownership";
  return structure;
}

function gateThesisCoherence(
  candidate: GateCandidate,
  _ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  if (!candidate.thesis || candidate.thesis.trim().length < 20) {
    reasons.push("Thesis missing or too thin to evaluate.");
  }
  if (candidate.outlook === "unknown") {
    reasons.push("No directional/volatility outlook could be formed.");
  }
  const compatible: Record<string, string[]> = {
    bullish: ["vertical_spread", "pmcc"],
    bearish: ["vertical_spread"],
    // Issue #353 — the catalog tags PMCC [bullish, range_bound], so the
    // thesis gate admits it for range_bound outlooks too.
    range_bound: ["iron_condor", "butterfly", "pmcc"],
    volatile: ["straddle", "strangle"],
  };
  // Pipeline structure ids (bull_call_spread, long_straddle, ...) map onto
  // economics families before the compatibility check.
  // #1639 (D8): llm_idea is exempt from the family check — it is a single
  // cited contract, not a named strategy family, and its direction lives
  // in the LLM answer prose (still length-checked above), not in a leg
  // pattern the gate can classify. The exemption does not qualify
  // anything: the publication gate still fails without falsification
  // evidence, and the kernel's falsify stage caps such candidates at
  // Unverified. Every named family keeps the check.
  const allowed = compatible[candidate.outlook] ?? [];
  if (candidate.outlook !== "unknown" && candidate.structure !== "llm_idea" && !allowed.includes(structureFamily(candidate.structure))) {
    reasons.push(
      `Structure ${candidate.structure} does not express a ${candidate.outlook} outlook.`
    );
  }
  if (reasons.length > 0) {
    return fail("thesis_coherence", "reject_or_revise", reasons);
  }
  return pass("thesis_coherence");
}

/**
 * Gate 5 — strategy integrity: correct leg relationships AND independently
 * verified calculations. The economics are recomputed from the legs here
 * and must match the candidate's figures within tolerance.
 */
export function gateStrategyIntegrity(
  candidate: GateCandidate,
  ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  const econ = candidate.economics;
  if (!econ) {
    return fail("strategy_integrity", "reject", ["Economics not computed."]);
  }
  try {
    if (candidate.structure === "vertical_spread") {
      const recomputed = verticalSpreadEconomics(
        candidate.legs,
        candidate.quote?.price ?? 100
      );
      const tol = 0.05;
      if (
        Math.abs(recomputed.maxLoss - econ.maxLoss) > tol ||
        Math.abs(recomputed.netDebit - econ.netDebit) > tol ||
        Math.abs(recomputed.netCredit - econ.netCredit) > tol
      ) {
        reasons.push(
          `Independent recomputation disagrees: maxLoss ${recomputed.maxLoss} vs ${econ.maxLoss}.`
        );
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    reasons.push(
      `Economics recomputation failed: ${err instanceof Error ? err.message : String(err)}.`
    );
  }
  if (!(econ.maxLoss >= 0) || !Number.isFinite(econ.maxLoss)) {
    reasons.push("Max loss is not a finite non-negative number.");
  }
  if (econ.breakevens.some((b) => !(b > 0))) {
    reasons.push("Breakeven computation produced an invalid price.");
  }
  void ctx;
  if (reasons.length > 0) {
    return fail("strategy_integrity", "reject_calculation_failure", reasons);
  }
  return pass("strategy_integrity");
}

/** Gate 6 — risk review: assignment, expiration, event, concentration, loss scenarios. */
export function gateRiskReview(
  candidate: GateCandidate,
  ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  if (candidate.hasNearTermShortLeg) {
    reasons.push(
      `Short leg within ${ctx.config.assignmentRiskDte} DTE — American-exercise assignment risk.`
    );
  }
  if (candidate.eventRisk) {
    reasons.push(`Event inside holding window: ${candidate.eventRisk}.`);
  }
  if (!candidate.economics) {
    reasons.push("No economics to review.");
  }
  // Portfolio concentration cannot be assessed without portfolio data —
  // per spec §7 this is a documented limitation, not a silent pass.
  if (reasons.length > 0) {
    return fail("risk_review", "escalate_or_reject", reasons);
  }
  return pass("risk_review");
}

/** Gate 7 — publication: sources, limitations, reproducible evidence present. */
export function gatePublication(
  candidate: GateCandidate,
  _ctx: GateContext
): GateResult {
  const reasons: string[] = [];
  if (candidate.sources.length === 0) {
    reasons.push("No sources recorded.");
  }
  if (!candidate.falsificationPresent) {
    reasons.push("Falsification (§4) not attached.");
  }
  if (reasons.length > 0) {
    // Spec: "Do not label actionable" — the idea cannot be Qualified.
    return fail("publication", "not_actionable", reasons);
  }
  return pass("publication");
}

export interface GateRunOutcome {
  status: IdeaStatus;
  gateResults: GateResult[];
  /** Set when status is rejected. */
  rejectionReason?: string;
}

/** Run all seven gates in order; map the first decisive failure to a status. */
export function runStageGates(
  candidate: GateCandidate,
  ctx: GateContext
): GateRunOutcome {
  const gateResults: GateResult[] = [
    gateDataIntegrity(candidate, ctx),
    gateContractIntegrity(candidate, ctx),
    gateQuoteQuality(candidate, ctx),
    gateThesisCoherence(candidate, ctx),
    gateStrategyIntegrity(candidate, ctx),
    gateRiskReview(candidate, ctx),
    gatePublication(candidate, ctx),
  ];
  let watchlistOnly = false;
  for (const result of gateResults) {
    if (result.passed) continue;
    if (result.action === "watchlist_only" || result.action === "reject_or_watchlist_only") {
      watchlistOnly = true;
      continue;
    }
    if (result.action === "refresh_or_unverified") {
      return {
        status: "unverified",
        gateResults,
        rejectionReason: result.reasons.join(" "),
      };
    }
    return {
      status: "rejected",
      gateResults,
      rejectionReason: `[${result.gate}] ${result.reasons.join(" ")}`,
    };
  }
  if (watchlistOnly) {
    const first = gateResults.find((g) => !g.passed);
    return {
      status: "watchlist",
      gateResults,
      rejectionReason: first ? `[${first.gate}] ${first.reasons.join(" ")}` : undefined,
    };
  }
  return { status: "qualified", gateResults };
}
