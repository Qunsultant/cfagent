/**
 * Issue #319 — autonomous options-research pipeline (spec §§1–9, ARR, OODA).
 *
 * Single pipeline entry: runResearchPipeline(). The manual route and the
 * scheduled tick are thin triggers over this entry (amendment 2) — zero
 * duplicated screening/validation/report logic.
 *
 * SDK-free. Data arrives through the injected ResearchDataProvider; the
 * E*TRADE-backed implementation lives in researchProviders.ts. The pipeline
 * never fabricates a data point: missing retrieval becomes Unverified /
 * missing-evidence, never an estimate dressed as data.
 *
 * READ-ONLY: the pipeline has no code path to any order function.
 */

import type { ResearchConfig } from "./researchConfig";
import type {
  ResearchLeg,
  StructureEconomics,
  ScenarioRow,
  CostAssumptions,
} from "./researchEconomics";
import {
  blackScholesPrice,
  expectedMove,
  verticalSpreadEconomics,
  ironCondorEconomics,
  butterflyEconomics,
  straddleEconomics,
  pmccEconomics,
  buildScenarioRows,
} from "./researchEconomics";
import type {
  GateCandidate,
  IdeaStatus,
  Outlook,
  ChainProvenance,
} from "./researchGates";
import { runStageGates } from "./researchGates";
import { isResearchUniverseRefusal } from "../trading";
import type { ResearchFeedStageOutput } from "./researchFeedHandoff";
import type { ResearchEnrichStageOutput } from "./researchEnrichHandoff";
import type {
  Falsification,
  Premortem,
} from "./researchFalsification";
import { buildFalsification, buildPremortem } from "./researchFalsification";
import { newRunId as mintRunId, oodaStepShortId } from "./executionTreeIds";
import { maskAccountId } from "../config/accountBindings";

export type TriggerSource = "manual" | "scheduled";

/* ------------------------------------------------------------------ */
/* Provider interface                                                  */
/* ------------------------------------------------------------------ */

export interface QuoteSnapshot {
  symbol: string;
  price: number;
  /** ms epoch. */
  timestamp: number;
  marketCap?: number | null;
  isEtf?: boolean;
  quoteStatus: string;
  source: string;
}

export interface ProviderChainLeg {
  optionType: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  bid: number;
  ask: number;
  iv?: number | null;
  volume?: number | null;
  openInterest?: number | null;
}

export interface ProviderChainExpiry {
  expiry: string;
  dte: number;
  legs: ProviderChainLeg[];
}

export interface ChainSnapshot {
  symbol: string;
  underlyingPrice: number;
  asOf: number;
  provenance: ChainProvenance;
  /** Selected broker or feed identity, when the provider can record it. */
  source?: string;
  /** Safe, actionable chain retrieval details when the provider could not supply a usable chain. */
  failureReason?: string;
  expiries: ProviderChainExpiry[];
}

export interface Technicals {
  trend: "up" | "down" | "flat";
  /** Signed momentum signal in [-1, 1]. */
  momentum: number | null;
  rsi?: number | null;
  notes: string[];
}

export interface CatalystInfo {
  description: string;
  date?: string | null;
  direction: "bullish" | "bearish" | "neutral";
}

export interface RegimeAssessment {
  regime: "bull" | "bear" | "chop" | "high_vol" | "unknown";
  notes: string[];
  asOf: number;
}

export interface ResearchDataProvider {
  getUniverseSymbols(universe: string): Promise<string[]>;
  getQuote(symbol: string): Promise<QuoteSnapshot | null>;
  getChain(symbol: string): Promise<ChainSnapshot>;
  getTechnicals(symbol: string): Promise<Technicals | null>;
  /** Null when no catalyst feed is wired — never fabricated. */
  getCatalysts(symbol: string): Promise<CatalystInfo[] | null>;
  getRegime(): Promise<RegimeAssessment>;
}

/* ------------------------------------------------------------------ */
/* Report types                                                        */
/* ------------------------------------------------------------------ */

export interface TradeCard {
  rank: number;
  symbol: string;
  outlook: Outlook;
  thesis: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  falsification: Falsification;
  falsificationWarnings: string[];
  premortem: Premortem;
  structure: string;
  legs: ResearchLeg[];
  economics: StructureEconomics;
  /** PMCC-only: correct model figures (null for other structures). */
  pmcc?: {
    maxProfit: number;
    maxLoss: number;
    netDebit: number;
    maxProfitSpot: number;
  } | null;
  scenarios: ScenarioRow[];
  entryCondition: string;
  invalidation: string;
  contractualMaxLoss: number;
  feesNote: string;
  limitations: string[];
  sources: string[];
  quoteTimestamp: number;
  /** Underlying spot price at idea creation (§9 baseline for evaluation). */
  entrySpot: number;
  chainProvenance: ChainProvenance;
  score: number;
  status: "qualified";
}

export interface WatchlistEntry {
  symbol: string;
  outlook: Outlook;
  thesis: string;
  structure: string;
  reason: string;
  triggerCondition: string;
}

export interface RejectedEntry {
  symbol: string;
  outlook: Outlook;
  structure: string;
  gate: string;
  reason: string;
}

export interface RunStats {
  universeSize: number;
  quotesRetrieved: number;
  candidatesEvaluated: number;
  chainsFetched: number;
  chainsAttempted?: number;
  chainsCalibrated: number;
  qualified: number;
  watchlist: number;
  rejected: number;
  unverified: number;
  oodaIterations: number;
  durationMs: number;
}

export type ResearchSymbolOutcome =
  | "not_screened"
  | "not_evaluated"
  | "quote_unavailable"
  | "filtered"
  | "thesis_rejected"
  | "chain_failed"
  | "evaluated";

export interface ResearchStrategyEvaluation {
  strategy: string;
  outcome: "build_unavailable" | "rejected" | "unverified" | "watchlist" | "qualified";
  gate?: string;
  reason?: string;
  legs?: ResearchLeg[];
}

/** One durable account of what happened to each symbol considered by OODA. */
export interface ResearchSymbolEvaluation {
  symbol: string;
  outcome: ResearchSymbolOutcome;
  reason?: string;
  quote?: Pick<QuoteSnapshot, "price" | "timestamp" | "quoteStatus" | "source" | "marketCap" | "isEtf">;
  chain?: {
    outcome: "retrieved" | "failed";
    source: string;
    provenance?: ChainProvenance;
    asOf?: number;
    expiryCount?: number;
    legCount?: number;
    failureReason?: string;
  };
  outlook?: Outlook;
  strategies: ResearchStrategyEvaluation[];
  selectedStrategy?: string;
}

export interface OodaStep {
  stage: "observe" | "orient" | "decide" | "act";
  detail: string;
  at: string;
  /**
   * Issue #4774: the level-qualified short id of this step —
   * `ooda:observe` | `ooda:orient` | `ooda:decide` | `ooda:act`.
   * The bare `stage` string is unchanged; the short id is what tells
   * this candidate-level step apart from the run-level stage of the
   * same name (whose id is the stage execution id
   * `stage:<runBody>:observe:-`). Always populated by the recorder
   * in `runResearchPipeline`.
   */
  shortId?: string;
}

/**
 * Issue #774: the 8 pipeline stages from the design doc
 * (docs/research/autonomous-options-research-pipeline.docx §1).
 * The OODA steps (above) operate *within* these stages — OODA is the
 * candidate-level loop, the pipeline stages are the run-level flow.
 * Issue #4774: the two levels share the stage names "observe" |
 * "orient" | "decide" — the level is what resolves them: the
 * candidate-level step carries its `ooda:*` shortId, the run-level
 * stage is identified by its stage execution id
 * (`stage:<runBody>:<stage>:-`). The `respipe:` namespace that used
 * to qualify run-level stages was retired by the uniform-convention
 * adoption (#5175, 2026-11-17) — the hierarchy scopes the stages,
 * so no separate namespace is needed.
 */
