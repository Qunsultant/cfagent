/**
 * Issue #1980 — the stored-list consumer: resolve an index to
 * its latest fresh stored list and feed the screener as
 * opts.symbols. The #1852 live path (screenIndexMembers) is
 * untouched — this is the stored path alongside it, not a
 * replacement: no endpoint removed, no screener/quote/provider
 * behavior change beyond accepting stored lists as input.
 *
 * Staleness is never silent, the #1852 rule carried over:
 * - resolveStoredIndexList reports { hit, stale } or { missing }
 *   — a missing list is a named outcome, never a live fallback.
 * - requireFreshStored throws StaleIndexMembershipError on a
 *   stale list (the loud refusal).
 * - withStalenessFlagStored labels the list instead (the
 *   flagged path).
 * Freshness budgets are the #1852 defaults (Wikipedia 10 days,
 * holdings 3 days) unless the caller passes maxAgeDays.
 */
import type { IndexListStore } from "../data/indexListPorts";
// Boundary (#290): trading is imported ONLY through its barrel
// (src/trading/index.ts) — never a trading-internal path.
import {
  DEFAULT_MAX_AGE_DAYS,
  DynamicMarketScreener,
  acquireUniverse,
  isStaleSnapshot,
  membersToListings,
  screenUniverse,
  StaleIndexMembershipError,
  type IndexId,
  type IndexMembership,
  type QuoteScreenerDeps,
} from "../trading";
import type { StockScreenerFilter } from "../types";

export type StoredIndexListResolution =
  | { status: "hit"; membership: IndexMembership; stale: boolean }
  | { status: "missing"; reason: string };

/** Convert a stored artifact to the #1852 membership shape (same fields, same labels). */
export function artifactToMembership(artifact: {
  index: IndexId;
  snapshotDate: string;
  symbols: IndexMembership["symbols"];
  source: string;
  sourceLabel: string;
  derivedFromHoldings: boolean;
}): IndexMembership {
  return {
    index: artifact.index,
    snapshotDate: artifact.snapshotDate,
    symbols: artifact.symbols,
    source: artifact.source,
    sourceLabel: artifact.sourceLabel,
    derivedFromHoldings: artifact.derivedFromHoldings,
  };
}

/** Default freshness budget for a stored list, by its source family. */
export function defaultMaxAgeDaysFor(membership: IndexMembership): number {
  return membership.derivedFromHoldings
    ? DEFAULT_MAX_AGE_DAYS.holdings
    : DEFAULT_MAX_AGE_DAYS.wikipedia;
}

export async function resolveStoredIndexList(args: {
  store: IndexListStore;
  index: IndexId;
  /** Days before a snapshot counts stale; absent ⇒ the #1852 source-family default. */
  maxAgeDays?: number;
  now?: string;
}): Promise<StoredIndexListResolution> {
  const artifact = await args.store.latest(args.index);
  if (!artifact) {
    return {
      status: "missing",
      reason: `no stored index list for ${args.index}: refresh has not stored one yet — refusing a live fallback`,
    };
  }
  const membership = artifactToMembership(artifact);
  const maxAgeDays = args.maxAgeDays ?? defaultMaxAgeDaysFor(membership);
  const stale = isStaleSnapshot(membership.snapshotDate, maxAgeDays, args.now);
  return { status: "hit", membership, stale };
}

/** Refuse a stale stored list loudly instead of serving it silently. */
export function requireFreshStored(
  membership: IndexMembership,
  maxAgeDays: number,
  now?: string,
): IndexMembership {
  if (isStaleSnapshot(membership.snapshotDate, maxAgeDays, now)) {
    throw new StaleIndexMembershipError(membership.index, membership.snapshotDate, maxAgeDays);
  }
  return { ...membership, stale: false };
}

/** Flag a stale stored list without refusing it (labelled, never silent). */
export function withStalenessFlagStored(
  membership: IndexMembership,
  maxAgeDays: number,
  now?: string,
): IndexMembership {
  return {
    ...membership,
    stale: isStaleSnapshot(membership.snapshotDate, maxAgeDays, now),
  };
}

/**
 * Consumer acceptance proof, stored side: resolve the latest
 * stored list, require it fresh, and screen it as opts.symbols
 * through the existing pipeline — unchanged. A missing list or
 * a stale list throws before any quote is fetched.
 */
export async function screenStoredIndexList(args: {
  store: IndexListStore;
  index: IndexId;
  maxAgeDays?: number;
  now?: string;
  filter?: StockScreenerFilter;
  quoteDeps: QuoteScreenerDeps;
  maxSymbols?: number;
}) {
  const resolved = await resolveStoredIndexList({
    store: args.store,
    index: args.index,
    maxAgeDays: args.maxAgeDays,
    now: args.now,
  });
  if (resolved.status === "missing") {
    throw new Error(`Cannot screen ${args.index} from stored list: ${resolved.reason}`);
  }
  const maxAgeDays = args.maxAgeDays ?? defaultMaxAgeDaysFor(resolved.membership);
  const fresh = requireFreshStored(resolved.membership, maxAgeDays, args.now);
  const acquired = await acquireUniverse({
    mode: "live-quotes",
    symbols: membersToListings(fresh),
    maxSymbols: args.maxSymbols,
    quoteDeps: args.quoteDeps,
  });
  return screenUniverse(new DynamicMarketScreener(), acquired, args.filter ?? {});
}
