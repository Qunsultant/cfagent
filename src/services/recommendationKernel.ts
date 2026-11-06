/**
 * Consolidation C4 (issue #1329, epic #1151) — the Recommendation Kernel.
 *
 * Design of record: docs/architecture/recommendation-engine-rationalization.md.
 *
 * One pipeline, pattern-oriented (GoF / GRASP / SOLID):
 *  - Facade + Controller: RecommendationService — the single entry for the
 *    panel route, the research paths, and comparison runs.
 *  - Template Method: RecommendationKernel — fixed skeleton
 *    loadSnapshot → buildCandidates → gate → price → rank → falsify →
 *    assemble, with overridable stage methods and attrition counted at
 *    every stage boundary.
 *  - Chain of Responsibility: GateHandler — the gate stage takes the most
 *    restrictive tier across handlers; calibrated provenance caps at
 *    Watchlist on every path.
 *  - Strategy: CandidateBuilder / RankingPolicy — builders wrap the
 *    existing construction functions (D1 engine, D4 discovery, composition
 *    algebra, LLM generation); they never reimplement them and never
 *    import route files, DO/storage, or execution APIs.
 *  - Composite: the leg-graph (strategyComposition) is the structure
 *    representation; D1 StrategyCandidates are adapted into it.
 *  - Decorator (C5 seam): WeightsRankDecorator — passthrough unless a
 *    weights function is injected, and then within-tier only.
 *
 * Honesty invariants (never fabricated, never silently qualified):
 *  - A candidate with economics null, or without falsification evidence,
 *    is demoted to at most Unverified by the falsify stage.
 *  - The price stage maps wrapped D1 engine economics onto the kernel
 *    contract; every other null-economics candidate stays null — the
 *    stage never invents a price. (Generic researchEconomics grid
 *    pricing lives in the Composed / LLM builders at build time, where
 *    the quote evidence is in hand.)
 *  - A stage failure throws KernelStageError naming the stage (and the
 *    builder/handler/policy where known) — never a silent complete.
 *  - Draft-only: nothing in this module places, modifies, or cancels
 *    orders, and no surface here returns an execution artifact.
 */

import { DoSqliteComparisonLedgerStore } from "../data/doSqliteComparisonLedgerAdapter";
import type { ComparisonLedgerSqlExecutor } from "../data/comparisonLedgerPorts";
import { runStageGates, type ChainProvenance, type IdeaStatus, type Outlook } from "./researchGates";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "./researchConfig";
import {
  composedStructureEconomics,
  legMid,
  type ResearchLeg,
  type StructureEconomics,
} from "./researchEconomics";
import {
  analyzeRisk,
  combine,
  graphFromResearchLegs,
  optionLegsOf,
  overlay,
  repairVerticalToButterfly,
  transformStraddleToStrangle,
} from "./strategyComposition";
import type { ChainSnapshot } from "./researchPipeline";
import type { DiscoveryCandidate, NameFit } from "./researchDiscovery";
import type { ScreenedOptionContractItem } from "../types";
// Trading boundary (#290): outside src/trading/, engine types come
// only through the trading barrel — never a trading-internal path,
// even for `import type` (the boundary test scans specifiers).
import type {
  BestTradePick,
  RankedStrategy,
  RawOptionsIdeasResponse,
  RiskProfile,
  StrategyCandidate,
  StrategyRequest,
  StrategyScreenFilter,
} from "../trading";
import { buildPanelFetchDteBands } from "../trading";

/* ------------------------------------------------------------------ */
/* Candidate contract                                                  */
/* ------------------------------------------------------------------ */

export type KernelProvenance = "llm" | "quant" | "composed";

export interface KernelCandidate {
  id: string;
  symbol: string;
  structure: string;
  label: string;
  legs: ResearchLeg[];
  economics: StructureEconomics | null;
  status: IdeaStatus;
  provenance: KernelProvenance;
  chainProvenance: ChainProvenance;
  definedRisk: boolean;
  marginEstimate: number | null;
  assignmentRisk: boolean;
  gateReasons: string[];
  limitations: string[];
  rationale: string;
  builderId: string;
  model?: string;
  temperature?: number;
  scenario?: { worstPnlTotal: number; meanPnlTotal: number; bestPnlTotal: number; withinConstraints: boolean };
  engineScore?: number;
  /** The wrapped source candidate (engine / discovery / fit), for route-shape mapping. */
  source?: unknown;
  /** Builder-asserted falsification evidence; absent ⇒ falsify demotes. */
  falsificationEvidence?: string;
  /** Rank-stage outputs. */
  score?: number;
  rank?: number;
  /** Strategy→Names fit score (PerNameBestFit orders on this). */
  fitScore?: number;
}

export interface KernelSnapshot {
  symbol: string;
  dataSource: "live" | "calibrated-demo";
  chainProvenance: ChainProvenance;
  contracts?: ScreenedOptionContractItem[];
  /** Raw chains passthrough (e.g. for the LLM generator's input). */
  chains?: unknown;
  /** Snapshot quotes keyed by contract symbol (the LLM builder's price source). */
  quotes?: Record<string, { bid: number; ask: number; iv?: number | null; volume?: number | null; openInterest?: number | null }>;
  underlyingPrice?: number;
  quote?: { price: number; timestamp: number; source: string };
  /** ResearchPipeline chain snapshot, when the caller has one (composition operators). */
  chain?: ChainSnapshot;
  screen?: unknown;
  rejections?: unknown;
  validationError?: string;
}

export interface KernelAttrition {
  generated: number;
  gatePassed: number;
  priced: number;
  falsified: number;
  ranked: number;
}

export interface KernelDiscoveryResult {
  snapshot: KernelSnapshot;
  candidates: KernelCandidate[];
  rejected: Array<{ id: string; structure: string; reason: string }>;
  attrition: KernelAttrition;
  limitations: string[];
  /** D1 engine build result, passed through for route-shape consumers
   *  that still need it (the /compare pool counts the full built set;
   *  the panel pipeline's PipelineResult.strategies IS this object). Never
   *  recomputed by the kernel. */
  legacy?: { evaluations?: unknown; nameLedger?: unknown; excluded?: unknown; buildResult?: EngineBuildResult };
}

/** Severity order: qualified 0 < watchlist 1 < unverified 2 < rejected 3. */
export const STATUS_TIERS: Record<IdeaStatus, number> = {
  qualified: 0,
  watchlist: 1,
  unverified: 2,
  rejected: 3,
};

function tierOf(status: IdeaStatus): number {
  return STATUS_TIERS[status] ?? 2;
}

function statusOfTier(tier: number): IdeaStatus {
  if (tier <= 0) return "qualified";
  if (tier === 1) return "watchlist";
  if (tier === 2) return "unverified";
  return "rejected";
}

/** D1 OptionThesis → research Outlook (large_move is the volatile outlook). */
export function outlookForThesis(thesis: unknown): Outlook | undefined {
  switch (thesis) {
    case "bullish":
      return "bullish";
    case "bearish":
      return "bearish";
    case "range_bound":
      return "range_bound";
    case "large_move":
      return "volatile";
    default:
      return undefined;
  }
}

export class KernelStageError extends Error {
  readonly stage: string;
  constructor(message: string, stage = "") {
    super(message);
    this.name = "KernelStageError";
    this.stage = stage;
  }
}

/* ------------------------------------------------------------------ */
/* Builders (Strategy)                                                 */
/* ------------------------------------------------------------------ */

export interface BuilderInput {
  snapshot: KernelSnapshot;
  request: unknown;
}

export interface CandidateBuilder {
  id: string;
  build(input: BuilderInput): KernelCandidate[] | Promise<KernelCandidate[]>;
  /** Limitations the builder recorded during its last build (drained by the kernel). */
  limitations?: string[];
}

/** Minimal structural shape the engine-candidate mapper reads. */
export interface MinimalEngineLeg {
  optionType: "CALL" | "PUT" | "STOCK";
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expirationDate: string;
  daysToExpiration?: number;
  bid: number;
  ask: number;
  impliedVolatility?: number;
  volume?: number;
  openInterest?: number;
  quoteTimestamp?: string;
}

export interface MinimalEngineCandidate {
  id: string;
  type: string;
  label: string;
  symbol: string;
  legs: MinimalEngineLeg[];
  score: number;
}

function requestField(request: unknown, field: string): unknown {
  return request && typeof request === "object" ? (request as Record<string, unknown>)[field] : undefined;
}