export type PipelineStage =
  | "configure"
  | "observe"
  | "orient"
  | "decide"
  | "build-and-price"
  | "challenge-and-gate"
  | "rank-and-report"
  | "evaluate-later";

export interface PipelineStageStep {
  stage: PipelineStage;
  detail: string;
  at: string;
  // No shortId: run-level stages carry no loop qualifier. The
  // `respipe:` short id this interface used to carry was retired by
  // the uniform-convention adoption (#5175, 2026-11-17) — a
  // run-level stage is identified by its stage execution id
  // (`stage:<runBody>:<stage>:-`), and only the candidate-level
  // OODA loop carries a shortId (`OodaStep.shortId`, `ooda:*`).
}

/** Issue #773 (a) — the evaluation history as a run saw it. */
export interface EvaluationFeedback {
  /** Where the numbers came from; there is no second source. */
  source: "track-record";
  published: number;
  evaluated: number;
  /** Minimum evaluated ideas a family needs before it may reorder anything. */
  minEvaluated: number;
  /** The per-family slices the run could see, verbatim from the track record. */
  families: Array<{
    key: string;
    evaluated: number;
    winRate: number | null;
    avgRMultiple: number | null;
    /** True when this family carried a per-family direction accuracy. */
    directionAccuracyRecorded: boolean;
  }>;
  /** True when the history actually changed the structure order this run. */
  orderingApplied: boolean;
  /** One sentence an operator can read: closed, or open and why. */
  statement: string;
}

export interface ResearchReport {
  runId: string;
  generationId: string;
  trigger: TriggerSource;
  userLogin: string;
  createdAt: string;
  rulesVersion: string;
  /**
   * Issue #5912 — the venue and mode this run actually quoted from, recorded
   * on the report so the row can name them. Absent = the configured default.
   */
  brokerId?: string;
  mode?: string;
  /** Read-only instrument selection resolved for this run, when recorded. */
  assetType?: string;
  accountType?: string;
  /** Safe masked identifier only; credentials are never report fields. */
  accountId?: string;
  /** Amendment 1: the effective filter/config snapshot this run used. */
  configSnapshot: ResearchConfig;
  /**
   * Issue #773 (a) — what the run read from the evaluation history, and
   * whether any of it changed a decision. Visible and auditable by design: the
   * loop is either stated as closed, or stated as open with the reason — never
   * a silence that reads like a decision.
   */
  evaluationFeedback: EvaluationFeedback;
  regime: RegimeAssessment;
  summary: string;
  ideas: TradeCard[];
  watchlist: WatchlistEntry[];
  rejected: RejectedEntry[];
  /** Complete universe ledger, including budget/filter/quote/chain outcomes. */
  symbolEvaluations?: ResearchSymbolEvaluation[];
  stats: RunStats;
  oodaTrace: OodaStep[];
  /** Issue #774: pipeline stage trace — the 8 stages from the design doc. */
  stageTrace: PipelineStageStep[];
  /**
   * Issue #5909 — a total data outage: the run retrieved no quote at all for
   * a non-empty universe. The report is still published (it is the evidence),
   * but the caller must record the run as failed, not as "nothing qualified".
   */
  dataRefusal?: {
    code: "research_data_unavailable" | "research_universe_unknown";
    message: string;
  };
}

export interface ResearchRunOptions {
  trigger: TriggerSource;
  userLogin: string;
  /** Issue #5912 — the venue/mode this run quoted from (recorded, not inferred). */
  brokerId?: string;
  mode?: string;
  assetType?: string;
  accountType?: string;
  accountId?: string;
  runId?: string;
  /** Issue #6063 — the feed stage output; the pipeline consumes it instead of re-fetching. */
  feed?: ResearchFeedStageOutput;
  /** Issue #6064 — the enrich stage output; analyze consumes it instead of re-fetching. */
  enrich?: ResearchEnrichStageOutput;
  now?: number;
}

/* ------------------------------------------------------------------ */
/* Thesis + structure selection (rule-based, documented, reproducible)  */
/* ------------------------------------------------------------------ */

interface ThesisDraft {
  outlook: Outlook;
  thesis: string;
  supporting: string[];
  contradicting: string[];
  strength: number;
}

function draftThesis(
  symbol: string,
  technicals: Technicals | null,
  catalysts: CatalystInfo[] | null,
  regime: RegimeAssessment
): ThesisDraft {
  const supporting: string[] = [];
  const contradicting: string[] = [];
  let outlook: Outlook = "unknown";
  let strength = 0.4;

  if (!technicals) {
    return {
      outlook: "unknown",
      thesis: `No technical data for ${symbol}; no outlook formed.`,
      supporting,
      contradicting: ["Technical data unavailable."],
      strength: 0,
    };
  }
  supporting.push(
    `Trend ${technicals.trend}${technicals.rsi != null ? `, RSI ${technicals.rsi.toFixed(0)}` : ""}.`
  );
  if (technicals.momentum != null) {
    supporting.push(`Momentum ${technicals.momentum >= 0 ? "+" : ""}${technicals.momentum.toFixed(2)}.`);
  }

  const alignedCatalysts = (catalysts ?? []).filter((c) => c.direction !== "neutral");
  if (technicals.trend === "up" && (technicals.momentum ?? 0) >= 0) {
    outlook = "bullish";
    strength = 0.6;
  } else if (technicals.trend === "down" && (technicals.momentum ?? 0) <= 0) {
    outlook = "bearish";
    strength = 0.6;
  } else if (technicals.trend === "flat") {
    outlook = "range_bound";
    strength = 0.55;
  }
  if (regime.regime === "high_vol" && outlook !== "unknown") {
    outlook = "volatile";
    supporting.push("Elevated volatility regime favors long-volatility structures.");
  }
  for (const c of alignedCatalysts) {
    supporting.push(`Catalyst (${c.direction}): ${c.description}.`);
    strength = Math.min(1, strength + 0.1);
  }
  if (catalysts === null) {
    contradicting.push("No catalyst feed available — event-driven drivers unassessed.");
  }
  contradicting.push(
    "Mean-reversion risk: the observed trend may already be priced into the options."
  );
  if (technicals.notes.length > 0) contradicting.push(...technicals.notes);

  const thesis =
    outlook === "unknown"
      ? `No coherent outlook for ${symbol}.`
      : `${symbol} screens ${outlook} on ${technicals.trend} trend${alignedCatalysts.length > 0 ? ` with ${alignedCatalysts.length} aligned catalyst(s)` : ""} in a ${regime.regime} regime.`;
  return { outlook, thesis, supporting, contradicting, strength };
}

/** Spec §6 strategy table: candidate structures per outlook. */

/**
 * Issue #353 — minimum DTE for the PMCC long leg. Matches the catalog's
 * poor_mans_covered_call farMinDte (180), so the provider's LEAPS band
 * (>=180 DTE) can actually satisfy it.
 */
const PMCC_LONG_LEG_MIN_DTE = 180;

export function structuresForOutlook(
  outlook: Outlook,
  ownershipAllowed: boolean,
  pmccEnabled: boolean
): string[] {
  switch (outlook) {
    case "bullish": {
      const list = ["bull_call_spread", "bull_put_spread"];
      if (ownershipAllowed) list.push("cash_secured_put");
      if (pmccEnabled) list.push("pmcc");
      return list;
    }
    case "bearish":
      return ["bear_put_spread", "bear_call_spread"];
    case "range_bound": {
      const list = ["iron_condor", "butterfly"];
      if (pmccEnabled) list.push("pmcc");
      return list;
    }
    case "volatile":
      return ["long_straddle", "long_strangle"];
    default:
      return [];
  }
}

interface BuiltStructure {
  name: string;
  legs: ResearchLeg[];
  economics: StructureEconomics;
  pmcc?: TradeCard["pmcc"];
}

