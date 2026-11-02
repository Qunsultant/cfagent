/**
 * Strategy user choice (issue #2600) — the ONE place that resolves the
 * four per-run / per-schedule controls, so the panel, schedule, and
 * unified surfaces cannot drift apart:
 *
 *   1. strategyMode: "thesis" | "all" | "no-view", default "thesis".
 *      Per run / per schedule — never a tenant-wide or repo-wide flip.
 *      `evaluateAllStrategies` survives only as a deprecated alias
 *      (superseded by strategyMode): true === "all", false/absent ===
 *      "thesis". Sending both with conflicting values is an error
 *      naming both fields; the route schemas turn it into a 400.
 *   2. allowedStrategies: multi-select; "all" expands via the existing
 *      registry resolveMany to the full catalogue (74 distinct ids —
 *      the 75th createTemplateStrategy match is the factory definition
 *      in template.ts, not a registry entry, and the 76th raw mention
 *      is the catalog.ts import line; neither is a strategy).
 *   3. candidateLimit: a ranked-candidate cap, kept separate from the
 *      best-trade `alternatives` count (default 3: 1 best + <=3
 *      alternatives). The explicit value "all" means uncapped and is
 *      recorded as "all", never as a large number and never as
 *      absent-without-a-trace.
 *   4. farDated / explicit DTE window: fetch bands derived from the
 *      MODE-RESOLVED selected templates' own horizons, never from the
 *      full catalogue. A selected template whose horizon no band
 *      reaches is reported horizon-limited, never silently dropped.
 *
 * This module consumes the existing registry, the #2583 scope resolver
 * (via its strategyScope mapping, applied by callers), and the #2579
 * unified run record. It creates no second catalog, scope model, or
 * recorder. It never ranks, never delivers, and never orders.
 */

import { DEFAULT_MAX_DTE } from "../optionsScreener";
import { defaultRegistry } from "./strategies/catalog";
import type { StrategyDefinition } from "./strategies/types";
import type { OptionThesis, StrategyRequest } from "./strategyEngine";

export type StrategyMode = "thesis" | "all" | "no-view";

export const STRATEGY_MODES: readonly StrategyMode[] = ["thesis", "all", "no-view"] as const;

/** Panel / manual default. Scheduled runs keep their stored scope (see
 *  scheduledTasks: a stored scope of "all" stays "all", it is never
 *  silently re-defaulted to thesis). */
export const DEFAULT_STRATEGY_MODE: StrategyMode = "thesis";

/**
 * Resolve the canonical mode from a body that may carry the new field,
 * the deprecated alias, or both. A conflict is an error naming both
 * fields — callers at a route boundary surface it as a 400; internal
 * callers (engine, scanner, schedules) treat it as a hard failure,
 * never as a silent pick of one side.
 */
export function resolveStrategyMode(input: {
  strategyMode?: StrategyMode;
  evaluateAllStrategies?: boolean;
}): StrategyMode {
  const { strategyMode, evaluateAllStrategies } = input;
  if (strategyMode !== undefined && evaluateAllStrategies !== undefined) {
    const aliasMode: StrategyMode = evaluateAllStrategies ? "all" : "thesis";
    if (aliasMode !== strategyMode) {
      throw new Error(
        `strategyMode "${strategyMode}" conflicts with evaluateAllStrategies ${evaluateAllStrategies} (which means "${aliasMode}"); send strategyMode only`,
      );
    }
    return strategyMode;
  }
  if (strategyMode !== undefined) return strategyMode;
  if (evaluateAllStrategies === true) return "all";
  return DEFAULT_STRATEGY_MODE;
}

/** True when the mode judges every wanted strategy (thesis orients
 *  scoring only, via thesisAlignment — it never excludes). */
export function modeEvaluatesAll(mode: StrategyMode): boolean {
  return mode === "all";
}

/**
 * Mode + wanted-set resolution, shared by the engine and the scanner
 * fetch selection so mode "all" can no longer judge-but-not-fetch:
 * thesis keeps only definitions whose theses include the run thesis;
 * all keeps every wanted definition; no-view is not a viewed filter
 * and must never reach this function (no-view uses its own path).
 */
export function filterDefinitionsByMode(
  definitions: readonly StrategyDefinition[],
  wantedIds: ReadonlySet<string>,
  mode: StrategyMode,
  thesis: OptionThesis,
): StrategyDefinition[] {
  if (mode === "no-view") {
    throw new Error("strategyMode \"no-view\" must use the no-view path, never the viewed thesis/all filter");
  }
  return definitions.filter(
    (def) => wantedIds.has(def.id) && (mode === "all" || def.theses.includes(thesis)),
  );
}

/** Resolve the as-submitted allowedStrategies list to registry ids.
 *  "all" expands to the full catalogue via resolveMany. Unknown names
 *  are returned separately so callers can reject (panel schema) rather
 *  than silently drop them. */
export function resolveAllowedStrategyIds(allowedStrategies: readonly string[]): { ids: string[]; unknown: string[] } {
  return defaultRegistry.resolveMany(allowedStrategies);
}

