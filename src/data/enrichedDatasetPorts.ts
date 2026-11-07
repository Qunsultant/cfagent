/**
 * Issue #3536 (Pipeline J3, epic #3533) — the enriched-dataset
 * port: one enrich job's persisted output — the feed dataset's
 * rows with the derived elements the job's configuration named,
 * plus the run record of the run that produced them and the
 * exact provenance of the persisted input they were computed
 * from.
 *
 * WHY A SIBLING STORE, not a dataset value in the feed-dataset
 * store (feedDatasetPorts.ts): that family's artifact is the
 * provider's verbatim copy (quotes / fundamentals rows exactly
 * as returned). An enriched artifact is a DERIVED product — its
 * rows carry computed features, its provenance names the input
 * artifact it consumed, and its honesty obligations differ (an
 * element the persisted inputs cannot support is recorded as
 * unavailable with a reason, never fabricated). Forcing derived
 * rows into the verbatim-copy shape would blur exactly the line
 * the feed seam exists to hold. This is the feed-dataset
 * precedent (itself the index-list precedent) applied again: a
 * sibling family reusing the seam's idiom — one artifact per
 * store, asOf + provenance on every artifact, run records on
 * the artifacts, results carry descriptors not bytes.
 *
 * KEYING: by enrich job id. The feed store buckets by (source,
 * dataset); an enrich job is the precise identity of a derived
 * product (one feed job, one configuration), so latest() here
 * is exact — no bucket sharing between the Nasdaq-100 and
 * S&P 100 enrich jobs of the same source.
 *
 * FOUNDATION: this family is a CDO data-foundation family
 * (#3548 pattern, per the J3 build contract): the table is
 * declared in src/data/drizzleSchema.ts with DDL authority
 * migration 0051 (src/data/migrationRunner.ts); adapters are
 * doSqliteEnrichedDatasetAdapter.ts (DO SQLite, Repository
 * core), d1EnrichedDatasetAdapter.ts (D1, drizzle — the
 * production residency, since analyze-stage readers run in
 * other instances than the writer), and
 * inMemoryEnrichedDatasetAdapter.ts (test double). This module
 * carries the record types and the port interface ONLY
 * (ADR 0002 R1/R2).
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetRunStatus,
  FeedDatasetRunTrigger,
  FeedDatasetUniverse,
} from "./feedDatasetPorts";

export type EnrichedDatasetRunStatus = FeedDatasetRunStatus;
export type EnrichedDatasetRunTrigger = FeedDatasetRunTrigger;

/** DO-SQLite / D1 table name for the enriched-dataset store. */
export const ENRICHED_DATASETS_TABLE = "job_enriched_datasets";

/** One enrich run's outcome — the record the status surface renders. */
export interface EnrichedDatasetRunRecord {
  runId: string;
  trigger: EnrichedDatasetRunTrigger;
  startedAt: string;
  finishedAt: string;
  status: EnrichedDatasetRunStatus;
  /** Symbols the run set out to enrich (the input copy's rows). */
  requested: number;
  /** Symbols the run produced an enriched row for. */
  received: number;
  /** requested - received. */
  failed: number;
  missingSymbols: string[];
  /** Stable coded error on a failed run; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message on a failed run; null otherwise. */
  errorMessage: string | null;
}

/** One element the run could not compute, and the coded reason. */
export interface EnrichedElementGap {
  element: string;
  /** Coded reason (e.g. "requires_daily_bar_history"). */
  reason: string;
  /** Symbols the gap applies to; empty ⇒ the whole artifact. */
  symbols: string[];
}

/** One symbol's enriched row: the quote's identity + price, and
 *  the feature values the configuration named. Feature values
 *  are numbers/strings computed from the persisted inputs —
 *  an element absent from `features` appears in the artifact's
 *  gaps (or the row's own gap list) with its reason. */
export interface EnrichedDatasetRow {
  symbol: string;
  /** The input quote's last price (the value features derive from). */
  lastPrice: number;
  /** Computed elements, by element name. */
  features: Record<string, number | string>;
  /** Elements requested for this symbol but not computable from
   *  the persisted inputs (names only; reasons ride the
   *  artifact-level gaps). */
  unavailable: string[];
}

export interface EnrichedDatasetArtifact {
  id: string;
  /** The enrich job that produced this artifact. */
  jobId: string;
  /** The feed job whose persisted dataset this run consumed. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The input dataset id within the source (e.g. "quotes"). */
  dataset: string;
  universe: FeedDatasetUniverse;
  /** The input artifact consumed — exact lineage, never a guess. */
  inputArtifactId: string;
  /** The feed run that produced the input artifact. */
  inputRunId: string;
  /** The input copy's asOf (when the feed data was fetched). */
  inputAsOf: string;
  /** The elements this run computed (the configuration's set). */
  elements: string[];
  /** Elements the persisted inputs could not support, with reasons. */
  gaps: EnrichedElementGap[];
  /** Per-element coverage: rows computed vs rows unavailable. */
  elementCoverage: Record<string, { computed: number; unavailable: number }>;
  rows: EnrichedDatasetRow[];
  run: EnrichedDatasetRunRecord;
  createdAt: string;
}

export interface EnrichedDatasetStoreOptions {
  idFactory?: () => string;
  /** Artifacts kept per enrich job after each store. Default 10. */
  keepPerJob?: number;
}

export type EnrichedDatasetStoreInput = Omit<
  EnrichedDatasetArtifact,
  "id" | "createdAt"
> & {
  /** Injectable clock (tests); defaults to now. */
  nowIso?: string;
};

/** The enriched-dataset store port (reader + the write side). */
export interface EnrichedDatasetStore {
  /** Store one run's artifact and prune to the newest
   *  keepPerJob rows for its enrich job. */
  store(input: EnrichedDatasetStoreInput): Promise<EnrichedDatasetArtifact>;
  /** The newest artifact for the enrich job — the LAST RUN,
   *  whatever its outcome; undefined when the job has never run. */
  latest(jobId: string): Promise<EnrichedDatasetArtifact | undefined>;
  /** The newest artifact a reader may serve: completed or
   *  partial with at least one row. A failed run never poisons
   *  reads. */
  latestUsable(jobId: string): Promise<EnrichedDatasetArtifact | undefined>;
  /** Run history for the enrich job, newest first. */
  listRuns(jobId: string, limit?: number): Promise<EnrichedDatasetArtifact[]>;
}

/** Newest-first ordering shared by every adapter: createdAt
 *  descending, then id descending (ids are unique; the feed
 *  family's D1 ordering rule). */
export function compareEnrichedArtifactsNewestFirst(
  a: EnrichedDatasetArtifact,
  b: EnrichedDatasetArtifact,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Whether a stored artifact may be served to readers. */
export function isUsableEnrichedArtifact(
  artifact: EnrichedDatasetArtifact,
): boolean {
  return artifact.run.status !== "failed" && artifact.rows.length > 0;
}
