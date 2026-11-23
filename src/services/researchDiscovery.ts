/**
 * Issue #1114 (epic #1096 Phase 2) — bidirectional Name↔Strategy
 * discovery, hosted as a researchPipeline MODE.
 *
 * This is not a parallel pipeline: it consumes the pipeline's own
 * provider seam (`ResearchDataProvider`), its own structure builder
 * (`buildStructure` / `structuresForOutlook`, exported from
 * researchPipeline for this reuse), its gates (`researchGates`), its
 * pricing (`researchEconomics` via the composition gate), the
 * Phase 1 scenario engine (`goalScenarioEngine`) for ranking, the
 * research track record for strategy-on-name history, and
 * correlation estimates produced by `correlationService` (supplied
 * by the caller — this module fetches no price history).
 *
 *  - Strategy → Names: rank a universe by a fit score whose every
 *    component is named. A component whose data is missing (no
 *    catalyst feed, no track record, no correlation estimate) is
 *    reported ABSENT and excluded from the score — never estimated.
 *  - Name → Strategies: enumerate the full catalog registry
 *    (admissible / admissible-but-not-constructible / inadmissible
 *    are all recorded — researchBrowse pattern), build what the
 *    pipeline builder + composition algebra can construct, gate
 *    every candidate through the same quant gate, and rank by
 *    Phase 1 scenario-grid outcome.
 *
 * Provenance honesty survives: only `live` chains can produce
 * Qualified candidates; `calibrated` caps at Watchlist (enforced
 * inside the real gates, not re-implemented here).
 *
 * READ-ONLY: discovery never places, modifies, or cancels orders,
 * and never activates a goal — it returns ranked candidates.
 */

import {
  buildStructure,
  findLeg,
  pickExpiry,
  structuresForOutlook,
  toResearchLeg,
  type ChainSnapshot,
  type ResearchDataProvider,
} from "./researchPipeline";
import type { ResearchConfig } from "./researchConfig";
import { RESEARCH_CONFIG_DEFAULTS } from "./researchConfig";
import {
  structureFamily,
  type ChainProvenance,
  type IdeaStatus,
  type Outlook,
} from "./researchGates";
import type { ResearchLeg, StructureEconomics } from "./researchEconomics";
import {
  buildScenario,
  evaluateScenarioGrid,
  isStructureAdmissibleForGoal,
  type ScenarioDefinition,
} from "./goalScenarioEngine";
import type { GoalKind } from "./goalScenarioStore";
import type { TrackRecord } from "./researchTrackRecord";
import type { CorrelationEstimate } from "./correlationService";
import { defaultRegistry } from "../trading";
import type { OptionThesis } from "../trading";
import {
  gateComposedCandidate,
  graphFromResearchLegs,
  overlay,
  combine,
  transformStraddleToStrangle,
  repairVerticalToButterfly,
  type GatedCandidate,
  type StrategyGraph,
} from "./strategyComposition";

/* ------------------------------------------------------------------ */
/* Shared types                                                        */
/* ------------------------------------------------------------------ */

export interface DiscoveryCandidate {
  symbol: string;
  /** Dominant economics family / pipeline structure id used for gating. */
  structure: string;
  /** Full identity (hybrid names live here, e.g. "Iron Condor + Call Butterfly"). */
  label: string;
  source: "catalog" | "composed";
  operator?: string;
  legs: ResearchLeg[];
  /**
   * #1256 remainder — nullable: the kernel candidate contract allows
   * economics null (unpriced ⇒ Unverified, never fabricated), and the
   * discovery contract must be able to carry such a candidate back
   * from a kernel run instead of dropping it or inventing figures.
   * Every consumer must handle null explicitly (absent, never zero).
   */
  economics: StructureEconomics | null;
  status: IdeaStatus;
  provenance: ChainProvenance;
  definedRisk: boolean;
  marginEstimate: number | null;
  assignmentRisk: boolean;
  gateReasons: string[];
  limitations: string[];
  scenario: {
    worstPnlTotal: number;
    meanPnlTotal: number;
    bestPnlTotal: number;
    withinConstraints: boolean;
  };
}