/** Adapter: a D1 engine candidate → the kernel contract (Composite leg-graph). */
export function mapStrategyCandidateToKernelCandidate(
  candidate: MinimalEngineCandidate,
  builderId: string,
): KernelCandidate {
  const limitations: string[] = [];
  const legs: ResearchLeg[] = [];
  for (const leg of candidate.legs) {
    if (leg.optionType === "STOCK") {
      limitations.push(`Stock leg ${leg.strike} omitted from the kernel leg-graph (options-only contract).`);
      continue;
    }
    legs.push({
      optionType: leg.optionType === "CALL" ? "call" : "put",
      strike: leg.strike,
      expiry: leg.expirationDate,
      dte: leg.daysToExpiration ?? 0,
      bid: leg.bid,
      ask: leg.ask,
      iv: leg.impliedVolatility ?? null,
      volume: leg.volume ?? null,
      openInterest: leg.openInterest ?? null,
      quantity: (leg.side === "BUY" ? 1 : -1) * leg.quantity,
      quoteTimestamp: leg.quoteTimestamp ? Date.parse(leg.quoteTimestamp) : null,
    });
  }
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    structure: candidate.type,
    label: candidate.label,
    legs,
    economics: null, // Filled by the price stage from the wrapped engine economics.
    status: "qualified", // Provisional: the gate chain only ever restricts downward.
    provenance: "quant",
    chainProvenance: "live",
    definedRisk: false,
    marginEstimate: null,
    assignmentRisk: false,
    gateReasons: [],
    limitations,
    rationale: candidate.label,
    builderId,
    engineScore: candidate.score,
    source: candidate,
  };
}

/** A wrapped engine candidate is recognizable by its engine score + net debit. */
export function isWrappedEngineCandidate(source: unknown): source is StrategyCandidate {
  if (!source || typeof source !== "object") return false;
  const s = source as Record<string, unknown>;
  return typeof s.score === "number" && typeof s.netDebit === "number" && Array.isArray(s.legs);
}

export interface EngineBuildResult {
  candidates: MinimalEngineCandidate[];
  evaluations?: unknown;
  nameLedger?: unknown;
  excluded?: unknown;
}

/** ViewStructureBuilder: StrategyRiskAgent.buildStrategies → kernel candidates. */
export class ViewStructureBuilder implements CandidateBuilder {
  readonly id = "view-structure";
  limitations: string[] = [];
  lastResult?: EngineBuildResult;
  constructor(
    private readonly opts: {
      buildFn: (contracts: ScreenedOptionContractItem[], request: unknown) => EngineBuildResult | Promise<EngineBuildResult>;
    },
  ) {}

  async build(input: BuilderInput): Promise<KernelCandidate[]> {
    const result = await this.opts.buildFn(input.snapshot.contracts ?? [], input.request);
    this.lastResult = result;
    return result.candidates.map((c) => mapStrategyCandidateToKernelCandidate(c, this.id));
  }
}

/** NoViewStructureBuilder: recommendNoViewStrategies → kernel candidates. */
export class NoViewStructureBuilder implements CandidateBuilder {
  readonly id = "no-view-structure";
  limitations: string[] = [];
  lastResult?: EngineBuildResult;
  constructor(
    private readonly opts: {
      buildFn: (contracts: ScreenedOptionContractItem[], request: unknown) => EngineBuildResult | Promise<EngineBuildResult>;
    },
  ) {}

  async build(input: BuilderInput): Promise<KernelCandidate[]> {
    const result = await this.opts.buildFn(input.snapshot.contracts ?? [], input.request);
    this.lastResult = result;
    return result.candidates.map((c) => mapStrategyCandidateToKernelCandidate(c, this.id));
  }
}

export interface DiscoveryForNameResult {
  candidates: DiscoveryCandidate[];
  rejected: Array<{ structure: string; reason: string }>;
  limitations?: string[];
  provenance?: ChainProvenance;
}

/**
 * CatalogFitBuilder: delegates to researchDiscovery.discoverStrategiesForName
 * via an injected function — the kernel never imports the discovery module's
 * provider machinery directly (no cycle, no provider construction here).
 * Catalog → quant, composed → composed; the discovery scenario, economics,
 * and gate artifacts are preserved verbatim.
 */
export class CatalogFitBuilder implements CandidateBuilder {
  readonly id = "catalog-fit";
  limitations: string[] = [];
  constructor(
    private readonly opts: {
      discoverFn: (opts: { symbol: string; outlook: Outlook }) => Promise<DiscoveryForNameResult>;
    },
  ) {}

  async build(input: BuilderInput): Promise<KernelCandidate[]> {
    const symbol = (requestField(input.request, "symbol") as string | undefined) ?? input.snapshot.symbol;
    const outlook = (requestField(input.request, "outlook") as Outlook | undefined) ?? "unknown";
    const result = await this.opts.discoverFn({ symbol, outlook });
    this.limitations = [...(result.limitations ?? [])];
    const seen = new Map<string, number>();
    return result.candidates.map((dc) => {
      const baseId = `research:${dc.symbol}:${dc.source}:${dc.structure}`;
      const n = (seen.get(baseId) ?? 0) + 1;
      seen.set(baseId, n);
      return {
        id: n === 1 ? baseId : `${baseId}#${n}`,
        symbol: dc.symbol,
        structure: dc.structure,
        label: dc.label,
        legs: dc.legs,
        economics: dc.economics,
        status: dc.status,
        provenance: dc.source === "composed" ? "composed" : "quant",
        chainProvenance: dc.provenance,
        definedRisk: dc.definedRisk,
        marginEstimate: dc.marginEstimate,
        assignmentRisk: dc.assignmentRisk,
        gateReasons: [...dc.gateReasons],
        limitations: [...dc.limitations],
        // Discovery candidates were gated with falsificationPresent: true
        // by gateComposedCandidate inside researchDiscovery — this mirrors
        // that upstream assertion, it does not invent one.
        rationale: `${dc.label} for ${dc.symbol} under ${outlook} outlook.`,
        builderId: this.id,
        scenario: { ...dc.scenario },
        falsificationEvidence: "researchDiscovery: gateComposedCandidate falsificationPresent",
        source: dc,
      } satisfies KernelCandidate;
    });
  }
}

export type CompositionOperatorName =
  | "overlay"
  | "combine"
  | "transformStraddleToStrangle"
  | "repairVerticalToButterfly";

/**
 * ComposedStructureBuilder: applies ONE named strategyComposition operator
 * to base kernel candidates via graphFromResearchLegs. On operator failure
 * it yields zero candidates + a limitation — it never throws the run.
 */
export class ComposedStructureBuilder implements CandidateBuilder {
  readonly id: string;
  limitations: string[] = [];
  constructor(
    private readonly opts: {
      operator: CompositionOperatorName;
      chain?: ChainSnapshot;
      bases?: KernelCandidate[];
      baseBuilder?: CandidateBuilder;
      currentPnlPerUnit?: number;
    },
  ) {
    this.id = `composed-${opts.operator}`;
  }