export function pickExpiry(
  expiries: ProviderChainExpiry[],
  minDte: number,
  targetMin: number,
  targetMax: number
): ProviderChainExpiry | null {
  const viable = expiries
    .filter((e) => e.dte >= minDte && e.legs.length > 0)
    .sort((a, b) => a.dte - b.dte);
  if (viable.length === 0) return null;
  const inTarget = viable.find((e) => e.dte >= targetMin && e.dte <= targetMax);
  return inTarget ?? viable[0];
}

export function findLeg(
  expiry: ProviderChainExpiry,
  optionType: "call" | "put",
  strikeFilter: (strike: number, spot: number) => boolean,
  spot: number,
  pick: "nearest" | "farthest" = "nearest"
): ProviderChainLeg | null {
  const cands = expiry.legs
    .filter((l) => l.optionType === optionType && strikeFilter(l.strike, spot) && l.bid > 0 && l.ask >= l.bid)
    .sort((a, b) =>
      pick === "nearest"
        ? Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
        : Math.abs(b.strike - spot) - Math.abs(a.strike - spot)
    );
  return cands[0] ?? null;
}

export function toResearchLeg(leg: ProviderChainLeg, quantity: number, quoteTs: number): ResearchLeg {
  return {
    optionType: leg.optionType,
    strike: leg.strike,
    expiry: leg.expiry,
    dte: leg.dte,
    bid: leg.bid,
    ask: leg.ask,
    iv: leg.iv ?? null,
    volume: leg.volume ?? null,
    openInterest: leg.openInterest ?? null,
    quantity,
    quoteTimestamp: quoteTs,
  };
}

/**
 * #926: does building `name` fail ONLY because a required leg lacks chain
 * IV? Used to classify a null build as a counted missing-IV exclusion
 * instead of a silent skip. Mirrors buildStructure's leg selection for the
 * IV-dependent structures (straddle, strangle, PMCC); all other structures
 * return false here.
 */
export function missingIvForStructure(
  name: string,
  chain: ChainSnapshot,
  spot: number,
  config: ResearchConfig
): boolean {
  const hasIv = (leg: ProviderChainLeg | null | undefined): boolean =>
    leg != null && leg.iv != null && leg.iv > 0;
  if (name === "long_straddle" || name === "long_strangle") {
    const expiry = pickExpiry(chain.expiries, config.minDte, 30, 45);
    if (!expiry) return false;
    const call = findLeg(expiry, "call", () => true, spot);
    return call != null && !hasIv(call);
  }
  if (name === "pmcc") {
    const leaps = chain.expiries
      .filter((e) => e.dte >= PMCC_LONG_LEG_MIN_DTE)
      .sort((a, b) => a.dte - b.dte)[0];
    if (!leaps) return false;
    const long = findLeg(leaps, "call", (s) => s < spot * 0.9, spot);
    return long != null && !hasIv(long);
  }
  return false;
}

export function buildStructure(
  name: string,
  chain: ChainSnapshot,
  spot: number,
  config: ResearchConfig
): BuiltStructure | null {
  const expiry = pickExpiry(chain.expiries, config.minDte, 30, 45);
  if (!expiry) return null;
  const qt = chain.asOf;
  const widthPct = 0.05;

  const legOrNull = (
    type: "call" | "put",
    filter: (s: number, spot: number) => boolean,
    qty: number
  ): ResearchLeg | null => {
    const found = findLeg(expiry, type, filter, spot);
    return found ? toResearchLeg(found, qty, qt) : null;
  };

  let legs: ResearchLeg[] | null = null;
  let economics: StructureEconomics | null = null;
  let pmcc: TradeCard["pmcc"] = null;

  switch (name) {
    case "bull_call_spread": {
      const long = legOrNull("call", (s) => s >= spot, 1);
      const short = long ? legOrNull("call", (s) => s > long.strike, -1) : null;
      if (long && short) {
        legs = [long, short];
        economics = verticalSpreadEconomics(legs, spot);
      }
      break;
    }
    case "bull_put_spread": {
      const short = legOrNull("put", (s) => s <= spot, -1);
      const long = short ? legOrNull("put", (s) => s < short.strike, 1) : null;
      if (long && short) {
        legs = [short, long];
        economics = verticalSpreadEconomics(legs, spot);
      }
      break;
    }
    case "bear_put_spread": {
      const long = legOrNull("put", (s) => s <= spot, 1);
      const short = long ? legOrNull("put", (s) => s < long.strike, -1) : null;
      if (long && short) {
        legs = [long, short];
        economics = verticalSpreadEconomics(legs, spot);
      }
      break;
    }
    case "bear_call_spread": {
      const short = legOrNull("call", (s) => s >= spot, -1);
      const long = short ? legOrNull("call", (s) => s > short.strike, 1) : null;
      if (long && short) {
        legs = [short, long];
        economics = verticalSpreadEconomics(legs, spot);
      }
      break;
    }
    case "cash_secured_put": {
      const short = legOrNull("put", (s) => s < spot, -1);
      if (short) {
        legs = [short];
        // Single short put: max loss = strike - credit (stock to zero).
        const priced = [{ ...short, mid: (short.bid + short.ask) / 2 }];
        const credit = priced[0].mid;
        economics = {
          structure: "cash_secured_put",
          legs: priced,
          netDebit: 0,
          netCredit: Number(credit.toFixed(2)),
          maxLoss: Number((short.strike - credit).toFixed(2)),
          maxGain: Number(credit.toFixed(2)),
          breakevens: [Number((short.strike - credit).toFixed(2))],
          derivationNotes: [
            "Ownership-dependent strategy: only built when explicitly permitted. Max loss assumes stock to zero.",
          ],
        };
      }
      break;
    }
    case "iron_condor": {
      const putShort = legOrNull("put", (s) => s < spot * (1 - widthPct / 2), -1);
      const putLong = putShort ? legOrNull("put", (s) => s < putShort.strike, 1) : null;
      const callShort = legOrNull("call", (s) => s > spot * (1 + widthPct / 2), -1);
      const callLong = callShort ? legOrNull("call", (s) => s > callShort.strike, 1) : null;
      if (putShort && putLong && callShort && callLong) {
        legs = [putLong, putShort, callShort, callLong];
        economics = ironCondorEconomics(legs, spot);
      }
      break;
    }
    case "butterfly": {
      const body = findLeg(expiry, "call", (s) => Math.abs(s - spot) / spot < 0.02, spot);
      if (body) {
        const wingLow = legOrNull("call", (s) => s < body.strike, 1);
        const wingHigh = legOrNull("call", (s) => s > body.strike, 1);
        if (wingLow && wingHigh) {
          const bodyLeg = toResearchLeg(body, -2, qt);
          legs = [wingLow, bodyLeg, wingHigh];
          economics = butterflyEconomics(legs, spot);
        }
      }
      break;
    }
    case "long_straddle": {
      const call = legOrNull("call", () => true, 1);
      const put = call ? legOrNull("put", (s) => s === call.strike, 1) : null;
      // #926: chain IV required — without it the structure is not built.
      if (call && put && call.iv != null && call.iv > 0) {
        legs = [call, put];
        const priced = legs.map((l) => ({ ...l, mid: (l.bid + l.ask) / 2 }));
        const premium = priced.reduce((s, l) => s + l.mid, 0);
        const assess = straddleEconomics(legs, spot, call.iv, call.dte);
        economics = {
          structure: "long_straddle",
          legs: priced,
          netDebit: Number(premium.toFixed(2)),
          netCredit: 0,
          maxLoss: Number(premium.toFixed(2)),
          maxGain: null,
          breakevens: assess.breakevens,
          derivationNotes: assess.derivationNotes.concat([
            `Premium/expected-move ${assess.premiumToExpectedMove}.`,
          ]),
        };
      }
      break;
    }
    case "long_strangle": {
      const call = legOrNull("call", (s) => s > spot, 1);
      const put = call ? legOrNull("put", (s) => s < spot, 1) : null;
      // #926: chain IV required — without it the structure is not built.
      if (call && put && call.iv != null && call.iv > 0) {
        legs = [call, put];
        const priced = legs.map((l) => ({ ...l, mid: (l.bid + l.ask) / 2 }));
        const premium = priced.reduce((s, l) => s + l.mid, 0);
        const assess = straddleEconomics(legs, spot, call.iv, call.dte);
        economics = {
          structure: "long_strangle",
          legs: priced,
          netDebit: Number(premium.toFixed(2)),
          netCredit: 0,
          maxLoss: Number(premium.toFixed(2)),
          maxGain: null,
          breakevens: assess.breakevens,
          derivationNotes: assess.derivationNotes,
        };
      }
      break;
    }
    case "pmcc": {
      // Issue #353 — the long leg needs a LEAPS expiry; the catalog's
      // poor_mans_covered_call declares farMinDte: 180, so >= 180 here
      // (was >= 300, which no loaded expiry could satisfy).
      const leaps = chain.expiries
        .filter((e) => e.dte >= PMCC_LONG_LEG_MIN_DTE)
        .sort((a, b) => a.dte - b.dte)[0];
      if (leaps) {
        const long = findLeg(leaps, "call", (s) => s < spot * 0.9, spot);
        const shortExp = pickExpiry(chain.expiries, config.minDte, 30, 45);
        const short = shortExp ? findLeg(shortExp, "call", (s) => s > spot, spot) : null;
        // #926: the long leg's chain IV is required to price the PMCC.
        if (long && short && short.strike > long.strike && long.iv != null && long.iv > 0) {
          const longLeg = toResearchLeg(long, 1, qt);
          const shortLeg = toResearchLeg(short, -1, qt);
          legs = [longLeg, shortLeg];
          const model = pmccEconomics({
            longCall: longLeg,
            shortCall: shortLeg,
            spot,
            rate: config.riskFreeRate,
            dividendYield: config.dividendYield,
            longIv: long.iv,
          });
          const priced = legs.map((l) => ({ ...l, mid: (l.bid + l.ask) / 2 }));
          economics = {
            structure: "pmcc",
            legs: priced,
            netDebit: model.netDebit,
            netCredit: 0,
            maxLoss: model.maxLoss,
            maxGain: model.maxProfit,
            breakevens: [],
            derivationNotes: model.derivationNotes,
          };
          pmcc = {
            maxProfit: model.maxProfit,
            maxLoss: model.maxLoss,
            netDebit: model.netDebit,
            maxProfitSpot: model.maxProfitSpot,
          };
        }
      }
      break;
    }
    default:
      return null;
  }
  if (!legs || !economics) return null;
  return { name, legs, economics, pmcc };
}

