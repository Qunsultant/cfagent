/**
 * Daily ATM IV collector (issue #15, Discovery epic #13).
 *
 * Once a day this walks the tracked universe (curated universe ∪ all
 * watchlist symbols), reads each name's live option chain through the
 * same data path the scanner uses (OptionsDataAgent over the
 * DynamicOptionsScreener — broker chains only, never the calibrated
 * demo generator), derives the name's at-the-money IV, and persists
 * one record per name per day via the IvHistoryStore.
 *
 * Provider failure is a first-class outcome, not an exception that
 * aborts the batch and never a value that gets invented: a name whose
 * chain fails (e.g. the E*TRADE oauth_problem 400s seen in
 * production) gets NO record for the day, and the run's report names
 * it `failed` with the provider's reason. Missing days are simply
 * absent observations in the series — coverage math (ivHistoryStore)
 * shows them as exactly that.
 */

import type { ScreenedOptionContractItem } from "../../types";
import {
  computeIvStats,
  nyDateString,
  type IvBroker,
  type IvHistoryRecord,
  type IvHistoryStore,
  type IvStats,
} from "./ivHistoryStore";

/** The chain fields the ATM IV derivation reads. */
export type AtmIvContract = Pick<
  ScreenedOptionContractItem,
  "strikePrice" | "impliedVolatility" | "expirationDate" | "optionType" | "underlyingPrice"
>;

/** The derived daily observation (the store record minus its
 *  bookkeeping fields). */
export interface AtmIvDerivation {
  atmIv: number;
  spot: number;
  expiryDate: string;
  dte: number;
}

/**
 * Derive a chain's at-the-money IV (pure; exported for unit tests).
 *
 * Selection follows the issue #15 contract: the NEAREST ELIGIBLE
 * EXPIRY first, then the NEAREST-TO-SPOT STRIKE within it, averaging
 * the call and put IVs when both sides exist at that strike (the
 * standard ATM convention — a single side alone is used when it is
 * the only one quoted).
 *
 * "Usable" and the DTE convention are the scanner's own, shared with
 * estimateExpectedMovePct (opportunityScanner.ts) so the product has
 * ONE notion of a chain's ATM contract: a contract qualifies when its
 * impliedVolatility is finite and > 0, its strikePrice is finite, and
 * its expirationDate parses; days-to-expiry is
 * ceil((expiry UTC midnight − now) / 86400000) and must be > 0 (an
 * expiry dated today or in the past is not eligible). The expected-
 * move helper then scales that same ATM IV by sqrt(days/365); this
 * derivation keeps the raw IV and pins the expiry first, because a
 * daily history must read the same (front) expiry every day rather
 * than whichever expiry happens to hold the single closest strike.
 *
 * Spot is the chain's own underlyingPrice (every screened contract
 * carries it). Returns null when nothing qualifies — the caller
 * records a failure, never a fabricated IV.
 */
