/**
 * Issue #1107 (Phase 1 of epic #1096) — Scenario/Goal engine.
 *
 * Turns the Phase 0 (#1098) goal/scenario records from inert storage
 * into a working engine, reusing the research stack per the epic §1.1
 * amendment — no parallel discovery subsystem:
 *
 *  - Taxonomy: the 9 GoalKinds map to a research Outlook and to the
 *    structure families that outlook admits. The mapping is GATE-TRUE
 *    by construction: admissibility is computed with researchGates'
 *    own `structureFamily()` against the same family lists the
 *    thesis-coherence gate uses, and tests run the real gate over
 *    every (kind, default structure) pair.
 *  - Scenarios: a typed shock grid (price × IV × time) + constraints,
 *    built with the effective ResearchConfig values snapshotted into
 *    the scenario (the researchConfig.ts snapshot idiom — every report
 *    in #319 embeds its config; a scenario does the same), persisted
 *    through the tenant-scoped Phase 0 goalScenarioStore.
 *  - Grid evaluation: every cell is priced by researchEconomics'
 *    `valueAtHorizon` — this module contains NO pricing engine of its
 *    own (pinned by a source test). Constraint verdicts distinguish
 *    pass / breach / not_evaluable; missing data never silently passes.
 *  - Auto-discovery: deterministic triggers over portfolio state,
 *    regime (the research pipeline's RegimeAssessment), events, and
 *    user intent produce PROPOSED goals with evidence — persisted
 *    source:"discovered", status:"proposed" for user confirmation.
 *    Discovery never activates a goal and never emits a trade.
 *    Missing event data follows the researchProviders pattern:
 *    getCatalysts() returns null because no catalyst feed is wired,
 *    and that absence is flagged as a limitation, never filled in.
 *
 * Discovery is hosted as a research-pipeline mode:
 * `runGoalScenarioDiscovery` consumes the existing ResearchDataProvider
 * seam from researchPipeline.ts (getRegime / getCatalysts) — the same
 * provider the research-agent (#319) runs its pipeline over.
 */

import {
  createGoal,
  createScenario,
  type GoalKind,
  type GoalRecord,
  type ScenarioRecord,
} from "./goalScenarioStore";
import {
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
} from "./researchConfig";
import { structureFamily, type Outlook } from "./researchGates";
import {
  valueAtHorizon,
  type StructureEconomics,
} from "./researchEconomics";
import type {
  CatalystInfo,
  RegimeAssessment,
  ResearchDataProvider,
} from "./researchPipeline";

/* ------------------------------------------------------------------ */
/* Goal taxonomy                                                       */
/* ------------------------------------------------------------------ */

export const GOAL_KINDS: readonly GoalKind[] = [
  "income",
  "directional",
  "volatility_event",
  "hedge_protect",
  "repair",
  "deconcentrate",
  "iv_harvest",
  "capital_efficient_leverage",
  "cash_secured_entry",
] as const;

export interface GoalTaxonomyEntry {
  kind: GoalKind;
  label: string;
  description: string;
  /** Primary research outlook this goal expresses. */
  outlook: Outlook;
  /** Gate-admissible structure families for that outlook. */
  families: string[];
  /** Concrete pipeline structure ids; each family's gate check must pass. */
  defaultStructures: string[];
}

/**
 * The gate's thesis-coherence compatibility (researchGates.ts):
 * bullish → vertical_spread, pmcc; bearish → vertical_spread;
 * range_bound → iron_condor, butterfly, pmcc; volatile → straddle,
 * strangle. Families below are exactly those lists per outlook, so a
 * taxonomy entry can only name families the gate itself admits.
 */
const FAMILIES_BY_OUTLOOK: Record<string, string[]> = {
  bullish: ["vertical_spread", "pmcc"],
  bearish: ["vertical_spread"],
  range_bound: ["iron_condor", "butterfly", "pmcc"],
  volatile: ["straddle", "strangle"],
  unknown: [],
};