function scoreCandidate(
  thesisStrength: number,
  economics: StructureEconomics,
  chainProvenance: ChainProvenance,
  eventRisk: string | null,
  config: ResearchConfig
): number {
  const avgSpreadPct = economics.legs.reduce(
    (s, l) => s + ((l.ask - l.bid) / l.mid) * 100,
    0
  ) / Math.max(economics.legs.length, 1);
  const liquidity = Math.max(0, Math.min(1, 1 - avgSpreadPct / config.maxSpreadPct));
  const rewardRisk =
    economics.maxLoss > 0 && economics.maxGain !== null
      ? Math.min(economics.maxGain / economics.maxLoss, 3) / 3
      : 0.5;
  let score = 0.4 * thesisStrength + 0.35 * liquidity + 0.25 * rewardRisk;
  if (chainProvenance !== "live") score -= 1;
  if (eventRisk) score -= 0.15;
  return Number(score.toFixed(4));
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface PipelineDeps {
  provider: ResearchDataProvider;
  /** Issue #773: historical evaluation outcomes for feedback into Decide. */
  trackRecord?: import("./researchTrackRecord").TrackRecord;
}

/**
 * Issue #5911 — one job, one run id. A research run dispatched by the engine
 * already HAS a run id (the engine mints it); this fallback exists only for a
 * direct invocation with none, and even then it goes through the platform's
 * one id authority (#5175) — never a private `rsr_…` mint.
 */
function newRunId(): string {
  return mintRunId();
}

/**
 * THE single pipeline entry. Both the manual route and the scheduled tick
 * are thin triggers over this function (amendment 2).
 */
/**
 * Issue #6064 — the enrich stage: technicals and catalysts for the feed's quoted
 * symbols. Run as the `research.enrich` engine step; analyze consumes its output
 * (opts.enrich / hand-off) and does not re-fetch.
 */
export async function runEnrichStage(
  deps: PipelineDeps,
  _config: ResearchConfig,
  feed: ResearchFeedStageOutput,
  opts: ResearchRunOptions,
): Promise<ResearchEnrichStageOutput> {
  const runId = opts.runId ?? feed.runId;
  const bySymbol: Record<string, { technicals: unknown | null; catalysts: unknown[] | null }> = {};
  for (const entry of feed.quotes) {
    if (!entry.quote) continue;
    const [technicals, catalysts] = await Promise.all([
      deps.provider.getTechnicals(entry.symbol).catch(() => null),
      deps.provider.getCatalysts(entry.symbol).catch(() => null),
    ]);
    bySymbol[entry.symbol] = { technicals, catalysts };
  }
  return { runId, asOf: new Date().toISOString(), feed, bySymbol };
}

/**
 * Issue #6063 — the feed stage: regime, universe and the quote snapshot for the
 * screened slice. It is the stage's real work, run as the `research.feed`
 * engine step; `runResearchPipeline` consumes its output (opts.feed / hand-off)
 * and never re-fetches a quote the feed already has.
 */
export async function runFeedStage(
  deps: PipelineDeps,
  config: ResearchConfig,
  opts: ResearchRunOptions,
): Promise<ResearchFeedStageOutput> {
  const runId = opts.runId ?? newRunId();
  const now = opts.now ?? Date.now();
  let regime: RegimeAssessment;
  try {
    regime = await deps.provider.getRegime();
  } catch {
    regime = { regime: "unknown", notes: ["Regime feed failed — proceeding without regime context."], asOf: now };
  }
  let symbols: string[] = [];
  let universeError: string | null = null;
  let universeRefusalCode: "research_universe_unknown" | undefined;
  try {
    symbols = await deps.provider.getUniverseSymbols(config.universe);
  } catch (err) {
    universeError = err instanceof Error ? err.message : String(err);
    // Issue #6032 — a universe refusal is coded, so the report can say
    // "this universe is not resolvable", not "retrieval failed".
    if (isResearchUniverseRefusal(err)) universeRefusalCode = "research_universe_unknown";
  }
  const screened = symbols.slice(0, config.maxCandidates * 3);
  const quotes: Array<{ symbol: string; quote: QuoteSnapshot | null }> = [];
  let quotesRetrieved = 0;
  for (const symbol of screened) {
    let quote: QuoteSnapshot | null = null;
    try {
      quote = await deps.provider.getQuote(symbol);
    } catch {
      quote = null;
    }
    if (quote) quotesRetrieved++;
    quotes.push({ symbol, quote });
  }
  return {
    runId,
    asOf: new Date(now).toISOString(),
    regime,
    universe: config.universe,
    universeError,
    ...(universeRefusalCode ? { universeRefusalCode } : {}),
    symbols,
    quotes,
    universeSize: symbols.length,
    quotesRetrieved,
  };
}

export async function runResearchPipeline(
  deps: PipelineDeps,
  config: ResearchConfig,
  opts: ResearchRunOptions
): Promise<ResearchReport> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? newRunId();
  const trace: OodaStep[] = [];
  const step = (stage: OodaStep["stage"], detail: string) =>
    trace.push({ stage, detail, at: new Date().toISOString(), shortId: oodaStepShortId(stage) });

  // Issue #774: pipeline stage trace (the 8 stages from the design doc).
  const stageTrace: PipelineStageStep[] = [];
  const stage = (s: PipelineStage, detail: string) =>
    stageTrace.push({ stage: s, detail, at: new Date().toISOString() });

  // Issue #773 (a) — read the evaluation history once, at run start, and
  // state what it did. `orderingApplied` is only true when a family actually
  // carried the per-family direction accuracy the reorder needs; the reorder
  // below sets it when it sorts. Nothing in the decision path changes here.
  const MIN_EVALUATED_FOR_ORDERING = 10;
  const trackRecordSlices = deps.trackRecord?.byStrategy ?? [];
  const evaluationFeedback: EvaluationFeedback = {
    source: "track-record",
    published: deps.trackRecord?.published ?? 0,
    evaluated: deps.trackRecord?.evaluated ?? 0,
    minEvaluated: MIN_EVALUATED_FOR_ORDERING,
    families: trackRecordSlices.map((slice) => {
      const recorded = typeof (slice as { directionAccuracy?: unknown }).directionAccuracy === "number";
      return {
        key: slice.key,
        evaluated: slice.evaluated,
        winRate: slice.winRate,
        avgRMultiple: slice.avgRMultiple,
        directionAccuracyRecorded: recorded,
      };
    }),
    orderingApplied: false,
    statement: "",
  };
  const reorderableFamilies = evaluationFeedback.families.filter(
    (family) => family.directionAccuracyRecorded && family.evaluated >= MIN_EVALUATED_FOR_ORDERING,
  );
  evaluationFeedback.statement =
    evaluationFeedback.evaluated === 0
      ? "No evaluated ideas are recorded yet, so no structure was reordered on history: the loop has nothing to feed back."
      : reorderableFamilies.length > 0
        ? `Read ${evaluationFeedback.evaluated} evaluated ideas across ${evaluationFeedback.families.length} structure families; ${reorderableFamilies.length} met the ${MIN_EVALUATED_FOR_ORDERING}-evaluation bar for ordering.`
        : `Read ${evaluationFeedback.evaluated} evaluated ideas across ${evaluationFeedback.families.length} structure families, but no family records a per-family direction accuracy, so the structure order was not changed by history (win rates are recorded and shown; they are not yet an ordering input).`;

  const rejected: RejectedEntry[] = [];
  const symbolEvaluations: ResearchSymbolEvaluation[] = [];
  const watchlist: WatchlistEntry[] = [];
  const qualified: TradeCard[] = [];
  let unverified = 0;
  const stats: RunStats = {
    universeSize: 0,
    quotesRetrieved: 0,
    candidatesEvaluated: 0,
    chainsFetched: 0,
    chainsAttempted: 0,
    chainsCalibrated: 0,
    qualified: 0,
    watchlist: 0,
    rejected: 0,
    unverified: 0,
    oodaIterations: 0,
    durationMs: 0,
  };
  const costs: CostAssumptions = {
    feePerContract: config.feePerContract,
    slippagePerContract: config.slippagePerContract,
    contracts: 1,
  };

  // CONFIGURE — load validated universe, thresholds, budgets.
  stage("configure", `Universe ${config.universe}, rules v${config.rulesVersion || "1"}.`);
  // OBSERVE — market regime.
  stage("observe", "Assessing market regime.");
  step("observe", "Assessing market regime.");
  // Issue #6063 — the feed stage output, or this pipeline's own fetch when the
  // stage did not run (a direct caller, or a resumed run in another process).
  const feed = opts.feed ?? (await runFeedStage(deps, config, { ...opts, runId }));
  const enrich = opts.enrich;
  const regime = feed.regime as RegimeAssessment;
  stage("orient", `Regime: ${regime.regime}.`);
  step("orient", `Regime: ${regime.regime}.`);

  // OBSERVE — universe.
  if (feed.universeError !== null) {
    stats.universeSize = feed.universeSize;
    stats.quotesRetrieved = feed.quotesRetrieved;
    // Fail closed: no universe, no ideas — still publish the report honestly.
    // Issue #6032 — an unresolvable universe is a coded refusal naming the
    // id, not a plausible "0 candidates" night.
    const universeRefused = feed.universeRefusalCode === "research_universe_unknown";
    return finishReport({
      runId, config, opts, now, started, trace, stageTrace, regime,
      symbolEvaluations,
      ideas: [], watchlist, rejected: [{
        symbol: "*", outlook: "unknown", structure: "-",
        gate: "data_integrity",
        reason: `Universe retrieval failed: ${feed.universeError}.`,
      }],
      stats,
      evaluationFeedback,
      summary: universeRefused
        ? `Universe "${config.universe}" is not resolvable for a single run; no candidates evaluated.`
        : "Universe retrieval failed; no candidates evaluated.",
      ...(universeRefused
        ? {
            dataRefusal: {
              code: "research_universe_unknown" as const,
              message: `[${feed.universeRefusalCode}] universe "${config.universe}" — ${feed.universeError}`,
            },
          }
        : {}),
    });
  }
  stats.universeSize = feed.universeSize;
  stats.quotesRetrieved = feed.quotesRetrieved;
  const screened = feed.quotes.map((entry) => entry.symbol);
  const screenedSet = new Set(screened);
  for (const symbol of feed.symbols) {
    symbolEvaluations.push({
      symbol,
      outcome: screenedSet.has(symbol) ? "not_evaluated" : "not_screened",
      reason: screenedSet.has(symbol)
        ? "Awaiting evaluation within the configured screening budget."
        : `Outside the configured screening budget of ${config.maxCandidates * 3} symbols.`,
      strategies: [],
    });
  }
  const evaluationBySymbol = new Map(symbolEvaluations.map((evaluation) => [evaluation.symbol, evaluation]));
  step("observe", `Universe ${config.universe}: ${feed.symbols.length} symbols.`);

  let iterations = 0;
  let chainAttempts = 0;
  for (const entry of feed.quotes) {
    const symbol = entry.symbol;
    const quote = entry.quote as QuoteSnapshot | null;
    // OODA budget: stop when the next action has no clear purpose.
    if (iterations >= config.oodaMaxIterations) {
      step("decide", "OODA budget exhausted — stopping candidate evaluation.");
      for (const remaining of screened.slice(iterations)) {
        const evaluation = evaluationBySymbol.get(remaining);
        if (evaluation?.outcome === "not_evaluated") evaluation.reason = "Not evaluated because the configured OODA iteration budget was exhausted.";
      }
      break;
    }
    if (qualified.length >= config.maxIdeas && watchlist.length >= config.maxIdeas) {
      for (const remaining of screened.slice(iterations)) {
        const evaluation = evaluationBySymbol.get(remaining);
        if (evaluation?.outcome === "not_evaluated") evaluation.reason = "Not evaluated because the configured idea and watchlist limits were reached.";
      }
      break;
    }
    iterations++;
    stats.oodaIterations = iterations;
    const symbolEvaluation = evaluationBySymbol.get(symbol)!;

    // OBSERVE — quote.

    if (!quote) {
      symbolEvaluation.outcome = "quote_unavailable";
      symbolEvaluation.reason = "No quote was returned by the configured quote source.";
      rejected.push({ symbol, outlook: "unknown", structure: "-", gate: "data_integrity", reason: "No quote retrieved." });
      continue;
    }
    symbolEvaluation.quote = {
      price: quote.price,
      timestamp: quote.timestamp,
      quoteStatus: quote.quoteStatus,
      source: quote.source,
      marketCap: quote.marketCap,
      isEtf: quote.isEtf,
    };

    // ORIENT — initial filters (from config, never hardcoded).
    if (quote.isEtf && !config.etfsIncluded) {
      symbolEvaluation.outcome = "filtered";
      symbolEvaluation.reason = "ETF excluded by the effective run configuration.";
      continue;
    }
    if (!quote.isEtf && quote.marketCap != null && quote.marketCap < config.marketCapMin) {
      symbolEvaluation.outcome = "filtered";
      symbolEvaluation.reason = "Market capitalization is below the configured minimum.";
      continue; // Spec initial filter; not a "rejection" — just screened out.
    }
    if (config.priceCap !== null && quote.price > config.priceCap) {
      symbolEvaluation.outcome = "filtered";
      symbolEvaluation.reason = "Quote price is above the configured price cap.";
      continue;
    }

    // OBSERVE — technicals + catalysts.
    let technicals: Technicals | null;
    let catalysts: CatalystInfo[] | null;
    const enriched = enrich?.bySymbol[symbol];
    if (enriched) {
      technicals = enriched.technicals as Technicals | null;
      catalysts = enriched.catalysts as CatalystInfo[] | null;
    } else {
      [technicals, catalysts] = await Promise.all([
        deps.provider.getTechnicals(symbol).catch(() => null),
        deps.provider.getCatalysts(symbol).catch(() => null),
      ]);
    }

    // ORIENT — thesis.
    const draft = draftThesis(symbol, technicals, catalysts, regime);
    step("orient", `${symbol}: outlook ${draft.outlook}.`);
    if (draft.outlook === "unknown") {
      symbolEvaluation.outcome = "thesis_rejected";
      symbolEvaluation.outlook = draft.outlook;
      symbolEvaluation.reason = draft.thesis;
      rejected.push({ symbol, outlook: draft.outlook, structure: "-", gate: "thesis_coherence", reason: draft.thesis });
      continue;
    }

    // DECIDE — investigate (chain) or skip.
    if (chainAttempts >= config.maxChainsPerRun) {
      symbolEvaluation.reason = "Option chain was not requested because the configured chain budget was reached.";
      step("decide", "Chain budget exhausted — stopping.");
      for (const remaining of screened.slice(iterations)) {
        const evaluation = evaluationBySymbol.get(remaining);
        if (evaluation?.outcome === "not_evaluated") evaluation.reason = "Not evaluated because the configured option-chain budget was exhausted.";
      }
      break;
    }
    chainAttempts++;
    stats.chainsAttempted = chainAttempts;
    let chain: ChainSnapshot;
    try {
      chain = await deps.provider.getChain(symbol);
      if (chain.provenance === "unavailable" || chain.expiries.length === 0) {
        symbolEvaluation.outcome = "chain_failed";
        symbolEvaluation.outlook = draft.outlook;
        symbolEvaluation.reason = chain.failureReason ?? "Option chain source returned no expirations or contracts.";
        symbolEvaluation.chain = {
          outcome: "failed",
          source: chain.source ?? "not recorded",
          provenance: chain.provenance,
          asOf: chain.asOf,
          expiryCount: chain.expiries.length,
          legCount: chain.expiries.reduce((count, expiry) => count + expiry.legs.length, 0),
          ...(chain.failureReason ? { failureReason: chain.failureReason } : {}),
        };
        rejected.push({ symbol, outlook: draft.outlook, structure: "-", gate: "quote_quality", reason: symbolEvaluation.reason });
        continue;
      }
      stats.chainsFetched++;
      if (chain.provenance === "calibrated") stats.chainsCalibrated++;
    } catch (error) {
      symbolEvaluation.outcome = "chain_failed";
      symbolEvaluation.outlook = draft.outlook;
      const reason = error instanceof Error ? error.message : String(error);
      symbolEvaluation.reason = reason;
      symbolEvaluation.chain = { outcome: "failed", source: quote.source, failureReason: reason };
      rejected.push({ symbol, outlook: draft.outlook, structure: "-", gate: "quote_quality", reason });
      continue;
    }
    stats.candidatesEvaluated++;
    symbolEvaluation.outcome = "evaluated";
    symbolEvaluation.outlook = draft.outlook;
    symbolEvaluation.reason = "Option chain retrieved; configured strategy structures evaluated.";
    symbolEvaluation.chain = {
      outcome: "retrieved",
      source: chain.source ?? "not recorded",
      provenance: chain.provenance,
      asOf: chain.asOf,
      expiryCount: chain.expiries.length,
      legCount: chain.expiries.reduce((count, expiry) => count + expiry.legs.length, 0),
      ...(chain.failureReason ? { failureReason: chain.failureReason } : {}),
    };

    // BUILD-AND-PRICE — construct candidate structures per the §6 table; keep the best
    // gated one. Alternatives are evaluated, not just the richest premium.
    stage("build-and-price", `${symbol}: building ${draft.outlook} structures.`);
    let structureNames = structuresForOutlook(draft.outlook, config.ownershipStrategiesAllowed, config.pmccEnabled);
    // Issue #773: reorder structures by historical direction accuracy.
    // Families with poor accuracy (<40%, n>=10) go last; strong ones (>60%) go first.
    if (deps.trackRecord?.byStrategy?.length) {
      const acc = new Map<string, { correct: number; total: number }>();
      for (const s of deps.trackRecord.byStrategy) {
        // byStrategy slices have directionAccuracy and evaluated counts
        const evaluated = (s as any).evaluated ?? 0;
        const dirAcc = (s as any).directionAccuracy;
        if (typeof dirAcc === "number" && evaluated >= 10) {
          acc.set(s.key, { correct: Math.round(dirAcc * evaluated), total: evaluated });
        }
      }
      if (acc.size > 0) {
        const score = (name: string) => {
          const a = acc.get(name);
          if (!a) return 0.5; // no data → neutral
          const rate = a.correct / a.total;
          return rate < 0.4 ? -1 : rate > 0.6 ? 1 : 0;
        };
        structureNames = [...structureNames].sort((a, b) => score(b) - score(a));
        evaluationFeedback.orderingApplied = true;
        step("decide", `Structure order by historical accuracy: ${structureNames.join(", ")}.`);
      }
    }
    let bestCard: TradeCard | null = null;

    for (const name of structureNames) {
      let built: BuiltStructure | null = null;
      try {
        built = buildStructure(name, chain, quote.price, config);
      } catch {
        built = null;
      }
      if (!built) {
        const missingIv = missingIvForStructure(name, chain, quote.price, config);
        symbolEvaluation.strategies.push({
          strategy: name,
          outcome: "build_unavailable",
          reason: missingIv ? "Required chain IV is missing; no assumed IV was used." : "The available chain could not build this structure.",
        });
        // #926: a missing-IV build is a counted exclusion, not a silent skip.
        if (missingIv) {
          rejected.push({
            symbol, outlook: draft.outlook, structure: name,
            gate: "missing-iv",
            reason: "Chain IV missing for the required leg — structure excluded, no assumed IV used.",
          });
        }
        continue;
      }

      const eventRisk: string | null =
        (catalysts ?? []).find((c) => c.date != null)?.description ?? null;
      const hasNearTermShortLeg = built.legs.some(
        (l) => l.quantity < 0 && l.dte <= config.assignmentRiskDte
      );
      // #926: expected move needs the first leg's chain IV; without it the
      // percentage stays null (the isFinite guard below) — never 0.4.
      const firstLegIv = built.legs[0]?.iv;
      const allLegsHaveIv = built.legs.every((l) => l.iv != null && l.iv > 0);
      const em = firstLegIv != null && firstLegIv > 0
        ? expectedMove(quote.price, firstLegIv, built.legs[0].dte / 365)
        : NaN;

      const gateCandidate: GateCandidate = {
        symbol,
        outlook: draft.outlook,
        thesis: draft.thesis,
        quote: {
          price: quote.price,
          timestamp: quote.timestamp,
          marketCap: quote.marketCap ?? null,
          quoteStatus: quote.quoteStatus,
          source: quote.source,
        },
        chain: {
          underlyingPrice: chain.underlyingPrice,
          asOf: chain.asOf,
          provenance: chain.provenance,
        },
        legs: built.legs,
        structure: name,
        economics: built.economics,
        expectedMovePct: Number.isFinite(em) ? Number((em / quote.price).toFixed(4)) : null,
        eventRisk,
        hasNearTermShortLeg,
        sources: [quote.source, `chain:${chain.provenance}`],
        limitations: [
          ...(catalysts === null ? ["Catalyst/event feed unavailable — event risk partially unassessed."] : []),
          ...(chain.provenance === "calibrated" ? ["Chain is model-calibrated, not a live broker quote."] : []),
          ...(firstLegIv == null || firstLegIv <= 0 ? ["Expected move unavailable — first leg lacks chain IV; no assumed IV used."] : []),
          ...(!allLegsHaveIv ? ["IV-dependent scenarios unavailable — one or more legs lack chain IV; no assumed IV used."] : []),
          "American-exercise nuances are not priced; early assignment is a risk-review item, not a modeled cost.",
          "Portfolio concentration unassessed — no portfolio data available.",
        ],
        falsificationPresent: true,
      };

      const outcome = runStageGates(gateCandidate, { config, now });
      if (outcome.status === "rejected") {
        const gate = outcome.gateResults.find((g) => !g.passed)?.gate ?? "unknown";
        const reason = outcome.rejectionReason ?? "Rejected.";
        symbolEvaluation.strategies.push({ strategy: name, outcome: "rejected", gate, reason, legs: built.legs });
        rejected.push({
          symbol, outlook: draft.outlook, structure: name,
          gate,
          reason,
        });
        continue;
      }
      if (outcome.status === "unverified") {
        symbolEvaluation.strategies.push({ strategy: name, outcome: "unverified", reason: "Required evidence was unavailable for a verified gate result.", legs: built.legs });
        unverified++;
        continue;
      }

      // Falsification + pre-mortem (§§4,7).
      const invalidation =
        draft.outlook === "bullish"
          ? `Underlying closes below ${quote.price.toFixed(2)} (thesis entry reference) or breakeven ${built.economics.breakevens.join("/")} violated at expiry.`
          : draft.outlook === "bearish"
            ? `Underlying closes above ${quote.price.toFixed(2)} or breakeven violated at expiry.`
            : `Underlying exits the ${(built.economics.breakevens.join(" – ") || "profitable")} range.`;
      const { falsification, warnings } = buildFalsification({
        symbol,
        outlook: draft.outlook,
        thesis: draft.thesis,
        supportingEvidence: draft.supporting,
        contradictingEvidence: draft.contradicting,
        resolutionTrigger: eventRisk ?? "Price action toward the thesis over the holding window.",
        horizon: `${built.legs[0]?.dte ?? 30} DTE`,
        invalidation,
        whyThisStructure: `${name} expresses ${draft.outlook} with defined risk; max loss $${built.economics.maxLoss.toFixed(2)}/unit vs uncapped directional exposure in shares.`,
      });
      const premortem = buildPremortem({
        symbol,
        structure: name,
        hasShortLeg: built.legs.some((l) => l.quantity < 0),
        eventRisk,
        maxLoss: built.economics.maxLoss,
      });

      // #926: buildScenarioRows itself returns [] when any leg lacks IV;
      // pass NaN (not 0.4) when the first leg has none, so the guard fires.
      const scenarios = buildScenarioRows(
        built.economics,
        quote.price,
        firstLegIv != null && firstLegIv > 0 ? firstLegIv : NaN,
        Math.min(21, Math.max(7, Math.floor(built.legs[0].dte / 2))),
        config.riskFreeRate,
        config.dividendYield,
        costs
      );
      const contractualMaxLoss = Number(
        (built.economics.maxLoss * 100 * costs.contracts +
          (costs.feePerContract + costs.slippagePerContract) * costs.contracts).toFixed(2)
      );
      const score = scoreCandidate(draft.strength, built.economics, chain.provenance, eventRisk, config);

      const card: TradeCard = {
        rank: 0,
        symbol,
        outlook: draft.outlook,
        thesis: draft.thesis,
        supportingEvidence: draft.supporting,
        contradictingEvidence: draft.contradicting,
        falsification,
        falsificationWarnings: warnings,
        premortem,
        structure: name,
        legs: built.legs,
        economics: built.economics,
        pmcc: built.pmcc ?? null,
        scenarios,
        entryCondition: `Enter at or better than mid; re-verify quotes are live (≤${config.quoteFreshnessSeconds}s old) before entry.`,
        invalidation,
        contractualMaxLoss,
        feesNote: `Fees $${config.feePerContract}/contract + $${config.slippagePerContract} slippage/contract assumed; 1 contract modeled.`,
        limitations: gateCandidate.limitations,
        sources: gateCandidate.sources,
        quoteTimestamp: quote.timestamp,
        entrySpot: quote.price,
        chainProvenance: chain.provenance,
        score,
        status: "qualified",
      };

      if (outcome.status === "watchlist") {
        symbolEvaluation.strategies.push({ strategy: name, outcome: "watchlist", reason: outcome.rejectionReason ?? "Watchlist.", legs: built.legs });
        watchlist.push({
          symbol,
          outlook: draft.outlook,
          thesis: draft.thesis,
          structure: name,
          reason: outcome.rejectionReason ?? "Watchlist.",
          triggerCondition: "Re-run when live quotes are available and spread/activity thresholds pass.",
        });
        continue;
      }
      symbolEvaluation.strategies.push({ strategy: name, outcome: "qualified", legs: built.legs });
      if (!bestCard || card.score > bestCard.score) bestCard = card;
      step("act", `${symbol} ${name}: gated ${outcome.status}, score ${card.score}.`);
    }
    stage("challenge-and-gate", `${symbol}: ${bestCard ? `qualified ${bestCard.structure}` : "no qualifying structure"}.`);

    if (bestCard) {
      symbolEvaluation.selectedStrategy = bestCard.structure;
      symbolEvaluation.reason = `Selected ${bestCard.structure} as the highest scoring qualified structure for this symbol.`;
      qualified.push(bestCard);
      step("decide", `${symbol}: shortlisted ${bestCard.structure}.`);
    }
  }

  // RANK-AND-REPORT: top config.maxIdeas.
  qualified.sort((a, b) => b.score - a.score);
  const ideas = qualified.slice(0, config.maxIdeas).map((c, i) => ({ ...c, rank: i + 1 }));
  stage("rank-and-report", `${ideas.length} ideas ranked from ${qualified.length} qualified.`);

  stats.qualified = ideas.length;
  stats.watchlist = watchlist.length;
  stats.rejected = rejected.length;
  stats.unverified = unverified;

  // Issue #5909 — "nothing qualified" and "we fetched no data at all" must
  // never read alike: a non-empty universe with zero quotes is an outage, and
  // the caller fails the run on it. The report is still built and published.
  const dataRefusal =
    stats.universeSize > 0 && stats.quotesRetrieved === 0
      ? {
          code: "research_data_unavailable" as const,
          message: `No quotes retrieved for a ${stats.universeSize}-symbol universe (quotes 0 / evaluated 0) — the run produced no data; check the live quote session before the next run.`,
        }
      : undefined;
  const summary =
    dataRefusal?.message ??
    (ideas.length > 0
      ? `${ideas.length} qualified idea(s); ${watchlist.length} watchlist; ${rejected.length} rejected.`
      : "No qualifying opportunities — no candidate passed the evidence and risk gates.");

  return finishReport({
    runId, config, opts, now, started, trace, stageTrace, regime,
    symbolEvaluations,
    ideas, watchlist, rejected, stats, summary, evaluationFeedback,
    ...(dataRefusal ? { dataRefusal } : {}),
  });
}

