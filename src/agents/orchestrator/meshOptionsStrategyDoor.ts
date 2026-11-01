/**
 * Issue #2581 — the mesh options-strategy door: the chat turn's
 * options strategy screen, owned by the orchestrator's door
 * layer and built WITHOUT NLQ.
 *
 * The gap (owner report 2026-10-31): "Screen the NASDAQ100 for
 * bull put credit spreads where my max loss is no more than $30
 * and my max profit is greater than $0" was deflected to the UI
 * ("Workflow 2: Options Strategy Discovery & Greeks") because
 * the only programmatic path to the options strategy engine was
 * the NLQ `options_opportunities` action, and NLQ is flagged
 * off the chat turn (CHAT_NLQ_MODE, #2488). The mesh door
 * family ended at run_stock_screen (#2488). This module is the
 * options counterpart of meshScreenDoor.ts: a door-layer
 * service that assembles the SAME structured filters the NLQ
 * parser assembles from prose and calls the SAME engine seam
 * the NLQ action dispatches to —
 * runOptionsStrategyAction (src/agents/nlqOptionsStrategy.ts),
 * action "options_opportunities" — over a caller-independent
 * ETradeService composed for the acting login. No strategy
 * math is reimplemented here, nothing routes through NLQ, and
 * NLQ / CHAT_NLQ_MODE are untouched.
 *
 * Carriage: DIRECT RETURN, deliberately unlike the stock
 * screen door's workflow job carriage. The engine seam's own
 * shape is a single awaited call that scans its symbol batch
 * inline (bounded by the scanner's MAX_SCAN_SYMBOLS) and
 * returns the complete ranked result — the NLQ chat path calls
 * it inline in a turn the same way. There is no workflow, job,
 * or read-back behind it to await; inventing one would change
 * the engine's carriage, not mirror it.
 *
 * Structured contract (the engine's own field names):
 *   - universe: a registry universe id (src/trading/
 *     universes.ts), resolved to its symbol batch through the
 *     listings seam (fetchAllUsStockListings + resolveUniverse,
 *     capped at the universe's defaultMaxSymbols — the
 *     screener-agent composition) and handed to the engine as
 *     an explicit { kind: "symbols" } scope. "ALL" is refused:
 *     it is a sharded stock-screen fan-out, and this scan is a
 *     single engine call over one batch.
 *   - strategyType: a strategy catalog id, label, or alias,
 *     resolved against the engine's own catalog
 *     (defaultRegistry.resolveMany — "Bull Put Credit Spread"
 *     resolves to put_credit_spread). Unknown → a coded
 *     invalid_strategy_type refusal before any engine call.
 *     Absent → the parser's own default, ["all"].
 *   - maxLoss → the scan template's maxPlannedLoss (the
 *     engine's risk cap; parser default 500).
 *   - minProfit → the screen filter's minMaxProfit (the engine
 *     keeps candidates whose max profit is at least the floor;
 *     a strictly-positive requirement is a positive floor).
 *   - minRewardRisk, minDte/maxDte, riskProfile, thesis,
 *     minProbabilityOfProfit, requireFresh ride the same-named
 *     engine fields, with the parser's scan defaults where the
 *     parser has them (minRewardRisk 1.5, DTE 14–60, balanced).
 *     The thesis defaults to the resolved strategy's catalog
 *     thesis (put_credit_spread → bullish), the parser's
 *     detectThesis fallback otherwise.
 *
 * Results: the engine seam's own result, returned in the
 * engine's own ranking order (the door never re-ranks), plus
 * the constraint echo. An empty scan is the engine's honest
 * "no_opportunities" payload — a normal result, never an
 * error and never a deflection. Scan-run persistence stays
 * the NLQ caller's layer (its deps thread a store); this door
 * supplies no store, so no scanRunId is claimed.
 *
 * Identity is fail-closed (the door discipline, #1185):
 * requireActingLogin refuses a missing, blank, or synthetic
 * ("default") acting login BEFORE any service is composed —
 * ETradeService itself refuses a missing login, and the scan
 * deps carry the same login for run ownership. The login
 * arrives from the tool context's actingLogin carrier, never
 * from tool arguments (the input carries no identity field).
 */

