/**
 * Issue #3538 (Pipeline J5, epic #3533) — the generated-dataset
 * port: one generate job's persisted output — the reports the
 * job rendered from the PERSISTED analyzed dataset its analyze
 * job produced (in every configured format), the canonical
 * report-store leg's outcome per report, plus the run record
 * of the run that produced them and the exact provenance of
 * the analyzed input they were generated from.
 *
 * WHY A SIBLING STORE, not a dataset value in the analyzed
 * store (analyzedDatasetPorts.ts) and not mas_reports rows:
 * - The analyzed family's artifact is the analysis stage's
 *   product — rows carrying rule verdicts. A generated
 *   artifact is a further derivation — rendered REPORTS (a
 *   different artifact kind, with per-format bodies and its
 *   own honesty obligations: a format that cannot be rendered
 *   is recorded failed with a coded reason, never fabricated).
 * - mas_reports (services/scheduledReports.ts, the canonical
 *   report copy) cannot be this store: its write seam refuses
 *   owner-less writes (every row belongs to exactly one
 *   tenant login), it is keyed by (user_login, generation_id),
 *   and it is resident in per-login Orchestrator DOs — while a
 *   pipeline generate run is a system run on the job plane
 *   (ScheduledAgent host / workflow residencies), carries no
 *   report-owning tenant, and its hand-off record must be
 *   readable by the deliver stage (J6) from other instances
 *   by job id. Where the canonical seam's preconditions DO
 *   fit (a host binds a tenant's report store + owner), the
 *   generate run ALSO stores each report through that seam and
 *   records the canonical outcome per report (see
 *   GeneratedCanonicalRecord) — the fan-out's per-leg outcome
 *   discipline (#2347) applied to this stage's canonical leg.
 *
 * KEYING: by generate job id. A generate job is the precise
 * identity of a generation product (one analyze job, one
 * configuration), so latest() here is exact — no bucket
 * sharing between the generate jobs of the same source.
 *
 * FOUNDATION: this family is a CDO data-foundation family
 * (#3548 pattern, per the J5 build contract): the table is
 * declared in src/data/drizzleSchema.ts with DDL authority
 * migration 0056 (src/data/migrationRunner.ts); adapters are
 * doSqliteGeneratedDatasetAdapter.ts (DO SQLite, Repository
 * core), d1GeneratedDatasetAdapter.ts (D1, drizzle — the
 * production residency, since the deliver stage's readers run
 * in other instances than the writer), and
 * inMemoryGeneratedDatasetAdapter.ts (test double). This module
 * carries the record types and the port interface ONLY
 * (ADR 0002 R1/R2).
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetRunStatus,
  FeedDatasetRunTrigger,
  FeedDatasetUniverse,
} from "./feedDatasetPorts";

export type GeneratedDatasetRunStatus = FeedDatasetRunStatus;
export type GeneratedDatasetRunTrigger = FeedDatasetRunTrigger;

/** DO-SQLite / D1 table name for the generated-dataset store. */
export const GENERATED_DATASETS_TABLE = "job_generated_datasets";

/** One generate run's outcome — the record the status surface renders. */
export interface GeneratedDatasetRunRecord {
  runId: string;
  trigger: GeneratedDatasetRunTrigger;
  startedAt: string;
  finishedAt: string;
  status: GeneratedDatasetRunStatus;
  /** Report × format pairs the run set out to generate. */
  requested: number;
  /** Report × format pairs the run generated. */
  received: number;
  /** requested - received. */
  failed: number;
  /** Stable coded error on a failed run; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message on a failed run; null otherwise. */
  errorMessage: string | null;
}

/**
 * One rendered format of one report. A format the run could
 * not produce is status "failed" with its coded reason — the
 * body fields stay null; a format is never dressed up as
 * generated without its body.
 */
export interface GeneratedFormatRecord {
  /** The format's name (the configuration's vocabulary). */
  format: string;
  status: "generated" | "failed";
  contentType: string;
  /** The rendered body for text formats (json/markdown/csv); null for binary. */
  bodyText: string | null;
  /** The rendered body, base64, for binary formats (pdf); null for text. */
  bodyBase64: string | null;
  /** The body's size in bytes (the decoded size for binary). */
  sizeBytes: number;
  /** Stable coded error when status is "failed"; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message when failed; null otherwise. */
  errorMessage: string | null;
}

/**
 * The canonical report-store leg's outcome for one report
 * (the #2347 per-leg discipline): the report was ALSO stored
 * through the canonical seam (mas_reports) when a host wired
 * it for a report-owning tenant — "stored" (a new canonical
 * row) or "deduped" (the seam's generation-id idempotency
 * returned the existing row). Where no host wiring fits, the
 * leg is "not_wired" with its coded reason — recorded, never
 * silently skipped, and never claimed as stored. A wired seam
 * that returned no row is "failed" with its reason.
 */
