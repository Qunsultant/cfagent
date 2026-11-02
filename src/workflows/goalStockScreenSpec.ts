/**
 * Issue #2882 (under #2764) — goal stock leg translated to
 * StockScreenRunSpec / broker / planner.
 *
 * The goal stock leg (goalDrivenScreen.buildGoalScreenPlan)
 * derives a stock filter from a scenario: momentum from the
 * outlook (bullish -> bullish_breakout, bearish ->
 * bearish_pullback, volatile -> high_relative_volume,
 * range_bound/unknown -> any), merged with the caller's base
 * stock filter. Scenario constraints (dteWindow,
 * liquidityFloor) map to OPTIONS fields only and never leak
 * into the stock filter — this translation preserves that
 * boundary by copying the plan's stockFilter verbatim.
 *
 * What this translation is, and what it is not:
 *   - It IS the canonical record of the goal stock leg: a
 *     source "goal" spec (deliver false, provider unset,
 *     universe "ALL", asyncRequested false, delivery {}),
 *     carrying goal provenance (goalKind, outlook,
 *     structures) as a reference, never flattened into
 *     the filter.
 *   - "ALL" records that goal legs are not universe-scoped
 *     (the registry provider screens its listings feed).
 *     It is not a coverage claim.
 *   - It is NOT an execution reroute: goal execution stays
 *     in goalDrivenScreen + goal dispatch. The broker
 *     returns null for goal specs (it never starts a
 *     screener workflow for them), and goal delivery stays
 *     goal-owned. The planner mapping below is the
 *     canonical coordinates of the leg (sector precedence,
 *     universe ALL, planner-default provider as the
 *     would-apply default — NOT the leg's actual provider,
 *     which stays in the goal result's provider /
 *     providerFallback fields).
 * No order placement, no options-leg change, no screening
 * semantics change: the filter is copied, never recomputed.
 */

import type { GoalScreenPlan } from "../services/goalDrivenScreen";
import type { StockScreenRunSpec } from "./stockScreenRunSpec";
import {
  planStockScreenRun,
  type StockScreenPlan,
} from "./stockScreenPlanner";

/** Translate a goal plan's stock leg to its canonical run spec. Pure: the filter is copied verbatim. */
export function goalStockSpecFromPlan(plan: GoalScreenPlan): StockScreenRunSpec {
  return {
    source: "goal",
    deliver: false,
    filters: { ...plan.stockFilter },
    universe: "ALL",
    asyncRequested: false,
    delivery: {},
    goal: {
      goalKind: plan.goalKind,
      outlook: plan.outlook,
      structures: [...plan.structures],
    },
  };
}

/** True when a spec is a goal stock-leg spec. The broker guard keys on this. */
export function isGoalStockSpec(spec: StockScreenRunSpec): boolean {
  return spec.source === "goal";
}

/**
 * Planner coordinates for a goal stock-leg spec: sector
 * precedence (filter sector, else ALL), universe ALL, trigger
 * as given. The returned plan's provider is the planner
 * default (etrade) — the would-apply default, not the leg's
 * actual provider (goal-owned; see module header).
 */
export function planGoalStockLeg(
  spec: StockScreenRunSpec,
  trigger: "manual" | "scheduled",
  timestamp: string,
): StockScreenPlan {
  if (spec.source !== "goal") {
    throw new Error("planGoalStockLeg requires a source \"goal\" spec.");
  }
  return planStockScreenRun(
    {
      trigger,
      filters: spec.filters as { sector?: string },
      universe: spec.universe as "ALL",
    },
    timestamp,
  );
}
