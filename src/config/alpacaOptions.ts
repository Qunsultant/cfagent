/**
 * Issue 6498 (#6237 RCA) — Alpaca options feed defaults.
 *
 * Alpaca's snapshots endpoint requires an explicit `feed` query parameter.
 * `ALPACA_OPTIONS_FEED` is the externalized override; `indicative` is the
 * documented free, no-OPRA-subscription default. Keeping the default here
 * means every consumer of `buildAlpacaOptionsConfig` (screen chains, options
 * screener, OODA's Alpaca live path, data adapters) gets the same value — a
 * caller never re-decides the feed.
 */

/** Default Alpaca options feed when `ALPACA_OPTIONS_FEED` is unset or empty. */
export const DEFAULT_ALPACA_OPTIONS_FEED = "indicative";