export interface DiscoveryRejected {
  structure: string;
  reason: string;
}

export interface NameDiscoveryResult {
  symbol: string;
  outlook: Outlook;
  provenance: ChainProvenance;
  candidates: DiscoveryCandidate[];
  rejected: DiscoveryRejected[];
  /** Catalog ids admissible for the outlook that this phase cannot yet construct from a provider chain. */
  notConstructible: string[];
  /** Catalog ids the thesis gate does not admit for this outlook (counted, listed in full). */
  inadmissibleCatalogIds: string[];
  limitations: string[];
}

export type FitComponent =
  | "liquidity"
  | "ivFit"
  | "termStructureFit"
  | "earningsDistance"
  | "correlation"
  | "trackRecord";

export interface NameFit {
  symbol: string;
  structure: string;
  status: IdeaStatus;
  provenance: ChainProvenance;
  fitScore: number;
  components: Record<FitComponent, number | null>;
  missingComponents: FitComponent[];
  /**
   * #1256 remainder — nullable, mirroring DiscoveryCandidate: a fit
   * whose candidate carries no economics reports economics absent,
   * never a zero-filled summary.
   */
  economics: {
    netDebit: number;
    netCredit: number;
    maxLoss: number;
    maxGain: number | null;
  } | null;
  /**
   * #1256 — genuine falsification evidence for this fit, built by
   * buildFitFalsificationEvidence at discovery time from the fit's
   * own evaluated record (gate verdict + live chain/quote session +
   * evaluated components). Absent ⇒ the kernel's falsify stage
   * demotes the fit to unverified (never silently qualified).
   */
  falsificationEvidence?: string;
}

/**
 * #1256 — build genuine falsification evidence for a strategy→name
 * fit. This is NOT a placeholder: every element names an evaluation
 * that actually ran in discoverNamesForStrategy for this symbol —
 * the structure passed gateComposedCandidate (falsificationPresent)
 * against the live quote + chain, and the fit components were
 * computed from that same session. A ranked fit has passed every
 * falsifying condition the path checks (no quote, no chain,
 * unbuildable structure, gate rejection, null economics — each lands
 * the symbol in `rejected`, never in `ranked`), so the evidence
 * records those checks as evaluated-and-not-triggered, with their
 * inputs. Two fits with different evaluated records produce
 * different strings; a fit with no evaluated record carries no
 * evidence at all (undefined), and falsify demotes it.
 */
export function buildFitFalsificationEvidence(input: {
  symbol: string;
  structure: string;
  status: IdeaStatus;
  gateReasons: string[];
  chainAsOf: number;
  chainProvenance: ChainProvenance;
  quoteSource: string;
  components: Record<FitComponent, number | null>;
  missingComponents: FitComponent[];
  fitScore: number;
}): string {
  const evaluated = (Object.keys(input.components) as FitComponent[])
    .filter((k) => input.components[k] !== null)
    .map((k) => `${k}=${input.components[k]}`)
    .join(", ");
  const absent = input.missingComponents.length > 0 ? input.missingComponents.join(", ") : "none";
  return (
    `fit falsification (researchDiscovery: gateComposedCandidate falsificationPresent): ` +
    `${input.symbol} ${input.structure} gated ${input.status} on live chain asOf ${new Date(input.chainAsOf).toISOString()} (${input.chainProvenance}) + quote ${input.quoteSource}; ` +
    `components evaluated: ${evaluated}; absent (excluded from fitScore, never estimated): ${absent}; ` +
    `fitScore ${input.fitScore}; gate reasons: ${input.gateReasons.length > 0 ? input.gateReasons.join(" ") : "none"}; ` +
    `invalidation checked and not triggered: no-quote / no-chain / unbuildable-structure / gate-rejected / null-economics (symbol ranked, not rejected).`
  );
}