import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import {
  UNIVERSES,
  defaultRegistry,
  resolveUniverse,
  type OptionThesis,
  type RiskProfile,
  type UniverseId,
} from "../../trading";
import { fetchAllUsStockListings } from "../../services/nasdaqListings";
import { ETradeService } from "../../services/etrade";
import {
  runOptionsStrategyAction,
  type OptionsStrategyIntent,
} from "../nlqOptionsStrategy";
import { MeshDoorError, requireActingLogin } from "./meshDoors";
import type { McpToolContext } from "../../patterns/interfaces";

/* ------------------------------------------------------------------ */
/* Input + result                                                      */
/* ------------------------------------------------------------------ */

/** The door command's structured input (never an identity field). */
export interface MeshOptionsStrategyDoorInput {
  /**
   * The universe to screen — one of the registry universe ids
   * (src/trading/universes.ts). Absent → NASDAQ100 (the route
   * default, as in the stock screen door). "ALL" is refused
   * (see the header).
   */
  universe?: string;
  /**
   * The strategy to screen for: a catalog id, label, or alias
   * from the engine's strategy catalog (e.g. "put_credit_spread"
   * or "Bull Put Credit Spread"). Absent → every strategy.
   */
  strategyType?: string;
  /** Max loss cap in dollars → the engine's maxPlannedLoss. */
  maxLoss?: number;
  /** Max-profit floor in dollars → the engine's minMaxProfit screen filter. */
  minProfit?: number;
  /** Reward/risk scoring floor → the engine's minRewardRisk. */
  minRewardRisk?: number;
  /** Scan thesis; absent → the resolved strategy's catalog thesis. */
  thesis?: string;
  /** Ranking posture → the engine's riskProfile. */
  riskProfile?: string;
  /** Expiry window bounds → the engine's minDte / maxDte. */
  minDte?: number;
  maxDte?: number;
  /** Probability-of-profit floor (0–1) → the engine's minProbabilityOfProfit screen filter. */
  minProbabilityOfProfit?: number;
  /** Fresh-quotes-only → the engine's requireFresh screen filter. */
  requireFresh?: boolean;
}

/** The constraint echo the door returns alongside the engine result. */
export interface MeshOptionsStrategyConstraints {
  universe: string;
  strategyTypes: string[];
  maxLoss: number;
  minProfit?: number;
}

/** The engine seam's result, plus the door's universe + constraint echo. */
export type MeshOptionsStrategyScreenResult =
  Awaited<ReturnType<typeof runOptionsStrategyAction>> & {
    universe: string;
    constraints: MeshOptionsStrategyConstraints;
  };

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Binding-seam overrides for the door service. Production
 * contexts supply NONE of these: every seam then composes from
 * `env` / `orm` exactly as the platform composition roots
 * compose theirs. Tests (and only tests) populate them through
 * the executor-shaped tool context (McpToolContext's
 * meshOptionsStrategyDoorSeams carrier) to fake the binding
 * seams — the engine seam itself, the listings seam, and the
 * ETradeService composition (the programme's acceptance rule:
 * fakes only at binding seams).
 */
export interface MeshOptionsStrategyDoorSeams {
  /**
   * The engine seam. Absent → runOptionsStrategyAction
   * (src/agents/nlqOptionsStrategy.ts), the callable the NLQ
   * options_opportunities action dispatches to.
   */
  runOptionsStrategy?: typeof runOptionsStrategyAction;
  /**
   * Universe → symbol batch. Absent → the listings seam
   * (fetchAllUsStockListings + resolveUniverse, capped at the
   * universe's defaultMaxSymbols).
   */
  resolveUniverseSymbols?: (universe: UniverseId) => Promise<string[]>;
  /**
   * The E*TRADE facade composition. Absent → a new
   * ETradeService(orm, env, actingLogin) per call — the same
   * composition the NLQ execution layer builds (execution.ts).
   */
  createEtradeService?: (actingLogin: string) => ETradeService;
}

/** Everything runOptionsStrategyScreenViaDoor receives from its context owner. */
export interface MeshOptionsStrategyDoorContext extends MeshOptionsStrategyDoorSeams {
  /** The worker env — the E*TRADE composition root. */
  env: Env;
  /** The executing context's ORM — the ETradeService's data root. */
  orm: DatabaseORM;
  /**
   * The executing context's DO blob storage handle, threaded
   * into the ETradeService composition as the NLQ execution
   * layer threads its own. Absent → the service's outcome-only
   * capture contract.
   */
  storage?: McpToolContext["storage"];
}