function finishReport(args: {
  runId: string;
  config: ResearchConfig;
  opts: ResearchRunOptions;
  now: number;
  started: number;
  trace: OodaStep[];
  stageTrace: PipelineStageStep[];
  symbolEvaluations: ResearchSymbolEvaluation[];
  regime: RegimeAssessment;
  ideas: TradeCard[];
  watchlist: WatchlistEntry[];
  rejected: RejectedEntry[];
  stats: RunStats;
  summary: string;
  evaluationFeedback: EvaluationFeedback;
  dataRefusal?: {
    code: "research_data_unavailable" | "research_universe_unknown";
    message: string;
  };
}): ResearchReport {
  const { runId, config, opts, now, started, trace, stageTrace, regime, ideas, watchlist, rejected, stats, summary, symbolEvaluations, evaluationFeedback } = args;
  stats.durationMs = Date.now() - started;
  return {
    runId,
    // Idempotent generation id: one canonical row per run (re-delivery never duplicates).
    generationId: `options_research:${runId}`,
    trigger: opts.trigger,
    userLogin: opts.userLogin,
    createdAt: new Date(now).toISOString(),
    rulesVersion: config.rulesVersion,
    // Issue #5912 — the venue/mode this run used, recorded once here.
    ...(opts.brokerId ? { brokerId: opts.brokerId } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    assetType: opts.assetType ?? "options",
    ...(opts.accountType ? { accountType: opts.accountType } : {}),
    ...(opts.accountId ? { accountId: maskAccountId(opts.accountId) } : {}),
    // Amendment 1: the effective filter/config snapshot this run used.
    configSnapshot: JSON.parse(JSON.stringify(config)) as ResearchConfig,
    // Issue #773 (a) — the evaluation history this run read, and whether it
    // changed a decision. Stated on every report, closed or open.
    evaluationFeedback,
    regime,
    summary,
    ideas,
    watchlist,
    rejected,
    symbolEvaluations,
    stats,
    oodaTrace: trace,
    stageTrace,
    ...(args.dataRefusal ? { dataRefusal: args.dataRefusal } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* §9 — evaluation pass (later prices vs thesis; no retrospective edits)*/
/* ------------------------------------------------------------------ */

export interface StoredIdeaRecord {
  runId: string;
  symbol: string;
  structure: string;
  legs: ResearchLeg[];
  economics: StructureEconomics;
  thesis: string;
  invalidation: string;
  entrySpot: number;
  quoteTimestamp: number;
  rulesVersion: string;
  createdAt: string;
  /** Idea outlook for direction scoring (#583); absent on legacy records. */
  outlook?: Outlook;
}

export interface IdeaEvaluation {
  symbol: string;
  structure: string;
  invalidated: boolean;
  /** P&L estimate per unit at evaluation (intrinsic-based when expired, BS otherwise). */
  pnlEstimatePerUnit: number | null;
  evalSpot: number | null;
  /**
   * #583 docx §9 direction dimension: did spot move in the thesis outlook's
   * direction vs entry? Null when unscored (non-directional outlook or no
   * follow-up quote). Heuristic, not a fill record.
   */
  directionCorrect: boolean | null;
  notes: string[];
}

export interface ResearchEvaluation {
  runId: string;
  evaluatedAt: string;
  rulesVersion: string;
  ideas: IdeaEvaluation[];
  aggregates: {
    evaluated: number;
    invalidated: number;
    avgPnlPerUnit: number | null;
    dataQualityFailures: number;
    /**
     * #583: fraction of direction-scored ideas that scored correct
     * (null when none scored).
     */
    directionAccuracy: number | null;
  };
  /** Rules are versioned; evaluation never edits the original record. */
  note: string;
}

/**
 * Evaluate a published run against later prices. Reads the stored idea
 * records; writes an evaluation row; never mutates the original report
 * (spec §9: no retrospective rule changes).
 */
export async function runResearchEvaluation(
  deps: PipelineDeps,
  ideas: StoredIdeaRecord[],
  runId: string,
  config: ResearchConfig,
  now?: number
): Promise<ResearchEvaluation> {
  const at = now ?? Date.now();
  const results: IdeaEvaluation[] = [];
  let dataQualityFailures = 0;

  for (const idea of ideas) {
    const notes: string[] = [];
    let quote: QuoteSnapshot | null = null;
    try {
      quote = await deps.provider.getQuote(idea.symbol);
    } catch {
      quote = null;
    }
    if (!quote) {
      dataQualityFailures++;
      results.push({
        symbol: idea.symbol,
        structure: idea.structure,
        invalidated: false,
        pnlEstimatePerUnit: null,
        evalSpot: null,
        directionCorrect: null,
        notes: ["Evaluation quote unavailable — data quality failure recorded."],
      });
      continue;
    }
    // Invalidation heuristic: eval spot beyond the first breakeven on the
    // wrong side, or spot moved >2× the entry expected range against the
    // structure. Documented as heuristic, not a fill record.
    const bes = idea.economics.breakevens;
    let invalidated = false;
    if (bes.length > 0) {
      const lo = Math.min(...bes);
      const hi = Math.max(...bes);
      if (quote.price < lo * 0.98 || quote.price > hi * 1.02) {
        invalidated = true;
        notes.push(`Spot ${quote.price} outside breakeven band [${lo}, ${hi}].`);
      }
    }
    // P&L estimate: intrinsic value of legs at eval spot minus opening cost.
    // When legs have not expired this is a rough estimate — flagged as such.
    // No legs means no economics: the estimate is unknown (null), never 0.
    let pnl: number | null = null;
    try {
      if (idea.legs.length === 0) {
        notes.push("P&L estimate unavailable — idea has no legs.");
      } else {
        const intrinsic = idea.legs.reduce((s, leg) => {
        const iv =
          leg.optionType === "call"
            ? Math.max(quote!.price - leg.strike, 0)
            : Math.max(leg.strike - quote!.price, 0);
        return s + leg.quantity * iv;
      }, 0);
      const openCost = idea.legs.reduce(
        (s, leg) => s + leg.quantity * ((leg.bid + leg.ask) / 2),
        0
      );
      pnl = Number((intrinsic - openCost).toFixed(2));
        notes.push("P&L is an intrinsic-based estimate, not a fill record.");
      }
    } catch {
      notes.push("P&L estimation failed.");
    }
    results.push({
      symbol: idea.symbol,
      structure: idea.structure,
      invalidated,
      pnlEstimatePerUnit: pnl,
      evalSpot: quote.price,
      directionCorrect: scoreDirection(idea.outlook, idea.entrySpot, quote.price),
      notes,
    });
  }

  const pnls = results
    .map((r) => r.pnlEstimatePerUnit)
    .filter((p): p is number => p !== null);
  const scored = results.filter((r) => r.directionCorrect !== null);
  return {
    runId,
    evaluatedAt: new Date(at).toISOString(),
    rulesVersion: config.rulesVersion,
    ideas: results,
    aggregates: {
      evaluated: results.length,
      invalidated: results.filter((r) => r.invalidated).length,
      avgPnlPerUnit:
        pnls.length > 0
          ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2))
          : null,
      dataQualityFailures,
      directionAccuracy:
        scored.length > 0
          ? Number(
              (
                scored.filter((r) => r.directionCorrect).length / scored.length
              ).toFixed(3)
            )
          : null,
    },
    note: `Evaluated under rules ${config.rulesVersion}; original records unmodified.`,
  };
}

/**
 * #583 docx §9 direction dimension: did spot move in the thesis outlook's
 * direction relative to entry? Returns null for non-directional outlooks.
 * Heuristic — direction only, not magnitude or fill quality.
 */
function scoreDirection(
  outlook: Outlook | undefined,
  entrySpot: number,
  evalSpot: number
): boolean | null {
  if (outlook === "bullish") return evalSpot > entrySpot;
  if (outlook === "bearish") return evalSpot < entrySpot;
  return null;
}

/**
 * #583: select runs due for outcome evaluation — runs older than `minAgeMs`
 * with no evaluation row yet, oldest first, capped at `limit`.
 * Pure function over run metadata; the caller performs the evaluations.
 */
export function selectRunsDueForEvaluation(
  runs: Array<{ runId: string; createdAt: string }>,
  evaluatedRunIds: Set<string>,
  nowMs: number,
  minAgeMs: number,
  limit = 5
): string[] {
  const cutoff = new Date(nowMs - minAgeMs).toISOString();
  return runs
    .filter((r) => r.createdAt < cutoff && !evaluatedRunIds.has(r.runId))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, limit)
    .map((r) => r.runId);
}
