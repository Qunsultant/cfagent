/**
 * The stock screen's explicit data mode (issue #4436, F8, D2 2026-11-13).
 *
 * One home for the vocabulary and its label. It lives in `config/` because
 * both layers name it: the workflow planner declares the mode on a run, and
 * the trading-layer PDF renderer prints its label. Keeping the label in the
 * planner made `trading/screenerReportPdf` import a workflow, which closed a
 * module cycle the moment the planner needed a value from `trading` (#5516).
 * This module imports nothing, so either side can read it.
 *
 * The two values are the two D2 shapes, named on the run instead of implied
 * by a broker-named fallback marker:
 *   - "gap-fill": gaps in the configured provider's data are filled from the
 *     delayed-quote provider. The run's provider stays the configured one;
 *     the filling is the designed live-quotes composition (screenerPipeline
 *     bindLiveQuotesQuoteDeps, #1356).
 *   - "full-dataset": the entire dataset comes from the delayed-quote
 *     provider — delayed quotes, stocks only — as a testing mode on the live
 *     system (e.g. run the entire pipeline on just the delayed-quote
 *     provider).
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
