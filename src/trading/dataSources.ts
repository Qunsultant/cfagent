/**
 * Market data source registry (issue #269).
 *
 * Declares every source the screener can draw on, its status, and what it
 * provides. New sources plug in here without pipeline changes — the
 * acquisition layer reads this registry.
 *
 * Status lifecycle: planned → integrating → live.
 */

export type DataSourceStatus = "live" | "integrating" | "planned";

export interface DataSource {
  id: string;
  name: string;
  status: DataSourceStatus;
  /** What this source contributes when live. */
  capabilities: string[];
  /** Notes on auth, limits, or integration plan. */
  notes: string;
}

export const DATA_SOURCES: DataSource[] = [
  {
    id: "etrade",
    name: "E*TRADE",
    status: "live",
    capabilities: [
      "Live snapshot quotes (price, change, day OHLC, volume)",
      "Bid/ask, 52-week high/low, P/E, market cap",
      "Options chains (via options service)",
    ],
    notes: "Primary quote source. OAuth via SessionStore DO; honest failure when unavailable.",
  },
  {
    id: "yahoo",
    name: "Yahoo Finance",
    status: "live",
    capabilities: [
      "Daily price history (3mo) → RSI(14), MACD(12,26,9)",
      "Previous close + open → overnight gap %",
    ],
    notes: "History complement only — never overrides an E*TRADE quote. v8 chart API, no auth.",
  },
  {
    id: "public_com",
    name: "Public.com",
    status: "planned",
    capabilities: [
      "Planned: alternative quote source, extended-hours data",
    ],
    notes: "Future source — not wired. Add fetcher + capabilities here when integrating.",
  },
  {
    id: "tastytrade",
    name: "Tastytrade",
    status: "integrating",
    capabilities: [
      "OAuth2 refresh-token session, accounts, positions, quotes, order dry-run/place/cancel",
    ],
    notes: "Issue #4675 Slice 1: OAuth2 credential seam + ITradingPlatform wired in src/trading/tastytrade/.",
  },
];

export function liveSources(): DataSource[] {
  return DATA_SOURCES.filter((s) => s.status === "live");
}

export function plannedSources(): DataSource[] {
  return DATA_SOURCES.filter((s) => s.status === "planned");
}
