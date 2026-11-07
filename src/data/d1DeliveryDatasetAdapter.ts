/**
 * Issue #3539 (Pipeline J6), on the CDO data foundation
 * (#3548 pattern) — the D1 implementation of the
 * delivery-dataset store (the production residency: the
 * status surfaces' readers run in different instances than
 * the deliver writer, on the shared AGENT_DB binding — the
 * generated-dataset family's residency ruling, applied
 * again). Built on the foundation's drizzle D1 pattern (the
 * d1GeneratedDatasetAdapter family): the table is the
 * foundation's (src/data/drizzleSchema.ts; DDL authority
 * migration 0057 in src/data/migrationRunner.ts — the same
 * shape in every residency), the schema is ensured through
 * the foundation's versioned migration runner, and all
 * query-builder sites live here, inside src/data/ — never
 * above the layer (global D-D census surface 3).
 *
 * Semantics identical to the other residencies: newest-first
 * per deliver job (created_at desc, id desc), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs,
 * and listForInput — the resume lookup over the denormalized
 * input artifact id. The denormalized rows_persisted column
 * carries the count of channel pairs the run itself
 * delivered (this family's "rows").
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, ne } from "drizzle-orm";
import { jobDeliveryDatasets } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0057_JOB_DELIVERY_DATASETS,
  type MigrationDb,
} from "./migrationRunner";
import {
  deliveredChannelCount,
  isUsableDeliveryArtifact,
  type DeliveryDatasetArtifact,
  type DeliveryDatasetStore,
  type DeliveryDatasetStoreInput,
  type DeliveryDatasetStoreOptions,
} from "./deliveryDatasetPorts";

/** Drizzle D1 database object carrying the delivery-dataset schema. */
export type DeliveryDatasetDb = DrizzleD1Database<{
  jobDeliveryDatasets: typeof jobDeliveryDatasets;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1DeliveryDatasetDb(d1: D1Database): DeliveryDatasetDb {
  return drizzle(d1, { schema: { jobDeliveryDatasets } });
}

/** Idempotent schema-ensure: applies migration 0057 if unapplied. */
export async function ensureDeliveryDatasetSchema(
  db: DeliveryDatasetDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0057_JOB_DELIVERY_DATASETS,
  ]);
}

/** The D1 delivery-dataset store over the shared AgentDB binding. */
export class D1DeliveryDatasetStore implements DeliveryDatasetStore {
  private ensured: Promise<void> | null = null;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly db: DeliveryDatasetDb,
    options?: DeliveryDatasetStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureDeliveryDatasetSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  private async newestFirst(jobId: string, limit: number) {
    return this.db
      .select()
      .from(jobDeliveryDatasets)
      .where(eq(jobDeliveryDatasets.jobId, jobId))
      .orderBy(desc(jobDeliveryDatasets.createdAt), desc(jobDeliveryDatasets.id))
      .limit(limit);
  }

  async store(input: DeliveryDatasetStoreInput): Promise<DeliveryDatasetArtifact> {
    await this.ensure();
    const { nowIso, ...rest } = input;
    const artifact: DeliveryDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.db.insert(jobDeliveryDatasets).values({
      id: artifact.id,
      createdAt: artifact.createdAt,
      jobId: artifact.jobId,
      generateJobId: artifact.generateJobId,
      sourceId: artifact.sourceId,
      dataset: artifact.dataset,
      runId: artifact.run.runId,
      status: artifact.run.status,
      asOf: artifact.run.finishedAt,
      rowsPersisted: deliveredChannelCount(artifact),
      inputArtifactId: artifact.inputArtifactId,
      artifactJson: JSON.stringify(artifact),
    });
    // Prune to the newest keepPerJob rows for this job.
    const kept = await this.newestFirst(artifact.jobId, this.keepPerJob);
    const keptIds = new Set(kept.map((r) => r.id));
    const all = await this.newestFirst(artifact.jobId, 1000);
    for (const row of all) {
      if (!keptIds.has(row.id)) {
        await this.db
          .delete(jobDeliveryDatasets)
          .where(eq(jobDeliveryDatasets.id, row.id));
      }
    }
    return artifact;
  }

  async latest(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, 1);
    return rows.length
      ? (JSON.parse(rows[0].artifactJson) as DeliveryDatasetArtifact)
      : undefined;
  }

  async latestUsable(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    await this.ensure();
    // The parsed-artifact check is authoritative (the DO
    // residency's rule): rows_persisted counts only THIS run's
    // deliveries, so an all-already_delivered resume artifact
    // (rows_persisted 0, deliveries verified) is usable even
    // though a count filter would exclude it. Retained rows
    // per job are capped by keepPerJob, so scanning the
    // non-failed newest-first window is bounded.
    const rows = await this.db
      .select()
      .from(jobDeliveryDatasets)
      .where(
        and(
          eq(jobDeliveryDatasets.jobId, jobId),
          ne(jobDeliveryDatasets.status, "failed"),
        ),
      )
      .orderBy(desc(jobDeliveryDatasets.createdAt), desc(jobDeliveryDatasets.id))
      .limit(100);
    for (const row of rows) {
      const artifact = JSON.parse(row.artifactJson) as DeliveryDatasetArtifact;
      if (isUsableDeliveryArtifact(artifact)) return artifact;
    }
    return undefined;
  }

  async listRuns(jobId: string, limit = 10): Promise<DeliveryDatasetArtifact[]> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, Math.max(0, limit));
    return rows.map((r) => JSON.parse(r.artifactJson) as DeliveryDatasetArtifact);
  }

  async listForInput(
    jobId: string,
    inputArtifactId: string,
    limit = 50,
  ): Promise<DeliveryDatasetArtifact[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobDeliveryDatasets)
      .where(
        and(
          eq(jobDeliveryDatasets.jobId, jobId),
          eq(jobDeliveryDatasets.inputArtifactId, inputArtifactId),
        ),
      )
      .orderBy(desc(jobDeliveryDatasets.createdAt), desc(jobDeliveryDatasets.id))
      .limit(Math.max(0, limit));
    return rows.map((r) => JSON.parse(r.artifactJson) as DeliveryDatasetArtifact);
  }
}
