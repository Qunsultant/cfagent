/**
 * Issue #3537 (Pipeline J4, epic #3533) — the analyzed-dataset
 * port: one analyze job's persisted output — the enriched
 * dataset's rows with the analysis verdicts the job's
 * configured rule sets produced, plus the run record of the
 * run that produced them and the exact provenance of the
 * persisted enriched input they were computed from.
 *
 * WHY A SIBLING STORE, not a dataset value in the enriched
 * store (enrichedDatasetPorts.ts): that family's artifact is
 * the enrich stage's derived product — rows carrying computed
 * FEATURES. An analyzed artifact is a further derivation —
 * its rows carry rule VERDICTS (signals + scores) over those
 * features, its provenance names the enriched artifact it
 * consumed, and its honesty obligations are the analysis
 * stage's own (a rule set the persisted features cannot
 * support is recorded as unavailable with a reason, never
 * fabricated). This is the feed-dataset → enriched-dataset
 * precedent applied again: a sibling family reusing the
 * seam's idiom — one artifact per store, asOf + provenance
 * on every artifact, run records on the artifacts, results
 * carry descriptors not bytes.
 *
 * KEYING: by analyze job id. An analyze job is the precise
 * identity of an analysis product (one enrich job, one
 * configuration), so latest() here is exact — no bucket
 * sharing between the analyze jobs of the same source.
 *
 * FOUNDATION: this family is a CDO data-foundation family
 * (#3548 pattern, per the J4 build contract): the table is
 * declared in src/data/drizzleSchema.ts with DDL authority
 * migration 0052 (src/data/migrationRunner.ts); adapters are
 * doSqliteAnalyzedDatasetAdapter.ts (DO SQLite, Repository
 * core), d1AnalyzedDatasetAdapter.ts (D1, drizzle — the
 * production residency, since the generate stage's readers
 * run in other instances than the writer), and
 * inMemoryAnalyzedDatasetAdapter.ts (test double). This module
 * carries the record types and the port interface ONLY
 * (ADR 0002 R1/R2).
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetRunStatus,
  FeedDatasetRunTrigger,
  FeedDatasetUniverse,
} from "./feedDatasetPorts";

export type AnalyzedDatasetRunStatus = FeedDatasetRunStatus;
export type AnalyzedDatasetRunTrigger = FeedDatasetRunTrigger;

/** DO-SQLite / D1 table name for the analyzed-dataset store. */
export const ANALYZED_DATASETS_TABLE = "job_analyzed_datasets";

/** One analyze run's outcome — the record the status surface renders. */
export interface AnalyzedDatasetRunRecord {
  runId: string;
  trigger: AnalyzedDatasetRunTrigger;
  startedAt: string;
  finishedAt: string;
  status: AnalyzedDatasetRunStatus;
  /** Symbols the run set out to analyze (the input copy's rows). */
  requested: number;
  /** Symbols the run produced an analyzed row for. */
  received: number;
  /** requested - received. */
  failed: number;
  /** Stable coded error on a failed run; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message on a failed run; null otherwise. */
  errorMessage: string | null;
}

/** One rule set the run could not evaluate, and the coded reason. */
export interface AnalyzedRuleGap {
  /** The rule set's name (the configuration's vocabulary). */
  ruleSet: string;
  /** Coded reason (e.g. "feature_not_in_artifact"). */
  reason: string;
  /** Symbols the gap applies to; empty ⇒ the whole artifact. */
  symbols: string[];
}

/** One symbol's analyzed row: the enriched row's identity +
 *  price, the per-rule-set verdicts the configuration named,
 *  and the composite over the rule sets that evaluated.
 *  A rule set absent from `signals`/`scores` appears in the
 *  artifact's gaps (or the row's own unavailable list) with
 *  its reason — never a fabricated verdict. */
export interface AnalyzedDatasetRow {
  symbol: string;
  /** The input enriched row's last price. */
  lastPrice: number;
  /** Verdict label per rule set (e.g. momentum → "strong_up"). */
  signals: Record<string, string>;
  /** Numeric score per rule set, in [-100, 100]. */
  scores: Record<string, number>;
  /** Weighted composite over the rule sets that evaluated
   *  for this symbol; null when none did. */
  compositeScore: number | null;
  /** Rule sets requested for this symbol but not evaluable
   *  from the persisted features (names only; reasons ride
   *  the artifact-level gaps). */
  unavailable: string[];
}