export const GOAL_TAXONOMY: Record<GoalKind, GoalTaxonomyEntry> = {
  income: {
    kind: "income",
    label: "Income",
    description:
      "Generate premium income from range-bound structures (defined-risk credit structures by default).",
    outlook: "range_bound",
    families: FAMILIES_BY_OUTLOOK.range_bound,
    defaultStructures: ["iron_condor", "butterfly"],
  },
  directional: {
    kind: "directional",
    label: "Directional growth",
    description:
      "Express a directional view with defined-risk verticals (direction carried on the scenario).",
    outlook: "bullish",
    families: FAMILIES_BY_OUTLOOK.bullish,
    defaultStructures: ["bull_call_spread", "bull_put_spread"],
  },
  volatility_event: {
    kind: "volatility_event",
    label: "Volatility / event play",
    description:
      "Position for an outsized move (earnings, macro event) with long-volatility structures.",
    outlook: "volatile",
    families: FAMILIES_BY_OUTLOOK.volatile,
    defaultStructures: ["long_straddle", "long_strangle"],
  },
  hedge_protect: {
    kind: "hedge_protect",
    label: "Hedge / protect",
    description:
      "Reduce portfolio downside with a defined-risk bearish structure sized to the exposure.",
    outlook: "bearish",
    families: FAMILIES_BY_OUTLOOK.bearish,
    defaultStructures: ["bear_put_spread", "bear_call_spread"],
  },
  repair: {
    kind: "repair",
    label: "Repair a position",
    description:
      "Repair a losing or expiring position by converting it toward a range-bound structure (e.g. butterfly conversion) instead of averaging down blindly.",
    outlook: "range_bound",
    families: FAMILIES_BY_OUTLOOK.range_bound,
    defaultStructures: ["butterfly", "iron_condor"],
  },
  deconcentrate: {
    kind: "deconcentrate",
    label: "Reduce concentration",
    description:
      "Bring an outsized single-name exposure back inside policy with a protective defined-risk structure while an exit is staged.",
    outlook: "bearish",
    families: FAMILIES_BY_OUTLOOK.bearish,
    defaultStructures: ["bear_put_spread"],
  },
  iv_harvest: {
    kind: "iv_harvest",
    label: "Harvest elevated IV",
    description:
      "Sell elevated implied volatility with defined-risk range-bound structures while IV rank is high.",
    outlook: "range_bound",
    families: FAMILIES_BY_OUTLOOK.range_bound,
    defaultStructures: ["iron_condor", "butterfly"],
  },
  capital_efficient_leverage: {
    kind: "capital_efficient_leverage",
    label: "Capital-efficient leverage",
    description:
      "Leveraged upside participation with less capital than share ownership (PMCC-style), when enabled in config.",
    outlook: "bullish",
    families: FAMILIES_BY_OUTLOOK.bullish,
    defaultStructures: ["pmcc"],
  },
  cash_secured_entry: {
    kind: "cash_secured_entry",
    label: "Cash-secured entry",
    description:
      "Enter a name below market while being paid to wait. Gate-admissible form is the defined-risk bull put spread; the ownership form (cash_secured_put) additionally requires ownershipStrategiesAllowed in config.",
    outlook: "bullish",
    families: FAMILIES_BY_OUTLOOK.bullish,
    defaultStructures: ["bull_put_spread"],
  },
};

export function goalOutlook(kind: GoalKind): Outlook {
  return GOAL_TAXONOMY[kind].outlook;
}

/** Gate-truth check, computed with the gate's own family mapping. */
export function isStructureAdmissibleForGoal(kind: GoalKind, structure: string): boolean {
  return GOAL_TAXONOMY[kind].families.includes(structureFamily(structure));
}

/* ------------------------------------------------------------------ */
/* Scenario model + builder                                            */
/* ------------------------------------------------------------------ */

export interface ScenarioShockGrid {
  /** Underlying price shocks, in percent (e.g. -10 = −10%). */
  pricePct: number[];
  /** Relative IV shifts (e.g. -0.3 = −30% IV), as valueAtHorizon takes them. */
  ivShift: number[];
  /** Horizon offsets, in days forward. */
  daysForward: number[];
}

export interface ScenarioConstraints {
  /** Total budget for the scenario, in dollars. */
  budget?: number;
  /** Maximum acceptable loss over the grid, in dollars. */
  maxLoss?: number;
  /** Risk budget as a fraction of portfolio value (0–1). */
  riskBudgetPct?: number;
  /** Contracts assumed for total-P&L figures. */
  contracts?: number;
  dteWindow?: { min: number; max: number };
  liquidityFloor?: {
    minOpenInterest?: number;
    minVolume?: number;
    /** Max (ask−bid)/mid per leg, in percent. */
    maxSpreadPct?: number;
  };
}

/** The ResearchConfig values a scenario depends on, snapshotted at build time. */
export interface ScenarioConfigSnapshot {
  riskFreeRate: number;
  dividendYield: number;
  feePerContract: number;
  slippagePerContract: number;
  minDte: number;
  minOpenInterest: number;
  minOptionVolume: number;
  maxSpreadPct: number;
  assignmentRiskDte: number;
  rulesVersion: string;
}

