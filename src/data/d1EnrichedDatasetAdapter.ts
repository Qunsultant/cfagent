/**
 * Issue #3536 (Pipeline J3), on the CDO data foundation
 * (#3548 pattern) — the D1 implementation of the
 * enriched-dataset store (the production residency: the
 * analyze stage's readers run in different instances than the
 * enrich writer, on the shared AGENT_DB binding — the
 * feed-dataset family's residency ruling, applied again).
 * Built on the foundation's drizzle D1 pattern (the
 * d1JobPipelineAdapter family): the table is the foundation's
 * (src/data/drizzleSchema.ts; DDL authority migration 0051 in
 * src/data/migrationRunner.ts — the same shape in every
 * residency), the schema is ensured through the foundation's
 * versioned migration runner, and all query-builder sites
 * live here, inside src/data/ — never above the layer (global
 * D-D census surface 3).
 *
 * Semantics identical to the other residencies: newest-first
 * per enrich job (created_at desc, id desc), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { jobEnrichedDatasets } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0051_JOB_ENRICHED_DATASETS,
  type MigrationDb,
} from "./migrationRunner";
import {
  isUsableEnrichedArtifact,
  type EnrichedDatasetArtifact,
  type EnrichedDatasetStore,
  type EnrichedDatasetStoreInput,
  type EnrichedDatasetStoreOptions,
} from "./enrichedDatasetPorts";

/** Drizzle D1 database object carrying the enriched-dataset schema. */
export type EnrichedDatasetDb = DrizzleD1Database<{
  jobEnrichedDatasets: typeof jobEnrichedDatasets;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1EnrichedDatasetDb(d1: D1Database): EnrichedDatasetDb {
  return drizzle(d1, { schema: { jobEnrichedDatasets } });
}

/** Idempotent schema-ensure: applies migration 0051 if unapplied. */
export async function ensureEnrichedDatasetSchema(
  db: EnrichedDatasetDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0051_JOB_ENRICHED_DATASETS,
  ]);
}

/** The D1 enriched-dataset store over the shared AgentDB binding. */
export class D1EnrichedDatasetStore implements EnrichedDatasetStore {
  private ensured: Promise<void> | null = null;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly db: EnrichedDatasetDb,
    options?: EnrichedDatasetStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureEnrichedDatasetSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  private async newestFirst(jobId: string, limit: number) {
    return this.db
      .select()
      .from(jobEnrichedDatasets)
      .where(eq(jobEnrichedDatasets.jobId, jobId))
      .orderBy(desc(jobEnrichedDatasets.createdAt), desc(jobEnrichedDatasets.id))
      .limit(limit);
  }

  async store(input: EnrichedDatasetStoreInput): Promise<EnrichedDatasetArtifact> {
    await this.ensure();
    const { nowIso, ...rest } = input;
    const artifact: EnrichedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.db.insert(jobEnrichedDatasets).values({
      id: artifact.id,
      createdAt: artifact.createdAt,
      jobId: artifact.jobId,
      feedJobId: artifact.feedJobId,
      sourceId: artifact.sourceId,
      dataset: artifact.dataset,
      runId: artifact.run.runId,
      status: artifact.run.status,
      asOf: artifact.run.finishedAt,
      rowsPersisted: artifact.rows.length,
      artifactJson: JSON.stringify(artifact),
    });
    // Prune to the newest keepPerJob rows for this job.
    const kept = await this.newestFirst(artifact.jobId, this.keepPerJob);
    const keptIds = new Set(kept.map((r) => r.id));
    const all = await this.newestFirst(artifact.jobId, 1000);
    for (const row of all) {
      if (!keptIds.has(row.id)) {
        await this.db
          .delete(jobEnrichedDatasets)
          .where(eq(jobEnrichedDatasets.id, row.id));
      }
    }
    return artifact;
  }

  async latest(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, 1);
    return rows.length
      ? (JSON.parse(rows[0].artifactJson) as EnrichedDatasetArtifact)
      : undefined;
  }

  async latestUsable(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobEnrichedDatasets)
      .where(
        and(
          eq(jobEnrichedDatasets.jobId, jobId),
          ne(jobEnrichedDatasets.status, "failed"),
          gt(jobEnrichedDatasets.rowsPersisted, 0),
        ),
      )
      .orderBy(desc(jobEnrichedDatasets.createdAt), desc(jobEnrichedDatasets.id))
      .limit(1);
    if (!rows.length) return undefined;
    const artifact = JSON.parse(rows[0].artifactJson) as EnrichedDatasetArtifact;
    return isUsableEnrichedArtifact(artifact) ? artifact : undefined;
  }

  async listRuns(jobId: string, limit = 10): Promise<EnrichedDatasetArtifact[]> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, Math.max(0, limit));
    return rows.map((r) => JSON.parse(r.artifactJson) as EnrichedDatasetArtifact);
  }
}