  async build(input: BuilderInput): Promise<KernelCandidate[]> {
    this.limitations = [];
    const bases = this.opts.bases ?? (this.opts.baseBuilder ? await this.opts.baseBuilder.build(input) : []);
    if (bases.length === 0) {
      this.limitations.push(`ComposedStructureBuilder (${this.opts.operator}): no base candidates to compose from.`);
      return [];
    }
    const chain = this.opts.chain ?? input.snapshot.chain;
    const graphOf = (base: KernelCandidate) =>
      graphFromResearchLegs({ id: base.id, label: base.label, source: "catalog", legs: base.legs });
    let outcome: ReturnType<typeof overlay> | ReturnType<typeof combine> | null = null;
    let structure = bases[0].structure;
    let parents: string[] = [bases[0].id];
    switch (this.opts.operator) {
      case "overlay": {
        if (!chain) {
          this.limitations.push("ComposedStructureBuilder (overlay): no chain snapshot available for wing selection.");
          return [];
        }
        outcome = overlay(graphOf(bases[0]), chain);
        break;
      }
      case "combine": {
        if (bases.length < 2) {
          this.limitations.push("ComposedStructureBuilder (combine): two base candidates are required.");
          return [];
        }
        const a = graphOf(bases[0]);
        const b = graphOf(bases[1]);
        outcome = combine(a, b, { id: `${a.id}+${b.id}`, label: `${a.label} + ${b.label}` });
        structure = `${bases[0].structure}+${bases[1].structure}`;
        parents = [bases[0].id, bases[1].id];
        break;
      }
      case "transformStraddleToStrangle": {
        if (!chain) {
          this.limitations.push("ComposedStructureBuilder (transformStraddleToStrangle): no chain snapshot available.");
          return [];
        }
        outcome = transformStraddleToStrangle(graphOf(bases[0]), chain);
        structure = "long_strangle";
        break;
      }
      case "repairVerticalToButterfly": {
        if (!chain) {
          this.limitations.push("ComposedStructureBuilder (repairVerticalToButterfly): no chain snapshot available.");
          return [];
        }
        const pnl =
          this.opts.currentPnlPerUnit ?? (requestField(input.request, "currentPnlPerUnit") as number | undefined);
        if (pnl === undefined) {
          this.limitations.push("ComposedStructureBuilder (repairVerticalToButterfly): currentPnlPerUnit is required (repair refuses non-losing positions).");
          return [];
        }
        outcome = repairVerticalToButterfly(graphOf(bases[0]), chain, { currentPnlPerUnit: pnl });
        structure = "butterfly";
        break;
      }
    }
    if (!outcome || !outcome.ok) {
      this.limitations.push(
        `ComposedStructureBuilder (${this.opts.operator}): ${outcome && !outcome.ok ? outcome.reason : "no outcome"}`,
      );
      return [];
    }
    const legs = optionLegsOf(outcome.graph);
    const spot = input.snapshot.underlyingPrice;
    let economics: StructureEconomics | null = null;
    if (spot !== undefined && spot > 0 && legs.length > 0) {
      try {
        economics = composedStructureEconomics(structure, legs, spot, [
          `Composed via ${this.opts.operator} from ${parents.join(" + ")} (strategyComposition leg-graph).`,
        ]);
      } catch (err) {
        this.limitations.push(
          `ComposedStructureBuilder (${this.opts.operator}): pricing failed — ${err instanceof Error ? err.message : String(err)}; economics left null.`,
        );
      }
    } else {
      this.limitations.push(
        `ComposedStructureBuilder (${this.opts.operator}): no spot price available; economics left null.`,
      );
    }
    const risk = analyzeRisk(outcome.graph);
    return [
      {
        id: outcome.graph.id,
        symbol: input.snapshot.symbol,
        structure,
        label: outcome.graph.label,
        legs,
        economics,
        status: economics ? "qualified" : "unverified",
        provenance: "composed",
        chainProvenance: input.snapshot.chainProvenance,
        definedRisk: risk.definedRisk,
        marginEstimate: risk.definedRisk && economics ? economics.maxLoss * 100 : null,
        assignmentRisk: risk.nearTermShortLegs.length > 0,
        gateReasons: [],
        limitations: [],
        rationale: `${outcome.graph.label} composed via ${this.opts.operator} from ${parents.join(" + ")}.`,
        builderId: this.id,
        source: outcome.graph,
      },
    ];
  }
}

export interface LlmContractDetail {
  symbol: string;
  expiration: string;
  contract: {
    optionType: "CALL" | "PUT";
    strikePrice: number;
    symbol: string;
    bid: number;
    ask: number;
    impliedVolatility?: number;
    volume?: number;
    openInterest?: number;
  };
}

export interface LlmGeneratorResponse {
  model?: string;
  answer: string;
  contractSymbols?: string[];
  contractDetails?: LlmContractDetail[];
}

/**
 * LlmIdeaBuilder — FIRST-CLASS, not deprecated. Takes an injected async
 * generator (never a real LLM call from this module, and never one in
 * tests). Each cited contract becomes one single-leg candidate; pricing
 * uses legMid from the snapshot's quotes, and a cited contract with no
 * usable quote yields economics null ⇒ Unverified, never fabricated.
 * Model + temperature are recorded in provenance.
 */
export class LlmIdeaBuilder implements CandidateBuilder {
  readonly id = "llm-idea";
  limitations: string[] = [];
  constructor(
    private readonly opts: {
      generateFn: (input: BuilderInput) => Promise<LlmGeneratorResponse>;
      model?: string;
      temperature?: number;
    },
  ) {}

  async build(input: BuilderInput): Promise<KernelCandidate[]> {
    this.limitations = [];
    const response: LlmGeneratorResponse = await this.opts.generateFn(input);
    // Accept the real RawOptionsIdeasResponse shape as well as the minimal stub shape.
    const details = (response.contractDetails ?? []) as LlmContractDetail[];
    if (details.length === 0) {
      this.limitations.push("LlmIdeaBuilder: generator cited no contract details; nothing mapped.");
      return [];
    }
    const out: KernelCandidate[] = [];
    for (const detail of details) {
      const symbol = detail.symbol;
      const snapshotQuote = input.snapshot.quotes?.[symbol];
      const bid = snapshotQuote?.bid ?? detail.contract.bid;
      const ask = snapshotQuote?.ask ?? detail.contract.ask;
      const hasQuote = bid > 0 && ask >= bid;
      const spot = input.snapshot.underlyingPrice;
      let economics: StructureEconomics | null = null;
      let leg: ResearchLeg | null = null;
      if (hasQuote) {
        const dte = Math.max(
          0,
          Math.ceil((Date.parse(detail.expiration) - Date.now()) / 86_400_000),
        );
        leg = {
          optionType: detail.contract.optionType === "CALL" ? "call" : "put",
          strike: detail.contract.strikePrice,
          expiry: detail.expiration,
          dte: Number.isFinite(dte) ? dte : 0,
          bid,
          ask,
          iv: snapshotQuote?.iv ?? detail.contract.impliedVolatility ?? null,
          volume: snapshotQuote?.volume ?? detail.contract.volume ?? null,
          openInterest: snapshotQuote?.openInterest ?? detail.contract.openInterest ?? null,
          quantity: 1,
          quoteTimestamp: Date.now(),
        };
        if (spot !== undefined && spot > 0) {
          const mid = legMid(leg);
          try {
            economics = composedStructureEconomics("llm_idea", [leg], spot, [
              `LLM idea priced from snapshot quote mid ${mid.toFixed(2)} for ${symbol} (researchEconomics grid).`,
            ]);
          } catch (err) {
            this.limitations.push(
              `LlmIdeaBuilder: pricing failed for ${symbol} — ${err instanceof Error ? err.message : String(err)}; economics left null.`,
            );
          }
        } else {
          this.limitations.push(`LlmIdeaBuilder: no spot price for ${symbol}; economics left null.`);
        }
      } else {
        this.limitations.push(
          `LlmIdeaBuilder: no quote for ${symbol} in snapshot; economics not computed (never fabricated).`,
        );
      }
      const legs = leg ? [leg] : [];
      const graph = legs.length > 0 ? graphFromResearchLegs({ id: `llm:${symbol}`, label: `LLM idea: ${symbol}`, source: "composed", legs }) : null;
      const risk = graph ? analyzeRisk(graph) : null;
      out.push({
        id: `llm:${symbol}`,
        symbol: input.snapshot.symbol,
        structure: "llm_idea",
        label: `LLM idea: ${symbol}`,
        legs,
        economics,
        status: economics ? "qualified" : "unverified",
        provenance: "llm",
        chainProvenance: input.snapshot.chainProvenance,
        definedRisk: risk ? risk.definedRisk : false,
        marginEstimate: risk && risk.definedRisk && economics ? economics.maxLoss * 100 : null,
        assignmentRisk: risk ? risk.nearTermShortLegs.length > 0 : false,
        gateReasons: [],
        limitations: hasQuote ? [] : [`No quote for ${symbol} in snapshot; economics not computed.`],
        rationale: response.answer || `LLM idea citing ${symbol}.`,
        builderId: this.id,
        model: response.model ?? this.opts.model,
        temperature: this.opts.temperature,
        source: detail,
      });
    }
    return out;
  }
}

// Re-exported for coordinator convenience: the real generator response shape
// is assignable to LlmGeneratorResponse (extra fields are ignored).
export type { RawOptionsIdeasResponse };

/* ------------------------------------------------------------------ */
/* Gates (Chain of Responsibility)                                     */
/* ------------------------------------------------------------------ */

export interface KernelGateContext {
  config?: ResearchConfig;
  now?: number;
  outlook?: Outlook;
  quote?: { price: number; timestamp: number; source: string };
  chain?: { underlyingPrice: number; asOf: number; provenance: ChainProvenance };
}

export interface GateEvaluation {
  cap?: IdeaStatus;
  reasons: string[];
}

export interface GateHandler {
  id: string;
  evaluate(candidate: KernelCandidate, ctx: KernelGateContext): GateEvaluation;
}

/**
 * StrategyRiskFitHandler: runs StrategyRiskAgent.screenStrategies over the
 * wrapped StrategyCandidates (injected screen function). Screening is
 * per-candidate in the original implementation, so a single-candidate
 * screen preserves D1 fit semantics exactly. Candidates without a wrapped
 * engine candidate are not fit-screened.
 */