export interface FetchBand {
  minDte: number;
  maxDte: number;
  maxExpirations?: number;
}

export interface HorizonLimitedStrategy {
  id: string;
  label: string;
  horizonDte: number;
}

/**
 * Derive the fetch band set from the MODE-RESOLVED selected templates
 * (controls 1+2 applied first — bands derive from selected templates,
 * never from the full catalogue).
 *
 * - The near band is always first: [nearMinDte, nearMaxDte].
 * - Horizon bands: for every selected template with
 *   dataHorizonDte > nearMaxDte, [max(nearMaxDte + 7, requiredMaxDte),
 *   horizon] for multi-expiry templates, [max(nearMaxDte + 1,
 *   requiredMaxDte), horizon] otherwise — the scanner's existing
 *   band rule, factored out so the panel route uses the same rule.
 * - farDated === false suppresses horizon bands: the selected
 *   far-horizon templates are then horizon-limited and named as such
 *   (the panel acceptance case: near maxDte 90, toggle OFF, PMCC is
 *   horizon-limited, not silently dropped). farDated true, or absent
 *   on the scanner path, keeps horizon bands (the scanner's legacy
 *   behaviour — existing scheduled scans keep fetching horizons).
 * - An explicit DTE window is the near band itself (callers pass the
 *   window as nearMinDte/nearMaxDte); horizon bands are still added
 *   for selected templates whose horizons exceed it.
 *
 * Worked example (near maxDte 90, farDated on):
 *   poor_mans_covered_call (farMinDte 180, multiExpiry, horizon 365)
 *   -> band 180-365; leaps_call (minDte 365, searchMaxDte 550,
 *   horizon 550) -> band 365-550.
 */
export function deriveFetchBands(input: {
  selected: readonly StrategyDefinition[];
  nearMinDte: number;
  nearMaxDte: number;
  farDated?: boolean;
  /** Near-band expiration cap, as the caller already used it (the
   *  scanner passes MAX_EXPIRATIONS_PER_SYMBOL; the screener clamps
   *  any band to 8). Omitted = the screener's per-band default. */
  nearMaxExpirations?: number;
}): { bands: FetchBand[]; horizonLimited: HorizonLimitedStrategy[]; dataMaxDte: number } {
  const nearMinDte = Math.max(0, Math.floor(input.nearMinDte));
  const nearMaxDte = Math.max(nearMinDte, Math.floor(input.nearMaxDte));
  const bands: FetchBand[] = [{
    minDte: nearMinDte,
    maxDte: nearMaxDte,
    ...(input.nearMaxExpirations !== undefined ? { maxExpirations: input.nearMaxExpirations } : {}),
  }];
  const horizonLimited: HorizonLimitedStrategy[] = [];
  if (input.farDated === false) {
    for (const def of input.selected) {
      const horizon = def.dataHorizonDte ?? 0;
      if (horizon > nearMaxDte) horizonLimited.push({ id: def.id, label: def.label, horizonDte: horizon });
    }
    return { bands, horizonLimited, dataMaxDte: nearMaxDte };
  }
  for (const def of input.selected) {
    const horizon = def.dataHorizonDte ?? 0;
    if (horizon <= nearMaxDte) continue;
    const minDte = def.multiExpiry
      ? Math.max(nearMaxDte + 7, def.requiredMaxDte ?? 0)
      : Math.max(nearMaxDte + 1, def.requiredMaxDte ?? 0);
    if (minDte <= horizon) {
      bands.push({ minDte, maxDte: horizon, maxExpirations: 4 });
    } else {
      horizonLimited.push({ id: def.id, label: def.label, horizonDte: horizon });
    }
  }
  const deduped = bands.filter(
    (band, index, all) => all.findIndex((candidate) => candidate.minDte === band.minDte && candidate.maxDte === band.maxDte) === index,
  );
  return {
    bands: deduped,
    horizonLimited,
    dataMaxDte: Math.max(nearMaxDte, ...deduped.map((band) => band.maxDte)),
  };
}

/**
 * Mapping from the #2583 report-scope resolver axis to this control
 * (fixed by the #2600 design; the resolver enum is NOT extended):
 * resolver "all" -> mode "all"; resolver "explicit" -> mode "thesis";
 * no-view bypasses the report-scope strategy axis entirely.
 */
export function strategyModeFromReportScope(strategyScope: "all" | "explicit"): StrategyMode {
  return strategyScope === "all" ? "all" : "thesis";
}

/**
 * Issue #2600: panel fetch bands for one viewed (or no-view) request.
 * Moved here from src/agents/routes/etradeOptions.ts (the #359 50 KB
 * ratchet leaves that file 90 B of headroom on main, so route logic
 * lives in its domain module and the route keeps only the call).
 * Selection (mode + wanted set) is resolved FIRST, then bands derive
 * from the selected templates only (deriveFetchBands).
 * farDated === true attaches horizon bands to the forwarded request;
 * otherwise the request keeps the near window only and far-horizon
 * selections are returned as horizonLimited (named, never silently
 * dropped). The panel default (farDated absent) is therefore
 * behaviour-preserving: previously the panel never attached bands.
 * Callers record the returned bands + horizonLimited on the run.
 */
