/**
 * Issue #3539 (Pipeline J6, epic #3533) — the delivery-dataset
 * port: one deliver job's persisted output — the per-channel
 * delivery outcomes for the reports its generate job persisted
 * (in the generated-dataset store), plus the run record of the
 * run that produced them and the exact provenance of the
 * generated input they delivered.
 *
 * WHY A SIBLING STORE, not a value in the generated store
 * (generatedDatasetPorts.ts) and not the channels' own logs:
 * - The generated family's artifact is the generate stage's
 *   product — rendered reports. A delivery artifact is a
 *   further derivation — the OUTCOME of pushing those reports
 *   over the platform's channels (Slack, email, webhook, the
 *   UX surfaces), one record per (report, channel) pair, with
 *   its own honesty obligations: a channel that cannot be
 *   attempted is recorded not_configured with a coded reason,
 *   never dressed up as delivered; a failed channel is
 *   recorded failed and retries independently of the others.
 * - The channels' own machinery (the screener Slack sender,
 *   the EmailSender port, the outbound webhook service) keeps
 *   no per-run outcome record the pipeline can resume from —
 *   and resume is this family's reason to exist: a re-run of a
 *   deliver job over the SAME persisted generated artifact
 *   consults listForInput and re-delivers only the pairs no
 *   earlier run delivered, so a completed channel is never
 *   delivered twice for the same generated copy.
 *
 * KEYING: by deliver job id. A deliver job is the precise
 * identity of a delivery product (one generate job, one
 * channel configuration), so latest() here is exact — no
 * bucket sharing between the deliver jobs of the same source.
 * The input artifact id is a denormalized column so the
 * resume lookup (listForInput) is an exact query in every
 * residency, never a scan-and-parse.
 *
 * FOUNDATION: this family is a CDO data-foundation family
 * (#3548 pattern, per the J6 build contract): the table is
 * declared in src/data/drizzleSchema.ts with DDL authority
 * migration 0057 (src/data/migrationRunner.ts); adapters are
 * doSqliteDeliveryDatasetAdapter.ts (DO SQLite, Repository
 * core), d1DeliveryDatasetAdapter.ts (D1, drizzle — the
 * production residency, since the status surfaces' readers
 * run in other instances than the writer), and
 * inMemoryDeliveryDatasetAdapter.ts (test double). This
 * module carries the record types and the port interface
 * ONLY (ADR 0002 R1/R2).
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetRunStatus,
  FeedDatasetRunTrigger,
  FeedDatasetUniverse,
} from "./feedDatasetPorts";

export type DeliveryDatasetRunStatus = FeedDatasetRunStatus;
export type DeliveryDatasetRunTrigger = FeedDatasetRunTrigger;

/** DO-SQLite / D1 table name for the delivery-dataset store. */
export const DELIVERY_DATASETS_TABLE = "job_delivery_datasets";

/** One deliver run's outcome — the record the status surface renders. */
export interface DeliveryDatasetRunRecord {
  runId: string;
  trigger: DeliveryDatasetRunTrigger;
  startedAt: string;
  finishedAt: string;
  status: DeliveryDatasetRunStatus;
  /**
   * (Report × channel) pairs the run set out to deliver —
   * pairs whose channel was not configured are recorded on
   * their channel records but excluded here (the generate
   * stage's not_wired canonical discipline: a configuration
   * absence is a recorded state, not a failed attempt).
   */
  requested: number;
  /** Pairs delivered by this run or an earlier run over the
   *  same input (already_delivered pairs count as received —
   *  the delivery exists; this run verified it rather than
   *  duplicating it). */
  received: number;
  /** requested - received. */
  failed: number;
  /** Stable coded error on a failed run; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message on a failed run; null otherwise. */
  errorMessage: string | null;
}

/**
 * One channel's delivery outcome for one report. A channel
 * that could not be attempted is status "not_configured" with
 * its coded reason — never a fake delivered state. A pair an
 * earlier run over the same input already delivered is status
 * "already_delivered": the sender was NOT called again (a
 * completed channel is never delivered twice for the same
 * generated copy); `detail` names the run that delivered it.
 */
export interface DeliveryChannelRecord {
  /** The channel's name (the configuration's vocabulary). */
  channel: string;
  status: "delivered" | "failed" | "not_configured" | "already_delivered";
  /**
   * Where the delivery went, in non-secret form: the Slack
   * channel id/name, the email recipient, the webhook target's
   * host, or "ux" — never a URL with credentials, never a
   * token. Null when no target was resolved.
   */
  target: string | null;
  /** The report formats this channel carried for the report. */
  formats: string[];
  /** Stable coded error when failed / not_configured; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message when failed; null otherwise. */
  errorMessage: string | null;
  /** Recorded detail: the UX surfaces for the ux channel, the
   *  delivering run's id for already_delivered; null otherwise. */
  detail: string | null;
}

