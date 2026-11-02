/**
 * Issue #2864 (Phase 2 Slice 4 under #2764) — the stock-screen
 * planner, extracted from ScreenerAgent.runScreenInner
 * (src/agents/screener-agent.ts, verified location).
 *
 * GRASP Information Expert / Pure Fabrication: this module owns
 * the single resolution of a run's execution plan — the fields
 * runScreenInner previously derived inline at its top, interleaved
 * with ledger and heartbeat setup — so the broker, scheduled, NLQ,
 * mesh, and goal paths can share one plan instead of re-deriving
 * it by hand:
 *   - sector: request sector, else filter sector, else "ALL"
 *     (issue #421: no sector selected means every sector).
 *   - universe: request universe, else "TECH".
 *   - provider: request provider, else "etrade" (issue #1007).
 *   - providerFallback: carried through untouched (issue #1527).
 *   - idempotencyKey: the durable-task identity, verbatim from
 *     runScreenInner — scheduled runs key on their minute slot
 *     (issue #607), manual runs on their full timestamp.
 *   - scheduledClaimKey: the duplicate-claim identity
 *     (`stock:<universe>`) claimScheduledExecution dedups on.
 *
 * The planner is pure: it plans, it never executes, persists, or
 * delivers, and it introduces no new key formula, default, or
 * precedence — every value below is copied verbatim from
 * runScreenInner, so wiring it in is a pure move.
 *
 * planFromSpec is the canonical-path entry: a Slice 1
 * StockScreenRunSpec plus a trigger plans exactly as the
 * equivalent ScreenerRunRequest would (spec.provider unset
 * means the E*TRADE default, as in Slice 1; spec filters carry
 * the sector, as the routes' parse step produces them).
 */

import type { StockScreenProvider, UniverseId } from "../trading";
import type { StockScreenRunSpec } from "./stockScreenRunSpec";

/** The resolved execution plan for one stock-screen run. */
export interface StockScreenPlan {
  sector: string;
  universe: UniverseId;
  provider: StockScreenProvider;
  providerFallback?: {
    from: StockScreenProvider;
    reason: string;
  };
  /** Durable-task identity (issue #607), verbatim formula. */
  idempotencyKey: string;
  /** Scheduled duplicate-claim identity (`stock:<universe>`). */
  scheduledClaimKey: string;
}

export interface StockScreenPlanInput {
  trigger: "manual" | "scheduled";
  sector?: string;
  filters?: { sector?: string };
  universe?: UniverseId;
  provider?: StockScreenProvider;
  providerFallback?: StockScreenPlan["providerFallback"];
}

function buildPlan(input: StockScreenPlanInput, timestamp: string): StockScreenPlan {
  const sector = input.sector || input.filters?.sector || "ALL";
  const universe: UniverseId = input.universe ?? "TECH";
  const provider: StockScreenProvider = input.provider ?? "etrade";
  return {
    sector,
    universe,
    provider,
    ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
    idempotencyKey:
      input.trigger === "scheduled"
        ? `screener:scheduled:${universe}:${sector}:${timestamp.slice(0, 16)}`
        : `screener:manual:${universe}:${sector}:${timestamp}`,
    scheduledClaimKey: `stock:${universe}`,
  };
}

/** Plan a run from a ScreenerRunRequest-shaped input. */
export function planStockScreenRun(
  input: StockScreenPlanInput,
  timestamp: string,
): StockScreenPlan {
  return buildPlan(input, timestamp);
}

/**
 * Issue #2865 (Phase 2 Slice 5 under #2764) — plan a scheduled
 * monolithic run from the schedule payload's resolved inputs.
 * The effective provider rule is copied verbatim from
 * ScheduledTasksService.autonomousMarketScreen: a fallback run
 * (E*TRADE auth dead) runs Yahoo with its marker; otherwise the
 * requested provider, else the planner default. The trigger
 * defaults to "scheduled"; callers that re-run a schedule with
 * trigger "manual" (Trigger-Now) pass it explicitly.
 */
export function planScheduledScreen(
  input: {
    sector?: string;
    filters?: { sector?: string };
    universe?: UniverseId;
    provider?: StockScreenProvider;
    providerFallback?: StockScreenPlan["providerFallback"];
    trigger?: "manual" | "scheduled";
  },
  timestamp: string,
): StockScreenPlan {
  return buildPlan(
    {
      trigger: input.trigger ?? "scheduled",
      sector: input.sector,
      filters: input.filters,
      universe: input.universe,
      provider: input.providerFallback ? "yahoo" : input.provider,
      ...(input.providerFallback
        ? { providerFallback: input.providerFallback }
        : {}),
    },
    timestamp,
  );
}

/** Plan a run from a Slice 1 StockScreenRunSpec. */
export function planFromSpec(
  spec: StockScreenRunSpec,
  trigger: "manual" | "scheduled",
  timestamp: string,
): StockScreenPlan {
  return buildPlan(
    {
      trigger,
      filters: spec.filters as { sector?: string },
      universe: spec.universe as UniverseId,
      ...(spec.provider ? { provider: spec.provider as StockScreenProvider } : {}),
    },
    timestamp,
  );
}