export class StrategyRiskFitHandler implements GateHandler {
  readonly id = "strategy-risk-fit";
  constructor(
    private readonly opts: {
      screenFn: (
        candidates: StrategyCandidate[],
        filter?: StrategyScreenFilter,
      ) => { matched: StrategyCandidate[]; rejected: Array<{ id: string; reason: string }> };
      filter?: StrategyScreenFilter;
    },
  ) {}

  evaluate(candidate: KernelCandidate, _ctx: KernelGateContext): GateEvaluation {
    const source = candidate.source;
    if (!isWrappedEngineCandidate(source)) return { reasons: [] };
    const { rejected } = this.opts.screenFn([source], this.opts.filter);
    const hit = rejected.find((r) => r.id === source.id);
    return hit ? { cap: "rejected", reasons: [hit.reason] } : { reasons: [] };
  }
}

/**
 * ResearchGatesHandler: maps a KernelCandidate → GateCandidate and runs
 * runStageGates. Calibrated chainProvenance caps at Watchlist. Two
 * not-yet-staged failures are deferred to the price / falsify stages
 * instead of hard-rejecting: missing economics and missing falsification
 * evidence cap at Unverified (the later stages own those verdicts).
 */
export class ResearchGatesHandler implements GateHandler {
  readonly id = "research-gates";
  constructor(private readonly opts: { config?: ResearchConfig; now?: number } = {}) {}

  evaluate(candidate: KernelCandidate, ctx: KernelGateContext): GateEvaluation {
    const config = ctx.config ?? this.opts.config ?? RESEARCH_CONFIG_DEFAULTS;
    const now = ctx.now ?? this.opts.now ?? Date.now();
    const chain = ctx.chain ?? {
      underlyingPrice: ctx.quote?.price ?? 0,
      asOf: now,
      provenance: candidate.chainProvenance,
    };
    const outcome = runStageGates(
      {
        symbol: candidate.symbol,
        outlook: ctx.outlook ?? "unknown",
        thesis: candidate.rationale || candidate.label,
        quote: ctx.quote ?? null,
        chain,
        legs: candidate.legs,
        structure: candidate.structure,
        economics: candidate.economics,
        expectedMovePct: null,
        eventRisk: null,
        hasNearTermShortLeg: candidate.legs.some(
          (l) => l.quantity < 0 && l.dte <= (config.assignmentRiskDte ?? 7),
        ),
        sources: ["kernel"],
        limitations: candidate.limitations,
        falsificationPresent: Boolean(candidate.falsificationEvidence),
      },
      { config, now },
    );
    const failing = outcome.gateResults.filter((g) => !g.passed);
    const reasons = failing.flatMap((g) => g.reasons);
    if (outcome.rejectionReason) reasons.push(outcome.rejectionReason);
    if (outcome.status === "qualified") {
      // Calibrated chains can never qualify, even if the caller supplied
      // a live-looking chain object for a calibrated candidate.
      return candidate.chainProvenance === "calibrated"
        ? { cap: "watchlist", reasons: ["Chain is model-calibrated — watchlist-only."] }
        : { reasons: [] };
    }
    if (outcome.status === "watchlist") return { cap: "watchlist", reasons };
    if (outcome.status === "unverified") return { cap: "unverified", reasons };
    // Rejected — unless every failing gate is a deferred (price/falsify) gate.
    const deferred = failing.every((g) => {
      if (g.gate === "strategy_integrity") return g.reasons.some((r) => r.includes("Economics not computed"));
      if (g.gate === "risk_review") return g.reasons.some((r) => r.includes("No economics to review"));
      if (g.gate === "publication") return g.reasons.some((r) => r.includes("Falsification"));
      return false;
    });
    return { cap: deferred && failing.length > 0 ? "unverified" : "rejected", reasons };
  }
}

/** Panel configuration: D1 fit first, then the research gates. */
export function createPanelGateHandlers(input: {
  screenFn: (candidates: StrategyCandidate[], filter?: StrategyScreenFilter) => { matched: StrategyCandidate[]; rejected: Array<{ id: string; reason: string }> };
  strategyFilter?: StrategyScreenFilter;
  researchConfig?: ResearchConfig;
  now?: number;
}): GateHandler[] {
  return [
    new StrategyRiskFitHandler({ screenFn: input.screenFn, filter: input.strategyFilter }),
    new ResearchGatesHandler({ config: input.researchConfig, now: input.now }),
  ];
}

/** Research configuration: the research gates alone. */
export function createResearchGateHandlers(input: { config?: ResearchConfig; now?: number } = {}): GateHandler[] {
  return [new ResearchGatesHandler(input)];
}

/* ------------------------------------------------------------------ */
/* Ranking policies (Strategy)                                         */
/* ------------------------------------------------------------------ */

export interface RankingContext {
  request?: unknown;
  riskProfile?: RiskProfile;
}

export interface RankingPolicy {
  id: string;
  rank(candidates: KernelCandidate[], ctx: RankingContext): KernelCandidate[];
}

function withRank(candidates: KernelCandidate[], scoreOf: (c: KernelCandidate) => number): KernelCandidate[] {
  return candidates.map((c, i) => ({ ...c, score: scoreOf(c), rank: i + 1 }));
}

/**
 * RiskProfileComposite: wraps RecommendationAgent.rank over wrapped
 * StrategyCandidates (injected rank function). Candidates without a
 * wrapped engine candidate fall back to engineScore / status ordering
 * and never crash the run; a failing rank function falls back too.
 */
export class RiskProfileComposite implements RankingPolicy {
  readonly id = "risk-profile-composite";
  constructor(
    private readonly opts: {
      rankFn?: (
        candidates: StrategyCandidate[],
        request: { maxPlannedLoss: number; minRewardRisk: number },
        profile: RiskProfile,
      ) => RankedStrategy[];
    } = {},
  ) {}

  rank(candidates: KernelCandidate[], ctx: RankingContext): KernelCandidate[] {
    const request = ctx.request as { maxPlannedLoss?: unknown; minRewardRisk?: unknown } | undefined;
    const profile = ctx.riskProfile ?? "balanced";
    const composites = new Map<string, number>();
    const wrapped = candidates.filter((c) => isWrappedEngineCandidate(c.source));
    if (
      this.opts.rankFn &&
      typeof request?.maxPlannedLoss === "number" &&
      typeof request?.minRewardRisk === "number" &&
      wrapped.every((c) => typeof (c.source as StrategyCandidate).targetRewardRisk === "number")
    ) {
      try {
        for (const r of this.opts.rankFn(
          wrapped.map((c) => c.source as StrategyCandidate),
          { maxPlannedLoss: request.maxPlannedLoss as number, minRewardRisk: request.minRewardRisk as number },
          profile,
        )) {
          composites.set(r.candidate.id, r.compositeScore);
        }
      } catch {
        composites.clear();
      }
    }
    const sorted = [...candidates].sort((a, b) => {
      const sa = composites.get(a.id) ?? a.engineScore ?? 0;
      const sb = composites.get(b.id) ?? b.engineScore ?? 0;
      return sb - sa || tierOf(a.status) - tierOf(b.status) || a.id.localeCompare(b.id);
    });
    return sorted.map((c, i) => ({
      ...c,
      score: composites.get(c.id) ?? c.engineScore ?? 0,
      rank: i + 1,
    }));
  }
}

/** ScenarioGridRank: status tier, then scenario mean P&L descending. */
export class ScenarioGridRank implements RankingPolicy {
  readonly id = "scenario-grid";
  rank(candidates: KernelCandidate[], _ctx: RankingContext): KernelCandidate[] {
    const sorted = [...candidates].sort((a, b) => {
      const ma = a.scenario?.meanPnlTotal ?? Number.NEGATIVE_INFINITY;
      const mb = b.scenario?.meanPnlTotal ?? Number.NEGATIVE_INFINITY;
      return tierOf(a.status) - tierOf(b.status) || mb - ma || a.id.localeCompare(b.id);
    });
    return withRank(sorted, (c) => c.scenario?.meanPnlTotal ?? c.engineScore ?? 0);
  }
}

/** PerNameBestFit: status tier, then fitScore descending. */
export class PerNameBestFit implements RankingPolicy {
  readonly id = "per-name-best-fit";
  rank(candidates: KernelCandidate[], _ctx: RankingContext): KernelCandidate[] {
    const sorted = [...candidates].sort((a, b) => {
      const fa = a.fitScore ?? Number.NEGATIVE_INFINITY;
      const fb = b.fitScore ?? Number.NEGATIVE_INFINITY;
      return tierOf(a.status) - tierOf(b.status) || fb - fa || a.id.localeCompare(b.id);
    });
    return withRank(sorted, (c) => c.fitScore ?? 0);
  }
}