export interface ScenarioDefinition {
  goalKind: GoalKind;
  /** Direction the scenario evaluates; defaults to the goal's outlook. */
  direction: Outlook;
  portfolioRef: { kind: "real" | "hypothetical"; ref?: string };
  shocks: ScenarioShockGrid;
  constraints: ScenarioConstraints;
  configSnapshot: ScenarioConfigSnapshot;
}

export const DEFAULT_SHOCK_GRID: ScenarioShockGrid = {
  pricePct: [-15, -7.5, 0, 7.5, 15],
  ivShift: [-0.3, 0, 0.25],
  daysForward: [0, 7, 30],
};

function snapshotConfig(config: ResearchConfig): ScenarioConfigSnapshot {
  return {
    riskFreeRate: config.riskFreeRate,
    dividendYield: config.dividendYield,
    feePerContract: config.feePerContract,
    slippagePerContract: config.slippagePerContract,
    minDte: config.minDte,
    minOpenInterest: config.minOpenInterest,
    minOptionVolume: config.minOptionVolume,
    maxSpreadPct: config.maxSpreadPct,
    assignmentRiskDte: config.assignmentRiskDte,
    rulesVersion: config.rulesVersion,
  };
}

export function buildScenario(input: {
  goalKind: GoalKind;
  portfolioRef: { kind: "real" | "hypothetical"; ref?: string };
  direction?: Outlook;
  shocks?: ScenarioShockGrid;
  constraints?: ScenarioConstraints;
  config?: ResearchConfig;
}): ScenarioDefinition {
  const config = input.config ?? RESEARCH_CONFIG_DEFAULTS;
  const taxonomy = GOAL_TAXONOMY[input.goalKind];
  return {
    goalKind: input.goalKind,
    direction: input.direction ?? taxonomy.outlook,
    portfolioRef: input.portfolioRef,
    shocks: input.shocks ?? {
      pricePct: [...DEFAULT_SHOCK_GRID.pricePct],
      ivShift: [...DEFAULT_SHOCK_GRID.ivShift],
      daysForward: [...DEFAULT_SHOCK_GRID.daysForward],
    },
    constraints: {
      contracts: 1,
      dteWindow: { min: config.minDte, max: 365 },
      liquidityFloor: {
        minOpenInterest: config.minOpenInterest,
        minVolume: config.minOptionVolume,
        maxSpreadPct: config.maxSpreadPct,
      },
      ...(input.constraints ?? {}),
    },
    configSnapshot: snapshotConfig(config),
  };
}

/**
 * Persist a built scenario through the Phase 0 store. The config
 * snapshot rides inside the stored constraints JSON (the store's
 * typed seam) so a stored scenario stays reproducible after the live
 * config changes — the researchConfig snapshot idiom.
 */
export function persistScenario(
  sql: any,
  input: { userLogin?: string; goalId: string; scenario: ScenarioDefinition; status?: string }
): ScenarioRecord | null {
  return createScenario(sql, {
    userLogin: input.userLogin,
    goalId: input.goalId,
    portfolioRef: input.scenario.portfolioRef,
    shocks: input.scenario.shocks,
    constraints: { ...input.scenario.constraints, configSnapshot: input.scenario.configSnapshot },
    status: input.status,
  });
}

/* ------------------------------------------------------------------ */
/* Scenario grid evaluation — priced ONLY by researchEconomics         */
/* ------------------------------------------------------------------ */

export interface ScenarioGridCell {
  pricePct: number;
  ivShift: number;
  daysForward: number;
  underlying: number;
  pnlPerUnit: number;
  pnlTotal: number;
}

export type ConstraintStatus = "pass" | "breach" | "not_evaluable";

export interface ConstraintVerdict {
  constraint: "max_loss" | "budget" | "dte_window" | "liquidity_floor";
  status: ConstraintStatus;
  detail: string;
}

export interface ScenarioGridResult {
  cells: ScenarioGridCell[];
  worst: ScenarioGridCell;
  best: ScenarioGridCell;
  verdicts: ConstraintVerdict[];
  /** True only when no verdict is a breach (not_evaluable does not pass silently — it is reported). */
  withinConstraints: boolean;
}

