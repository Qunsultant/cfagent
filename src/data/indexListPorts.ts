/**
 * Issue #1980 (follow-up to #1852) — the stored index-list port.
 *
 * #1852 fetches live on every call, stores nothing, and has no
 * production consumer. This port is the stored side: one artifact
 * per (index, snapshotDate) — symbols + source + sourceLabel —
 * shaped on the #1236 feed seam (idempotent creation +
 * single-line statements on the SQL adapters; asOf/snapshotDate +
 * provenance/source label on every artifact; job results carry
 * descriptors, NOT bytes — see indexListProducer.ts /
 * indexListJob.ts).
 *
 * Why a SIBLING store, not an extension of the feed-snapshot
 * store: feed artifacts are per-(user, symbol) options snapshots;
 * index lists are deployment-global per-index datasets. Keying
 * them by userLogin would duplicate one shared list per user and
 * conflate two datasets with different owners and retention.
 * The sibling reuses the seam's idiom and its executor shape,
 * never a second feed system and never a second aggregation
 * pipeline — the producer still fetches only through the #1852
 * port adapters.
 *
 * This module carries the record types and the port interface
 * ONLY (ADR 0002 R1/R2). Adapters:
 * inMemoryIndexListAdapter.ts (test double),
 * doSqliteIndexListAdapter.ts (DO SQLite, feed-seam shape),
 * d1IndexListAdapter.ts (D1, raw prepare/bind — the
 * d1QuoteSourceAdapter pattern, not Drizzle: one table, four
 * statements).
 *
 * The port is ASYNC, unlike the feed-snapshot port: the D1
 * adapter is async by nature, and forcing a sync shape would
 * exclude it. Callers are jobs and resolvers, never the
 * discovery hot path, so async costs nothing here.
 */
import type { IndexId, IndexMember } from "../trading";

/** One stored index list: the unit the refresh job writes and the consumer reads. */
export interface IndexListArtifact {
  id: string;
  index: IndexId;
  /** YYYY-MM-DD: fetch date for Wikipedia, as-of date for holdings files (the #1852 rule). */
  snapshotDate: string;
  symbols: IndexMember[];
  /** Adapter id: "wikipedia" or the ETF ticker (lowercase, e.g. "iwm"). */
  source: string;
  /** Human label; holdings-derived results say so, never "official". */
  sourceLabel: string;
  /** True when the list came from a fund holdings file, not a table. */
  derivedFromHoldings: boolean;
  createdAt: string;
}

/** The stored index-list port (reader + the write side). */
export interface IndexListStore {
  /** Store one artifact and prune to the newest keepPerIndex rows
   *  for its index — the INSERT + prune pair is one unit on the
   *  SQL adapters at this volume (per-row DELETEs, the feed-seam
   *  idiom: the shared mock does not evaluate NOT IN subqueries). */
  store(input: {
    index: IndexId;
    snapshotDate: string;
    symbols: IndexMember[];
    source: string;
    sourceLabel: string;
    derivedFromHoldings: boolean;
    nowIso?: string;
  }): Promise<IndexListArtifact>;
  /** The newest stored artifact for an index, or undefined when none exists. */
  latest(index: IndexId): Promise<IndexListArtifact | undefined>;
}

export interface IndexListStoreOptions {
  idFactory?: () => string;
  /** Rows kept per index after each store. Default 10 (the feed-seam default). */
  keepPerIndex?: number;
}

/** The SQL executor shape the DO-SQLite adapter runs over (the feed-seam shape). */
export interface IndexListSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
