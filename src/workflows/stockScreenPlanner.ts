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
 *   - provider: REQUIRED (issue #4431, S5/N3) — the caller
 *     supplies the tenant-resolved provider; a missing provider
 *     refuses with FAILURE_NO_SCREENING_PROVIDER (the F6 #3655
 *     contract) instead of screening another provider's data.
 *     The pre-#4431 `?? "etrade"` default is removed, never
 *     replaced by another silent default.
 *   - providerFallback: removed (issue #4436) — the #1527 marker
 *     is replaced by yahooDataMode below; the E*TRADE-named
 *     marker is gone.
 *   - yahooDataMode: the explicit data mode (issue #4436,
 *     F8, D2 2026-11-13) — "gap-fill" (gaps in the configured
 *     provider's data are filled from the delayed-quote provider;
 *     the provider stays the configured one, the filling done by
 *     composition, untouched) or "full-dataset" (the entire
 *     dataset comes from the delayed-quote provider — delayed quotes, stocks only —
 *     as a testing mode on the live system). The mode is named on
 *     the run; it is never an implicit substitution.
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
 * equivalent ScreenerRunRequest would (spec.provider is the
 * tenant-resolved provider the routes stamp per #4431; spec
 * filters carry the sector, as the routes' parse step produces
 * them). A spec with no provider refuses here — the planner
 * never invents one.
 */

import type { StockScreenProvider, UniverseId } from "../trading";
import { normalizeJobRunTrigger, type JobRunTrigger } from "../data/jobRunRecordPorts";
import { BusinessError } from "../outcomes/outcomeAspects";
import type { StockScreenRunSpec } from "./stockScreenRunSpec";

/**
 * Issue #4436 (F8, D2 2026-11-13) — the explicit broker-neutral
 * Data mode for a stock-screen run. The two values are the
 * two D2 shapes, named on the run instead of implied by a
 * broker-named fallback marker:
 *   - "gap-fill": gaps in the configured provider's data are
 *     filled from the delayed-quote provider. The run's provider
 *     stays the configured one; the filling is the designed
 *     live-quotes composition (screenerPipeline
 *     bindLiveQuotesQuoteDeps, #1356), untouched by this slice.
 *   - "full-dataset": the entire dataset comes from the delayed-quote provider —
 *     delayed quotes, stocks only — as a testing mode on the live
 *     system (e.g. run the entire pipeline on just the delayed-quote provider).
 * Stocks-only by construction: the planner plans stock screens,
 * and the only producer (the goal-screen guard) consults it only
 * for stocks-requesting runs.
 */
export type YahooDataMode = "gap-fill" | "full-dataset";

/** True when a value is a data mode (command validation). */
export function isYahooDataMode(value: unknown): value is YahooDataMode {
  return value === "gap-fill" || value === "full-dataset";
}

/**
 * Issue #4436 — the one UI/record label for a data mode.
 * Every surface that names the mode (run summary, PDF provenance,
 * failure notice) uses this wording so the mode reads the same
 * everywhere: the mode, that quotes are delayed, and the
 * stocks-only scope; the full-dataset value adds the testing
 * framing.
 */
export function yahooDataModeLabel(mode: YahooDataMode): string {
  return mode === "full-dataset"
    ? "Yahoo full-dataset testing mode (delayed quotes, stocks only)"
    : "Yahoo gap-fill mode (delayed quotes, stocks only)";
}

/** The resolved execution plan for one stock-screen run. */
export interface StockScreenPlan {
  sector: string;
  universe: UniverseId;
  provider: StockScreenProvider;
  /** Issue #4436: the run's explicit data mode, when one applies. */
  yahooDataMode?: YahooDataMode;
  /** Durable-task identity (issue #607), verbatim formula. */
  idempotencyKey: string;
  /** Scheduled duplicate-claim identity (`stock:<universe>`). */
  scheduledClaimKey: string;
}

export interface StockScreenPlanInput {
  trigger: JobRunTrigger;
  sector?: string;
  filters?: { sector?: string };
  universe?: UniverseId;
  provider?: StockScreenProvider;
  /** Issue #4436: the run's explicit data mode, when one applies. */
  yahooDataMode?: YahooDataMode;
}

function buildPlan(input: StockScreenPlanInput, timestamp: string): StockScreenPlan {
  const sector = input.sector || input.filters?.sector || "ALL";
  const universe: UniverseId = input.universe ?? "TECH";
  // Issue #4431 (S5/N3): the provider is required — a missing
  // provider refuses with the F6 (#3655) coded outcome instead of
  // screening another provider's data. The issue text names this
  // refusal NO_SCREEN_PROVIDER; it is implemented as the existing
  // catalog outcome FAILURE_NO_SCREENING_PROVIDER (409) so the
  // manual path and the scheduled path refuse with one code.
  // Issue #4436: the full-dataset mode names its dataset provider
  // explicitly, so it resolves the provider itself —
  // the mode IS the explicit choice, never a silent default. The
  // gap-fill mode needs a configured primary to fill gaps in, so
  // a gap-fill run with no provider refuses like any other
  // provider-less run.
  let provider: StockScreenProvider;
  if (input.yahooDataMode === "full-dataset") {
    provider = "yahoo";
  } else {
    if (input.provider === undefined) {
      throw new BusinessError("FAILURE_NO_SCREENING_PROVIDER", {
        trigger: input.trigger,
        universe,
      });
    }
    provider = input.provider;
  }
  return {
    sector,
    universe,
    provider,
    ...(input.yahooDataMode ? { yahooDataMode: input.yahooDataMode } : {}),
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
 * Issue #4436: the effective provider rule is the explicit
 * data mode — a full-dataset run runs the delayed-quote provider
 * (the mode names its dataset provider); a gap-fill run keeps the
 * requested provider and its gaps are filled from the delayed-quote
 * provider. There is no implicit fallback: a scheduled run with no
 * resolved provider and no full-dataset mode refuses with
 * FAILURE_NO_SCREENING_PROVIDER (the scheduled path resolves
 * throw). The trigger defaults to "scheduled"; callers that re-run
 * a schedule with trigger "manual" (Trigger-Now) pass it explicitly.
 */
export function planScheduledScreen(
  input: {
    sector?: string;
    filters?: { sector?: string };
    universe?: UniverseId;
    provider?: StockScreenProvider;
    yahooDataMode?: YahooDataMode;
    trigger?: JobRunTrigger;
  },
  timestamp: string,
): StockScreenPlan {
  return buildPlan(
    {
      trigger: input.trigger ?? "scheduled",
      sector: input.sector,
      filters: input.filters,
      universe: input.universe,
      provider: input.provider,
      ...(input.yahooDataMode ? { yahooDataMode: input.yahooDataMode } : {}),
    },
    timestamp,
  );
}

/**
 * Plan a run from a Slice 1 StockScreenRunSpec. Issue #2908
 * (G1): the trigger defaults to the spec's own trigger — the five
 * dispatch modes pass through (#5052); a source-only spec trigger
 * (nlq / mesh / goal / research) plans as manual, as before —
 * callers no longer re-derive it by hand; an explicit trigger
 * still wins.
 */
export function planFromSpec(
  spec: StockScreenRunSpec,
  trigger?: JobRunTrigger,
  timestamp?: string,
): StockScreenPlan {
  const resolvedTrigger = trigger ?? normalizeJobRunTrigger(spec.trigger);
  return buildPlan(
    {
      trigger: resolvedTrigger,
      filters: spec.filters as { sector?: string },
      universe: spec.universe as UniverseId,
      ...(spec.provider ? { provider: spec.provider as StockScreenProvider } : {}),
    },
    timestamp ?? new Date().toISOString(),
  );
}