export function evaluateScenarioGrid(input: {
  economics: StructureEconomics;
  spot: number;
  /** #926: accepted but intentionally unused — the grid reprices from leg
   *  IVs, so a null (no chain IV) sigma must never be replaced by a
   *  constant here. */
  sigma: number | null;
  shocks: ScenarioShockGrid;
  constraints: ScenarioConstraints;
  config?: ResearchConfig;
}): ScenarioGridResult {
  const config = input.config ?? RESEARCH_CONFIG_DEFAULTS;
  const { economics: econ, spot, sigma, shocks } = input;
  const constraints = input.constraints;
  const contracts = constraints.contracts ?? 1;
  const perContractCost = config.feePerContract + config.slippagePerContract;

  const cells: ScenarioGridCell[] = [];
  for (const daysForward of shocks.daysForward) {
    for (const ivShift of shocks.ivShift) {
      for (const pricePct of shocks.pricePct) {
        const underlying = Math.max(spot * (1 + pricePct / 100), 0.01);
        const pnlPerUnit = valueAtHorizon(
          econ.legs,
          econ.netDebit,
          econ.netCredit,
          underlying,
          ivShift,
          daysForward / 365,
          config.riskFreeRate,
          config.dividendYield
        );
        const pnlTotal = pnlPerUnit * 100 * contracts - perContractCost * contracts;
        cells.push({
          pricePct,
          ivShift,
          daysForward,
          underlying: Number(underlying.toFixed(2)),
          pnlPerUnit: Number(pnlPerUnit.toFixed(2)),
          pnlTotal: Number(pnlTotal.toFixed(2)),
        });
      }
    }
  }
  const sorted = [...cells].sort((a, b) => a.pnlTotal - b.pnlTotal);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];

  const verdicts: ConstraintVerdict[] = [];

  // Max loss over the grid vs the stated max-loss constraint.
  if (constraints.maxLoss === undefined) {
    verdicts.push({
      constraint: "max_loss",
      status: "not_evaluable",
      detail: "No maxLoss constraint stated; worst grid cell is reported but not judged.",
    });
  } else {
    const loss = -worst.pnlTotal;
    verdicts.push({
      constraint: "max_loss",
      status: loss <= constraints.maxLoss ? "pass" : "breach",
      detail: `Worst grid cell loses $${loss.toFixed(2)} vs maxLoss $${constraints.maxLoss.toFixed(2)}.`,
    });
  }

  // Budget: capital at risk is the structure's contractual max loss
  // (researchEconomics) at the assumed contract count, plus costs.
  if (constraints.budget === undefined) {
    verdicts.push({
      constraint: "budget",
      status: "not_evaluable",
      detail: "No budget constraint stated.",
    });
  } else {
    const capitalAtRisk = econ.maxLoss * 100 * contracts + perContractCost * contracts;
    verdicts.push({
      constraint: "budget",
      status: capitalAtRisk <= constraints.budget ? "pass" : "breach",
      detail: `Capital at risk $${capitalAtRisk.toFixed(2)} (contractual max loss × ${contracts} contract(s) + costs) vs budget $${constraints.budget.toFixed(2)}.`,
    });
  }

  // DTE window: every leg's DTE must sit inside the window.
  if (!constraints.dteWindow) {
    verdicts.push({
      constraint: "dte_window",
      status: "not_evaluable",
      detail: "No DTE window stated.",
    });
  } else if (econ.legs.length === 0) {
    verdicts.push({
      constraint: "dte_window",
      status: "not_evaluable",
      detail: "Structure has no legs to check against the DTE window.",
    });
  } else {
    const { min, max } = constraints.dteWindow;
    const outside = econ.legs.filter((l) => l.dte < min || l.dte > max);
    verdicts.push({
      constraint: "dte_window",
      status: outside.length === 0 ? "pass" : "breach",
      detail:
        outside.length === 0
          ? `All ${econ.legs.length} legs within ${min}–${max} DTE.`
          : `${outside.length} leg(s) outside the ${min}–${max} DTE window.`,
    });
  }

  // Liquidity floor: per-leg OI / volume / spread where the data exists.
  const floor = constraints.liquidityFloor;
  if (!floor || (floor.minOpenInterest === undefined && floor.minVolume === undefined && floor.maxSpreadPct === undefined)) {
    verdicts.push({
      constraint: "liquidity_floor",
      status: "not_evaluable",
      detail: "No liquidity floor stated.",
    });
  } else {
    let breachDetail: string | null = null;
    let missing = false;
    for (const leg of econ.legs) {
      if (floor.minOpenInterest !== undefined) {
        if (leg.openInterest === null || leg.openInterest === undefined) missing = true;
        else if (leg.openInterest < floor.minOpenInterest)
          breachDetail = `Leg ${leg.optionType} ${leg.strike} OI ${leg.openInterest} < floor ${floor.minOpenInterest}.`;
      }
      if (floor.minVolume !== undefined) {
        if (leg.volume === null || leg.volume === undefined) missing = true;
        else if (leg.volume < floor.minVolume)
          breachDetail = `Leg ${leg.optionType} ${leg.strike} volume ${leg.volume} < floor ${floor.minVolume}.`;
      }
      if (floor.maxSpreadPct !== undefined) {
        const mid = (leg.bid + leg.ask) / 2;
        if (!(mid > 0)) missing = true;
        else if (((leg.ask - leg.bid) / mid) * 100 > floor.maxSpreadPct)
          breachDetail = `Leg ${leg.optionType} ${leg.strike} spread ${(((leg.ask - leg.bid) / mid) * 100).toFixed(1)}% of mid > floor ${floor.maxSpreadPct.toFixed(1)}%.`;
      }
      if (breachDetail) break;
    }
    if (breachDetail) {
      verdicts.push({ constraint: "liquidity_floor", status: "breach", detail: breachDetail });
    } else if (missing) {
      verdicts.push({
        constraint: "liquidity_floor",
        status: "not_evaluable",
        detail: "At least one leg is missing the quote data the floor requires; not judged as a pass.",
      });
    } else {
      verdicts.push({
        constraint: "liquidity_floor",
        status: "pass",
        detail: `All ${econ.legs.length} legs meet the liquidity floor.`,
      });
    }
  }

  return {
    cells,
    worst,
    best,
    verdicts,
    withinConstraints: !verdicts.some((v) => v.status === "breach"),
  };
}