export function resolvePanelFetchBands(
  request: StrategyRequest,
  farDated: boolean | undefined,
): {
  request: StrategyRequest;
  bands: FetchBand[];
  horizonLimited: HorizonLimitedStrategy[];
} {
  const mode = resolveStrategyMode(request);
  const wanted = new Set(resolveAllowedStrategyIds(request.allowedStrategies).ids);
  const selected = mode === "no-view"
    ? defaultRegistry.list().filter((def) => wanted.has(def.id))
    : filterDefinitionsByMode(defaultRegistry.list(), wanted, mode, request.thesis);
  const farDatedOn = farDated === true;
  const { bands, horizonLimited } = deriveFetchBands({
    selected,
    nearMinDte: request.minDte ?? 0,
    nearMaxDte: request.maxDte ?? DEFAULT_MAX_DTE,
    farDated: farDatedOn,
  });
  return {
    request: farDatedOn ? { ...request, expirationDteBands: bands } : request,
    bands,
    horizonLimited,
  };
}

/**
 * Issue #2600: normalize a viewed-recommendation body BEFORE the
 * legacy validator (moved here from etradeOptions.ts for the same
 * #359 ratchet reason). The legacy validator (non-strict field
 * check) ignores the new route-level keys, so strategyMode flows to
 * the engine — but candidateLimit "all" would fail its int check,
 * and no-view + view fields must fail explicitly. "all" is
 * normalized to uncapped BEFORE validation (the engine receives no
 * cap, i.e. every ranked candidate), and no-view is refused here:
 * the strategies route owns the no-view path.
 */
export function normalizeViewedRecommendationBody(body: unknown): {
  isNoView: boolean;
  noViewError: string | null;
  candidateLimitAll: boolean;
  validationBody: unknown;
  farDated: boolean | undefined;
} {
  const rawBody = body as (Record<string, unknown> | null);
  const candidateLimitAll = rawBody?.candidateLimit === "all";
  const isNoView = rawBody?.strategyMode === "no-view";
  return {
    isNoView,
    noViewError: isNoView
      ? "strategyMode \"no-view\" cannot run a viewed recommendation; use POST /trading/options/strategies with a constraint-only (no-view) body."
      : null,
    candidateLimitAll,
    validationBody: candidateLimitAll && rawBody
      ? Object.fromEntries(Object.entries(rawBody).filter(([key]) => key !== "candidateLimit"))
      : body,
    farDated: rawBody?.farDated as boolean | undefined,
  };
}

/**
 * Issue #2600: a no-view mode with view fields is incoherent — the
 * comparison builder is viewed-only. The strategies route owns the
 * no-view path; comparison refuses it explicitly rather than
 * letting the engine throw mid-run. Returns the 400 message, or
 * null when the mode is viewed (or absent).
 */
export function noViewComparisonError(strategyMode: unknown): string | null {
  return strategyMode === "no-view"
    ? "strategyMode \"no-view\" cannot run a comparison; use POST /trading/options/strategies with a constraint-only (no-view) body."
    : null;
}

/**
 * Issue #2600: the strategies-route run-record fields for the four
 * controls (moved here from etradeOptions.ts for the #359 ratchet).
 * The record carries mode (canonical, alias folded in by the
 * schema), allowedStrategies as submitted + resolved ids,
 * candidateLimit (number or explicit "all"), farDated, the bands
 * actually used, and the horizon-limited list. Best-trade
 * alternatives stay their own field (default 3 in the kernel),
 * never merged into the ranked cap. The surrounding record fields
 * (thesis, dates, prices, risk profile) ride along so the call
 * site stays one spread.
 */
export function strategyRecordControlFields(input: {
  strategyMode?: string;
  riskProfile?: unknown;
  candidateLimit?: number | "all";
  farDated?: boolean;
  alternatives?: number;
  request: Record<string, any>;
  bands: FetchBand[];
  horizonLimited: HorizonLimitedStrategy[];
}): Record<string, unknown> {
  const req = input.request;
  return {
    thesis: typeof req.thesis === "string" ? req.thesis : undefined,
    strategyMode: input.strategyMode ?? "thesis",
    targetDate: typeof req.targetDate === "string" ? req.targetDate : undefined,
    riskProfile: input.riskProfile,
    allowedStrategies: req.allowedStrategies,
    allowedStrategiesResolved: resolveAllowedStrategyIds(req.allowedStrategies).ids,
    targetPrice: typeof req.targetPrice === "number" ? req.targetPrice : undefined,
    dteMin: typeof req.minDte === "number" ? req.minDte : undefined,
    dteMax: typeof req.maxDte === "number" ? req.maxDte : undefined,
    candidateLimit: input.candidateLimit,
    farDated: input.farDated,
    fetchBands: input.bands,
    horizonLimited: input.horizonLimited.length > 0 ? input.horizonLimited : undefined,
    alternatives: input.alternatives,
  };
}