/** One delivered report: its per-channel outcomes. */
export interface DeliveryReportRecord {
  /** The report kind (the configuration's vocabulary). */
  kind: string;
  /** The report's human title. */
  title: string;
  channels: DeliveryChannelRecord[];
}

/** Artifact-level tallies over the delivery records — every
 *  value a deterministic count over the records above. */
export interface DeliveryDatasetSummary {
  /** Reports with at least one delivered (or already-delivered) channel. */
  reportsDelivered: number;
  /** Channel pairs delivered by this run. */
  channelsDelivered: number;
  /** Channel pairs an earlier run over the same input had delivered. */
  channelsAlreadyDelivered: number;
  /** Channel pairs attempted and failed. */
  channelsFailed: number;
  /** Channel pairs recorded not_configured (not attempted). */
  channelsNotConfigured: number;
}

export interface DeliveryDatasetArtifact {
  id: string;
  /** The deliver job that produced this artifact. */
  jobId: string;
  /** The generate job whose persisted artifact this run consumed. */
  generateJobId: string;
  /** The analyze job upstream of the generate job. */
  analyzeJobId: string;
  /** The enrich job upstream of the analyze job. */
  enrichJobId: string;
  /** The feed job at the head of this artifact's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source (e.g. "quotes"). */
  dataset: string;
  universe: FeedDatasetUniverse;
  /** The generated artifact consumed — exact lineage, never a guess. */
  inputArtifactId: string;
  /** The generate run that produced the input artifact. */
  inputRunId: string;
  /** The input copy's creation time (when the generate run persisted it). */
  inputAsOf: string;
  /** The channels this run was configured to deliver over. */
  channelsRequested: string[];
  /** The delivered reports, in the input's configuration order. */
  reports: DeliveryReportRecord[];
  /** Tallies over the delivery records. */
  summary: DeliveryDatasetSummary;
  run: DeliveryDatasetRunRecord;
  createdAt: string;
}

export interface DeliveryDatasetStoreOptions {
  idFactory?: () => string;
  /** Artifacts kept per deliver job after each store. Default 10. */
  keepPerJob?: number;
}

export type DeliveryDatasetStoreInput = Omit<
  DeliveryDatasetArtifact,
  "id" | "createdAt"
> & {
  /** Injectable clock (tests); defaults to now. */
  nowIso?: string;
};

/** The delivery-dataset store port (reader + the write side). */
export interface DeliveryDatasetStore {
  /** Store one run's artifact and prune to the newest
   *  keepPerJob rows for its deliver job. */
  store(input: DeliveryDatasetStoreInput): Promise<DeliveryDatasetArtifact>;
  /** The newest artifact for the deliver job — the LAST RUN,
   *  whatever its outcome; undefined when the job has never run. */
  latest(jobId: string): Promise<DeliveryDatasetArtifact | undefined>;
  /** The newest artifact a reader may serve: not failed, with
   *  at least one delivered channel. A failed run never
   *  poisons reads. */
  latestUsable(jobId: string): Promise<DeliveryDatasetArtifact | undefined>;
  /** Run history for the deliver job, newest first. */
  listRuns(jobId: string, limit?: number): Promise<DeliveryDatasetArtifact[]>;
  /**
   * Every retained artifact for the deliver job that consumed
   * the given generated artifact, newest first — the resume
   * lookup: the pairs these artifacts record as delivered are
   * the pairs a new run over the same input must not send again.
   */
  listForInput(
    jobId: string,
    inputArtifactId: string,
    limit?: number,
  ): Promise<DeliveryDatasetArtifact[]>;
}

/** Newest-first ordering shared by every adapter: createdAt
 *  descending, then id descending (ids are unique; the feed
 *  family's D1 ordering rule). */
export function compareDeliveryArtifactsNewestFirst(
  a: DeliveryDatasetArtifact,
  b: DeliveryDatasetArtifact,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Channel pairs a stored artifact delivered (this run's own
 *  deliveries only — already_delivered pairs are another run's). */
export function deliveredChannelCount(artifact: DeliveryDatasetArtifact): number {
  return artifact.reports.reduce(
    (sum, report) =>
      sum + report.channels.filter((c) => c.status === "delivered").length,
    0,
  );
}

/** Channel pairs whose delivery exists, by whichever run over
 *  this input delivered them (delivered + already_delivered). */
export function receivedChannelCount(artifact: DeliveryDatasetArtifact): number {
  return artifact.reports.reduce(
    (sum, report) =>
      sum +
      report.channels.filter(
        (c) => c.status === "delivered" || c.status === "already_delivered",
      ).length,
    0,
  );
}

/** Whether a stored artifact may be served to readers. */
export function isUsableDeliveryArtifact(
  artifact: DeliveryDatasetArtifact,
): boolean {
  return artifact.run.status !== "failed" && receivedChannelCount(artifact) > 0;
}