/** Universe-level aggregates over the analyzed rows — every
 *  value a deterministic computation over the persisted rows,
 *  recorded so the generate stage (and the surfaces) never
 *  recompute them from a different copy. */
export interface AnalyzedDatasetSummary {
  /** Rows analyzed. */
  symbols: number;
  /** Rows whose momentum feature is positive / negative / zero. */
  advancers: number;
  decliners: number;
  flat: number;
  /** Mean of the momentum feature over rows carrying it; null when none do. */
  meanMomentum: number | null;
  /** Mean composite over rows with a composite; null when none have one. */
  meanCompositeScore: number | null;
  /** Highest composites, best first (at most 5). */
  topByComposite: Array<{ symbol: string; score: number }>;
  /** Lowest composites, worst first (at most 5). */
  bottomByComposite: Array<{ symbol: string; score: number }>;
}

export interface AnalyzedDatasetArtifact {
  id: string;
  /** The analyze job that produced this artifact. */
  jobId: string;
  /** The enrich job whose persisted artifact this run consumed. */
  enrichJobId: string;
  /** The feed job at the head of this artifact's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source (e.g. "quotes"). */
  dataset: string;
  universe: FeedDatasetUniverse;
  /** The enriched artifact consumed — exact lineage, never a guess. */
  inputArtifactId: string;
  /** The enrich run that produced the input artifact. */
  inputRunId: string;
  /** The input copy's creation time (when the enrich run persisted it). */
  inputAsOf: string;
  /** The rule sets this run evaluated (the configuration's set). */
  ruleSets: string[];
  /** Rule sets the persisted features could not support, with reasons. */
  gaps: AnalyzedRuleGap[];
  /** Per-rule-set coverage: rows evaluated vs rows unavailable. */
  ruleCoverage: Record<string, { evaluated: number; unavailable: number }>;
  /** Universe aggregates over the analyzed rows. */
  summary: AnalyzedDatasetSummary;
  rows: AnalyzedDatasetRow[];
  run: AnalyzedDatasetRunRecord;
  createdAt: string;
}

export interface AnalyzedDatasetStoreOptions {
  idFactory?: () => string;
  /** Artifacts kept per analyze job after each store. Default 10. */
  keepPerJob?: number;
}

export type AnalyzedDatasetStoreInput = Omit<
  AnalyzedDatasetArtifact,
  "id" | "createdAt"
> & {
  /** Injectable clock (tests); defaults to now. */
  nowIso?: string;
};

/** The analyzed-dataset store port (reader + the write side). */
export interface AnalyzedDatasetStore {
  /** Store one run's artifact and prune to the newest
   *  keepPerJob rows for its analyze job. */
  store(input: AnalyzedDatasetStoreInput): Promise<AnalyzedDatasetArtifact>;
  /** The newest artifact for the analyze job — the LAST RUN,
   *  whatever its outcome; undefined when the job has never run. */
  latest(jobId: string): Promise<AnalyzedDatasetArtifact | undefined>;
  /** The newest artifact a reader may serve: completed or
   *  partial with at least one row. A failed run never poisons
   *  reads. */
  latestUsable(jobId: string): Promise<AnalyzedDatasetArtifact | undefined>;
  /** Run history for the analyze job, newest first. */
  listRuns(jobId: string, limit?: number): Promise<AnalyzedDatasetArtifact[]>;
}

/** Newest-first ordering shared by every adapter: createdAt
 *  descending, then id descending (ids are unique; the feed
 *  family's D1 ordering rule). */
export function compareAnalyzedArtifactsNewestFirst(
  a: AnalyzedDatasetArtifact,
  b: AnalyzedDatasetArtifact,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Whether a stored artifact may be served to readers. */
export function isUsableAnalyzedArtifact(
  artifact: AnalyzedDatasetArtifact,
): boolean {
  return artifact.run.status !== "failed" && artifact.rows.length > 0;
}
