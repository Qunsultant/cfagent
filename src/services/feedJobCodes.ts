/**
 * Issue #4068 — the feed-job coded errors, as a LEAF module: this file
 * imports nothing, so `jobPipelineEngine` can import the codes without
 * pulling in `feedJobs` — and, through it, `indexListJob` and the
 * `../trading` barrel. That import closed a module cycle once the
 * options engine dispatch (`unifiedOptionsService` →
 * `optionsScreenEngine` → `jobPipelineEngine`) was reachable from the
 * barrel: `feedJobs` → `indexListJob` → `../trading` re-entered the
 * barrel mid-evaluation and `SECTOR_IDS` read as undefined at
 * `indexListJob.ts` module scope (`TypeError: SECTOR_IDS is not
 * iterable`, four suites failing to load). `feedJobs.ts` re-exports
 * these names, so every existing importer keeps its path; only
 * `jobPipelineEngine` imports the leaf directly. (The #4060 pattern:
 * move the seam to a leaf, re-export from the old home.)
 */

/** Stable coded errors for feed-job outcomes (externalized vocabulary). */
export const FEED_JOB_CODES = {
  jobNotFound: "FEED_JOB_NOT_FOUND",
  universeMissing: "FEED_UNIVERSE_MISSING",
  universeRefreshFailed: "FEED_UNIVERSE_REFRESH_FAILED",
  universeUnknown: "FEED_UNIVERSE_UNKNOWN",
  batchUnsupported: "FEED_PROVIDER_BATCH_UNSUPPORTED",
  providerMismatch: "FEED_PROVIDER_MISMATCH",
  noQuotesReturned: "FEED_NO_QUOTES_RETURNED",
  fetchFailed: "FEED_FETCH_FAILED",
  fundamentalsUnsupported: "FEED_PROVIDER_FUNDAMENTALS_UNSUPPORTED",
  noFundamentalsReturned: "FEED_NO_FUNDAMENTALS_RETURNED",
  historicalBarsUnsupported: "FEED_PROVIDER_HISTORICAL_BARS_UNSUPPORTED",
  noBarsReturned: "FEED_NO_BARS_RETURNED",
  newsUnsupported: "FEED_PROVIDER_NEWS_UNSUPPORTED",
  noNewsReturned: "FEED_NO_NEWS_RETURNED",
  optionsChainsUnsupported: "FEED_PROVIDER_OPTIONS_CHAINS_UNSUPPORTED",
  noChainsReturned: "FEED_NO_CHAINS_RETURNED",
  refreshTimeout: "FEED_REFRESH_TIMEOUT",
  fetchTimeout: "FEED_FETCH_TIMEOUT",
  captureTimeout: "FEED_CAPTURE_TIMEOUT",
  deadlineExceeded: "FEED_DEADLINE_EXCEEDED",
  /** #4304 — the provider verify probe exceeded its named bound. */
  verifyTimeout: "FEED_VERIFY_TIMEOUT",
} as const;
export type FeedJobCode = (typeof FEED_JOB_CODES)[keyof typeof FEED_JOB_CODES];