/** LlmRankPolicy (llm arm ONLY): orders by an injected LLM ranking over candidate ids. */
export class LlmRankPolicy implements RankingPolicy {
  readonly id = "llm-rank";
  constructor(private readonly opts: { orderFn: (ids: string[]) => string[] }) {}

  rank(candidates: KernelCandidate[], _ctx: RankingContext): KernelCandidate[] {
    const order = this.opts.orderFn(candidates.map((c) => c.id));
    const position = new Map(order.map((id, i) => [id, i]));
    const indexed = candidates.map((c, i) => ({ c, i }));
    indexed.sort((a, b) => {
      const pa = position.get(a.c.id) ?? Number.POSITIVE_INFINITY;
      const pb = position.get(b.c.id) ?? Number.POSITIVE_INFINITY;
      return pa - pb || a.i - b.i;
    });
    return indexed.map(({ c }, i) => ({
      ...c,
      score: position.has(c.id) ? candidates.length - (position.get(c.id) as number) : 0,
      rank: i + 1,
    }));
  }
}

/** LlmScorePolicy (hybrid arm ONLY): orders by injected LLM scores per candidate id. */
export class LlmScorePolicy implements RankingPolicy {
  readonly id = "llm-score";
  private readonly scoreFn: (id: string) => number | null | undefined;
  constructor(opts: {
    scores: Record<string, number> | ((id: string) => number | null | undefined);
  }) {
    const scores = opts.scores;
    this.scoreFn = typeof scores === "function" ? scores : (id: string) => scores[id];
  }

  rank(candidates: KernelCandidate[], _ctx: RankingContext): KernelCandidate[] {
    const scored = candidates.map((c) => ({ c, score: this.scoreFn(c.id) }));
    scored.sort((a, b) => {
      const sa = a.score ?? Number.NEGATIVE_INFINITY;
      const sb = b.score ?? Number.NEGATIVE_INFINITY;
      return sb - sa || tierOf(a.c.status) - tierOf(b.c.status) || a.c.id.localeCompare(b.c.id);
    });
    return scored.map(({ c, score }, i) => ({ ...c, score: score ?? 0, rank: i + 1 }));
  }
}

/**
 * WeightsRankDecorator (C5 seam): a Decorator over an already-ranked list.
 * Without a weights function it is a strict no-op (same reference). With
 * one, it reorders WITHIN each status tier only — never across tiers —
 * and reassigns ranks in tier order.
 */
export interface WeightsRankDecorator {
  id: string;
  decorate(ranked: KernelCandidate[], ctx: RankingContext): KernelCandidate[];
}

export class PassthroughWeightsRankDecorator implements WeightsRankDecorator {
  readonly id = "weights-passthrough";
  constructor(private readonly opts: { weightsFn?: (candidate: KernelCandidate) => number } = {}) {}

  decorate(ranked: KernelCandidate[], _ctx: RankingContext): KernelCandidate[] {
    if (!this.opts.weightsFn) return ranked;
    const weightsFn = this.opts.weightsFn;
    const byTier = new Map<number, KernelCandidate[]>();
    for (const c of ranked) {
      const tier = tierOf(c.status);
      byTier.set(tier, [...(byTier.get(tier) ?? []), c]);
    }
    const out: KernelCandidate[] = [];
    for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
      const group = [...(byTier.get(tier) ?? [])];
      group.sort((a, b) => weightsFn(b) - weightsFn(a));
      out.push(...group);
    }
    return out.map((c, i) => ({ ...c, rank: i + 1 }));
  }
}

/* ------------------------------------------------------------------ */
/* Template Method: RecommendationKernel                               */
/* ------------------------------------------------------------------ */

export interface KernelRunInput {
  snapshot: KernelSnapshot;
  request: unknown;
  gateContext?: Partial<KernelGateContext>;
  rankingContext?: RankingContext;
  legacy?: KernelDiscoveryResult["legacy"];
}

export interface KernelConfig {
  builders: CandidateBuilder[];
  gateHandlers: GateHandler[];
  rankingPolicy: RankingPolicy;
  weightsDecorator?: WeightsRankDecorator;
  snapshotLoader?: (input: KernelRunInput) => KernelSnapshot | Promise<KernelSnapshot>;
}

export class RecommendationKernel {
  constructor(private readonly config: KernelConfig) {}

  async run(input: KernelRunInput): Promise<KernelDiscoveryResult> {
    const snapshot = await this.loadSnapshotStage(input);
    const built = await this.buildCandidatesStage(input, snapshot);
    const gated = this.gateCandidatesStage(input, built.candidates, built.limitations);
    const priced = this.priceCandidatesStage(gated.survivors);
    const falsified = this.falsifyCandidatesStage(priced.survivors);
    const ranked = this.rankCandidatesStage(input, falsified.survivors);
    return this.assembleStage(input, snapshot, ranked, gated.rejected, {
      generated: built.candidates.length,
      gatePassed: gated.survivors.length,
      priced: priced.priced,
      falsified: falsified.falsified,
      ranked: ranked.length,
    }, built.limitations);
  }

  protected async loadSnapshotStage(input: KernelRunInput): Promise<KernelSnapshot> {
    try {
      const snapshot = this.config.snapshotLoader ? await this.config.snapshotLoader(input) : input.snapshot;
      if (!snapshot || !snapshot.symbol) {
        throw new Error("snapshot is missing (a symbol is required)");
      }
      return snapshot;
    } catch (err) {
      if (err instanceof KernelStageError) throw err;
      throw new KernelStageError(
        `loadSnapshot: failed to load snapshot — ${err instanceof Error ? err.message : String(err)}`,
        "loadSnapshot",
      );
    }
  }

  protected async buildCandidatesStage(
    input: KernelRunInput,
    snapshot: KernelSnapshot,
  ): Promise<{ candidates: KernelCandidate[]; limitations: string[] }> {
    const candidates: KernelCandidate[] = [];
    const limitations: string[] = [];
    for (const builder of this.config.builders) {
      let built: KernelCandidate[];
      try {
        built = await builder.build({ snapshot, request: input.request });
      } catch (err) {
        throw new KernelStageError(
          `buildCandidates: builder ${builder.id} failed — ${err instanceof Error ? err.message : String(err)}`,
          "buildCandidates",
        );
      }
      for (const c of built) {
        candidates.push({ ...c, gateReasons: [...c.gateReasons], limitations: [...c.limitations] });
      }
      if (builder.limitations?.length) limitations.push(...builder.limitations);
    }
    return { candidates, limitations };
  }

  protected gateCandidatesStage(
    input: KernelRunInput,
    candidates: KernelCandidate[],
    _limitations: string[],
  ): { survivors: KernelCandidate[]; rejected: KernelDiscoveryResult["rejected"] } {
    const gateCtx: KernelGateContext = {
      config: input.gateContext?.config ?? RESEARCH_CONFIG_DEFAULTS,
      now: input.gateContext?.now ?? Date.now(),
      outlook: input.gateContext?.outlook ?? outlookForThesis(requestField(input.request, "thesis")),
      quote: input.gateContext?.quote,
      chain: input.gateContext?.chain,
    };
    const survivors: KernelCandidate[] = [];
    const rejected: KernelDiscoveryResult["rejected"] = [];
    for (const candidate of candidates) {
      let tier = tierOf(candidate.status);
      const reasons: string[] = [];
      for (const handler of this.config.gateHandlers) {
        let evaluation: GateEvaluation;
        try {
          evaluation = handler.evaluate(candidate, gateCtx);
        } catch (err) {
          throw new KernelStageError(
            `gate: handler ${handler.id} failed on ${candidate.id} — ${err instanceof Error ? err.message : String(err)}`,
            "gate",
          );
        }
        if (evaluation.cap !== undefined) tier = Math.max(tier, tierOf(evaluation.cap));
        reasons.push(...evaluation.reasons);
      }
      // Calibrated provenance caps at Watchlist on every path, regardless
      // of which handlers ran (idempotent: max() with the watchlist tier).
      if (candidate.chainProvenance === "calibrated" && tier < STATUS_TIERS.watchlist) {
        tier = STATUS_TIERS.watchlist;
      }
      const status = statusOfTier(tier);
      if (status === "rejected") {
        rejected.push({
          id: candidate.id,
          structure: candidate.structure,
          reason: reasons.join(" ") || "Rejected by gate chain.",
        });
      } else {
        survivors.push({ ...candidate, status, gateReasons: [...candidate.gateReasons, ...reasons] });
      }
    }
    return { survivors, rejected };
  }

