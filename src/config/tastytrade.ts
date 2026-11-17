/**
 * Externalized Tastytrade API configuration defaults (issue #4675, Gap 21).
 *
 * Environment overrides (`TASTYTRADE_PAPER_URL`, `TASTYTRADE_LIVE_URL`,
 * `TASTYTRADE_BASE_URL`, `TASTYTRADE_USER_AGENT`) take precedence when set.
 */
export const TASTYTRADE_CONFIG = {
  liveBaseUrl: "https://api.tastyworks.com",
  paperBaseUrl: "https://api.cert.tastyworks.com",
  backtestBaseUrl: "https://backtester.vast.tastyworks.com",
  userAgent: "cfagent/1.0",
  refreshMarginSecs: 60,
  defaultExpiresInSecs: 900,
  requestTimeoutMs: 15_000,
} as const;
