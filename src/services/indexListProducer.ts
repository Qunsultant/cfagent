/**
 * Issue #1980 — the stored index-list producer: fetch one index
 * through the #1852 port (injected service — the producer never
 * touches the network directly) and store it as one artifact.
 *
 * Honesty rules, the feed producer's rules carried over:
 * - A failed fetch is NEVER stored as an artifact: the throw
 *   propagates before any store call.
 * - A zero-member result is refused, not stored: an empty list
 *   is not a dataset, it is a broken fetch wearing a snapshot
 *   date. (#1852's adapters already refuse empty tables/files;
 *   this is the second, producer-side guard for adapters that
 *   do not.)
 * - The descriptor carries counts, NOT bytes: symbols live in
 *   the store, never in a job result.
 */
import type {
  IndexListStore,
} from "../data/indexListPorts";
import type {
  IndexId,
  IndexMembershipPort,
} from "../trading/indexMembership";

export interface IndexListDescriptor {
  artifactId: string;
  index: IndexId;
  snapshotDate: string;
  source: string;
  sourceLabel: string;
  memberCount: number;
}

/** A service shape is any port: the producer fetches one index through it. */
export type IndexListFetchService = Pick<IndexMembershipPort, "getMembers">;

export async function produceIndexListSnapshot(args: {
  store: IndexListStore;
  /** #1852 service (or a single adapter) — fetchers injected, never network here. */
  service: IndexListFetchService;
  index: IndexId;
  nowIso?: string;
}): Promise<IndexListDescriptor> {
  const membership = await args.service.getMembers(args.index);
  if (!membership.symbols || membership.symbols.length === 0) {
    throw new Error(
      `Index list for ${args.index} not stored: zero-member result — refusing an empty list`,
    );
  }
  const stored = await args.store.store({
    index: membership.index,
    snapshotDate: membership.snapshotDate,
    symbols: membership.symbols,
    source: membership.source,
    sourceLabel: membership.sourceLabel,
    derivedFromHoldings: membership.derivedFromHoldings,
    nowIso: args.nowIso,
  });
  return {
    artifactId: stored.id,
    index: stored.index,
    snapshotDate: stored.snapshotDate,
    source: stored.source,
    sourceLabel: stored.sourceLabel,
    memberCount: stored.symbols.length,
  };
}