export interface GeneratedCanonicalRecord {
  status: "stored" | "deduped" | "not_wired" | "failed";
  /** The canonical mas_reports row id when stored/deduped; null otherwise. */
  reportId: string | null;
  /** The canonical fan-out outcome code when stored/deduped; null otherwise. */
  fanoutCode: string | null;
  /** Coded reason when not_wired / failed; null otherwise. */
  reason: string | null;
}

/** One generated report: its rendered formats + canonical leg. */
export interface GeneratedReportRecord {
  /** The report kind (the configuration's vocabulary). */
  kind: string;
  /** The report's human title. */
  title: string;
  formats: GeneratedFormatRecord[];
  canonical: GeneratedCanonicalRecord;
}

/** Artifact-level tallies over the generated reports — every
 *  value a deterministic count over the records above. */
export interface GeneratedDatasetSummary {
  /** Reports with at least one generated format. */
  reportsGenerated: number;
  /** Format bodies generated, across all reports. */
  formatsGenerated: number;
  /** Format bodies that failed, across all reports. */
  formatsFailed: number;
  /** Reports whose canonical leg stored or deduped a row. */
  canonicalStored: number;
  /** Reports whose canonical leg was not wired on this host. */
  canonicalNotWired: number;
}

export interface GeneratedDatasetArtifact {
  id: string;
  /** The generate job that produced this artifact. */
  jobId: string;
  /** The analyze job whose persisted artifact this run consumed. */
  analyzeJobId: string;
  /** The enrich job upstream of the analyze job. */
  enrichJobId: string;
  /** The feed job at the head of this artifact's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source (e.g. "quotes"). */
  dataset: string;
  universe: FeedDatasetUniverse;
  /** The analyzed artifact consumed — exact lineage, never a guess. */
  inputArtifactId: string;
  /** The analyze run that produced the input artifact. */
  inputRunId: string;
  /** The input copy's creation time (when the analyze run persisted it). */
  inputAsOf: string;
  /** The report kinds this run generated (the configuration's set). */
  reportsRequested: string[];
  /** The formats this run rendered (the configuration's set). */
  formatsRequested: string[];
  /** The generated reports, in configuration order. */
  reports: GeneratedReportRecord[];
  /** Tallies over the generated reports. */
  summary: GeneratedDatasetSummary;
  run: GeneratedDatasetRunRecord;
  createdAt: string;
}

export interface GeneratedDatasetStoreOptions {
  idFactory?: () => string;
  /** Artifacts kept per generate job after each store. Default 10. */
  keepPerJob?: number;
}

export type GeneratedDatasetStoreInput = Omit<
  GeneratedDatasetArtifact,
  "id" | "createdAt"
> & {
  /** Injectable clock (tests); defaults to now. */
  nowIso?: string;
};

/** The generated-dataset store port (reader + the write side). */
export interface GeneratedDatasetStore {
  /** Store one run's artifact and prune to the newest
   *  keepPerJob rows for its generate job. */
  store(input: GeneratedDatasetStoreInput): Promise<GeneratedDatasetArtifact>;
  /** The newest artifact for the generate job — the LAST RUN,
   *  whatever its outcome; undefined when the job has never run. */
  latest(jobId: string): Promise<GeneratedDatasetArtifact | undefined>;
  /** The newest artifact a reader may serve: not failed, with
   *  at least one generated format body. A failed run never
   *  poisons reads. */
  latestUsable(jobId: string): Promise<GeneratedDatasetArtifact | undefined>;
  /** Run history for the generate job, newest first. */
  listRuns(jobId: string, limit?: number): Promise<GeneratedDatasetArtifact[]>;
}

/** Newest-first ordering shared by every adapter: createdAt
 *  descending, then id descending (ids are unique; the feed
 *  family's D1 ordering rule). */
export function compareGeneratedArtifactsNewestFirst(
  a: GeneratedDatasetArtifact,
  b: GeneratedDatasetArtifact,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Format bodies a stored artifact actually generated. */
export function generatedFormatCount(artifact: GeneratedDatasetArtifact): number {
  return artifact.reports.reduce(
    (sum, report) =>
      sum + report.formats.filter((f) => f.status === "generated").length,
    0,
  );
}

/** Whether a stored artifact may be served to readers. */
export function isUsableGeneratedArtifact(
  artifact: GeneratedDatasetArtifact,
): boolean {
  return artifact.run.status !== "failed" && generatedFormatCount(artifact) > 0;
}