export function deriveAtmIv(
  contracts: ReadonlyArray<AtmIvContract>,
  now: Date,
): AtmIvDerivation | null {
  let spot: number | null = null;
  for (const c of contracts) {
    if (typeof c.underlyingPrice === "number" && Number.isFinite(c.underlyingPrice) && c.underlyingPrice > 0) {
      spot = c.underlyingPrice;
      break;
    }
  }
  if (spot === null) return null;

  let nearestExpiryMs: number | null = null;
  let nearestExpiryDate: string | null = null;
  let nearestDte = 0;
  const usableByExpiry = new Map<string, AtmIvContract[]>();
  for (const contract of contracts) {
    const iv = contract.impliedVolatility;
    if (typeof iv !== "number" || !Number.isFinite(iv) || iv <= 0) continue;
    if (!Number.isFinite(contract.strikePrice)) continue;
    const expiryMs = Date.parse(`${contract.expirationDate}T00:00:00.000Z`);
    if (!Number.isFinite(expiryMs)) continue;
    const days = Math.ceil((expiryMs - now.getTime()) / 86_400_000);
    if (days <= 0) continue;
    if (nearestExpiryMs === null || expiryMs < nearestExpiryMs) {
      nearestExpiryMs = expiryMs;
      nearestExpiryDate = contract.expirationDate;
      nearestDte = days;
    }
    const bucket = usableByExpiry.get(contract.expirationDate);
    if (bucket) bucket.push(contract);
    else usableByExpiry.set(contract.expirationDate, [contract]);
  }
  if (nearestExpiryDate === null) return null;

  const atExpiry = usableByExpiry.get(nearestExpiryDate) ?? [];
  let bestStrike: number | null = null;
  let bestDistance = Infinity;
  for (const contract of atExpiry) {
    const distance = Math.abs(contract.strikePrice - spot);
    if (
      distance < bestDistance ||
      (distance === bestDistance && bestStrike !== null && contract.strikePrice < bestStrike)
    ) {
      bestDistance = distance;
      bestStrike = contract.strikePrice;
    }
  }
  if (bestStrike === null) return null;

  const ivs = atExpiry.filter((c) => c.strikePrice === bestStrike).map((c) => c.impliedVolatility as number);
  if (!ivs.length) return null;
  const atmIv = ivs.reduce((sum, v) => sum + v, 0) / ivs.length;
  return { atmIv, spot, expiryDate: nearestExpiryDate, dte: nearestDte };
}

/**
 * The tracked universe: curated ∪ watchlist symbols, trimmed,
 * uppercased, deduped, sorted — the one list the collector walks and
 * the read API summarizes. Pure and exported for tests.
 */
export function resolveTrackedSymbols(
  curatedSymbols: Iterable<string>,
  watchlistSymbols: Iterable<string>,
): string[] {
  const seen = new Set<string>();
  for (const raw of [...curatedSymbols, ...watchlistSymbols]) {
    const symbol = String(raw ?? "").trim().toUpperCase();
    if (symbol) seen.add(symbol);
  }
  return [...seen].sort();
}

/**
 * Flatten stored watchlists (WatchlistRecord-shaped rows) into their
 * raw symbol lists, tolerating malformed rows — a bad watchlist must
 * not break the day's collection or the coverage summary for everyone
 * else. Pure and exported for tests.
 */
export function flattenWatchlistSymbols(
  watchlists: ReadonlyArray<{ symbolsJson?: string | null }>,
): string[] {
  const symbols: string[] = [];
  for (const watchlist of watchlists) {
    try {
      const parsed = JSON.parse(watchlist.symbolsJson || "[]");
      if (Array.isArray(parsed)) {
        for (const s of parsed) {
          if (typeof s === "string") symbols.push(s);
        }
      }
    } catch {
      // Skip a watchlist whose symbolsJson is not valid JSON.
    }
  }
  return symbols;
}

/** What the chain fetcher returns for one symbol: the screened live
 *  contracts, plus the provider/screen reason when the fetch degraded
 *  (surfaced as the failure reason when no usable chain came back). */
export interface IvChainFetchResult {
  contracts: ScreenedOptionContractItem[];
  error?: string;
}

export type IvCollectionOutcomeStatus = "recorded" | "already_recorded" | "failed";

export interface IvCollectionOutcome {
  symbol: string;
  status: IvCollectionOutcomeStatus;
  /** Present when status is "failed": why no record exists for the
   *  day (provider error, empty chain, no usable ATM IV). */
  reason?: string;
}

export interface IvCollectionReport {
  /** The collection day (America/New_York) every outcome belongs to. */
  date: string;
  outcomes: IvCollectionOutcome[];
  recorded: number;
  alreadyRecorded: number;
  failed: number;
}

export interface CollectIvHistoryDeps {
  store: IvHistoryStore;
  /**
   * Issue #3326: which broker's chains this run reads. The observation is
   * stamped with it, so a series can never be served under a broker that did
   * not produce it. Required: a run that cannot name its source must not write.
   */
  broker: IvBroker;
  /** Live chain source — in production an OptionsDataAgent snapshot;
   *  in tests, a stub. May throw; a throw is one name's failure. */
  fetchChain: (symbol: string) => Promise<IvChainFetchResult>;
  curatedSymbols: Iterable<string>;
  watchlistSymbols: Iterable<string>;
  /** Collection instant (injectable for tests). Default: now. */
  now?: Date;
}

