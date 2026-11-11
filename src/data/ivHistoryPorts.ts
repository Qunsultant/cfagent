/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — IV-history
 * port: one ATM IV observation per tracked name per day
 * (issue #15, Discovery epic #13).
 *
 * ADR D-0 ruled this family D1: the table is tenant-free
 * market data — keyed (symbol, date), the only family table
 * with no user_login — while its durable read is a whole-series
 * read (computeIvStats over the trailing 252 observations)
 * whose correctness depends on seeing ALL collected
 * observations. Collection happens in whichever orchestrator
 * instance runs the collector task, so DO residency silently
 * fragments the series per collecting instance. Writes are
 * idempotent appends (first-write-wins, INSERT OR IGNORE)
 * consuming no serialization; reads are symbol-indexed lookups
 * D1 serves identically. Migration 0020 creates the D1 table
 * (agent_iv_history).
 *
 * CUTOVER GATE (issue #2337, R-2): the D1 adapter lands with
 * this port, but production composition DEFAULTS to the DO
 * adapter — the read/write cutover waits on the owner ruling
 * recorded on the issue (backfill the stranded per-instance
 * series vs accept a warming-up restart). The default is
 * pinned in the step-2 conformance suite.
 *
 * HONESTY RULES CARRIED IN THE CONTRACT: the settled decision
 * (spec §16, decision 3) is self-collection in warming-up mode
 * — no licensed backfill, nothing fabricated or interpolated;
 * a day the provider failed is an absent observation, never an
 * invented one. record() is therefore a single idempotent
 * statement per record and must NEVER be wrapped into an
 * all-or-nothing batch (step-2 audit §4): an absent day is an
 * absent observation.
 *
 * This module carries the record types, the pure stats math,
 * and the port interface ONLY (ADR 0002 R1/R2). Adapters:
 * d1IvHistoryAdapter.ts (D1, gated), doSqliteIvHistoryAdapter
 * .ts (production default), inMemoryIvHistoryAdapter.ts (test
 * double). The types moved here from
 * src/trading/options/ivHistoryStore.ts, which is now a
 * re-export shim.
 */


/** Trailing window (in observations) the rank/percentile math reads:
 *  252 ≈ one trading year of daily observations. */
export const IV_STATS_WINDOW = 252;

/** Below this many observations a name is "warming up" (spec §11):
 *  rank/percentile are still computed and returned, but consumers
 *  must treat IV-rank-dependent inference as reduced-confidence. */
export const IV_WARMING_UP_THRESHOLD = 60;

/**
 * Issue #3326 (programme #3292): which broker's chain produced an observation.
 *
 * The row is still one observation per (symbol, date) — ATM IV on a given day
 * is one market fact — but the snapshot it was read from came from a specific
 * broker, and the series a surface shows must be that broker's own or say it
 * has none. Without this field the only honest options were "refuse Alpaca" or
 * "relabel E*TRADE rows", and relabelling is fabrication.
 */
export type IvBroker = "etrade" | "alpaca" | "public"; // Issue #3990: Public runs record their own broker.

/** Legacy rows (and any unrecognised value) were collected from E*TRADE chains. */
export function normalizeIvBroker(value: unknown): IvBroker {
  return String(value ?? "").trim().toLowerCase() === "alpaca" ? "alpaca" : "etrade";
}

/** One day's ATM IV observation for one tracked name. */
export interface IvHistoryRecord {
  symbol: string;
  /** Broker whose chain produced this observation. Absent = legacy E*TRADE row. */
  broker?: IvBroker;
  /** Collection day, YYYY-MM-DD in America/New_York. */
  date: string;
  /** ATM IV as a fraction (0.32 = 32%), derived from the live chain —
   *  see deriveAtmIv in ivCollector.ts. */
  atmIv: number;
  /** Underlying spot the chain was priced against. */
  spot: number;
  /** The expiry the ATM IV was read from (nearest eligible expiry). */
  expiryDate: string;
  /** Days from the collection instant to expiryDate (ceil, UTC). */
  dte: number;
  /** ISO timestamp of the write. */
  collectedAt: string;
}

/** Coverage accounting for one name's stored history. */
export interface IvHistoryCoverage {
  observations: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** Rank/percentile view over a stored series (pure math — see
 *  computeIvStats). Rank/percentile are null only when the series is
 *  empty; warming-up series still report computed values, qualified
 *  by the warmingUp flag rather than hidden. */
export interface IvStats {
  observations: number;
  /** observations / IV_STATS_WINDOW × 100, capped at 100. */
  coveragePct: number;
  /** observations < IV_WARMING_UP_THRESHOLD. */
  warmingUp: boolean;
  latest: IvHistoryRecord | null;
  /** (current − min) / (max − min) × 100 over the trailing window,
   *  where current is the latest observation. A degenerate window
   *  (max == min — flat series, or a single observation) reports the
   *  neutral midpoint 50: the current IV is neither high nor low
   *  relative to everything observed. */
  ivRank: number | null;
  /** Share of window observations strictly below current × 100. */
  ivPercentile: number | null;
}

export interface IvHistoryStore {
  /** Persist one day's record. Returns true when the row was
   *  written, false when (symbol, date) already existed — first
   *  write wins, so a same-day rerun is a no-op. The day's FIRST
   *  observation is the record whichever broker produced it: a second
   *  broker on the same day is not a second data point, and its run
   *  reports already_recorded rather than rewriting provenance. */
  record(record: IvHistoryRecord): Promise<boolean>;
  /** The record for one (symbol, date), or null. `broker` filters to rows that
   *  broker produced; omit for the day's record whichever broker wrote it. */
  get(symbol: string, date: string, broker?: IvBroker): Promise<IvHistoryRecord | null>;
  /** Stored series for a symbol, NEWEST first (house list style);
   *  `limit` caps the rows returned, `broker` filters by provenance. */
  listSeries(symbol: string, options?: { limit?: number; broker?: IvBroker }): Promise<IvHistoryRecord[]>;
  /** Observation count and date span for a symbol (optionally per broker). */
  coverage(symbol: string, broker?: IvBroker): Promise<IvHistoryCoverage>;
  /** Every symbol with at least one stored record, ascending (optionally per broker). */
  listSymbols(options?: { broker?: IvBroker }): Promise<string[]>;
}

/**
 * The America/New_York calendar date (YYYY-MM-DD) of an instant —
 * the collection day a record belongs to. Same en-CA Intl idiom the
 * codebase already uses for ET dates (src/security/etradeOAuth.ts).
 * Pure and exported for tests.
 */
export function nyDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * IV rank / percentile over a stored series (pure; exported for
 * direct unit testing). "Current" is the latest record by date.
 * Rank and percentile read the trailing IV_STATS_WINDOW observations
 * (the most recent ones — older history still counts toward
 * `observations` and coverage). Percentile convention: share of
 * window observations STRICTLY below current, so ties at the current
 * value never inflate it.
 */
export function computeIvStats(records: readonly IvHistoryRecord[]): IvStats {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const observations = sorted.length;
  const latest = observations > 0 ? sorted[observations - 1] : null;
  const coveragePct = Math.min(100, (observations / IV_STATS_WINDOW) * 100);
  const warmingUp = observations < IV_WARMING_UP_THRESHOLD;
  if (!latest) {
    return { observations, coveragePct, warmingUp, latest: null, ivRank: null, ivPercentile: null };
  }
  const window = sorted.slice(-IV_STATS_WINDOW);
  const current = latest.atmIv;
  let min = Infinity;
  let max = -Infinity;
  let below = 0;
  for (const r of window) {
    if (r.atmIv < min) min = r.atmIv;
    if (r.atmIv > max) max = r.atmIv;
    if (r.atmIv < current) below++;
  }
  const ivRank = max === min ? 50 : ((current - min) / (max - min)) * 100;
  const ivPercentile = (below / window.length) * 100;
  return { observations, coveragePct, warmingUp, latest, ivRank, ivPercentile };
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same shape scanRunStore.ts declares): run a statement
 * with bound parameters, get back an iterable of row objects. The real
 * `this.ctx.storage.sql` satisfies it structurally.
 */
export interface IvSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