/* ------------------------------------------------------------------ */
/* Auto-discovery                                                      */
/* ------------------------------------------------------------------ */

export interface DiscoveryThresholds {
  /** Single-name weight (fraction of portfolio) that breaches policy. */
  concentrationBreachPct: number;
  /** |net beta-weighted delta| as a fraction of portfolio value. */
  unhedgedDeltaPct: number;
  /** Option legs at/below this DTE are expiring (defaults to config assignmentRiskDte). */
  expiringLegDte: number;
  /** Unrealized P&L fraction at/below which a position is a repair candidate. */
  losingPositionPct: number;
  /** IV rank at/above which high vol is harvestable rather than an event play. */
  ivHarvestRank: number;
  /** Earnings/ex-div within this many days is an event trigger. */
  eventWindowDays: number;
}

export const DEFAULT_DISCOVERY_THRESHOLDS: DiscoveryThresholds = {
  concentrationBreachPct: 0.25,
  unhedgedDeltaPct: 0.2,
  expiringLegDte: RESEARCH_CONFIG_DEFAULTS.assignmentRiskDte,
  losingPositionPct: -0.15,
  ivHarvestRank: 70,
  eventWindowDays: 14,
};

export function discoveryThresholdsFromConfig(
  config: ResearchConfig,
  overrides?: Partial<DiscoveryThresholds>
): DiscoveryThresholds {
  return {
    ...DEFAULT_DISCOVERY_THRESHOLDS,
    expiringLegDte: config.assignmentRiskDte,
    ...(overrides ?? {}),
  };
}

export interface DiscoveryPosition {
  symbol: string;
  kind: "stock" | "option";
  /** Signed quantity (shares, or contracts for options). */
  quantity: number;
  marketValue: number;
  /** Beta-weighted dollar delta of this position, when known. */
  betaDelta?: number | null;
  /** Days to expiry for option positions. */
  dte?: number | null;
  expiry?: string | null;
  /** Unrealized P&L as a fraction of cost basis (e.g. -0.42), when known. */
  unrealizedPnlPct?: number | null;
}

export interface PortfolioDiscoveryState {
  totalValue: number;
  /** Net beta-weighted dollar delta across the portfolio, when known. */
  netBetaDelta: number | null;
  positions: DiscoveryPosition[];
}

export interface DiscoveredGoalProposal {
  kind: GoalKind;
  title: string;
  /** Stable trigger id, e.g. "portfolio.concentration_breach". */
  trigger: string;
  evidence: string[];
  limitations: string[];
  scenario: ScenarioDefinition;
}

function proposal(input: {
  kind: GoalKind;
  title: string;
  trigger: string;
  evidence: string[];
  limitations?: string[];
  direction?: Outlook;
  config?: ResearchConfig;
  portfolioRef?: { kind: "real" | "hypothetical"; ref?: string };
}): DiscoveredGoalProposal {
  return {
    kind: input.kind,
    title: input.title,
    trigger: input.trigger,
    evidence: input.evidence,
    limitations: input.limitations ?? [],
    scenario: buildScenario({
      goalKind: input.kind,
      portfolioRef: input.portfolioRef ?? { kind: "real" },
      direction: input.direction,
      config: input.config,
    }),
  };
}