  protected priceCandidatesStage(candidates: KernelCandidate[]): { survivors: KernelCandidate[]; priced: number } {
    let priced = 0;
    const survivors = candidates.map((candidate) => {
      if (candidate.economics) {
        priced++;
        return candidate;
      }
      // Wrapped D1 candidates: map the engine's economics onto the kernel
      // contract (figures are the engine's, named as such — not recomputed).
      if (isWrappedEngineCandidate(candidate.source)) {
        const engine = candidate.source;
        const legs: StructureEconomics["legs"] = engine.legs
          .filter((l) => l.optionType !== "STOCK")
          .map((l) => ({
            optionType: (l.optionType === "CALL" ? "call" : "put") as "call" | "put",
            strike: l.strike,
            expiry: l.expirationDate,
            dte: l.daysToExpiration ?? 0,
            bid: l.bid,
            ask: l.ask,
            iv: l.impliedVolatility ?? null,
            volume: l.volume ?? null,
            openInterest: l.openInterest ?? null,
            quantity: (l.side === "BUY" ? 1 : -1) * l.quantity,
            quoteTimestamp: l.quoteTimestamp ? Date.parse(l.quoteTimestamp) : null,
            mid: (l.bid + l.ask) / 2,
          }));
        const economics: StructureEconomics = {
          structure: engine.type,
          legs,
          netDebit: Math.max(engine.netDebit, 0),
          netCredit: Math.max(-engine.netDebit, 0),
          maxLoss: engine.maxLoss,
          maxGain: engine.maxProfitUnbounded ? null : engine.maxProfit,
          breakevens: [...engine.breakevens],
          derivationNotes: [
            `Mapped from StrategyCandidate ${engine.id} engine economics (strategyEngine) by the RecommendationKernel price stage; not recomputed by the researchEconomics grid.`,
          ],
        };
        priced++;
        return { ...candidate, economics };
      }
      // Every other null-economics candidate stays null: the price stage
      // never invents a price.
      return candidate;
    });
    return { survivors, priced };
  }

  protected falsifyCandidatesStage(candidates: KernelCandidate[]): { survivors: KernelCandidate[]; falsified: number } {
    let falsified = 0;
    const survivors = candidates.map((candidate) => {
      const hasEvidence = Boolean(candidate.falsificationEvidence);
      const hasEconomics = candidate.economics !== null;
      if (hasEvidence && hasEconomics) {
        falsified++;
        return candidate;
      }
      if (candidate.status === "qualified" || candidate.status === "watchlist") {
        return {
          ...candidate,
          status: "unverified" as IdeaStatus,
          limitations: [
            ...candidate.limitations,
            `Demoted to unverified by the falsify stage: ${!hasEconomics ? "no economics" : "no falsification evidence"} (never silently qualified).`,
          ],
        };
      }
      return candidate;
    });
    return { survivors, falsified };
  }

  protected rankCandidatesStage(input: KernelRunInput, candidates: KernelCandidate[]): KernelCandidate[] {
    const rankingCtx: RankingContext = {
      request: input.request,
      ...(input.rankingContext ?? {}),
    };
    let ranked: KernelCandidate[];
    try {
      ranked = this.config.rankingPolicy.rank(candidates, rankingCtx);
    } catch (err) {
      throw new KernelStageError(
        `rank: policy ${this.config.rankingPolicy.id} failed — ${err instanceof Error ? err.message : String(err)}`,
        "rank",
      );
    }
    this.assertSameCandidateSet("rank", candidates, ranked);
    if (this.config.weightsDecorator) {
      try {
        ranked = this.config.weightsDecorator.decorate(ranked, rankingCtx);
      } catch (err) {
        throw new KernelStageError(
          `rank: weights decorator ${this.config.weightsDecorator.id} failed — ${err instanceof Error ? err.message : String(err)}`,
          "rank",
        );
      }
      this.assertSameCandidateSet("rank (weights decorator)", candidates, ranked);
    }
    return ranked;
  }

  private assertSameCandidateSet(stage: string, before: KernelCandidate[], after: KernelCandidate[]): void {
    const beforeIds = [...before.map((c) => c.id)].sort();
    const afterIds = [...after.map((c) => c.id)].sort();
    if (beforeIds.length !== afterIds.length || beforeIds.some((id, i) => id !== afterIds[i])) {
      throw new KernelStageError(
        `${stage} stage dropped or duplicated candidates (in ${beforeIds.length}, out ${afterIds.length}) — refusing a silent partial result.`,
        "rank",
      );
    }
  }