/**
 * Build the production door context out of a tool context: env,
 * the ORM and storage the executor carries, and whatever
 * binding seams the context carries (production contexts carry
 * none).
 */
export function meshOptionsStrategyDoorContextFromMcp(
  context: McpToolContext,
): MeshOptionsStrategyDoorContext {
  return {
    env: context.env,
    orm: context.orm,
    storage: context.storage,
    ...(context.meshOptionsStrategyDoorSeams ?? {}),
  };
}

/* ------------------------------------------------------------------ */
/* The door operation                                                  */
/* ------------------------------------------------------------------ */

/* The NLQ scan's standing defaults (parseOptionsStrategyIntent):
 * the door assembles the same template shape from structured
 * input, so a door screen and the equivalent NLQ question are
 * judged by the engine under the same caps. */
const DEFAULT_MAX_PLANNED_LOSS = 500;
const DEFAULT_MIN_REWARD_RISK = 1.5;
const DEFAULT_MIN_DTE = 14;
const DEFAULT_MAX_DTE = 60;

const THESES: readonly OptionThesis[] = ["bullish", "bearish", "range_bound", "large_move"];
const RISK_PROFILES: readonly RiskProfile[] = ["conservative", "balanced", "aggressive"];

/**
 * Run one chat options strategy screen through the mesh door:
 * identity gate → catalog + universe validation → engine seam
 * (direct return). Throws MeshDoorError (coded, honest) for
 * every refusal, each raised before any engine call; the
 * engine's own outcomes — ranked candidates or the honest
 * no_opportunities empty — return as results.
 */
export async function runOptionsStrategyScreenViaDoor(
  ctx: MeshOptionsStrategyDoorContext,
  actingLogin: string | undefined | null,
  input: MeshOptionsStrategyDoorInput,
): Promise<MeshOptionsStrategyScreenResult> {
  const login = requireActingLogin(actingLogin);

  const rawUniverse = typeof input.universe === "string" ? input.universe.trim() : "";
  let universeId: UniverseId = "NASDAQ100";
  if (rawUniverse) {
    if (!(rawUniverse in UNIVERSES) || rawUniverse === "ALL") {
      throw new MeshDoorError(
        "door_unavailable",
        `run_options_strategy_screen: universe "${rawUniverse}" is not a scannable universe — the door takes the registry universe set ` +
          `(${Object.keys(UNIVERSES).filter((u) => u !== "ALL").join(", ")}); "ALL" is a sharded stock-screen fan-out and this scan is a single engine call over one symbol batch. Refusing rather than guessing.`,
      );
    }
    universeId = rawUniverse as UniverseId;
  }

  // Strategy validation against the engine's own catalog: an
  // id, label, or alias resolves to its canonical id set (a
  // generic alias may name several); anything else refuses
  // here, before any service is composed or chain is fetched.
  let strategyIds: string[] = ["all"];
  if (typeof input.strategyType === "string" && input.strategyType.trim()) {
    const { ids, unknown } = defaultRegistry.resolveMany([input.strategyType.trim()]);
    if (unknown.length > 0 || ids.length === 0) {
      throw new MeshDoorError(
        "invalid_strategy_type",
        `run_options_strategy_screen: unknown strategy type "${input.strategyType}" — the door takes a strategy from the engine's catalog ` +
          `(an id, label, or alias, e.g. "put_credit_spread" / "Bull Put Credit Spread"). Refusing before any engine call.`,
      );
    }
    strategyIds = ids;
  }
  const isAll = strategyIds.length === 1 && strategyIds[0] === "all";

  const thesis = resolveThesis(input.thesis, isAll ? undefined : strategyIds[0]);
  const riskProfile = resolveRiskProfile(input.riskProfile);
  const minDte = positiveIntOr(input.minDte, DEFAULT_MIN_DTE);
  const maxDte = positiveIntOr(input.maxDte, DEFAULT_MAX_DTE);
  const maxLoss = positiveNumberOr(input.maxLoss, DEFAULT_MAX_PLANNED_LOSS);
  const minRewardRisk = nonNegativeNumberOr(input.minRewardRisk, DEFAULT_MIN_REWARD_RISK);

  const resolveSymbols =
    ctx.resolveUniverseSymbols ?? defaultResolveUniverseSymbols;
  const symbols = await resolveSymbols(universeId);
  if (symbols.length === 0) {
    throw new MeshDoorError(
      "door_unavailable",
      `run_options_strategy_screen: universe "${universeId}" resolved to no symbols from the listings directory — no scan can run over an empty batch. Refusing rather than reporting a fabricated empty result.`,
    );
  }

  const strategyFilter: OptionsStrategyIntent["filters"]["strategyFilter"] = {
    ...(isAll ? {} : { strategyTypes: strategyIds }),
    ...(input.minProfit !== undefined && Number.isFinite(input.minProfit)
      ? { minMaxProfit: input.minProfit }
      : {}),
    ...(input.minProbabilityOfProfit !== undefined &&
    Number.isFinite(input.minProbabilityOfProfit)
      ? { minProbabilityOfProfit: input.minProbabilityOfProfit }
      : {}),
    ...(input.requireFresh !== undefined ? { requireFresh: input.requireFresh } : {}),
  };
  const filters: OptionsStrategyIntent["filters"] = {
    request: {
      thesis,
      targetDate: new Date(Date.now() + maxDte * 86_400_000).toISOString().slice(0, 10),
      expectedIvDirection: "unchanged",
      maxPlannedLoss: maxLoss,
      minRewardRisk,
      minDte,
      maxDte,
      maxQuoteAgeSeconds: 60,
      contractLimit: 500,
      candidateLimit: 10,
      maxStrikesPerSide: 12,
      maxIronCondors: 100,
      eventPolicy: "warn",
      allowedStrategies: strategyIds,
    },
    riskProfile,
    strategyFilter,
    targetPriceInferred: false,
    thesisInferred: input.thesis === undefined,
    scope: { kind: "symbols", symbols },
    mode: "per_name_best",
  };

  const etrade = (ctx.createEtradeService ?? defaultCreateEtradeService(ctx))(login);
  const run = ctx.runOptionsStrategy ?? runOptionsStrategyAction;
  const result = await run(etrade, "options_opportunities", filters, {
    userLogin: login,
  });

  const constraints: MeshOptionsStrategyConstraints = {
    universe: universeId,
    strategyTypes: strategyIds,
    maxLoss,
    ...(input.minProfit !== undefined && Number.isFinite(input.minProfit)
      ? { minProfit: input.minProfit }
      : {}),
  };
  return { ...result, universe: universeId, constraints };
}