export interface StrategyDiscoveryResult {
  structure: string;
  ranked: NameFit[];
  rejected: Array<{ symbol: string; reason: string }>;
  limitations: string[];
}

export interface DiscoveryDeps {
  provider: ResearchDataProvider;
  /** Published-idea history (researchTrackRecord) — strategy-on-name evidence where available. */
  trackRecord?: TrackRecord;
  /** Portfolio correlation estimates from correlationService, keyed by symbol. */
  correlations?: Map<string, CorrelationEstimate>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const THESIS_FOR_OUTLOOK: Record<Outlook, OptionThesis | null> = {
  bullish: "bullish",
  bearish: "bearish",
  range_bound: "range_bound",
  volatile: "large_move",
  unknown: null,
};

/** Catalog registry ids each pipeline structure constructs (Phase 2 construction map). */
const CATALOG_IDS_BY_PIPELINE_STRUCTURE: Record<string, string[]> = {
  bull_call_spread: ["call_debit_spread"],
  bull_put_spread: ["put_credit_spread"],
  bear_put_spread: ["put_debit_spread"],
  bear_call_spread: ["call_credit_spread"],
  cash_secured_put: ["cash_secured_put"],
  iron_condor: ["iron_condor"],
  butterfly: ["long_call_butterfly"],
  long_straddle: ["long_straddle"],
  long_strangle: ["long_strangle"],
  pmcc: ["poor_mans_covered_call"],
};

const STATUS_RANK: Record<IdeaStatus, number> = {
  qualified: 0,
  watchlist: 1,
  unverified: 2,
  rejected: 3,
};

/** #926: nearest ATM chain IV, or null when no leg in the chain carries
 *  IV. Never a constant: a 0.4 fallback here previously fabricated an
 *  ivFit score (and scenario sigma) from zero chain data. */
function atmIv(chain: ChainSnapshot, spot: number): number | null {
  let best: { dist: number; iv: number } | null = null;
  for (const expiry of chain.expiries) {
    for (const leg of expiry.legs) {
      if (leg.iv == null) continue;
      const dist = Math.abs(leg.strike - spot);
      if (!best || dist < best.dist) best = { dist, iv: leg.iv };
    }
  }
  return best?.iv ?? null;
}

function expiryAtmIv(chain: ChainSnapshot, expiry: string, spot: number): number | null {
  const exp = chain.expiries.find((e) => e.expiry === expiry);
  if (!exp) return null;
  let best: { dist: number; iv: number } | null = null;
  for (const leg of exp.legs) {
    if (leg.iv == null) continue;
    const dist = Math.abs(leg.strike - spot);
    if (!best || dist < best.dist) best = { dist, iv: leg.iv };
  }
  return best?.iv ?? null;
}

function thesisFor(symbol: string, outlook: Outlook, structure: string): string {
  return `Discovery candidate for ${symbol}: ${structure} expressing a ${outlook} outlook, generated and gated by the research discovery mode.`;
}

interface BuiltCandidate {
  graph: StrategyGraph;
  structure: string;
  label: string;
  source: "catalog" | "composed";
  economicsOverride?: StructureEconomics;
}

function gateAndScore(input: {
  built: BuiltCandidate;
  symbol: string;
  outlook: Outlook;
  spot: number;
  provenance: ChainProvenance;
  now: number;
  config: ResearchConfig;
  scenario: ScenarioDefinition;
  /** #926: ATM chain IV, or null when the chain carries none. The scenario
   *  grid does not consume sigma (it reprices from leg IVs), so null is
   *  inert here — it must never be replaced by an assumed constant. */
  sigma: number | null;
  goalKind?: GoalKind;
  sources: string[];
}): { candidate?: DiscoveryCandidate; rejected?: DiscoveryRejected } {
  const { built } = input;
  if (input.goalKind && !isStructureAdmissibleForGoal(input.goalKind, built.structure)) {
    return {
      rejected: {
        structure: built.structure,
        reason: `Structure family ${structureFamily(built.structure)} is not admissible for goal ${input.goalKind} (Phase 1 goal gate).`,
      },
    };
  }
  const gated: GatedCandidate = gateComposedCandidate({
    graph: built.graph,
    structure: built.structure,
    symbol: input.symbol,
    outlook: input.outlook,
    thesis: thesisFor(input.symbol, input.outlook, built.structure),
    spot: input.spot,
    provenance: input.provenance,
    now: input.now,
    falsificationPresent: true,
    sources: input.sources,
    economicsOverride: built.economicsOverride,
    researchConfig: input.config,
  });
  if (gated.status === "rejected") {
    return {
      rejected: {
        structure: built.structure,
        reason: gated.reasons.join(" ") || "Rejected by the quant gate.",
      },
    };
  }
  const grid = evaluateScenarioGrid({
    economics: gated.economics,
    spot: input.spot,
    sigma: input.sigma,
    shocks: input.scenario.shocks,
    constraints: input.scenario.constraints,
    config: input.config,
  });
  const mean =
    grid.cells.reduce((sum, cell) => sum + cell.pnlTotal, 0) / Math.max(grid.cells.length, 1);
  return {
    candidate: {
      symbol: input.symbol,
      structure: built.structure,
      label: built.label,
      source: built.source,
      operator: built.graph.operator,
      legs: gated.economics.legs,
      economics: gated.economics,
      status: gated.status,
      provenance: input.provenance,
      definedRisk: gated.definedRisk,
      marginEstimate: gated.marginEstimate,
      assignmentRisk: gated.assignmentRisk,
      gateReasons: gated.reasons,
      limitations: gated.limitations,
      scenario: {
        worstPnlTotal: grid.worst.pnlTotal,
        meanPnlTotal: Number(mean.toFixed(2)),
        bestPnlTotal: grid.best.pnlTotal,
        withinConstraints: grid.withinConstraints,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Name → Strategies                                                   */
/* ------------------------------------------------------------------ */

export async function discoverStrategiesForName(
  deps: DiscoveryDeps,
  config: ResearchConfig = RESEARCH_CONFIG_DEFAULTS,
  opts: {
    symbol: string;
    outlook: Outlook;
    goalKind?: GoalKind;
    scenario?: ScenarioDefinition;
    now?: number;
    /** An existing losing vertical to repair into a butterfly candidate. */
    repairPosition?: { legs: ResearchLeg[]; currentPnlPerUnit: number };
  }
): Promise<NameDiscoveryResult> {
  const now = opts.now ?? Date.now();
  const symbol = opts.symbol.toUpperCase();
  const limitations: string[] = [];
  const base: NameDiscoveryResult = {
    symbol,
    outlook: opts.outlook,
    provenance: "unavailable",
    candidates: [],
    rejected: [],
    notConstructible: [],
    inadmissibleCatalogIds: [],
    limitations,
  };

  const quote = await deps.provider.getQuote(symbol);
  if (!quote) {
    limitations.push(`No quote available for ${symbol}; discovery cannot run — nothing was estimated.`);
    return base;
  }
  const chain = await deps.provider.getChain(symbol);
  if (!chain || chain.provenance === "unavailable" || chain.expiries.length === 0) {
    limitations.push(`No option chain available for ${symbol}; discovery cannot run — nothing was estimated.`);
    return base;
  }
  const spot = quote.price;
  const provenance = chain.provenance;
  const sigma = atmIv(chain, spot);
  const scenario =
    opts.scenario ??
    buildScenario({
      goalKind: opts.goalKind ?? "directional",
      portfolioRef: { kind: "hypothetical" },
      direction: opts.outlook,
      config,
    });
  const sources = [quote.source, "researchDiscovery"];

  const built: BuiltCandidate[] = [];
  const constructedCatalogIds = new Set<string>();

  // (a) Pipeline structures for the outlook — the pipeline's own builder.
  for (const name of structuresForOutlook(opts.outlook, config.ownershipStrategiesAllowed, config.pmccEnabled)) {
    const structure = buildStructure(name, chain, spot, config);
    if (!structure) continue;
    built.push({
      graph: graphFromResearchLegs({ id: name, label: name, source: "catalog", legs: structure.legs }),
      structure: name,
      label: name,
      source: "catalog",
      economicsOverride: structure.economics,
    });
    for (const id of CATALOG_IDS_BY_PIPELINE_STRUCTURE[name] ?? []) {
      constructedCatalogIds.add(id);
    }
  }

  // (b) Composed candidates from the composition algebra.
  if (opts.outlook === "range_bound") {
    // Short strangle (built with the pipeline's own leg pickers) → overlay wings.
    const expiry = pickExpiry(chain.expiries, config.minDte, 30, 45);
    if (expiry) {
      const shortPut = findLeg(expiry, "put", (s) => s < spot, spot);
      const shortCall = findLeg(expiry, "call", (s) => s > spot, spot);
      if (shortPut && shortCall) {
        const strangle = graphFromResearchLegs({
          id: "short_strangle",
          label: "Short Strangle",
          source: "catalog",
          legs: [toResearchLeg(shortPut, -1, chain.asOf), toResearchLeg(shortCall, -1, chain.asOf)],
        });
        const wrapped = overlay(strangle, chain);
        if (wrapped.ok) {
          built.push({
            graph: wrapped.graph,
            structure: "iron_condor",
            label: "Condor-Wrapped Strangle (short strangle + wings)",
            source: "composed",
          });
        }
      }
    }
    // Iron condor + call butterfly combine.
    const condor = built.find((b) => b.structure === "iron_condor" && b.source === "catalog");
    const butterfly = built.find((b) => b.structure === "butterfly");
    if (condor && butterfly) {
      const combined = combine(condor.graph, butterfly.graph, {
        id: "condor_plus_butterfly",
        label: "Iron Condor + Call Butterfly",
      });
      if (combined.ok) {
        built.push({
          graph: combined.graph,
          structure: "iron_condor",
          label: "Iron Condor + Call Butterfly",
          source: "composed",
        });
      }
    }
  }
  if (opts.outlook === "volatile") {
    const straddle = built.find((b) => b.structure === "long_straddle");
    if (straddle) {
      const widened = transformStraddleToStrangle(straddle.graph, chain);
      if (widened.ok) {
        built.push({
          graph: widened.graph,
          structure: "long_strangle",
          label: "Long Strangle (transformed from Long Straddle)",
          source: "composed",
        });
      }
    }
  }
  if (opts.repairPosition) {
    const position = graphFromResearchLegs({
      id: "current_position",
      label: "Current vertical position",
      source: "catalog",
      legs: opts.repairPosition.legs,
    });
    const repaired = repairVerticalToButterfly(position, chain, {
      currentPnlPerUnit: opts.repairPosition.currentPnlPerUnit,
    });
    if (repaired.ok) {
      built.push({
        graph: repaired.graph,
        structure: "butterfly",
        label: "Repaired Vertical → Butterfly",
        source: "composed",
      });
    } else {
      base.rejected.push({ structure: "butterfly", reason: `Repair refused: ${repaired.reason}` });
    }
  }

  // (c) Catalog enumeration: every registry id is accounted for.
  const thesis = THESIS_FOR_OUTLOOK[opts.outlook];
  for (const def of defaultRegistry.list()) {
    if (thesis && def.theses.includes(thesis)) {
      if (!constructedCatalogIds.has(def.id)) base.notConstructible.push(def.id);
    } else {
      base.inadmissibleCatalogIds.push(def.id);
    }
  }

  // (d) Gate + scenario-rank everything built.
  for (const candidate of built) {
    const outcome = gateAndScore({
      built: candidate,
      symbol,
      outlook: opts.outlook,
      spot,
      provenance,
      now,
      config,
      scenario,
      sigma,
      goalKind: opts.goalKind,
      sources,
    });
    if (outcome.candidate) base.candidates.push(outcome.candidate);
    if (outcome.rejected) base.rejected.push(outcome.rejected);
  }
  base.candidates.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.scenario.worstPnlTotal - a.scenario.worstPnlTotal ||
      b.scenario.meanPnlTotal - a.scenario.meanPnlTotal ||
      a.structure.localeCompare(b.structure)
  );
  base.provenance = provenance;
  if (provenance === "calibrated") {
    limitations.push("Chain is model-calibrated, not live: candidates cap at Watchlist.");
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Strategy → Names                                                    */
/* ------------------------------------------------------------------ */

const FIT_WEIGHTS: Record<FitComponent, number> = {
  liquidity: 0.3,
  ivFit: 0.25,
  termStructureFit: 0.15,
  earningsDistance: 0.1,
  correlation: 0.1,
  trackRecord: 0.1,
};

/** IV level each family "wants" (documented heuristic, not a forecast). */
const TARGET_IV_BY_FAMILY: Record<string, number> = {
  iron_condor: 0.4,
  butterfly: 0.4,
  straddle: 0.3,
  strangle: 0.3,
  vertical_spread: 0.3,
  pmcc: 0.3,
  ownership: 0.35,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export async function discoverNamesForStrategy(
  deps: DiscoveryDeps,
  config: ResearchConfig = RESEARCH_CONFIG_DEFAULTS,
  opts: {
    /** Pipeline structure id, a mapped catalog id, or "condor_wrapped_strangle". */
    structure: string;
    outlook: Outlook;
    symbols?: string[];
    universe?: string;
    goalKind?: GoalKind;
    now?: number;
  }
): Promise<StrategyDiscoveryResult> {
  const now = opts.now ?? Date.now();
  const limitations: string[] = [];
  const symbols = (
    opts.symbols ?? (await deps.provider.getUniverseSymbols(opts.universe ?? "discovery"))
  ).map((s) => s.toUpperCase());

  // Resolve a catalog id to its pipeline structure, when one exists.
  const pipelineStructure =
    CATALOG_IDS_BY_PIPELINE_STRUCTURE[opts.structure] !== undefined ||
    Object.values(CATALOG_IDS_BY_PIPELINE_STRUCTURE).flat().includes(opts.structure)
      ? (Object.entries(CATALOG_IDS_BY_PIPELINE_STRUCTURE).find(([, ids]) => ids.includes(opts.structure))?.[0] ??
        opts.structure)
      : opts.structure;

  const ranked: NameFit[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];

  for (const symbol of symbols) {
    const quote = await deps.provider.getQuote(symbol);
    if (!quote) {
      rejected.push({ symbol, reason: "No quote available; not scored (nothing estimated)." });
      continue;
    }
    const chain = await deps.provider.getChain(symbol);
    if (!chain || chain.provenance === "unavailable" || chain.expiries.length === 0) {
      rejected.push({ symbol, reason: "No option chain available; not scored (nothing estimated)." });
      continue;
    }
    const spot = quote.price;

    // Build + gate exactly the requested structure for this name.
    let built: BuiltCandidate | null = null;
    if (pipelineStructure === "condor_wrapped_strangle") {
      const expiry = pickExpiry(chain.expiries, config.minDte, 30, 45);
      const shortPut = expiry ? findLeg(expiry, "put", (s) => s < spot, spot) : null;
      const shortCall = expiry ? findLeg(expiry, "call", (s) => s > spot, spot) : null;
      if (shortPut && shortCall) {
        const strangle = graphFromResearchLegs({
          id: "short_strangle",
          label: "Short Strangle",
          source: "catalog",
          legs: [toResearchLeg(shortPut, -1, chain.asOf), toResearchLeg(shortCall, -1, chain.asOf)],
        });
        const wrapped = overlay(strangle, chain);
        if (wrapped.ok) {
          built = {
            graph: wrapped.graph,
            structure: "iron_condor",
            label: "Condor-Wrapped Strangle",
            source: "composed",
          };
        }
      }
    } else {
      const structure = buildStructure(pipelineStructure, chain, spot, config);
      if (structure) {
        built = {
          graph: graphFromResearchLegs({
            id: pipelineStructure,
            label: pipelineStructure,
            source: "catalog",
            legs: structure.legs,
          }),
          structure: pipelineStructure,
          label: pipelineStructure,
          source: "catalog",
          economicsOverride: structure.economics,
        };
      }
    }
    if (!built) {
      rejected.push({
        symbol,
        reason: `Structure ${opts.structure} could not be built from the available chain.`,
      });
      continue;
    }

    const scenario = buildScenario({
      goalKind: opts.goalKind ?? "directional",
      portfolioRef: { kind: "hypothetical" },
      direction: opts.outlook,
      config,
    });
    const outcome = gateAndScore({
      built,
      symbol,
      outlook: opts.outlook,
      spot,
      provenance: chain.provenance,
      now,
      config,
      scenario,
      sigma: atmIv(chain, spot),
      goalKind: opts.goalKind,
      sources: [quote.source, "researchDiscovery"],
    });
    if (!outcome.candidate) {
      rejected.push({
        symbol,
        reason: outcome.rejected?.reason ?? "Rejected by the quant gate.",
      });
      continue;
    }
    const candidate = outcome.candidate;
    if (!candidate.economics) {
      // gateAndScore always prices, so this is defensive: a
      // null-economics candidate cannot be fit-scored on legs — the
      // rejection is recorded visibly, never silently dropped.
      rejected.push({
        symbol,
        reason: "Economics unavailable — candidate cannot be fit-scored.",
      });
      continue;
    }
    const legs = candidate.economics.legs;

    /* Fit components — missing data stays missing. */
    const components: Record<FitComponent, number | null> = {
      liquidity: null,
      ivFit: null,
      termStructureFit: null,
      earningsDistance: null,
      correlation: null,
      trackRecord: null,
    };

    if (legs.length > 0) {
      const perLeg = legs.map((leg) => {
        const mid = (leg.bid + leg.ask) / 2;
        const spreadPct = mid > 0 ? ((leg.ask - leg.bid) / mid) * 100 : 100;
        return clamp01(
          0.5 * clamp01((leg.openInterest ?? 0) / (config.minOpenInterest * 4)) +
            0.3 * clamp01((leg.volume ?? 0) / (config.minOptionVolume * 4)) +
            0.2 * clamp01(1 - spreadPct / config.maxSpreadPct)
        );
      });
      components.liquidity = Number((perLeg.reduce((s, v) => s + v, 0) / perLeg.length).toFixed(4));
    }

    const family = structureFamily(candidate.structure);
    const targetIv = TARGET_IV_BY_FAMILY[family] ?? 0.35;
    const atm = atmIv(chain, spot);
    // #926: no chain IV means ivFit stays missing (excluded from the
    // fitScore by the missing-components rule below) — never a score
    // computed from an assumed 0.4.
    components.ivFit = atm == null
      ? null
      : Number(clamp01(1 - Math.abs(atm - targetIv) / targetIv).toFixed(4));

    if (chain.expiries.length >= 2) {
      const sorted = [...chain.expiries].sort((a, b) => a.dte - b.dte);
      const nearIv = expiryAtmIv(chain, sorted[0].expiry, spot);
      const farIv = expiryAtmIv(chain, sorted[sorted.length - 1].expiry, spot);
      if (nearIv != null && farIv != null) {
        components.termStructureFit = Number(clamp01(1 - Math.abs(farIv - nearIv) / 0.2).toFixed(4));
      }
    }

    const catalysts = await deps.provider.getCatalysts(symbol);
    if (catalysts === null) {
      limitations.push(`${symbol}: catalyst feed unavailable — earnings-distance component absent (not estimated).`);
    } else {
      const dated = catalysts
        .filter((c) => c.date && /earn/i.test(c.description))
        .map((c) => Math.floor((Date.parse(c.date as string) - now) / 86_400_000))
        .filter((days) => days >= 0)
        .sort((a, b) => a - b)[0];
      if (dated !== undefined) {
        components.earningsDistance = Number(clamp01(dated / 45).toFixed(4));
      }
    }

    const correlation = deps.correlations?.get(symbol);
    if (correlation && correlation.source !== "unknown" && correlation.value != null) {
      components.correlation = Number(clamp01(1 - Math.abs(correlation.value)).toFixed(4));
    }

    if (deps.trackRecord) {
      const rows = deps.trackRecord.ideas.filter(
        (idea) =>
          idea.symbol.toUpperCase() === symbol &&
          structureFamily(idea.structure) === family &&
          idea.evaluation != null
      );
      if (rows.length > 0) {
        const wins = rows.filter((idea) => (idea.evaluation!.pnlEstimatePerUnit ?? 0) > 0).length;
        components.trackRecord = Number((wins / rows.length).toFixed(4));
      }
    }

    const missingComponents = (Object.keys(components) as FitComponent[]).filter(
      (key) => components[key] === null
    );
    let weightSum = 0;
    let weighted = 0;
    for (const key of Object.keys(components) as FitComponent[]) {
      const value = components[key];
      if (value === null) continue;
      weightSum += FIT_WEIGHTS[key];
      weighted += FIT_WEIGHTS[key] * value;
    }
    const fitScore = weightSum > 0 ? Number((weighted / weightSum).toFixed(4)) : 0;

    ranked.push({
      symbol,
      structure: opts.structure,
      status: candidate.status,
      provenance: chain.provenance,
      fitScore,
      components,
      missingComponents,
      // #1256: genuine falsification evidence from this fit's own
      // evaluated record (gate verdict + live chain/quote session +
      // components) — the kernel's falsify stage keeps the tier only
      // on this evidence, never on assertion.
      falsificationEvidence: buildFitFalsificationEvidence({
        symbol,
        structure: opts.structure,
        status: candidate.status,
        gateReasons: candidate.gateReasons,
        chainAsOf: chain.asOf,
        chainProvenance: chain.provenance,
        quoteSource: quote.source,
        components,
        missingComponents,
        fitScore,
      }),
      // Null economics carries through as null (fitScore comes from
      // components, not economics) — never a zero-filled summary.
      economics: candidate.economics
        ? {
            netDebit: candidate.economics.netDebit,
            netCredit: candidate.economics.netCredit,
            maxLoss: candidate.economics.maxLoss,
            maxGain: candidate.economics.maxGain,
          }
        : null,
    });
  }

  ranked.sort((a, b) => b.fitScore - a.fitScore || a.symbol.localeCompare(b.symbol));
  return { structure: opts.structure, ranked, rejected, limitations };
}

/* ------------------------------------------------------------------ */
/* One entry, both directions (the discovery mode)                     */
/* ------------------------------------------------------------------ */

export type DiscoveryModeRequest =
  | {
      direction: "name_to_strategies";
      symbol: string;
      outlook: Outlook;
      goalKind?: GoalKind;
      scenario?: ScenarioDefinition;
      now?: number;
      repairPosition?: { legs: ResearchLeg[]; currentPnlPerUnit: number };
    }
  | {
      direction: "strategy_to_names";
      structure: string;
      outlook: Outlook;
      symbols?: string[];
      universe?: string;
      goalKind?: GoalKind;
      now?: number;
    };

export type DiscoveryModeResult =
  | { direction: "name_to_strategies"; result: NameDiscoveryResult }
  | { direction: "strategy_to_names"; result: StrategyDiscoveryResult };

export async function runDiscoveryMode(
  deps: DiscoveryDeps,
  config: ResearchConfig = RESEARCH_CONFIG_DEFAULTS,
  request: DiscoveryModeRequest
): Promise<DiscoveryModeResult> {
  if (request.direction === "name_to_strategies") {
    return {
      direction: "name_to_strategies",
      result: await discoverStrategiesForName(deps, config, request),
    };
  }
  return {
    direction: "strategy_to_names",
    result: await discoverNamesForStrategy(deps, config, request),
  };
}
