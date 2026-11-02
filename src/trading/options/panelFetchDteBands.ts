/**
 * Issue #2599 (F7): the panel fetch band builder.
 *
 * The panel snapshot (POST /trading/options/strategies, /best-trade
 * via RecommendationService.discoverPanel) used to fetch only the
 * request's min/maxDte window (default 0-90, no expirationDteBands),
 * so strategies whose legs live beyond that window could never
 * match: LEAPS legs need 365-550 DTE (catalog searchMaxDte 550)
 * and PMCC needs a 180+ DTE far leg (catalog dataHorizonDte 365).
 * The scheduled scanner (opportunityScanner.ts, the near +
 * extended band builder) already reaches those horizons — this
 * helper applies that scanner's exact rule to a panel request, so
 * the panel fetches what the scanner fetches for the same thesis
 * and wanted strategies:
 *
 * - near band: [minDte ?? 0, maxDte ?? DEFAULT_MAX_DTE], capped
 *   at MAX_EXPIRATIONS_PER_SYMBOL expirations (the scanner's near
 *   band, unchanged — the panel's previous window, not widened);
 * - one extended band per registry definition that matches BOTH
 *   the request's thesis and its resolved allowedStrategies and
 *   whose dataHorizonDte exceeds the near max: [nearMax + 1 (or
 *   nearMax + 7 for multi-expiry definitions), horizon], capped
 *   at 4 expirations (the scanner's extended-band cap).
 *
 * Bands are deduped by (minDte, maxDte), exactly as the scanner
 * dedupes. This changes ONLY what is fetched: no strategy is
 * added, removed, re-ranked, or re-thesised, no thesis default
 * changes, and no cap changes (the screener's per-band and
 * per-symbol caps still apply downstream). Strategy-choice
 * redesign stays in slice 4 (#2600); in particular this does NOT
 * implement evaluateAllStrategies for the panel — it only makes
 * the thesis-matching LEAPS/PMCC legs fetchable, so a panel run
 * that wants those strategies (thesis match + allowedStrategies)
 * can build them instead of ledger-skipping them for a missing
 * DTE window.
 *
 * No Yahoo substitution: the bands only widen which E*TRADE
 * expirations are fetched for the broker chain; the live path
 * stays broker-chains-only.
 */

import { DEFAULT_MAX_DTE, MAX_EXPIRATIONS_PER_SYMBOL } from "../optionsScreener";
import { defaultRegistry } from "./strategies/catalog";
import type { OptionThesis } from "./strategyEngine";

export interface PanelFetchBand {
  minDte: number;
  maxDte: number;
  maxExpirations: number;
}

/** The scanner's extended-band per-band expiration cap. */
export const PANEL_EXTENDED_BAND_MAX_EXPIRATIONS = 4;

/** The scanner's multi-expiry gap between the near band and an extended band. */
export const PANEL_MULTI_EXPIRY_BAND_GAP_DAYS = 7;

export function buildPanelFetchDteBands(input: {
  thesis: OptionThesis;
  allowedStrategies?: readonly string[];
  minDte?: number;
  maxDte?: number;
}): PanelFetchBand[] {
  const nearMaxDte = input.maxDte ?? DEFAULT_MAX_DTE;
  // A request without wanted strategies keeps the pre-F7 fetch:
  // near band only (no extended bands), never a throw — the
  // facade/route callers pass StrategyRequest, whose
  // allowedStrategies is optional.
  const resolvedStrategies = new Set(
    defaultRegistry.resolveMany(input.allowedStrategies ?? []).ids,
  );
  const selectedDefinitions = defaultRegistry
    .list()
    .filter(
      (def) =>
        resolvedStrategies.has(def.id) &&
        def.theses.some((thesis) => thesis === input.thesis),
    );
  const bands: PanelFetchBand[] = [
    {
      minDte: input.minDte ?? 0,
      maxDte: nearMaxDte,
      maxExpirations: MAX_EXPIRATIONS_PER_SYMBOL,
    },
    ...selectedDefinitions.flatMap((def) => {
      const horizon = def.dataHorizonDte ?? 0;
      if (horizon <= nearMaxDte) return [];
      const minDte = def.multiExpiry
        ? Math.max(nearMaxDte + PANEL_MULTI_EXPIRY_BAND_GAP_DAYS, def.requiredMaxDte ?? 0)
        : Math.max(nearMaxDte + 1, def.requiredMaxDte ?? 0);
      return minDte <= horizon
        ? [
            {
              minDte,
              maxDte: horizon,
              maxExpirations: PANEL_EXTENDED_BAND_MAX_EXPIRATIONS,
            },
          ]
        : [];
    }),
  ];
  return bands.filter(
    (band, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.minDte === band.minDte &&
          candidate.maxDte === band.maxDte,
      ) === index,
  );
}
