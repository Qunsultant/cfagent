/**
 * Issue #2809 (Phase 2 Slice 1 under #2764) — one normalized
 * StockScreenRunSpec for the two REST stock-screen routes.
 *
 * Pure Fabrication / Information Expert (GRASP): this module owns
 * the single construction of a run spec from the two steps both
 * REST routes already performed separately — admitScreenModeSelection
 * (#2530) and parseStockScreenRequest (#959) — plus the delivery
 * envelope. It introduces no new schema, no new validation, and no
 * behaviour change: the schema stays single-source in
 * src/trading/screeningSchemas.ts, imported here only through the
 * sole public surface src/trading (issue #290 trading boundary),
 * and mode admission stays in screenerWorkflowRoutes.ts. Routes
 * only stop assembling the spec by hand.
 *
 * Divergence is pinned as data, not as branching code:
 *   - E*TRADE route:  source "etrade",      deliver true,  provider
 *     unset (the ScreenerAgent default), delivery = the parsed
 *     envelope (the sync path publishes it via publishOrBridge).
 *   - Market-data route: source "market-data", deliver false,
 *     provider "yahoo", delivery = {} — the parsed envelope is
 *     deliberately NOT forwarded, exactly as today: the
 *     market-data route has no deliver step.
 *   - Goal stock leg (issue #2882): source "goal", deliver
 *     false, provider unset, universe "ALL", asyncRequested
 *     false, delivery = {}. Goal delivery and the goal
 *     provider stay owned by goal dispatch; the broker never
 *     starts a screener workflow for a goal spec (it returns
 *     null). "ALL" records that goal legs are not
 *     universe-scoped (the registry provider screens its
 *     listings feed) — it is not a coverage claim, and the
 *     spec is a canonical record of the leg, not an
 *     execution reroute: goal execution stays in
 *     goalDrivenScreen + goal dispatch.
 *
 * Ordering contract (preserves both routes' behaviour exactly):
 * the E*TRADE route admits the mode BEFORE its listings switch
 * and parses only after the listings branch, so it passes its
 * already-admitted modeSelection in and this builder does not
 * re-admit (a second admit on a POST body would see the mode
 * fields already stripped and lose an ND selection). The
 * market-data route passes no modeSelection and the builder
 * admits it. `rawFilters` is mutated exactly as today by
 * admitScreenModeSelection on POST (screenMode/screenIntent
 * stripped so they never leak into the filters); `async` must
 * already have been stripped by the caller, as both routes do.
 */

import { parseStockScreenRequest } from "../trading";
import {
  admitScreenModeSelection,
  type ScreenModeSelection,
} from "./screenerWorkflowRoutes";
import type { StockScreenerFilter } from "../types";

/** The per-request delivery envelope, defined once here. */
export interface StockScreenDelivery {
  emailTo?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
  webhookUrl?: string;
  generatePdf?: boolean;
}

export type StockScreenSource = "etrade" | "market-data" | "goal";

/**
 * The normalized run spec both REST routes execute from. `minScore`
 * is carried for compatibility (the #959 envelope field) and is
 * never forwarded into the engine filter — `filters` already
 * excludes it, as parseStockScreenRequest splits it out.
 */
export interface StockScreenRunSpec {
  source: StockScreenSource;
  /** Undefined for E*TRADE (agent default) and goal (goal-owned); "yahoo" for market-data. */
  provider?: "yahoo";
  /** The pinned delivery divergence: E*TRADE true, market-data and goal false. */
  deliver: boolean;
  filters: StockScreenerFilter;
  universe: string;
  minScore?: number;
  asyncRequested: boolean;
  delivery: StockScreenDelivery;
  screenMode?: "non-deterministic";
  screenIntent?: string;
  /** Issue #2882: goal provenance, present only on source "goal" specs. Kept as a reference, never flattened into the filter. */
  goal?: {
    goalKind: string;
    outlook: string;
    structures: string[];
  };
}

export type BuildStockScreenRunSpecResult =
  | { ok: true; spec: StockScreenRunSpec }
  | { ok: false; error: string };

export function buildStockScreenRunSpec(args: {
  env: unknown;
  method: string;
  rawFilters: Record<string, unknown> & {
    screenMode?: unknown;
    screenIntent?: unknown;
  };
  query: URLSearchParams;
  asyncRequested: boolean;
  source: StockScreenSource;
  /** Pre-admitted mode (E*TRADE route: admitted before listings). */
  modeSelection?: ScreenModeSelection;
}): BuildStockScreenRunSpecResult {
  const modeSelection =
    args.modeSelection ??
    admitScreenModeSelection(args.env, args.method, args.rawFilters, args.query, {
      asyncRequested: args.asyncRequested,
    });
  if (!modeSelection.ok) {
    return { ok: false, error: modeSelection.error };
  }
  const parsedScreen = parseStockScreenRequest(args.rawFilters);
  if (!parsedScreen.ok) {
    return { ok: false, error: parsedScreen.error };
  }
  const { filters, universe, minScore, emailTo, pushToSlack, slackChannel, webhookUrl, generatePdf } =
    parsedScreen.value;
  const delivery: StockScreenDelivery =
    args.source === "etrade"
      ? { emailTo, pushToSlack, slackChannel, webhookUrl, generatePdf }
      : {};
  return {
    ok: true,
    spec: {
      source: args.source,
      ...(args.source === "market-data" ? { provider: "yahoo" as const } : {}),
      deliver: args.source === "etrade",
      filters,
      universe,
      ...(minScore !== undefined ? { minScore } : {}),
      asyncRequested: args.asyncRequested,
      delivery,
      ...(modeSelection.screenMode
        ? { screenMode: modeSelection.screenMode, screenIntent: modeSelection.screenIntent }
        : {}),
    },
  };
}