  protected assembleStage(
    input: KernelRunInput,
    snapshot: KernelSnapshot,
    ranked: KernelCandidate[],
    rejected: KernelDiscoveryResult["rejected"],
    attrition: KernelAttrition,
    limitations: string[],
  ): KernelDiscoveryResult {
    return {
      snapshot,
      candidates: ranked,
      rejected,
      attrition,
      limitations,
      ...(input.legacy ? { legacy: input.legacy } : {}),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Facade (GRASP Controller): RecommendationService                    */
/* ------------------------------------------------------------------ */

export interface PanelSnapshotData {
  symbol: string;
  contracts: ScreenedOptionContractItem[];
  dataSource: "live" | "calibrated-demo";
  screen?: unknown;
  rejections?: unknown;
  validationError?: string;
}

export interface PanelRiskAgent {
  buildStrategies: (contracts: ScreenedOptionContractItem[], request: StrategyRequest) => EngineBuildResult | Promise<EngineBuildResult>;
  screenStrategies: (
    candidates: StrategyCandidate[],
    filter?: StrategyScreenFilter,
  ) => { matched: StrategyCandidate[]; rejected: Array<{ id: string; reason: string }> };
  riskReport: (candidate: StrategyCandidate, request: Pick<StrategyRequest, "maxPlannedLoss">) => unknown;
}

export interface PanelRecommender {
  rank: (candidates: StrategyCandidate[], request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk">, profile?: RiskProfile) => RankedStrategy[];
  pickBestTrade: (
    candidates: StrategyCandidate[],
    request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk" | "thesis" | "symbol">,
    profile?: RiskProfile,
    alternatives?: number,
  ) => BestTradePick | ({ status: string } & Record<string, unknown>);
}

export interface PanelDiscoveryInput {
  dataAgent: { loadSnapshot: (params: unknown) => Promise<PanelSnapshotData> };
  riskAgent: PanelRiskAgent;
  recommender: PanelRecommender;
  request: StrategyRequest;
  strategyFilter?: StrategyScreenFilter;
  riskProfile?: RiskProfile;
  alternatives?: number;
}

export interface PanelDiscoveryResult extends KernelDiscoveryResult {
  ranked: RankedStrategy[];
  riskReports: unknown[];
  bestTrade: BestTradePick | ({ status: string } & Record<string, unknown>);
  screenedOut: Array<{ id: string; reason: string }>;
}

/**
 * discoverPanel: the D1 panel path re-implemented on the kernel. The
 * kernel run (fit + research gates, price, falsify, rank) produces the
 * candidate list; ranked / riskReports / bestTrade are then computed via
 * the injected riskAgent / recommender over the kernel-passed wrapped
 * candidates, exactly as the retired OptionsAgentPipeline adapter
 * did — so the panel route needs no engine imports. Note: panel candidates carry no research
 * quote or falsification evidence, so their kernel status lands
 * Unverified; the route-facing ranked / bestTrade output is unaffected.
 */
/**
 * Issue #3186 (step 3e): discoverPanel's post-snapshot block, extracted
 * into stage functions WITHOUT behavior change - same calls, same
 * order. discoverPanel itself becomes their composition, and the one
 * strategy pipeline's ports map one stage function per pipeline stage.
 * The kernel's own internals (build -> gate -> price -> rank ->
 * falsify) stay inside the screen stage; they are not pipeline stages.
 */

/** The enrich stage: KernelSnapshot construction from the loaded data (pure). */
export function buildPanelKernelSnapshot(data: PanelSnapshotData): KernelSnapshot {
  return {
    symbol: data.symbol,
    dataSource: data.dataSource,
    chainProvenance: data.dataSource === "calibrated-demo" ? "calibrated" : "live",
    contracts: data.contracts,
    underlyingPrice: data.contracts[0]?.underlyingPrice,
    screen: data.screen,
    rejections: data.rejections,
    validationError: data.validationError,
  };
}

/** The screen stage's artifact: kernel result + ranking, before risk. */
export interface PanelScreenArtifact {
  kernelResult: KernelDiscoveryResult;
  wrapped: StrategyCandidate[];
  ranked: RankedStrategy[];
  legacy: unknown;
  profile: RiskProfile;
}

/** The screen stage: kernel run + rank (same construction discoverPanel used). */
export async function runPanelScreen(
  snapshot: KernelSnapshot,
  input: PanelDiscoveryInput,
): Promise<PanelScreenArtifact> {
  const viewBuilder = new ViewStructureBuilder({
    buildFn: (contracts, request) => input.riskAgent.buildStrategies(contracts, request as StrategyRequest),
  });
  const kernel = new RecommendationKernel({
    builders: [viewBuilder],
    gateHandlers: createPanelGateHandlers({
      screenFn: (candidates, filter) => input.riskAgent.screenStrategies(candidates, filter),
      strategyFilter: input.strategyFilter,
    }),
    rankingPolicy: new RiskProfileComposite({
      rankFn: (candidates, request, profile) => input.recommender.rank(candidates, request, profile),
    }),
  });
  const profile = input.riskProfile ?? "balanced";
  const kernelResult = await kernel.run({
    snapshot,
    request: input.request,
    rankingContext: { request: input.request, riskProfile: profile },
  });
  const wrapped = kernelResult.candidates
    .map((c) => c.source)
    .filter((s): s is StrategyCandidate => isWrappedEngineCandidate(s));
  const rankedAll = input.recommender.rank(wrapped, input.request, profile);
  const limit = input.request.candidateLimit ?? rankedAll.length;
  const ranked = rankedAll.slice(0, limit);
  const last = viewBuilder.lastResult;
  return {
    kernelResult,
    wrapped,
    ranked,
    legacy: last
      ? { evaluations: last.evaluations, nameLedger: last.nameLedger, excluded: last.excluded, buildResult: last }
      : undefined,
    profile,
  };
}

/** The risk stage: one risk report per ranked candidate. */
export function panelRiskReports(
  ranked: RankedStrategy[],
  input: PanelDiscoveryInput,
): unknown[] {
  return ranked.map((r) => input.riskAgent.riskReport(r.candidate, input.request));
}

/** The shapeReport stage: best trade + PipelineResult assembly. */
export function assemblePanelResult(input: {
  screen: PanelScreenArtifact;
  riskReports: unknown[];
  panelInput: PanelDiscoveryInput;
}): PanelDiscoveryResult {
  const { screen, riskReports, panelInput } = input;
  const bestTrade = panelInput.recommender.pickBestTrade(
    screen.wrapped,
    panelInput.request,
    screen.profile,
    panelInput.alternatives ?? 3,
  );
  return {
    ...screen.kernelResult,
    ranked: screen.ranked,
    riskReports,
    bestTrade,
    screenedOut: screen.kernelResult.rejected.map((r) => ({ id: r.id, reason: r.reason })),
    legacy: screen.legacy as PanelDiscoveryResult["legacy"],
  };
}

export class RecommendationService {
  async discoverPanel(input: PanelDiscoveryInput): Promise<PanelDiscoveryResult> {
    // Issue #2599 (F7): the panel snapshot fetches the scanner's
    // near + extended DTE bands for this request's thesis and
    // wanted strategies, so LEAPS (365-550 DTE) and PMCC (180+
    // DTE far leg) contracts are in the fetched chain instead of
    // unreachable past the 0-90 default window. The request
    // itself is unchanged (same thesis, strategies, caps); only
    // the snapshot's fetch bands widen, via the panel band builder
    // (same rule as the scheduled scanner). The route's snapshot
    // adapter forwards the extra field to OptionsDataAgent, whose
    // SnapshotParams already carries expirationDteBands.
    const data = await input.dataAgent.loadSnapshot({
      ...input.request,
      expirationDteBands: buildPanelFetchDteBands({
        thesis: input.request.thesis,
        allowedStrategies: input.request.allowedStrategies,
        minDte: input.request.minDte,
        maxDte: input.request.maxDte,
      }),
    });
    const snapshot = buildPanelKernelSnapshot(data);
    const screen = await runPanelScreen(snapshot, input);
    const riskReports = panelRiskReports(screen.ranked, input);
    return assemblePanelResult({ screen, riskReports, panelInput: input });
  }

  /**
   * discoverForName: the D4 research configuration — CatalogFitBuilder
   * over an injected (deps/config-bound) discoverStrategiesForName, the
   * research gate chain alone, ScenarioGridRank. The caller may pass
   * gateQuote / gateChain so the kernel's re-gate sees the same quote
   * evidence the discovery run used; without them, candidates demote
   * to Unverified on missing-quote honesty rather than inheriting the
   * upstream tier.
   */
  async discoverForName(input: {
    discoverStrategiesForName: (opts: {
      symbol: string;
      outlook: Outlook;
      goalKind?: unknown;
      scenario?: unknown;
      now?: number;
    }) => Promise<DiscoveryForNameResult>;
    symbol: string;
    outlook: Outlook;
    goalKind?: unknown;
    scenario?: unknown;
    now?: number;
    gateQuote?: KernelGateContext["quote"];
    gateChain?: KernelGateContext["chain"];
  }): Promise<KernelDiscoveryResult> {
    const now = input.now ?? Date.now();
    const result = await input.discoverStrategiesForName({
      symbol: input.symbol,
      outlook: input.outlook,
      goalKind: input.goalKind,
      scenario: input.scenario,
      now,
    });
    const snapshot: KernelSnapshot = {
      symbol: input.symbol,
      dataSource: result.provenance === "calibrated" ? "calibrated-demo" : "live",
      chainProvenance: result.provenance ?? "live",
    };
    const kernel = new RecommendationKernel({
      builders: [new CatalogFitBuilder({ discoverFn: async () => result })],
      gateHandlers: createResearchGateHandlers(),
      rankingPolicy: new ScenarioGridRank(),
    });
    return kernel.run({
      snapshot,
      request: { symbol: input.symbol, outlook: input.outlook },
      gateContext: { outlook: input.outlook, quote: input.gateQuote, chain: input.gateChain, now },
    });
  }

  /**
   * discoverNamesForStrategy: Strategy→Names fits ranked by PerNameBestFit.
   * Fits are name rankings, not tradable structures, so they bypass the
   * structure gate chain (which would reject their empty leg sets);
   * their honesty rule is preserved instead: every missing fit component
   * is reported ABSENT on the candidate and was already excluded from
   * the discovery's fitScore — never estimated.
   */
  async discoverNamesForStrategy(input: {
    discoverNamesForStrategy: (opts: {
      structure?: string;
      outlook?: Outlook;
      symbols?: string[];
      universe?: string;
      goalKind?: unknown;
      now?: number;
    }) => Promise<{
      structure: string;
      ranked: NameFit[];
      rejected: Array<{ symbol: string; reason: string }>;
      limitations?: string[];
    }>;
    structure?: string;
    outlook?: Outlook;
    symbols?: string[];
    universe?: string;
    goalKind?: unknown;
    now?: number;
  }): Promise<KernelDiscoveryResult> {
    const result = await input.discoverNamesForStrategy({
      structure: input.structure,
      outlook: input.outlook,
      symbols: input.symbols,
      universe: input.universe,
      goalKind: input.goalKind,
      now: input.now,
    });
    const fits: KernelCandidate[] = result.ranked.map((fit) => {
      const absent = fit.missingComponents.map((c) => `Fit component ABSENT: ${c} (excluded from fitScore, never estimated).`);
      return {
        id: `fit:${fit.symbol}:${fit.structure}`,
        symbol: fit.symbol,
        structure: fit.structure,
        label: `${fit.symbol} fit for ${fit.structure}`,
        legs: [],
        // A null-economics fit maps to a null-economics kernel
        // candidate (Unverified at most via falsify) — never a
        // fabricated summary.
        economics: fit.economics
          ? {
              structure: fit.structure,
              legs: [],
              netDebit: fit.economics.netDebit,
              netCredit: fit.economics.netCredit,
              maxLoss: fit.economics.maxLoss,
              maxGain: fit.economics.maxGain,
              breakevens: [],
              derivationNotes: ["Mapped from NameFit economics summary; fit-level result, no structure legs."],
            }
          : null,
        status: fit.status,
        provenance: "quant",
        chainProvenance: fit.provenance,
        definedRisk: false,
        marginEstimate: null,
        assignmentRisk: false,
        gateReasons: [],
        limitations: [...absent],
        rationale: `${fit.symbol} fit for ${fit.structure} (fitScore ${fit.fitScore}).`,
        builderId: "name-fit",
        fitScore: fit.fitScore,
        // #1256: genuine falsification evidence from the discovery's
        // own gate + fit-component evaluation. Absent (undefined) ⇒
        // the falsify stage demotes the fit to unverified — the
        // invariant, not a gap.
        falsificationEvidence: fit.falsificationEvidence,
        source: fit,
      } satisfies KernelCandidate;
    });
    const snapshot: KernelSnapshot = {
      symbol: result.structure,
      dataSource: "live",
      chainProvenance: "live",
    };
    const kernel = new RecommendationKernel({
      builders: [{ id: "name-fit", build: () => fits }],
      gateHandlers: [],
      rankingPolicy: new PerNameBestFit(),
    });
    const kernelResult = await kernel.run({ snapshot, request: { structure: result.structure } });
    return {
      ...kernelResult,
      rejected: [
        ...kernelResult.rejected,
        ...result.rejected.map((r) => ({ id: r.symbol, structure: result.structure, reason: r.reason })),
      ],
      limitations: [...kernelResult.limitations, ...(result.limitations ?? [])],
    };
  }

  /**
   * discoverLlmIdeas (#1639, D8 — the kernel target for llmIdeas):
   * the standalone LLM configuration of the template method. Before
   * this slice, LlmIdeaBuilder ran only inside the 3-way comparison
   * arms (via comparisonRunner, pre-generated); this entry runs it
   * directly: LlmIdeaBuilder → research gate chain → price (snapshot
   * quotes, never fabricated) → falsify → generation-order ranking.
   * The generator is always injected — this module never calls an
   * LLM itself, and never in tests. Honesty, unchanged from every
   * other kernel path: the builder asserts no falsification evidence,
   * so the falsify stage lands priced LLM candidates at most
   * Unverified; an idea with no usable quote has no legs and is
   * rejected by the contract-integrity gate (recorded in rejected),
   * never carried as a candidate with invented economics. Ranking is generation order (LlmRankPolicy over the build
   * order) — the LLM's order is the ranking signal for this arm, and
   * no quant re-ranking overwrites it.
   */
  async discoverLlmIdeas(input: {
    snapshot: KernelSnapshot;
    request: unknown;
    generateFn: (input: BuilderInput) => Promise<LlmGeneratorResponse>;
    model?: string;
    temperature?: number;
    gateContext?: Partial<KernelGateContext>;
  }): Promise<KernelDiscoveryResult> {
    const builder = new LlmIdeaBuilder({
      generateFn: input.generateFn,
      model: input.model,
      temperature: input.temperature,
    });
    const kernel = new RecommendationKernel({
      builders: [builder],
      gateHandlers: createResearchGateHandlers(),
      rankingPolicy: new LlmRankPolicy({ orderFn: (ids) => ids }),
    });
    return kernel.run({
      snapshot: input.snapshot,
      request: input.request,
      gateContext: input.gateContext,
    });
  }

  /** Comparison runs delegate to the standalone runComparison. */
  async runComparison(input: ComparisonInput): Promise<ComparisonArtifact> {
    return runComparison(input);
  }
}

/* ------------------------------------------------------------------ */
/* 3-way comparison + outcome ledger                                   */
/* ------------------------------------------------------------------ */

export type ComparisonArm = "llm" | "quant" | "hybrid";

export interface ComparisonArmConfig {
  builders: CandidateBuilder[];
  rankingPolicy: RankingPolicy;
}

export interface ComparisonInput {
  snapshot: KernelSnapshot;
  request: unknown;
  gateHandlers: GateHandler[];
  arms: Record<ComparisonArm, ComparisonArmConfig>;
  gateContext?: Partial<KernelGateContext>;
  rankingContext?: RankingContext;
  weightsDecorator?: WeightsRankDecorator;
  ledgerSql?: ComparisonLedgerSink;
  runId?: string;
}

export interface ComparisonArtifact {
  runId: string;
  arms: Record<ComparisonArm, { attrition: KernelAttrition; ranked: KernelCandidate[] }>;
  overlap: {
    sharedStructures: string[];
    armUnique: Record<ComparisonArm, string[]>;
  };
  stats: {
    armRankedCounts: Record<ComparisonArm, number>;
    sharedStructureCount: number;
  };
}

/** Minimal SQL sink (a plain injectable function object, not DO storage). */
export interface ComparisonLedgerSink {
  exec: (query: string, ...args: unknown[]) => unknown;
}

/**
 * The ledger statements live in the data layer since #1976
 * step 4c (#2356): src/data/comparisonLedgerPorts.ts +
 * doSqliteComparisonLedgerAdapter.ts. These two functions are
 * the kernel's seam onto that port, kept so runComparison and
 * existing callers are unchanged.
 */
export function ensureComparisonLedgerTable(sql: ComparisonLedgerSink): void {
  new DoSqliteComparisonLedgerStore(sql as ComparisonLedgerSqlExecutor).ensureTable();
}

export function recordComparisonArmOutcome(
  sql: ComparisonLedgerSink,
  input: { runId: string; arm: ComparisonArm; candidate: KernelCandidate },
): void {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${input.runId}:${input.arm}:${input.candidate.id}:${Date.now()}`;
  new DoSqliteComparisonLedgerStore(sql as ComparisonLedgerSqlExecutor).recordOutcome({
    id,
    runId: input.runId,
    arm: input.arm,
    candidateId: input.candidate.id,
    structure: input.candidate.structure,
    symbol: input.candidate.symbol,
    status: input.candidate.status,
    provenance: input.candidate.provenance,
    createdAt: new Date().toISOString(),
  });
}

/**
 * runComparison: a run mode of the kernel. The three arms differ ONLY in
 * generator × scorer; every arm passes the SAME gate chain, pricing,
 * falsification, and assembly. `composed` is NOT an arm (it is a builder
 * technique / provenance value) — requesting one throws. The artifact
 * contains no winner field: arms accumulate ledger track records and are
 * evaluated later, on evidence, never by assertion.
 */
export async function runComparison(input: ComparisonInput): Promise<ComparisonArtifact> {
  const rawArms = input.arms as Record<string, ComparisonArmConfig | undefined>;
  if ("composed" in rawArms && rawArms.composed !== undefined) {
    throw new Error(
      "composed is not an arm: composed is a builder technique / provenance value, not a generator × scorer arm (arms are llm | quant | hybrid).",
    );
  }
  const armNames: ComparisonArm[] = ["llm", "quant", "hybrid"];
  const missing = armNames.filter((arm) => !rawArms[arm]);
  if (missing.length > 0) {
    throw new Error(`runComparison requires all three arms (llm, quant, hybrid); missing: ${missing.join(", ")}.`);
  }
  const runId =
    input.runId ?? `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const arms = {} as ComparisonArtifact["arms"];
  for (const arm of armNames) {
    const config = rawArms[arm] as ComparisonArmConfig;
    const kernel = new RecommendationKernel({
      builders: config.builders,
      gateHandlers: input.gateHandlers,
      rankingPolicy: config.rankingPolicy,
      weightsDecorator: input.weightsDecorator,
    });
    const result = await kernel.run({
      snapshot: input.snapshot,
      request: input.request,
      gateContext: input.gateContext,
      rankingContext: input.rankingContext,
    });
    arms[arm] = { attrition: result.attrition, ranked: result.candidates };
  }
  const structuresByArm = new Map<ComparisonArm, Set<string>>();
  for (const arm of armNames) {
    structuresByArm.set(arm, new Set(arms[arm].ranked.map((c) => c.structure)));
  }
  const allStructures = new Set([...structuresByArm.values()].flatMap((s) => [...s]));
  const sharedStructures: string[] = [];
  const armUnique = {} as Record<ComparisonArm, string[]>;
  for (const arm of armNames) {
    armUnique[arm] = [];
  }
  for (const structure of allStructures) {
    const holders = armNames.filter((arm) => structuresByArm.get(arm)?.has(structure));
    if (holders.length >= 2) sharedStructures.push(structure);
    else if (holders.length === 1) armUnique[holders[0]].push(structure);
  }
  sharedStructures.sort();
  for (const arm of armNames) armUnique[arm].sort();
  if (input.ledgerSql) {
    ensureComparisonLedgerTable(input.ledgerSql);
    for (const arm of armNames) {
      for (const candidate of arms[arm].ranked) {
        recordComparisonArmOutcome(input.ledgerSql, { runId, arm, candidate });
      }
    }
  }
  return {
    runId,
    arms,
    overlap: { sharedStructures, armUnique },
    stats: {
      armRankedCounts: {
        llm: arms.llm.ranked.length,
        quant: arms.quant.ranked.length,
        hybrid: arms.hybrid.ranked.length,
      },
      sharedStructureCount: sharedStructures.length,
    },
  };
}