/** The listings-seam default: the screener-agent composition (resolveUniverse over the live directory, capped at the universe's default size). */
async function defaultResolveUniverseSymbols(universe: UniverseId): Promise<string[]> {
  const listings = await fetchAllUsStockListings();
  const resolved = resolveUniverse(universe, listings);
  const cap = UNIVERSES[universe].defaultMaxSymbols;
  const selected = cap > 0 ? resolved.slice(0, cap) : resolved;
  return selected.map((l) => l.symbol);
}

function defaultCreateEtradeService(
  ctx: MeshOptionsStrategyDoorContext,
): (actingLogin: string) => ETradeService {
  return (actingLogin: string) =>
    new ETradeService(ctx.orm, ctx.env, actingLogin, undefined, ctx.storage);
}

/**
 * The scan thesis: an explicit door input wins; otherwise the
 * resolved strategy's own catalog thesis (its first declared
 * thesis); otherwise the parser's fallback, bullish. An
 * unrecognized explicit value refuses rather than guessing.
 */
function resolveThesis(raw: string | undefined, firstStrategyId: string | undefined): OptionThesis {
  if (raw !== undefined) {
    const value = raw.trim() as OptionThesis;
    if (!THESES.includes(value)) {
      throw new MeshDoorError(
        "door_unavailable",
        `run_options_strategy_screen: unknown thesis "${raw}" — the door takes one of ${THESES.join(", ")}. Refusing rather than guessing.`,
      );
    }
    return value;
  }
  if (firstStrategyId) {
    const def = defaultRegistry.get(firstStrategyId);
    if (def && def.theses.length > 0) return def.theses[0];
  }
  return "bullish";
}

function resolveRiskProfile(raw: string | undefined): RiskProfile {
  if (raw === undefined) return "balanced";
  const value = raw.trim() as RiskProfile;
  if (!RISK_PROFILES.includes(value)) {
    throw new MeshDoorError(
      "door_unavailable",
      `run_options_strategy_screen: unknown riskProfile "${raw}" — the door takes one of ${RISK_PROFILES.join(", ")}. Refusing rather than guessing.`,
    );
  }
  return value;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