/**
 * Run one day's collection. Names are processed sequentially (the
 * scanner's per-symbol cadence — provider-friendly and the outcomes
 * stay in tracked order). A name already recorded for the day is
 * reported `already_recorded` WITHOUT a provider call: first write
 * wins, so refetching could only produce a value we'd refuse to
 * store. One name's failure never aborts the batch.
 */
export async function collectIvHistory(deps: CollectIvHistoryDeps): Promise<IvCollectionReport> {
  const now = deps.now ?? new Date();
  const date = nyDateString(now);
  const symbols = resolveTrackedSymbols(deps.curatedSymbols, deps.watchlistSymbols);
  const outcomes: IvCollectionOutcome[] = [];

  for (const symbol of symbols) {
    // One observation per (symbol, date) regardless of broker: the day's first
    // observation is the record, and a later broker's run reports
    // already_recorded instead of rewriting provenance.
    const existing = await deps.store.get(symbol, date);
    if (existing) {
      outcomes.push({ symbol, status: "already_recorded" });
      continue;
    }
    let fetched: IvChainFetchResult;
    try {
      fetched = await deps.fetchChain(symbol);
    } catch (err) {
      outcomes.push({
        symbol,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!fetched.contracts.length) {
      outcomes.push({
        symbol,
        status: "failed",
        reason: fetched.error ?? "chain returned no contracts",
      });
      continue;
    }
    const derived = deriveAtmIv(fetched.contracts, now);
    if (!derived) {
      outcomes.push({
        symbol,
        status: "failed",
        reason: fetched.error ?? "chain carried no usable ATM IV (no IV-bearing contract at a live expiry)",
      });
      continue;
    }
    const record: IvHistoryRecord = {
      symbol,
      broker: deps.broker,
      date,
      atmIv: derived.atmIv,
      spot: derived.spot,
      expiryDate: derived.expiryDate,
      dte: derived.dte,
      collectedAt: now.toISOString(),
    };
    const written = await deps.store.record(record);
    outcomes.push({ symbol, status: written ? "recorded" : "already_recorded" });
  }

  return {
    date,
    outcomes,
    recorded: outcomes.filter((o) => o.status === "recorded").length,
    alreadyRecorded: outcomes.filter((o) => o.status === "already_recorded").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}

/** One name's read-API view (GET /api/etrade/options/iv-history):
 *  the stored stats, verbatim — warming-up names report their
 *  computed rank/percentile WITH the flag, never hidden values. */
export interface IvHistoryEntry {
  symbol: string;
  observations: number;
  coveragePct: number;
  warmingUp: boolean;
  latest: {
    date: string;
    atmIv: number;
    spot: number;
    expiryDate: string;
    dte: number;
  } | null;
  ivRank: number | null;
  ivPercentile: number | null;
}

/** Build one name's read-API entry from the store (the route's whole
 *  logic for a single symbol, factored out for testing). A symbol
 *  with no records is a state, not an error: observations 0,
 *  warmingUp true, latest/rank/percentile null. */
export async function getIvHistoryEntry(
  store: IvHistoryStore,
  symbol: string,
  broker?: IvBroker,
): Promise<IvHistoryEntry> {
  const clean = symbol.trim().toUpperCase();
  const series = await store.listSeries(clean, broker ? { broker } : {});
  const stats: IvStats = computeIvStats(series);
  return {
    symbol: clean,
    observations: stats.observations,
    coveragePct: stats.coveragePct,
    warmingUp: stats.warmingUp,
    latest: stats.latest
      ? {
          date: stats.latest.date,
          atmIv: stats.latest.atmIv,
          spot: stats.latest.spot,
          expiryDate: stats.latest.expiryDate,
          dte: stats.latest.dte,
        }
      : null,
    ivRank: stats.ivRank,
    ivPercentile: stats.ivPercentile,
  };
}