export function discoverGoalsFromPortfolio(
  state: PortfolioDiscoveryState,
  thresholds: DiscoveryThresholds = DEFAULT_DISCOVERY_THRESHOLDS,
  config?: ResearchConfig
): DiscoveredGoalProposal[] {
  const proposals: DiscoveredGoalProposal[] = [];
  if (!(state.totalValue > 0)) return proposals;

  // Concentration: aggregate |market value| per symbol.
  const bySymbol = new Map<string, number>();
  for (const p of state.positions) {
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + Math.abs(p.marketValue));
  }
  for (const [symbol, value] of bySymbol) {
    const weight = value / state.totalValue;
    if (weight >= thresholds.concentrationBreachPct) {
      proposals.push(
        proposal({
          kind: "deconcentrate",
          title: `Reduce concentration in ${symbol}`,
          trigger: "portfolio.concentration_breach",
          evidence: [
            `${symbol} is ${(weight * 100).toFixed(1)}% of portfolio value ($${value.toFixed(2)} of $${state.totalValue.toFixed(2)}), at/above the ${(thresholds.concentrationBreachPct * 100).toFixed(0)}% policy threshold.`,
          ],
          config,
        })
      );
    }
  }

  // Unhedged delta.
  if (state.netBetaDelta !== null && state.netBetaDelta !== undefined) {
    const deltaPct = Math.abs(state.netBetaDelta) / state.totalValue;
    if (deltaPct >= thresholds.unhedgedDeltaPct) {
      proposals.push(
        proposal({
          kind: "hedge_protect",
          title: "Hedge unhedged portfolio delta",
          trigger: "portfolio.unhedged_delta",
          evidence: [
            `Net beta-weighted delta $${state.netBetaDelta.toFixed(2)} is ${(deltaPct * 100).toFixed(1)}% of portfolio value, at/above the ${(thresholds.unhedgedDeltaPct * 100).toFixed(0)}% unhedged threshold.`,
          ],
          config,
        })
      );
    }
  }

  // Expiring legs + losing positions.
  for (const p of state.positions) {
    if (p.kind === "option" && p.dte !== null && p.dte !== undefined && p.dte >= 0 && p.dte <= thresholds.expiringLegDte) {
      proposals.push(
        proposal({
          kind: "repair",
          title: `Manage expiring ${p.symbol} option leg`,
          trigger: "portfolio.expiring_leg",
          evidence: [
            `${p.symbol} option position (qty ${p.quantity}) expires in ${p.dte} day(s)${p.expiry ? ` (${p.expiry})` : ""}, within the ${thresholds.expiringLegDte}-day expiring window.`,
          ],
          config,
        })
      );
    }
    if (p.unrealizedPnlPct !== null && p.unrealizedPnlPct !== undefined && p.unrealizedPnlPct <= thresholds.losingPositionPct) {
      proposals.push(
        proposal({
          kind: "repair",
          title: `Repair losing ${p.symbol} position`,
          trigger: "portfolio.losing_position",
          evidence: [
            `${p.symbol} position is ${(p.unrealizedPnlPct * 100).toFixed(1)}% unrealized, at/below the ${(thresholds.losingPositionPct * 100).toFixed(0)}% repair threshold.`,
          ],
          config,
        })
      );
    }
  }

  return proposals;
}

export function discoverGoalsFromRegime(
  regime: RegimeAssessment,
  ivRank?: number | null,
  thresholds: DiscoveryThresholds = DEFAULT_DISCOVERY_THRESHOLDS,
  config?: ResearchConfig
): { proposals: DiscoveredGoalProposal[]; limitations: string[] } {
  const proposals: DiscoveredGoalProposal[] = [];
  const limitations: string[] = [];
  switch (regime.regime) {
    case "bull":
      proposals.push(
        proposal({
          kind: "directional",
          title: "Directional opportunity in a bull regime",
          trigger: "regime.trend",
          evidence: [`Regime assessed as bull (as of ${new Date(regime.asOf).toISOString()}).`, ...regime.notes],
          direction: "bullish",
          config,
        })
      );
      break;
    case "bear":
      proposals.push(
        proposal({
          kind: "directional",
          title: "Directional (bearish) opportunity in a bear regime",
          trigger: "regime.trend",
          evidence: [`Regime assessed as bear (as of ${new Date(regime.asOf).toISOString()}).`, ...regime.notes],
          direction: "bearish",
          config,
        })
      );
      break;
    case "chop":
      proposals.push(
        proposal({
          kind: "income",
          title: "Income opportunity in a range-bound regime",
          trigger: "regime.range_bound",
          evidence: [`Regime assessed as chop/range-bound (as of ${new Date(regime.asOf).toISOString()}).`, ...regime.notes],
          config,
        })
      );
      break;
    case "high_vol":
      if (ivRank === null || ivRank === undefined) {
        limitations.push(
          "IV rank unavailable — high-vol regime cannot be distinguished into IV harvest vs. event play; proposing the event/volatility goal."
        );
        proposals.push(
          proposal({
            kind: "volatility_event",
            title: "Volatility opportunity in a high-vol regime",
            trigger: "regime.high_vol",
            evidence: [`Regime assessed as high_vol (as of ${new Date(regime.asOf).toISOString()}).`, ...regime.notes],
            limitations: ["IV rank unavailable at discovery time."],
            config,
          })
        );
      } else if (ivRank >= thresholds.ivHarvestRank) {
        proposals.push(
          proposal({
            kind: "iv_harvest",
            title: "Harvest elevated implied volatility",
            trigger: "regime.high_vol_iv",
            evidence: [
              `Regime assessed as high_vol with IV rank ${ivRank.toFixed(0)}, at/above the ${thresholds.ivHarvestRank} harvest threshold.`,
              ...regime.notes,
            ],
            config,
          })
        );
      } else {
        proposals.push(
          proposal({
            kind: "volatility_event",
            title: "Volatility opportunity in a high-vol regime",
            trigger: "regime.high_vol",
            evidence: [
              `Regime assessed as high_vol with IV rank ${ivRank.toFixed(0)}, below the ${thresholds.ivHarvestRank} harvest threshold.`,
              ...regime.notes,
            ],
            config,
          })
        );
      }
      break;
    default:
      limitations.push("Regime could not be assessed (unknown) — no regime-based goal proposed.");
  }
  return { proposals, limitations };
}

export interface EventDiscoveryInput {
  symbol: string;
  /** From ResearchDataProvider.getCatalysts — null means NO feed is wired. */
  catalysts: CatalystInfo[] | null;
  /** Days to next earnings (eventCalendar.ts), when known. */
  earningsInDays?: number | null;
  /** Days to next ex-dividend date (eventCalendar.ts), when known. */
  exDivInDays?: number | null;
}

export function discoverGoalsFromEvents(
  events: EventDiscoveryInput[],
  thresholds: DiscoveryThresholds = DEFAULT_DISCOVERY_THRESHOLDS,
  config?: ResearchConfig
): { proposals: DiscoveredGoalProposal[]; limitations: string[] } {
  const proposals: DiscoveredGoalProposal[] = [];
  const limitations: string[] = [];
  for (const ev of events) {
    if (ev.catalysts === null) {
      // researchProviders pattern: no catalyst feed is wired on the
      // platform. Flag it per symbol — never invent catalysts.
      limitations.push(
        `Catalyst feed unavailable for ${ev.symbol} — catalyst-based discovery not evaluated (no feed is wired; nothing was fabricated).`
      );
    }
    if (ev.earningsInDays !== null && ev.earningsInDays !== undefined && ev.earningsInDays >= 0 && ev.earningsInDays <= thresholds.eventWindowDays) {
      proposals.push(
        proposal({
          kind: "volatility_event",
          title: `Event play into ${ev.symbol} earnings`,
          trigger: "event.earnings",
          evidence: [
            `${ev.symbol} earnings in ${ev.earningsInDays} day(s), inside the ${thresholds.eventWindowDays}-day event window.`,
          ],
          config,
        })
      );
    }
    if (ev.exDivInDays !== null && ev.exDivInDays !== undefined && ev.exDivInDays >= 0 && ev.exDivInDays <= thresholds.eventWindowDays) {
      proposals.push(
        proposal({
          kind: "income",
          title: `Income around ${ev.symbol} ex-dividend date`,
          trigger: "event.ex_dividend",
          evidence: [
            `${ev.symbol} ex-dividend date in ${ev.exDivInDays} day(s), inside the ${thresholds.eventWindowDays}-day event window.`,
          ],
          config,
        })
      );
    }
  }
  return { proposals, limitations };
}

/** Plain-language intent → goal kind (first match wins; null when none). */
const INTENT_PATTERNS: Array<{ kind: GoalKind; pattern: RegExp }> = [
  { kind: "cash_secured_entry", pattern: /cash[-\s]?secured/i },
  { kind: "capital_efficient_leverage", pattern: /pmcc|poor man|leaps|leverage/i },
  { kind: "repair", pattern: /repair|losing position|underwater/i },
  { kind: "deconcentrate", pattern: /concentrat|too much .* in|overweight/i },
  { kind: "hedge_protect", pattern: /hedge|protect|insurance|downside/i },
  { kind: "iv_harvest", pattern: /harvest|sell (premium|volatility)|iv (is )?(high|elevated)/i },
  { kind: "volatility_event", pattern: /earnings|event play|big move|straddle|strangle/i },
  { kind: "income", pattern: /income|premium income|covered call/i },
  { kind: "directional", pattern: /growth|bullish|bearish|directional|long call|long put/i },
];

export function goalKindForIntent(text: string): GoalKind | null {
  for (const { kind, pattern } of INTENT_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

/**
 * Discovery as a research-pipeline mode: runs over the pipeline's
 * ResearchDataProvider seam (regime + catalysts), the caller's
 * portfolio state, and caller-supplied event-calendar data. Returns
 * proposals only — persisting/confirming them is the caller's step,
 * and activation is always a separate human decision.
 */
export async function runGoalScenarioDiscovery(input: {
  provider: ResearchDataProvider;
  /**
   * Phase 3 (#1122): the portfolio state may be ABSENT — e.g. the
   * scheduled discovery run type in the research agent, which has no
   * portfolio seam. Portfolio triggers are then SKIPPED with the
   * limitation recorded; the portfolio is never assumed healthy.
   */
  portfolio: PortfolioDiscoveryState | null;
  symbols: string[];
  ivRank?: number | null;
  eventsBySymbol?: Record<string, { earningsInDays?: number | null; exDivInDays?: number | null }>;
  thresholds?: DiscoveryThresholds;
  config?: ResearchConfig;
}): Promise<{
  proposals: DiscoveredGoalProposal[];
  limitations: string[];
  regime: RegimeAssessment;
}> {
  const thresholds = input.thresholds ?? discoveryThresholdsFromConfig(input.config ?? RESEARCH_CONFIG_DEFAULTS);
  const limitations: string[] = [];

  const proposals = input.portfolio
    ? discoverGoalsFromPortfolio(input.portfolio, thresholds, input.config)
    : [];
  if (!input.portfolio) {
    limitations.push(
      "Portfolio state not supplied; portfolio discovery triggers (concentration, unhedged delta, expiring legs, repair) were skipped, not assumed healthy."
    );
  }

  const regime = await input.provider.getRegime();
  const fromRegime = discoverGoalsFromRegime(regime, input.ivRank ?? null, thresholds, input.config);
  proposals.push(...fromRegime.proposals);
  limitations.push(...fromRegime.limitations);

  const eventInputs: EventDiscoveryInput[] = [];
  for (const symbol of input.symbols) {
    const catalysts: CatalystInfo[] | null = await input.provider.getCatalysts(symbol);
    eventInputs.push({
      symbol,
      catalysts,
      earningsInDays: input.eventsBySymbol?.[symbol]?.earningsInDays ?? null,
      exDivInDays: input.eventsBySymbol?.[symbol]?.exDivInDays ?? null,
    });
  }
  const fromEvents = discoverGoalsFromEvents(eventInputs, thresholds, input.config);
  proposals.push(...fromEvents.proposals);
  limitations.push(...fromEvents.limitations);

  // Proposal-level limitations also surface at the run level.
  for (const p of proposals) limitations.push(...p.limitations);

  return { proposals, limitations, regime };
}

/**
 * Persist discovery proposals for one tenant. Every goal lands as
 * source:"discovered" / status:"proposed" with its trigger, evidence,
 * and limitations in the payload, and its scenario attached through
 * the Phase 0 store. There is deliberately no activation path here.
 */
export function persistDiscoveredGoals(
  sql: any,
  userLogin: string,
  proposals: DiscoveredGoalProposal[]
): GoalRecord[] {
  const created: GoalRecord[] = [];
  for (const p of proposals) {
    const goal = createGoal(sql, {
      userLogin,
      kind: p.kind,
      title: p.title,
      source: "discovered",
      status: "proposed",
      payload: { trigger: p.trigger, evidence: p.evidence, limitations: p.limitations },
    });
    persistScenario(sql, { userLogin, goalId: goal.id, scenario: p.scenario, status: "proposed" });
    created.push(goal);
  }
  return created;
}
